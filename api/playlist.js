// api/playlist.js
//
// Endpoint ให้ CMS ภายนอก "ดึง" (pull) รายการ Content ที่ต้องเล่นตอนนี้ของ Office หนึ่งอัน
// รวมทั้ง Content ของ Office เอง (3 slot จัดการเอง) และ Content ของ Sponsor ที่จองสล็อตและจ่ายเงินแล้ว
// ในสัปดาห์ปัจจุบัน — อัปเดตอัตโนมัติทันทีที่ Sponsor เปลี่ยนไฟล์ในสล็อตของตัวเอง ไม่ต้องมีแอดมินอัปโหลดซ้ำ
//
// เรียกใช้แบบนี้ (ตั้งค่าใน CMS ให้ดึง URL นี้เป็นระยะ เช่น ทุก 5-15 นาที):
//
//   GET https://your-project.vercel.app/api/playlist?office_id=1&key=YOUR_SECRET
//
// ตอบกลับเป็น JSON

import { supabase } from '../lib/supabaseClient.js';

const OFFICE_BUCKET = 'office-content';
const SPONSOR_BUCKET = 'sponsor-content';
const URL_EXPIRY_SECONDS = 60 * 60 * 6; // ลิงก์ไฟล์อายุ 6 ชั่วโมง (CMS จะมาขอใหม่ก่อนหมดอายุอยู่แล้วเพราะ poll เป็นระยะ)

function getCurrentWeekStart() {
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dayOfWeek = (d.getDay() + 6) % 7; // จันทร์ = 0
  d.setDate(d.getDate() - dayOfWeek);
  return d.toISOString().slice(0, 10);
}

export default async function handler(req, res) {
  const providedKey = req.query.key;
  if (!process.env.PLAYLIST_FEED_SECRET || providedKey !== process.env.PLAYLIST_FEED_SECRET) {
    res.status(401).json({ error: 'unauthorized — key ไม่ถูกต้อง' });
    return;
  }

  const officeId = req.query.office_id;
  if (!officeId) {
    res.status(400).json({ error: 'ต้องระบุ office_id' });
    return;
  }

  const { data: office } = await supabase.from('office_accounts').select('id, office_name').eq('id', officeId).maybeSingle();
  if (!office) {
    res.status(404).json({ error: 'ไม่พบ Office นี้' });
    return;
  }

  const weekStart = getCurrentWeekStart();

  const [officeContentRes, bookingsRes] = await Promise.all([
    // Content 3 slot ที่ Office จัดการเอง
    supabase.from('office_content').select('slot_number, file_name, file_path, file_type').eq('office_account_id', officeId),
    // สล็อตที่ Sponsor จองและจ่ายเงินแล้ว สำหรับสัปดาห์ปัจจุบัน
    supabase
      .from('slot_bookings')
      .select('slot_number, sponsor_content(file_name, file_path, file_type), sponsors(company_name)')
      .eq('office_account_id', officeId)
      .eq('payment_status', 'paid')
      .eq('approval_status', 'approved')
      .eq('week_start', weekStart),
  ]);

  const items = [];

  for (const row of officeContentRes.data || []) {
    if (!row.file_path) continue;
    const { data: signed } = await supabase.storage.from(OFFICE_BUCKET).createSignedUrl(row.file_path, URL_EXPIRY_SECONDS);
    items.push({
      source: 'office',
      slot: row.slot_number,
      file_name: row.file_name,
      file_type: row.file_type,
      video_url: signed?.signedUrl || null,
    });
  }

  for (const row of bookingsRes.data || []) {
    if (!row.sponsor_content?.file_path) continue;
    const { data: signed } = await supabase.storage.from(SPONSOR_BUCKET).createSignedUrl(row.sponsor_content.file_path, URL_EXPIRY_SECONDS);
    items.push({
      source: 'sponsor',
      slot: row.slot_number,
      sponsor: row.sponsors?.company_name || null,
      file_name: row.sponsor_content.file_name,
      file_type: row.sponsor_content.file_type,
      video_url: signed?.signedUrl || null,
    });
  }

  items.sort((a, b) => a.slot - b.slot);

  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.status(200).json({
    office: office.office_name,
    week_start: weekStart,
    generated_at: new Date().toISOString(),
    items,
  });
}
