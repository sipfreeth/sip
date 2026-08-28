// api/playback-log.js
//
// Endpoint ให้ CMS (ยี่ห้อไหนก็ได้ที่รองรับ Webhook/HTTP callback ตอนเล่นเนื้อหาจบ) ยิงมาบันทึก
// ป้องกันด้วย secret key ผ่าน query string หรือ header — กันคนนอกยิงข้อมูลปลอมเข้ามา
//
// เรียกใช้แบบนี้ (ตั้งค่าใน CMS ให้ยิง POST มาที่ URL นี้ทุกครั้งที่เล่นจบ 1 รอบ):
//
//   POST https://your-project.vercel.app/api/playback-log?key=YOUR_SECRET
//   Content-Type: application/json
//   {
//     "office_id": 3,            // เลือกใส่: id ของ office_accounts ในระบบเรา (ถ้า CMS รู้จัก)
//     "screen_id": "LOBBY-01",   // เลือกใส่: รหัสจอจาก CMS เอง
//     "slot_number": 1,          // เลือกใส่: 1/2/3
//     "content_label": "promo-video.mp4", // เลือกใส่: ชื่อ/รหัสไฟล์ที่เล่น
//     "played_at": "2026-08-07T10:30:00Z" // เลือกใส่: ไม่ใส่ก็ได้ ระบบจะใช้เวลาปัจจุบันแทน
//   }
//
// ฟิลด์ทั้งหมด "เลือกใส่ได้" เพราะแต่ละ CMS ส่งข้อมูลมาไม่เหมือนกัน ใส่เท่าที่ CMS มีให้ก็พอ

import { supabase } from '../lib/supabaseClient.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).send('Method not allowed — ต้องยิงเป็น POST');
    return;
  }

  const providedKey = req.query.key || req.headers['x-webhook-key'];
  if (!process.env.PLAYBACK_WEBHOOK_SECRET || providedKey !== process.env.PLAYBACK_WEBHOOK_SECRET) {
    res.status(401).send('unauthorized — key ไม่ถูกต้อง');
    return;
  }

  let body = {};
  try {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    body = raw ? JSON.parse(raw) : {};
  } catch {
    res.status(400).send('รูปแบบข้อมูลไม่ถูกต้อง (ต้องเป็น JSON)');
    return;
  }

  const { error } = await supabase.from('content_play_logs').insert({
    office_account_id: body.office_id || null,
    slot_number: body.slot_number || null,
    screen_id: body.screen_id || null,
    content_label: body.content_label || null,
    played_at: body.played_at ? new Date(body.played_at).toISOString() : new Date().toISOString(),
  });

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  res.status(200).json({ ok: true });
}
