// api/auth/callback.js
//
// LINE จะ redirect กลับมาที่นี่หลังคนกดยินยอมล็อกอิน ไม่ว่าจะมาจาก
// การสแกน QR, เช็คแต้ม, ดูของรางวัล, หรือกดแลกของรางวัล
// เช็คจาก state ว่ามาจากทางไหน แล้วทำหน้าที่ต่างกัน
//
// ระบบนี้แยก 2 อย่างออกจากกันชัดเจน:
//   - Tier Score: ได้จาก engagement (1 ครั้ง = 1 คะแนน) ใช้ตัดสิน Tier เท่านั้น ไม่ใช้แลกอะไร
//                 Tier ของปีนี้ทั้งปี ถูกล็อกจากยอด Tier Score ของ "ปีที่แล้วทั้งปี"
//   - Point: ได้จาก engagement เดียวกัน (1 ครั้ง = 5 แต้ม ปรับได้) ใช้แลก Reward
//            หมดอายุทุกสิ้นปี ถ้าไม่ใช้ (นับแค่ยอดที่ได้ในปีปฏิทินปัจจุบัน)
//   - ทั้งสองอย่างได้จาก 1 Campaign (creative) แค่ครั้งเดียวเท่านั้น ห้ามซ้ำ

import { createClient } from '@supabase/supabase-js';
import { getTier, getTierEvaluationPeriod, getCurrentYearStart } from '../../lib/tiers.js';
import { createRedeemToken } from '../../lib/memberToken.js';
import { getMemberPet, getPetInventory, getPetBadges, SPECIES_LIST } from '../../lib/petGame.js';
import { createMemberSessionCookie } from '../../lib/memberAuth.js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const TIER_SCORE_PER_ENGAGEMENT = 1; // ปรับได้ แต่ปกติไม่ควรแก้ (นิยาม 1 engagement = 1 คะแนน)
const REWARD_POINTS_PER_ENGAGEMENT = 5; // ปรับจำนวนแต้มต่อ engagement ได้ตรงนี้

// หา Tier Score ในช่วงเวลาที่ใช้ตัดสิน Tier (ปีที่แล้วทั้งปี หรือปีนี้ถ้าเป็นสมาชิกใหม่)
// นับทั้งจาก engagement (scan_qr) และรายการที่แอดมินปรับด้วยมือ (admin_adjust)
async function getTierScoreForEvaluation(memberId, createdAt) {
  const { start, end } = getTierEvaluationPeriod(createdAt);
  let query = supabase
    .from('points_ledger')
    .select('tier_score')
    .eq('member_id', memberId)
    .gte('created_at', start);
  if (end) query = query.lt('created_at', end);
  const { data } = await query;
  return (data || []).reduce((sum, row) => sum + row.tier_score, 0);
}

// หา Point คงเหลือที่ใช้แลกได้ (ได้ปีนี้ - ใช้ไปปีนี้) หมดอายุทุกสิ้นปี
// นับทั้งจาก engagement (scan_qr) และรายการที่แอดมินปรับด้วยมือ (admin_adjust)
async function getSpendableBalance(memberId) {
  const yearStart = getCurrentYearStart();
  const [earnedRes, spentRes] = await Promise.all([
    supabase
      .from('points_ledger')
      .select('reward_points')
      .eq('member_id', memberId)
      .gte('created_at', yearStart),
    supabase
      .from('redemptions')
      .select('points_spent')
      .eq('member_id', memberId)
      .gte('created_at', yearStart),
  ]);
  const earned = (earnedRes.data || []).reduce((sum, row) => sum + row.reward_points, 0);
  const spent = (spentRes.data || []).reduce((sum, row) => sum + row.points_spent, 0);
  return earned - spent;
}

