// api/admin/[page].js
//
// หน้า Admin รวมทุกฟังก์ชันไว้ที่เดียว สลับด้วยแท็บเมนู:
//   /api/admin/dashboard  — สรุปยอด + กราฟเทียบ Campaign + filter ดูตาม Campaign
//   /api/admin/members    — รายชื่อสมาชิก + filter ตาม Tier + ดูรายละเอียดรายคน (ประวัติ engagement/redemption)
//   /api/admin/rewards    — จัดการของรางวัล (เพิ่ม/แก้/เปิดปิด/ลบ)
//   /api/admin/campaigns  — จัดการ Campaign (เพิ่ม/แก้/เปิดปิด/ลบ)
//   /api/admin/admins     — จัดการบัญชีแอดมิน (super_admin เท่านั้น)
//
// ต้อง login ก่อนถึงจะเข้าได้ สิทธิ์แต่ละปุ่มเช็คตาม role (lib/adminAuth.js)

import { supabase } from '../../lib/supabaseClient.js';
import { getTier, TIERS, getTierEvaluationPeriod, getCurrentYearStart } from '../../lib/tiers.js';
import { requireAdmin, can } from '../../lib/adminAuth.js';
import { listOfficeAccounts, getOfficeAccount, getSlots, renderOfficeAreaContent } from '../../lib/officeArea.js';
import { getSignedContentUrl, getSignedSlipUrl, getPendingBookings, searchSponsors, getSponsorById, getSponsorContent, getSponsorCreditBalance, getPreviouslyApprovedContent, getAiringStatus, AIRING_STATUS_LABEL, getOfficeSlotCategories, BUSINESS_TYPE_LABEL } from '../../lib/sponsorArea.js';
import { getAdminChatThreads } from '../../lib/chat.js';

const PAGES = ['dashboard', 'members', 'rewards', 'campaigns', 'admins', 'office', 'account', 'sponsors', 'chat', 'pet-shop'];

export default async function handler(req, res) {
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  let page = PAGES.includes(req.query.page) ? req.query.page : 'dashboard';
  if (page === 'admins' && !can(admin.role, 'manage_admins') && !can(admin.role, 'manage_staff')) page = 'dashboard'; // กันเข้าตรงๆ ผ่าน URL

  let content = '';
  if (page === 'dashboard') {
    const campaignsParam = req.query.campaigns;
    const filterCampaigns = campaignsParam ? (Array.isArray(campaignsParam) ? campaignsParam : [campaignsParam]) : [];
    content = await renderDashboardTab(filterCampaigns);
  }
  if (page === 'members') content = await renderMembersTab(admin, req.query.tier || null, req.query.detail || null);
  if (page === 'rewards') content = await renderRewardsTab(admin);
  if (page === 'campaigns') content = await renderCampaignsTab(admin, req);
  if (page === 'admins') content = await renderAdminsTab(admin);
  if (page === 'office') content = await renderOfficeTab(admin, req.query.office_id || null);
  if (page === 'account') content = renderAccountTab(admin);
  if (page === 'sponsors') content = await renderSponsorsTab(admin, req.query);
  if (page === 'chat') content = await renderChatTab(admin, req.query);
  if (page === 'pet-shop') content = await renderPetShopAdminTab(admin, req.query);

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.status(200).send(renderLayout(page, admin, content));
}

// ---------- Dashboard tab ----------
async function renderDashboardTab(filterCampaigns) {
  const [scanLogsRes, membersRes, redemptionsRes, creativesRes] = await Promise.all([
    supabase.from('scan_logs').select('creative_id, scanned_at'),
    supabase.from('members').select('id'),
    supabase
      .from('redemptions')
      .select('id, redemption_code, points_spent, status, shipping_status, created_at, recipient_name, recipient_phone, recipient_address, rewards(name), members(display_name, line_user_id)')
      .order('created_at', { ascending: false })
      .limit(50),
    supabase.from('creatives').select('creative_id').order('creative_id'),
  ]);

  const scanLogs = scanLogsRes.data || [];
  const totalMembers = (membersRes.data || []).length;
  const redemptions = redemptionsRes.data || [];
  const creativeIds = (creativesRes.data || []).map((c) => c.creative_id);

  // ขอบเขตช่วงเวลา: วันนี้ (เที่ยงคืน), สัปดาห์นี้ (จันทร์), เดือนนี้ (วันที่ 1)
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dayOfWeek = (now.getDay() + 6) % 7; // จันทร์ = 0
  const weekStart = new Date(todayStart);
  weekStart.setDate(todayStart.getDate() - dayOfWeek);
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  // สรุปยอดสแกนแยกตาม creative x ช่วงเวลา (วันนี้/สัปดาห์นี้/เดือนนี้/ทั้งหมด — เป็นยอดสะสม ไม่ใช่แยกกันเป๊ะๆ)
  const statsByCreative = {};
  for (const id of creativeIds) statsByCreative[id] = { today: 0, week: 0, month: 0, all: 0 };
  for (const row of scanLogs) {
    if (!statsByCreative[row.creative_id]) statsByCreative[row.creative_id] = { today: 0, week: 0, month: 0, all: 0 };
    const s = statsByCreative[row.creative_id];
    const scannedAt = new Date(row.scanned_at);
    s.all++;
    if (scannedAt >= monthStart) s.month++;
    if (scannedAt >= weekStart) s.week++;
    if (scannedAt >= todayStart) s.today++;
  }
  const scansToday = Object.values(statsByCreative).reduce((sum, s) => sum + s.today, 0);

  const scansByCreative = {};
  for (const row of scanLogs) scansByCreative[row.creative_id] = (scansByCreative[row.creative_id] || 0) + 1;

  const notShippedCount = redemptions.filter((r) => r.status === 'used' && r.shipping_status === 'not_shipped').length;

  const chartLabels = Object.keys(scansByCreative);
  const chartValues = Object.values(scansByCreative);

  // ---------- ส่วนเปรียบเทียบหลาย Campaign พร้อมกัน (เลือกได้จาก checkbox) ----------
  const selected = filterCampaigns.filter((id) => creativeIds.includes(id));
  let comparisonHtml = '';
  let trendChartScript = '';

  if (selected.length > 0) {
    // ยอดพีค: วันไหนสแกนเยอะสุดของแต่ละ Campaign ที่เลือก
    const dailyCountByCreative = {}; // { creative_id: { 'YYYY-MM-DD': count } }
    for (const row of scanLogs) {
      if (!selected.includes(row.creative_id)) continue;
      const dateKey = new Date(row.scanned_at).toLocaleDateString('sv-SE'); // YYYY-MM-DD
      if (!dailyCountByCreative[row.creative_id]) dailyCountByCreative[row.creative_id] = {};
      dailyCountByCreative[row.creative_id][dateKey] = (dailyCountByCreative[row.creative_id][dateKey] || 0) + 1;
    }

    const peakRows = selected
      .map((id) => {
        const days = dailyCountByCreative[id] || {};
        let peakDate = '-';
        let peakCount = 0;
        for (const [date, count] of Object.entries(days)) {
          if (count > peakCount) {
            peakCount = count;
            peakDate = date;
          }
        }
        const total = scansByCreative[id] || 0;
        return `
          <tr>
            <td>${id}</td>
            <td style="text-align:right; font-weight:700;">${total.toLocaleString()}</td>
            <td style="text-align:right;">${peakCount.toLocaleString()}</td>
            <td>${peakDate !== '-' ? new Date(peakDate).toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: 'numeric' }) : '-'}</td>
          </tr>`;
      })
      .join('');

    // แนวโน้มรายสัปดาห์ ย้อนหลัง 8 สัปดาห์ (นับจากสัปดาห์นี้ถอยไป)
    const WEEKS_TO_SHOW = 8;
    const weekBuckets = [];
    for (let i = WEEKS_TO_SHOW - 1; i >= 0; i--) {
      const start = new Date(weekStart);
      start.setDate(weekStart.getDate() - i * 7);
      weekBuckets.push(start);
    }
    const weekLabels = weekBuckets.map((d) => d.toLocaleDateString('th-TH', { day: 'numeric', month: 'short' }));

    const weeklySeriesByCreative = {};
    for (const id of selected) weeklySeriesByCreative[id] = new Array(WEEKS_TO_SHOW).fill(0);
    for (const row of scanLogs) {
      if (!selected.includes(row.creative_id)) continue;
      const scannedAt = new Date(row.scanned_at);
      for (let i = 0; i < WEEKS_TO_SHOW; i++) {
        const bucketStart = weekBuckets[i];
        const bucketEnd = new Date(bucketStart);
        bucketEnd.setDate(bucketStart.getDate() + 7);
        if (scannedAt >= bucketStart && scannedAt < bucketEnd) {
          weeklySeriesByCreative[row.creative_id][i]++;
          break;
        }
      }
    }

    const palette = ['#2a78d6', '#e76f51', '#06c755', '#d4a017', '#8b5cf6', '#0891b2', '#db2777', '#65a30d'];
    const trendDatasets = selected.map((id, i) => ({
      label: id,
      data: weeklySeriesByCreative[id],
      borderColor: palette[i % palette.length],
      backgroundColor: palette[i % palette.length] + '22',
      tension: 0.3,
      fill: false,
    }));

    comparisonHtml = `
      <div class="section">
        <h2>เปรียบเทียบ ${selected.length} Campaign ที่เลือก</h2>
        <table>
          <tr><th>Campaign</th><th style="text-align:right;">สแกนทั้งหมด</th><th style="text-align:right;">ยอดสูงสุดใน 1 วัน</th><th>วันที่ทำยอดสูงสุด</th></tr>
          ${peakRows}
        </table>
      </div>
      <div class="section">
        <h2>แนวโน้มรายสัปดาห์ (ย้อนหลัง ${WEEKS_TO_SHOW} สัปดาห์)</h2>
        <div style="position:relative; height:280px;"><canvas id="trendChart"></canvas></div>
      </div>`;

    trendChartScript = `
      new Chart(document.getElementById('trendChart'), {
        type: 'line',
        data: { labels: ${JSON.stringify(weekLabels)}, datasets: ${JSON.stringify(trendDatasets)} },
        options: { responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false } }
      });`;
  }

  const campaignCheckboxes = creativeIds
    .map(
      (id) =>
        `<label style="display:inline-flex; align-items:center; gap:4px; margin:4px 12px 4px 0; font-size:13px;">
          <input type="checkbox" name="campaigns" value="${id}" ${selected.includes(id) ? 'checked' : ''} /> ${id}
        </label>`
    )
    .join('');

  const periodRows = Object.entries(statsByCreative)
    .sort((a, b) => b[1].all - a[1].all)
    .map(
      ([id, s]) => `
        <tr>
          <td>${id}</td>
          <td style="text-align:right;">${s.today.toLocaleString()}</td>
          <td style="text-align:right;">${s.week.toLocaleString()}</td>
          <td style="text-align:right;">${s.month.toLocaleString()}</td>
          <td style="text-align:right; font-weight:700;">${s.all.toLocaleString()}</td>
        </tr>`
    )
    .join('');

  const redemptionRows = redemptions
    .map((r) => {
      const isPending = r.status === 'pending';
      const shippingInfo = r.recipient_name
        ? `<div>${r.recipient_name}</div><div class="hint">${r.recipient_phone || ''}</div><div class="hint">${r.recipient_address || ''}</div>`
        : '<span class="muted">-</span>';
      const shipToggle =
        r.status === 'used'
          ? `<form method="POST" action="/api/admin/action?action=redemption_ship_status" style="display:inline;">
               <input type="hidden" name="redemption_id" value="${r.id}" />
               <select name="shipping_status" class="table-input" style="width:auto; display:inline-block;" onchange="this.form.submit()">
                 <option value="not_shipped" ${r.shipping_status !== 'shipped' ? 'selected' : ''}>ยังไม่จัดส่ง</option>
                 <option value="shipped" ${r.shipping_status === 'shipped' ? 'selected' : ''}>จัดส่งแล้ว</option>
               </select>
             </form>`
          : '-';
      return `
        <tr>
          <td>${new Date(r.created_at).toLocaleString('th-TH')}</td>
          <td>${r.members?.display_name || r.members?.line_user_id || '-'}</td>
          <td>${r.rewards?.name || '-'}</td>
          <td style="text-align:right;">${r.points_spent}</td>
          <td style="max-width:200px;">${shippingInfo}</td>
          <td style="text-align:center;">
            ${
              isPending
                ? `<form method="POST" action="/api/admin/action?action=mark_used" style="display:inline;">
                     <input type="hidden" name="code" value="${r.redemption_code}" />
                     <button class="btn-small">ยืนยันใช้แล้ว</button>
                   </form>`
                : shipToggle
            }
          </td>
        </tr>`;
    })
    .join('');

  return `
    <div class="grid">
      <div class="card"><p class="label">สแกนทั้งหมด</p><p class="value">${scanLogs.length.toLocaleString()}</p></div>
      <div class="card"><p class="label">สแกนวันนี้</p><p class="value">${scansToday.toLocaleString()}</p></div>
      <div class="card"><p class="label">สมาชิกทั้งหมด</p><p class="value">${totalMembers.toLocaleString()}</p></div>
      <div class="card"><p class="label">รอจัดส่ง</p><p class="value" style="color:${notShippedCount > 0 ? '#e76f51' : '#1b1f27'};">${notShippedCount}</p></div>
    </div>

    <div class="section">
      <h2>เปรียบเทียบยอดสแกนแยกตาม Campaign</h2>
      <a href="/api/admin/action?action=export_scans" class="btn-small" style="display:inline-block; margin-bottom:8px;">📥 Export สแกนทั้งหมด (CSV)</a>
      <div style="position:relative; height:260px;"><canvas id="scanChart"></canvas></div>
    </div>

    <div class="section">
      <h2>เลือก Campaign เพื่อเปรียบเทียบ (เลือกได้หลายอัน)</h2>
      <p class="hint">เหมาะสำหรับเทียบหลายสาขา/สถานที่ของแบรนด์เดียวกัน</p>
      <form method="GET" action="/api/admin/dashboard">
        <div>${campaignCheckboxes || '<span class="muted">ยังไม่มี Campaign</span>'}</div>
        <button class="btn-small" type="submit" style="margin-top:12px;">เปรียบเทียบ</button>
        ${selected.length ? '<a href="/api/admin/dashboard" class="clear-filter">ล้างการเลือก</a>' : ''}
      </form>
    </div>

    ${comparisonHtml}

    <div class="section">
      <h2>ยอดสแกนแยกตาม Campaign — วันนี้ / สัปดาห์นี้ / เดือนนี้ / ทั้งหมด</h2>
      <table>
        <tr><th>Campaign</th><th style="text-align:right;">วันนี้</th><th style="text-align:right;">สัปดาห์นี้</th><th style="text-align:right;">เดือนนี้</th><th style="text-align:right;">ทั้งหมด</th></tr>
        ${periodRows || '<tr><td colspan="5" class="muted">ยังไม่มีข้อมูล</td></tr>'}
      </table>
    </div>

    <div class="section">
      <h2>ประวัติการแลกของรางวัล / สถานะจัดส่ง (50 รายการล่าสุด)</h2>
      <a href="/api/admin/action?action=export_redemptions" class="btn-small" style="display:inline-block; margin-bottom:8px;">📥 Export การแลกรางวัลทั้งหมด (CSV)</a>
      <table>
        <tr><th>วันที่</th><th>สมาชิก</th><th>ของรางวัล</th><th style="text-align:right;">Sip</th><th>ที่อยู่จัดส่ง</th><th style="text-align:center;">สถานะ</th></tr>
        ${redemptionRows || '<tr><td colspan="6" class="muted">ยังไม่มีการแลก</td></tr>'}
      </table>
    </div>

    <script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.js"></script>
    <script>
      new Chart(document.getElementById('scanChart'), {
        type: 'bar',
        data: {
          labels: ${JSON.stringify(chartLabels)},
          datasets: [{ label: 'จำนวนสแกน', data: ${JSON.stringify(chartValues)}, backgroundColor: '#2a78d6', borderRadius: 4 }]
        },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } }
      });
      ${trendChartScript}
    </script>`;
}

