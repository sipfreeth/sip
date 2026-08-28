// lib/sponsorAuth.js
//
// ระบบ Login/Logout สำหรับบัญชี Sponsor — แยกจาก admin/office คนละ cookie

import crypto from 'crypto';
import { supabase } from './supabaseClient.js';

const COOKIE_NAME = 'sponsor_session';
const SESSION_HOURS = 24 * 7; // 7 วัน (สปอนเซอร์คงไม่อยาก login บ่อยเท่าแอดมิน)

function sign(value) {
  return crypto.createHmac('sha256', process.env.ADMIN_SECRET).update(value).digest('hex');
}

export function createSponsorSessionCookie(sponsorId) {
  const expires = Date.now() + SESSION_HOURS * 60 * 60 * 1000;
  const payload = `${sponsorId}.${expires}`;
  const sig = sign(payload);
  const token = Buffer.from(`${payload}.${sig}`).toString('base64url');
  return `${COOKIE_NAME}=${token}; HttpOnly; Path=/; Max-Age=${SESSION_HOURS * 3600}; SameSite=Lax`;
}

export function clearSponsorSessionCookie() {
  return `${COOKIE_NAME}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`;
}

function getSponsorSessionId(req) {
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
  const [sponsorId, expires, sig] = parts;

  if (sign(`${sponsorId}.${expires}`) !== sig) return null;
  if (Date.now() > Number(expires)) return null;

  return sponsorId;
}

export async function requireSponsor(req, res) {
  const sponsorId = getSponsorSessionId(req);
  if (!sponsorId) {
    res.writeHead(302, { Location: '/api/sponsor/action?action=login' });
    res.end();
    return null;
  }

  const { data: sponsor } = await supabase.from('sponsors').select('*').eq('id', sponsorId).maybeSingle();

  if (!sponsor) {
    res.setHeader('Set-Cookie', clearSponsorSessionCookie());
    res.writeHead(302, { Location: '/api/sponsor/action?action=login' });
    res.end();
    return null;
  }

  return sponsor;
}
