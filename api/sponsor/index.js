// api/sponsor/index.js
//
// หน้าหลักของ Sponsor รวมทุกฟังก์ชันไว้ที่เดียว สลับด้วยแท็บเมนู:
//   ?page=content   — คลัง Content (อัปโหลด/ดูสถานะอนุมัติ)
//   ?page=book      — จองสล็อตใหม่ (เลือก Office แล้วดูปฏิทินความว่าง)
//   ?page=bookings  — บริหารสล็อตที่จองไปแล้ว + ชำระเงิน
//   ?page=profile   — แก้ไขข้อมูลบริษัท + เปลี่ยนรหัสผ่าน
// ค่าเริ่มต้นคือ content

import { supabase } from '../../lib/supabaseClient.js';
import { requireSponsor } from '../../lib/sponsorAuth.js';
import {
  getSponsorContent,
  getSignedContentUrl,
  getAvailability,
  getSponsorBookings,
  getBookingGroup,
  getPlayCountForBooking,
  MAX_FILES_PER_SPONSOR,
  MAX_FILE_MB,
} from '../../lib/sponsorArea.js';

const PAGES = ['content', 'book', 'bookings', 'profile'];

export default async function handler(req, res) {
  const sponsor = await requireSponsor(req, res);
  if (!sponsor) return;

  const page = PAGES.includes(req.query.page) ? req.query.page : 'content';

  let content = '';
  if (page === 'content') content = await renderContentTab(sponsor);
  if (page === 'book') content = await renderBookTab(sponsor, req.query);
  if (page === 'bookings') content = await renderBookingsTab(sponsor, req.query);
  if (page === 'profile') content = renderProfileTab(sponsor);

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.status(200).send(renderLayout(page, sponsor, content));
}