// ---------- Members tab ----------
async function renderMembersTab(admin, tierFilter, detailMemberId) {
  if (detailMemberId) return renderMemberDetail(admin, detailMemberId);

  const yearStart = getCurrentYearStart();
  const [membersRes, ledgerRes, redemptionsRes] = await Promise.all([
    supabase.from('members').select('id, line_user_id, display_name, created_at'),
    supabase.from('points_ledger').select('member_id, tier_score, reward_points, created_at'),
    supabase.from('redemptions').select('member_id, points_spent, created_at'),
  ]);

  const members = membersRes.data || [];
  const ledger = ledgerRes.data || [];
  const redemptions = redemptionsRes.data || [];

  const spentThisYearByMember = {};
  for (const r of redemptions) {
    if (new Date(r.created_at) >= new Date(yearStart)) {
      spentThisYearByMember[r.member_id] = (spentThisYearByMember[r.member_id] || 0) + r.points_spent;
    }
  }

  const membersWithStats = members.map((m) => {
    const { start, end } = getTierEvaluationPeriod(m.created_at);
    const startDate = new Date(start);
    const endDate = end ? new Date(end) : null;
    let tierScore = 0;
    let pointsEarnedThisYear = 0;
    for (const row of ledger) {
      if (row.member_id !== m.id) continue;
      const rowDate = new Date(row.created_at);
      if (rowDate >= startDate && (!endDate || rowDate < endDate)) tierScore += row.tier_score;
      if (rowDate >= new Date(yearStart)) pointsEarnedThisYear += row.reward_points;
    }
    const spendableBalance = pointsEarnedThisYear - (spentThisYearByMember[m.id] || 0);
    return { ...m, tierScore, spendableBalance, tier: getTier(tierScore).current };
  });

  const tierCounts = Object.fromEntries(TIERS.map((t) => [t.name, 0]));
  for (const m of membersWithStats) tierCounts[m.tier.name]++;

  const filtered = tierFilter ? membersWithStats.filter((m) => m.tier.name === tierFilter) : membersWithStats;

  const tierPills = TIERS.map((t) => {
    const isActive = tierFilter === t.name;
    return `
      <a href="/api/admin/members?tier=${encodeURIComponent(t.name)}" class="stat-pill" style="border-color:${t.color}; ${isActive ? `background:${t.color}1a;` : ''}">
        <span style="color:${t.color};">${t.name}</span>
        <strong>${tierCounts[t.name] || 0}</strong>
      </a>`;
  }).join('');

  const clearFilter = tierFilter ? `<a href="/api/admin/members" class="clear-filter">ล้างฟิลเตอร์</a>` : '';

  const rows = filtered
    .sort((a, b) => b.tierScore - a.tierScore)
    .map(
      (m) => `
        <tr>
          <td><a href="/api/admin/members?detail=${m.id}" class="link">${m.display_name || m.line_user_id}</a></td>
          <td><span class="tier-tag" style="background:${m.tier.color};">${m.tier.name}</span></td>
          <td style="text-align:right;">${m.tierScore.toLocaleString()}</td>
          <td style="text-align:right;">${m.spendableBalance.toLocaleString()}</td>
          <td>${new Date(m.created_at).toLocaleDateString('th-TH')}</td>
        </tr>`
    )
    .join('');

  return `
    <div class="section">
      <h2>สมาชิกแยกตาม Tier</h2>
      <p class="hint">Tier ปีนี้ล็อกจากยอด Tier Score ของปีที่แล้ว — กดป้ายเพื่อกรอง</p>
      <div>${tierPills}${clearFilter}</div>
    </div>
    <div class="section">
      <h2>รายชื่อสมาชิก${tierFilter ? ` — Tier ${tierFilter}` : ''}</h2>
      <p class="hint">${filtered.length.toLocaleString()} คน — คลิกชื่อเพื่อดูรายละเอียด</p>
      <table>
        <tr><th>ชื่อ</th><th>Tier</th><th style="text-align:right;">Tier Score</th><th style="text-align:right;">Sip คงเหลือ</th><th>สมัครเมื่อ</th></tr>
        ${rows || '<tr><td colspan="5" class="muted">ไม่มีสมาชิกในกลุ่มนี้</td></tr>'}
      </table>
    </div>`;
}

