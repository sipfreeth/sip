// public/sw.js — Service Worker สำหรับเกมเลี้ยงสัตว์ (PWA)
// รับ Push Notification จริงจากเซิร์ฟเวอร์ + จัดการตอนกดที่แจ้งเตือน

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let data = { title: 'สัตว์เลี้ยงของคุณหิวแล้ว!', body: 'กลับมาให้อาหารกันเถอะ 🍖' };
  try {
    if (event.data) data = event.data.json();
  } catch {
    // ถ้า payload ไม่ใช่ JSON ใช้ค่าเริ่มต้นด้านบน
  }

  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/pet-icon-192.png',
      badge: '/pet-icon-192.png',
      data: { url: data.url || '/api/member-action?do=pet' },
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || '/api/member-action?do=pet';
  event.waitUntil(
    self.clients.matchAll({ type: 'window' }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.includes('/api/member-action') && 'focus' in client) {
          return client.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});
