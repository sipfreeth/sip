// lib/receipts.js
//
// ระบบใบเสร็จรับเงิน (ไม่ใช่ใบกำกับภาษี — ยังไม่ได้จด VAT) ออกอัตโนมัติทันทีที่ชำระเงินสำเร็จ
// ทำเป็นหน้าเว็บพิมพ์สวยงาม ให้ Sponsor กด Print > Save as PDF เอาเอง — ไม่ใช้ PDF Library บน Server เลย
// (กันปัญหา Library หนัก + ไม่รองรับฟอนต์ไทย ที่เคยเจอปัญหาคล้ายกันมาก่อนกับ web-push)

import { supabase } from './supabaseClient.js';

const ISSUER_BRAND = 'SipFree';
const ISSUER_NAME = 'พุฒิพงศ์ พิสิษฐบรรณกร';
const ISSUER_ADDRESS = '388/211 หมู่บ้านพลีโน่สุขสวัสดิ์ 30(2) ซอยสุขสวัสดิ์30 ถนนสุขสวัสดิ์ แขวงบางปะกอก เขตราษฎร์บูรณะ กรุงเทพฯ 10140';
const ISSUER_ID_NUMBER = '1120300070711';

// สร้างใบเสร็จให้ Booking Group นี้ — กันสร้างซ้ำถ้าเคยออกไปแล้ว (เผื่อมีการเรียกซ้ำจากหลายจุด)
export async function createReceiptForGroup(groupId) {
  const { data: existing } = await supabase.from('receipts').select('id').eq('booking_group_id', groupId).maybeSingle();
  if (existing) return existing;

  const { data: bookings } = await supabase
    .from('slot_bookings')
    .select('sponsor_id, price, payment_method')
    .eq('booking_group_id', groupId);

  if (!bookings || !bookings.length) return null;

  const amount = bookings.reduce((sum, b) => sum + Number(b.price || 0), 0);
  const { data: seqRow } = await supabase.rpc('nextval_receipt_number');
  const receiptNumber = seqRow || `R${new Date().getFullYear() + 543}-${String(Date.now()).slice(-6)}`; // fallback เผื่อ RPC มีปัญหา

  const { data: receipt, error } = await supabase
    .from('receipts')
    .insert({
      receipt_number: receiptNumber,
      booking_group_id: groupId,
      sponsor_id: bookings[0].sponsor_id,
      amount,
      payment_method: bookings[0].payment_method,
    })
    .select()
    .single();

  if (error) {
    console.error('❌ ออกใบเสร็จไม่สำเร็จ:', error.message);
    return null;
  }
  return receipt;
}

export async function getReceiptsForSponsor(sponsorId) {
  const { data } = await supabase.from('receipts').select('*').eq('sponsor_id', sponsorId).order('created_at', { ascending: false });
  return data || [];
}

export async function getReceiptById(receiptId, sponsorId) {
  const { data } = await supabase.from('receipts').select('*').eq('id', receiptId).eq('sponsor_id', sponsorId).maybeSingle();
  return data;
}

// ใช้ตอน Sponsor คลิกดูใบเสร็จจาก Slot โดยตรง — หาใบเสร็จจาก booking_group_id แทนที่จะรู้ receipt_id ตรงๆ
export async function getReceiptByGroupId(groupId, sponsorId) {
  const { data } = await supabase.from('receipts').select('*').eq('booking_group_id', groupId).eq('sponsor_id', sponsorId).maybeSingle();
  return data;
}

// สำหรับหน้าตรวจสอบใบเสร็จสาธารณะ (ไม่ต้อง Login) — คืนแค่ข้อมูลที่จำเป็นสำหรับยืนยันความถูกต้อง ไม่เปิดเผยข้อมูล Sponsor เกินจำเป็น
export async function getReceiptForVerification(receiptNumber) {
  const { data: receipt } = await supabase.from('receipts').select('*, sponsors(company_name)').eq('receipt_number', receiptNumber).maybeSingle();
  return receipt;
}

