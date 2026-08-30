// lib/sponsorArea.js
//
// โค้ดกลางของระบบ Sponsor: คลัง Content, ปฏิทินความว่างของสล็อต, การจอง
// อัปโหลดไฟล์ตรงไป Supabase Storage เหมือนระบบ Office Area (เลี่ยงข้อจำกัดขนาด request ของ Vercel)

import { supabase } from './supabaseClient.js';
import crypto from 'crypto';

const BUCKET = 'sponsor-content';
const MAX_FILES_PER_SPONSOR = 6;
const MAX_IMAGE_MB = 15;
const MAX_VIDEO_MB = 50;
const MAX_VIDEO_SECONDS = 15;
const CREDIT_EXPIRY_DAYS = 365;
const WEEKS_TO_SHOW = 4;
const RESERVATION_MINUTES = 15;

// ---------- Content Library ----------
export async function getSponsorContent(sponsorId) {
  const { data } = await supabase
    .from('sponsor_content')
    .select('*')
    .eq('sponsor_id', sponsorId)
    .order('created_at', { ascending: false });
  return data || [];
}

export async function countSponsorContent(sponsorId) {
  const { count } = await supabase
    .from('sponsor_content')
    .select('id', { count: 'exact', head: true })
    .eq('sponsor_id', sponsorId);
  return count || 0;
}

export async function createUploadTarget(sponsorId, fileName) {
  const safeName = fileName.replace(/[^a-zA-Z0-9.\-_]/g, '_');
  const path = `${sponsorId}/${Date.now()}-${safeName}`;
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUploadUrl(path);
  if (error) throw error;
  return { path, token: data.token };
}

export async function saveSponsorContent({ sponsorId, fileName, filePath, fileType }) {
  const currentCount = await countSponsorContent(sponsorId);
  if (currentCount >= MAX_FILES_PER_SPONSOR) {
    throw new Error(`อัปโหลดได้สูงสุด ${MAX_FILES_PER_SPONSOR} ไฟล์ต่อบัญชี กรุณาลบไฟล์เก่าก่อน`);
  }
  const { error } = await supabase.from('sponsor_content').insert({
    sponsor_id: sponsorId,
    file_name: fileName,
    file_path: filePath,
    file_type: fileType,
  });
  if (error) throw error;
}

export async function getSignedContentUrl(filePath) {
  const { data } = await supabase.storage.from(BUCKET).createSignedUrl(filePath, 3600);
  return data?.signedUrl || null;
}

// ---------- ปฏิทินความว่างของสล็อต ----------
function getNextMonday(from = new Date()) {
  const d = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  const dayOfWeek = d.getDay(); // 0 = อาทิตย์
  const daysUntilMonday = (8 - dayOfWeek) % 7 || 7; // จันทร์หน้าเสมอ (ไม่นับสัปดาห์นี้ เพราะต้องจองล่วงหน้า)
  d.setDate(d.getDate() + daysUntilMonday);
  return d;
}

// คืน array ของสัปดาห์ที่จองได้ (เริ่มจากจันทร์หน้า ไปอีก WEEKS_TO_SHOW สัปดาห์)
export function getBookableWeeks() {
  const firstMonday = getNextMonday();
  const weeks = [];
  for (let i = 0; i < WEEKS_TO_SHOW; i++) {
    const start = new Date(firstMonday);
    start.setDate(firstMonday.getDate() + i * 7);
    weeks.push(start);
  }
  return weeks;
}

// คืนตารางความว่าง { [slot_number]: { [week_start_iso]: booking หรือ null } } ของ office หนึ่งอัน
// รายการที่ unpaid และเลย reserved_until มาแล้ว ถือว่า "หมดอายุ" ไม่นับว่าไม่ว่างอีกต่อไป (คืน slot ให้คนอื่นอัตโนมัติ)
export async function getAvailability(officeAccountId) {
  const weeks = getBookableWeeks();
  const lastWeek = new Date(weeks[weeks.length - 1]);
  lastWeek.setDate(lastWeek.getDate() + 7);
  const nowIso = new Date().toISOString();

  const { data: bookings } = await supabase
    .from('slot_bookings')
    .select('slot_number, week_start, payment_status, reserved_until')
    .eq('office_account_id', officeAccountId)
    .neq('payment_status', 'refunded') // คืนเงินแล้ว = ปล่อยช่องนั้นว่างกลับมาให้จองใหม่ได้
    .gte('week_start', weeks[0].toISOString().slice(0, 10))
    .lt('week_start', lastWeek.toISOString().slice(0, 10));

  const bookedMap = {};
  for (const b of bookings || []) {
    // ถือว่า "หมดอายุ" ทั้งกรณีเลยเวลาจริง และกรณี reserved_until เป็นค่าว่าง (แถวเก่า/ผิดพลาด ไม่ควรค้างกั้น slot ตลอดไป)
    const isExpiredHold = b.payment_status === 'unpaid' && (!b.reserved_until || b.reserved_until < nowIso);
    if (isExpiredHold) continue; // หมดเวลาจ่ายเงินแล้ว ถือว่าว่าง
    bookedMap[`${b.slot_number}_${b.week_start}`] = b;
  }

  return { weeks, bookedMap };
}