// ---------- Member detail (ประวัติ engagement + redemption + form แก้ไข/ลบ) ----------
async function renderMemberDetail(admin, memberId) {
  const [memberRes, ledgerRes, redemptionsRes, addressesRes] = await Promise.all([
    supabase.from('members').select('id, line_user_id, display_name, created_at').eq('id', memberId).single(),
    supabase.from('points_ledger').select('creative_id, tier_score, reward_points, reason, created_at').eq('member_id', memberId).order('created_at', { ascending: false }),
    supabase.from('redemptions').select('id, points_spent, status, shipping_status, created_at, used_at, recipient_name, recipient_phone, recipient_address, rewards(name)').eq('member_id', memberId).order('created_at', { ascending: false }),
    supabase.from('member_addresses').select('recipient_name, recipient_phone, recipient_address, created_at').eq('member_id', memberId).order('created_at', { ascending: false }),
  ]);

  const member = memberRes.data;
  if (!member) return `<div class="section"><p>ไม่พบสมาชิกนี้</p></div>`;

  const ledger = ledgerRes.data || [];
  const redemptions = redemptionsRes.data || [];
  const addresses = addressesRes.data || [];
  const tierScore = ledger.reduce((s, r) => s + r.tier_score, 0);
  const { current } = getTier(tierScore);

  const engagementRows = ledger
    .map((r) => {
      const isAdjust = r.reason?.startsWith('admin_adjust');
      return `
        <tr>
          <td>${new Date(r.created_at).toLocaleString('th-TH')}</td>
          <td>${r.creative_id || (isAdjust ? '(แอดมินปรับ)' : '-')}</td>
          <td style="text-align:right;">${r.tier_score >= 0 ? '+' : ''}${r.tier_score}</td>
          <td style="text-align:right;">${r.reward_points >= 0 ? '+' : ''}${r.reward_points}</td>
        </tr>`;
    })
    .join('');

  const redemptionRows = redemptions
    .map((r) => {
      const shipBadge =
        r.status === 'used'
          ? `<form method="POST" action="/api/admin/action?action=redemption_ship_status" style="display:inline;">
               <input type="hidden" name="redemption_id" value="${r.id}" />
               <input type="hidden" name="back_to" value="/api/admin/members?detail=${memberId}" />
               <select name="shipping_status" class="table-input" style="width:auto; display:inline-block;" onchange="this.form.submit()">
                 <option value="not_shipped" ${r.shipping_status !== 'shipped' ? 'selected' : ''}>ยังไม่จัดส่ง</option>
                 <option value="shipped" ${r.shipping_status === 'shipped' ? 'selected' : ''}>จัดส่งแล้ว</option>
               </select>
             </form>`
          : 'รอใช้';
      return `
        <tr>
          <td>${new Date(r.created_at).toLocaleString('th-TH')}</td>
          <td>${r.rewards?.name || '-'}</td>
          <td style="text-align:right;">${r.points_spent}</td>
          <td>${r.recipient_name ? `${r.recipient_name}<br/><span class="hint">${r.recipient_phone || ''}</span><br/><span class="hint">${r.recipient_address || ''}</span>` : '-'}</td>
          <td style="text-align:center;">${shipBadge}</td>
        </tr>`;
    })
    .join('');

  const addressRows = addresses
    .map(
      (a) => `
        <tr>
          <td>${new Date(a.created_at).toLocaleDateString('th-TH')}</td>
          <td>${a.recipient_name}</td>
          <td>${a.recipient_phone}</td>
          <td>${a.recipient_address}</td>
        </tr>`
    )
    .join('');

  const canEditMember = can(admin.role, 'edit_member');
  const canDeleteMember = can(admin.role, 'delete_member');

  const adjustForm = canEditMember
    ? `
    <div class="section">
      <h2>ปรับ Tier Score / Sip ด้วยมือ</h2>
      <form method="POST" action="/api/admin/action?action=member_adjust" class="stack-form">
        <input type="hidden" name="member_id" value="${member.id}" />
        <label>เพิ่ม/ลด Tier Score (ใส่ค่าติดลบเพื่อหัก)</label>
        <input type="number" name="tier_score_delta" value="0" />
        <label>เพิ่ม/ลด Sip (ใส่ค่าติดลบเพื่อหัก)</label>
        <input type="number" name="points_delta" value="0" />
        <label>หมายเหตุ (ไม่บังคับ)</label>
        <input type="text" name="note" placeholder="เช่น ชดเชยระบบ error" />
        <button type="submit" class="btn-primary">บันทึก</button>
      </form>
    </div>`
    : '';

  const deleteForm = canDeleteMember
    ? `
    <div class="section">
      <h2 style="color:#e76f51;">ลบสมาชิกนี้</h2>
      <p class="hint">การลบไม่สามารถย้อนกลับได้ ประวัติทั้งหมดของสมาชิกคนนี้จะหายไป</p>
      <form method="POST" action="/api/admin/action?action=member_delete" onsubmit="return confirm('ยืนยันลบสมาชิกนี้ถาวร? ข้อมูลทั้งหมดจะกู้คืนไม่ได้')">
        <input type="hidden" name="member_id" value="${member.id}" />
        <label style="font-size:13px; display:flex; align-items:center; gap:6px; margin:8px 0;">
          <input type="checkbox" name="confirm" value="yes" required />
          ฉันเข้าใจว่าการลบนี้ถาวรและไม่สามารถกู้คืนได้
        </label>
        <button type="submit" class="btn-danger">ลบสมาชิกถาวร</button>
      </form>
    </div>`
    : '';

  return `
    <a href="/api/admin/members" class="link">&larr; กลับไปรายชื่อสมาชิก</a>
    <div class="section" style="margin-top:12px;">
      <h2>${member.display_name || member.line_user_id}</h2>
      <span class="tier-tag" style="background:${current.color};">${current.name}</span>
      <p class="hint" style="margin-top:8px;">สมัครเมื่อ ${new Date(member.created_at).toLocaleDateString('th-TH')}</p>
    </div>

    <div class="section">
      <h2>ประวัติ Engagement (Campaign ที่เคย engage)</h2>
      <table>
        <tr><th>วันที่</th><th>Campaign</th><th style="text-align:right;">Tier Score</th><th style="text-align:right;">Sip</th></tr>
        ${engagementRows || '<tr><td colspan="4" class="muted">ยังไม่มีประวัติ</td></tr>'}
      </table>
    </div>

    <div class="section">
      <h2>ประวัติการแลก Reward</h2>
      <table>
        <tr><th>วันที่</th><th>ของรางวัล</th><th style="text-align:right;">Sip</th><th>ที่อยู่จัดส่ง</th><th style="text-align:center;">สถานะจัดส่ง</th></tr>
        ${redemptionRows || '<tr><td colspan="5" class="muted">ยังไม่เคยแลก</td></tr>'}
      </table>
    </div>

    <div class="section">
      <h2>ที่อยู่ที่เคยใช้จัดส่ง</h2>
      <table>
        <tr><th>วันที่</th><th>ชื่อ</th><th>เบอร์โทร</th><th>ที่อยู่</th></tr>
        ${addressRows || '<tr><td colspan="4" class="muted">ยังไม่มีที่อยู่บันทึกไว้</td></tr>'}
      </table>
    </div>

    ${adjustForm}
    ${deleteForm}`;
}

// ---------- Rewards tab ----------
async function renderRewardsTab(admin) {
  const { data: rewards } = await supabase.from('rewards').select('id, name, points_cost, active, image_path').order('id');
  const canEdit = can(admin.role, 'edit_reward');
  const canDelete = can(admin.role, 'delete_reward');

  const rows = (rewards || [])
    .map((r) => {
      const imageUrl = r.image_path ? `${process.env.SUPABASE_URL}/storage/v1/object/public/reward-images/${r.image_path}` : null;
      const imageCell = `
        <td style="text-align:center;">
          ${imageUrl ? `<img src="${imageUrl}" style="width:40px; height:40px; object-fit:cover; border-radius:6px;" />` : '<span class="muted">-</span>'}
          ${canEdit ? `<input type="file" accept="image/jpeg,image/png,image/webp" class="reward-image-input" data-reward-id="${r.id}" style="display:block; margin-top:4px; font-size:11px; max-width:90px;" />` : ''}
        </td>`;

      const editableCells = canEdit
        ? `
          <td>
            <form method="POST" action="/api/admin/action?action=reward_update" class="inline-form reward-edit-form" data-reward-id="${r.id}">
              <input type="hidden" name="id" value="${r.id}" />
              <input type="hidden" name="image_base64" class="reward-image-base64" />
              <input type="hidden" name="image_filename" class="reward-image-filename" />
              <input type="text" name="name" value="${r.name}" class="table-input" />
          </td>
          <td><input type="number" name="points_cost" value="${r.points_cost}" class="table-input small" /></td>
          <td style="text-align:center;"><button class="btn-small">บันทึก</button></form></td>`
        : `<td>${r.name}</td><td>${r.points_cost}</td><td></td>`;

      const deleteCell = canDelete
        ? `<td style="text-align:center;">
            <form method="POST" action="/api/admin/action?action=reward_delete" onsubmit="return confirm('ลบของรางวัลนี้?')" style="display:inline;">
              <input type="hidden" name="id" value="${r.id}" />
              <button class="btn-small btn-danger">ลบ</button>
            </form>
          </td>`
        : `<td></td>`;

      return `
        <tr>
          ${imageCell}
          ${editableCells}
          <td style="text-align:center;">
            <form method="POST" action="/api/admin/action?action=reward_toggle" class="inline-form">
              <input type="hidden" name="id" value="${r.id}" />
              <button class="btn-small ${r.active ? '' : 'btn-muted'}">${r.active ? 'เปิดใช้อยู่' : 'ปิดใช้อยู่'}</button>
            </form>
          </td>
          ${deleteCell}
        </tr>`;
    })
    .join('');

  return `
    <div class="section">
      <h2>เพิ่มของรางวัลใหม่</h2>
      <form method="POST" action="/api/admin/action?action=reward_create" class="stack-form" id="rewardCreateForm">
        <label>ชื่อของรางวัล</label>
        <input type="text" name="name" required />
        <label>ใช้กี่ Sip</label>
        <input type="number" name="points_cost" required min="1" />
        <label>รูปภาพ (ไม่บังคับ — JPEG/PNG/WEBP ไม่เกิน 3MB)</label>
        <input type="file" accept="image/jpeg,image/png,image/webp" id="rewardCreateImage" />
        <input type="hidden" name="image_base64" id="rewardCreateImageBase64" />
        <input type="hidden" name="image_filename" id="rewardCreateImageFilename" />
        <button type="submit" class="btn-primary">เพิ่มของรางวัล</button>
      </form>
    </div>
    <div class="section">
      <h2>รายการของรางวัลทั้งหมด</h2>
      ${!canEdit ? '<p class="hint">คุณดูและเปิด/ปิดใช้งานได้ แต่แก้ไข/ลบไม่ได้</p>' : ''}
      <table>
        <tr><th>รูป</th><th>ชื่อ</th><th>Sip</th><th></th><th style="text-align:center;">สถานะ</th><th></th></tr>
        ${rows || '<tr><td colspan="6" class="muted">ยังไม่มีของรางวัล</td></tr>'}
      </table>
    </div>
    <script>
      function fileToBase64(file) {
        return new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = reject;
          reader.readAsDataURL(file);
        });
      }

      // ฟอร์มเพิ่มของรางวัลใหม่ — แปลงไฟล์เป็น Base64 ใส่ในช่องซ่อนก่อน submit จริง
      const createForm = document.getElementById('rewardCreateForm');
      const createImageInput = document.getElementById('rewardCreateImage');
      createForm.addEventListener('submit', async (e) => {
        if (createImageInput.files[0]) {
          e.preventDefault();
          const base64 = await fileToBase64(createImageInput.files[0]);
          document.getElementById('rewardCreateImageBase64').value = base64;
          document.getElementById('rewardCreateImageFilename').value = createImageInput.files[0].name;
          createForm.submit();
        }
      });

      // ช่องเปลี่ยนรูปต่อแถว — พอเลือกไฟล์ ใส่ Base64 ลงในฟอร์มแก้ไขแถวเดียวกันไว้เลย (ยังไม่ submit จนกว่าจะกด "บันทึก")
      document.querySelectorAll('.reward-image-input').forEach((input) => {
        input.addEventListener('change', async () => {
          if (!input.files[0]) return;
          const rewardId = input.dataset.rewardId;
          const form = document.querySelector('.reward-edit-form[data-reward-id="' + rewardId + '"]');
          const base64 = await fileToBase64(input.files[0]);
          form.querySelector('.reward-image-base64').value = base64;
          form.querySelector('.reward-image-filename').value = input.files[0].name;
        });
      });
    </script>`;
}