export function renderReceiptPage(receipt, bookings, sponsor, baseUrl) {
  const rows = bookings
    .map(
      (b) => `
      <tr>
        <td>ค่าพื้นที่โฆษณาบนจอ LED ออฟฟิศ ${b.office_accounts?.office_name || '-'} Slot ${b.slot_number}</td>
        <td>สัปดาห์ ${new Date(b.week_start).toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: 'numeric' })}</td>
        <td style="text-align:right;">${Number(b.price).toLocaleString()} บาท</td>
      </tr>`
    )
    .join('');

  const verifyUrl = `${baseUrl}/api/sponsor/action?action=verify_receipt&number=${encodeURIComponent(receipt.receipt_number)}`;
  const qrImageUrl = `https://api.qrserver.com/v1/create-qr-code/?size=120x120&data=${encodeURIComponent(verifyUrl)}`;

  return `<!DOCTYPE html>
<html lang="th">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>ใบเสร็จรับเงิน ${receipt.receipt_number}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: sans-serif; background: #f7f8fa; margin: 0; padding: 24px; color: #1b1f27; }
  .paper { background: white; max-width: 700px; margin: 0 auto; padding: 40px; border-radius: 8px; box-shadow: 0 1px 4px rgba(0,0,0,0.08); }
  .header { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #1b1f27; padding-bottom: 16px; margin-bottom: 24px; }
  .brand { font-size: 22px; font-weight: 700; }
  .issuer-name { font-size: 13px; color: #374151; margin-top: 4px; }
  .issuer-detail { font-size: 12px; color: #6b7280; margin-top: 2px; line-height: 1.5; }
  .receipt-title { text-align: right; }
  .receipt-title h1 { font-size: 18px; margin: 0; }
  .receipt-number { font-size: 13px; color: #6b7280; }
  .info-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 24px; font-size: 13px; }
  .info-grid .label { color: #9ca3af; margin-bottom: 2px; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 16px; }
  th { text-align: left; font-size: 12px; color: #9ca3af; border-bottom: 1px solid #e5e7eb; padding: 8px 4px; }
  td { font-size: 13px; padding: 10px 4px; border-bottom: 1px solid #f0f0f0; }
  .total-row { display: flex; justify-content: flex-end; margin-top: 12px; font-size: 16px; font-weight: 700; }
  .signature-area { display: flex; justify-content: flex-end; margin-top: 48px; }
  .signature-box { text-align: center; font-size: 12px; color: #6b7280; }
  .signature-line { border-bottom: 1px solid #9ca3af; width: 200px; margin-bottom: 6px; height: 32px; }
  .verify-area { display: flex; align-items: center; gap: 12px; margin-top: 32px; padding-top: 16px; border-top: 1px dashed #e5e7eb; }
  .verify-text { font-size: 11px; color: #9ca3af; }
  .footer { margin-top: 24px; font-size: 11px; color: #9ca3af; text-align: center; }
  .print-btn { display: block; max-width: 700px; margin: 16px auto; padding: 10px; background: #1b1f27; color: white; border: none; border-radius: 8px; font-size: 14px; cursor: pointer; }
  @media print { .print-btn { display: none; } body { background: white; padding: 0; } .paper { box-shadow: none; } }
</style>
</head>
<body>
  <button class="print-btn" onclick="window.print()">🖨️ พิมพ์ / บันทึกเป็น PDF</button>
  <div class="paper">
    <div class="header">
      <div>
        <div class="brand">${ISSUER_BRAND}</div>
        <div class="issuer-name">ออกใบเสร็จในนาม: ${ISSUER_NAME}</div>
        <div class="issuer-detail">${ISSUER_ADDRESS}</div>
        <div class="issuer-detail">เลขประจำตัวประชาชน: ${ISSUER_ID_NUMBER}</div>
      </div>
      <div class="receipt-title">
        <h1>ใบเสร็จรับเงิน</h1>
        <div class="receipt-number">เลขที่ ${receipt.receipt_number}</div>
      </div>
    </div>

    <div class="info-grid">
      <div>
        <div class="label">ผู้ชำระเงิน</div>
        <div>${sponsor.company_name}</div>
        ${sponsor.tax_id ? `<div>เลขผู้เสียภาษี: ${sponsor.tax_id}</div>` : ''}
        ${sponsor.address ? `<div>${sponsor.address}</div>` : ''}
      </div>
      <div>
        <div class="label">วันที่ออกใบเสร็จ</div>
        <div>${new Date(receipt.created_at).toLocaleDateString('th-TH', { day: 'numeric', month: 'long', year: 'numeric' })}</div>
        <div class="label" style="margin-top:8px;">ช่องทางชำระเงิน</div>
        <div>${{ omise: 'บัตรเครดิต/เดบิต', 'card+credit': 'บัตร + เครดิต', transfer: 'โอนเงิน', 'transfer+credit': 'โอนเงิน + เครดิต', credit: 'เครดิตในระบบ', manual: 'โอนเงิน (Admin ยืนยัน)' }[receipt.payment_method] || receipt.payment_method}</div>
      </div>
    </div>

    <table>
      <tr><th>รายการ</th><th>ช่วงเวลา</th><th style="text-align:right;">จำนวนเงิน</th></tr>
      ${rows}
    </table>

    <div class="total-row">รวมทั้งสิ้น: ${Number(receipt.amount).toLocaleString()} บาท</div>

    <div class="signature-area">
      <div class="signature-box">
        <div class="signature-line"></div>
        ลงชื่อผู้รับเงิน (${ISSUER_NAME})
      </div>
    </div>

    <div class="verify-area">
      <img src="${qrImageUrl}" width="70" height="70" alt="QR ตรวจสอบใบเสร็จ" />
      <div class="verify-text">
        สแกนเพื่อตรวจสอบความถูกต้องของใบเสร็จนี้<br/>
        หรือเข้า ${verifyUrl}
      </div>
    </div>

    <div class="footer">
      <p>เอกสารนี้เป็นใบเสร็จรับเงินทั่วไป ไม่ใช่ใบกำกับภาษี (ผู้ออกยังไม่ได้จดทะเบียนภาษีมูลค่าเพิ่ม)</p>
    </div>
  </div>
</body>
</html>`;
}