export default async function handler(req, res) {
  const { code, state } = req.query;

  if (!code || !state) {
    res.status(400).send('ล็อกอินไม่สำเร็จ (ขาดข้อมูลจำเป็น)');
    return;
  }

  let parsedState;
  try {
    parsedState = JSON.parse(Buffer.from(state, 'base64url').toString());
  } catch {
    res.status(400).send('state ไม่ถูกต้อง');
    return;
  }

  // ขั้นที่ 1: เอา code ไปแลก token กับ LINE (เหมือนกันทุกทาง)
  const tokenRes = await fetch('https://api.line.me/oauth2/v2.1/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: process.env.LINE_CALLBACK_URL,
      client_id: process.env.LINE_CHANNEL_ID,
      client_secret: process.env.LINE_CHANNEL_SECRET,
    }),
  });

  if (!tokenRes.ok) {
    console.error('แลก token กับ LINE ไม่สำเร็จ:', await tokenRes.text());
    res.status(502).send('เชื่อมต่อ LINE ไม่สำเร็จ ลองใหม่อีกครั้ง');
    return;
  }

  const tokenData = await tokenRes.json();
  const payload = JSON.parse(
    Buffer.from(tokenData.id_token.split('.')[1], 'base64url').toString()
  );
  const lineUserId = payload.sub;
  const displayName = payload.name || null;
  const pictureUrl = payload.picture || null;

  // ขั้นที่ 2: หาสมาชิกเดิม หรือสร้างใหม่ถ้ายังไม่เคยเจอ
  let { data: member } = await supabase
    .from('members')
    .select('id, display_name, picture_url, created_at')
    .eq('line_user_id', lineUserId)
    .single();

  if (!member) {
    const { data: newMember, error: insertError } = await supabase
      .from('members')
      .insert({ line_user_id: lineUserId, display_name: displayName, picture_url: pictureUrl })
      .select('id, display_name, picture_url, created_at')
      .single();

    if (insertError) {
      console.error('สร้างสมาชิกไม่สำเร็จ:', insertError);
      res.status(500).send('เกิดข้อผิดพลาด ลองใหม่อีกครั้ง');
      return;
    }
    member = newMember;
  }

  // ทางที่ 1: มาจากลิงก์เช็คแต้ม
  if (parsedState.action === 'view_points') {
    const [tierScore, spendableBalance, historyRes] = await Promise.all([
      getTierScoreForEvaluation(member.id, member.created_at),
      getSpendableBalance(member.id),
      supabase
        .from('points_ledger')
        .select('reward_points, tier_score, creative_id, reason, created_at')
        .eq('member_id', member.id)
        .order('created_at', { ascending: false })
        .limit(20),
    ]);

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.status(200).send(renderPointsPage(member, historyRes.data || [], tierScore, spendableBalance));
    return;
  }

  // ทางที่ 2: มาจากลิงก์ดูของรางวัล
  if (parsedState.action === 'view_rewards') {
    const [tierScore, spendableBalance, rewardsRes] = await Promise.all([
      getTierScoreForEvaluation(member.id, member.created_at),
      getSpendableBalance(member.id),
      supabase.from('rewards').select('id, name, points_cost').eq('active', true).order('points_cost', { ascending: true }),
    ]);

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.status(200).send(renderRewardsPage(member, rewardsRes.data || [], tierScore, spendableBalance));
    return;
  }

  // ทางที่ 3: มาจากการกดแลกของรางวัล — เช็คแต้มพอไหม แล้วโชว์ฟอร์มกรอกที่อยู่จัดส่ง
  // (ยังไม่หักแต้ม/บันทึกอะไรตรงนี้ จะหักตอนกรอกฟอร์มเสร็จแล้วส่งไปที่ api/member-action.js?do=confirm)
  if (parsedState.action === 'redeem') {
    const { data: reward } = await supabase
      .from('rewards')
      .select('id, name, points_cost')
      .eq('id', parsedState.rewardId)
      .single();

    if (!reward) {
      res.status(404).send('ไม่พบของรางวัลนี้');
      return;
    }

    const spendableBalance = await getSpendableBalance(member.id);

    if (spendableBalance < reward.points_cost) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(200).send(renderErrorPage('แต้มไม่พอ', `ต้องใช้ ${reward.points_cost} แต้ม แต่คุณมี ${spendableBalance} แต้ม`));
      return;
    }

    const { data: savedAddresses } = await supabase
      .from('member_addresses')
      .select('recipient_name, recipient_phone, recipient_address')
      .eq('member_id', member.id)
      .order('created_at', { ascending: false })
      .limit(5);

    const token = createRedeemToken(member.id, reward.id);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.status(200).send(renderShippingForm(reward, member, token, savedAddresses || []));
    return;
  }

  // ทางที่ 3.5: มาจากลิงก์เกมเลี้ยงสัตว์ — ตั้ง Session Cookie ให้ด้วย เพื่อให้ปุ่มในเกมกดได้ไวๆ
  // ไม่ต้อง Redirect ผ่าน LINE ทุกครั้งเหมือน Flow แต้ม/ของรางวัลเดิม (เกมกดถี่กว่ามาก)
  if (parsedState.action === 'view_pet') {
    const pet = await getMemberPet(member.id);
    res.setHeader('Set-Cookie', createMemberSessionCookie(member.id));
    res.setHeader('Content-Type', 'text/html; charset=utf-8');

    if (!pet) {
      res.status(200).send(renderPetCreatePage(member));
      return;
    }

    const [inventory, badges, spendableBalance] = await Promise.all([
      getPetInventory(pet.id),
      getPetBadges(pet.id),
      getSpendableBalance(member.id),
    ]);
    res.status(200).send(renderPetDashboard(member, pet, inventory, badges, spendableBalance));
    return;
  }

  // ทางที่ 4 (ค่าเริ่มต้น): มาจากการสแกน QR — ให้ Tier Score + Point แล้ว redirect ไปโปรโมชั่นจริง
  const { creative, destination } = parsedState;
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  // Tier Score: เช็คว่าวันนี้เคยได้จาก campaign นี้ไปแล้วหรือยัง (ได้วันละ 1 ครั้งต่อ campaign)
  const { data: todayAward } = await supabase
    .from('points_ledger')
    .select('id')
    .eq('member_id', member.id)
    .eq('creative_id', creative)
    .eq('engagement_date', today)
    .maybeSingle();

  // Point: เช็คว่าเคยได้จาก campaign นี้ "ตลอดชีพ" ไปแล้วหรือยัง (ได้แค่ครั้งแรกครั้งเดียว ไม่นับรายวัน)
  const { data: everEarnedReward } = await supabase
    .from('points_ledger')
    .select('id')
    .eq('member_id', member.id)
    .eq('creative_id', creative)
    .gt('reward_points', 0)
    .maybeSingle();

  let alreadyClaimedToday = false;

  if (todayAward) {
    // วันนี้เคยสแกนอันนี้แล้ว ไม่ให้ Tier Score ซ้ำ (ไม่ต้อง insert อะไรเพิ่ม)
    alreadyClaimedToday = true;
  } else {
    const { error: ledgerError } = await supabase.from('points_ledger').insert({
      member_id: member.id,
      creative_id: creative,
      tier_score: TIER_SCORE_PER_ENGAGEMENT,
      reward_points: everEarnedReward ? 0 : REWARD_POINTS_PER_ENGAGEMENT, // Point ให้แค่ครั้งแรกสุดเท่านั้น
      reason: 'scan_qr',
      engagement_date: today,
    });
    if (ledgerError) {
      // เผื่อ race condition (สแกนพร้อมกัน 2 ครั้งในเสี้ยววินาที) — unique constraint กันซ้ำอีกชั้น
      alreadyClaimedToday = true;
    }
  }

  const spendableBalance = await getSpendableBalance(member.id);
  const finalUrl = new URL(destination);
  finalUrl.searchParams.set('points', spendableBalance);
  if (alreadyClaimedToday) finalUrl.searchParams.set('already_claimed', '1');
  res.writeHead(302, { Location: finalUrl.toString() });
  res.end();
}

