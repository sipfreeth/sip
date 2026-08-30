// api/office/action.js
//
// ศูนย์รวม action ของฝั่ง Office (รวมไฟล์เดียวกันแนวเดียวกับ api/admin/action.js
// เพื่อประหยัดโควต้า Serverless Functions):
//   GET/POST /api/office/action?action=login            — login
//   GET      /api/office/action?action=logout           — logout
//   GET/POST /api/office/action?action=forgot_password  — ขอลิงก์รีเซ็ตรหัสผ่านทางอีเมล
//   GET/POST /api/office/action?action=reset_password   — ตั้งรหัสผ่านใหม่จากลิงก์
//   POST     /api/office/action?action=get_upload_url   — ขอ signed URL อัปโหลดไฟล์ (ระบุ ?slot=1/2/3)
//   POST     /api/office/action?action=save_content     — บันทึกข้อมูลหลังอัปโหลดเสร็จ (ระบุ ?slot=1/2/3)

import bcrypt from 'bcryptjs';
import { supabase } from '../../lib/supabaseClient.js';
import { createOfficeSessionCookie, clearOfficeSessionCookie, requireOffice } from '../../lib/officeAuth.js';
import { createUploadTarget, saveSlotContent } from '../../lib/officeArea.js';
import { sendEmail } from '../../lib/email.js';
import { createResetToken, verifyResetToken, markTokenUsed } from '../../lib/passwordReset.js';
import { sendMessage, getMessages, markThreadRead } from '../../lib/chat.js';

async function readBody(req) {
  let body = '';
  for await (const chunk of req) body += chunk;
  return new URLSearchParams(body);
}

