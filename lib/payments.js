// lib/payments.js
//
// รวมฟังก์ชันเรียก Omise (บัตรเครดิต/เดบิต) และ SlipOK (ตรวจสอบสลิปโอนเงินอัตโนมัติ)

// ---------- Omise ----------
const OMISE_API = 'https://api.omise.co';

function omiseAuthHeader() {
  return 'Basic ' + Buffer.from(`${process.env.OMISE_SECRET_KEY}:`).toString('base64');
}

// สร้าง charge จาก token ที่ฝั่งเบราว์เซอร์สร้างไว้แล้ว (Omise.js) — เงินหน่วยเป็นสตางค์ (บาท x 100)
export async function createOmiseCharge({ amountBaht, token, returnUri, description }) {
  const res = await fetch(`${OMISE_API}/charges`, {
    method: 'POST',
    headers: {
      Authorization: omiseAuthHeader(),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      amount: Math.round(amountBaht * 100),
      currency: 'thb',
      card: token,
      return_uri: returnUri,
      description: description || '',
    }),
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

// ---------- SlipOK ----------
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