function renderPointsPage(member, history, tierScore, spendableBalance) {
  const { current, next, pointsToNext } = getTier(tierScore);
  const rows = history
    .map((h) => {
      const isRedeem = h.reason !== 'scan_qr';
      return `
        <tr>
          <td>${new Date(h.created_at).toLocaleString('th-TH')}</td>
          <td>${h.creative_id || '-'}</td>
          <td style="text-align:right; color:${isRedeem ? '#9ca3af' : '#1baf7a'};">${isRedeem ? '-' : '+' + h.reward_points}</td>
        </tr>`;
    })
    .join('');

  return `<!DOCTYPE html>
<html lang="th">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<link rel="stylesheet" href="/theme.css" />
<script src="/theme.js" defer></script>
<title>แต้มของฉัน</title>
<style>
  body { font-family: sans-serif; background: #f7f8fa; margin: 0; padding: 24px; color: #1b1f27; }
  .card { background: white; border-radius: 16px; padding: 24px; max-width: 480px; margin: 0 auto; box-shadow: 0 1px 4px rgba(0,0,0,0.08); }
  .tier-badge { display: inline-block; color: white; font-size: 12px; font-weight: 700; padding: 4px 12px; border-radius: 999px; margin-top: 8px; letter-spacing: 0.5px; }
  .balance-row { display: flex; gap: 16px; margin: 16px 0; }
  .balance-box { flex: 1; background: #f7f8fa; border-radius: 10px; padding: 12px; }
  .balance-box .label { font-size: 12px; color: #6b7280; margin: 0 0 2px; }
  .balance-box .value { font-size: 24px; font-weight: 700; margin: 0; }
  table { width: 100%; border-collapse: collapse; margin-top: 16px; font-size: 14px; }
  th { text-align: left; color: #6b7280; font-weight: 500; padding: 6px 4px; border-bottom: 1px solid #e5e7eb; }
  td { padding: 8px 4px; border-bottom: 1px solid #f0f0f0; }
</style>
</head>
<body>
  <div class="card">
    <p style="color:#6b7280; margin:0;">${member.display_name ? member.display_name : 'สมาชิก'}</p>
    <span class="tier-badge" style="background:${current.color};">${current.name}</span>
    <div class="balance-row">
      <div class="balance-box">
        <p class="label">Point คงเหลือ (ใช้แลกได้)</p>
        <p class="value" style="color:#06c755;">${spendableBalance.toLocaleString()}</p>
      </div>
      <div class="balance-box">
        <p class="label">Tier Score</p>
        <p class="value">${tierScore.toLocaleString()}</p>
      </div>
    </div>
    ${
      next
        ? `<p style="color:#6b7280; font-size:13px;">อีก ${pointsToNext.toLocaleString()} Tier Score จะขึ้นระดับ ${next.name}</p>`
        : `<p style="color:#6b7280; font-size:13px;">คุณอยู่ระดับสูงสุดแล้ว</p>`
    }
    <p style="color:#9ca3af; font-size:12px;">Point จะหมดอายุทุกสิ้นปีถ้าไม่ใช้ ส่วน Tier ประเมินใหม่ทุกปีจากยอดปีที่แล้ว</p>
    <h3 style="margin-top:20px;">ประวัติล่าสุด</h3>
    <table>
      <tr><th>วันที่</th><th>ที่มา</th><th style="text-align:right;">Point</th></tr>
      ${rows || '<tr><td colspan="3" style="color:#6b7280;">ยังไม่มีประวัติ</td></tr>'}
    </table>
  </div>
</body>
</html>`;
}