// ---------- สร้างการจอง (เลือกได้หลาย slot พร้อมกันในสัปดาห์เดียว ผูกเป็นกลุ่มเดียว จ่ายเงินรวมทีเดียว) ----------
export async function createBookings({ sponsorId, officeAccountId, slotNumbers, weekStart, slotContentMap, pricePerSlot }) {
  const nowIso = new Date().toISOString();
  const reservedUntil = new Date(Date.now() + RESERVATION_MINUTES * 60 * 1000).toISOString();
  const groupId = crypto.randomUUID();

  const bookingIds = [];
  for (const slotNumber of slotNumbers) {
    // เคลียร์ hold เก่าที่หมดอายุแล้วของ slot+สัปดาห์นี้ทิ้งก่อน (ถ้ามี) — รวมถึงแถวเก่าที่ reserved_until เป็นค่าว่างด้วย
    await supabase
      .from('slot_bookings')
      .delete()
      .eq('office_account_id', officeAccountId)
      .eq('slot_number', slotNumber)
      .eq('week_start', weekStart)
      .eq('payment_status', 'unpaid')
      .or(`reserved_until.lt.${nowIso},reserved_until.is.null`);

    const { data, error } = await supabase
      .from('slot_bookings')
      .insert({
        sponsor_id: sponsorId,
        office_account_id: officeAccountId,
        slot_number: slotNumber,
        week_start: weekStart,
        sponsor_content_id: slotContentMap[slotNumber],
        price: pricePerSlot,
        payment_status: 'unpaid',
        reserved_until: reservedUntil,
        booking_group_id: groupId,
      })
      .select('id')
      .single();

    if (error) {
      // ยกเลิกรายการที่เพิ่ง insert ไปในรอบนี้ทั้งหมด (all-or-nothing)
      if (bookingIds.length) {
        await supabase.from('slot_bookings').delete().in('id', bookingIds);
      }
      // ถ้าเป็นการชนกันจริง (unique constraint) จะบอกแบบนี้ ถ้าเป็นสาเหตุอื่นจะโชว์ข้อความจริงจากฐานข้อมูลแทน เพื่อวินิจฉัยง่ายขึ้น
      const isConflict = error.code === '23505';
      throw new Error(
        isConflict
          ? `Slot ${slotNumber} เพิ่งถูกจองไปโดยคนอื่น กรุณาเลือกใหม่`
          : `จองไม่สำเร็จที่ Slot ${slotNumber}: ${error.message}`
      );
    }

    bookingIds.push(data.id);
  }

  return { groupId, bookingIds };
}

// ดึงรายการจองทั้งกลุ่ม (ไว้ใช้หน้าชำระเงินรวม) — เช็คว่าเป็นของ sponsor คนนี้จริง และยังไม่หมดเวลาจ่าย
export async function getBookingGroup(groupId, sponsorId) {
  const { data } = await supabase
    .from('slot_bookings')
    .select('*, office_accounts(office_name, price_per_week)')
    .eq('booking_group_id', groupId)
    .eq('sponsor_id', sponsorId);
  return data || [];
}

// นับจำนวนรอบที่คอนเทนต์ของสล็อตนี้เล่นจริงบนจอ (ข้อมูลจาก CMS ที่ยิงเข้ามาทาง /api/playback-log)
// จับคู่ด้วย office + slot + ช่วงสัปดาห์ที่จอง เพราะ Playback Log ไม่รู้จัก sponsor โดยตรง
export async function getPlayCountForBooking(officeAccountId, slotNumber, weekStart) {
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekEnd.getDate() + 7);

  const { count } = await supabase
    .from('content_play_logs')
    .select('id', { count: 'exact', head: true })
    .eq('office_account_id', officeAccountId)
    .eq('slot_number', slotNumber)
    .gte('played_at', new Date(weekStart).toISOString())
    .lt('played_at', weekEnd.toISOString());

  return count || 0;
}

export { RESERVATION_MINUTES };

