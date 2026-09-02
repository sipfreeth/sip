// lib/officeArea.js
//
// โค้ดกลางของฟีเจอร์ Office Area ใช้ร่วมกันทั้ง 2 ทาง:
//   - api/office/index.js (Office account เข้าดูของตัวเอง)
//   - api/admin/[page].js แท็บ Office Area (Admin/Staff เข้าดู/แก้ของ office ไหนก็ได้)
//
// อัปโหลดไฟล์ตรงไป Supabase Storage จากเบราว์เซอร์เลย (ไม่ผ่าน Vercel function)
// เพราะไฟล์ใหญ่ได้ถึง 125MB ซึ่งเกินขีดจำกัด request ของ Vercel Serverless Function มาก

import { supabase } from './supabaseClient.js';
import { getImageDimensions, getMp4Dimensions, isRatio16x9 } from './mediaDimensions.js';

const BUCKET = 'office-content';
const MAX_FILE_MB = 125;

export async function listOfficeAccounts() {
  const { data } = await supabase.from('office_accounts').select('id, office_name, username, email, price_per_week, sponsor_slot_count').order('office_name');
  return data || [];
}

export async function getOfficeAccount(id) {
  const { data } = await supabase.from('office_accounts').select('id, office_name, username').eq('id', id).single();
  return data;
}

// คืน array 6 ช่อง (slot 1-6) เสมอ ไม่ว่าจะมีข้อมูลจริงกี่อันก็ตาม (ช่องว่างคือ null)
// สร้าง signed URL ชั่วคราวให้แต่ละไฟล์สด ๆ ทุกครั้งที่เปิดหน้า (bucket เป็น private เพื่อความปลอดภัย)
export async function getSlots(officeAccountId) {
  const { data } = await supabase.from('office_content').select('*').eq('office_account_id', officeAccountId);
  const bySlot = {};
  for (const row of data || []) bySlot[row.slot_number] = row;

  const slots = [1, 2, 3, 4, 5, 6].map((n) => bySlot[n] || { slot_number: n });

  await Promise.all(
    slots.map(async (slot) => {
      if (!slot.file_path) return;
      const { data: signed } = await supabase.storage.from(BUCKET).createSignedUrl(slot.file_path, 3600); // ลิงก์ดูไฟล์ อายุ 1 ชั่วโมง
      slot.display_url = signed?.signedUrl || null;
    })
  );

  return slots;
}

// สร้าง path ไม่ซ้ำ + ขอ signed upload URL จาก Supabase Storage (server-side, ใช้ service role key)
export async function createUploadTarget(officeAccountId, slotNumber, fileName) {
  const safeName = fileName.replace(/[^a-zA-Z0-9.\-_]/g, '_');
  const path = `${officeAccountId}/slot${slotNumber}/${Date.now()}-${safeName}`;

  const { data, error } = await supabase.storage.from(BUCKET).createSignedUploadUrl(path);
  if (error) throw error;

  return { path, token: data.token };
}

// บันทึกข้อมูล content ลง slot หลังอัปโหลดไฟล์เสร็จแล้ว (upsert เพราะแต่ละ office มีได้แค่ 1 แถวต่อ slot)
// ไม่เก็บ URL ถาวรเพราะ bucket เป็น private — ตอนแสดงผลจะสร้าง signed URL ชั่วคราวใหม่ทุกครั้ง (ดูใน getSlots)
export async function saveSlotContent({ officeAccountId, slotNumber, fileName, filePath, fileType, displayAt, editorLabel }) {
  // ตรวจสอบอัตราส่วนภาพ — แคบกว่า 16:9 ได้ (เช่น 4:3, 1:1) แต่กว้างกว่าไม่ได้ (ตามสเปคจอที่ติดตั้งจริง)
  // ถ้าไม่ผ่าน ลบไฟล์ที่เพิ่งอัปโหลดทิ้งทันที กันมีไฟล์ค้างอยู่ใน Storage โดยไม่มีใครใช้
  const { data: fileBlob } = await supabase.storage.from(BUCKET).download(filePath);
  if (fileBlob) {
    const buf = Buffer.from(await fileBlob.arrayBuffer());
    const dims = fileType === 'video' ? getMp4Dimensions(buf) : getImageDimensions(buf);
    if (dims && !isRatio16x9(dims.width, dims.height)) {
      await supabase.storage.from(BUCKET).remove([filePath]);
      throw new Error(
        `ไฟล์นี้อัตราส่วน ${dims.width}x${dims.height} กว้างเกินไป (ต้องไม่กว้างกว่า 16:9 เช่น 1920x1080 — แคบกว่าได้) กรุณาแก้ไขไฟล์แล้วอัปโหลดใหม่`
      );
    }
  }

  const { error } = await supabase.from('office_content').upsert(
    {
      office_account_id: officeAccountId,
      slot_number: slotNumber,
      file_name: fileName,
      file_path: filePath,
      file_type: fileType,
      display_at: displayAt || null,
      updated_by: editorLabel,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'office_account_id,slot_number' }
  );

  if (error) throw error;
}

