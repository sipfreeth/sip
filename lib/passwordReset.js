// lib/passwordReset.js
//
// สร้างและตรวจสอบลิงก์รีเซ็ตรหัสผ่าน — ใช้ได้ครั้งเดียว หมดอายุใน 30 นาที
// ใช้ร่วมกันได้ทั้ง Sponsor และ Office (ระบุ accountType ให้ต่างกัน)

import crypto from 'crypto';
import { supabase } from './supabaseClient.js';

const TOKEN_MINUTES = 30;

function sign(value) {
  return crypto.createHmac('sha256', process.env.ADMIN_SECRET).update(value).digest('hex');
}

export function createResetToken(accountType, accountId) {
  const expires = Date.now() + TOKEN_MINUTES * 60 * 1000;
  const payload = `${accountType}.${accountId}.${expires}`;
  const sig = sign(payload);
  return Buffer.from(`${payload}.${sig}`).toString('base64url');
}

// คืน { accountType, accountId } ถ้า token ใช้ได้ (ยังไม่หมดอายุ ยังไม่เคยถูกใช้) หรือ null
export async function verifyResetToken(token) {
  let decoded;
  try {
    decoded = Buffer.from(token, 'base64url').toString();
  } catch {
    return null;
  }

  const parts = decoded.split('.');
  if (parts.length !== 4) return null;
  const [accountType, accountId, expires, sig] = parts;

  if (sign(`${accountType}.${accountId}.${expires}`) !== sig) return null;
  if (Date.now() > Number(expires)) return null;

  // เช็คว่าเคยถูกใช้ไปแล้วหรือยัง (กันเอาลิงก์เดิมมาใช้ซ้ำ)
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const { data: used } = await supabase.from('used_reset_tokens').select('token_hash').eq('token_hash', tokenHash).maybeSingle();
  if (used) return null;

  return { accountType, accountId, tokenHash };
}

export async function markTokenUsed(tokenHash) {
  await supabase.from('used_reset_tokens').insert({ token_hash: tokenHash });
}