// ---------- บริหารสล็อตที่จองไปแล้ว (ฝั่ง Sponsor) ----------
export async function getSponsorBookings(sponsorId) {
  const { data } = await supabase
    .from('slot_bookings')
    .select('*, office_accounts(office_name), sponsor_content(file_name)')
    .eq('sponsor_id', sponsorId)
    .order('week_start', { ascending: false });
  return data || [];
}

export async function getBookingById(bookingId, sponsorId) {
  const { data } = await supabase
    .from('slot_bookings')
    .select('*, office_accounts(office_name, price_per_week)')
    .eq('id', bookingId)
    .eq('sponsor_id', sponsorId)
    .maybeSingle();
  return data;
}

export async function updateBookingContent(bookingId, sponsorId, sponsorContentId) {
  // เช็คก่อนว่า booking นี้ถูกตรวจสอบไปแล้วหรือยัง (อนุมัติแล้ว หรือ ไม่ผ่าน) — ถ้าตรวจแล้ว Sponsor แก้เองไม่ได้ ต้องแจ้งทีมงานผ่านแชทแทน แก้เองได้แค่ตอนยัง "รอตรวจสอบ" เท่านั้น
  const { data: booking } = await supabase
    .from('slot_bookings')
    .select('approval_status')
    .eq('id', bookingId)
    .eq('sponsor_id', sponsorId)
    .maybeSingle();

  if (!booking) throw new Error('ไม่พบรายการจองนี้');
  if (booking.approval_status !== 'pending') {
    const statusText = booking.approval_status === 'approved' ? 'ผ่านการอนุมัติแล้ว' : 'ถูกตรวจสอบแล้ว (ไม่ผ่าน)';
    throw new Error(`เนื้อหานี้${statusText} ไม่สามารถแก้ไขเองได้ กรุณาแจ้งทีมงานผ่านแชทเพื่อขอเปลี่ยนแทน`);
  }

  const { error } = await supabase
    .from('slot_bookings')
    .update({ sponsor_content_id: sponsorContentId, approval_status: 'pending', reviewed_by: null, reviewed_at: null })
    .eq('id', bookingId)
    .eq('sponsor_id', sponsorId);
  if (error) throw error;
}

// ---------- ฝั่ง Admin/ทีมงาน: เปลี่ยน Content ของ Booking แทน Sponsor (ตามที่แจ้งผ่านแชท) ----------
// เลือกได้เฉพาะไฟล์ที่เคยผ่านการอนุมัติมาก่อน (ในการจองครั้งอื่นของ sponsor คนเดียวกัน) เท่านั้น
export async function getPreviouslyApprovedContent(sponsorId) {
  const { data } = await supabase
    .from('slot_bookings')
    .select('sponsor_content_id, sponsor_content(id, file_name, file_type, file_path)')
    .eq('sponsor_id', sponsorId)
    .eq('approval_status', 'approved');

  const seen = new Map();
  for (const row of data || []) {
    if (row.sponsor_content && !seen.has(row.sponsor_content.id)) {
      seen.set(row.sponsor_content.id, row.sponsor_content);
    }
  }
  return Array.from(seen.values());
}

// ทีมงานเปลี่ยน content ให้ — เลือกจากไฟล์ที่เคยอนุมัติแล้วเท่านั้น ถือว่าอนุมัติทันทีไม่ต้องรอตรวจใหม่
export async function adminUpdateBookingContent(bookingId, sponsorId, sponsorContentId, reviewerLabel) {
  const approvedList = await getPreviouslyApprovedContent(sponsorId);
  if (!approvedList.some((c) => c.id === sponsorContentId)) {
    throw new Error('เลือกได้เฉพาะไฟล์ที่เคยผ่านการอนุมัติมาก่อนเท่านั้น');
  }
  const { error } = await supabase
    .from('slot_bookings')
    .update({
      sponsor_content_id: sponsorContentId,
      approval_status: 'approved',
      reviewed_by: reviewerLabel,
      reviewed_at: new Date().toISOString(),
      rejection_reason: null,
    })
    .eq('id', bookingId)
    .eq('sponsor_id', sponsorId);
  if (error) throw error;
}

// ยกเลิกได้แค่รายการที่ยังไม่จ่ายเงินเท่านั้น (กันสับสนเรื่อง refund)
export async function cancelUnpaidBooking(bookingId, sponsorId) {
  const { error } = await supabase
    .from('slot_bookings')
    .delete()
    .eq('id', bookingId)
    .eq('sponsor_id', sponsorId)
    .eq('payment_status', 'unpaid');
  if (error) throw error;
}

// ---------- อัปโหลดสลิปโอนเงิน ----------
const SLIP_BUCKET = 'payment-slips';