// ---------- Render หน้า Office Area (ใช้ร่วมกัน) ----------
// คืนแค่เนื้อหาด้านใน ไม่มี <html> ครอบ เพื่อให้เอาไปแปะในเลย์เอาต์ของแต่ละฝั่งได้เอง
export function renderOfficeAreaContent({ officeAccount, slots, canEdit, uploadUrlAction, saveAction, supabaseUrl, supabaseAnonKey }) {
  const slotCards = slots
    .map((slot) => {
      const hasContent = !!slot.file_name;
      const preview = hasContent
        ? slot.file_type === 'video'
          ? `<video src="${slot.display_url}" controls style="width:100%; max-height:180px; border-radius:8px; margin:10px 0;"></video>`
          : `<img src="${slot.display_url}" style="width:100%; max-height:180px; object-fit:cover; border-radius:8px; margin:10px 0;" />`
        : '';

      const meta = hasContent
        ? `
          <p style="font-size:13px; margin:4px 0;"><strong>${slot.file_name}</strong></p>
          <p class="hint">แสดงตั้งแต่: ${slot.display_at ? new Date(slot.display_at).toLocaleString('th-TH') : 'ไม่ระบุ'}</p>
          <p class="hint">แก้ไขล่าสุดโดย: ${slot.updated_by || '-'} เมื่อ ${slot.updated_at ? new Date(slot.updated_at).toLocaleString('th-TH') : '-'}</p>`
        : `<p class="muted">ยังไม่มี Content ในช่องนี้</p>`;

      const uploadForm = canEdit
        ? `
          <form class="office-upload-form" data-slot="${slot.slot_number}" style="margin-top:12px; border-top:1px solid #f0f0f0; padding-top:12px;">
            <label>เลือกไฟล์ใหม่ (JPEG, PNG, MP4 — ไม่เกิน ${MAX_FILE_MB}MB)</label>
            <input type="file" name="file" accept="image/jpeg,image/png,video/mp4" required />
            <p class="hint" style="color:#e76f51; font-weight:600; margin-top:4px;">⚠️ ไฟล์ต้องไม่กว้างกว่า 16:9 (เช่น 1920x1080) — แคบกว่าได้ (เช่น 4:3, 1:1) แต่กว้างกว่าจะถูกปฏิเสธ</p>
            <label>ชื่อไฟล์ที่จะแสดง</label>
            <input type="text" name="file_name" required />
            <label>วันและเวลาที่ต้องการให้แสดง</label>
            <input type="datetime-local" name="display_at" required />
            <button type="submit" class="btn-primary" style="margin-top:10px;">อัปโหลด</button>
            <p class="upload-status hint" style="margin-top:8px;"></p>
          </form>`
        : '';

      return `
        <div class="section">
          <h2>Slot ${slot.slot_number}</h2>
          ${preview}
          ${meta}
          ${uploadForm}
        </div>`;
    })
    .join('');

  const script = canEdit
    ? `
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

      const sb = supabase.createClient(${JSON.stringify(supabaseUrl)}, ${JSON.stringify(supabaseAnonKey)});
      const MAX_BYTES = ${MAX_FILE_MB} * 1024 * 1024;

      document.querySelectorAll('.office-upload-form').forEach((form) => {
        form.addEventListener('submit', async (e) => {
          e.preventDefault();
          const slot = form.dataset.slot;
          const fileInput = form.querySelector('input[name="file"]');
          const fileNameInput = form.querySelector('input[name="file_name"]');
          const displayAtInput = form.querySelector('input[name="display_at"]');
          const statusEl = form.querySelector('.upload-status');
          const file = fileInput.files[0];

          if (!file) return;
          if (file.size > MAX_BYTES) {
            statusEl.textContent = 'ไฟล์ใหญ่เกิน ${MAX_FILE_MB}MB';
            return;
          }

          // ---------- เช็คอัตราส่วนภาพก่อนอัปโหลดจริง (แคบกว่า 16:9 ได้ กว้างกว่าไม่ได้) ----------
          statusEl.textContent = 'กำลังตรวจสอบอัตราส่วนไฟล์...';
          const isVideo = file.type.startsWith('video');
          const dims = await new Promise((resolve) => {
            const objectUrl = URL.createObjectURL(file);
            if (isVideo) {
              const videoEl = document.createElement('video');
              videoEl.preload = 'metadata';
              videoEl.onloadedmetadata = () => {
                URL.revokeObjectURL(objectUrl);
                resolve({ width: videoEl.videoWidth, height: videoEl.videoHeight });
              };
              videoEl.onerror = () => resolve(null);
              videoEl.src = objectUrl;
            } else {
              const img = new Image();
              img.onload = () => {
                URL.revokeObjectURL(objectUrl);
                resolve({ width: img.naturalWidth, height: img.naturalHeight });
              };
              img.onerror = () => resolve(null);
              img.src = objectUrl;
            }
          });

          if (dims) {
            const ratio = dims.width / dims.height;
            const withinTolerance = ratio <= (16 / 9) * 1.02;
            if (!withinTolerance) {
              statusEl.textContent = 'ไฟล์นี้อัตราส่วน ' + dims.width + 'x' + dims.height + ' กว้างเกินไป (ต้องไม่กว้างกว่า 16:9 — แคบกว่าได้)';
              return;
            }
            if (ratio < (16 / 9) * 0.98) {
              statusEl.textContent = '';
              const confirmed = await showRatioPreview(file, isVideo);
              if (!confirmed) {
                statusEl.textContent = 'ยกเลิกการอัปโหลด';
                return;
              }
            }
          }

          statusEl.textContent = 'กำลังขอสิทธิ์อัปโหลด...';
          try {
            const urlRes = await fetch('${uploadUrlAction}&slot=' + slot, {
              method: 'POST',
              headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
              body: 'file_name=' + encodeURIComponent(file.name),
            });
            const urlData = await urlRes.json();
            if (!urlRes.ok) throw new Error(urlData.error || 'ขอสิทธิ์อัปโหลดไม่สำเร็จ');

            statusEl.textContent = 'กำลังอัปโหลดไฟล์...';
            const { error: uploadError } = await sb.storage
              .from('office-content')
              .uploadToSignedUrl(urlData.path, urlData.token, file);
            if (uploadError) throw uploadError;

            statusEl.textContent = 'กำลังบันทึกข้อมูล...';
            const fileType = file.type.startsWith('video') ? 'video' : 'image';
            const saveRes = await fetch('${saveAction}&slot=' + slot, {
              method: 'POST',
              headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
              body: new URLSearchParams({
                file_path: urlData.path,
                file_name: fileNameInput.value,
                file_type: fileType,
                display_at: displayAtInput.value,
              }).toString(),
            });
            if (!saveRes.ok) throw new Error(await saveRes.text());

            statusEl.textContent = 'อัปโหลดสำเร็จ กำลังโหลดหน้าใหม่...';
            setTimeout(() => window.location.reload(), 800);
          } catch (err) {
            statusEl.textContent = 'เกิดข้อผิดพลาด: ' + err.message;
          }
        });
      });
    </script>`
    : '';

  return `
    <div class="section">
      <h2>${officeAccount.office_name}</h2>
      <p class="hint">Office Area — จัดการ Content 6 Slot</p>
    </div>
    ${slotCards}

    <div id="ratioPreviewModal" style="display:none; position:fixed; inset:0; background:rgba(0,0,0,0.7); z-index:1000; align-items:center; justify-content:center; padding:20px;">
      <div style="background:white; border-radius:12px; padding:20px; max-width:480px; width:100%;">
        <h3 style="margin:0 0 4px; font-size:15px;">ตัวอย่างการแสดงผลบนจอจริง</h3>
        <p class="hint" style="margin:0 0 12px;">ไฟล์นี้แคบกว่า 16:9 จะมีแถบพื้นหลังด้านข้างตามภาพตัวอย่างนี้</p>
        <div id="ratioPreviewCanvas" style="position:relative; width:100%; aspect-ratio:16/9; background:#000; border-radius:8px; overflow:hidden; display:flex; align-items:center; justify-content:center;"></div>
        <div style="display:flex; gap:8px; margin-top:16px;">
          <button type="button" id="ratioPreviewCancel" class="btn-small" style="flex:1; background:#9ca3af; color:white;">ยกเลิก</button>
          <button type="button" id="ratioPreviewConfirm" class="btn-primary" style="flex:1; margin-top:0;">ยืนยัน อัปโหลด</button>
        </div>
      </div>
    </div>

    ${script}`;
}
