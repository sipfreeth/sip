// lib/webpush.js
//
// ส่ง Push Notification จริงผ่านมาตรฐาน Web Push API (ใช้ได้ทั้ง Android และ iOS 16.4+)
//
// *** ต้องติดตั้ง package เพิ่ม ***: รันคำสั่งนี้ในเครื่อง แล้ว commit package.json/package-lock.json ขึ้น GitHub ด้วย
//   npm install web-push
//
// *** ต้องตั้งค่า Environment Variable ใน Vercel เพิ่ม 3 ตัว ***
//   VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY — สร้างไว้ให้แล้ว ดูค่าใน README
//   VAPID_SUBJECT — อีเมลติดต่อ เช่น mailto:admin@yourdomain.com (ใส่อะไรก็ได้ที่เป็นอีเมลจริง)

import webpush from 'web-push';

let configured = false;
function ensureConfigured() {
  if (configured) return;
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || 'mailto:admin@example.com',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
  configured = true;
}

export async function sendPushNotification(subscription, payload) {
  ensureConfigured();
  const pushSubscription = {
    endpoint: subscription.endpoint,
    keys: { p256dh: subscription.p256dh, auth: subscription.auth },
  };
  return webpush.sendNotification(pushSubscription, JSON.stringify(payload));
}
