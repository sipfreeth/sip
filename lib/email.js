// lib/email.js
//
// ส่งอีเมลผ่าน Resend (resend.com) — สมัครฟรี ไม่ต้องติดตั้ง SDK แค่เรียก API ตรงๆ

export async function sendEmail({ to, subject, html }) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: process.env.EMAIL_FROM || 'onboarding@resend.dev',
      to,
      subject,
      html,
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`ส่งอีเมลไม่สำเร็จ: ${errText}`);
  }

  return res.json();
}