// ---------- Campaigns tab ----------
async function renderCampaignsTab(admin, req) {
  const { data: creatives } = await supabase.from('creatives').select('creative_id, destination_url, active').order('creative_id');
  const canEdit = can(admin.role, 'edit_campaign');
  const canDelete = can(admin.role, 'delete_campaign');

  const proto = req.headers['x-forwarded-proto'] || 'https';
  const baseUrl = `${proto}://${req.headers.host}`;

  const rows = (creatives || [])
    .map((c) => {
      const qrLink = `${baseUrl}/api/qr/${c.creative_id}`;
      const editableCells = canEdit
        ? `
          <td>
            <form method="POST" action="/api/admin/action?action=campaign_update" class="inline-form">
              <input type="hidden" name="creative_id" value="${c.creative_id}" />
              <input type="text" name="destination_url" value="${c.destination_url}" class="table-input" />
          </td>
          <td style="text-align:center;"><button class="btn-small">บันทึก</button></form></td>`
        : `<td>${c.destination_url}</td><td></td>`;

      const deleteCell = canDelete
        ? `<td style="text-align:center;">
            <form method="POST" action="/api/admin/action?action=campaign_delete" onsubmit="return confirm('ลบ Campaign นี้?')" style="display:inline;">
              <input type="hidden" name="creative_id" value="${c.creative_id}" />
              <button class="btn-small btn-danger">ลบ</button>
            </form>
          </td>`
        : `<td></td>`;

      return `
        <tr>
          <td style="font-family:monospace;">${c.creative_id}</td>
          <td>
            <div style="display:flex; gap:6px; align-items:center;">
              <input type="text" readonly value="${qrLink}" class="table-input" style="font-size:12px;" onclick="this.select()" />
              <button type="button" class="btn-small" onclick="navigator.clipboard.writeText('${qrLink}'); this.textContent='ก็อปแล้ว'; setTimeout(()=>this.textContent='ก็อปลิงก์', 1500);">ก็อปลิงก์</button>
            </div>
          </td>
          ${editableCells}
          <td style="text-align:center;">
            <form method="POST" action="/api/admin/action?action=campaign_toggle" class="inline-form">
              <input type="hidden" name="creative_id" value="${c.creative_id}" />
              <button class="btn-small ${c.active ? '' : 'btn-muted'}">${c.active ? 'เปิดใช้อยู่' : 'ปิดใช้อยู่'}</button>
            </form>
          </td>
          ${deleteCell}
        </tr>`;
    })
    .join('');

  return `
    <div class="section">
      <h2>เพิ่ม Campaign ใหม่</h2>
      <form method="POST" action="/api/admin/action?action=campaign_create" class="stack-form">
        <label>Campaign ID (ใช้ในลิงก์ QR เช่น brandA-video)</label>
        <input type="text" name="creative_id" required pattern="[a-zA-Z0-9\\-_]+" />
        <label>URL ปลายทาง</label>
        <input type="url" name="destination_url" required placeholder="https://..." />
        <button type="submit" class="btn-primary">เพิ่ม Campaign</button>
      </form>
    </div>
    <div class="section">
      <h2>Campaign ทั้งหมด</h2>
      ${!canEdit ? '<p class="hint">คุณดูและเปิด/ปิดใช้งานได้ แต่แก้ไข/ลบไม่ได้</p>' : ''}
      <table>
        <tr><th>Campaign ID</th><th>ลิงก์ QR</th><th>URL ปลายทาง</th><th></th><th style="text-align:center;">สถานะ</th><th></th></tr>
        ${rows || '<tr><td colspan="6" class="muted">ยังไม่มี Campaign</td></tr>'}
      </table>
    </div>`;
}

// ---------- Admins tab (super_admin เท่านั้น) ----------
async function renderAdminsTab(admin) {
  const fullAccess = can(admin.role, 'manage_admins'); // super_admin: จัดการได้ทุกคน ทุก role
  const { data: allAdmins } = await supabase.from('admin_users').select('username, role, created_at').order('created_at');

  // ถ้าไม่ใช่ full access (คือเป็น 'admin') เห็นแค่บัญชี staff เท่านั้น ไม่เห็น/แตะบัญชี admin หรือ super_admin คนอื่น
  const visibleAdmins = fullAccess ? allAdmins || [] : (allAdmins || []).filter((a) => a.role === 'staff');

  const roleOptions = (selected) =>
    ['super_admin', 'admin', 'staff']
      .map((r) => `<option value="${r}" ${r === selected ? 'selected' : ''}>${r}</option>`)
      .join('');

  const rows = visibleAdmins
    .map((a) => {
      const isSelf = a.username === admin.username;
      const roleCell = isSelf
        ? a.role
        : fullAccess
        ? `<form method="POST" action="/api/admin/action?action=admin_update_role" class="inline-form">
             <input type="hidden" name="username" value="${a.username}" />
             <select name="role" class="table-input">${roleOptions(a.role)}</select>
           </td>
           <td style="text-align:center;"><button class="btn-small">บันทึก</button></form>`
        : a.role; // admin เห็น role ของ staff ได้ แต่แก้ไม่ได้

      const resetForm = isSelf
        ? ''
        : `<form method="POST" action="/api/admin/action?action=admin_reset_password" class="inline-form">
             <input type="hidden" name="username" value="${a.username}" />
             <input type="hidden" name="password" value="" />
             <button type="button" class="btn-small" onclick="const p=prompt('ตั้งรหัสผ่านใหม่ให้ ${a.username}'); if(p){ this.form.password.value=p; this.form.submit(); }">รีเซ็ตรหัสผ่าน</button>
           </form>`;

      const deleteForm = isSelf
        ? ''
        : `<form method="POST" action="/api/admin/action?action=admin_delete" onsubmit="return confirm('ลบบัญชี ${a.username}?')" style="display:inline;">
             <input type="hidden" name="username" value="${a.username}" />
             <button class="btn-small btn-danger">ลบ</button>
           </form>`;

      return `
        <tr>
          <td>${a.username}${isSelf ? ' <span class="hint">(คุณ)</span>' : ''}</td>
          <td>${roleCell}</td>
          <td>${new Date(a.created_at).toLocaleDateString('th-TH')}</td>
          <td style="text-align:center;">${resetForm}</td>
          <td style="text-align:center;">${deleteForm}</td>
        </tr>`;
    })
    .join('');

  const roleSelector = fullAccess
    ? `
        <label>Role</label>
        <select name="role" style="padding:8px; border:1px solid #e5e7eb; border-radius:6px;">
          <option value="staff">staff</option>
          <option value="admin">admin</option>
          <option value="super_admin">super_admin</option>
        </select>`
    : `<input type="hidden" name="role" value="staff" />`; // admin สร้างได้แค่ staff เท่านั้น

  return `
    <div class="section">
      <h2>เพิ่มบัญชี${fullAccess ? 'แอดมิน/เจ้าหน้าที่' : 'เจ้าหน้าที่ (Staff)'}ใหม่</h2>
      ${!fullAccess ? '<p class="hint">คุณเพิ่มได้แค่บัญชีระดับ Staff เท่านั้น</p>' : ''}
      <form method="POST" action="/api/admin/action?action=admin_create" class="stack-form">
        <label>Username</label>
        <input type="text" name="username" required />
        <label>Password</label>
        <input type="password" name="password" required />
        ${roleSelector}
        <button type="submit" class="btn-primary">เพิ่มบัญชี</button>
      </form>
    </div>
    <div class="section">
      <h2>${fullAccess ? 'บัญชีแอดมินทั้งหมด' : 'บัญชี Staff ทั้งหมด'}</h2>
      <p class="hint">super_admin: ทำได้ทุกอย่าง | admin: จัดการบัญชี Staff/Office ได้ แตะบัญชี Admin คนอื่นไม่ได้ | staff: สร้าง/เปิดปิด Campaign และ Reward ได้ จัดการบัญชีใครไม่ได้เลย</p>
      <table>
        <tr><th>Username</th><th>Role</th><th>สร้างเมื่อ</th><th>รหัสผ่าน</th><th></th></tr>
        ${rows || '<tr><td colspan="5" class="muted">ไม่มีบัญชี</td></tr>'}
      </table>
    </div>`;
}

// ---------- Office Area tab (admin/staff เข้าดู/แก้ office ไหนก็ได้) ----------
async function renderOfficeTab(admin, selectedOfficeId) {
  const canManageOffices = can(admin.role, 'manage_offices');
  const offices = await listOfficeAccounts();

  const manageSection = canManageOffices ? renderOfficeAccountManagement(offices) : '';

  if (!offices.length) {
    return manageSection + `<div class="section"><p class="muted">ยังไม่มีบัญชี Office เลย เพิ่มได้จากฟอร์มด้านบน</p></div>`;
  }

  const activeId = selectedOfficeId || offices[0].id;
  const officeAccount = await getOfficeAccount(activeId);

  const officeOptions = offices
    .map((o) => `<option value="${o.id}" ${String(o.id) === String(activeId) ? 'selected' : ''}>${o.office_name} (${o.username})</option>`)
    .join('');

  const picker = `
    <div class="section">
      <h2>เลือก Office</h2>
      <form method="GET" action="/api/admin/office" style="display:flex; gap:8px; align-items:center;">
        <select name="office_id" class="table-input" style="max-width:280px;" onchange="this.form.submit()">
          ${officeOptions}
        </select>
      </form>
    </div>`;

  if (!officeAccount) {
    return manageSection + picker + `<div class="section"><p class="muted">ไม่พบ Office นี้</p></div>`;
  }

  const slots = await getSlots(officeAccount.id);
  const officeContent = renderOfficeAreaContent({
    officeAccount,
    slots,
    canEdit: true,
    uploadUrlAction: `/api/admin/action?action=office_get_upload_url&office=${officeAccount.id}`,
    saveAction: `/api/admin/action?action=office_save_content&office=${officeAccount.id}`,
    supabaseUrl: process.env.SUPABASE_URL,
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY,
  });

  const playStats = await renderPlaybackStats(officeAccount.id);

  return manageSection + picker + officeContent + playStats;
}

