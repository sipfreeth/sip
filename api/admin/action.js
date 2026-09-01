// api/admin/action.js
//
// ศูนย์รวม Action ทั้งหมดของระบบ Admin บน Vercel Serverless Function
// ช่วยประหยัดจำนวน Serverless Functions ไม่ให้เกินโควต้า 12 Functions บน Hobby Plan
//
// เรียกผ่าน query parameter 'action' เช่น:
//   GET  /api/admin/action?action=login          — แสดงฟอร์ม login
//   POST /api/admin/action?action=login           — ประมวลผล login
//   GET  /api/admin/action?action=logout          — logout
//   POST /api/admin/action?action=mark_used       — ยืนยัน redemption ว่าใช้แล้ว (สำหรับรายการ pending เก่า)
//   POST /api/admin/action?action=redemption_ship_status — ตั้งสถานะจัดส่ง (เลือกจาก dropdown)
//   POST /api/admin/action?action=reward_create   — เพิ่มของรางวัล
//   POST /api/admin/action?action=reward_update   — แก้ของรางวัล
//   POST /api/admin/action?action=reward_toggle   — เปิด/ปิดของรางวัล
//   POST /api/admin/action?action=reward_delete   — ลบของรางวัล
//   POST /api/admin/action?action=campaign_create — เพิ่ม Campaign
//   POST /api/admin/action?action=campaign_update — แก้ Campaign
//   POST /api/admin/action?action=campaign_toggle — เปิด/ปิด Campaign
//   POST /api/admin/action?action=campaign_delete — ลบ Campaign
//   POST /api/admin/action?action=admin_create        — เพิ่มบัญชีแอดมิน (super_admin เท่านั้น)
//   POST /api/admin/action?action=admin_update_role   — เปลี่ยน role แอดมิน (super_admin เท่านั้น)
//   POST /api/admin/action?action=admin_reset_password — รีเซ็ตรหัสผ่านแอดมิน (super_admin เท่านั้น)
//   POST /api/admin/action?action=admin_delete        — ลบบัญชีแอดมิน (super_admin เท่านั้น)
//   POST /api/admin/action?action=member_adjust   — ปรับ Tier Score/Point สมาชิกด้วยมือ
//   POST /api/admin/action?action=member_delete   — ลบสมาชิก (ต้อง confirm=yes)

import bcrypt from 'bcryptjs';
import { supabase } from '../../lib/supabaseClient.js';
import { requireAdmin, requirePermission, can, createSessionCookie, clearSessionCookie } from '../../lib/adminAuth.js';
import { createUploadTarget, saveSlotContent } from '../../lib/officeArea.js';
import { updateBookingApproval, grantSponsorCredit, adminUpdateBookingContent, getPreviouslyApprovedContent } from '../../lib/sponsorArea.js';
import { sendMessage, getMessages, markThreadRead, getAdminChatThreads } from '../../lib/chat.js';
import { toCsv, sendCsv } from '../../lib/csv.js';
import { getClientIp, checkLoginRateLimit, recordLoginAttempt, LOGIN_LOCKOUT_MESSAGE } from '../../lib/rateLimit.js';

async function readBody(req) {
  let body = '';
  for await (const chunk of req) body += chunk;
  return new URLSearchParams(body);
}