function renderRewardsPage(member, rewards, tierScore, spendableBalance) {
  const { current } = getTier(tierScore);
  const items = rewards
    .map((r) => {
      const canAfford = spendableBalance >= r.points_cost;
      return `
        <div class="reward ${canAfford ? '' : 'disabled'}">
          <div>
            <div class="reward-name">${r.name}</div>
            <div class="reward-cost">${r.points_cost} Point</div>
          </div>
          ${
            canAfford
              ? `<a class="btn" href="/api/member-action?do=redeem&reward=${r.id}">แลกเลย</a>`
              : `<span class="btn btn-disabled">แต้มไม่พอ</span>`
          }
        </div>`;
    })
    .join('');

  return `<!DOCTYPE html>
<html lang="th">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<link rel="stylesheet" href="/theme.css" />
<script src="/theme.js" defer></script>
<title>ของรางวัล</title>
<style>
  body { font-family: sans-serif; background: #f7f8fa; margin: 0; padding: 24px; color: #1b1f27; }
  .card { background: white; border-radius: 16px; padding: 24px; max-width: 480px; margin: 0 auto; box-shadow: 0 1px 4px rgba(0,0,0,0.08); }
  .tier-badge { display: inline-block; color: white; font-size: 12px; font-weight: 700; padding: 4px 12px; border-radius: 999px; margin-top: 8px; letter-spacing: 0.5px; }
  .balance { font-size: 28px; font-weight: 700; color: #06c755; margin: 12px 0 20px; }
  .reward { display: flex; justify-content: space-between; align-items: center; padding: 14px 0; border-bottom: 1px solid #f0f0f0; }
  .reward.disabled { opacity: 0.5; }
  .reward-name { font-weight: 600; }
  .reward-cost { font-size: 13px; color: #6b7280; }
  .btn { background: #06c755; color: white; text-decoration: none; padding: 8px 16px; border-radius: 8px; font-size: 14px; }
  .btn-disabled { background: #e5e7eb; color: #9ca3af; padding: 8px 16px; border-radius: 8px; font-size: 14px; }
</style>
</head>
<body>
  <div class="card">
    <p style="color:#6b7280; margin:0;">Point ของฉัน</p>
    <span class="tier-badge" style="background:${current.color};">${current.name}</span>
    <p class="balance">${spendableBalance.toLocaleString()} Point</p>
    ${items || '<p style="color:#6b7280;">ยังไม่มีของรางวัลตอนนี้</p>'}
  </div>
</body>
</html>`;
}