// ยอดรอบการเล่นเนื้อหาจริงบนจอ (ข้อมูลจาก CMS ที่ยิงเข้ามาทาง /api/playback-log)
async function renderPlaybackStats(officeAccountId) {
  const { data: logs } = await supabase
    .from('content_play_logs')
    .select('slot_number, screen_id, content_label, played_at')
    .eq('office_account_id', officeAccountId)
    .order('played_at', { ascending: false })
    .limit(500);

  const rows = logs || [];

  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dayOfWeek = (now.getDay() + 6) % 7;
  const weekStart = new Date(todayStart);
  weekStart.setDate(todayStart.getDate() - dayOfWeek);
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  const bySlot = {};
  for (let i = 1; i <= 6; i++) bySlot[i] = { today: 0, week: 0, month: 0, all: 0 };
  for (const row of rows) {
    const slot = bySlot[row.slot_number];
    if (!slot) continue;
    const playedAt = new Date(row.played_at);
    slot.all++;
    if (playedAt >= monthStart) slot.month++;
    if (playedAt >= weekStart) slot.week++;
    if (playedAt >= todayStart) slot.today++;
  }

  const slotRows = [1, 2, 3, 4, 5, 6]
    .map(
      (n) => `
        <tr>
          <td>Slot ${n}</td>
          <td style="text-align:right;">${bySlot[n].today.toLocaleString()}</td>
          <td style="text-align:right;">${bySlot[n].week.toLocaleString()}</td>
          <td style="text-align:right;">${bySlot[n].month.toLocaleString()}</td>
          <td style="text-align:right; font-weight:700;">${bySlot[n].all.toLocaleString()}</td>
        </tr>`
    )
    .join('');

  const recentRows = rows
    .slice(0, 20)
    .map(
      (r) => `
        <tr>
          <td>${new Date(r.played_at).toLocaleString('th-TH')}</td>
          <td>${r.slot_number || '-'}</td>
          <td>${r.screen_id || '-'}</td>
          <td>${r.content_label || '-'}</td>
        </tr>`
    )
    .join('');

  return `
    <div class="section">
      <h2>ยอดรอบการเล่นเนื้อหาจริงบนจอ (จาก CMS)</h2>
      <a href="/api/admin/action?action=export_playback&office=${officeAccountId}" class="btn-small" style="display:inline-block; margin-bottom:8px;">📥 Export ยอดการเล่นของ Office นี้ (CSV)</a>
      <p class="hint">ข้อมูลนี้มาจาก CMS ภายนอกที่ยิง Webhook เข้ามาที่ /api/playback-log — ถ้ายังไม่เชื่อมต่อ CMS ตารางนี้จะว่างเปล่า</p>
      <table>
        <tr><th></th><th style="text-align:right;">วันนี้</th><th style="text-align:right;">สัปดาห์นี้</th><th style="text-align:right;">เดือนนี้</th><th style="text-align:right;">ทั้งหมด</th></tr>
        ${slotRows}
      </table>
    </div>
    <div class="section">
      <h2>Log ล่าสุด (20 รายการ)</h2>
      <table>
        <tr><th>เวลา</th><th>Slot</th><th>Screen ID</th><th>ไฟล์ที่เล่น</th></tr>
        ${recentRows || '<tr><td colspan="4" class="muted">ยังไม่มีข้อมูล</td></tr>'}
      </table>
    </div>`;
}

// จัดการบัญชี Office (สร้าง/แก้ชื่อ-รหัสผ่าน/ลบ) — super_admin, admin เท่านั้น
function renderOfficeAccountManagement(offices) {
  const rows = offices
    .map(
      (o) => `
        <tr>
          <td>
            <form method="POST" action="/api/admin/action?action=office_account_update" class="inline-form">
              <input type="hidden" name="office_id" value="${o.id}" />
              <input type="text" name="office_name" value="${o.office_name}" class="table-input" />
          </td>
          <td>${o.username}</td>
          <td>
              <input type="email" name="email" value="${o.email || ''}" placeholder="สำหรับลืมรหัสผ่าน" class="table-input" />
          </td>
          <td>
              <input type="number" name="price_per_week" value="${o.price_per_week || 0}" class="table-input" style="width:100px;" step="0.01" />
          </td>
          <td>
              <input type="number" name="sponsor_slot_count" value="${o.sponsor_slot_count || 18}" class="table-input" style="width:70px;" min="1" />
          </td>
          <td>
              <input type="password" name="password" placeholder="(เว้นว่างถ้าไม่เปลี่ยน)" class="table-input" />
          </td>
          <td style="text-align:center;"><button class="btn-small">บันทึก</button></form></td>
          <td style="text-align:center;">
            <form method="POST" action="/api/admin/action?action=office_account_delete" onsubmit="return confirm('ลบบัญชี Office นี้? Content ทุก Slot จะหายไปด้วย')" style="display:inline;">
              <input type="hidden" name="office_id" value="${o.id}" />
              <button class="btn-small btn-danger">ลบ</button>
            </form>
          </td>
        </tr>`
    )
    .join('');

  return `
    <div class="section">
      <h2>เพิ่มบัญชี Office ใหม่</h2>
      <form method="POST" action="/api/admin/action?action=office_account_create" class="stack-form">
        <label>ชื่อ Office/สาขา</label>
        <input type="text" name="office_name" required />
        <label>Username</label>
        <input type="text" name="username" required />
        <label>อีเมล (ใช้สำหรับลืมรหัสผ่าน)</label>
        <input type="email" name="email" />
        <label>Password</label>
        <input type="password" name="password" required />
        <label>ราคาต่อสัปดาห์ (บาท) — สำหรับให้ Sponsor จองสล็อต</label>
        <input type="number" name="price_per_week" step="0.01" min="0" value="0" />
        <label>จำนวนสล็อตสำหรับ Sponsor</label>
        <input type="number" name="sponsor_slot_count" min="1" value="18" />
        <button type="submit" class="btn-primary">เพิ่มบัญชี Office</button>
      </form>
    </div>
    <div class="section">
      <h2>จัดการบัญชี Office ทั้งหมด</h2>
      <table>
        <tr><th>ชื่อ Office</th><th>Username</th><th>อีเมล</th><th>ราคา/สัปดาห์</th><th>จำนวนสล็อต</th><th>รีเซ็ตรหัสผ่าน</th><th></th><th></th></tr>
        ${rows || '<tr><td colspan="8" class="muted">ยังไม่มีบัญชี Office</td></tr>'}
      </table>
    </div>`;
}

