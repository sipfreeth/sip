// lib/sponsorArea.js
//
// โค้ดกลางของระบบ Sponsor: คลัง Content, ปฏิทินความว่างของสล็อต, การจอง
// อัปโหลดไฟล์ตรงไป Supabase Storage เหมือนระบบ Office Area (เลี่ยงข้อจำกัดขนาด request ของ Vercel)

import { supabase } from './supabaseClient.js';
import crypto from 'crypto';

const BUCKET = 'sponsor-content';
const MAX_FILES_PER_SPONSOR = 6;
const WEEKS_TO_SHOW = 4;
const RESERVATION_MINUTES = 15;

// ---------- Content Library ----------
export async function getSponsorContent(sponsorId) {
  const { data } = await supabase
    .from('sponsor_content')
    .select('*')
    .eq('sponsor_id', sponsorId)
    .order('created_at', { ascending: false });
  return data || [];
}

export async function countSponsorContent(sponsorId) {
  const { count } = await supabase
    .from('sponsor_content')
    .select('id', { count: 'exact', head: true })
    .eq('sponsor_id', sponsorId);
  return count || 0;
}

export async function createUploadTarget(sponsorId, fileName) {
  const safeName = fileName.replace(/[^a-zA-Z0-9.\-_]/g, '_');
  const path = `${sponsorId}/${Date.now()}-${safeName}`;
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUploadUrl(path);
  if (error) throw error;
  return { path, token: data.token };
}

export async function saveSponsorContent({ sponsorId, fileName, filePath, fileType }) {
  const currentCount = await countSponsorContent(sponsorId);
  if (currentCount >= MAX_FILES_PER_SPONSOR) {
    throw new Error(`อัปโหลดได้สูงสุด ${MAX_FILES_PER_SPONSOR} ไฟล์ต่อบัญชี กรุณาลบไฟล์เก่าก่อน`);
  }
  const { error } = await supabase.from('sponsor_content').insert({
    sponsor_id: sponsorId,
    file_name: fileName,
    file_path: filePath,
    file_type: fileType,
    status: 'pending',
  });
  if (error) throw error;
}

export async function getSignedContentUrl(filePath) {
  const { data } = await supabase.storage.from(BUCKET).createSignedUrl(filePath, 3600);
  return data?.signedUrl || null;
}

// ---------- ปฏิทินความว่างของสล็อต ----------
function getNextMonday(from = new Date()) {
  const d = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  const dayOfWeek = d.getDay(); // 0 = อาทิตย์
  const daysUntilMonday = (8 - dayOfWeek) % 7 || 7; // จันทร์หน้าเสมอ (ไม่นับสัปดาห์นี้ เพราะต้องจองล่วงหน้า)
  d.setDate(d.getDate() + daysUntilMonday);
  return d;
}

// คืน array ของสัปดาห์ที่จองได้ (เริ่มจากจันทร์หน้า ไปอีก WEEKS_TO_SHOW สัปดาห์)
export function getBookableWeeks() {
  const firstMonday = getNextMonday();
  const weeks = [];
  for (let i = 0; i < WEEKS_TO_SHOW; i++) {
    const start = new Date(firstMonday);
    start.setDate(firstMonday.getDate() + i * 7);
    weeks.push(start);
  }
  return weeks;
}

// คืนตารางความว่าง { [slot_number]: { [week_start_iso]: booking หรือ null } } ของ office หนึ่งอัน
// รายการที่ unpaid และเลย reserved_until มาแล้ว ถือว่า "หมดอายุ" ไม่นับว่าไม่ว่างอีกต่อไป (คืน slot ให้คนอื่นอัตโนมัติ)
export async function getAvailability(officeAccountId) {
  const weeks = getBookableWeeks();
  const lastWeek = new Date(weeks[weeks.length - 1]);
  lastWeek.setDate(lastWeek.getDate() + 7);
  const nowIso = new Date().toISOString();

  const { data: bookings } = await supabase
    .from('slot_bookings')
    .select('slot_number, week_start, payment_status, reserved_until')
    .eq('office_account_id', officeAccountId)
    .neq('payment_status', 'refunded') // คืนเงินแล้ว = ปล่อยช่องนั้นว่างกลับมาให้จองใหม่ได้
    .gte('week_start', weeks[0].toISOString().slice(0, 10))
    .lt('week_start', lastWeek.toISOString().slice(0, 10));

  const bookedMap = {};
  for (const b of bookings || []) {
    const isExpiredHold = b.payment_status === 'unpaid' && b.reserved_until && b.reserved_until < nowIso;
    if (isExpiredHold) continue; // หมดเวลาจ่ายเงินแล้ว ถือว่าว่าง
    bookedMap[`${b.slot_number}_${b.week_start}`] = b;
  }

  return { weeks, bookedMap };
}

