// api/member-action.js
//
// รวม 4 ฟังก์ชันของฝั่งลูกค้าไว้ไฟล์เดียว (เดิมแยกเป็น points.js, rewards.js,
// redeem/[rewardId].js, redeem/confirm.js) เพื่อประหยัดโควต้า Vercel Serverless Functions
//
// เรียกผ่าน query parameter 'do':
//   GET  /api/member-action?do=points         — เช็คแต้มของฉัน (เดิม /api/points)
//   GET  /api/member-action?do=rewards        — ดูของรางวัล (เดิม /api/rewards)
//   GET  /api/member-action?do=redeem&reward=3 — กดแลกของรางวัล id 3 (เดิม /api/redeem/3)
//   POST /api/member-action?do=confirm        — ยืนยันที่อยู่จัดส่งหลังกรอกฟอร์ม (เดิม /api/redeem/confirm)

import { supabase } from '../lib/supabaseClient.js';
import { verifyRedeemToken } from '../lib/memberToken.js';
import { getCurrentYearStart } from '../lib/tiers.js';

async function getSpendableBalance(memberId) {
  const yearStart = getCurrentYearStart();
  const [earnedRes, spentRes] = await Promise.all([
    supabase.from('points_ledger').select('reward_points').eq('member_id', memberId).gte('created_at', yearStart),
    supabase.from('redemptions').select('points_spent').eq('member_id', memberId).gte('created_at', yearStart),
  ]);
  const earned = (earnedRes.data || []).reduce((sum, row) => sum + row.reward_points, 0);
  const spent = (spentRes.data || []).reduce((sum, row) => sum + row.points_spent, 0);
  return earned - spent;
}

function redirectToLine(res, state) {
  const encodedState = Buffer.from(JSON.stringify(state)).toString('base64url');
  const lineAuthUrl = new URL('https://access.line.me/oauth2/v2.1/authorize');
  lineAuthUrl.searchParams.set('response_type', 'code');
  lineAuthUrl.searchParams.set('client_id', process.env.LINE_CHANNEL_ID);
  lineAuthUrl.searchParams.set('redirect_uri', process.env.LINE_CALLBACK_URL);
  lineAuthUrl.searchParams.set('state', encodedState);
  lineAuthUrl.searchParams.set('scope', 'profile openid');
  res.writeHead(302, { Location: lineAuthUrl.toString() });
  res.end();
}

export default async function handler(req, res) {
  const doParam = req.query.do;

  // ---------- เช็คแต้มของฉัน (เดิม /api/points) ----------
  if (doParam === 'points') {
    redirectToLine(res, { action: 'view_points' });
    return;
  }

  // ---------- ดูของรางวัล (เดิม /api/rewards) ----------
  if (doParam === 'rewards') {
    redirectToLine(res, { action: 'view_rewards' });
    return;
  }

  // ---------- กดแลกของรางวัล (เดิม /api/redeem/[rewardId]) ----------
  if (doParam === 'redeem') {
    const rewardId = req.query.reward;
    if (!rewardId) {
      res.status(400).send('ไม่พบ reward');
      return;
    }
    redirectToLine(res, { action: 'redeem', rewardId });
    return;
  }

  // ---------- ยืนยันที่อยู่จัดส่ง (เดิม /api/redeem/confirm) ----------
  if (doParam === 'confirm') {
    if (req.method !== 'POST') {
      res.status(405).send('Method not allowed');
      return;
    }

    let body = '';
    for await (const chunk of req) body += chunk;
    const params = new URLSearchParams(body);

    const tokenData = verifyRedeemToken(params.get('token'));
    if (!tokenData) {
      res.status(400).send('ลิงก์หมดอายุหรือไม่ถูกต้อง กรุณากลับไปกดแลกของรางวัลใหม่อีกครั้ง');
      return;
    }

    const { memberId, rewardId } = tokenData;
    const recipientName = params.get('recipient_name');
    const recipientPhone = params.get('recipient_phone');
    const recipientAddress = params.get('recipient_address');

    if (!recipientName || !recipientPhone || !recipientAddress) {
      res.status(400).send('กรุณากรอกข้อมูลให้ครบ');
      return;
    }

    const { data: reward } = await supabase.from('rewards').select('id, name, points_cost').eq('id', rewardId).single();
    if (!reward) {
      res.status(404).send('ไม่พบของรางวัลนี้');
      return;
    }

    // เช็คแต้มอีกครั้ง เผื่อระหว่างกรอกฟอร์มมีการใช้แต้มที่อื่นไปแล้ว
    const spendableBalance = await getSpendableBalance(memberId);
    if (spendableBalance < reward.points_cost) {
      res.status(200).send('แต้มไม่พอแล้ว (อาจมีการใช้แต้มไปที่อื่นระหว่างที่กรอกฟอร์ม) กรุณาลองใหม่');
      return;
    }

    const redemptionCode = Math.floor(100000 + Math.random() * 900000).toString();

    const [{ error }] = await Promise.all([
      supabase.from('redemptions').insert({
        member_id: memberId,
        reward_id: reward.id,
        points_spent: reward.points_cost,
        redemption_code: redemptionCode,
        status: 'used',
        used_at: new Date().toISOString(),
        shipping_status: 'not_shipped',
        recipient_name: recipientName,
        recipient_phone: recipientPhone,
        recipient_address: recipientAddress,
      }),
      // เก็บที่อยู่นี้ไว้ในประวัติของสมาชิกด้วย เผื่อใช้ซ้ำครั้งหน้า
      supabase.from('member_addresses').insert({
        member_id: memberId,
        recipient_name: recipientName,
        recipient_phone: recipientPhone,
        recipient_address: recipientAddress,
      }),
    ]);

    if (error) {
      res.status(500).send('เกิดข้อผิดพลาด ลองใหม่อีกครั้ง');
      return;
    }

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.status(200).send(renderSuccessPage(reward, spendableBalance - reward.points_cost));
    return;
  }

  res.status(400).send('ไม่รู้จัก do parameter นี้');
}

function renderSuccessPage(reward, newBalance) {
  return `<!DOCTYPE html>
<html lang="th">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<link rel="stylesheet" href="/theme.css" />
<script src="/theme.js" defer></script>
<title>แลกสำเร็จ</title>
<style>
  body { font-family: sans-serif; background: #f7f8fa; margin: 0; padding: 24px; color: #1b1f27; text-align: center; }
  .card { background: white; border-radius: 16px; padding: 32px 24px; max-width: 420px; margin: 40px auto 0; box-shadow: 0 1px 4px rgba(0,0,0,0.08); }
  .hint { color: #6b7280; font-size: 14px; margin-top: 12px; }
</style>
</head>
<body>
  <div class="card">
    <p style="font-size:20px;">🎉</p>
    <p>แลก <strong>${reward.name}</strong> สำเร็จ</p>
    <p class="hint">ทีมงานจะจัดส่งของรางวัลไปตามที่อยู่ที่แจ้งไว้เร็วๆ นี้</p>
    <p class="hint">Point คงเหลือ: ${newBalance.toLocaleString()}</p>
  </div>
</body>
</html>`;
}