export default async function handler(req, res) {
  const actionParam = req.query.action;

  // ---------- LOGIN ----------
  if (actionParam === 'login') {
    if (req.method === 'GET') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(200).send(renderLoginPage());
      return;
    }
    if (req.method === 'POST') {
      const params = await readBody(req);
      const username = (params.get('username') || '').trim();
      const password = params.get('password') || '';

      const { data: office } = await supabase
        .from('office_accounts')
        .select('id, password_hash')
        .eq('username', username)
        .maybeSingle();

      const validPassword = office ? await bcrypt.compare(password, office.password_hash) : false;

      if (!office || !validPassword) {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.status(200).send(renderLoginPage('Username หรือ Password ไม่ถูกต้อง'));
        return;
      }

      res.setHeader('Set-Cookie', createOfficeSessionCookie(office.id));
      res.writeHead(302, { Location: '/api/office' });
      res.end();
      return;
    }
    res.status(405).send('Method not allowed');
    return;
  }

  // ---------- ลืมรหัสผ่าน: ขอลิงก์รีเซ็ต ----------
  if (actionParam === 'forgot_password') {
    if (req.method === 'GET') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(200).send(renderForgotPasswordPage());
      return;
    }
    if (req.method === 'POST') {
      const params = await readBody(req);
      const email = (params.get('email') || '').trim().toLowerCase();

      const { data: found } = await supabase.from('office_accounts').select('id').eq('email', email).maybeSingle();
      if (found) {
        const token = createResetToken('office', found.id);
        const resetLink = `${process.env.APP_BASE_URL}/api/office/action?action=reset_password&token=${token}`;
        try {
          await sendEmail({
            to: email,
            subject: 'รีเซ็ตรหัสผ่านบัญชี Office',
            html: `<p>คลิกลิงก์นี้เพื่อตั้งรหัสผ่านใหม่ (ลิงก์นี้ใช้ได้ 30 นาที):</p><p><a href="${resetLink}">${resetLink}</a></p><p>ถ้าไม่ได้ขอรีเซ็ตรหัสผ่าน ไม่ต้องทำอะไรเพิ่มครับ</p>`,
          });
        } catch (err) {
          console.error('ส่งอีเมลไม่สำเร็จ:', err.message);
        }
      }

      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(200).send(renderForgotPasswordPage(null, 'ถ้าอีเมลนี้มีอยู่ในระบบ เราได้ส่งลิงก์รีเซ็ตรหัสผ่านไปให้แล้ว กรุณาเช็คกล่องอีเมล'));
      return;
    }
    res.status(405).send('Method not allowed');
    return;
  }

  // ---------- ลืมรหัสผ่าน: ตั้งรหัสผ่านใหม่จากลิงก์ ----------
  if (actionParam === 'reset_password') {
    if (req.method === 'GET') {
      const valid = await verifyResetToken(req.query.token);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(200).send(renderResetPasswordPage(req.query.token, valid ? null : 'ลิงก์นี้หมดอายุหรือถูกใช้ไปแล้ว กรุณาขอลิงก์ใหม่'));
      return;
    }
    if (req.method === 'POST') {
      const params = await readBody(req);
      const tokenData = await verifyResetToken(params.get('token'));
      if (!tokenData || tokenData.accountType !== 'office') {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.status(200).send(renderResetPasswordPage(null, 'ลิงก์นี้หมดอายุหรือถูกใช้ไปแล้ว กรุณาขอลิงก์ใหม่'));
        return;
      }

      const hash = await bcrypt.hash(params.get('new_password'), 10);
      await supabase.from('office_accounts').update({ password_hash: hash }).eq('id', tokenData.accountId);
      await markTokenUsed(tokenData.tokenHash);

      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(200).send(renderResetSuccessPage());
      return;
    }
    res.status(405).send('Method not allowed');
    return;
  }

  // ---------- LOGOUT ----------
  if (actionParam === 'logout') {
    res.setHeader('Set-Cookie', clearOfficeSessionCookie());
    res.writeHead(302, { Location: '/api/office/action?action=login' });
    res.end();
    return;
  }

  // ---------- ต่อจากนี้ต้อง login (office account) ก่อน ----------
  const office = await requireOffice(req, res);
  if (!office) return;

  // ---------- Poll แชท (GET เพื่อรีเฟรชข้อความถี่ๆ) ----------
  if (actionParam === 'chat_poll' && req.method === 'GET') {
    const messages = await getMessages('office', office.id);
    await markThreadRead('office', office.id, 'party');
    res.setHeader('Content-Type', 'application/json');
    res.status(200).json({ messages });
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).send('Method not allowed');
    return;
  }

  // ---------- เปลี่ยนรหัสผ่านของตัวเอง (ไม่เกี่ยวกับ slot) ----------
  if (actionParam === 'change_password') {
    const params = await readBody(req);
    const { data: row } = await supabase.from('office_accounts').select('password_hash').eq('id', office.id).single();
    const valid = row && (await bcrypt.compare(params.get('current_password') || '', row.password_hash));

    if (!valid) {
      res.status(400).send('รหัสผ่านปัจจุบันไม่ถูกต้อง');
      return;
    }

    const hash = await bcrypt.hash(params.get('new_password'), 10);
    await supabase.from('office_accounts').update({ password_hash: hash }).eq('id', office.id);
    res.writeHead(302, { Location: '/api/office' });
    res.end();
    return;
  }

  // ---------- แชทกับทีมงาน ----------
  if (actionParam === 'chat_send') {
    const params = await readBody(req);
    try {
      await sendMessage({
        threadType: 'office',
        threadId: office.id,
        senderType: 'office',
        senderLabel: office.office_name,
        message: params.get('message'),
      });
    } catch (err) {
      res.status(400).send(err.message);
      return;
    }
    res.status(200).send('ok');
    return;
  }

  const slot = Number(req.query.slot);
  if (![1, 2, 3].includes(slot)) {
    res.status(400).send('slot ไม่ถูกต้อง');
    return;
  }

  const params = await readBody(req);

  if (actionParam === 'get_upload_url') {
    try {
      const target = await createUploadTarget(office.id, slot, params.get('file_name') || 'file');
      res.setHeader('Content-Type', 'application/json');
      res.status(200).send(JSON.stringify(target));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
    return;
  }

  if (actionParam === 'save_content') {
    try {
      await saveSlotContent({
        officeAccountId: office.id,
        slotNumber: slot,
        fileName: params.get('file_name'),
        filePath: params.get('file_path'),
        fileType: params.get('file_type'),
        displayAt: params.get('display_at') ? new Date(params.get('display_at')).toISOString() : null,
        editorLabel: `${office.username} (office)`,
      });
      res.status(200).send('ok');
    } catch (err) {
      res.status(500).send(err.message);
    }
    return;
  }

  res.status(400).send('ไม่รู้จัก action นี้');
}

function renderLoginPage(error) {
  return `<!DOCTYPE html>
<html lang="th">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<link rel="stylesheet" href="/theme.css" />
<script src="/theme.js" defer></script>
<title>Office Login</title>
<style>
  body { font-family: sans-serif; background: #f7f8fa; margin: 0; padding: 24px; color: #1b1f27; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
  .card { background: white; border-radius: 16px; padding: 32px; max-width: 360px; width: 100%; box-shadow: 0 1px 4px rgba(0,0,0,0.08); }
  h1 { font-size: 18px; margin: 0 0 20px; }
  label { display: block; font-size: 13px; color: #6b7280; margin-bottom: 4px; }
  input { width: 100%; box-sizing: border-box; padding: 10px 12px; border: 1px solid #e5e7eb; border-radius: 8px; margin-bottom: 16px; font-size: 14px; }
  button { width: 100%; background: #1b1f27; color: white; border: none; padding: 12px; border-radius: 8px; font-size: 14px; cursor: pointer; }
  .error { color: #e76f51; font-size: 13px; margin-bottom: 12px; }
</style>
</head>
<body>
  <div class="card">
    <h1>Office Area Login</h1>
    ${error ? `<p class="error">${error}</p>` : ''}
    <form method="POST" action="/api/office/action?action=login">
      <label>Username</label>
      <input type="text" name="username" required autofocus />
      <label>Password</label>
      <input type="password" name="password" required />
      <button type="submit">Log in</button>
    </form>
    <p style="text-align:center; margin-top:16px; font-size:13px;"><a href="/api/office/action?action=forgot_password">ลืมรหัสผ่าน?</a></p>
  </div>
</body>
</html>`;
}