// ---------- สร้างการจอง (เลือกได้หลาย slot พร้อมกันในสัปดาห์เดียว ผูกเป็นกลุ่มเดียว จ่ายเงินรวมทีเดียว) ----------
export async function createBookings({ sponsorId, officeAccountId, slotNumbers, weekStart, slotContentMap, pricePerSlot }) {
  const nowIso = new Date().toISOString();
  const reservedUntil = new Date(Date.now() + RESERVATION_MINUTES * 60 * 1000).toISOString();
  const groupId = crypto.randomUUID();

  const bookingIds = [];
  for (const slotNumber of slotNumbers) {
    // เคลียร์ hold เก่าที่หมดอายุแล้วของ slot+สัปดาห์นี้ทิ้งก่อน (ถ้ามี)
    await supabase
      .from('slot_bookings')
      .delete()
      .eq('office_account_id', officeAccountId)
      .eq('slot_number', slotNumber)
      .eq('week_start', weekStart)
      .eq('payment_status', 'unpaid')
      .lt('reserved_until', nowIso);

    const { data, error } = await supabase
      .from('slot_bookings')
      .insert({
        sponsor_id: sponsorId,
        office_account_id: officeAccountId,
        slot_number: slotNumber,
        week_start: weekStart,
        sponsor_content_id: slotContentMap[slotNumber],
        price: pricePerSlot,
        payment_status: 'unpaid',
        reserved_until: reservedUntil,
        booking_group_id: groupId,
      })
      .select('id')
      .single();

    if (error) {
      // ชนกับคนอื่นที่จองไปพร้อมกันพอดี — ยกเลิกรายการที่เพิ่ง insert ไปในรอบนี้ทั้งหมด (all-or-nothing)
      if (bookingIds.length) {
        await supabase.from('slot_bookings').delete().in('id', bookingIds);
      }
      throw new Error(`Slot ${slotNumber} เพิ่งถูกจองไปโดยคนอื่น กรุณาเลือกใหม่`);
    }

    bookingIds.push(data.id);
  }

  return { groupId, bookingIds };
}

// ดึงรายการจองทั้งกลุ่ม (ไว้ใช้หน้าชำระเงินรวม) — เช็คว่าเป็นของ sponsor คนนี้จริง และยังไม่หมดเวลาจ่าย
export async function getBookingGroup(groupId, sponsorId) {
  const { data } = await supabase
    .from('slot_bookings')
    .select('*, office_accounts(office_name, price_per_week)')
    .eq('booking_group_id', groupId)
    .eq('sponsor_id', sponsorId);
  return data || [];
}

// นับจำนวนรอบที่คอนเทนต์ของสล็อตนี้เล่นจริงบนจอ (ข้อมูลจาก CMS ที่ยิงเข้ามาทาง /api/playback-log)
// จับคู่ด้วย office + slot + ช่วงสัปดาห์ที่จอง เพราะ Playback Log ไม่รู้จัก sponsor โดยตรง
export async function getPlayCountForBooking(officeAccountId, slotNumber, weekStart) {
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekEnd.getDate() + 7);

  const { count } = await supabase
    .from('content_play_logs')
    .select('id', { count: 'exact', head: true })
    .eq('office_account_id', officeAccountId)
    .eq('slot_number', slotNumber)
    .gte('played_at', new Date(weekStart).toISOString())
    .lt('played_at', weekEnd.toISOString());

  return count || 0;
}

export { RESERVATION_MINUTES };

// ---------- บริหารสล็อตที่จองไปแล้ว (ฝั่ง Sponsor) ----------
export async function getSponsorBookings(sponsorId) {
  const { data } = await supabase
    .from('slot_bookings')
    .select('*, office_accounts(office_name), sponsor_content(file_name)')
    .eq('sponsor_id', sponsorId)
    .order('week_start', { ascending: false });
  return data || [];
}

export async function getBookingById(bookingId, sponsorId) {
  const { data } = await supabase
    .from('slot_bookings')
    .select('*, office_accounts(office_name, price_per_week)')
    .eq('id', bookingId)
    .eq('sponsor_id', sponsorId)
    .maybeSingle();
  return data;
}

export async function updateBookingContent(bookingId, sponsorId, sponsorContentId) {
  const { error } = await supabase
    .from('slot_bookings')
    .update({ sponsor_content_id: sponsorContentId })
    .eq('id', bookingId)
    .eq('sponsor_id', sponsorId);
  if (error) throw error;
}

// ยกเลิกได้แค่รายการที่ยังไม่จ่ายเงินเท่านั้น (กันสับสนเรื่อง refund)
export async function cancelUnpaidBooking(bookingId, sponsorId) {
  const { error } = await supabase
    .from('slot_bookings')
    .delete()
    .eq('id', bookingId)
    .eq('sponsor_id', sponsorId)
    .eq('payment_status', 'unpaid');
  if (error) throw error;
}

// ---------- อัปโหลดสลิปโอนเงิน ----------
const SLIP_BUCKET = 'payment-slips';

export async function createSlipUploadTarget(sponsorId, bookingId, fileName) {
  const safeName = fileName.replace(/[^a-zA-Z0-9.\-_]/g, '_');
  const path = `${sponsorId}/${bookingId}-${Date.now()}-${safeName}`;
  const { data, error } = await supabase.storage.from(SLIP_BUCKET).createSignedUploadUrl(path);
  if (error) throw error;
  return { path, token: data.token };
}

export async function downloadSlipBytes(filePath) {
  const { data, error } = await supabase.storage.from(SLIP_BUCKET).download(filePath);
  if (error) throw error;
  return Buffer.from(await data.arrayBuffer());
}

export async function getSignedSlipUrl(filePath) {
  const { data } = await supabase.storage.from(SLIP_BUCKET).createSignedUrl(filePath, 3600);
  return data?.signedUrl || null;
}

export { MAX_FILES_PER_SPONSOR, WEEKS_TO_SHOW };
