// lib/memberToken.js
//
// ใช้เซ็นรับรองข้อมูล (memberId, rewardId) ตอนส่งผ่านฟอร์มที่อยู่จัดส่ง
// กันคนแก้ member_id/reward_id เองในหน้าเว็บแล้วส่งมาแลกแทนคนอื่น
// อายุสั้นๆ แค่ 15 นาที (พอสำหรับกรอกฟอร์มที่อยู่)

import crypto from 'crypto';

const TOKEN_MINUTES = 15;

function sign(value) {
  return crypto.createHmac('sha256', process.env.ADMIN_SECRET).update(value).digest('hex');
}

export function createRedeemToken(memberId, rewardId) {
  const expires = Date.now() + TOKEN_MINUTES * 60 * 1000;
  const payload = `${memberId}.${rewardId}.${expires}`;
  const sig = sign(payload);
  return Buffer.from(`${payload}.${sig}`).toString('base64url');
}

// คืน { memberId, rewardId } ถ้า token ยังใช้ได้ หรือ null ถ้าปลอม/หมดอายุ
export function verifyRedeemToken(token) {
  let decoded;
  try {
    decoded = Buffer.from(token, 'base64url').toString();
  } catch {
    return null;
  }

  const parts = decoded.split('.');
  if (parts.length !== 4) return null;
  const [memberId, rewardId, expires, sig] = parts;

  if (sign(`${memberId}.${rewardId}.${expires}`) !== sig) return null;
  if (Date.now() > Number(expires)) return null;

  return { memberId, rewardId };
}