// ---------- Content Library tab ----------
async function renderContentTab(sponsor) {
  const items = await getSponsorContent(sponsor.id);

  const rows = await Promise.all(
    items.map(async (item) => {
      const url = await getSignedContentUrl(item.file_path);
      const preview =
        item.file_type === 'video'
          ? `<video src="${url}" controls style="width:100%; max-height:140px; border-radius:8px;"></video>`
          : `<img src="${url}" style="width:100%; max-height:140px; object-fit:cover; border-radius:8px;" />`;
      return `
        <div class="content-card">
          ${preview}
          <p style="font-size:13px; font-weight:600; margin:8px 0 2px;">${item.file_name}</p>
          <form method="POST" action="/api/sponsor/action?action=delete_content" onsubmit="return confirm('ลบไฟล์นี้?')" style="margin-top:8px;">
            <input type="hidden" name="content_id" value="${item.id}" />
            <button class="btn-small btn-danger" type="submit">ลบ</button>
          </form>
        </div>`;
    })
  );

  const canUploadMore = items.length < MAX_FILES_PER_SPONSOR;

  const uploadForm = canUploadMore
    ? `
      <div class="section">
        <h2>อัปโหลดไฟล์ใหม่</h2>
        <p class="hint">JPEG, PNG, MP4 — ไม่เกิน ${MAX_FILE_MB}MB — ใช้ได้สูงสุด ${MAX_FILES_PER_SPONSOR} ไฟล์ต่อบัญชี (ตอนนี้มี ${items.length}/${MAX_FILES_PER_SPONSOR})</p>
        <p class="hint">อัปโหลดเสร็จใช้เลือกลง Slot ได้ทันที — Admin จะตรวจสอบตอนที่คุณเลือกใส่ Slot อีกครั้งก่อนขึ้นจอจริง</p>
        <form class="sponsor-upload-form">
          <input type="file" name="file" accept="image/jpeg,image/png,video/mp4" required />
          <button type="submit" class="btn-primary" style="margin-top:10px;">อัปโหลด</button>
          <p class="upload-status hint" style="margin-top:8px;"></p>
        </form>
      </div>`
    : `<div class="section"><p class="muted">ใช้ครบ ${MAX_FILES_PER_SPONSOR} ไฟล์แล้ว ลบไฟล์เก่าก่อนถึงจะอัปโหลดเพิ่มได้</p></div>`;

  return `
    ${uploadForm}
    <div class="section">
      <h2>ไฟล์ทั้งหมดของฉัน</h2>
      <div class="content-grid">${rows.join('') || '<p class="muted">ยังไม่มีไฟล์</p>'}</div>
    </div>
    <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js"></script>
    <script>
      const sb = supabase.createClient(${JSON.stringify(process.env.SUPABASE_URL)}, ${JSON.stringify(process.env.SUPABASE_ANON_KEY)});
      const form = document.querySelector('.sponsor-upload-form');
      if (form) {
        form.addEventListener('submit', async (e) => {
          e.preventDefault();
          const fileInput = form.querySelector('input[name="file"]');
          const statusEl = form.querySelector('.upload-status');
          const file = fileInput.files[0];
          if (!file) return;
          if (file.size > ${MAX_FILE_MB} * 1024 * 1024) { statusEl.textContent = 'ไฟล์ใหญ่เกิน ${MAX_FILE_MB}MB'; return; }

          statusEl.textContent = 'กำลังขอสิทธิ์อัปโหลด...';
          try {
            const urlRes = await fetch('/api/sponsor/action?action=get_upload_url', {
              method: 'POST',
              headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
              body: 'file_name=' + encodeURIComponent(file.name),
            });
            const urlData = await urlRes.json();
            if (!urlRes.ok) throw new Error(urlData.error || 'ขอสิทธิ์อัปโหลดไม่สำเร็จ');

            statusEl.textContent = 'กำลังอัปโหลดไฟล์...';
            const { error: uploadError } = await sb.storage.from('sponsor-content').uploadToSignedUrl(urlData.path, urlData.token, file);
            if (uploadError) throw uploadError;

            statusEl.textContent = 'กำลังบันทึกข้อมูล...';
            const fileType = file.type.startsWith('video') ? 'video' : 'image';
            const saveRes = await fetch('/api/sponsor/action?action=save_content', {
              method: 'POST',
              headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
              body: new URLSearchParams({ file_path: urlData.path, file_name: file.name, file_type: fileType }).toString(),
            });
            if (!saveRes.ok) throw new Error(await saveRes.text());

            statusEl.textContent = 'อัปโหลดสำเร็จ กำลังโหลดหน้าใหม่...';
            setTimeout(() => window.location.reload(), 800);
          } catch (err) {
            statusEl.textContent = 'เกิดข้อผิดพลาด: ' + err.message;
          }
        });
      }

      if (reservedUntil) {
        const countdownEl = document.getElementById('countdown');
        function tick() {
          const diff = new Date(reservedUntil).getTime() - Date.now();
          if (diff <= 0) {
            countdownEl.textContent = 'หมดเวลาชำระเงินแล้ว กรุณาจองใหม่';
            return;
          }
          const mins = Math.floor(diff / 60000);
          const secs = Math.floor((diff % 60000) / 1000);
          countdownEl.textContent = 'เหลือเวลาชำระเงิน ' + mins + ':' + String(secs).padStart(2, '0');
          setTimeout(tick, 1000);
        }
        tick();
      }
    </script>`;
}

