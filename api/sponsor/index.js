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
  getSponsorCreditBalance,
  getAiringStatus,
  AIRING_STATUS_LABEL,
  BUSINESS_TYPE_LABEL,
  MAX_FILES_PER_SPONSOR,
  MAX_IMAGE_MB,
  MAX_VIDEO_MB,
  MAX_VIDEO_SECONDS,
} from '../../lib/sponsorArea.js';
import { listCustomerCards, isPromptPayConfigured, getPromptPayQrImageUrl, SUPPORTED_BANKS } from '../../lib/payments.js';

const PAGES = ['content', 'book', 'bookings', 'profile', 'chat', 'qr'];

export default async function handler(req, res) {
  const sponsor = await requireSponsor(req, res);
  if (!sponsor) return;

  const page = PAGES.includes(req.query.page) ? req.query.page : 'content';

  let content = '';
  if (page === 'content') content = await renderContentTab(sponsor);
  if (page === 'book') content = await renderBookTab(sponsor, req.query);
  if (page === 'bookings') content = await renderBookingsTab(sponsor, req.query);
  if (page === 'profile') content = await renderProfileTab(sponsor);
  if (page === 'chat') content = renderChatTab(sponsor);
  if (page === 'qr') content = await renderQrCampaignsTab(sponsor);

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.status(200).send(renderLayout(page, sponsor, content));
}

