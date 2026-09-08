// lib/linePush.js
//
// ส่งข้อความ Push ผ่าน LINE Messaging API — ใช้ได้เฉพาะกับคนที่เพิ่มเพื่อน OA ไว้แล้วเท่านั้น
// ถ้าไม่ได้เป็นเพื่อนกัน LINE จะตอบ Error กลับมา (จับไว้ให้ฝั่งเรียกใช้ตัดสินใจเองว่าจะแสดงยังไง)

export async function sendLinePushMessage(lineUserId, text) {
  const res = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.LINE_OA_CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({
      to: lineUserId,
      messages: [{ type: 'text', text }],
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(errText);
  }
  return true;
}
