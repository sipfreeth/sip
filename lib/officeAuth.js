// lib/officeAuth.js
//
// ระบบ Login/Logout สำหรับบัญชี Office — แยกจาก admin_users คนละระบบ คนละ cookie
// Office account หนึ่งบัญชี เห็นได้แค่ office_content ของตัวเองเท่านั้น

import crypto from 'crypto';
import { supabase } from './supabaseClient.js';

const COOKIE_NAME = 'office_session';
const SESSION_HOURS = 12;

function sign(value) {
  return crypto.createHmac('sha256', process.env.ADMIN_SECRET).update(value).digest('hex');
}

export function createOfficeSessionCookie(officeAccountId) {
  const expires = Date.now() + SESSION_HOURS * 60 * 60 * 1000;
  const payload = `${officeAccountId}.${expires}`;
  const sig = sign(payload);
  const token = Buffer.from(`${payload}.${sig}`).toString('base64url');
  return `${COOKIE_NAME}=${token}; HttpOnly; Path=/; Max-Age=${SESSION_HOURS * 3600}; SameSite=Lax`;
}

export function clearOfficeSessionCookie() {
  return `${COOKIE_NAME}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`;
}

function getOfficeSessionId(req) {
  const cookieHeader = req.headers.cookie || '';
  const match = cookieHeader
    .split(';')
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${COOKIE_NAME}=`));
  if (!match) return null;

  let decoded;
  try {
    decoded = Buffer.from(match.split('=')[1], 'base64url').toString();
  } catch {
    return null;
  }

  const parts = decoded.split('.');
  if (parts.length !== 3) return null;
  const [officeAccountId, expires, sig] = parts;

  if (sign(`${officeAccountId}.${expires}`) !== sig) return null;
  if (Date.now() > Number(expires)) return null;

  return officeAccountId;
}

// คืนข้อมูล office account ถ้า session ใช้ได้ ไม่งั้น redirect ไปหน้า login แล้วคืน null
export async function requireOffice(req, res) {
  const officeAccountId = getOfficeSessionId(req);
  if (!officeAccountId) {
    res.writeHead(302, { Location: '/api/office/action?action=login' });
    res.end();
    return null;
  }

  const { data: office } = await supabase
    .from('office_accounts')
    .select('id, office_name, username')
    .eq('id', officeAccountId)
    .maybeSingle();

  if (!office) {
    res.setHeader('Set-Cookie', clearOfficeSessionCookie());
    res.writeHead(302, { Location: '/api/office/action?action=login' });
    res.end();
    return null;
  }

  return office;
}
