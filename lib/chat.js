// lib/chat.js
//
// ระบบแชทกลาง ใช้ร่วมกัน 2 ช่องทาง: Sponsor↔Admin และ Office↔Admin
// ทำงานแบบ Poll ถี่ๆ (ทุก 2-3 วินาที) ผ่านระบบ Login เดิมของเรา ไม่ใช้ Websocket จริง
// เพราะ Supabase Realtime ต้องพึ่ง Supabase Auth ซึ่งระบบ Login ของเราไม่ได้ใช้ (เสี่ยงข้อมูลรั่วถ้าเปิดตรงๆ)

import { supabase } from './supabaseClient.js';

export async function sendMessage({ threadType, threadId, senderType, senderLabel, message }) {
  const trimmed = (message || '').trim();
  if (!trimmed) throw new Error('ข้อความว่างเปล่า');

  const isAdmin = senderType === 'admin';
  const { error } = await supabase.from('chat_messages').insert({
    thread_type: threadType,
    thread_id: threadId,
    sender_type: senderType,
    sender_label: senderLabel,
    message: trimmed,
    read_by_admin: isAdmin, // แอดมินส่งเอง = แอดมินอ่านแล้วโดยปริยาย
    read_by_party: !isAdmin, // อีกฝ่ายส่งเอง = อีกฝ่ายอ่านแล้วโดยปริยาย
  });
  if (error) throw error;
}

// ดึงข้อความทั้งหมดของ thread หนึ่ง เรียงเก่า→ใหม่ (เอาไปแสดงเป็นฟองแชท)
export async function getMessages(threadType, threadId) {
  const { data } = await supabase
    .from('chat_messages')
    .select('*')
    .eq('thread_type', threadType)
    .eq('thread_id', threadId)
    .order('created_at', { ascending: true })
    .limit(200);
  return data || [];
}

// มาร์คว่าอ่านแล้ว — ฝั่งไหนเปิดดู ก็มาร์คฝั่งนั้น (ไม่แตะข้อความที่ตัวเองส่งเอง เพราะอ่านแล้วอยู่แล้วตอน insert)
export async function markThreadRead(threadType, threadId, readerType) {
  const field = readerType === 'admin' ? 'read_by_admin' : 'read_by_party';
  await supabase
    .from('chat_messages')
    .update({ [field]: true })
    .eq('thread_type', threadType)
    .eq('thread_id', threadId)
    .eq(field, false);
}

// สำหรับฝั่ง Admin: รายชื่อ thread ทั้งหมดที่เคยมีข้อความ พร้อมข้อความล่าสุด + จำนวนที่ยังไม่อ่าน
export async function getAdminChatThreads() {
  const { data } = await supabase
    .from('chat_messages')
    .select('thread_type, thread_id, sender_type, sender_label, message, created_at, read_by_admin')
    .order('created_at', { ascending: false });

  const threadsMap = {};
  for (const row of data || []) {
    const key = `${row.thread_type}_${row.thread_id}`;
    if (!threadsMap[key]) {
      threadsMap[key] = {
        threadType: row.thread_type,
        threadId: row.thread_id,
        lastMessage: row.message,
        lastSenderLabel: row.sender_label,
        lastAt: row.created_at,
        unreadCount: 0,
      };
    }
    if (!row.read_by_admin && row.sender_type !== 'admin') {
      threadsMap[key].unreadCount++;
    }
  }

  return Object.values(threadsMap).sort((a, b) => new Date(b.lastAt) - new Date(a.lastAt));
}