function renderForgotPasswordPage(error, message) {
  return `<!DOCTYPE html>
<html lang="th">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<link rel="stylesheet" href="/theme.css" />
<script src="/theme.js" defer></script>
<title>ลืมรหัสผ่าน</title>
<style>
  body { font-family: sans-serif; background: #f7f8fa; margin: 0; padding: 24px; color: #1b1f27; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
  .card { background: white; border-radius: 16px; padding: 32px; max-width: 360px; width: 100%; box-shadow: 0 1px 4px rgba(0,0,0,0.08); }
  h1 { font-size: 18px; margin: 0 0 20px; }
  label { display: block; font-size: 13px; color: #6b7280; margin-bottom: 4px; }
  input { width: 100%; box-sizing: border-box; padding: 10px 12px; border: 1px solid #e5e7eb; border-radius: 8px; margin-bottom: 16px; font-size: 14px; }
  button { width: 100%; background: #1b1f27; color: white; border: none; padding: 12px; border-radius: 8px; font-size: 14px; cursor: pointer; }
  .error { color: #e76f51; font-size: 13px; margin-bottom: 12px; }
  .success { color: #06c755; font-size: 13px; margin-bottom: 12px; }
  .link { text-align: center; margin-top: 16px; font-size: 13px; }
</style>
</head>
<body>
  <div class="card">
    <h1>ลืมรหัสผ่าน</h1>
    ${error ? `<p class="error">${error}</p>` : ''}
    ${message ? `<p class="success">${message}</p>` : ''}
    <form method="POST" action="/api/office/action?action=forgot_password">
      <label>อีเมลของ Office</label>
      <input type="email" name="email" required autofocus />
      <button type="submit">ส่งลิงก์รีเซ็ตรหัสผ่าน</button>
    </form>
    <p class="link"><a href="/api/office/action?action=login">กลับไปหน้าเข้าสู่ระบบ</a></p>
  </div>
</body>
</html>`;
}

function renderResetPasswordPage(token, error) {
  const form = token
    ? `
    <form method="POST" action="/api/office/action?action=reset_password">
      <input type="hidden" name="token" value="${token}" />
      <label>รหัสผ่านใหม่</label>
      <input type="password" name="new_password" required minlength="6" autofocus />
      <button type="submit">ตั้งรหัสผ่านใหม่</button>
    </form>`
    : `<p class="link"><a href="/api/office/action?action=forgot_password">ขอลิงก์ใหม่</a></p>`;

  return `<!DOCTYPE html>
<html lang="th">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<link rel="stylesheet" href="/theme.css" />
<script src="/theme.js" defer></script>
<title>ตั้งรหัสผ่านใหม่</title>
<style>
  body { font-family: sans-serif; background: #f7f8fa; margin: 0; padding: 24px; color: #1b1f27; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
  .card { background: white; border-radius: 16px; padding: 32px; max-width: 360px; width: 100%; box-shadow: 0 1px 4px rgba(0,0,0,0.08); }
  h1 { font-size: 18px; margin: 0 0 20px; }
  label { display: block; font-size: 13px; color: #6b7280; margin-bottom: 4px; }
  input { width: 100%; box-sizing: border-box; padding: 10px 12px; border: 1px solid #e5e7eb; border-radius: 8px; margin-bottom: 16px; font-size: 14px; }
  button { width: 100%; background: #1b1f27; color: white; border: none; padding: 12px; border-radius: 8px; font-size: 14px; cursor: pointer; }
  .error { color: #e76f51; font-size: 13px; margin-bottom: 12px; }
  .link { text-align: center; margin-top: 16px; font-size: 13px; }
</style>
</head>
<body>
  <div class="card">
    <h1>ตั้งรหัสผ่านใหม่</h1>
    ${error ? `<p class="error">${error}</p>` : ''}
    ${form}
  </div>
</body>
</html>`;
}

function renderResetSuccessPage() {
  return `<!DOCTYPE html>
<html lang="th">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<link rel="stylesheet" href="/theme.css" />
<script src="/theme.js" defer></script>
<title>ตั้งรหัสผ่านสำเร็จ</title>
<style>
  body { font-family: sans-serif; background: #f7f8fa; margin: 0; padding: 24px; color: #1b1f27; display: flex; align-items: center; justify-content: center; min-height: 100vh; text-align: center; }
  .card { background: white; border-radius: 16px; padding: 32px; max-width: 360px; width: 100%; box-shadow: 0 1px 4px rgba(0,0,0,0.08); }
  .link { margin-top: 16px; font-size: 14px; }
</style>
</head>
<body>
  <div class="card">
    <p>🎉 ตั้งรหัสผ่านใหม่สำเร็จแล้ว</p>
    <p class="link"><a href="/api/office/action?action=login">เข้าสู่ระบบด้วยรหัสผ่านใหม่</a></p>
  </div>
</body>
</html>`;
}
