// lib/alerts.js
//
// ส่งอีเมลแจ้งเตือน Admin ทันทีเมื่อระบบสำคัญมีปัญหา (Webhook ล้มเหลว, Cron Job พัง ฯลฯ)
// ใช้ระบบส่งอีเมล (Resend) เดียวกับที่ตั้งไว้แล้วตอนทำ "ลืมรหัสผ่าน" ไม่ต้องสมัครบริการเพิ่ม
//
// ตั้งค่า Environment Variable เพิ่ม 1 ตัว: ADMIN_ALERT_EMAIL=sipfreeth@gmail.com

import { sendEmail } from './email.js';

// จงใจ "กันเหนียว" ไม่ให้ตัวระบบแจ้งเตือนเองพังจนทำให้ฟังก์ชันหลักที่เรียกมันพังตามไปด้วย
// ถ้าส่งอีเมลไม่สำเร็จ (เช่น Resend ล่ม) แค่ Log ไว้เฉยๆ ไม่ throw ต่อ
export async function sendAlertEmail(subject, details) {
  const to = process.env.ADMIN_ALERT_EMAIL;
  if (!to) {
    console.error('⚠️ ยังไม่ได้ตั้งค่า ADMIN_ALERT_EMAIL — ข้ามการส่งอีเมลแจ้งเตือน:', subject);
    return;
  }

  try {
    await sendEmail({
      to,
      subject: `🚨 [แจ้งเตือนระบบ] ${subject}`,
      html: `
        <h2>🚨 แจ้งเตือนจากระบบ QR Tracker</h2>
        <p><strong>เรื่อง:</strong> ${subject}</p>
        <p><strong>เวลาที่เกิด:</strong> ${new Date().toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' })}</p>
        <pre style="background:#f7f8fa; padding:12px; border-radius:8px; white-space:pre-wrap; font-size:13px;">${
          typeof details === 'string' ? details : JSON.stringify(details, null, 2)
        }</pre>
        <p style="color:#9ca3af; font-size:12px;">อีเมลนี้ส่งอัตโนมัติจากระบบ ไม่ต้องตอบกลับ</p>
      `,
    });
  } catch (err) {
    console.error('❌ ส่งอีเมลแจ้งเตือนไม่สำเร็จ:', err.message);
  }
}