export default async function handler(req, res) {
  const actionParam = req.query.action;

  // ---------- 1. LOGIN (ไม่ต้อง login มาก่อน) ----------
  if (actionParam === 'login') {
    if (req.method === 'GET') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(200).send(renderLoginPage());
      return;
    }
    if (req.method === 'POST') {
      const params = await readBody(req);
      const username = (params.get('username') || '').trim();
      const password = params.get('password') || '';
      const ipAddress = getClientIp(req);

      const withinLimit = await checkLoginRateLimit(ipAddress, 'admin');
      if (!withinLimit) {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.status(200).send(renderLoginPage(LOGIN_LOCKOUT_MESSAGE));
        return;
      }

      const { data: user } = await supabase
        .from('admin_users')
        .select('username, password_hash')
        .eq('username', username)
        .maybeSingle();

      const validPassword = user ? await bcrypt.compare(password, user.password_hash) : false;

      if (!user || !validPassword) {
        await recordLoginAttempt(ipAddress, 'admin', false);
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.status(200).send(renderLoginPage('Username หรือ Password ไม่ถูกต้อง'));
        return;
      }

      await recordLoginAttempt(ipAddress, 'admin', true);
      res.setHeader('Set-Cookie', createSessionCookie(username));
      res.writeHead(302, { Location: '/api/admin/dashboard' });
      res.end();
      return;
    }
    res.status(405).send('Method not allowed');
    return;
  }

  // ---------- 2. LOGOUT (ไม่ต้อง login มาก่อน) ----------
  if (actionParam === 'logout') {
    res.setHeader('Set-Cookie', clearSessionCookie());
    res.writeHead(302, { Location: '/api/admin/action?action=login' });
    res.end();
    return;
  }

  // ---------- ทุก action ต่อจากนี้ ต้อง login ก่อน ----------
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  // ---------- Poll แชท (GET เพื่อรีเฟรชข้อความถี่ๆ) ----------
  if (actionParam === 'chat_poll' && req.method === 'GET') {
    const threadType = req.query.thread_type;
    const threadId = req.query.thread_id;
    const messages = await getMessages(threadType, threadId);
    await markThreadRead(threadType, threadId, 'admin');
    res.setHeader('Content-Type', 'application/json');
    res.status(200).json({ messages });
    return;
  }

  // ---------- Export CSV (GET ทั้งหมด — กด "Export" แล้วดาวน์โหลดทันที) ----------
  if (actionParam === 'export_scans' && req.method === 'GET') {
    const { data } = await supabase.from('scan_logs').select('creative_id, screen_id, scanned_at').order('scanned_at', { ascending: false });
    const csv = toCsv(data || [], [
      { key: 'creative_id', label: 'Campaign' },
      { key: 'screen_id', label: 'Screen ID' },
      { get: (r) => new Date(r.scanned_at).toLocaleString('th-TH'), label: 'เวลาที่สแกน' },
    ]);
    sendCsv(res, `scans-${Date.now()}.csv`, csv);
    return;
  }

  if (actionParam === 'export_playback' && req.method === 'GET') {
    const officeId = req.query.office;
    let query = supabase
      .from('content_play_logs')
      .select('office_account_id, slot_number, screen_id, content_label, played_at, office_accounts(office_name)')
      .order('played_at', { ascending: false });
    if (officeId) query = query.eq('office_account_id', officeId);
    const { data } = await query;
    const csv = toCsv(data || [], [
      { get: (r) => r.office_accounts?.office_name || '-', label: 'Office' },
      { key: 'slot_number', label: 'Slot' },
      { key: 'screen_id', label: 'Screen ID' },
      { key: 'content_label', label: 'ไฟล์ที่เล่น' },
      { get: (r) => new Date(r.played_at).toLocaleString('th-TH'), label: 'เวลาที่เล่น' },
    ]);
    sendCsv(res, `playback-${Date.now()}.csv`, csv);
    return;
  }

  if (actionParam === 'export_bookings' && req.method === 'GET') {
    const { data } = await supabase
      .from('slot_bookings')
      .select(
        'slot_number, week_start, price, payment_status, payment_method, approval_status, rejection_reason, created_at, sponsors(company_name, sponsor_code), office_accounts(office_name), sponsor_content(file_name)'
      )
      .order('created_at', { ascending: false });
    const csv = toCsv(data || [], [
      { get: (r) => r.sponsors?.company_name || '-', label: 'Sponsor' },
      { get: (r) => r.sponsors?.sponsor_code || '-', label: 'Sponsor Code' },
      { get: (r) => r.office_accounts?.office_name || '-', label: 'Office' },
      { key: 'slot_number', label: 'Slot' },
      { get: (r) => new Date(r.week_start).toLocaleDateString('th-TH'), label: 'สัปดาห์' },
      { get: (r) => r.sponsor_content?.file_name || '-', label: 'ไฟล์' },
      { key: 'price', label: 'ราคา' },
      { key: 'payment_status', label: 'สถานะจ่ายเงิน' },
      { key: 'payment_method', label: 'วิธีชำระ' },
      { key: 'approval_status', label: 'สถานะตรวจสอบ' },
      { key: 'rejection_reason', label: 'เหตุผลไม่ผ่าน' },
      { get: (r) => new Date(r.created_at).toLocaleString('th-TH'), label: 'วันที่จอง' },
    ]);
    sendCsv(res, `bookings-${Date.now()}.csv`, csv);
    return;
  }

  if (actionParam === 'export_redemptions' && req.method === 'GET') {
    const { data } = await supabase
      .from('redemptions')
      .select('points_spent, status, shipping_status, created_at, recipient_name, recipient_phone, rewards(name), members(display_name, line_user_id)')
      .order('created_at', { ascending: false });
    const csv = toCsv(data || [], [
      { get: (r) => r.members?.display_name || r.members?.line_user_id || '-', label: 'สมาชิก' },
      { get: (r) => r.rewards?.name || '-', label: 'ของรางวัล' },
      { key: 'points_spent', label: 'Point' },
      { key: 'status', label: 'สถานะ' },
      { key: 'shipping_status', label: 'สถานะจัดส่ง' },
      { key: 'recipient_name', label: 'ชื่อผู้รับ' },
      { key: 'recipient_phone', label: 'เบอร์โทร' },
      { get: (r) => new Date(r.created_at).toLocaleString('th-TH'), label: 'วันที่แลก' },
    ]);
    sendCsv(res, `redemptions-${Date.now()}.csv`, csv);
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).send('Method not allowed');
    return;
  }

  const params = await readBody(req);

  // ---------- 3. MARK REDEMPTION USED ----------
  if (actionParam === 'mark_used') {
    const code = params.get('code');
    if (code) {
      await supabase
        .from('redemptions')
        .update({ status: 'used', used_at: new Date().toISOString() })
        .eq('redemption_code', code)
        .eq('status', 'pending');
    }
    res.writeHead(302, { Location: '/api/admin/dashboard' });
    res.end();
    return;
  }

  // ---------- 3b. TOGGLE SHIPPING STATUS (จัดส่งแล้ว / ยังไม่จัดส่ง) ----------
  if (actionParam === 'redemption_ship_status') {
    const redemptionId = params.get('redemption_id');
    const newStatus = params.get('shipping_status');
    if (redemptionId && ['shipped', 'not_shipped'].includes(newStatus)) {
      await supabase.from('redemptions').update({ shipping_status: newStatus }).eq('id', redemptionId);
    }
    const backTo = params.get('back_to') || '/api/admin/dashboard';
    res.writeHead(302, { Location: backTo });
    res.end();
    return;
  }

  // ---------- 4. REWARD ACTIONS ----------
  if (actionParam === 'reward_create') {
    if (!requirePermission(res, admin.role, 'create_reward')) return;
    await supabase.from('rewards').insert({
      name: params.get('name'),
      points_cost: Number(params.get('points_cost')),
    });
    res.writeHead(302, { Location: '/api/admin/rewards' });
    res.end();
    return;
  }

  if (actionParam === 'reward_update') {
    if (!requirePermission(res, admin.role, 'edit_reward')) return;
    await supabase
      .from('rewards')
      .update({ name: params.get('name'), points_cost: Number(params.get('points_cost')) })
      .eq('id', params.get('id'));
    res.writeHead(302, { Location: '/api/admin/rewards' });
    res.end();
    return;
  }

  if (actionParam === 'reward_toggle') {
    if (!requirePermission(res, admin.role, 'toggle_reward')) return;
    const { data: reward } = await supabase.from('rewards').select('active').eq('id', params.get('id')).single();
    if (reward) await supabase.from('rewards').update({ active: !reward.active }).eq('id', params.get('id'));
    res.writeHead(302, { Location: '/api/admin/rewards' });
    res.end();
    return;
  }

  if (actionParam === 'reward_delete') {
    if (!requirePermission(res, admin.role, 'delete_reward')) return;
    await supabase.from('rewards').delete().eq('id', params.get('id'));
    res.writeHead(302, { Location: '/api/admin/rewards' });
    res.end();
    return;
  }

  // ---------- 5. CAMPAIGN ACTIONS ----------
  if (actionParam === 'campaign_create') {
    if (!requirePermission(res, admin.role, 'create_campaign')) return;
    await supabase.from('creatives').insert({
      creative_id: params.get('creative_id'),
      destination_url: params.get('destination_url'),
    });
    res.writeHead(302, { Location: '/api/admin/campaigns' });
    res.end();
    return;
  }

  if (actionParam === 'campaign_update') {
    if (!requirePermission(res, admin.role, 'edit_campaign')) return;
    await supabase
      .from('creatives')
      .update({ destination_url: params.get('destination_url') })
      .eq('creative_id', params.get('creative_id'));
    res.writeHead(302, { Location: '/api/admin/campaigns' });
    res.end();
    return;
  }

  if (actionParam === 'campaign_toggle') {
    if (!requirePermission(res, admin.role, 'toggle_campaign')) return;
    const { data: c } = await supabase
      .from('creatives')
      .select('active')
      .eq('creative_id', params.get('creative_id'))
      .single();
    if (c) await supabase.from('creatives').update({ active: !c.active }).eq('creative_id', params.get('creative_id'));
    res.writeHead(302, { Location: '/api/admin/campaigns' });
    res.end();
    return;
  }

  if (actionParam === 'campaign_delete') {
    if (!requirePermission(res, admin.role, 'delete_campaign')) return;
    await supabase.from('creatives').delete().eq('creative_id', params.get('creative_id'));
    res.writeHead(302, { Location: '/api/admin/campaigns' });
    res.end();
    return;
  }

  // ---------- 6. ADMIN USER ACTIONS ----------
  // super_admin (manage_admins) จัดการได้ทุกบัญชี ทุก role
  // admin (manage_staff) จัดการได้แค่บัญชีที่ role = 'staff' เท่านั้น เปลี่ยน role ไม่ได้เลย
  if (['admin_create', 'admin_update_role', 'admin_reset_password', 'admin_delete'].includes(actionParam)) {
    const fullAccess = can(admin.role, 'manage_admins');
    const staffOnlyAccess = can(admin.role, 'manage_staff');

    if (!fullAccess && !staffOnlyAccess) {
      res.status(403).send('คุณไม่มีสิทธิ์ทำรายการนี้');
      return;
    }

    async function targetIsStaff(username) {
      const { data } = await supabase.from('admin_users').select('role').eq('username', username).maybeSingle();
      return data?.role === 'staff';
    }

    if (actionParam === 'admin_create') {
      const newRole = params.get('role');
      if (!fullAccess && newRole !== 'staff') {
        res.status(403).send('คุณสร้างบัญชีได้แค่ระดับ Staff เท่านั้น');
        return;
      }
      const hash = await bcrypt.hash(params.get('password'), 10);
      await supabase.from('admin_users').insert({
        username: params.get('username'),
        password_hash: hash,
        role: newRole,
      });
    }

    if (actionParam === 'admin_update_role') {
      // เปลี่ยน role ได้แค่ super_admin เท่านั้น (การเลื่อนขั้นเป็นสิทธิ์สูงสุด)
      if (!fullAccess) {
        res.status(403).send('คุณไม่มีสิทธิ์เปลี่ยน role');
        return;
      }
      if (params.get('username') === admin.username) {
        res.status(400).send('ไม่สามารถเปลี่ยน role ของบัญชีตัวเองได้ ให้ super_admin คนอื่นเปลี่ยนให้');
        return;
      }
      await supabase.from('admin_users').update({ role: params.get('role') }).eq('username', params.get('username'));
    }

    if (actionParam === 'admin_reset_password') {
      if (!fullAccess && !(await targetIsStaff(params.get('username')))) {
        res.status(403).send('คุณรีเซ็ตรหัสผ่านได้แค่บัญชี Staff เท่านั้น');
        return;
      }
      const hash = await bcrypt.hash(params.get('password'), 10);
      await supabase.from('admin_users').update({ password_hash: hash }).eq('username', params.get('username'));
    }

    if (actionParam === 'admin_delete') {
      if (params.get('username') === admin.username) {
        res.status(400).send('ไม่สามารถลบบัญชีตัวเองได้');
        return;
      }
      if (!fullAccess && !(await targetIsStaff(params.get('username')))) {
        res.status(403).send('คุณลบได้แค่บัญชี Staff เท่านั้น');
        return;
      }
      await supabase.from('admin_users').delete().eq('username', params.get('username'));
    }

    res.writeHead(302, { Location: '/api/admin/admins' });
    res.end();
    return;
  }

  // ---------- 6b. OFFICE ACCOUNT MANAGEMENT (super_admin, admin) ----------
  if (['office_account_create', 'office_account_update', 'office_account_delete'].includes(actionParam)) {
    console.error('🔍OFFICE_DEBUG🔍 action:', actionParam, 'admin.role:', admin.role, 'canManageOffices:', can(admin.role, 'manage_offices'));

    if (!requirePermission(res, admin.role, 'manage_offices')) {
      console.error('🔍OFFICE_DEBUG🔍 blocked by requirePermission — role ไม่มีสิทธิ์ manage_offices');
      return;
    }

    let dbError = null;

    if (actionParam === 'office_account_create') {
      console.error('🔍OFFICE_DEBUG🔍 params:', {
        office_name: params.get('office_name'),
        username: params.get('username'),
        email: params.get('email'),
        price_per_week: params.get('price_per_week'),
        sponsor_slot_count: params.get('sponsor_slot_count'),
        has_password: Boolean(params.get('password')),
      });

      const hash = await bcrypt.hash(params.get('password'), 10);
      const { data, error } = await supabase
        .from('office_accounts')
        .insert({
          office_name: params.get('office_name'),
          username: params.get('username'),
          email: (params.get('email') || '').trim().toLowerCase() || null,
          password_hash: hash,
          price_per_week: Number(params.get('price_per_week') || 0),
          sponsor_slot_count: Number(params.get('sponsor_slot_count') || 18),
        })
        .select();

      console.error('🔍OFFICE_DEBUG🔍 supabase result — data:', JSON.stringify(data), 'error:', JSON.stringify(error));

      dbError = error || (!data || !data.length ? { message: 'ไม่มีข้อผิดพลาดจากฐานข้อมูล แต่ไม่มีแถวถูกสร้างขึ้นจริง (อาจติด Row Level Security หรือ Policy บางอย่าง)' } : null);
    }

    if (actionParam === 'office_account_update') {
      const updates = {
        office_name: params.get('office_name'),
        email: (params.get('email') || '').trim().toLowerCase() || null,
        price_per_week: Number(params.get('price_per_week') || 0),
        sponsor_slot_count: Number(params.get('sponsor_slot_count') || 18),
      };
      const newPassword = params.get('password');
      if (newPassword) updates.password_hash = await bcrypt.hash(newPassword, 10);
      const { error } = await supabase.from('office_accounts').update(updates).eq('id', params.get('office_id'));
      dbError = error;
    }

    if (actionParam === 'office_account_delete') {
      const { error } = await supabase.from('office_accounts').delete().eq('id', params.get('office_id'));
      dbError = error;
    }

    if (dbError) {
      // แสดง error จริงจากฐานข้อมูล แทนที่จะเงียบแล้วทำเหมือนสำเร็จ (บั๊กเดิม)
      const friendly = dbError.code === '23505' ? 'Username หรือ Email นี้ถูกใช้ไปแล้ว กรุณาใช้ค่าอื่น' : dbError.message;
      res.status(400).send(`บันทึกไม่สำเร็จ: ${friendly}`);
      return;
    }

    res.writeHead(302, { Location: '/api/admin/office' });
    res.end();
    return;
  }

  // ---------- 6c. เปลี่ยนรหัสผ่านของตัวเอง (ทุก role ทำได้ ไม่ต้องมีสิทธิ์พิเศษ) ----------
  if (actionParam === 'change_my_password') {
    const { data: user } = await supabase.from('admin_users').select('password_hash').eq('username', admin.username).single();
    const valid = user && (await bcrypt.compare(params.get('current_password') || '', user.password_hash));

    if (!valid) {
      res.status(400).send('รหัสผ่านปัจจุบันไม่ถูกต้อง');
      return;
    }

    const hash = await bcrypt.hash(params.get('new_password'), 10);
    await supabase.from('admin_users').update({ password_hash: hash }).eq('username', admin.username);
    res.writeHead(302, { Location: '/api/admin/account' });
    res.end();
    return;
  }

  // ---------- 7. MEMBER ACTIONS ----------
  if (actionParam === 'member_adjust') {
    if (!requirePermission(res, admin.role, 'edit_member')) return;
    const memberId = params.get('member_id');
    const tierScoreDelta = Number(params.get('tier_score_delta') || 0);
    const pointsDelta = Number(params.get('points_delta') || 0);
    const note = params.get('note') || '';

    if (tierScoreDelta !== 0 || pointsDelta !== 0) {
      await supabase.from('points_ledger').insert({
        member_id: memberId,
        creative_id: null,
        tier_score: tierScoreDelta,
        reward_points: pointsDelta,
        reason: `admin_adjust:${admin.username}${note ? ' - ' + note : ''}`,
      });
    }
    res.writeHead(302, { Location: `/api/admin/members?detail=${memberId}` });
    res.end();
    return;
  }

  if (actionParam === 'member_delete') {
    if (!requirePermission(res, admin.role, 'delete_member')) return;
    if (params.get('confirm') !== 'yes') {
      res.status(400).send('ต้องยืนยันการลบก่อน');
      return;
    }
    await supabase.from('members').delete().eq('id', params.get('member_id'));
    res.writeHead(302, { Location: '/api/admin/members' });
    res.end();
    return;
  }

  // ---------- 8. OFFICE AREA ACTIONS (admin/staff แก้ของ office ไหนก็ได้) ----------
  if (actionParam === 'office_get_upload_url') {
    const officeAccountId = req.query.office;
    const slot = Number(req.query.slot);
    try {
      const target = await createUploadTarget(officeAccountId, slot, params.get('file_name') || 'file');
      res.setHeader('Content-Type', 'application/json');
      res.status(200).send(JSON.stringify(target));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
    return;
  }

  if (actionParam === 'office_save_content') {
    const officeAccountId = req.query.office;
    const slot = Number(req.query.slot);
    try {
      await saveSlotContent({
        officeAccountId,
        slotNumber: slot,
        fileName: params.get('file_name'),
        filePath: params.get('file_path'),
        fileType: params.get('file_type'),
        displayAt: params.get('display_at') ? new Date(params.get('display_at')).toISOString() : null,
        editorLabel: `${admin.username} (${admin.role})`,
      });
      res.status(200).send('ok');
    } catch (err) {
      res.status(500).send(err.message);
    }
    return;
  }

  // ---------- 9. BOOKING REVIEW (อนุมัติ/ไม่อนุมัติ Content ที่เลือกลง Slot ก่อนขึ้น CMS) ----------
  if (actionParam === 'booking_review') {
    const bookingId = params.get('booking_id');
    const decision = params.get('decision'); // 'approved' หรือ 'rejected'
    const reason = (params.get('reason') || '').trim();

    if (!['approved', 'rejected'].includes(decision)) {
      res.status(400).send('decision ไม่ถูกต้อง');
      return;
    }
    if (decision === 'rejected' && !reason) {
      res.status(400).send('กรุณาใส่เหตุผลที่ไม่อนุมัติ');
      return;
    }

    await updateBookingApproval(bookingId, decision, admin.username, reason);

    if (decision === 'rejected') {
      // เนื้อหาไม่ผ่านอนุมัติ → ยกเลิก Slot นี้ทันที ไม่ว่าจะจ่ายเงินไปแล้วหรือยังก็ตาม
      // ถ้าจ่ายเงินไปแล้ว คืนเป็นเครดิตแทน (ใช้จองครั้งต่อไปได้ อายุ 1 ปี) — ถ้ายังไม่จ่าย ไม่มีอะไรต้องคืน แค่ปล่อย slot
      const { data: booking } = await supabase
        .from('slot_bookings')
        .select('sponsor_id, price, payment_status')
        .eq('id', bookingId)
        .single();

      if (booking) {
        if (booking.payment_status === 'paid') {
          await grantSponsorCredit(booking.sponsor_id, booking.price, `rejected_booking:${bookingId}`);
        }
        // ตั้งเป็น 'refunded' เสมอไม่ว่าจะจ่ายเงินไปแล้วหรือยัง — สถานะนี้คือตัวที่ทำให้ getAvailability() ปล่อย slot คืนทันที
        // (ไม่รอให้ครบ 15 นาทีหมดเวลาเองตามธรรมชาติ กันปัญหา slot ค้างจากการตรวจสอบไม่ผ่าน)
        await supabase.from('slot_bookings').update({ payment_status: 'refunded' }).eq('id', bookingId);
      }
    }

    res.writeHead(302, { Location: '/api/admin/sponsors' });
    res.end();
    return;
  }

  // ---------- 9b. เปลี่ยน Content ของ Booking แทน Sponsor (ตามที่แจ้งผ่านแชท) ----------
  if (actionParam === 'admin_update_booking_content') {
    const bookingId = params.get('booking_id');
    const sponsorId = params.get('sponsor_id');
    const contentId = params.get('sponsor_content_id');
    try {
      await adminUpdateBookingContent(bookingId, sponsorId, contentId, `${admin.username} (${admin.role})`);
    } catch (err) {
      res.status(400).send(err.message);
      return;
    }
    res.writeHead(302, { Location: `/api/admin/sponsors?sponsor_id=${sponsorId}` });
    res.end();
    return;
  }

  // ---------- แชท (Admin ตอบทั้ง Sponsor และ Office) ----------
  if (actionParam === 'chat_send') {
    const threadType = params.get('thread_type');
    const threadId = params.get('thread_id');
    try {
      await sendMessage({
        threadType,
        threadId,
        senderType: 'admin',
        senderLabel: admin.username,
        message: params.get('message'),
      });
    } catch (err) {
      res.status(400).send(err.message);
      return;
    }
    res.status(200).send('ok');
    return;
  }

  // ---------- 10. BOOKING PAYMENT CONFIRMATION (manual — เผื่อระบบชำระเงินอัตโนมัติในอนาคต) ----------
  if (actionParam === 'booking_mark_paid') {
    await supabase
      .from('slot_bookings')
      .update({ payment_status: 'paid', payment_method: 'manual' })
      .eq('id', params.get('booking_id'));
    res.writeHead(302, { Location: '/api/admin/sponsors' });
    res.end();
    return;
  }

  if (actionParam === 'booking_cancel') {
    await supabase.from('slot_bookings').delete().eq('id', params.get('booking_id'));
    res.writeHead(302, { Location: '/api/admin/sponsors' });
    res.end();
    return;
  }

  // ---------- 11. SPONSOR ACCOUNT MANAGEMENT (super_admin เท่านั้น) ----------
  if (actionParam === 'sponsor_account_update') {
    if (!requirePermission(res, admin.role, 'manage_sponsor_accounts')) return;

    const updates = {
      company_name: params.get('company_name'),
      tax_id: params.get('tax_id') || null,
      address: params.get('address') || null,
      contact_name: params.get('contact_name') || null,
      contact_phone: params.get('contact_phone') || null,
      business_type: params.get('business_type') || null,
      email: (params.get('email') || '').trim().toLowerCase(),
    };
    const newPassword = params.get('password');
    if (newPassword) updates.password_hash = await bcrypt.hash(newPassword, 10);

    await supabase.from('sponsors').update(updates).eq('id', params.get('sponsor_id'));
    res.writeHead(302, { Location: '/api/admin/sponsors' });
    res.end();
    return;
  }

  if (actionParam === 'sponsor_account_delete') {
    if (!requirePermission(res, admin.role, 'manage_sponsor_accounts')) return;
    await supabase.from('sponsors').delete().eq('id', params.get('sponsor_id'));
    res.writeHead(302, { Location: '/api/admin/sponsors' });
    res.end();
    return;
  }

  // ---------- จัดการร้านค้าเกมเลี้ยงสัตว์ (อาหาร/ขนม/เครื่องแต่งกาย) ----------
  if (actionParam === 'pet_shop_item_create') {
    const itemType = params.get('item_type');
    const { error } = await supabase.from('pet_shop_items').insert({
      item_type: itemType,
      name: params.get('name'),
      description: params.get('description') || null,
      points_cost: Number(params.get('points_cost') || 0),
      hunger_boost: Number(params.get('hunger_boost') || 0),
      happiness_boost: Number(params.get('happiness_boost') || 0),
      accessory_slot: itemType === 'accessory' ? params.get('accessory_slot') : null,
    });
    if (error) {
      res.status(400).send(`เพิ่มไอเทมไม่สำเร็จ: ${error.message}`);
      return;
    }
    res.writeHead(302, { Location: '/api/admin/pet-shop' });
    res.end();
    return;
  }

  if (actionParam === 'pet_shop_item_toggle') {
    const { data: item } = await supabase.from('pet_shop_items').select('active').eq('id', params.get('item_id')).single();
    await supabase.from('pet_shop_items').update({ active: !item?.active }).eq('id', params.get('item_id'));
    const q = params.get('q');
    res.writeHead(302, { Location: `/api/admin/pet-shop${q ? `?q=${encodeURIComponent(q)}` : ''}` });
    res.end();
    return;
  }

  if (actionParam === 'pet_shop_item_update') {
    const itemType = params.get('item_type');
    const { error } = await supabase
      .from('pet_shop_items')
      .update({
        name: params.get('name'),
        description: params.get('description') || null,
        points_cost: Number(params.get('points_cost') || 0),
        hunger_boost: Number(params.get('hunger_boost') || 0),
        happiness_boost: Number(params.get('happiness_boost') || 0),
        accessory_slot: itemType === 'accessory' ? params.get('accessory_slot') : null,
      })
      .eq('id', params.get('item_id'));
    if (error) {
      res.status(400).send(`บันทึกไม่สำเร็จ: ${error.message}`);
      return;
    }
    const q = params.get('q');
    res.writeHead(302, { Location: `/api/admin/pet-shop${q ? `?q=${encodeURIComponent(q)}` : ''}` });
    res.end();
    return;
  }

  if (actionParam === 'pet_game_config_update') {
    const keys = params.getAll('config_key');
    const values = params.getAll('config_value');
    for (let i = 0; i < keys.length; i++) {
      await supabase.from('pet_game_config').update({ value: values[i] }).eq('key', keys[i]);
    }
    res.writeHead(302, { Location: '/api/admin/pet-shop' });
    res.end();
    return;
  }

  res.status(400).send('ไม่รู้จัก action นี้');
}