function renderShippingForm(reward, member, token, savedAddresses) {
  const addressOptions = savedAddresses
    .map(
      (a, i) =>
        `<option value="${i}" data-name="${escapeAttr(a.recipient_name)}" data-phone="${escapeAttr(a.recipient_phone)}" data-address="${escapeAttr(a.recipient_address)}">${a.recipient_name} — ${a.recipient_address.slice(0, 30)}...</option>`
    )
    .join('');

  const savedAddressPicker = savedAddresses.length
    ? `
      <label>ใช้ที่อยู่ที่เคยกรอกไว้ (ไม่บังคับ)</label>
      <select id="savedAddress" onchange="fillAddress(this)">
        <option value="">-- กรอกที่อยู่ใหม่ --</option>
        ${addressOptions}
      </select>`
    : '';

  return `<!DOCTYPE html>
<html lang="th">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<link rel="stylesheet" href="/theme.css" />
<script src="/theme.js" defer></script>
<title>กรอกที่อยู่จัดส่ง</title>
<style>
  body { font-family: sans-serif; background: #f7f8fa; margin: 0; padding: 24px; color: #1b1f27; }
  .card { background: white; border-radius: 16px; padding: 24px; max-width: 420px; margin: 0 auto; box-shadow: 0 1px 4px rgba(0,0,0,0.08); }
  .reward-name { font-weight: 700; font-size: 18px; margin: 0 0 4px; }
  .reward-cost { color: #6b7280; font-size: 13px; margin: 0 0 20px; }
  label { display: block; font-size: 13px; color: #6b7280; margin: 14px 0 4px; }
  input, textarea, select { width: 100%; box-sizing: border-box; padding: 10px 12px; border: 1px solid #e5e7eb; border-radius: 8px; font-size: 14px; font-family: inherit; }
  textarea { resize: vertical; min-height: 70px; }
  button { width: 100%; background: #06c755; color: white; border: none; padding: 12px; border-radius: 8px; font-size: 14px; cursor: pointer; margin-top: 20px; }
</style>
</head>
<body>
  <div class="card">
    <p class="reward-name">${reward.name}</p>
    <p class="reward-cost">ใช้ ${reward.points_cost.toLocaleString()} Point</p>
    <p style="font-size:13px; color:#6b7280;">กรอกที่อยู่สำหรับจัดส่งของรางวัล — กดยืนยันแล้วแต้มจะถูกหักทันที</p>
    ${savedAddressPicker}
    <form method="POST" action="/api/member-action?do=confirm">
      <input type="hidden" name="token" value="${token}" />
      <label>ชื่อ-นามสกุลผู้รับ</label>
      <input type="text" id="fieldName" name="recipient_name" value="${member.display_name || ''}" required />
      <label>เบอร์โทรติดต่อ</label>
      <input type="tel" id="fieldPhone" name="recipient_phone" required placeholder="08xxxxxxxx" />
      <label>ที่อยู่จัดส่ง</label>
      <textarea id="fieldAddress" name="recipient_address" required placeholder="บ้านเลขที่ ถนน ตำบล/แขวง อำเภอ/เขต จังหวัด รหัสไปรษณีย์"></textarea>
      <button type="submit">ยืนยันการแลก</button>
    </form>
  </div>
  <script>
    function fillAddress(select) {
      const opt = select.options[select.selectedIndex];
      if (!opt.dataset.name) return;
      document.getElementById('fieldName').value = opt.dataset.name;
      document.getElementById('fieldPhone').value = opt.dataset.phone;
      document.getElementById('fieldAddress').value = opt.dataset.address;
    }
  </script>
</body>
</html>`;
}