// ---------- Sponsors tab: อนุมัติ Content + ยืนยันรับเงินการจอง ----------
async function renderSponsorsTab(admin, query) {
  const canManageSponsors = can(admin.role, 'manage_sponsor_accounts');

  const [pendingBookings, allBookingsRes] = await Promise.all([
    getPendingBookings(),
    supabase
      .from('slot_bookings')
      .select('id, slot_number, week_start, price, payment_status, approval_status, payment_method, payment_reference, payment_slip_path, reserved_until, created_at, sponsors(company_name, sponsor_code), office_accounts(office_name), sponsor_content(file_name)')
      .order('week_start', { ascending: true })
      .limit(50),
  ]);

  const allBookings = allBookingsRes.data || [];

  // ---------- ส่วนที่ 1: การจองที่รอตรวจสอบไฟล์ก่อนขึ้น CMS (ทุก Sponsor) ----------
  const pendingCards = await Promise.all(
    pendingBookings.map(async (b) => {
      const c = b.sponsor_content;
      const url = c ? await getSignedContentUrl(c.file_path) : null;
      const preview = !c
        ? '<p class="muted">ไม่มีไฟล์</p>'
        : c.file_type === 'video'
        ? `<video src="${url}" controls style="width:100%; max-height:160px; border-radius:8px;"></video>`
        : `<img src="${url}" style="width:100%; max-height:160px; object-fit:cover; border-radius:8px;" />`;

      // Slot อื่นในออฟฟิศเดียวกัน สัปดาห์เดียวกัน — เอาไว้ดูว่ามีธุรกิจประเภทเดียวกันติดกันไหมก่อนอนุมัติ
      const neighborSlots = await getOfficeSlotCategories(b.office_account_id, b.week_start, b.id);
      const neighborHtml = neighborSlots.length
        ? `<div class="hint" style="background:#f7f8fa; border-radius:6px; padding:6px 8px; margin-top:6px;">
            <strong>Slot อื่นในสัปดาห์เดียวกัน:</strong><br/>
            ${neighborSlots
              .map((s) => `Slot ${s.slotNumber}: ${s.businessType ? BUSINESS_TYPE_LABEL[s.businessType] || 'อื่นๆ' : 'ไม่ระบุ'}`)
              .join(' • ')}
          </div>`
        : '';

      return `
        <div class="content-review-card">
          ${preview}
          <p style="font-size:13px; font-weight:600; margin:8px 0 2px;">${c?.file_name || '-'}</p>
          <p class="hint">${b.sponsors?.company_name || '-'} (${b.sponsors?.sponsor_code || '-'}) — ${b.office_accounts?.office_name || '-'} Slot ${b.slot_number}</p>
          <p class="hint">ธุรกิจ: ${b.sponsors?.business_type ? BUSINESS_TYPE_LABEL[b.sponsors.business_type] || 'อื่นๆ' : 'ไม่ระบุ'}</p>
          <p class="hint">สัปดาห์ ${new Date(b.week_start).toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: 'numeric' })}</p>
          ${neighborHtml}
          <div style="display:flex; gap:8px; margin-top:8px;">
            <form method="POST" action="/api/admin/action?action=booking_review" style="display:inline;">
              <input type="hidden" name="booking_id" value="${b.id}" />
              <input type="hidden" name="decision" value="approved" />
              <button class="btn-small">อนุมัติ</button>
            </form>
            <form method="POST" action="/api/admin/action?action=booking_review" style="display:inline;" onsubmit="return fillReason(this)">
              <input type="hidden" name="booking_id" value="${b.id}" />
              <input type="hidden" name="decision" value="rejected" />
              <input type="hidden" name="reason" value="" />
              <button class="btn-small btn-danger">ไม่ผ่าน</button>
            </form>
          </div>
        </div>`;
    })
  );

  // ---------- ส่วนที่ 2: ค้นหา Sponsor รายตัว ----------
  const keyword = query.q || '';
  let searchResultsHtml = '';
  if (keyword.trim()) {
    const results = await searchSponsors(keyword.trim());
    searchResultsHtml =
      results
        .map(
          (s) => `
        <a href="/api/admin/sponsors?q=${encodeURIComponent(keyword)}&sponsor_id=${s.id}" class="link" style="display:block; padding:8px 0; border-bottom:1px solid #f0f0f0;">
          <strong>${s.sponsor_code}</strong> — ${s.company_name} <span class="hint">(${s.email})</span>
        </a>`
        )
        .join('') || '<p class="muted">ไม่พบ Sponsor ที่ตรงกับคำค้นหา</p>';
  }

  const searchSection = `
    <div class="section">
      <h2>ค้นหา Sponsor</h2>
      <p class="hint">พิมพ์ชื่อบริษัท หรือ Sponsor Code (เช่น "01")</p>
      <form method="GET" action="/api/admin/sponsors" style="display:flex; gap:8px; max-width:420px;">
        <input type="text" name="q" value="${keyword}" placeholder="ชื่อบริษัท หรือ Code" class="table-input" style="flex:1;" autofocus />
        <button type="submit" class="btn-small">ค้นหา</button>
      </form>
      ${keyword.trim() ? `<div style="margin-top:12px;">${searchResultsHtml}</div>` : ''}
    </div>`;

  // ---------- ส่วนที่ 3: รายละเอียด Sponsor ที่เลือกจากผลค้นหา ----------
  let detailSection = '';
  if (query.sponsor_id) {
    const sponsor = await getSponsorById(query.sponsor_id);
    if (sponsor) {
      const [content, bookings, creditBalance, approvedContentList] = await Promise.all([
        getSponsorContent(sponsor.id),
        supabase
          .from('slot_bookings')
          .select('id, slot_number, week_start, price, payment_status, approval_status, rejection_reason, updated_at, office_accounts(office_name), sponsor_content(file_name)')
          .eq('sponsor_id', sponsor.id)
          .order('week_start', { ascending: false }),
        getSponsorCreditBalance(sponsor.id),
        getPreviouslyApprovedContent(sponsor.id),
      ]);

      const contentRows = await Promise.all(
        content.map(async (c) => {
          const url = await getSignedContentUrl(c.file_path);
          const preview =
            c.file_type === 'video'
              ? `<video src="${url}" controls style="width:100%; max-height:120px; border-radius:8px;"></video>`
              : `<img src="${url}" style="width:100%; max-height:120px; object-fit:cover; border-radius:8px;" />`;
          return `<div class="content-review-card">${preview}<p style="font-size:12px; margin:6px 0 0;">${c.file_name}</p></div>`;
        })
      );

      const approvedOptionsHtml = approvedContentList.map((c) => `<option value="${c.id}">${c.file_name}</option>`).join('');

      const bookingRows = (bookings.data || [])
        .map((b) => {
          const payLabel =
            b.payment_status === 'refunded' && b.approval_status === 'rejected'
              ? 'ยกเลิก (ไม่ผ่านการตรวจสอบ)'
              : { unpaid: 'รอชำระเงิน', paid: 'ชำระแล้ว', refunded: 'คืนเงินแล้ว' }[b.payment_status] || b.payment_status;
          const approvalLabel = { pending: 'รอตรวจสอบ', approved: 'ผ่านแล้ว', rejected: 'ไม่ผ่าน' }[b.approval_status] || b.approval_status;
          const reasonLine = b.approval_status === 'rejected' && b.rejection_reason ? `<div class="hint" style="color:#e76f51;">เหตุผล: ${b.rejection_reason}</div>` : '';
          const updatedLine = `<div class="hint">แก้ไขล่าสุด: ${new Date(b.updated_at).toLocaleString('th-TH')}</div>`;

          const changeContentForm = approvedContentList.length
            ? `<form method="POST" action="/api/admin/action?action=admin_update_booking_content" style="margin-top:4px; display:flex; gap:4px;">
                 <input type="hidden" name="booking_id" value="${b.id}" />
                 <input type="hidden" name="sponsor_id" value="${sponsor.id}" />
                 <select name="sponsor_content_id" class="table-input" style="font-size:12px;">${approvedOptionsHtml}</select>
                 <button class="btn-small">เปลี่ยนไฟล์</button>
               </form>`
            : '';

          return `
            <tr>
              <td>${b.office_accounts?.office_name || '-'} — Slot ${b.slot_number}</td>
              <td>${new Date(b.week_start).toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: 'numeric' })}</td>
              <td>${b.sponsor_content?.file_name || '-'}${changeContentForm}</td>
              <td style="text-align:right;">${Number(b.price).toLocaleString()} บาท</td>
              <td style="text-align:center;">${payLabel}</td>
              <td style="text-align:center;">${approvalLabel}${reasonLine}${updatedLine}</td>
            </tr>`;
        })
        .join('');

      const editForm = canManageSponsors
        ? `
        <form method="POST" action="/api/admin/action?action=sponsor_account_update" class="stack-form" style="max-width:600px;">
          <input type="hidden" name="sponsor_id" value="${sponsor.id}" />
          <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px;">
            <div><label>ชื่อบริษัท</label><input type="text" name="company_name" value="${sponsor.company_name || ''}" required /></div>
            <div><label>อีเมล (username)</label><input type="email" name="email" value="${sponsor.email || ''}" required /></div>
            <div><label>เลขประจำตัวผู้เสียภาษี</label><input type="text" name="tax_id" value="${sponsor.tax_id || ''}" /></div>
            <div><label>ชื่อผู้ติดต่อ</label><input type="text" name="contact_name" value="${sponsor.contact_name || ''}" /></div>
            <div><label>เบอร์โทร</label><input type="text" name="contact_phone" value="${sponsor.contact_phone || ''}" /></div>
            <div><label>ประเภทธุรกิจ</label><input type="text" name="business_type" value="${sponsor.business_type || ''}" /></div>
          </div>
          <label>ที่อยู่</label>
          <input type="text" name="address" value="${sponsor.address || ''}" />
          <label>ตั้งรหัสผ่านใหม่ (เว้นว่างถ้าไม่เปลี่ยน)</label>
          <input type="password" name="password" />
          <button type="submit" class="btn-primary" style="margin-top:12px;">บันทึก</button>
        </form>
        <form method="POST" action="/api/admin/action?action=sponsor_account_delete" onsubmit="return confirm('ลบบัญชี Sponsor นี้ถาวร? ประวัติการจองทั้งหมดจะหายไปด้วย')" style="margin-top:8px;">
          <input type="hidden" name="sponsor_id" value="${sponsor.id}" />
          <button type="submit" class="btn-small btn-danger">ลบบัญชีนี้</button>
        </form>`
        : `<p class="hint">ชื่อบริษัท: ${sponsor.company_name} — อีเมล: ${sponsor.email} — เบอร์โทร: ${sponsor.contact_phone || '-'}</p>`;

      detailSection = `
        <div class="section">
          <h2>${sponsor.company_name} <span class="hint">(Code: ${sponsor.sponsor_code})</span></h2>
          <p style="font-size:14px; margin:4px 0 12px;">เครดิตคงเหลือ: <strong style="color:#06c755;">${creditBalance.toLocaleString()} บาท</strong></p>
          <a href="/api/admin/chat?thread_type=sponsor&thread_id=${sponsor.id}" class="btn-small" style="display:inline-block; margin-bottom:12px;">แชทกับ Sponsor นี้</a>
          ${editForm}
        </div>
        <div class="section">
          <h2>คลัง Content (${content.length} ไฟล์)</h2>
          <div class="content-grid">${contentRows.join('') || '<p class="muted">ยังไม่มีไฟล์</p>'}</div>
        </div>
        <div class="section">
          <h2>ประวัติการจอง</h2>
          <table>
            <tr><th>Office / Slot</th><th>สัปดาห์</th><th>ไฟล์</th><th style="text-align:right;">ราคา</th><th style="text-align:center;">ชำระเงิน</th><th style="text-align:center;">ตรวจสอบไฟล์</th></tr>
            ${bookingRows || '<tr><td colspan="6" class="muted">ยังไม่มีการจอง</td></tr>'}
          </table>
        </div>`;
    } else {
      detailSection = `<div class="section"><p class="muted">ไม่พบ Sponsor นี้</p></div>`;
    }
  }

  const bookingRows = allBookings
    .map((b) => {
      const isPaid = b.payment_status === 'paid';
      const isRejectedReleased = b.payment_status === 'refunded' && b.approval_status === 'rejected';
      const isExpired = b.payment_status === 'unpaid' && (!b.reserved_until || new Date(b.reserved_until) < new Date());
      const approvalLabel = { pending: 'รอตรวจสอบ', approved: 'ผ่านแล้ว', rejected: 'ไม่ผ่าน' }[b.approval_status] || b.approval_status;
      const airingStatus = getAiringStatus(b);
      const airingHtml = airingStatus
        ? `<span style="color:${AIRING_STATUS_LABEL[airingStatus].color}; font-weight:600;">${AIRING_STATUS_LABEL[airingStatus].text}</span>`
        : '<span class="hint">-</span>';
      return `
        <tr style="${isExpired || isRejectedReleased ? 'opacity:0.5;' : ''}">
          <td>${b.sponsors?.company_name || '-'} <span class="hint">(${b.sponsors?.sponsor_code || '-'})</span></td>
          <td>${b.office_accounts?.office_name || '-'} — Slot ${b.slot_number}</td>
          <td>${new Date(b.week_start).toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: 'numeric' })}</td>
          <td>${b.sponsor_content?.file_name || '-'}</td>
          <td style="text-align:right;">${Number(b.price).toLocaleString()} บาท</td>
          <td style="text-align:center;">
            ${
              isPaid
                ? '<span class="badge-used">ชำระแล้ว</span>'
                : isRejectedReleased
                ? '<span class="hint">ไม่ผ่านตรวจสอบ — คืน Slot แล้ว</span>'
                : isExpired
                ? '<span class="hint">หมดเวลาแล้ว — Slot คืนให้จองใหม่ได้แล้ว</span>'
                : `<form method="POST" action="/api/admin/action?action=booking_mark_paid" style="display:inline;">
                     <input type="hidden" name="booking_id" value="${b.id}" />
                     <button class="btn-small">ยืนยันรับเงิน</button>
                   </form>`
            }
          </td>
          <td style="text-align:center;">${approvalLabel}</td>
          <td style="text-align:center;">${airingHtml}</td>
          <td style="text-align:center;">
            <form method="POST" action="/api/admin/action?action=booking_cancel" onsubmit="return confirm('ลบรายการนี้ทิ้งถาวร?')" style="display:inline;">
              <input type="hidden" name="booking_id" value="${b.id}" />
              <button class="btn-small btn-danger">${isExpired ? 'ลบทิ้ง' : 'ยกเลิก'}</button>
            </form>
          </td>
        </tr>`;
    })
    .join('');

  return `
    <script>
      function fillReason(form) {
        const reason = prompt('เหตุผลที่ไม่อนุมัติ (จำเป็นต้องกรอก จะแจ้งให้ Sponsor เห็น)');
        if (!reason || !reason.trim()) { return false; }
        form.reason.value = reason.trim();
        return true;
      }
    </script>
    <div class="section">
      <h2>การจองที่รอตรวจสอบไฟล์ก่อนขึ้น CMS (${pendingBookings.length})</h2>
      <div class="content-grid">${pendingCards.join('') || '<p class="muted">ไม่มีรายการรอตรวจสอบ</p>'}</div>
    </div>
    ${searchSection}
    ${detailSection}
    <div class="section">
      <h2>การจองทั้งหมด (ภาพรวม)</h2>
      <a href="/api/admin/action?action=export_bookings" class="btn-small" style="display:inline-block; margin-bottom:8px;">📥 Export ประวัติการจองทั้งหมด (CSV)</a>
      <table>
        <tr><th>Sponsor</th><th>Office / Slot</th><th>สัปดาห์</th><th>ไฟล์</th><th style="text-align:right;">ราคา</th><th style="text-align:center;">ชำระเงิน</th><th style="text-align:center;">ตรวจสอบไฟล์</th><th style="text-align:center;">สถานะขึ้นจอ</th><th></th></tr>
        ${bookingRows || '<tr><td colspan="9" class="muted">ยังไม่มีการจอง</td></tr>'}
      </table>
    </div>
    <style>
      .content-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 16px; margin-top: 12px; }
      .content-review-card { border: 1px solid #f0f0f0; border-radius: 10px; padding: 10px; }
    </style>`;
}


