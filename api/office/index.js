// api/office/index.js
//
// หน้าเดียวที่บัญชี Office เห็น — ล็อกอินแล้วมาที่นี่ตรงๆ ไม่มีเมนูอื่นให้กด
// เห็นและแก้ไขได้แค่ content ของตัวเองเท่านั้น (ผูกกับ office_account_id จาก session)

import { requireOffice } from '../../lib/officeAuth.js';
import { getSlots, renderOfficeAreaContent } from '../../lib/officeArea.js';

export default async function handler(req, res) {
  const office = await requireOffice(req, res);
  if (!office) return;

  const slots = await getSlots(office.id);

  const content = renderOfficeAreaContent({
    officeAccount: office,
    slots,
    canEdit: true,
    uploadUrlAction: '/api/office/action?action=get_upload_url',
    saveAction: '/api/office/action?action=save_content',
    supabaseUrl: process.env.SUPABASE_URL,
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY,
  });

  const passwordSection = `
    <div class="section">
      <h2>เปลี่ยนรหัสผ่านของฉัน</h2>
      <form method="POST" action="/api/office/action?action=change_password">
        <label>รหัสผ่านปัจจุบัน</label>
        <input type="password" name="current_password" required />
        <label>รหัสผ่านใหม่</label>
        <input type="password" name="new_password" required minlength="6" />
        <button type="submit" class="btn-primary" style="margin-top:12px;">บันทึกรหัสผ่านใหม่</button>
      </form>
    </div>`;

  const chatSection = `
    <div class="section">
      <h2>แชทกับทีมงาน</h2>
      <div id="chatBox" style="height:320px; overflow-y:auto; border:1px solid #f0f0f0; border-radius:8px; padding:12px; margin-top:8px;"></div>
      <form id="chatSendForm" style="display:flex; gap:8px; margin-top:12px;">
        <input type="text" id="chatInput" placeholder="พิมพ์ข้อความ..." style="flex:1;" />
        <button type="submit" class="btn-primary" style="width:auto; padding:8px 16px;">ส่ง</button>
      </form>
    </div>
    <script>
      const chatBox = document.getElementById('chatBox');

      function renderMessages(messages) {
        chatBox.innerHTML = messages.map((m) => {
          const mine = m.sender_type === 'office';
          return '<div style="margin-bottom:10px; text-align:' + (mine ? 'right' : 'left') + ';">' +
            '<div style="display:inline-block; max-width:75%; padding:8px 12px; border-radius:10px; background:' + (mine ? '#1b1f27' : '#f0f0f0') + '; color:' + (mine ? 'white' : '#1b1f27') + '; font-size:13px; text-align:left;">' +
            '<div class="hint" style="color:#9ca3af; margin-bottom:2px;">' + (m.sender_label || (mine ? 'คุณ' : 'ทีมงาน')) + '</div>' +
            m.message.replace(/</g, '&lt;') +
            '</div></div>';
        }).join('');
        chatBox.scrollTop = chatBox.scrollHeight;
      }

      async function pollChat() {
        const res = await fetch('/api/office/action?action=chat_poll');
        const data = await res.json();
        renderMessages(data.messages || []);
      }

      document.getElementById('chatSendForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const input = document.getElementById('chatInput');
        const message = input.value.trim();
        if (!message) return;
        input.value = '';
        await fetch('/api/office/action?action=chat_send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ message }).toString(),
        });
        pollChat();
      });

      pollChat();
      setInterval(pollChat, 2500);
    </script>`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.status(200).send(`<!DOCTYPE html>
<html lang="th">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<link rel="stylesheet" href="/theme.css" />
<script src="/theme.js" defer></script>
<title>Office Area — ${office.office_name}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: sans-serif; background: #f7f8fa; margin: 0; color: #1b1f27; }
  header { background: white; border-bottom: 1px solid #e5e7eb; padding: 16px 24px; display: flex; align-items: center; justify-content: space-between; }
  .brand { font-weight: 700; }
  .logout-link { color: #e76f51; text-decoration: none; font-size: 13px; }
  main { padding: 24px; max-width: 640px; margin: 0 auto; }
  .section { background: white; border-radius: 12px; padding: 20px; margin-bottom: 20px; box-shadow: 0 1px 4px rgba(0,0,0,0.06); }
  h2 { font-size: 16px; margin: 0 0 4px; }
  .hint, .muted { font-size: 12px; color: #9ca3af; }
  label { display: block; font-size: 13px; color: #6b7280; margin: 10px 0 4px; }
  input { width: 100%; box-sizing: border-box; padding: 8px 10px; border: 1px solid #e5e7eb; border-radius: 6px; font-size: 14px; }
  .btn-primary { background: #1b1f27; color: white; border: none; padding: 10px 20px; border-radius: 8px; font-size: 14px; cursor: pointer; }
</style>
</head>
<body>
  <header>
    <div class="brand">Office Area</div>
    <a href="/api/office/action?action=logout" class="logout-link">Logout</a>
  </header>
  <main>${content}${chatSection}${passwordSection}</main>
</body>
</html>`);
}
