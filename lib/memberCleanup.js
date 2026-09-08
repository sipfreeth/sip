// lib/memberCleanup.js
//
// รองรับ Privacy Policy ข้อ "เก็บข้อมูล 2 ปี นับจากใช้งานล่าสุด" — แบบกึ่งอัตโนมัติ
// Admin เห็นรายชื่อสมาชิกที่ไม่ใช้งานนานเกิน 2 ปี แล้วเลือกลบเองเป็นรอบๆ (ไม่ลบอัตโนมัติทันที)
//
// "ลบ" ในที่นี้คือ "ทำให้ระบุตัวตนไม่ได้" (Anonymize) ไม่ใช่ลบแถวทิ้งจริง
// เพราะยังต้องเก็บประวัติ Sip/ของรางวัลไว้ทำรายงานสรุปภาพรวมได้ (ตัวเลขรวมยังถูกต้อง แค่ไม่รู้ว่าเป็นใคร)

import { supabase } from './supabaseClient.js';

export async function getInactiveMembers() {
  const { data } = await supabase.from('inactive_members_view').select('*');
  return data || [];
}

export async function anonymizeMember(memberId) {
  // ใส่ค่าที่ไม่ซ้ำใครแทน line_user_id เดิม (คอลัมน์นี้มักมี Unique Constraint ต้องกันชนกัน)
  const { error } = await supabase
    .from('members')
    .update({
      line_user_id: `deleted-${memberId}-${Date.now()}`,
      display_name: 'สมาชิกที่ถูกลบข้อมูลแล้ว',
      picture_url: null,
    })
    .eq('id', memberId);
  if (error) throw error;
}
