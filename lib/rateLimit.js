// lib/rateLimit.js
//
// Rate Limiting แบบใช้ฐานข้อมูลเดิมเก็บนับ ไม่ต้องพึ่งบริการเสริมภายนอก
//
// 2 จุดที่ใช้ต่างกัน:
//   1. checkLoginRateLimit — กันเดารหัสสุ่ม (Brute Force) เข้มงวดปกติ เพราะไม่มีเหตุผลที่คนจริงจะ Login ผิดรัวๆ
//   2. checkScanRateLimit — กัน Bot สแกน QR ถี่ผิดธรรมชาติ ตั้งเกณฑ์สูงมาก เพราะระบบตั้งใจให้คนหลายคน
//      สแกนพร้อมกันจาก WiFi เดียวกันได้ (เห็นเป็น IP เดียวกัน) ไม่ใช่พฤติกรรมผิดปกติ

import { supabase } from './supabaseClient.js';

const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_LOCKOUT_MINUTES = 15;

const SCAN_MAX_PER_MINUTE = 100; // สูงมากตั้งใจ กันแค่ Bot ไม่กันคนสแกนพร้อมกันจริง

// ---------- ดึง IP จริงของผู้ใช้ (รองรับผ่าน Vercel/Proxy) ----------
export function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return forwarded.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

// ---------- Login Rate Limit (Admin/Sponsor/Office) ----------
// คืน true ถ้ายังลองได้ / false ถ้าถูกล็อกชั่วคราวแล้ว
export async function checkLoginRateLimit(identifier, accountType) {
  const windowStart = new Date(Date.now() - LOGIN_LOCKOUT_MINUTES * 60 * 1000).toISOString();
  const { count } = await supabase
    .from('login_attempts')
    .select('id', { count: 'exact', head: true })
    .eq('identifier', identifier)
    .eq('account_type', accountType)
    .eq('success', false)
    .gte('attempted_at', windowStart);

  return (count || 0) < LOGIN_MAX_ATTEMPTS;
}

// บันทึกผลการ Login แต่ละครั้ง — ถ้าสำเร็จ เคลียร์ประวัติผิดเก่าทิ้งด้วย (รีเซ็ตให้ทันที ไม่ต้องรอหมดเวลา)
export async function recordLoginAttempt(identifier, accountType, success) {
  await supabase.from('login_attempts').insert({ identifier, account_type: accountType, success });
  if (success) {
    await supabase.from('login_attempts').delete().eq('identifier', identifier).eq('account_type', accountType).eq('success', false);
  }
}

export const LOGIN_LOCKOUT_MESSAGE = `เข้าสู่ระบบผิดพลาดหลายครั้งเกินไป กรุณาลองใหม่อีกครั้งภายใน ${LOGIN_LOCKOUT_MINUTES} นาที`;

// ---------- QR Scan Rate Limit (กัน Bot เท่านั้น) ----------
export async function checkScanRateLimit(ipAddress) {
  if (!ipAddress || ipAddress === 'unknown') return true; // หา IP ไม่ได้ ปล่อยผ่าน ไม่บล็อกคนจริงเพราะเหตุผลทางเทคนิค

  const windowStart = new Date(Date.now() - 60 * 1000).toISOString();
  const { count } = await supabase
    .from('scan_logs')
    .select('id', { count: 'exact', head: true })
    .eq('ip_address', ipAddress)
    .gte('scanned_at', windowStart);

  return (count || 0) < SCAN_MAX_PER_MINUTE;
}