function escapeAttr(str) {
  return (str || '').replace(/"/g, '&quot;');
}

function renderErrorPage(title, message) {
  return `<!DOCTYPE html>
<html lang="th">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<link rel="stylesheet" href="/theme.css" />
<script src="/theme.js" defer></script>
<title>${title}</title>
<style>
  body { font-family: sans-serif; background: #f7f8fa; margin: 0; padding: 24px; color: #1b1f27; text-align: center; }
  .card { background: white; border-radius: 16px; padding: 32px 24px; max-width: 420px; margin: 40px auto 0; box-shadow: 0 1px 4px rgba(0,0,0,0.08); }
</style>
</head>
<body>
  <div class="card">
    <p style="font-size:18px; font-weight:700;">${title}</p>
    <p style="color:#6b7280;">${message}</p>
  </div>
</body>
</html>`;
}

// ---------- ระบบเกมเลี้ยงสัตว์ ----------

const SPECIES_EMOJI = { cat: '🐱', dog: '🐶', bird: '🐦', monkey: '🐵' };
const LEVEL_COLOR = { 1: '#a7f3d0', 2: '#93c5fd', 3: '#c4b5fd', 4: '#fde68a' };

function renderPetCreatePage(member) {
  const options = SPECIES_LIST.map(
    (s) => `
      <label class="species-option">
        <input type="radio" name="species_id" value="${s.id}" required />
        <span class="species-emoji">${SPECIES_EMOJI[s.id]}</span>
        <span>${s.name}</span>
      </label>`
  ).join('');

  return `<!DOCTYPE html>
<html lang="th">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<link rel="stylesheet" href="/theme.css" />
<script src="/theme.js" defer></script>
<title>สร้างสัตว์เลี้ยงของฉัน</title>
<style>
  body { font-family: sans-serif; background: #f7f8fa; margin: 0; padding: 24px; color: #1b1f27; }
  .card { background: white; border-radius: 16px; padding: 24px; max-width: 420px; margin: 0 auto; box-shadow: 0 1px 4px rgba(0,0,0,0.08); }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .hint { color: #6b7280; font-size: 13px; margin: 0 0 20px; }
  .species-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 16px; }
  .species-option { border: 2px solid #e5e7eb; border-radius: 12px; padding: 16px; text-align: center; cursor: pointer; display: flex; flex-direction: column; align-items: center; gap: 6px; }
  .species-option:has(input:checked) { border-color: #ff5b2e; background: #fff1ec; }
  .species-option input { position: absolute; opacity: 0; }
  .species-emoji { font-size: 40px; }
  label.field { display: block; font-size: 13px; color: #6b7280; margin: 4px 0; }
  input[type="text"] { width: 100%; box-sizing: border-box; padding: 10px 12px; border: 1px solid #e5e7eb; border-radius: 8px; font-size: 14px; }
  button { width: 100%; background: #ff5b2e; color: white; border: none; padding: 12px; border-radius: 8px; font-size: 14px; cursor: pointer; margin-top: 16px; }
</style>
</head>
<body>
  <div class="card">
    <h1>สร้างสัตว์เลี้ยงตัวแรกของคุณ 🎉</h1>
    <p class="hint">เลี้ยงดูให้ดี ให้อาหาร เล่นด้วย จะโตขึ้นเรื่อยๆ</p>
    <form id="createForm">
      <div class="species-grid">${options}</div>
      <label class="field">ตั้งชื่อสัตว์เลี้ยง (ไม่บังคับ)</label>
      <input type="text" name="name" maxlength="20" placeholder="เช่น มะลิ" />
      <button type="submit">เริ่มเลี้ยงเลย</button>
    </form>
  </div>
  <script>
    document.getElementById('createForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const formData = new FormData(e.target);
      const res = await fetch('/api/member-action?do=pet_create', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(formData).toString(),
      });
      if (res.ok) {
        window.location.reload();
      } else {
        alert(await res.text());
      }
    });
  </script>
</body>
</html>`;
}

function renderPetDashboard(member, pet, inventory, badges, spendableBalance) {
  const config = { level2: 100, level3: 300, level4: 700 }; // แค่ใช้แสดงผล progress bar คร่าวๆ (ค่าจริงคำนวณฝั่งเซิร์ฟเวอร์)
  const thresholds = { 1: 0, 2: config.level2, 3: config.level3, 4: config.level4 };
  const nextThreshold = pet.isMaxLevel ? pet.exp : thresholds[pet.level + 1];
  const currentThreshold = thresholds[pet.level];
  const expProgress = pet.isMaxLevel ? 100 : Math.round(((pet.exp - currentThreshold) / (nextThreshold - currentThreshold)) * 100);

  const badgeChips = badges
    .map((b) => `<span class="badge-chip" title="${b.pet_badges?.description || ''}">🏅 ${b.pet_badges?.name_th}</span>`)
    .join('');

  const equippedItems = inventory.filter((i) => i.equipped);

  return `<!DOCTYPE html>
<html lang="th">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<link rel="stylesheet" href="/theme.css" />
<script src="/theme.js" defer></script>
<title>${pet.name || 'สัตว์เลี้ยงของฉัน'}</title>
<style>
  body { font-family: sans-serif; background: #f7f8fa; margin: 0; padding: 24px; color: #1b1f27; }
  .card { background: white; border-radius: 16px; padding: 24px; max-width: 420px; margin: 0 auto; box-shadow: 0 1px 4px rgba(0,0,0,0.08); }
  .pet-stage { text-align: center; padding: 24px; border-radius: 16px; margin-bottom: 16px; }
  .pet-emoji { font-size: 72px; }
  .pet-name { font-weight: 700; font-size: 18px; margin: 8px 0 2px; }
  .pet-level { font-size: 12px; color: #6b7280; }
  .bar-row { margin: 12px 0; }
  .bar-label { display: flex; justify-content: space-between; font-size: 12px; color: #6b7280; margin-bottom: 4px; }
  .bar-track { background: #f0f0f0; border-radius: 999px; height: 10px; overflow: hidden; }
  .bar-fill { height: 100%; border-radius: 999px; transition: width 0.3s; }
  .btn-row { display: flex; gap: 8px; margin-top: 16px; }
  .btn-row button { flex: 1; padding: 12px; border: none; border-radius: 10px; font-size: 14px; cursor: pointer; }
  .btn-feed { background: #06c755; color: white; }
  .btn-play { background: #ff5b2e; color: white; }
  .btn-row button:disabled { background: #e5e7eb; color: #9ca3af; cursor: not-allowed; }
  .status-msg { font-size: 13px; text-align: center; margin-top: 10px; min-height: 18px; }
  .hungry-warning { background: #fff1ec; color: #e76f51; padding: 10px; border-radius: 8px; font-size: 13px; text-align: center; margin-bottom: 12px; }
  .badge-chip { display: inline-block; background: #f7f8fa; border: 1px solid #e5e7eb; border-radius: 999px; padding: 4px 10px; font-size: 12px; margin: 4px 4px 0 0; }
  .link-row { text-align: center; margin-top: 16px; font-size: 13px; }
  .link-row a { color: #2a78d6; text-decoration: none; }
  .closet-section { border-top: 1px solid #f0f0f0; padding-top: 10px; }
  .closet-item { display: flex; justify-content: space-between; align-items: center; padding: 6px 0; font-size: 13px; }
  .equip-btn { background: #f7f8fa; border: 1px solid #e5e7eb; border-radius: 8px; padding: 6px 12px; font-size: 12px; cursor: pointer; }
  .equip-btn.equipped { background: #06c755; color: white; border-color: #06c755; }
</style>
</head>
<body>
  <div class="card">
    ${pet.isHungry ? `<div class="hungry-warning">🍖 ${pet.name || 'สัตว์เลี้ยง'}หิวแล้ว! รีบให้อาหารหน่อยนะ</div>` : ''}

    <div class="pet-stage" style="background:${LEVEL_COLOR[pet.level]};">
      <div class="pet-emoji">${SPECIES_EMOJI[pet.species_id]}</div>
      <div class="pet-name">${pet.name || pet.speciesName}</div>
      <div class="pet-level">${pet.levelName} ${pet.isMaxLevel ? '⭐' : ''}</div>
      ${equippedItems.length ? `<div style="margin-top:6px; font-size:12px;">${equippedItems.map((i) => i.pet_shop_items?.name).join(', ')}</div>` : ''}
    </div>

    <div class="bar-row">
      <div class="bar-label"><span>ความอิ่ม</span><span>${pet.hunger}%</span></div>
      <div class="bar-track"><div class="bar-fill" style="width:${pet.hunger}%; background:#06c755;"></div></div>
    </div>
    <div class="bar-row">
      <div class="bar-label"><span>ความสุข</span><span>${pet.happiness}%</span></div>
      <div class="bar-track"><div class="bar-fill" style="width:${pet.happiness}%; background:#ff5b2e;"></div></div>
    </div>
    <div class="bar-row">
      <div class="bar-label"><span>EXP (${pet.levelName})</span><span>${pet.isMaxLevel ? 'สูงสุดแล้ว' : expProgress + '%'}</span></div>
      <div class="bar-track"><div class="bar-fill" style="width:${pet.isMaxLevel ? 100 : expProgress}%; background:#2a78d6;"></div></div>
    </div>

    <div class="btn-row">
      <button id="feedBtn" class="btn-feed">🍚 ให้อาหาร</button>
      <button id="playBtn" class="btn-play">🎾 เล่นด้วย</button>
    </div>
    <p id="statusMsg" class="status-msg"></p>

    ${badgeChips ? `<div style="margin-top:12px;">${badgeChips}</div>` : ''}

    ${
      inventory.length
        ? `<div class="closet-section">
            <h3 style="font-size:14px; margin:16px 0 8px;">🎀 ตู้เสื้อผ้า</h3>
            ${inventory
              .map(
                (i) => `
              <div class="closet-item">
                <span>${i.pet_shop_items?.name || '-'}</span>
                <button class="equip-btn ${i.equipped ? 'equipped' : ''}" data-inventory="${i.id}" data-equipped="${i.equipped}">
                  ${i.equipped ? 'ถอด' : 'สวมใส่'}
                </button>
              </div>`
              )
              .join('')}
          </div>`
        : ''
    }

    <div class="link-row">
      <a href="/api/member-action?do=pet_shop">🛒 ร้านค้า (Point: ${spendableBalance.toLocaleString()})</a>
    </div>
  </div>

  <script>
    const feedBtn = document.getElementById('feedBtn');
    const playBtn = document.getElementById('playBtn');
    const statusMsg = document.getElementById('statusMsg');

    async function doAction(action, btn) {
      btn.disabled = true;
      statusMsg.textContent = 'กำลังทำรายการ...';
      try {
        const res = await fetch('/api/member-action?do=' + action, { method: 'POST', credentials: 'same-origin' });
        const data = await res.json();
        if (!res.ok) {
          statusMsg.textContent = data.error || 'เกิดข้อผิดพลาด';
          btn.disabled = false;
          return;
        }
        statusMsg.textContent = 'ได้ EXP +' + data.expGained + ' 🎉';
        setTimeout(() => window.location.reload(), 800);
      } catch (err) {
        statusMsg.textContent = 'เกิดข้อผิดพลาด: ' + err.message;
        btn.disabled = false;
      }
    }

    feedBtn.addEventListener('click', () => doAction('pet_feed', feedBtn));
    playBtn.addEventListener('click', () => doAction('pet_play', playBtn));

    document.querySelectorAll('.equip-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        const currentlyEquipped = btn.dataset.equipped === 'true';
        await fetch('/api/member-action?do=pet_equip', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ inventory_id: btn.dataset.inventory, equipped: String(!currentlyEquipped) }).toString(),
        });
        window.location.reload();
      });
    });
  </script>
</body>
</html>`;
}