// ---------- Book tab (จองใหม่) ----------
async function renderBookTab(sponsor, query) {
  const selectedOfficeId = query.office_id || null;
  const { data: offices } = await supabase
    .from('office_accounts')
    .select('id, office_name, price_per_week, sponsor_slot_count')
    .order('office_name');

  if (!offices || !offices.length) {
    return `<div class="section"><p class="muted">ยังไม่มี Office ให้จองตอนนี้</p></div>`;
  }

  const activeId = selectedOfficeId || offices[0].id;
  const activeOffice = offices.find((o) => String(o.id) === String(activeId)) || offices[0];
  const slotCount = activeOffice.sponsor_slot_count || 18;

  const approvedContent = await getSponsorContent(sponsor.id);

  const officeOptions = offices
    .map((o) => `<option value="${o.id}" ${String(o.id) === String(activeId) ? 'selected' : ''}>${o.office_name} — ${Number(o.price_per_week).toLocaleString()} บาท/สัปดาห์</option>`)
    .join('');

  const picker = `
    <div class="section">
      <h2>1. เลือก Office</h2>
      <form method="GET" action="/api/sponsor">
        <input type="hidden" name="page" value="book" />
        <select name="office_id" class="table-input" style="max-width:320px;" onchange="this.form.submit()">
          ${officeOptions}
        </select>
      </form>
    </div>`;

  const { weeks, bookedMap } = await getAvailability(activeOffice.id);

  const activeWeekIso = query.week || weeks[0].toISOString().slice(0, 10);
  const activeWeekDate = weeks.find((w) => w.toISOString().slice(0, 10) === activeWeekIso) || weeks[0];
  const activeWeekEnd = new Date(activeWeekDate);
  activeWeekEnd.setDate(activeWeekDate.getDate() + 6);

  const weekTabs = weeks
    .map((w) => {
      const wIso = w.toISOString().slice(0, 10);
      const isActive = wIso === activeWeekIso;
      return `<a href="/api/sponsor?page=book&office_id=${activeOffice.id}&week=${wIso}" class="tab ${isActive ? 'active' : ''}" style="border:1px solid #e5e7eb; border-radius:8px; margin-right:8px;">${w.toLocaleDateString('th-TH', { day: 'numeric', month: 'short' })}</a>`;
    })
    .join('');

  const weekPicker = `
    <div class="section">
      <h2>2. เลือกสัปดาห์</h2>
      <p class="hint">แสดงล่วงหน้า ${weeks.length} สัปดาห์ (วิ่งไปเรื่อยๆ ทีละสัปดาห์)</p>
      <div style="display:flex; flex-wrap:wrap;">${weekTabs}</div>
    </div>`;

  const slotNumbers = Array.from({ length: slotCount }, (_, i) => i + 1);
  let availableCount = 0;

  const contentOptionsHtml = approvedContent.map((c) => `<option value="${c.id}">${c.file_name}</option>`).join('');

  const slotCheckboxes = slotNumbers
    .map((slotNum) => {
      const booking = bookedMap[`${slotNum}_${activeWeekIso}`];
      if (booking) {
        return `<div class="slot-box slot-full">Slot ${slotNum}<br/><span class="hint">ไม่ว่าง</span></div>`;
      }
      availableCount++;
      return `
        <div class="slot-box slot-available">
          <label style="display:block; cursor:pointer;">
            <input type="checkbox" class="slot-checkbox" data-slot="${slotNum}" />
            Slot ${slotNum}<br/><span class="hint">ว่าง</span>
          </label>
          <select name="content_slot_${slotNum}" class="slot-content-select table-input" data-slot="${slotNum}" style="display:none; margin-top:8px; width:100%;" disabled>
            <option value="">-- เลือกไฟล์ --</option>
            ${contentOptionsHtml}
          </select>
        </div>`;
    })
    .join('');

  const bookingForm = approvedContent.length
    ? `
    <div class="section">
      <h2>3. เลือก Slot และไฟล์ที่จะแสดง (เลือกได้หลาย Slot พร้อมกัน แต่ละอันเลือกไฟล์แยกกันได้)</h2>
      <p class="hint">ว่าง ${availableCount}/${slotCount} slot ในสัปดาห์นี้ — ราคา ${Number(activeOffice.price_per_week).toLocaleString()} บาท/slot</p>
      <p class="hint">หลังจองและชำระเงินแล้ว ทีมงานจะตรวจสอบไฟล์ที่เลือกอีกครั้งก่อนส่งขึ้นจอจริง</p>
      <form method="POST" action="/api/sponsor/action?action=create_bookings" id="bookForm">
        <input type="hidden" name="office_id" value="${activeOffice.id}" />
        <input type="hidden" name="week_start" value="${activeWeekIso}" />
        <input type="hidden" name="slot_numbers" id="slotNumbersField" />
        <div class="slot-grid">${slotCheckboxes}</div>
        <p id="totalPrice" class="hint" style="margin-top:12px; font-size:16px; font-weight:700; color:#1b1f27;">ยอดรวม: 0 บาท</p>
        <button type="submit" class="btn-primary" style="margin-top:8px;">ยืนยันการจอง (ต้องชำระเงินภายใน 15 นาที)</button>
      </form>
    </div>
    <script>
      const pricePerSlot = ${activeOffice.price_per_week};
      const totalEl = document.getElementById('totalPrice');
      document.querySelectorAll('.slot-checkbox').forEach((cb) => {
        cb.addEventListener('change', () => {
          const slot = cb.dataset.slot;
          const select = document.querySelector('.slot-content-select[data-slot="' + slot + '"]');
          select.style.display = cb.checked ? 'block' : 'none';
          select.disabled = !cb.checked;
          select.required = cb.checked;
          if (cb.checked) {
            // เลือกไฟล์แรกที่อนุมัติแล้วให้อัตโนมัติ (ตัวเลือกแรกคือ "-- เลือกไฟล์ --" ว่างเปล่า ข้ามไปตัวถัดไป)
            if (select.options.length > 1) select.selectedIndex = 1;
          } else {
            select.value = '';
          }
          updateTotal();
        });
      });
      function updateTotal() {
        const count = document.querySelectorAll('.slot-checkbox:checked').length;
        totalEl.textContent = 'เลือก ' + count + ' slot — ยอดรวม: ' + (count * pricePerSlot).toLocaleString() + ' บาท';
      }
      document.getElementById('bookForm').addEventListener('submit', (e) => {
        const checked = document.querySelectorAll('.slot-checkbox:checked');
        if (checked.length === 0) {
          e.preventDefault();
          alert('กรุณาเลือกอย่างน้อย 1 slot');
          return;
        }
        document.getElementById('slotNumbersField').value = Array.from(checked).map((cb) => cb.dataset.slot).join(',');
      });
    </script>
    <style>
      .slot-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 8px; margin-top: 12px; }
      .slot-box { border: 1px solid #e5e7eb; border-radius: 8px; padding: 10px; font-size: 13px; }
      .slot-full { background: #f0f0f0; color: #9ca3af; text-align: center; cursor: not-allowed; }
      .slot-available:has(input:checked) { border-color: #06c755; background: #06c75511; }
    </style>`
    : `<div class="section"><p class="hint" style="color:#e76f51;">คุณยังไม่มีไฟล์ในคลัง ต้องอัปโหลดไฟล์ในแท็บ Content Library ก่อนถึงจะจองได้</p></div>`;

  return picker + weekPicker + bookingForm;
}

