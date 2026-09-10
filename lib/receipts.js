// lib/receipts.js
//
// ระบบใบเสร็จรับเงิน (ไม่ใช่ใบกำกับภาษี — ยังไม่ได้จด VAT) ออกอัตโนมัติทันทีที่ชำระเงินสำเร็จ
// ทำเป็นหน้าเว็บพิมพ์สวยงาม ให้ Sponsor กด Print > Save as PDF เอาเอง — ไม่ใช้ PDF Library บน Server เลย
// (กันปัญหา Library หนัก + ไม่รองรับฟอนต์ไทย ที่เคยเจอปัญหาคล้ายกันมาก่อนกับ web-push)

import { supabase } from './supabaseClient.js';

const ISSUER_BRAND = 'SipFree';
const ISSUER_NAME = 'พุฒิพงศ์ พิสิษฐบรรณกร';

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
  const { data: seqRow } = await supabase.rpc('nextval_receipt_number'); // ดูฟังก์ชันคู่กันด้านล่าง (สร้างผ่าน SQL แทน ถ้าไม่ได้ตั้ง RPC ไว้)
  const receiptNumber = seqRow || `R${new Date().getFullYear() + 543}-${String(Date.now()).slice(-6)}`; // fallback เผื่อไม่ได้สร้าง RPC ไว้

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

export function renderReceiptPage(receipt, bookings, sponsor) {
  const rows = bookings
    .map(
      (b) => `
      <tr>
        <td>${b.office_accounts?.office_name || '-'} — Slot ${b.slot_number}</td>
        <td>สัปดาห์ ${new Date(b.week_start).toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: 'numeric' })}</td>
        <td style="text-align:right;">${Number(b.price).toLocaleString()} บาท</td>
      </tr>`
    )
    .join('');

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
  .issuer-name { font-size: 13px; color: #6b7280; margin-top: 2px; }
  .receipt-title { text-align: right; }
  .receipt-title h1 { font-size: 18px; margin: 0; }
  .receipt-number { font-size: 13px; color: #6b7280; }
  .info-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 24px; font-size: 13px; }
  .info-grid .label { color: #9ca3af; margin-bottom: 2px; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 16px; }
  th { text-align: left; font-size: 12px; color: #9ca3af; border-bottom: 1px solid #e5e7eb; padding: 8px 4px; }
  td { font-size: 13px; padding: 10px 4px; border-bottom: 1px solid #f0f0f0; }
  .total-row { display: flex; justify-content: flex-end; margin-top: 12px; font-size: 16px; font-weight: 700; }
  .footer { margin-top: 40px; font-size: 11px; color: #9ca3af; text-align: center; }
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

    <div class="footer">
      <p>เอกสารนี้เป็นใบเสร็จรับเงินทั่วไป ไม่ใช่ใบกำกับภาษี (ผู้ออกยังไม่ได้จดทะเบียนภาษีมูลค่าเพิ่ม)</p>
    </div>
  </div>
</body>
</html>`;
}