function renderLoginPage(error) {
  return `<!DOCTYPE html>
<html lang="th">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<link rel="stylesheet" href="/theme.css" />
<script src="/theme.js" defer></script>
<title>Admin Login</title>
<style>
  body { font-family: sans-serif; background: #f7f8fa; margin: 0; padding: 24px; color: #1b1f27; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
  .card { background: white; border-radius: 16px; padding: 32px; max-width: 360px; width: 100%; box-shadow: 0 1px 4px rgba(0,0,0,0.08); }
  h1 { font-size: 18px; margin: 0 0 20px; }
  label { display: block; font-size: 13px; color: #6b7280; margin-bottom: 4px; }
  input { width: 100%; box-sizing: border-box; padding: 10px 12px; border: 1px solid #e5e7eb; border-radius: 8px; margin-bottom: 16px; font-size: 14px; }
  button { width: 100%; background: #1b1f27; color: white; border: none; padding: 12px; border-radius: 8px; font-size: 14px; cursor: pointer; }
  .error { color: #e76f51; font-size: 13px; margin-bottom: 12px; }
</style>
</head>
<body>
  <div class="card">
    <h1>Admin Login</h1>
    ${error ? `<p class="error">${error}</p>` : ''}
    <form method="POST" action="/api/admin/action?action=login">
      <label>Username</label>
      <input type="text" name="username" required autofocus />
      <label>Password</label>
      <input type="password" name="password" required />
      <button type="submit">Log in</button>
    </form>
  </div>
</body>
</html>`;
}