// ---------- Bookings tab (บริหารสล็อตที่จองแล้ว + ชำระเงิน) ----------
async function renderBookingsTab(sponsor, query) {
  // ---------- ขั้นชำระเงิน (มาจากการกด "ชำระเงิน" ในรายการ — จ่ายทีเดียวทั้งกลุ่มที่จองพร้อมกัน) ----------
  if (query.pay) {
    const group = await getBookingGroup(query.pay, sponsor.id);
    if (!group.length) return `<div class="section"><p class="muted">ไม่พบรายการจองนี้ หรือหมดเวลาชำระเงินแล้ว</p></div>`;
    if (group[0].payment_status === 'paid') {
      return `<div class="section"><p>รายการนี้ชำระเงินแล้ว</p></div>`;
    }
    return renderPaymentStep(group);
  }

  const bookings = await getSponsorBookings(sponsor.id);
  const approvedContent = await getSponsorContent(sponsor.id);
  const contentOptions = (currentId) =>
    approvedContent.map((c) => `<option value="${c.id}" ${c.id === currentId ? 'selected' : ''}>${c.file_name}</option>`).join('');

  const rows = await Promise.all(
    bookings.map(async (b) => {
      const statusLabel = { unpaid: 'รอชำระเงิน', paid: 'ชำระแล้ว', refunded: 'คืนเงินแล้ว' }[b.payment_status] || b.payment_status;
      const statusColor = { unpaid: '#e76f51', paid: '#06c755', refunded: '#9ca3af' }[b.payment_status] || '#9ca3af';
      const approvalLabel = { pending: 'รอตรวจสอบไฟล์', approved: 'ไฟล์ผ่านแล้ว', rejected: 'ไฟล์ไม่ผ่าน' }[b.approval_status] || b.approval_status;
      const approvalColor = { pending: '#d4a017', approved: '#06c755', rejected: '#e76f51' }[b.approval_status] || '#9ca3af';
      const weekDate = new Date(b.week_start);
      const isExpired = b.payment_status === 'unpaid' && b.reserved_until && new Date(b.reserved_until) < new Date();

      // เห็นจำนวนรอบเล่นจริงแค่รายการที่จ่ายเงินแล้ว (ยังไม่จ่าย = ยังไม่ถูกส่งไปเล่นบนจอ)
      const playCount = b.payment_status === 'paid' ? await getPlayCountForBooking(b.office_account_id, b.slot_number, b.week_start) : null;

      const actions =
        b.payment_status === 'unpaid' && !isExpired
          ? `
            <a href="/api/sponsor?page=bookings&pay=${b.booking_group_id}" class="btn-small">ชำระเงิน</a>
            <form method="POST" action="/api/sponsor/action?action=cancel_booking" onsubmit="return confirm('ยกเลิกการจองนี้?')" style="display:inline;">
              <input type="hidden" name="booking_id" value="${b.id}" />
              <button class="btn-small btn-danger">ยกเลิก</button>
            </form>`
          : isExpired
          ? '<span class="hint">หมดเวลาชำระเงิน</span>'
          : '';

      return `
        <tr>
          <td>${b.office_accounts?.office_name || '-'} — Slot ${b.slot_number}</td>
          <td>${weekDate.toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: 'numeric' })}</td>
          <td>
            <form method="POST" action="/api/sponsor/action?action=update_booking_content" class="inline-form">
              <input type="hidden" name="booking_id" value="${b.id}" />
              <select name="sponsor_content_id" class="table-input">${contentOptions(b.sponsor_content_id)}</select>
          </td>
          <td style="text-align:center;"><button class="btn-small">บันทึก</button></form></td>
          <td style="text-align:right;">${Number(b.price).toLocaleString()} บาท</td>
          <td style="text-align:center;"><span class="tier-tag" style="background:${statusColor};">${statusLabel}</span></td>
          <td style="text-align:center;"><span class="tier-tag" style="background:${approvalColor};">${approvalLabel}</span></td>
          <td style="text-align:center;">${playCount === null ? '<span class="muted">-</span>' : `<strong>${playCount.toLocaleString()}</strong> รอบ`}</td>
          <td>${actions}</td>
        </tr>`;
    })
  );

  return `
    <div class="section">
      <h2>สล็อตที่จองไว้ทั้งหมด</h2>
      <p class="hint">รายการ "รอชำระเงิน" ต้องจ่ายภายใน 15 นาทีหลังจอง ไม่งั้นระบบจะคืน slot ให้คนอื่นอัตโนมัติ</p>
      <table>
        <tr><th>Office / Slot</th><th>สัปดาห์</th><th>ไฟล์ที่แสดง</th><th></th><th style="text-align:right;">ราคา</th><th style="text-align:center;">สถานะจ่ายเงิน</th><th style="text-align:center;">สถานะไฟล์</th><th style="text-align:center;">เล่นแล้ว</th><th></th></tr>
        ${rows.join('') || '<tr><td colspan="9" class="muted">ยังไม่มีการจอง</td></tr>'}
      </table>
    </div>`;
}

