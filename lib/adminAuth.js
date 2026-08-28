// lib/adminAuth.js
//
// ระบบ Login/Logout + สิทธิ์ตาม Role สำหรับ Admin/เจ้าหน้าที่

import crypto from 'crypto';
import { supabase } from './supabaseClient.js';

const COOKIE_NAME = 'admin_session';
const SESSION_HOURS = 12;

function sign(value) {
  return crypto.createHmac('sha256', process.env.ADMIN_SECRET).update(value).digest('hex');
}

export function createSessionCookie(username) {
  const expires = Date.now() + SESSION_HOURS * 60 * 60 * 1000;
  const payload = `${username}.${expires}`;
  const sig = sign(payload);
  const token = Buffer.from(`${payload}.${sig}`).toString('base64url');
  return `${COOKIE_NAME}=${token}; HttpOnly; Path=/; Max-Age=${SESSION_HOURS * 3600}; SameSite=Lax`;
}

export function clearSessionCookie() {
  return `${COOKIE_NAME}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`;
}

export function getSessionUsername(req) {
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
  const [username, expires, sig] = parts;

  if (sign(`${username}.${expires}`) !== sig) return null;
  if (Date.now() > Number(expires)) return null;

  return username;
}

// ---- สิทธิ์ตาม Role ----
// super_admin: ทำได้ทุกอย่าง รวมถึงจัดการบัญชีแอดมินคนอื่น
// admin: เหมือน super_admin ทุกอย่าง ยกเว้นจัดการบัญชีแอดมิน (สร้าง/แก้/ลบ/เปลี่ยน role คนอื่น)
// staff: สร้าง Campaign/Reward ได้ และเปิด-ปิดใช้งานได้ แต่แก้ไข/ลบไม่ได้ และแตะข้อมูลสมาชิกไม่ได้
// super_admin: ทำได้ทุกอย่าง รวมถึงจัดการบัญชี Admin/Super Admin คนอื่น (manage_admins)
// admin: เหมือน super_admin เกือบทุกอย่าง ยกเว้นจัดการบัญชีระดับ Admin/Super Admin
//        แต่จัดการบัญชี Staff และ Office ได้ (manage_staff, manage_offices)
// staff: สร้าง Campaign/Reward และเปิด-ปิดใช้งานได้ แก้ไข/ลบไม่ได้ แตะข้อมูลสมาชิกไม่ได้ จัดการบัญชีใครไม่ได้เลย
const ROLE_PERMISSIONS = {
  super_admin: [
    'manage_admins', 'manage_staff', 'manage_offices', 'manage_sponsor_accounts',
    'create_campaign', 'edit_campaign', 'delete_campaign', 'toggle_campaign',
    'create_reward', 'edit_reward', 'delete_reward', 'toggle_reward',
    'edit_member', 'delete_member', 'view_history',
  ],
  admin: [
    'manage_staff', 'manage_offices',
    'create_campaign', 'edit_campaign', 'delete_campaign', 'toggle_campaign',
    'create_reward', 'edit_reward', 'delete_reward', 'toggle_reward',
    'edit_member', 'delete_member', 'view_history',
  ],
  staff: ['create_campaign', 'toggle_campaign', 'create_reward', 'toggle_reward', 'view_history'],
};

export function can(role, permission) {
  return (ROLE_PERMISSIONS[role] || []).includes(permission);
}

// เช็ค login แล้วดึง role มาด้วย — ใช้ในทุกหน้า/action ที่ต้อง login
// คืน { username, role } ถ้าผ่าน หรือ null พร้อม redirect ไปหน้า login ให้อัตโนมัติ
export async function requireAdmin(req, res) {
  const username = getSessionUsername(req);
  if (!username) {
    res.writeHead(302, { Location: '/api/admin/action?action=login' });
    res.end();
    return null;
  }

  const { data: user } = await supabase
    .from('admin_users')
    .select('role')
    .eq('username', username)
    .maybeSingle();

  if (!user) {
    // บัญชีถูกลบไปแล้วแต่ cookie เก่ายังค้างอยู่
    res.setHeader('Set-Cookie', clearSessionCookie());
    res.writeHead(302, { Location: '/api/admin/action?action=login' });
    res.end();
    return null;
  }

  return { username, role: user.role };
}

// เช็คสิทธิ์เฉพาะ action นั้นๆ — เรียกต่อจาก requireAdmin แล้วถ้าไม่ผ่านจะตอบ 403 ให้เอง
export function requirePermission(res, role, permission) {
  if (!can(role, permission)) {
    res.status(403).send('คุณไม่มีสิทธิ์ทำรายการนี้');
    return false;
  }
  return true;
}