export async function createSlipUploadTarget(sponsorId, bookingId, fileName) {
  const safeName = fileName.replace(/[^a-zA-Z0-9.\-_]/g, '_');
  const path = `${sponsorId}/${bookingId}-${Date.now()}-${safeName}`;
  const { data, error } = await supabase.storage.from(SLIP_BUCKET).createSignedUploadUrl(path);
  if (error) throw error;
  return { path, token: data.token };
}

export async function downloadSlipBytes(filePath) {
  const { data, error } = await supabase.storage.from(SLIP_BUCKET).download(filePath);
  if (error) throw error;
  return Buffer.from(await data.arrayBuffer());
}

export async function getSignedSlipUrl(filePath) {
  const { data } = await supabase.storage.from(SLIP_BUCKET).createSignedUrl(filePath, 3600);
  return data?.signedUrl || null;
}

// ---------- ฝั่ง Admin: ค้นหา/ดูรายละเอียด Sponsor ----------
export async function searchSponsors(keyword) {
  const { data } = await supabase
    .from('sponsors')
    .select('id, sponsor_code, company_name, email')
    .or(`company_name.ilike.%${keyword}%,sponsor_code.ilike.%${keyword}%`)
    .order('sponsor_code')
    .limit(20);
  return data || [];
}

export async function getSponsorById(sponsorId) {
  const { data } = await supabase.from('sponsors').select('*').eq('id', sponsorId).maybeSingle();
  return data;
}

// ---------- ฝั่ง Admin: อนุมัติการจอง (ระดับ Slot) ก่อนส่งไป CMS ----------
export async function getPendingBookings() {
  const { data } = await supabase
    .from('slot_bookings')
    .select('*, sponsors(company_name, sponsor_code), office_accounts(office_name), sponsor_content(file_name, file_path, file_type)')
    .eq('approval_status', 'pending')
    .order('created_at', { ascending: true });
  return data || [];
}

export async function updateBookingApproval(bookingId, decision, reviewerLabel, rejectionReason) {
  await supabase
    .from('slot_bookings')
    .update({
      approval_status: decision,
      reviewed_by: reviewerLabel,
      reviewed_at: new Date().toISOString(),
      rejection_reason: decision === 'rejected' ? rejectionReason : null,
    })
    .eq('id', bookingId);
}

// ---------- เครดิต Sponsor (ได้จาก Slot ที่ไม่ผ่านอนุมัติ ใช้แทนเงินสด หมดอายุใน 1 ปี) ----------

// ยอดเครดิตที่ใช้ได้ตอนนี้ = ผลรวมของ (แถวได้เครดิตที่ยังไม่หมดอายุ) + (แถวใช้เครดิตทั้งหมด ซึ่งเป็นค่าติดลบ)
export async function getSponsorCreditBalance(sponsorId) {
  const nowIso = new Date().toISOString();
  const { data } = await supabase.from('sponsor_credits').select('amount, expires_at').eq('sponsor_id', sponsorId);
  let balance = 0;
  for (const row of data || []) {
    if (row.amount < 0) {
      balance += Number(row.amount); // การใช้เครดิต หักได้เสมอไม่มีวันหมดอายุ
    } else if (!row.expires_at || row.expires_at > nowIso) {
      balance += Number(row.amount); // การได้เครดิตที่ยังไม่หมดอายุ
    }
  }
  return Math.max(0, Math.round(balance * 100) / 100);
}

// ให้เครดิตใหม่ (ตอน Admin ปฏิเสธการจองที่จ่ายเงินไปแล้ว) — หมดอายุใน 1 ปีจากวันนี้
export async function grantSponsorCredit(sponsorId, amount, reason) {
  const expiresAt = new Date(Date.now() + CREDIT_EXPIRY_DAYS * 24 * 60 * 60 * 1000).toISOString();
  await supabase.from('sponsor_credits').insert({ sponsor_id: sponsorId, amount, reason, expires_at: expiresAt });
}

// ใช้เครดิต (ตอนจ่ายเงินจอง) — บันทึกเป็นแถวติดลบ ไม่มีวันหมดอายุ
export async function spendSponsorCredit(sponsorId, amount, reason) {
  await supabase.from('sponsor_credits').insert({ sponsor_id: sponsorId, amount: -Math.abs(amount), reason, expires_at: null });
}

export { MAX_FILES_PER_SPONSOR, MAX_IMAGE_MB, MAX_VIDEO_MB, MAX_VIDEO_SECONDS, WEEKS_TO_SHOW, CREDIT_EXPIRY_DAYS };