function renderPaymentStep(group) {
  const totalPrice = group.reduce((sum, b) => sum + Number(b.price), 0);
  const officeName = group[0].office_accounts?.office_name || '-';
  const slotList = group.map((b) => 'Slot ' + b.slot_number).join(', ');
  const groupId = group[0].booking_group_id;
  const reservedUntil = group[0].reserved_until;

  return `
    <div class="section">
      <h2>ชำระเงิน</h2>
      <p>${officeName} — ${slotList} (${group.length} slot)</p>
      <p style="font-size:24px; font-weight:700; margin:8px 0 8px;">${totalPrice.toLocaleString()} บาท</p>
      ${reservedUntil ? `<p class="hint" id="countdown" style="color:#e76f51;"></p>` : ''}

      <div style="display:flex; gap:8px; margin-bottom:16px;">
        <button type="button" class="btn-small" onclick="showTab('card')">บัตรเครดิต/เดบิต</button>
        <button type="button" class="btn-small" onclick="showTab('transfer')">โอนเงิน / QR</button>
      </div>

      <div id="tab-card">
        <div id="card-form">
          <input type="text" id="card-name" placeholder="ชื่อบนบัตร" />
          <input type="text" id="card-number" placeholder="หมายเลขบัตร" style="margin-top:8px;" />
          <div style="display:flex; gap:8px; margin-top:8px;">
            <input type="text" id="card-expmonth" placeholder="MM" style="width:60px;" />
            <input type="text" id="card-expyear" placeholder="YYYY" style="width:80px;" />
            <input type="text" id="card-cvv" placeholder="CVV" style="width:80px;" />
          </div>
          <button type="button" class="btn-primary" style="margin-top:12px;" onclick="payByCard()">ชำระด้วยบัตร</button>
          <p id="card-status" class="hint" style="margin-top:8px;"></p>
        </div>
      </div>

      <div id="tab-transfer" style="display:none;">
        <p class="hint">โอนเงินตามช่องทางที่ทีมงานแจ้งไว้ แล้วอัปโหลดสลิปด้านล่าง ระบบจะตรวจสอบยอดเงินให้อัตโนมัติ</p>
        <form class="slip-upload-form">
          <input type="file" name="slip" accept="image/jpeg,image/png,image/webp" required />
          <button type="submit" class="btn-primary" style="margin-top:10px;">อัปโหลดสลิป</button>
          <p class="slip-status hint" style="margin-top:8px;"></p>
        </form>
      </div>
    </div>

    <script src="https://cdn.omise.co/omise.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js"></script>
    <script>
      OmiseCard.configure({ publicKey: ${JSON.stringify(process.env.OMISE_PUBLIC_KEY || '')} });
      const sb = supabase.createClient(${JSON.stringify(process.env.SUPABASE_URL)}, ${JSON.stringify(process.env.SUPABASE_ANON_KEY)});
      const groupId = ${JSON.stringify(groupId)};
      const reservedUntil = ${JSON.stringify(reservedUntil)};

      function showTab(name) {
        document.getElementById('tab-card').style.display = name === 'card' ? 'block' : 'none';
        document.getElementById('tab-transfer').style.display = name === 'transfer' ? 'block' : 'none';
      }

      function payByCard() {
        const statusEl = document.getElementById('card-status');
        statusEl.textContent = 'กำลังส่งข้อมูลบัตร...';
        OmiseCard.createToken('card', {
          name: document.getElementById('card-name').value,
          number: document.getElementById('card-number').value,
          expiration_month: document.getElementById('card-expmonth').value,
          expiration_year: document.getElementById('card-expyear').value,
          security_code: document.getElementById('card-cvv').value,
        }, async (statusCode, response) => {
          if (statusCode !== 200) {
            statusEl.textContent = 'ข้อมูลบัตรไม่ถูกต้อง: ' + (response.message || '');
            return;
          }
          statusEl.textContent = 'กำลังทำรายการชำระเงิน...';
          const res = await fetch('/api/sponsor/action?action=pay_by_card', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ group_id: groupId, omise_token: response.id }).toString(),
          });
          const data = await res.json();
          if (!res.ok) { statusEl.textContent = 'เกิดข้อผิดพลาด: ' + (data.error || ''); return; }
          if (data.redirect) { window.location.href = data.redirect; return; }
          if (data.paid) { statusEl.textContent = 'ชำระเงินสำเร็จ กำลังพาไปหน้ารายการจอง...'; setTimeout(() => window.location.href = '/api/sponsor?page=bookings', 1000); return; }
          statusEl.textContent = 'การชำระเงินไม่สำเร็จ กรุณาลองใหม่หรือใช้บัตรอื่น';
        });
      }

      const slipForm = document.querySelector('.slip-upload-form');
      if (slipForm) {
        slipForm.addEventListener('submit', async (e) => {
          e.preventDefault();
          const fileInput = slipForm.querySelector('input[name="slip"]');
          const statusEl = slipForm.querySelector('.slip-status');
          const file = fileInput.files[0];
          if (!file) return;

          statusEl.textContent = 'กำลังขอสิทธิ์อัปโหลด...';
          try {
            const urlRes = await fetch('/api/sponsor/action?action=get_slip_upload_url', {
              method: 'POST',
              headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
              body: new URLSearchParams({ group_id: groupId, file_name: file.name }).toString(),
            });
            const urlData = await urlRes.json();
            if (!urlRes.ok) throw new Error(urlData.error || 'ขอสิทธิ์อัปโหลดไม่สำเร็จ');

            statusEl.textContent = 'กำลังอัปโหลดสลิป...';
            const { error: uploadError } = await sb.storage.from('payment-slips').uploadToSignedUrl(urlData.path, urlData.token, file);
            if (uploadError) throw uploadError;

            statusEl.textContent = 'กำลังตรวจสอบสลิป...';
            const verifyRes = await fetch('/api/sponsor/action?action=verify_slip', {
              method: 'POST',
              headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
              body: new URLSearchParams({ group_id: groupId, file_path: urlData.path }).toString(),
            });
            const verifyData = await verifyRes.json();
            if (verifyData.paid) {
              statusEl.textContent = 'ตรวจสอบสำเร็จ ชำระเงินเรียบร้อย กำลังพาไปหน้ารายการจอง...';
              setTimeout(() => window.location.href = '/api/sponsor?page=bookings', 1200);
            } else {
              statusEl.textContent = 'ตรวจสอบอัตโนมัติไม่ผ่าน (' + (verifyData.message || 'ยอดเงินหรือข้อมูลไม่ตรง') + ') — ทีมงานจะตรวจสอบสลิปนี้ให้อีกครั้งด้วยมือ';
            }
          } catch (err) {
            statusEl.textContent = 'เกิดข้อผิดพลาด: ' + err.message;
          }
        });
      }

      if (reservedUntil) {
        const countdownEl = document.getElementById('countdown');
        function tick() {
          const diff = new Date(reservedUntil).getTime() - Date.now();
          if (diff <= 0) {
            countdownEl.textContent = 'หมดเวลาชำระเงินแล้ว กรุณาจองใหม่';
            return;
          }
          const mins = Math.floor(diff / 60000);
          const secs = Math.floor((diff % 60000) / 1000);
          countdownEl.textContent = 'เหลือเวลาชำระเงิน ' + mins + ':' + String(secs).padStart(2, '0');
          setTimeout(tick, 1000);
        }
        tick();
      }
    </script>`;
}

