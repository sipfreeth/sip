// lib/htmlEscape.js
//
// Escape ข้อความก่อนแปะลง HTML ฝั่ง Server — ป้องกัน Stored XSS
// ใช้ทุกจุดที่เอาข้อมูลที่ผู้ใช้กรอกเอง (ชื่อบริษัท, ชื่อติดต่อ, ที่อยู่, ชื่อไฟล์ ฯลฯ) ไปแปะใน HTML โดยตรง

export function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