function renderAccountTab(admin) {
  return `
    <div class="section">
      <h2>บัญชีของฉัน</h2>
      <p class="hint">Username: ${admin.username} — Role: ${admin.role}</p>
    </div>
    <div class="section">
      <h2>เปลี่ยนรหัสผ่าน</h2>
      <form method="POST" action="/api/admin/action?action=change_my_password" class="stack-form">
        <label>รหัสผ่านปัจจุบัน</label>
        <input type="password" name="current_password" required />
        <label>รหัสผ่านใหม่</label>
        <input type="password" name="new_password" required minlength="6" />
        <button type="submit" class="btn-primary">บันทึกรหัสผ่านใหม่</button>
      </form>
    </div>`;
}

// ---------- Layout ----------
// ---------- แชท (Admin คุยกับ Sponsor/Office) ----------
async function renderChatTab(admin, query) {
  const threads = await getAdminChatThreads();

  // ดึงชื่อจริงของ Sponsor/Office ที่ลงทะเบียนไว้ มาแสดงแทน ID ดิบๆ
  const sponsorIds = threads.filter((t) => t.threadType === 'sponsor').map((t) => t.threadId);
  const officeIds = threads.filter((t) => t.threadType === 'office').map((t) => t.threadId);
  const [sponsorRows, officeRows] = await Promise.all([
    sponsorIds.length ? supabase.from('sponsors').select('id, company_name').in('id', sponsorIds) : { data: [] },
    officeIds.length ? supabase.from('office_accounts').select('id, office_name').in('id', officeIds) : { data: [] },
  ]);
  const sponsorNames = Object.fromEntries((sponsorRows.data || []).map((s) => [s.id, s.company_name]));
  const officeNames = Object.fromEntries((officeRows.data || []).map((o) => [o.id, o.office_name]));

  const threadLabel = (threadType, threadId) =>
    threadType === 'sponsor' ? `Sponsor ${sponsorNames[threadId] || `#${threadId}`}` : `Office ${officeNames[threadId] || `#${threadId}`}`;

  const threadRows = threads
    .map((t) => {
      const label = threadLabel(t.threadType, t.threadId);
      const isActive = String(query.thread_id) === String(t.threadId) && query.thread_type === t.threadType;
      return `
        <a href="/api/admin/chat?thread_type=${t.threadType}&thread_id=${t.threadId}" class="chat-thread-item ${isActive ? 'active' : ''}">
          <div style="display:flex; justify-content:space-between;">
            <strong style="font-size:13px;">${label}</strong>
            ${t.unreadCount > 0 ? `<span class="tier-tag" style="background:#e76f51;">${t.unreadCount}</span>` : ''}
          </div>
          <p class="hint" style="margin:2px 0 0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${t.lastSenderLabel || ''}: ${t.lastMessage}</p>
        </a>`;
    })
    .join('');

  let conversationHtml = '<div class="section"><p class="muted">เลือกแชททางซ้ายเพื่อเริ่มดูข้อความ</p></div>';
  if (query.thread_type && query.thread_id) {
    conversationHtml = `
      <div class="section">
        <h2>${threadLabel(query.thread_type, query.thread_id)}</h2>
        <div id="chatBox" style="height:360px; overflow-y:auto; border:1px solid #f0f0f0; border-radius:8px; padding:12px; margin-top:8px;"></div>
        <form id="chatSendForm" style="display:flex; gap:8px; margin-top:12px;">
          <input type="text" id="chatInput" placeholder="พิมพ์ข้อความ..." style="flex:1;" />
          <button type="submit" class="btn-small">ส่ง</button>
        </form>
      </div>
      <script>
        const threadType = ${JSON.stringify(query.thread_type)};
        const threadId = ${JSON.stringify(String(query.thread_id))};
        const chatBox = document.getElementById('chatBox');

        function renderMessages(messages) {
          chatBox.innerHTML = messages.map((m) => {
            const mine = m.sender_type === 'admin';
            return '<div style="margin-bottom:10px; text-align:' + (mine ? 'right' : 'left') + ';">' +
              '<div style="display:inline-block; max-width:75%; padding:8px 12px; border-radius:10px; background:' + (mine ? '#1b1f27' : '#f0f0f0') + '; color:' + (mine ? 'white' : '#1b1f27') + '; font-size:13px; text-align:left;">' +
              '<div class="hint" style="color:#9ca3af; margin-bottom:2px;">' + (m.sender_label || m.sender_type) + '</div>' +
              m.message.replace(/</g, '&lt;') +
              '</div></div>';
          }).join('');
          chatBox.scrollTop = chatBox.scrollHeight;
        }

        async function poll() {
          const res = await fetch('/api/admin/action?action=chat_poll&thread_type=' + threadType + '&thread_id=' + threadId);
          const data = await res.json();
          renderMessages(data.messages || []);
        }

        document.getElementById('chatSendForm').addEventListener('submit', async (e) => {
          e.preventDefault();
          const input = document.getElementById('chatInput');
          const message = input.value.trim();
          if (!message) return;
          input.value = '';
          await fetch('/api/admin/action?action=chat_send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ thread_type: threadType, thread_id: threadId, message }).toString(),
          });
          poll();
        });

        poll();
        setInterval(poll, 2500);
      </script>`;
  }

  return `
    <div style="display:grid; grid-template-columns:280px 1fr; gap:16px; align-items:start;">
      <div class="section" style="padding:12px;">
        <h2 style="margin-bottom:8px;">แชททั้งหมด</h2>
        ${threadRows || '<p class="muted" style="font-size:13px;">ยังไม่มีข้อความ</p>'}
      </div>
      <div>${conversationHtml}</div>
    </div>
    <style>
      .chat-thread-item { display:block; padding:10px; border-radius:8px; text-decoration:none; color:#1b1f27; margin-bottom:4px; }
      .chat-thread-item:hover, .chat-thread-item.active { background:#f7f8fa; }
    </style>`;
}

