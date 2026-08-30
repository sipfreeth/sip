// lib/payments.js
//
// รวมฟังก์ชันเรียก Omise (บัตรเครดิต/เดบิต) และ SlipOK (ตรวจสอบสลิปโอนเงินอัตโนมัติ)

// ---------- Omise ----------
const OMISE_API = 'https://api.omise.co';

function omiseAuthHeader() {
  return 'Basic ' + Buffer.from(`${process.env.OMISE_SECRET_KEY}:`).toString('base64');
}

// สร้าง charge — รองรับทั้งบัตรใหม่ (token) และบัตรที่บันทึกไว้แล้ว (customer + card) — เงินหน่วยเป็นสตางค์ (บาท x 100)
export async function createOmiseCharge({ amountBaht, token, customerId, cardId, returnUri, description }) {
  const body = {
    amount: Math.round(amountBaht * 100),
    currency: 'thb',
    return_uri: returnUri,
    description: description || '',
  };
  if (customerId) {
    body.customer = customerId;
    if (cardId) body.card = cardId; // ไม่ใส่ = ใช้ default card ของ customer
  } else {
    body.card = token; // จ่ายบัตรใหม่แบบไม่บันทึก
  }

  const res = await fetch(`${OMISE_API}/charges`, {
    method: 'POST',
    headers: {
      Authorization: omiseAuthHeader(),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || 'สร้างรายการชำระเงินไม่สำเร็จ');
  return data; // { id, status, paid, authorize_uri, ... }
}

export async function getOmiseCharge(chargeId) {
  const res = await fetch(`${OMISE_API}/charges/${chargeId}`, {
    headers: { Authorization: omiseAuthHeader() },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || 'ดึงข้อมูล charge ไม่สำเร็จ');
  return data;
}

// ---------- Omise Customer (ผูกบัตรไว้ใช้ซ้ำ เหมือนระบบ Shopee/e-commerce ทั่วไป) ----------

// สร้าง Customer ใหม่ พร้อมผูกบัตรใบแรก (จาก token ที่ browser สร้างไว้)
export async function createOmiseCustomer({ email, token }) {
  const res = await fetch(`${OMISE_API}/customers`, {
    method: 'POST',
    headers: {
      Authorization: omiseAuthHeader(),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ email, card: token }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || 'สร้างบัญชีลูกค้าไม่สำเร็จ');
  return data; // { id, default_card, cards: { data: [...] } }
}

// เพิ่มบัตรใบใหม่ให้ Customer ที่มีอยู่แล้ว
export async function attachCardToCustomer(customerId, token) {
  const res = await fetch(`${OMISE_API}/customers/${customerId}`, {
    method: 'PATCH',
    headers: {
      Authorization: omiseAuthHeader(),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ card: token }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || 'เพิ่มบัตรไม่สำเร็จ');
  return data;
}

// ดึงรายการบัตรทั้งหมดของ Customer (ข้อมูลจริงอยู่ที่ Omise เสมอ ไม่ต้องเก็บเองฝั่งเรา)
export async function listCustomerCards(customerId) {
  const res = await fetch(`${OMISE_API}/customers/${customerId}`, {
    headers: { Authorization: omiseAuthHeader() },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || 'ดึงข้อมูลบัตรไม่สำเร็จ');
  return { defaultCardId: data.default_card, cards: data.cards?.data || [] };
}

export async function setDefaultCard(customerId, cardId) {
  const res = await fetch(`${OMISE_API}/customers/${customerId}`, {
    method: 'PATCH',
    headers: {
      Authorization: omiseAuthHeader(),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ default_card: cardId }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || 'ตั้งบัตรหลักไม่สำเร็จ');
  return data;
}

export async function deleteCustomerCard(customerId, cardId) {
  const res = await fetch(`${OMISE_API}/customers/${customerId}/cards/${cardId}`, {
    method: 'DELETE',
    headers: { Authorization: omiseAuthHeader() },
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.message || 'ลบบัตรไม่สำเร็จ');
  }
}

// ---------- Internet Banking (จ่ายผ่านธนาคารออนไลน์ ครั้งเดียว ไม่ต้องผูกบัญชีถาวร) ----------
// ธนาคารที่ Omise รองรับตอนนี้ (เช็คในบัญชี Omise จริงว่าเปิดใช้ครบไหม อาจต่างกันไปตามแต่ละบัญชี)
export const SUPPORTED_BANKS = [
  { code: 'internet_banking_bbl', label: 'ธนาคารกรุงเทพ (BBL)' },
  { code: 'internet_banking_bay', label: 'ธนาคารกรุงศรีอยุธยา (BAY)' },
  { code: 'internet_banking_ktb', label: 'ธนาคารกรุงไทย (KTB)' },
  { code: 'internet_banking_scb', label: 'ธนาคารไทยพาณิชย์ (SCB)' },
];

// สร้าง Source แล้ว charge จาก Source นั้นทันที — คืน charge ที่มี authorize_uri ให้ redirect ไปหน้า login ธนาคาร
export async function createOmiseBankCharge({ amountBaht, bankCode, returnUri, description }) {
  const sourceRes = await fetch(`${OMISE_API}/sources`, {
    method: 'POST',
    headers: {
      Authorization: omiseAuthHeader(),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      amount: Math.round(amountBaht * 100),
      currency: 'thb',
      type: bankCode,
    }),
  });
  const source = await sourceRes.json();
  if (!sourceRes.ok) throw new Error(source.message || 'สร้างรายการธนาคารไม่สำเร็จ');

  const chargeRes = await fetch(`${OMISE_API}/charges`, {
    method: 'POST',
    headers: {
      Authorization: omiseAuthHeader(),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      amount: Math.round(amountBaht * 100),
      currency: 'thb',
      source: source.id,
      return_uri: returnUri,
      description: description || '',
    }),
  });
  const charge = await chargeRes.json();
  if (!chargeRes.ok) throw new Error(charge.message || 'สร้างรายการชำระเงินไม่สำเร็จ');
  return charge; // { id, authorize_uri, paid, ... }
}

// ---------- PromptPay QR ----------
// สร้าง payload สำหรับ PromptPay QR ตามมาตรฐาน EMVCo ของไทย แล้วเอาไปสร้างรูป QR ผ่านบริการฟรีภายนอก (qrserver.com)
//
// *** ยังไม่ได้ตั้งค่าเลข PromptPay จริง ***
// พอมีเลขพร้อมใช้งานแล้ว ให้เพิ่ม Environment Variable ชื่อ PROMPTPAY_ID ใน Vercel:
//   - ถ้าเป็นเบอร์โทร ใส่แบบไม่มีขีด ไม่มี 0 นำหน้า เช่น "0812345678" ก็ใส่ไปแบบนั้นได้เลย โค้ดจะแปลงให้เอง
//   - ถ้าเป็นเลขประจำตัวผู้เสียภาษี/เลขบัตรประชาชน ใส่ 13 หลักตรงๆ
// ไม่ต้องแก้โค้ดไฟล์นี้เลย แค่เพิ่ม Environment Variable ตัวนี้ตัวเดียวก็ใช้งานได้ทันที

function crc16(payload) {
  let crc = 0xffff;
  for (let i = 0; i < payload.length; i++) {
    crc ^= payload.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) {
      crc = crc & 0x8000 ? (crc << 1) ^ 0x1021 : crc << 1;
      crc &= 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

function tlv(id, value) {
  return `${id}${String(value.length).padStart(2, '0')}${value}`;
}

export function isPromptPayConfigured() {
  return Boolean(process.env.PROMPTPAY_ID);
}

// คืน payload string (เอาไปสร้าง QR ต่อได้เลย) — ต้องมี PROMPTPAY_ID ตั้งไว้ก่อน ไม่งั้นคืน null
export function generatePromptPayPayload(amountBaht) {
  const rawId = process.env.PROMPTPAY_ID;
  if (!rawId) return null;

  const digits = rawId.replace(/[^0-9]/g, '');
  let merchantInfo;

  if (digits.length === 13) {
    // เลขประจำตัวผู้เสียภาษี / เลขบัตรประชาชน
    merchantInfo = tlv('00', 'A000000677010111') + tlv('02', digits);
  } else {
    // เบอร์โทร — แปลงเป็นรูปแบบสากล 0066XXXXXXXXX (ตัด 0 นำหน้าออก แทนด้วย 66)
    const localDigits = digits.startsWith('0') ? digits.slice(1) : digits;
    const intlPhone = '0066' + localDigits;
    merchantInfo = tlv('00', 'A000000677010111') + tlv('01', intlPhone);
  }

  let payload =
    tlv('00', '01') +
    tlv('01', '12') + // dynamic QR (มีจำนวนเงินระบุตายตัว)
    tlv('29', merchantInfo) +
    tlv('53', '764') + // THB
    tlv('54', amountBaht.toFixed(2)) +
    tlv('58', 'TH');

  payload += '6304'; // เริ่ม tag CRC แต่ยังไม่ใส่ค่า
  const checksum = crc16(payload);
  return payload + checksum;
}

// คืน URL รูป QR พร้อมใช้ (ใช้บริการฟรีภายนอก ไม่ต้องติดตั้งไลบรารีเพิ่ม)
export function getPromptPayQrImageUrl(amountBaht) {
  const payload = generatePromptPayPayload(amountBaht);
  if (!payload) return null;
  return `https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=${encodeURIComponent(payload)}`;
}


// ส่งรูปสลิป (bytes) ไปให้ SlipOK ตรวจสอบ พร้อมยอดเงินที่คาดหวัง (ให้ SlipOK cross-check ให้อัตโนมัติ)
export async function verifySlipWithSlipOK({ fileBytes, fileName, expectedAmount }) {
  const url = `https://api.slipok.com/api/line/apikey/${process.env.SLIPOK_BRANCH_ID}`;

  const form = new FormData();
  form.append('files', new Blob([fileBytes]), fileName || 'slip.jpg');
  form.append('amount', String(expectedAmount));
  form.append('log', 'true');

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'x-authorization': process.env.SLIPOK_API_KEY },
    body: form,
  });

  const data = await res.json();
  return { httpOk: res.ok, ...data }; // { success, data: { success, message, amount, transRef, ... } }
}