// ---------- Content Library tab ----------
async function renderContentTab(sponsor) {
  const items = await getSponsorContent(sponsor.id);
  const { data: campaigns } = await supabase.from('creatives').select('creative_id, campaign_name').eq('sponsor_id', sponsor.id).eq('active', true);

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
          ${item.creative_id ? `<p class="hint" style="margin:0 0 6px;">🔗 QR: ${item.creative_id}</p>` : ''}
          <button class="btn-small btn-danger delete-content-btn" data-content-id="${item.id}" style="margin-top:8px;">ลบ</button>
        </div>`;
    })
  );

  const canUploadMore = items.length < MAX_FILES_PER_SPONSOR;
  const campaignOptions = (campaigns || []).map((c) => `<option value="${c.creative_id}">${c.campaign_name || c.creative_id}</option>`).join('');

  const uploadForm = canUploadMore
    ? `
      <div class="section">
        <h2>อัปโหลดไฟล์ใหม่</h2>
        <p class="hint">รูปภาพ (JPEG, PNG) ไม่เกิน ${MAX_IMAGE_MB}MB — วิดีโอ (MP4) ไม่เกิน ${MAX_VIDEO_MB}MB และ**ความยาวไม่เกิน ${MAX_VIDEO_SECONDS} วินาที** — ใช้ได้สูงสุด ${MAX_FILES_PER_SPONSOR} ไฟล์ต่อบัญชี (ตอนนี้มี ${items.length}/${MAX_FILES_PER_SPONSOR})</p>
        <p class="hint" style="color:#e76f51; font-weight:600;">⚠️ ไฟล์ต้องไม่กว้างกว่า 16:9 (เช่น 1920x1080) ตามสเปคจอที่ติดตั้งจริง — แคบกว่าได้ (เช่น 4:3, 1:1) แต่กว้างกว่าจะถูกปฏิเสธอัตโนมัติ</p>
        <p class="hint">อัปโหลดเสร็จใช้เลือกลง Slot ได้ทันที — Admin จะตรวจสอบตอนที่คุณเลือกใส่ Slot อีกครั้งก่อนขึ้นจอจริง</p>
        <form class="sponsor-upload-form">
          <input type="file" name="file" accept="image/jpeg,image/png,video/mp4" required />

          <label style="display:block; margin-top:12px; font-weight:600; font-size:13px;">ไฟล์นี้ใช้คู่กับแคมเปญ QR ไหน? (ต้องเลือกอย่างใดอย่างหนึ่ง)</label>
          <label style="display:flex; align-items:center; gap:6px; margin-top:6px; font-size:13px; cursor:pointer;">
            <input type="radio" name="campaign_choice" value="none" required />
            ไม่ผูกกับแคมเปญไหน
          </label>
          <label style="display:flex; align-items:center; gap:6px; margin-top:6px; font-size:13px; cursor:pointer;">
            <input type="radio" name="campaign_choice" value="pick" required />
            เลือกผูกกับแคมเปญ
          </label>
          <select name="creative_id" class="table-input" id="campaignSelect" style="margin-top:6px; display:none;" disabled>
            <option value="">-- เลือกแคมเปญ --</option>
            ${campaignOptions}
          </select>

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

    <div id="ratioPreviewModal" style="display:none; position:fixed; inset:0; background:rgba(0,0,0,0.7); z-index:1000; align-items:center; justify-content:center; padding:20px;">
      <div style="background:white; border-radius:12px; padding:20px; max-width:480px; width:100%;">
        <h3 style="margin:0 0 4px; font-size:15px;">ตัวอย่างการแสดงผลบนจอจริง</h3>
        <p class="hint" style="margin:0 0 12px;">ตรวจสอบให้แน่ใจว่าไฟล์นี้แสดงผลถูกต้องตามภาพตัวอย่างนี้ ก่อนอัปโหลดจริง</p>
        <div id="ratioPreviewCanvas" style="position:relative; width:100%; aspect-ratio:16/9; background:#000; border-radius:8px; overflow:hidden; display:flex; align-items:center; justify-content:center;"></div>
        <div style="display:flex; gap:8px; margin-top:16px;">
          <button type="button" id="ratioPreviewCancel" class="btn-small" style="flex:1; background:#9ca3af; color:white;">ยกเลิก</button>
          <button type="button" id="ratioPreviewConfirm" class="btn-primary" style="flex:1; margin-top:0;">ยืนยัน อัปโหลด</button>
        </div>
      </div>
    </div>

    <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js"></script>
    <script>
      // แสดงตัวอย่างว่าไฟล์แคบกว่า 16:9 จะขึ้นจอจริงเป็นยังไง (มีแถบพื้นหลังซ้าย-ขวา) — คืนค่า true ถ้ากดยืนยัน, false ถ้ายกเลิก
      function showRatioPreview(file, isVideo) {
        return new Promise((resolve) => {
          const modal = document.getElementById('ratioPreviewModal');
          const canvas = document.getElementById('ratioPreviewCanvas');
          canvas.innerHTML = '';
          const objectUrl = URL.createObjectURL(file);
          const mediaEl = document.createElement(isVideo ? 'video' : 'img');
          mediaEl.src = objectUrl;
          mediaEl.style.height = '100%';
          mediaEl.style.width = 'auto';
          mediaEl.style.maxWidth = '100%';
          if (isVideo) {
            mediaEl.muted = true;
            mediaEl.autoplay = true;
            mediaEl.loop = true;
            mediaEl.playsInline = true;
          }
          canvas.appendChild(mediaEl);
          modal.style.display = 'flex';

          const confirmBtn = document.getElementById('ratioPreviewConfirm');
          const cancelBtn = document.getElementById('ratioPreviewCancel');
          function cleanup(result) {
            modal.style.display = 'none';
            URL.revokeObjectURL(objectUrl);
            confirmBtn.onclick = null;
            cancelBtn.onclick = null;
            resolve(result);
          }
          confirmBtn.onclick = () => cleanup(true);
          cancelBtn.onclick = () => cleanup(false);
        });
      }

      const sb = supabase.createClient(${JSON.stringify(process.env.SUPABASE_URL)}, ${JSON.stringify(process.env.SUPABASE_ANON_KEY)});
      document.querySelectorAll('.delete-content-btn').forEach((btn) => {
        btn.addEventListener('click', async () => {
          if (!confirm('ลบไฟล์นี้?')) return;
          btn.disabled = true;
          try {
            const res = await fetch('/api/sponsor/action?action=delete_content', {
              method: 'POST',
              headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
              body: new URLSearchParams({ content_id: btn.dataset.contentId }).toString(),
            });
            if (res.ok) {
              window.location.reload();
            } else {
              alert(await res.text());
              btn.disabled = false;
            }
          } catch (err) {
            alert('เกิดข้อผิดพลาด: ' + err.message);
            btn.disabled = false;
          }
        });
      });

      const form = document.querySelector('.sponsor-upload-form');
      if (form) {
        const campaignSelect = document.getElementById('campaignSelect');
        form.querySelectorAll('input[name="campaign_choice"]').forEach((radio) => {
          radio.addEventListener('change', () => {
            const isPick = radio.value === 'pick' && radio.checked;
            campaignSelect.style.display = isPick ? 'block' : 'none';
            campaignSelect.disabled = !isPick;
            campaignSelect.required = isPick;
            if (!isPick) campaignSelect.value = '';
          });
        });

        form.addEventListener('submit', async (e) => {
          e.preventDefault();
          const fileInput = form.querySelector('input[name="file"]');
          const statusEl = form.querySelector('.upload-status');
          const file = fileInput.files[0];
          if (!file) return;

          const isVideo = file.type.startsWith('video');
          const maxMb = isVideo ? ${MAX_VIDEO_MB} : ${MAX_IMAGE_MB};
          if (file.size > maxMb * 1024 * 1024) {
            statusEl.textContent = (isVideo ? 'วิดีโอ' : 'รูปภาพ') + 'ใหญ่เกิน ' + maxMb + 'MB';
            return;
          }

          // ---------- อ่านข้อมูลไฟล์ — วิดีโอโหลดครั้งเดียวอ่านทั้งความยาวและขนาดพร้อมกัน (กันปัญหาโหลดซ้ำ 2 รอบไม่เสถียร) ----------
          statusEl.textContent = 'กำลังตรวจสอบไฟล์...';
          let dims = null;

          if (isVideo) {
            console.log('[Ratio Check] เริ่มตรวจสอบวิดีโอ:', file.name);
            const videoMeta = await new Promise((resolve) => {
              const objectUrl = URL.createObjectURL(file);
              const videoEl = document.createElement('video');
              videoEl.preload = 'auto'; // เปลี่ยนจาก 'metadata' — บางเบราว์เซอร์อ่านขนาดไม่แม่นยำถ้าใช้แค่ metadata
              videoEl.muted = true;
              videoEl.playsInline = true;
              videoEl.style.position = 'fixed';
              videoEl.style.top = '-9999px';
              videoEl.style.left = '-9999px';
              videoEl.style.width = '1px';
              videoEl.style.height = '1px';
              document.body.appendChild(videoEl);

              let resolved = false;
              const cleanup = () => {
                URL.revokeObjectURL(objectUrl);
                videoEl.remove();
              };
              const finish = (result, reason) => {
                if (resolved) return;
                resolved = true;
                console.log('[Ratio Check] วิดีโออ่านค่าจบด้วยเหตุผล:', reason, '-> ผลลัพธ์:', result);
                cleanup();
                resolve(result);
              };

              const tryFinish = (reason) => {
                console.log('[Ratio Check]', reason, '— videoWidth:', videoEl.videoWidth, 'videoHeight:', videoEl.videoHeight, 'duration:', videoEl.duration);
                if (videoEl.videoWidth > 0 && videoEl.videoHeight > 0) {
                  finish({ duration: videoEl.duration, width: videoEl.videoWidth, height: videoEl.videoHeight }, reason);
                }
              };
              videoEl.onloadedmetadata = () => tryFinish('loadedmetadata');
              videoEl.onloadeddata = () => tryFinish('loadeddata');
              videoEl.oncanplay = () => tryFinish('canplay');
              videoEl.onerror = () => {
                console.error('[Ratio Check] วิดีโอโหลด Error:', videoEl.error);
                finish(null, 'error');
              };
              setTimeout(() => finish(null, 'timeout 8s'), 8000);

              videoEl.src = objectUrl;
              videoEl.load();
            });

            if (!videoMeta) {
              statusEl.textContent = 'อ่านข้อมูลวิดีโอไม่ได้ กรุณาลองไฟล์อื่น';
              return;
            }
            if (videoMeta.duration > ${MAX_VIDEO_SECONDS} + 0.5) {
              statusEl.textContent = 'วิดีโอต้องยาวไม่เกิน ${MAX_VIDEO_SECONDS} วินาที';
              return;
            }
            dims = { width: videoMeta.width, height: videoMeta.height };
          } else {
            dims = await new Promise((resolve) => {
              const objectUrl = URL.createObjectURL(file);
              const img = new Image();
              img.onload = () => {
                URL.revokeObjectURL(objectUrl);
                resolve({ width: img.naturalWidth, height: img.naturalHeight });
              };
              img.onerror = () => resolve(null);
              img.src = objectUrl;
            });
          }

          if (dims) {
            const ratio = dims.width / dims.height;
            const targetRatio = 16 / 9;
            const withinTolerance = ratio <= targetRatio * 1.02; // แคบกว่าได้ไม่จำกัด กว้างกว่าเกิน 2% ไม่ผ่าน
            if (!withinTolerance) {
              statusEl.textContent = 'ไฟล์นี้อัตราส่วน ' + dims.width + 'x' + dims.height + ' กว้างเกินไป (ต้องไม่กว้างกว่า 16:9 เช่น 1920x1080 — แคบกว่าได้)';
              return;
            }
          }

          // ยืนยันตัวอย่างก่อนอัปโหลดจริงเสมอ ไม่ว่าอัตราส่วนจะใกล้เคียง 16:9 แค่ไหนก็ตาม
          statusEl.textContent = '';
          const confirmed = await showRatioPreview(file, isVideo);
          if (!confirmed) {
            statusEl.textContent = 'ยกเลิกการอัปโหลด';
            return;
          }

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
            const creativeId = form.querySelector('select[name="creative_id"]')?.value || '';
            const saveRes = await fetch('/api/sponsor/action?action=save_content', {
              method: 'POST',
              headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
              body: new URLSearchParams({ file_path: urlData.path, file_name: file.name, file_type: fileType, creative_id: creativeId }).toString(),
            });
            if (!saveRes.ok) throw new Error(await saveRes.text());

            statusEl.textContent = 'อัปโหลดสำเร็จ กำลังโหลดหน้าใหม่...';
            setTimeout(() => window.location.reload(), 800);
          } catch (err) {
            statusEl.textContent = 'เกิดข้อผิดพลาด: ' + err.message;
          }
        });
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
        const categoryLabel = booking.businessType ? BUSINESS_TYPE_LABEL[booking.businessType] || 'อื่นๆ' : null;
        return `<div class="slot-box slot-full">Slot ${slotNum}<br/><span class="hint">ไม่ว่าง</span>${
          categoryLabel ? `<br/><span class="hint" style="color:#e76f51;">${categoryLabel}</span>` : ''
        }</div>`;
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
      <p style="font-size:13px; color:#e76f51; font-weight:600; margin-top:8px;">⚠️ หากยืนยันการจองแล้วจะไม่สามารถเปลี่ยนเนื้อหาได้ โปรดตรวจสอบให้แน่ใจก่อนยืนยัน</p>
      <form method="POST" action="/api/sponsor/action?action=create_bookings" id="bookForm">
        <input type="hidden" name="office_id" value="${activeOffice.id}" />
        <input type="hidden" name="week_start" value="${activeWeekIso}" />
        <input type="hidden" name="slot_numbers" id="slotNumbersField" />
        <div class="slot-grid">${slotCheckboxes}</div>
        <p id="totalPrice" class="hint" style="margin-top:12px; font-size:16px; font-weight:700; color:#1b1f27;">ยอดรวม: 0 บาท</p>
        <button type="button" class="btn-primary" style="margin-top:8px;" onclick="openBookingConfirm()">ยืนยันการจอง (ต้องชำระเงินภายใน 15 นาที)</button>
      </form>
    </div>

    <div class="modal-overlay" id="bookingConfirmModal">
      <div class="modal-box" style="max-width:480px;">
        <div class="modal-header">
          <h2>ยืนยันรายการจอง</h2>
          <button type="button" class="modal-close" onclick="closeBookingConfirm()">&times;</button>
        </div>
        <div class="modal-body">
          <p style="font-size:13px; color:#e76f51; font-weight:600; margin:0 0 12px;">⚠️ หลังยืนยันแล้วจะไม่สามารถเปลี่ยนเนื้อหาได้ กรุณาตรวจสอบให้ถูกต้อง</p>
          <table style="width:100%; font-size:13px; border-collapse:collapse;">
            <tr><th style="text-align:left; padding:4px 0; border-bottom:1px solid #e5e7eb;">Slot</th><th style="text-align:left; padding:4px 0; border-bottom:1px solid #e5e7eb;">ไฟล์ที่จะแสดง</th></tr>
            <tbody id="bookingConfirmList"></tbody>
          </table>
          <p id="bookingConfirmTotal" style="font-size:15px; font-weight:700; margin-top:12px;"></p>
        </div>
        <div class="modal-footer" style="display:flex; gap:8px;">
          <button type="button" class="btn-small" style="flex:1; background:#9ca3af;" onclick="closeBookingConfirm()">ยกเลิก แก้ไขก่อน</button>
          <button type="button" class="btn-primary" style="flex:1; margin-top:0;" onclick="confirmBookingSubmit()">ยืนยันการจอง</button>
        </div>
      </div>
    </div>

    <style>
      .modal-overlay { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.5); z-index: 1000; align-items: center; justify-content: center; padding: 24px; }
      .modal-overlay.open { display: flex; }
      .modal-box { background: white; border-radius: 12px; max-width: 640px; width: 100%; max-height: 80vh; display: flex; flex-direction: column; }
      .modal-header { padding: 16px 20px; border-bottom: 1px solid #e5e7eb; display: flex; justify-content: space-between; align-items: center; }
      .modal-header h2 { font-size: 16px; margin: 0; }
      .modal-close { background: none; border: none; font-size: 20px; cursor: pointer; color: #6b7280; width: auto; margin: 0; padding: 0; }
      .modal-body { padding: 20px; overflow-y: auto; }
      .modal-footer { padding: 12px 20px; border-top: 1px solid #e5e7eb; }
    </style>
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

      // ---------- ขั้นที่ 1: ตรวจสอบข้อมูลให้ครบ แล้วเปิด Popup สรุปให้ดูอีกรอบก่อนส่งจริง ----------
      function openBookingConfirm() {
        const checked = document.querySelectorAll('.slot-checkbox:checked');
        if (checked.length === 0) {
          alert('กรุณาเลือกอย่างน้อย 1 slot');
          return;
        }

        let missing = false;
        const rows = [];
        checked.forEach((cb) => {
          const select = document.querySelector('.slot-content-select[data-slot="' + cb.dataset.slot + '"]');
          if (select) {
            if (!select.value && select.options.length > 1) select.selectedIndex = 1;
            if (!select.value) missing = true;
            rows.push({ slot: cb.dataset.slot, fileName: select.options[select.selectedIndex]?.text || '-' });
          }
        });
        if (missing) {
          alert('กรุณาเลือกไฟล์ให้ครบทุก slot ที่ติ๊กไว้ (คุณอาจยังไม่มีไฟล์ในคลัง)');
          return;
        }

        document.getElementById('slotNumbersField').value = Array.from(checked).map((cb) => cb.dataset.slot).join(',');

        const listBody = document.getElementById('bookingConfirmList');
        listBody.innerHTML = rows
          .map((r) => '<tr><td style="padding:6px 0; border-bottom:1px solid #f0f0f0;">Slot ' + r.slot + '</td><td style="padding:6px 0; border-bottom:1px solid #f0f0f0;">' + r.fileName + '</td></tr>')
          .join('');
        document.getElementById('bookingConfirmTotal').textContent =
          'รวม ' + rows.length + ' slot — ยอดรวม ' + (rows.length * pricePerSlot).toLocaleString() + ' บาท';

        document.getElementById('bookingConfirmModal').classList.add('open');
      }

      function closeBookingConfirm() {
        document.getElementById('bookingConfirmModal').classList.remove('open');
      }

      // ---------- ขั้นที่ 2: กดยืนยันใน Popup แล้วค่อยส่งฟอร์มจริง ----------
      function confirmBookingSubmit() {
        document.getElementById('bookForm').submit();
      }

      document.getElementById('bookingConfirmModal').addEventListener('click', (e) => {
        if (e.target.id === 'bookingConfirmModal') closeBookingConfirm();
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
    return await renderPaymentStep(sponsor, group);
  }

  const bookings = await getSponsorBookings(sponsor.id);
  const approvedContent = await getSponsorContent(sponsor.id);
  const contentOptions = (currentId) =>
    approvedContent.map((c) => `<option value="${c.id}" ${c.id === currentId ? 'selected' : ''}>${c.file_name}</option>`).join('');

  const rows = await Promise.all(
    bookings.map(async (b) => {
      const isExpired = b.payment_status === 'unpaid' && b.reserved_until && new Date(b.reserved_until) < new Date();
      const statusLabel =
        b.payment_status === 'refunded' && b.approval_status === 'rejected'
          ? 'ไม่ผ่านตรวจสอบ (ยกเลิก)'
          : isExpired
          ? 'หมดเวลาชำระเงิน'
          : { unpaid: 'รอชำระเงิน', paid: 'ชำระแล้ว', refunded: 'ได้เครดิตคืนแล้ว' }[b.payment_status] || b.payment_status;
      const statusColor = isExpired ? '#e76f51' : { unpaid: '#e76f51', paid: '#06c755', refunded: '#9ca3af' }[b.payment_status] || '#9ca3af';
      const approvalLabel = { pending: 'รอตรวจสอบไฟล์', approved: 'ไฟล์ผ่านแล้ว', rejected: 'ไฟล์ไม่ผ่าน' }[b.approval_status] || b.approval_status;
      const approvalColor = { pending: '#d4a017', approved: '#06c755', rejected: '#e76f51' }[b.approval_status] || '#9ca3af';
      const weekDate = new Date(b.week_start);
      const isLocked = true; // ล็อกเสมอตั้งแต่ยืนยันการจองแล้ว เปลี่ยนได้แค่แจ้งทีมงานผ่านแชท (ขึ้นอยู่กับดุลยพินิจทีมงาน)

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

      const lockedNote =
        b.approval_status === 'approved' ? 'อนุมัติแล้ว' : b.approval_status === 'rejected' ? 'ไม่ผ่านการตรวจสอบ' : 'รอตรวจสอบ';
      const contentCell = `${b.sponsor_content?.file_name || '-'}<br/><a href="/api/sponsor?page=chat" class="hint">${lockedNote} — แจ้งทีมงานผ่านแชทถ้าต้องการเปลี่ยน (ขึ้นอยู่กับดุลยพินิจของทีมงาน)</a>`;

      const rejectionNote =
        b.approval_status === 'rejected' && b.rejection_reason ? `<div class="hint" style="color:#e76f51; margin-top:4px;">เหตุผล: ${b.rejection_reason}</div>` : '';

      const airingStatus = getAiringStatus(b);
      const airingHtml = airingStatus
        ? `<span style="color:${AIRING_STATUS_LABEL[airingStatus].color}; font-weight:600;">${AIRING_STATUS_LABEL[airingStatus].text}</span>`
        : '<span class="muted">-</span>';

      return `
        <tr>
          <td>${b.office_accounts?.office_name || '-'} — Slot ${b.slot_number}</td>
          <td>${weekDate.toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: 'numeric' })}</td>
          ${
            isLocked
              ? `<td colspan="2">${contentCell}</td>`
              : `<td>
                   <form method="POST" action="/api/sponsor/action?action=update_booking_content" class="inline-form">
                     <input type="hidden" name="booking_id" value="${b.id}" />
                     <select name="sponsor_content_id" class="table-input">${contentOptions(b.sponsor_content_id)}</select>
                 </td>
                 <td style="text-align:center;"><button class="btn-small">บันทึก</button></form></td>`
          }
          <td style="text-align:right;">${Number(b.price).toLocaleString()} บาท</td>
          <td style="text-align:center;"><span class="tier-tag" style="background:${statusColor};">${statusLabel}</span></td>
          <td style="text-align:center;"><span class="tier-tag" style="background:${approvalColor};">${approvalLabel}</span>${rejectionNote}</td>
          <td style="text-align:center;">${airingHtml}</td>
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
        <tr><th>Office / Slot</th><th>สัปดาห์</th><th>ไฟล์ที่แสดง</th><th></th><th style="text-align:right;">ราคา</th><th style="text-align:center;">สถานะจ่ายเงิน</th><th style="text-align:center;">สถานะไฟล์</th><th style="text-align:center;">สถานะขึ้นจอ</th><th style="text-align:center;">เล่นแล้ว</th><th></th></tr>
        ${rows.join('') || '<tr><td colspan="10" class="muted">ยังไม่มีการจอง</td></tr>'}
      </table>
    </div>`;
}

async function renderPaymentStep(sponsor, group) {
  const totalPrice = group.reduce((sum, b) => sum + Number(b.price), 0);
  const officeName = group[0].office_accounts?.office_name || '-';
  const slotList = group.map((b) => 'Slot ' + b.slot_number).join(', ');
  const groupId = group[0].booking_group_id;
  const reservedUntil = group[0].reserved_until;

  const [creditBalance, cardInfo, promptPayReady] = await Promise.all([
    getSponsorCreditBalance(sponsor.id),
    sponsor.omise_customer_id ? listCustomerCards(sponsor.omise_customer_id).catch(() => ({ defaultCardId: null, cards: [] })) : { defaultCardId: null, cards: [] },
    Promise.resolve(isPromptPayConfigured()),
  ]);

  const savedCardsHtml = cardInfo.cards.length
    ? cardInfo.cards
        .map(
          (c) => `
        <label style="display:block; padding:8px; border:1px solid #e5e7eb; border-radius:8px; margin-bottom:6px; cursor:pointer;">
          <input type="radio" name="card_choice" value="${c.id}" ${c.id === cardInfo.defaultCardId ? 'checked' : ''} />
          ${c.brand} •••• ${c.last_digits} ${c.id === cardInfo.defaultCardId ? '<span class="hint">(ค่าเริ่มต้น)</span>' : ''}
        </label>`
        )
        .join('')
    : '<p class="hint">ยังไม่มีบัตรที่บันทึกไว้</p>';

  const creditNote = `
    <div class="section" style="background:#fff8ec; border:1px solid #f0d999;">
      <p style="font-size:13px; margin:0;"><strong>เงื่อนไขสำคัญ:</strong> หากเนื้อหาที่เลือกไม่ผ่านการอนุมัติจาก Admin ระบบจะยกเลิก Slot นั้นและ<strong>ไม่คืนเงินสด</strong> แต่จะโอนเป็น<strong>เครดิต</strong>เข้าบัญชีของคุณแทน ใช้จองครั้งต่อไปได้ (เครดิตมีอายุ 1 ปีนับจากวันที่ได้รับ)</p>
    </div>`;

  return `
    ${creditNote}
    <div class="section">
      <h2>ชำระเงิน</h2>
      <p>${officeName} — ${slotList} (${group.length} slot)</p>
      <p style="font-size:24px; font-weight:700; margin:8px 0 8px;">${totalPrice.toLocaleString()} บาท</p>
      ${reservedUntil ? `<p class="hint" id="countdown" style="color:#e76f51;"></p>` : ''}

      ${
        creditBalance > 0
          ? `
      <div style="background:#f7f8fa; border-radius:8px; padding:12px; margin-bottom:16px;">
        <p style="font-size:13px; margin:0 0 6px;">เครดิตที่มี: <strong>${creditBalance.toLocaleString()} บาท</strong></p>
        <label class="hint">ใช้เครดิตกี่บาท (ไม่เกิน ${Math.min(creditBalance, totalPrice).toLocaleString()} บาท)</label>
        <input type="number" id="creditToApply" min="0" max="${Math.min(creditBalance, totalPrice)}" value="0" step="0.01" style="width:140px;" oninput="updateRemaining()" />
      </div>`
          : ''
      }

      <p id="remainingAmount" style="font-size:14px; font-weight:600;">ยอดที่ต้องชำระ: ${totalPrice.toLocaleString()} บาท</p>

      <div id="paymentMethods" style="${creditBalance >= totalPrice ? 'display:none;' : ''}">
        <div style="display:flex; gap:8px; margin-bottom:16px; flex-wrap:wrap;">
          <button type="button" class="btn-small" onclick="showTab('card')">บัตรเครดิต/เดบิต</button>
          <button type="button" class="btn-small" onclick="showTab('bank')">ธนาคารออนไลน์</button>
          <button type="button" class="btn-small" onclick="showTab('transfer')">โอนเงิน / PromptPay</button>
        </div>

        <div id="tab-card">
          ${savedCardsHtml}
          <label style="display:block; padding:8px; border:1px solid #e5e7eb; border-radius:8px; margin-bottom:6px; cursor:pointer;">
            <input type="radio" name="card_choice" value="__new__" ${cardInfo.cards.length ? '' : 'checked'} />
            เพิ่มบัตรใหม่ (กรอกผ่านหน้าต่างที่ปลอดภัยของ Omise)
          </label>
          <label style="display:flex; align-items:center; gap:6px; margin-top:8px; font-size:13px;">
            <input type="checkbox" id="save-card" checked /> บันทึกบัตรนี้ไว้ใช้ครั้งหน้า
          </label>
          <button type="button" class="btn-primary" style="margin-top:12px;" onclick="payByCard()">ชำระด้วยบัตร</button>
          <p id="card-status" class="hint" style="margin-top:8px;"></p>
        </div>

        <div id="tab-bank" style="display:none;">
          <p class="hint">เลือกธนาคารเพื่อไปหน้า Login ของธนาคารและยืนยันการชำระเงิน (ไม่ต้องผูกบัญชีถาวร)</p>
          <div style="display:flex; flex-direction:column; gap:8px; margin-top:8px; max-width:320px;">
            ${SUPPORTED_BANKS.map((b) => `<button type="button" class="btn-small" style="text-align:left;" onclick="payByBank('${b.code}')">${b.label}</button>`).join('')}
          </div>
          <p id="bank-status" class="hint" style="margin-top:8px;"></p>
        </div>

        <div id="tab-transfer" style="display:none;">
          ${
            promptPayReady
              ? `<p class="hint">สแกน QR นี้ด้วยแอปธนาคารเพื่อชำระผ่าน PromptPay</p>
                 <img id="promptpay-qr" src="" style="width:200px; height:200px; border:1px solid #e5e7eb; border-radius:8px;" />`
              : `<p class="hint" style="color:#e76f51;">ช่องทาง PromptPay อยู่ระหว่างเตรียมการ กรุณาโอนเข้าบัญชีธนาคารที่ทีมงานแจ้งไว้แทน</p>`
          }
          <p class="hint" style="margin-top:12px;">โอนเงินแล้วอัปโหลดสลิปด้านล่าง ระบบจะตรวจสอบยอดเงินให้อัตโนมัติ</p>
          <form class="slip-upload-form">
            <input type="file" name="slip" accept="image/jpeg,image/png,image/webp" required />
            <button type="submit" class="btn-primary" style="margin-top:10px;">อัปโหลดสลิป</button>
            <p class="slip-status hint" style="margin-top:8px;"></p>
          </form>
        </div>
      </div>

      <div id="creditOnlyPay" style="display:${creditBalance >= totalPrice ? 'block' : 'none'};">
        <button type="button" class="btn-primary" onclick="payByCreditOnly()">ชำระด้วยเครดิตทั้งหมด</button>
        <p id="credit-only-status" class="hint" style="margin-top:8px;"></p>
      </div>
    </div>

    <script src="https://cdn.omise.co/omise.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js"></script>
    <script>
      OmiseCard.configure({ publicKey: ${JSON.stringify(process.env.OMISE_PUBLIC_KEY || '')} });
      const sb = supabase.createClient(${JSON.stringify(process.env.SUPABASE_URL)}, ${JSON.stringify(process.env.SUPABASE_ANON_KEY)});
      const groupId = ${JSON.stringify(groupId)};
      const reservedUntil = ${JSON.stringify(reservedUntil)};
      const totalPrice = ${totalPrice};
      const creditBalance = ${creditBalance};
      const promptPayReady = ${promptPayReady};

      function getCreditToApply() {
        const el = document.getElementById('creditToApply');
        if (!el) return 0;
        const v = parseFloat(el.value) || 0;
        return Math.max(0, Math.min(v, creditBalance, totalPrice));
      }

      function updateRemaining() {
        const credit = getCreditToApply();
        const remaining = Math.round((totalPrice - credit) * 100) / 100;
        document.getElementById('remainingAmount').textContent = 'ยอดที่ต้องชำระ: ' + remaining.toLocaleString() + ' บาท';
        document.getElementById('paymentMethods').style.display = remaining <= 0 ? 'none' : 'block';
        document.getElementById('creditOnlyPay').style.display = remaining <= 0 ? 'block' : 'none';
        if (promptPayReady && remaining > 0) {
          document.getElementById('promptpay-qr').src = '/api/sponsor/action?action=promptpay_qr&group_id=' + groupId + '&amount=' + remaining;
        }
      }

      document.querySelectorAll('input[name="card_choice"]').forEach((r) => {
        r.addEventListener('change', () => {
          document.getElementById('card-form').style.display = r.value === '__new__' && r.checked ? 'block' : 'none';
        });
      });

      function showTab(name) {
        document.getElementById('tab-card').style.display = name === 'card' ? 'block' : 'none';
        document.getElementById('tab-bank').style.display = name === 'bank' ? 'block' : 'none';
        document.getElementById('tab-transfer').style.display = name === 'transfer' ? 'block' : 'none';
        if (name === 'transfer' && promptPayReady) updateRemaining();
      }

      async function payByCreditOnly() {
        const statusEl = document.getElementById('credit-only-status');
        statusEl.textContent = 'กำลังทำรายการ...';
        const res = await fetch('/api/sponsor/action?action=pay_with_credit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ group_id: groupId, credit_to_apply: String(getCreditToApply()) }).toString(),
        });
        const data = await res.json();
        if (data.paid) { statusEl.textContent = 'ชำระด้วยเครดิตสำเร็จ กำลังพาไปหน้ารายการจอง...'; setTimeout(() => window.location.href = '/api/sponsor?page=bookings', 1000); }
        else { statusEl.textContent = 'เกิดข้อผิดพลาด: ' + (data.error || ''); }
      }

      async function payByBank(bankCode) {
        const statusEl = document.getElementById('bank-status');
        statusEl.textContent = 'กำลังพาไปหน้าธนาคาร...';
        const res = await fetch('/api/sponsor/action?action=pay_by_bank', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ group_id: groupId, bank_code: bankCode, credit_to_apply: String(getCreditToApply()) }).toString(),
        });
        const data = await res.json();
        if (data.redirect) { window.location.href = data.redirect; return; }
        if (data.paid) { statusEl.textContent = 'ชำระเงินสำเร็จ กำลังพาไปหน้ารายการจอง...'; setTimeout(() => window.location.href = '/api/sponsor?page=bookings', 1000); return; }
        statusEl.textContent = 'เกิดข้อผิดพลาด: ' + (data.message || data.error || '');
      }

      // ใช้หน้าต่างกรอกบัตรสำเร็จรูปของ Omise เอง (OmiseCard.open) — หน้าตาเหมือนระบบชำระเงินมาตรฐานทั่วไป
      // เว้นวรรคเลขบัตรอัตโนมัติ 4-4-4-4 มีไอคอนประเภทบัตร ตรวจสอบความถูกต้องให้ในตัว ข้อมูลบัตรไม่ผ่านเซิร์ฟเวอร์เราเลย
      function payByCard() {
        const statusEl = document.getElementById('card-status');
        const chosen = document.querySelector('input[name="card_choice"]:checked');
        const creditToApply = getCreditToApply();

        if (chosen && chosen.value !== '__new__') {
          statusEl.textContent = 'กำลังทำรายการชำระเงิน...';
          fetch('/api/sponsor/action?action=pay_by_card', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ group_id: groupId, card_id: chosen.value, credit_to_apply: String(creditToApply) }).toString(),
          }).then((r) => r.json()).then((data) => {
            if (data.redirect) { window.location.href = data.redirect; return; }
            if (data.paid) { statusEl.textContent = 'ชำระเงินสำเร็จ กำลังพาไปหน้ารายการจอง...'; setTimeout(() => window.location.href = '/api/sponsor?page=bookings', 1000); return; }
            statusEl.textContent = 'การชำระเงินไม่สำเร็จ: ' + (data.message || data.error || '');
          });
          return;
        }

        OmiseCard.open({
          amount: Math.round((totalPrice - creditToApply) * 100),
          currency: 'THB',
          defaultPaymentMethod: 'credit_card',
          onCreateTokenSuccess: async (nonce) => {
            // nonce เป็น token (ขึ้นต้นด้วย tokn_) หรือ source (ขึ้นต้นด้วย src_) แล้วแต่วิธีที่ลูกค้าเลือกในป๊อปอัป
            statusEl.textContent = 'กำลังทำรายการชำระเงิน...';
            const saveCard = document.getElementById('save-card')?.checked ? '1' : '0';
            const res = await fetch('/api/sponsor/action?action=pay_by_card', {
              method: 'POST',
              headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
              body: new URLSearchParams({ group_id: groupId, omise_token: nonce, save_card: saveCard, credit_to_apply: String(creditToApply) }).toString(),
            });
            const data = await res.json();
            if (!res.ok) { statusEl.textContent = 'เกิดข้อผิดพลาด: ' + (data.error || ''); return; }
            if (data.redirect) { window.location.href = data.redirect; return; }
            if (data.paid) { statusEl.textContent = 'ชำระเงินสำเร็จ กำลังพาไปหน้ารายการจอง...'; setTimeout(() => window.location.href = '/api/sponsor?page=bookings', 1000); return; }
            statusEl.textContent = 'การชำระเงินไม่สำเร็จ กรุณาลองใหม่หรือใช้บัตรอื่น';
          },
          onFormClosed: () => {},
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
          const creditToApply = getCreditToApply();

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
              body: new URLSearchParams({ group_id: groupId, file_path: urlData.path, credit_to_apply: String(creditToApply) }).toString(),
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

      if (promptPayReady) updateRemaining();
    </script>`;
}

// ---------- Profile tab ----------
async function renderProfileTab(sponsor) {
  const creditBalance = await getSponsorCreditBalance(sponsor.id);
  const cardInfo = sponsor.omise_customer_id
    ? await listCustomerCards(sponsor.omise_customer_id).catch(() => ({ defaultCardId: null, cards: [] }))
    : { defaultCardId: null, cards: [] };

  const cardRows = cardInfo.cards
    .map(
      (c) => `
      <div style="display:flex; justify-content:space-between; align-items:center; padding:10px 0; border-bottom:1px solid #f0f0f0;">
        <span>${c.brand} •••• ${c.last_digits} ${c.id === cardInfo.defaultCardId ? '<span class="tier-tag" style="background:#06c755;">ค่าเริ่มต้น</span>' : ''}</span>
        <div style="display:flex; gap:6px;">
          ${
            c.id !== cardInfo.defaultCardId
              ? `<form method="POST" action="/api/sponsor/action?action=set_default_card" style="display:inline;">
                   <input type="hidden" name="card_id" value="${c.id}" />
                   <button class="btn-small">ตั้งเป็นค่าเริ่มต้น</button>
                 </form>`
              : ''
          }
          <form method="POST" action="/api/sponsor/action?action=remove_card" onsubmit="return confirm('ลบบัตรนี้?')" style="display:inline;">
            <input type="hidden" name="card_id" value="${c.id}" />
            <button class="btn-small btn-danger">ลบ</button>
          </form>
        </div>
      </div>`
    )
    .join('');

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
        <label>ประเภทธุรกิจ *</label>
        <select name="business_type" required>
          <option value="">-- เลือกประเภทธุรกิจ --</option>
          ${Object.entries(BUSINESS_TYPE_LABEL)
            .map(([key, label]) => `<option value="${key}" ${sponsor.business_type === key ? 'selected' : ''}>${label}</option>`)
            .join('')}
        </select>
        <button type="submit" class="btn-primary" style="margin-top:12px;">บันทึก</button>
      </form>
    </div>
    <div class="section">
      <h2>เครดิตของฉัน</h2>
      <p style="font-size:22px; font-weight:700; color:#06c755;">${creditBalance.toLocaleString()} บาท</p>
      <p class="hint">ได้จากการยกเลิก Slot ที่เนื้อหาไม่ผ่านการอนุมัติ ใช้จองครั้งต่อไปได้ อายุ 1 ปีนับจากวันที่ได้รับ</p>
    </div>
    <div class="section">
      <h2>บัตรที่บันทึกไว้</h2>
      ${cardRows || '<p class="muted">ยังไม่มีบัตรที่บันทึกไว้ — เพิ่มได้ตอนชำระเงินครั้งถัดไป</p>'}
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
// ---------- แชทกับทีมงาน ----------
function renderChatTab(sponsor) {
  return `
    <div class="section">
      <h2>แชทกับทีมงาน</h2>
      <p class="hint">แจ้งขอเปลี่ยนเนื้อหาที่อนุมัติแล้ว หรือสอบถามอื่นๆ ได้ที่นี่</p>
      <div id="chatBox" style="height:360px; overflow-y:auto; border:1px solid #f0f0f0; border-radius:8px; padding:12px; margin-top:8px;"></div>
      <form id="chatSendForm" style="display:flex; gap:8px; margin-top:12px;">
        <input type="text" id="chatInput" placeholder="พิมพ์ข้อความ..." style="flex:1;" />
        <button type="submit" class="btn-small">ส่ง</button>
      </form>
    </div>
    <script>
      const chatBox = document.getElementById('chatBox');

      function renderMessages(messages) {
        chatBox.innerHTML = messages.map((m) => {
          const mine = m.sender_type === 'sponsor';
          return '<div style="margin-bottom:10px; text-align:' + (mine ? 'right' : 'left') + ';">' +
            '<div style="display:inline-block; max-width:75%; padding:8px 12px; border-radius:10px; background:' + (mine ? '#1b1f27' : '#f0f0f0') + '; color:' + (mine ? 'white' : '#1b1f27') + '; font-size:13px; text-align:left;">' +
            '<div class="hint" style="color:#9ca3af; margin-bottom:2px;">' + (m.sender_label || (mine ? 'คุณ' : 'ทีมงาน')) + '</div>' +
            m.message.replace(/</g, '&lt;') +
            '</div></div>';
        }).join('');
        chatBox.scrollTop = chatBox.scrollHeight;
      }

      async function poll() {
        const res = await fetch('/api/sponsor/action?action=chat_poll');
        const data = await res.json();
        renderMessages(data.messages || []);
      }

      document.getElementById('chatSendForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const input = document.getElementById('chatInput');
        const message = input.value.trim();
        if (!message) return;
        input.value = '';
        await fetch('/api/sponsor/action?action=chat_send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ message }).toString(),
        });
        poll();
      });

      poll();
      setInterval(poll, 2500);
    </script>`;
}

// ---------- แคมเปญ QR (Sponsor สร้างเอง — พาไปปลายทาง หรือโชว์โค้ดโปรโมชั่น) ----------
async function renderQrCampaignsTab(sponsor) {
  const { data: campaigns, error: campaignsError } = await supabase
    .from('creatives')
    .select('*')
    .eq('sponsor_id', sponsor.id)
    .order('created_at', { ascending: false });

  if (campaignsError) {
    console.error('🔍QR_CAMPAIGN_DEBUG🔍 ดึงรายการแคมเปญไม่สำเร็จ:', campaignsError.message);
  }

  const rows = (campaigns || [])
    .map((c) => {
      const scanUrl = `${process.env.APP_BASE_URL}/api/qr/${c.creative_id}`;
      const qrImageUrl = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(scanUrl)}`;
      return `
        <div class="qr-card">
          <img src="${qrImageUrl}" alt="QR" style="width:120px; height:120px; border:1px solid #e5e7eb; border-radius:8px;" />
          <div style="flex:1;">
            <p style="font-weight:600; margin:0 0 4px;">${c.campaign_name || c.creative_id}</p>
            <p class="hint" style="margin:0 0 4px;">${c.campaign_type === 'link' ? `🔗 พาไปปลายทาง: ${c.destination_url}` : `🎁 โชว์โค้ด: ${c.promo_code}`}</p>
            <p class="hint" style="margin:0;">Code: ${c.creative_id}</p>
            <div style="display:flex; gap:8px; margin-top:8px;">
              <a href="${qrImageUrl}" download="${c.creative_id}.png" class="btn-small" style="text-decoration:none;">⬇ ดาวน์โหลด QR</a>
              <form method="POST" action="/api/sponsor/action?action=qr_campaign_toggle" style="display:inline;">
                <input type="hidden" name="creative_id" value="${c.creative_id}" />
                <button class="btn-small ${c.active ? 'btn-danger' : ''}">${c.active ? 'ปิดใช้งาน' : 'เปิดใช้งาน'}</button>
              </form>
            </div>
          </div>
        </div>`;
    })
    .join('');

  return `
    <div class="section">
      <h2>สร้างแคมเปญ QR ใหม่</h2>
      <p class="hint">สร้าง QR ก่อน แล้วนำไปแปะในภาพ/วิดีโอของคุณเอง ก่อนอัปโหลดเข้าคลัง Content</p>
      <form method="POST" action="/api/sponsor/action?action=qr_campaign_create" class="stack-form" id="qrForm">
        <label>ชื่อแคมเปญ (ไม่บังคับ ไว้จำง่ายๆ)</label>
        <input type="text" name="campaign_name" placeholder="เช่น โปรโมชั่นเดือนกันยายน" />
        <label>ประเภท</label>
        <select name="campaign_type" id="campaignTypeSelect" required>
          <option value="link">🔗 พาไปปลายทาง (มีเว็บไซต์/ลิงก์ของตัวเอง)</option>
          <option value="promo_code">🎁 โชว์โค้ดโปรโมชั่น (ให้ลูกค้าแคปไปใช้ที่ร้าน)</option>
        </select>
        <div id="linkFields">
          <label>ลิงก์ปลายทาง</label>
          <input type="url" name="destination_url" placeholder="https://..." />
        </div>
        <div id="promoFields" style="display:none;">
          <label>โค้ดโปรโมชั่น</label>
          <input type="text" name="promo_code" placeholder="เช่น SAVE100" />
          <label>คำแนะนำการใช้ (ไม่บังคับ)</label>
          <input type="text" name="promo_instructions" placeholder="เช่น แสดงโค้ดนี้ที่แคชเชียร์เพื่อรับส่วนลด" />
        </div>
        <button type="submit" class="btn-primary" style="margin-top:12px;">สร้าง QR</button>
      </form>
      <script>
        document.getElementById('campaignTypeSelect').addEventListener('change', function () {
          const isPromo = this.value === 'promo_code';
          document.getElementById('linkFields').style.display = isPromo ? 'none' : 'block';
          document.getElementById('promoFields').style.display = isPromo ? 'block' : 'none';
        });
      </script>
    </div>

    <div class="section">
      <h2>แคมเปญ QR ของฉัน (${(campaigns || []).length})</h2>
      ${rows || '<p class="muted">ยังไม่มีแคมเปญ — สร้างจากฟอร์มด้านบน</p>'}
    </div>
    <style>
      .qr-card { display: flex; gap: 12px; padding: 12px 0; border-bottom: 1px solid #f0f0f0; }
    </style>`;
}

function renderLayout(activePage, sponsor, content) {
  const tabs = [
    { key: 'content', label: 'Content Library' },
    { key: 'book', label: 'จองสล็อตใหม่' },
    { key: 'bookings', label: 'สล็อตของฉัน' },
    { key: 'chat', label: 'แชทกับทีมงาน' },
    { key: 'qr', label: 'แคมเปญ QR' },
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