// ---------- จัดการร้านค้าเกมเลี้ยงสัตว์ ----------
async function renderPetShopAdminTab(admin, query) {
  const keyword = (query.q || '').trim();

  let itemsQuery = supabase.from('pet_shop_items').select('*').order('item_type').order('points_cost');
  if (keyword) itemsQuery = itemsQuery.ilike('name', `%${keyword}%`);

  const [itemsRes, configRes] = await Promise.all([
    itemsQuery,
    supabase.from('pet_game_config').select('*').order('key'),
  ]);

  const items = itemsRes.data || [];
  const config = configRes.data || [];

  const typeLabel = { food: '🍚 อาหาร', treat: '🍬 ขนม', supplement: '💪 อาหารเสริม', medicine: '💊 ยารักษา', accessory: '🎀 เครื่องแต่งกาย' };
  const slotLabel = { bow: 'โบว์', hat: 'หมวก', glasses: 'แว่นตา', mouth: 'เครื่องปาก', shoes: 'รองเท้า' };
  const qParam = keyword ? `&q=${encodeURIComponent(keyword)}` : '';

  const itemRows = items
    .map(
      (item) => `
      <tr style="${item.active ? '' : 'opacity:0.5;'}">
        <form method="POST" action="/api/admin/action?action=pet_shop_item_update" class="inline-form">
          <input type="hidden" name="item_id" value="${item.id}" />
          <input type="hidden" name="item_type" value="${item.item_type}" />
          <input type="hidden" name="q" value="${keyword}" />
          <td>${typeLabel[item.item_type] || item.item_type}${
        item.item_type === 'accessory'
          ? `<br/><select name="accessory_slot" class="table-input" style="margin-top:4px; font-size:12px;">
              ${Object.keys(slotLabel)
                .map((s) => `<option value="${s}" ${item.accessory_slot === s ? 'selected' : ''}>${slotLabel[s]}</option>`)
                .join('')}
            </select>`
          : ''
      }</td>
          <td><input type="text" name="name" value="${item.name}" class="table-input" style="min-width:100px;" /></td>
          <td style="text-align:right;"><input type="number" name="points_cost" value="${item.points_cost}" min="0" class="table-input" style="width:70px; text-align:right;" /></td>
          <td style="text-align:center;">
            ${
              item.item_type === 'accessory'
                ? '-'
                : `<input type="number" name="hunger_boost" value="${item.hunger_boost || 0}" min="0" max="100" class="table-input" style="width:55px; text-align:center;" />`
            }
          </td>
          <td style="text-align:center;">
            ${
              item.item_type === 'accessory'
                ? '-'
                : `<input type="number" name="happiness_boost" value="${item.happiness_boost || 0}" min="0" max="100" class="table-input" style="width:55px; text-align:center;" />`
            }
          </td>
          <td style="text-align:center;"><button class="btn-small">บันทึก</button></td>
        </form>
        <td style="text-align:center;">
          <form method="POST" action="/api/admin/action?action=pet_shop_item_toggle" style="display:inline;">
            <input type="hidden" name="item_id" value="${item.id}" />
            <input type="hidden" name="q" value="${keyword}" />
            <button class="btn-small ${item.active ? 'btn-danger' : ''}">${item.active ? 'ปิดขาย' : 'เปิดขาย'}</button>
          </form>
        </td>
      </tr>`
    )
    .join('');

  const configRows = config
    .map(
      (c) => `
      <tr>
        <td>${c.key}</td>
        <td>
          <input type="hidden" name="config_key" value="${c.key}" />
          <input type="text" name="config_value" value="${c.value}" class="table-input" style="width:100px;" />
        </td>
      </tr>`
    )
    .join('');

  return `
    <div class="section">
      <h2>เพิ่มไอเทมใหม่ในร้านค้า</h2>
      <form method="POST" action="/api/admin/action?action=pet_shop_item_create" class="stack-form" id="itemForm">
        <label>ประเภท</label>
        <select name="item_type" id="itemTypeSelect" required>
          <option value="food">🍚 อาหาร</option>
          <option value="treat">🍬 ขนม</option>
          <option value="supplement">💪 อาหารเสริม (เตรียมไว้สำหรับ Phase Duel)</option>
          <option value="medicine">💊 ยารักษา (ใช้ตอนป่วยเท่านั้น)</option>
          <option value="accessory">🎀 เครื่องแต่งกาย</option>
        </select>
        <label>ชื่อไอเทม</label>
        <input type="text" name="name" required />
        <label>คำอธิบาย (ไม่บังคับ)</label>
        <input type="text" name="description" />
        <label>ราคา (Sip)</label>
        <input type="number" name="points_cost" min="0" required />
        <div id="foodFields">
          <label>เพิ่มความอิ่ม (% — เฉพาะอาหาร/ขนม)</label>
          <input type="number" name="hunger_boost" min="0" max="100" value="0" />
          <label>เพิ่มความสุข (% — เฉพาะอาหาร/ขนม)</label>
          <input type="number" name="happiness_boost" min="0" max="100" value="0" />
        </div>
        <div id="accessoryFields" style="display:none;">
          <label>ประเภทเครื่องแต่งกาย (Slot — สวมได้ทีละ 1 ชิ้นต่อ Slot)</label>
          <select name="accessory_slot">
            <option value="bow">โบว์</option>
            <option value="hat">หมวก</option>
            <option value="glasses">แว่นตา</option>
            <option value="mouth">เครื่องปาก</option>
            <option value="shoes">รองเท้า</option>
          </select>
        </div>
        <button type="submit" class="btn-primary" style="margin-top:12px;">เพิ่มไอเทม</button>
      </form>
      <script>
        document.getElementById('itemTypeSelect').addEventListener('change', function () {
          const isAccessory = this.value === 'accessory';
          document.getElementById('foodFields').style.display = isAccessory ? 'none' : 'block';
          document.getElementById('accessoryFields').style.display = isAccessory ? 'block' : 'none';
        });
      </script>
    </div>

    <div class="section">
      <h2>ไอเทมทั้งหมดในร้าน (${items.length}${keyword ? ` — ค้นหา "${keyword}"` : ''})</h2>
      <form method="GET" action="/api/admin/pet-shop" style="display:flex; gap:8px; max-width:360px; margin-bottom:12px;">
        <input type="text" name="q" value="${keyword}" placeholder="ค้นหาชื่อไอเทม..." class="table-input" style="flex:1;" />
        <button type="submit" class="btn-small">ค้นหา</button>
        ${keyword ? `<a href="/api/admin/pet-shop" class="btn-small btn-danger" style="text-decoration:none; display:inline-flex; align-items:center;">ล้าง</a>` : ''}
      </form>
      <p class="hint">แก้ตัวเลขในตารางแล้วกด "บันทึก" ต่อแถวได้เลย ไม่ต้องลบแล้วสร้างใหม่</p>
      <table>
        <tr><th>ประเภท</th><th>ชื่อ</th><th style="text-align:right;">ราคา</th><th style="text-align:center;">อิ่ม %</th><th style="text-align:center;">สุข %</th><th></th><th></th></tr>
        ${itemRows || `<tr><td colspan="7" class="muted">${keyword ? 'ไม่พบไอเทมที่ค้นหา' : 'ยังไม่มีไอเทมในร้าน — เพิ่มจากฟอร์มด้านบน'}</td></tr>`}
      </table>
    </div>

    <div class="section">
      <h2>ค่าคงที่ของเกม (ปรับได้เลย ไม่ต้องแก้โค้ด)</h2>
      <p class="hint">เช่น ความหิวลดลงกี่ % ต่อชั่วโมง, EXP ที่ได้จากแต่ละกิจกรรม, EXP ที่ต้องใช้ขึ้นแต่ละระดับ</p>
      <form method="POST" action="/api/admin/action?action=pet_game_config_update">
        <table>
          <tr><th>ตัวแปร</th><th>ค่า</th></tr>
          ${configRows}
        </table>
        <button type="submit" class="btn-primary" style="margin-top:12px;">บันทึกค่าทั้งหมด</button>
      </form>
    </div>`;
}

function renderLayout(activePage, admin, content) {
  const tabs = [
    { key: 'dashboard', label: 'Dashboard' },
    { key: 'members', label: 'Members' },
    { key: 'rewards', label: 'Rewards' },
    { key: 'campaigns', label: 'Campaigns' },
    { key: 'office', label: 'Office Area' },
    { key: 'sponsors', label: 'Sponsors' },
    { key: 'chat', label: 'แชท' },
    { key: 'pet-shop', label: 'ร้านสัตว์เลี้ยง' },
  ];
  if (can(admin.role, 'manage_admins') || can(admin.role, 'manage_staff')) tabs.push({ key: 'admins', label: 'Admins' });
  tabs.push({ key: 'account', label: 'My Account' });

  const nav = tabs
    .map((t) => `<a href="/api/admin/${t.key}" class="tab ${activePage === t.key ? 'active' : ''}">${t.label}</a>`)
    .join('');

  return `<!DOCTYPE html>
<html lang="th">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<link rel="stylesheet" href="/theme.css" />
<script src="/theme.js" defer></script>
<title>Admin — ${activePage}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: sans-serif; background: #f7f8fa; margin: 0; color: #1b1f27; }
  header { background: white; border-bottom: 1px solid #e5e7eb; padding: 0 24px; display: flex; align-items: center; justify-content: space-between; }
  .brand { font-weight: 700; padding: 16px 0; }
  nav { display: flex; gap: 4px; }
  .tab { padding: 16px 12px; text-decoration: none; color: #6b7280; font-size: 14px; border-bottom: 2px solid transparent; }
  .tab.active { color: #1b1f27; font-weight: 700; border-bottom-color: #1b1f27; }
  .user-info { display: flex; align-items: center; gap: 12px; font-size: 13px; color: #6b7280; }
  .logout-link { color: #e76f51; text-decoration: none; }
  main { padding: 24px; max-width: 960px; margin: 0 auto; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; margin-bottom: 24px; }
  .card { background: white; border-radius: 12px; padding: 16px; box-shadow: 0 1px 4px rgba(0,0,0,0.06); }
  .card .label { font-size: 13px; color: #6b7280; margin: 0 0 4px; }
  .card .value { font-size: 28px; font-weight: 700; margin: 0; }
  .section { background: white; border-radius: 12px; padding: 20px; margin-bottom: 20px; box-shadow: 0 1px 4px rgba(0,0,0,0.06); }
  h2 { font-size: 16px; margin: 0 0 4px; }
  .hint, .muted { font-size: 12px; color: #9ca3af; }
  .link { color: #2a78d6; text-decoration: none; }
  table { width: 100%; border-collapse: collapse; font-size: 14px; margin-top: 8px; }
  th { text-align: left; color: #6b7280; font-weight: 500; padding: 6px 4px; border-bottom: 1px solid #e5e7eb; }
  td { padding: 8px 4px; border-bottom: 1px solid #f0f0f0; }
  .stat-pill { display: inline-flex; flex-direction: column; align-items: center; gap: 2px; border: 1.5px solid; border-radius: 10px; padding: 8px 16px; margin-right: 8px; font-size: 13px; font-weight: 600; text-decoration: none; }
  .clear-filter { font-size: 12px; color: #2a78d6; margin-left: 8px; }
  .btn-small { background: #06c755; color: white; border: none; padding: 6px 12px; border-radius: 6px; font-size: 12px; cursor: pointer; }
  .btn-muted { background: #9ca3af; }
  .btn-danger { background: #e76f51; }
  .btn-primary { background: #1b1f27; color: white; border: none; padding: 10px 20px; border-radius: 8px; font-size: 14px; cursor: pointer; margin-top: 8px; }
  .badge-used { color: #9ca3af; font-size: 12px; }
  .tier-tag { color: white; font-size: 11px; font-weight: 700; padding: 3px 10px; border-radius: 999px; }
  .inline-form { display: contents; }
  .stack-form { display: flex; flex-direction: column; max-width: 400px; }
  .stack-form label { font-size: 13px; color: #6b7280; margin: 10px 0 4px; }
  .stack-form input { padding: 8px 10px; border: 1px solid #e5e7eb; border-radius: 6px; font-size: 14px; }
  .table-input { width: 100%; padding: 6px 8px; border: 1px solid #e5e7eb; border-radius: 6px; font-size: 13px; }
  .table-input.small { width: 80px; }
</style>
</head>
<body>
  <header>
    <div class="brand">QR Tracker Admin</div>
    <nav>${nav}</nav>
    <div class="user-info">
      <span>${admin.username} (${admin.role})</span>
      <a href="/api/admin/action?action=logout" class="logout-link">Logout</a>
    </div>
  </header>
  <main>${content}</main>
</body>
</html>`;
}
