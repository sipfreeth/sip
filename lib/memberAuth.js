// lib/memberAuth.js
//
// Session Cookie สำหรับสมาชิก (เดิมไม่มี — ทุกหน้าต้อง Redirect ผ่าน LINE OAuth ใหม่ทุกครั้ง)
// สร้างขึ้นเฉพาะสำหรับระบบเกมเลี้ยงสัตว์ที่ต้องกดปุ่มถี่ๆ (ให้อาหาร/เล่นด้วย/ซื้อของ)
// ระบบแต้ม/ของรางวัลเดิมยังคงใช้ Flow แบบ Redirect ผ่าน LINE เหมือนเดิม ไม่กระทบกัน

import crypto from 'crypto';

const COOKIE_NAME = 'member_session';
const SESSION_HOURS = 24;

function sign(value) {
  return crypto.createHmac('sha256', process.env.ADMIN_SECRET).update(value).digest('hex');
}

export function createMemberSessionCookie(memberId) {
  const expires = Date.now() + SESSION_HOURS * 60 * 60 * 1000;
  const payload = `${memberId}.${expires}`;
  const sig = sign(payload);
  const token = Buffer.from(`${payload}.${sig}`).toString('base64url');
  const maxAge = SESSION_HOURS * 60 * 60;
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const cookies = {};
  header.split(';').forEach((part) => {
    const [key, ...rest] = part.trim().split('=');
    if (key) cookies[key] = rest.join('=');
  });
  return cookies;
}

// คืน memberId ถ้า session ยังไม่หมดอายุ ไม่งั้นคืน null (ไม่ redirect ไปไหนเอง ให้ผู้เรียกจัดการต่อ)
export function getMemberFromSession(req) {
  const cookies = parseCookies(req);
  const token = cookies[COOKIE_NAME];
  if (!token) return null;

  let decoded;
  try {
    decoded = Buffer.from(token, 'base64url').toString();
  } catch {
    return null;
  }

  const parts = decoded.split('.');
  if (parts.length !== 3) return null;
  const [memberId, expires, sig] = parts;

  if (sign(`${memberId}.${expires}`) !== sig) return null;
  if (Date.now() > Number(expires)) return null;

  return memberId;
}