// ---------- Profile tab ----------
function renderProfileTab(sponsor) {
  return `
    <div class="section">
      <h2>ข้อมูลบริษัท</h2>
      <form method="POST" action="/api/sponsor/action?action=update_profile" class="stack-form">
        <label>ชื่อบริษัท</label>
        <input type="text" name="company_name" value="${sponsor.company_name || ''}" required />
        <label>เลขประจำตัวผู้เสียภาษี</label>
        <input type="text" name="tax_id" value="${sponsor.tax_id || ''}" />
        <label>ที่อยู่</label>
        <input type="text" name="address" value="${sponsor.address || ''}" />
        <label>ชื่อผู้ติดต่อ</label>
        <input type="text" name="contact_name" value="${sponsor.contact_name || ''}" />
        <label>เบอร์โทร</label>
        <input type="text" name="contact_phone" value="${sponsor.contact_phone || ''}" />
        <label>ประเภทธุรกิจ</label>
        <input type="text" name="business_type" value="${sponsor.business_type || ''}" />
        <button type="submit" class="btn-primary" style="margin-top:12px;">บันทึก</button>
      </form>
    </div>
    <div class="section">
      <h2>เปลี่ยนรหัสผ่าน</h2>
      <form method="POST" action="/api/sponsor/action?action=change_password" class="stack-form">
        <label>รหัสผ่านปัจจุบัน</label>
        <input type="password" name="current_password" required />
        <label>รหัสผ่านใหม่</label>
        <input type="password" name="new_password" required minlength="6" />
        <button type="submit" class="btn-primary" style="margin-top:12px;">บันทึกรหัสผ่านใหม่</button>
      </form>
    </div>`;
}

