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
import { createPet, playWithPet, buyItem, useInventoryItem, toggleEquip, getMemberPet, getPetBag, getPetCloset, getShopItems, getPetBadges } from '../lib/petGame.js';
import { getMemberFromSession } from '../lib/memberAuth.js';
import { sendPushNotification } from '../lib/webpush.js';
import { sendAlertEmail } from '../lib/alerts.js';

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

  // ---------- เข้าเกมเลี้ยงสัตว์ (ครั้งแรกต้องผ่าน LINE เพื่อยืนยันตัวตน จะได้ Session Cookie ติดมาด้วย) ----------
  if (doParam === 'pet') {
    redirectToLine(res, { action: 'view_pet' });
    return;
  }

  // ---------- Action ในเกม (ใช้ Session Cookie ไม่ต้องผ่าน LINE ซ้ำทุกครั้ง — กดถี่ได้ลื่นๆ) ----------
  if (['pet_create', 'pet_play', 'pet_shop', 'pet_use_item', 'pet_buy_item', 'pet_equip', 'push_subscribe'].includes(doParam)) {
    const memberId = getMemberFromSession(req);
    if (!memberId) {
      res.status(401).send('Session หมดอายุ กรุณาเข้าหน้าสัตว์เลี้ยงใหม่อีกครั้ง');
      return;
    }

    if (doParam === 'pet_create') {
      if (req.method !== 'POST') {
        res.status(405).send('Method not allowed');
        return;
      }
      let body = '';
      for await (const chunk of req) body += chunk;
      const params = new URLSearchParams(body);
      try {
        await createPet(memberId, params.get('species_id'), params.get('name'));
        res.status(200).send('ok');
      } catch (err) {
        res.status(400).send(err.message);
      }
      return;
    }

    if (doParam === 'pet_play') {
      if (req.method !== 'POST') {
        res.status(405).send('Method not allowed');
        return;
      }
      try {
        const result = await playWithPet(memberId);
        res.setHeader('Content-Type', 'application/json');
        res.status(200).json(result);
      } catch (err) {
        res.status(400).json({ error: err.message });
      }
      return;
    }

    // ---------- ใช้ไอเทมจากกระเป๋า (อาหาร/ขนม) — วิธีเดียวที่ให้อาหารสัตว์เลี้ยงได้ ----------
    if (doParam === 'pet_use_item') {
      if (req.method !== 'POST') {
        res.status(405).send('Method not allowed');
        return;
      }
      let body = '';
      for await (const chunk of req) body += chunk;
      const params = new URLSearchParams(body);
      try {
        const result = await useInventoryItem(memberId, params.get('inventory_id'));
        res.setHeader('Content-Type', 'application/json');
        res.status(200).json(result);
      } catch (err) {
        res.status(400).json({ error: err.message });
      }
      return;
    }

    // ---------- ซื้อไอเทม (ทุกประเภท) — เข้ากระเป๋า/ตู้เสื้อผ้าเสมอ ไม่ได้ใช้ทันที ----------
    if (doParam === 'pet_buy_item') {
      if (req.method !== 'POST') {
        res.status(405).send('Method not allowed');
        return;
      }
      let body = '';
      for await (const chunk of req) body += chunk;
      const params = new URLSearchParams(body);
      try {
        await buyItem(memberId, params.get('item_id'));
        res.status(200).send('ok');
      } catch (err) {
        res.status(400).send(err.message);
      }
      return;
    }

    if (doParam === 'pet_equip') {
      if (req.method !== 'POST') {
        res.status(405).send('Method not allowed');
        return;
      }
      let body = '';
      for await (const chunk of req) body += chunk;
      const params = new URLSearchParams(body);
      try {
        await toggleEquip(memberId, params.get('inventory_id'), params.get('equipped') === 'true');
        res.status(200).send('ok');
      } catch (err) {
        res.status(400).send(err.message);
      }
      return;
    }

    if (doParam === 'push_subscribe') {
      if (req.method !== 'POST') {
        res.status(405).send('Method not allowed');
        return;
      }
      let body = '';
      for await (const chunk of req) body += chunk;
      const sub = JSON.parse(body);
      const { error } = await supabase.from('push_subscriptions').upsert(
        {
          member_id: memberId,
          endpoint: sub.endpoint,
          p256dh: sub.keys.p256dh,
          auth: sub.keys.auth,
        },
        { onConflict: 'endpoint' }
      );
      if (error) {
        res.status(400).json({ error: error.message });
        return;
      }
      res.status(200).send('ok');
      return;
    }

    if (doParam === 'pet_shop') {
      const pet = await getMemberPet(memberId);
      if (!pet) {
        res.status(302).setHeader('Location', '/api/member-action?do=pet');
        res.end();
        return;
      }
      const [foodItems, treatItems, supplementItems, accessoryItems] = await Promise.all([
        getShopItems('food'),
        getShopItems('treat'),
        getShopItems('supplement'),
        getShopItems('accessory'),
      ]);
      const closet = await getPetCloset(pet.id);
      const ownedAccessoryIds = new Set(closet.map((i) => i.shop_item_id));
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(200).send(renderPetShopPage({ foodItems, treatItems, supplementItems, accessoryItems, ownedAccessoryIds }));
      return;
    }
  }

  // ---------- Cron: เช็คสัตว์เลี้ยงที่หิว ส่ง Push Notification (Vercel เรียกอัตโนมัติทุกชั่วโมง) ----------
  // ป้องกันด้วย CRON_SECRET ที่ Vercel แนบมาอัตโนมัติเมื่อตั้งค่า Environment Variable ชื่อนี้ไว้
  if (doParam === 'cron_hunger_check') {
    const authHeader = req.headers.authorization || '';
    if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
      res.status(401).send('unauthorized');
      return;
    }

    try {
      const { data: config } = await supabase.from('pet_game_config').select('key, value').eq('key', 'hunger_notify_threshold');
      const threshold = Number(config?.[0]?.value || 30);
      const cooldownMs = 6 * 60 * 60 * 1000; // แจ้งซ้ำได้ไม่เกินทุก 6 ชั่วโมง กันสแปม

      const { data: hungryPets } = await supabase
        .from('member_pets')
        .select('id, member_id, hunger, name, last_hunger_notified_at')
        .lt('hunger', threshold);

      let sentCount = 0;
      for (const pet of hungryPets || []) {
        const lastNotified = pet.last_hunger_notified_at ? new Date(pet.last_hunger_notified_at).getTime() : 0;
        if (Date.now() - lastNotified < cooldownMs) continue;

        const { data: subs } = await supabase.from('push_subscriptions').select('*').eq('member_id', pet.member_id);
        for (const sub of subs || []) {
          try {
            await sendPushNotification(sub, {
              title: `${pet.name || 'สัตว์เลี้ยง'}หิวแล้ว! 🍖`,
              body: 'กลับมาให้อาหารกันเถอะ',
              url: '/api/member-action?do=pet',
            });
            sentCount++;
          } catch (err) {
            // subscription หมดอายุ/ถูกยกเลิกจากฝั่งเบราว์เซอร์ — ลบทิ้งกันค้าง (ไม่ใช่ปัญหาของระบบเรา ไม่ต้องแจ้งเตือน)
            if (err.statusCode === 410 || err.statusCode === 404) {
              await supabase.from('push_subscriptions').delete().eq('id', sub.id);
            }
          }
        }
        await supabase.from('member_pets').update({ last_hunger_notified_at: new Date().toISOString() }).eq('id', pet.id);
      }

      res.status(200).json({ checked: (hungryPets || []).length, sent: sentCount });
    } catch (err) {
      // Cron Job ทั้งตัวพัง (ไม่ใช่แค่ Push รายตัว) — จุดนี้ต้องแจ้งเตือนทันที เพราะถ้าไม่แจ้งจะไม่มีใครรู้เลยว่าระบบหยุดเช็คความหิวไปแล้ว
      console.error('❌ cron_hunger_check พังทั้งยวง:', err);
      await sendAlertEmail('Cron Job เช็คความหิวสัตว์เลี้ยงล้มเหลว', err.stack || err.message);
      res.status(500).json({ error: 'cron failed', message: err.message });
    }
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