// หน้าตรวจสอบใบเสร็จสาธารณะ — ไม่ต้อง Login เข้าถึงได้ทุกคนที่มีเลขที่ใบเสร็จ
export function renderVerifyPage(receipt) {
  if (!receipt) {
    return `<!DOCTYPE html><html lang="th"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width, initial-scale=1.0"/><title>ไม่พบใบเสร็จ</title></head>
      <body style="font-family:sans-serif; text-align:center; padding:60px 20px; background:#f7f8fa;">
        <h2 style="color:#e76f51;">❌ ไม่พบใบเสร็จนี้ในระบบ</h2>
        <p style="color:#6b7280;">เลขที่ใบเสร็จนี้ไม่ตรงกับข้อมูลในระบบ อาจถูกแก้ไขหรือปลอมแปลง</p>
      </body></html>`;
  }

  return `<!DOCTYPE html>
<html lang="th">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>ตรวจสอบใบเสร็จ ${receipt.receipt_number}</title>
<style>
  body { font-family: sans-serif; background: #f7f8fa; margin: 0; padding: 24px; color: #1b1f27; }
  .card { background: white; max-width: 420px; margin: 40px auto; padding: 32px; border-radius: 16px; box-shadow: 0 1px 4px rgba(0,0,0,0.08); text-align: center; }
  .check { font-size: 40px; margin-bottom: 8px; }
  .row { display: flex; justify-content: space-between; padding: 10px 0; border-bottom: 1px solid #f0f0f0; font-size: 14px; text-align: left; }
  .label { color: #9ca3af; }
</style>
</head>
<body>
  <div class="card">
    <div class="check">✅</div>
    <h2 style="margin:0 0 20px;">ใบเสร็จนี้ถูกต้อง</h2>
    <div class="row"><span class="label">เลขที่</span><strong>${receipt.receipt_number}</strong></div>
    <div class="row"><span class="label">วันที่ออก</span><span>${new Date(receipt.created_at).toLocaleDateString('th-TH', { day: 'numeric', month: 'long', year: 'numeric' })}</span></div>
    <div class="row"><span class="label">ผู้ชำระเงิน</span><span>${receipt.sponsors?.company_name || '-'}</span></div>
    <div class="row" style="border-bottom:none;"><span class="label">จำนวนเงิน</span><strong style="color:#06c755;">${Number(receipt.amount).toLocaleString()} บาท</strong></div>
  </div>
</body>
</html>`;
}