// ---------- Layout ----------
function renderLayout(activePage, sponsor, content) {
  const tabs = [
    { key: 'content', label: 'Content Library' },
    { key: 'book', label: 'จองสล็อตใหม่' },
    { key: 'bookings', label: 'สล็อตของฉัน' },
    { key: 'profile', label: 'Profile' },
  ];
  const nav = tabs
    .map((t) => `<a href="/api/sponsor?page=${t.key}" class="tab ${activePage === t.key ? 'active' : ''}">${t.label}</a>`)
    .join('');

  return `<!DOCTYPE html>
<html lang="th">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<link rel="stylesheet" href="/theme.css" />
<script src="/theme.js" defer></script>
<title>Sponsor — ${sponsor.company_name}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: sans-serif; background: #f7f8fa; margin: 0; color: #1b1f27; }
  header { background: white; border-bottom: 1px solid #e5e7eb; padding: 0 24px; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; }
  .brand { font-weight: 700; padding: 16px 0; }
  nav { display: flex; gap: 4px; flex-wrap: wrap; }
  .tab { padding: 16px 12px; text-decoration: none; color: #6b7280; font-size: 14px; border-bottom: 2px solid transparent; }
  .tab.active { color: #1b1f27; font-weight: 700; border-bottom-color: #1b1f27; }
  .user-info { display: flex; align-items: center; gap: 12px; font-size: 13px; color: #6b7280; }
  .logout-link { color: #e76f51; text-decoration: none; }
  main { padding: 24px; max-width: 960px; margin: 0 auto; }
  .section { background: white; border-radius: 12px; padding: 20px; margin-bottom: 20px; box-shadow: 0 1px 4px rgba(0,0,0,0.06); }
  h2 { font-size: 16px; margin: 0 0 4px; }
  .hint, .muted { font-size: 12px; color: #9ca3af; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; margin-top: 8px; }
  th, td { padding: 8px 6px; border-bottom: 1px solid #f0f0f0; }
  .btn-small { background: #06c755; color: white; border: none; padding: 6px 12px; border-radius: 6px; font-size: 12px; cursor: pointer; text-decoration: none; display: inline-block; }
  .btn-danger { background: #e76f51; }
  .btn-primary { background: #1b1f27; color: white; border: none; padding: 10px 20px; border-radius: 8px; font-size: 14px; cursor: pointer; }
  .tier-tag { color: white; font-size: 11px; font-weight: 700; padding: 3px 10px; border-radius: 999px; }
  .stack-form { display: flex; flex-direction: column; max-width: 420px; }
  .stack-form label { font-size: 13px; color: #6b7280; margin: 10px 0 4px; }
  .stack-form input { padding: 8px 10px; border: 1px solid #e5e7eb; border-radius: 6px; font-size: 14px; }
  .table-input { padding: 8px 10px; border: 1px solid #e5e7eb; border-radius: 6px; font-size: 14px; }
  .content-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 16px; margin-top: 12px; }
  .content-card { border: 1px solid #f0f0f0; border-radius: 10px; padding: 10px; }
  .inline-form { display: contents; }
  #card-form input { width: 100%; box-sizing: border-box; padding: 8px 10px; border: 1px solid #e5e7eb; border-radius: 6px; font-size: 14px; }
</style>
</head>
<body>
  <header>
    <div class="brand">${sponsor.company_name}</div>
    <nav>${nav}</nav>
    <div class="user-info">
      <a href="/api/sponsor/action?action=logout" class="logout-link">Logout</a>
    </div>
  </header>
  <main>${content}</main>
</body>
</html>`;
}