const ACCESSORY_SLOT_LABEL = { bow: '🎀 โบว์', hat: '🎩 หมวก', glasses: '👓 แว่นตา', mouth: '👄 เครื่องปาก', shoes: '👟 รองเท้า' };

function renderPetShopPage({ foodItems, treatItems, supplementItems, accessoryItems, ownedAccessoryIds }) {
  const renderItemCard = (item, isOwned) => `
    <div class="shop-item">
      <div>
        <div class="item-name">${item.name}</div>
        <div class="item-cost">${item.points_cost.toLocaleString()} Point</div>
        ${item.description ? `<div class="item-desc">${item.description}</div>` : ''}
      </div>
      ${
        isOwned
          ? `<span class="btn btn-owned">มีแล้ว</span>`
          : `<button class="btn buy-btn" data-item="${item.id}">ซื้อ</button>`
      }
    </div>`;

  const foodTreatItems = [...foodItems, ...treatItems];
  const foodHtml = foodTreatItems.map((i) => renderItemCard(i, false)).join('') || '<p class="muted">ยังไม่มีอาหาร/ขนมในร้าน</p>';

  // จัดกลุ่มเครื่องแต่งกายตาม Slot (โบว์/หมวก/แว่นตา/เครื่องปาก/รองเท้า)
  const bySlot = {};
  for (const item of accessoryItems) {
    const slot = item.accessory_slot || 'อื่นๆ';
    if (!bySlot[slot]) bySlot[slot] = [];
    bySlot[slot].push(item);
  }
  const accessoryHtml =
    Object.keys(bySlot)
      .map(
        (slot) => `
        <h3 style="font-size:13px; color:#6b7280; margin:16px 0 4px;">${ACCESSORY_SLOT_LABEL[slot] || slot}</h3>
        ${bySlot[slot].map((i) => renderItemCard(i, ownedAccessoryIds.has(i.id))).join('')}`
      )
      .join('') || '<p class="muted">ยังไม่มีเครื่องแต่งกายในร้าน</p>';

  return `<!DOCTYPE html>
<html lang="th">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<link rel="stylesheet" href="/theme.css" />
<script src="/theme.js" defer></script>
<title>ร้านค้าสัตว์เลี้ยง</title>
<style>
  body { font-family: sans-serif; background: #f7f8fa; margin: 0; padding: 24px; color: #1b1f27; }
  .card { background: white; border-radius: 16px; padding: 24px; max-width: 480px; margin: 0 auto 16px; box-shadow: 0 1px 4px rgba(0,0,0,0.08); }
  h2 { font-size: 15px; margin: 0 0 10px; }
  .shop-item { display: flex; justify-content: space-between; align-items: center; padding: 10px 0; border-bottom: 1px solid #f0f0f0; }
  .item-name { font-weight: 600; font-size: 14px; }
  .item-cost { font-size: 12px; color: #6b7280; }
  .item-desc { font-size: 12px; color: #9ca3af; margin-top: 2px; }
  .btn { background: #ff5b2e; color: white; border: none; padding: 8px 14px; border-radius: 8px; font-size: 13px; cursor: pointer; }
  .btn-owned { background: #e5e7eb; color: #9ca3af; padding: 8px 14px; border-radius: 8px; font-size: 13px; }
  .muted { color: #9ca3af; font-size: 13px; }
  .back-link { text-align: center; display: block; margin-top: 8px; color: #2a78d6; text-decoration: none; font-size: 13px; }
</style>
</head>
<body>
  <div class="card">
    <h2>🍚 อาหาร</h2>
    <p class="hint" style="margin-top:-6px;">ซื้อแล้วเข้ากระเป๋า ไปเลือกให้ที่หน้าสัตว์เลี้ยงได้เลย</p>
    ${foodHtml}
  </div>
  <div class="card">
    <h2>💪 อาหารเสริม</h2>
    <p class="muted">เร็วๆ นี้ — ใช้เพิ่มพลังโจมตีตอนมีระบบต่อสู้</p>
  </div>
  <div class="card">
    <h2>🎀 เครื่องแต่งกาย</h2>
    <p class="hint" style="margin-top:-6px;">สวมได้ทีละ 1 ชิ้นต่อประเภท เลือกสวมได้ที่ตู้เสื้อผ้าในหน้าสัตว์เลี้ยง</p>
    ${accessoryHtml}
  </div>
  <a href="/api/member-action?do=pet" class="back-link">&larr; กลับไปหน้าสัตว์เลี้ยง</a>

  <script>
    document.querySelectorAll('.buy-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        btn.textContent = 'กำลังทำรายการ...';
        const itemId = btn.dataset.item;
        const res = await fetch('/api/member-action?do=pet_buy_item', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ item_id: itemId }).toString(),
        });
        if (res.ok) {
          window.location.reload();
        } else {
          const msg = res.headers.get('content-type')?.includes('json') ? (await res.json()).error : await res.text();
          alert(msg || 'เกิดข้อผิดพลาด');
          btn.disabled = false;
          btn.textContent = 'ซื้อ';
        }
      });
    });
  </script>
</body>
</html>`;
}
