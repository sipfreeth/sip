// lib/supabaseClient.js
// Client กลาง ใช้ร่วมกันในไฟล์ admin ทั้งหมด (กันสร้างซ้ำหลายที่)
import { createClient } from '@supabase/supabase-js';

export const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);
