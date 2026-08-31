// api/qr/[creative].js
//
// URL รูปแบบ: https://your-project.vercel.app/api/qr/creativeA
// ทำ 2 อย่าง:
//   1. บันทึก log ลง Supabase (creative_id, timestamp, screen_id ถ้ามี)
//   2. Redirect คนไปหน้าโปรโมชั่นจริงของลูกค้า

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

export default async function handler(req, res) {
  const { creative } = req.query;
  const screenId = req.query.screen || null; // เผื่ออยากส่ง ?screen=LOBBY-A-01 มาด้วย

  // ดึงปลายทางจากตาราง creatives แทนการเขียนตายตัวในโค้ด
  // แก้/เพิ่ม creative ใหม่ได้จากหน้า Table Editor หรือหน้า Admin โดยไม่ต้อง deploy ใหม่
  const { data, error } = await supabase
    .from('creatives')
    .select('destination_url, active, campaign_type, promo_code, promo_instructions, campaign_name')
    .eq('creative_id', creative)
    .single();

  if (error || !data) {
    res.status(404).send('ไม่พบ creative นี้');
    return;
  }

  if (data.active === false) {
    res.status(200).send('แคมเปญนี้ปิดใช้งานอยู่ในขณะนี้');
    return;
  }

  // บันทึก log การมองเห็น/สแกน — นับทุกครั้งไม่ว่าจะล็อกอินสำเร็จหรือไม่
  try {
    await supabase.from('scan_logs').insert({
      creative_id: creative,
      screen_id: screenId,
      scanned_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error('บันทึก log ไม่สำเร็จ:', err);
  }

  // แทนที่จะไปหน้าโปรโมชั่นตรงๆ ให้ไปล็อกอิน LINE ก่อน เพื่อรู้ตัวตนแล้วให้แต้ม
  // creative_id ถูกส่งผ่าน state เพื่อให้ callback รู้ว่าต้องให้แต้มจาก creative ไหน
  // และรู้ว่าเสร็จแล้วต้องทำอะไรต่อ (redirect ไปปลายทาง หรือโชว์หน้าโค้ดโปรโมชั่น) — encode มาด้วยกัน กัน SQL query ซ้ำ
  const state = Buffer.from(
    JSON.stringify({
      creative,
      destination: data.destination_url,
      campaignType: data.campaign_type || 'link',
      promoCode: data.promo_code || null,
      promoInstructions: data.promo_instructions || null,
      campaignName: data.campaign_name || null,
    })
  ).toString('base64url');

  const lineAuthUrl = new URL('https://access.line.me/oauth2/v2.1/authorize');
  lineAuthUrl.searchParams.set('response_type', 'code');
  lineAuthUrl.searchParams.set('client_id', process.env.LINE_CHANNEL_ID);
  lineAuthUrl.searchParams.set('redirect_uri', process.env.LINE_CALLBACK_URL);
  lineAuthUrl.searchParams.set('state', state);
  lineAuthUrl.searchParams.set('scope', 'profile openid');

  res.writeHead(302, { Location: lineAuthUrl.toString() });
  res.end();
}
