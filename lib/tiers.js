// lib/tiers.js
//
// ระดับสมาชิก เรียงจาก Tier Score น้อย -> มาก
// ปรับชื่อระดับ, เกณฑ์คะแนน, หรือเพิ่ม/ลดจำนวนระดับได้ตรงนี้ที่เดียว
// (ใช้ร่วมกันทั้ง api/auth/callback.js และ api/admin/dashboard.js)

export const TIERS = [
  { name: 'Explorer', min: 0, color: '#9ca3af' },
  { name: 'Insider', min: 100, color: '#2a78d6' },
  { name: 'Ambassador', min: 200, color: '#d4a017' },
  { name: 'Legend', min: 400, color: '#8b5cf6' },
];

export function getTier(tierScore) {
  let current = TIERS[0];
  for (const tier of TIERS) {
    if (tierScore >= tier.min) current = tier;
  }
  const next = TIERS.find((t) => t.min > tierScore) || null;
  return { current, next, pointsToNext: next ? next.min - tierScore : 0 };
}

// ---- ช่วงเวลาที่ใช้ตัดสิน Tier ----
// กติกา: Tier ของ "ปีนี้ทั้งปี" ถูกล็อกไว้จากยอด Tier Score ของ "ปีที่แล้วทั้งปี"
// (เหมือนสายการบินประเมินสถานะจากยอดบินปีก่อน) ยกเว้นสมาชิกที่เพิ่งสมัครปีนี้
// ซึ่งยังไม่มีปีที่แล้วให้ดู จะใช้ยอดสะสม ณ ตอนนี้ของปีนี้ไปพลางก่อน
export function getTierEvaluationPeriod(memberCreatedAt) {
  const now = new Date();
  const currentYear = now.getFullYear();
  const joinYear = new Date(memberCreatedAt).getFullYear();

  if (joinYear >= currentYear) {
    // สมาชิกใหม่ปีนี้ — ยังไม่มีปีที่แล้วให้ประเมิน ใช้ยอดสะสมปีนี้ (นับถึงตอนนี้)
    return { start: new Date(currentYear, 0, 1).toISOString(), end: null };
  }
  // สมาชิกเก่า — ใช้ยอดของ "ปีที่แล้วทั้งปี" (1 ม.ค. - 31 ธ.ค. ปีก่อน) มาล็อก Tier ปีนี้
  return {
    start: new Date(currentYear - 1, 0, 1).toISOString(),
    end: new Date(currentYear, 0, 1).toISOString(),
  };
}

// ---- ช่วงเวลาที่ใช้คำนวณ Point คงเหลือ ----
// Point หมดอายุทุกสิ้นปี ใช้แค่ยอดที่ได้ในปีปฏิทินปัจจุบันเท่านั้น (ไม่ทบจากปีก่อน)
export function getCurrentYearStart() {
  const now = new Date();
  return new Date(now.getFullYear(), 0, 1).toISOString();
}
