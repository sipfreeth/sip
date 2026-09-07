// lib/emailVerification.js
//
// ระบบยืนยันอีเมล — ใช้กลไก Token เดิมจาก lib/passwordReset.js (สร้าง/ตรวจสอบ/ทำเครื่องหมายว่าใช้แล้ว)
// แค่ใช้ accountType คนละชุดกับตอน "ลืมรหัสผ่าน" (ต่อท้าย _verify) กันโทเค็นสองเรื่องนี้ใช้แทนกันได้

import { createResetToken } from './passwordReset.js';
import { sendEmail } from './email.js';

export async function sendVerificationEmail({ accountType, accountId, email, verifyActionUrl, displayName }) {
  const token = createResetToken(`${accountType}_verify`, accountId);
  const verifyUrl = `${process.env.APP_BASE_URL}${verifyActionUrl}?token=${token}`;

  await sendEmail({
    to: email,
    subject: 'ยืนยันอีเมลของคุณ',
    html: `
      <p>สวัสดีครับ${displayName ? ` ${displayName}` : ''}</p>
      <p>กรุณายืนยันอีเมลนี้เพื่อยืนยันตัวตนบัญชีของคุณ (ลิงก์นี้ใช้ได้ครั้งเดียว หมดอายุใน 30 นาที)</p>
      <p><a href="${verifyUrl}" style="background:#1b1f27; color:white; padding:10px 20px; border-radius:8px; text-decoration:none; display:inline-block;">ยืนยันอีเมล</a></p>
      <p style="color:#9ca3af; font-size:12px;">ถ้าไม่ได้เป็นคนขอ สามารถเพิกเฉยอีเมลนี้ได้เลย</p>
    `,
  });
}
