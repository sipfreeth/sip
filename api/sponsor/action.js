// api/sponsor/action.js
//
// ศูนย์รวม action ของฝั่ง Sponsor (รวมไฟล์เดียวแนวเดียวกับ admin/action.js และ office/action.js
// เพื่อประหยัดโควต้า Serverless Functions):
//   GET/POST ?action=signup              — สมัครสมาชิกใหม่
//   GET/POST ?action=login               — login
//   GET      ?action=logout              — logout
//   POST     ?action=update_profile      — แก้ข้อมูลบริษัท
//   POST     ?action=change_password     — เปลี่ยนรหัสผ่านตัวเอง
//   POST     ?action=get_upload_url      — ขอ signed URL อัปโหลดไฟล์เข้าคลัง Content
//   POST     ?action=save_content        — บันทึกไฟล์หลังอัปโหลดเสร็จ
//   POST     ?action=delete_content      — ลบไฟล์จากคลัง
//   POST     ?action=create_booking      — จองสล็อตใหม่ (ยังไม่ชำระเงิน)
//   POST     ?action=update_booking_content — เปลี่ยนไฟล์ที่แสดงของสล็อตที่จองไว้
//   POST     ?action=cancel_booking      — ยกเลิกสล็อตที่ยังไม่ชำระเงิน
//   POST     ?action=pay_by_card         — ชำระด้วยบัตร (Omise)
//   POST     ?action=pay_by_bank         — ชำระผ่านธนาคารออนไลน์ (Omise Internet Banking)
//   GET      ?action=omise_return        — จุดที่ Omise redirect กลับมาหลัง 3D Secure
//   POST     ?action=omise_webhook       — Omise ยิงมายืนยันผลการชำระ (ไม่ต้อง login เพราะ Omise เรียกเอง)
//   POST     ?action=get_slip_upload_url — ขอ signed URL อัปโหลดสลิปโอนเงิน
//   POST     ?action=verify_slip         — ส่งสลิปให้ SlipOK ตรวจสอบอัตโนมัติ

import bcrypt from 'bcryptjs';
import { supabase } from '../../lib/supabaseClient.js';
import { createSponsorSessionCookie, clearSponsorSessionCookie, requireSponsor } from '../../lib/sponsorAuth.js';
import {
  createUploadTarget,
  saveSponsorContent,
  createBookings,
  getBookingGroup,
  updateBookingContent,
  cancelUnpaidBooking,
  createSlipUploadTarget,
  downloadSlipBytes,
} from '../../lib/sponsorArea.js';
import { createOmiseCharge, getOmiseCharge, verifySlipWithSlipOK, createOmiseCustomer, attachCardToCustomer, listCustomerCards, setDefaultCard, deleteCustomerCard, getPromptPayQrImageUrl, createOmiseBankCharge, SUPPORTED_BANKS } from '../../lib/payments.js';
import { getSponsorCreditBalance, spendSponsorCredit } from '../../lib/sponsorArea.js';
import { sendEmail } from '../../lib/email.js';
import { createResetToken, verifyResetToken, markTokenUsed } from '../../lib/passwordReset.js';
import { sendMessage, getMessages, markThreadRead } from '../../lib/chat.js';

async function readBody(req) {
  let body = '';
  for await (const chunk of req) body += chunk;
  return new URLSearchParams(body);
}

export default async function handler(req, res) {
  const actionParam = req.query.action;

  // ---------- SIGNUP ----------
  if (actionParam === 'signup') {
    if (req.method === 'GET') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(200).send(renderSignupPage());
      return;
    }
    if (req.method === 'POST') {
      const params = await readBody(req);
      const email = (params.get('email') || '').trim().toLowerCase();

      if (params.get('agree_terms') !== 'on') {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.status(200).send(renderSignupPage('กรุณายืนยันว่าอ่านและยอมรับข้อกำหนดก่อนสมัครสมาชิก', params));
        return;
      }

      const { data: existing } = await supabase.from('sponsors').select('id').eq('email', email).maybeSingle();
      if (existing) {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.status(200).send(renderSignupPage('อีเมลนี้ถูกใช้สมัครไปแล้ว', params));
        return;
      }

      const hash = await bcrypt.hash(params.get('password'), 10);
      const { data: newSponsor, error } = await supabase
        .from('sponsors')
        .insert({
          company_name: params.get('company_name'),
          tax_id: params.get('tax_id') || null,
          address: params.get('address') || null,
          contact_name: params.get('contact_name') || null,
          contact_phone: params.get('contact_phone') || null,
          business_type: params.get('business_type') || null,
          email,
          password_hash: hash,
          terms_accepted_at: new Date().toISOString(),
        })
        .select('id')
        .single();

      if (error) {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.status(200).send(renderSignupPage('สมัครไม่สำเร็จ ลองใหม่อีกครั้ง', params));
        return;
      }

      res.setHeader('Set-Cookie', createSponsorSessionCookie(newSponsor.id));
      res.writeHead(302, { Location: '/api/sponsor?page=profile' });
      res.end();
      return;
    }
    res.status(405).send('Method not allowed');
    return;
  }

  // ---------- LOGIN ----------
  if (actionParam === 'login') {
    if (req.method === 'GET') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(200).send(renderLoginPage());
      return;
    }
    if (req.method === 'POST') {
      const params = await readBody(req);
      const email = (params.get('email') || '').trim().toLowerCase();
      const password = params.get('password') || '';

      const { data: sponsor } = await supabase.from('sponsors').select('id, password_hash').eq('email', email).maybeSingle();
      const valid = sponsor ? await bcrypt.compare(password, sponsor.password_hash) : false;

      if (!sponsor || !valid) {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.status(200).send(renderLoginPage('อีเมลหรือรหัสผ่านไม่ถูกต้อง'));
        return;
      }

      res.setHeader('Set-Cookie', createSponsorSessionCookie(sponsor.id));
      res.writeHead(302, { Location: '/api/sponsor' });
      res.end();
      return;
    }
    res.status(405).send('Method not allowed');
    return;
  }

  // ---------- ลืมรหัสผ่าน: ขอลิงก์รีเซ็ต ----------
  if (actionParam === 'forgot_password') {
    if (req.method === 'GET') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(200).send(renderForgotPasswordPage());
      return;
    }
    if (req.method === 'POST') {
      const params = await readBody(req);
      const email = (params.get('email') || '').trim().toLowerCase();

      const { data: found } = await supabase.from('sponsors').select('id').eq('email', email).maybeSingle();
      if (found) {
        const token = createResetToken('sponsor', found.id);
        const resetLink = `${process.env.APP_BASE_URL}/api/sponsor/action?action=reset_password&token=${token}`;
        try {
          await sendEmail({
            to: email,
            subject: 'รีเซ็ตรหัสผ่านบัญชี Sponsor',
            html: `<p>คลิกลิงก์นี้เพื่อตั้งรหัสผ่านใหม่ (ลิงก์นี้ใช้ได้ 30 นาที):</p><p><a href="${resetLink}">${resetLink}</a></p><p>ถ้าไม่ได้ขอรีเซ็ตรหัสผ่าน ไม่ต้องทำอะไรเพิ่มครับ</p>`,
          });
        } catch (err) {
          console.error('ส่งอีเมลไม่สำเร็จ:', err.message);
        }
      }

      // ข้อความเดียวกันไม่ว่าจะเจออีเมลนี้ในระบบหรือไม่ (กันคนสุ่มเช็คว่าอีเมลไหนสมัครไว้บ้าง)
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(200).send(renderForgotPasswordPage(null, 'ถ้าอีเมลนี้มีอยู่ในระบบ เราได้ส่งลิงก์รีเซ็ตรหัสผ่านไปให้แล้ว กรุณาเช็คกล่องอีเมล'));
      return;
    }
    res.status(405).send('Method not allowed');
    return;
  }

  // ---------- ลืมรหัสผ่าน: ตั้งรหัสผ่านใหม่จากลิงก์ ----------
  if (actionParam === 'reset_password') {
    if (req.method === 'GET') {
      const valid = await verifyResetToken(req.query.token);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(200).send(renderResetPasswordPage(req.query.token, valid ? null : 'ลิงก์นี้หมดอายุหรือถูกใช้ไปแล้ว กรุณาขอลิงก์ใหม่'));
      return;
    }
    if (req.method === 'POST') {
      const params = await readBody(req);
      const tokenData = await verifyResetToken(params.get('token'));
      if (!tokenData || tokenData.accountType !== 'sponsor') {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.status(200).send(renderResetPasswordPage(null, 'ลิงก์นี้หมดอายุหรือถูกใช้ไปแล้ว กรุณาขอลิงก์ใหม่'));
        return;
      }

      const hash = await bcrypt.hash(params.get('new_password'), 10);
      await supabase.from('sponsors').update({ password_hash: hash }).eq('id', tokenData.accountId);
      await markTokenUsed(tokenData.tokenHash);

      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(200).send(renderResetSuccessPage());
      return;
    }
    res.status(405).send('Method not allowed');
    return;
  }

  // ---------- LOGOUT ----------
  if (actionParam === 'logout') {
    res.setHeader('Set-Cookie', clearSponsorSessionCookie());
    res.writeHead(302, { Location: '/api/sponsor/action?action=login' });
    res.end();
    return;
  }

  // ---------- OMISE WEBHOOK (public — Omise เรียกเอง ไม่มี session cookie ของเรา) ----------
  if (actionParam === 'omise_webhook') {
    if (req.method !== 'POST') {
      res.status(405).send('Method not allowed');
      return;
    }
    let raw = '';
    for await (const chunk of req) raw += chunk;
    let event;
    try {
      event = JSON.parse(raw);
    } catch {
      res.status(400).send('bad payload');
      return;
    }

    const charge = event?.data;
    if (charge?.object === 'charge' && charge.id && charge.paid) {
      await supabase
        .from('slot_bookings')
        .update({ payment_status: 'paid', payment_method: 'omise' })
        .eq('omise_charge_id', charge.id);
    }
    res.status(200).send('ok');
    return;
  }

  // ---------- ต่อจากนี้ต้อง login ก่อน ----------
  const sponsor = await requireSponsor(req, res);
  if (!sponsor) return;

  // ---------- OMISE RETURN (redirect กลับมาจากหน้า 3D Secure ของธนาคาร) ----------
  if (actionParam === 'omise_return') {
    const groupId = req.query.group_id;
    const creditApplied = parseFloat(req.query.credit) || 0;
    const group = await getBookingGroup(groupId, sponsor.id);
    const chargeId = group[0]?.omise_charge_id;
    if (!chargeId) {
      res.writeHead(302, { Location: '/api/sponsor?page=bookings' });
      res.end();
      return;
    }
    try {
      const charge = await getOmiseCharge(chargeId);
      if (charge.paid) {
        if (creditApplied > 0) await spendSponsorCredit(sponsor.id, creditApplied, `used_for_booking_group:${groupId}`);
        await supabase
          .from('slot_bookings')
          .update({ payment_status: 'paid', payment_method: creditApplied > 0 ? 'card+credit' : 'omise' })
          .eq('booking_group_id', groupId);
      }
    } catch (err) {
      console.error('เช็คสถานะ Omise ไม่สำเร็จ:', err.message);
    }
    res.writeHead(302, { Location: '/api/sponsor?page=bookings' });
    res.end();
    return;
  }

  // ---------- Poll แชท (GET เพื่อรีเฟรชข้อความถี่ๆ) ----------
  if (actionParam === 'chat_poll' && req.method === 'GET') {
    const messages = await getMessages('sponsor', sponsor.id);
    await markThreadRead('sponsor', sponsor.id, 'party');
    res.setHeader('Content-Type', 'application/json');
    res.status(200).json({ messages });
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).send('Method not allowed');
    return;
  }

  const params = await readBody(req);

  if (actionParam === 'update_profile') {
    await supabase
      .from('sponsors')
      .update({
        company_name: params.get('company_name'),
        tax_id: params.get('tax_id') || null,
        address: params.get('address') || null,
        contact_name: params.get('contact_name') || null,
        contact_phone: params.get('contact_phone') || null,
        business_type: params.get('business_type') || null,
      })
      .eq('id', sponsor.id);
    res.writeHead(302, { Location: '/api/sponsor?page=profile' });
    res.end();
    return;
  }

  if (actionParam === 'change_password') {
    const valid = await bcrypt.compare(params.get('current_password') || '', sponsor.password_hash);
    if (!valid) {
      res.status(400).send('รหัสผ่านปัจจุบันไม่ถูกต้อง');
      return;
    }
    const hash = await bcrypt.hash(params.get('new_password'), 10);
    await supabase.from('sponsors').update({ password_hash: hash }).eq('id', sponsor.id);
    res.writeHead(302, { Location: '/api/sponsor?page=profile' });
    res.end();
    return;
  }

  if (actionParam === 'get_upload_url') {
    try {
      const target = await createUploadTarget(sponsor.id, params.get('file_name') || 'file');
      res.setHeader('Content-Type', 'application/json');
      res.status(200).send(JSON.stringify(target));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
    return;
  }

  if (actionParam === 'save_content') {
    try {
      await saveSponsorContent({
        sponsorId: sponsor.id,
        fileName: params.get('file_name'),
        filePath: params.get('file_path'),
        fileType: params.get('file_type'),
        creativeId: params.get('creative_id') || null,
      });
      res.status(200).send('ok');
    } catch (err) {
      res.status(400).send(err.message);
    }
    return;
  }

  if (actionParam === 'delete_content') {
    await supabase.from('sponsor_content').delete().eq('id', params.get('content_id')).eq('sponsor_id', sponsor.id);
    res.writeHead(302, { Location: '/api/sponsor?page=content' });
    res.end();
    return;
  }

  if (actionParam === 'create_bookings') {
    const officeId = params.get('office_id');
    const slotNumbers = (params.get('slot_numbers') || '')
      .split(',')
      .filter(Boolean)
      .map(Number);
    const weekStart = params.get('week_start');

    if (!slotNumbers.length) {
      res.status(400).send('กรุณาเลือกอย่างน้อย 1 slot');
      return;
    }

    // เช็คไฟล์ที่เลือกของแต่ละ slot แยกกัน — แค่ต้องเป็นของ sponsor คนนี้จริง (ไม่ต้องอนุมัติก่อนแล้ว — จะไปอนุมัติตอนตรวจสอบการจอง)
    const { data: ownedRows } = await supabase
      .from('sponsor_content')
      .select('id')
      .eq('sponsor_id', sponsor.id)
      .order('created_at', { ascending: false });
    const ownedIds = new Set((ownedRows || []).map((r) => r.id));
    const fallbackContentId = ownedRows && ownedRows.length ? ownedRows[0].id : null;

    const slotContentMap = {};
    for (const slotNumber of slotNumbers) {
      let contentId = params.get(`content_slot_${slotNumber}`);
      // เผื่อ dropdown ของ slot นี้ไม่ได้ถูกเลือกมา (เช่น JS พลาด) — ใช้ไฟล์ล่าสุดในคลังแทนแล้วให้แก้ทีหลังได้ในแท็บ "สล็อตของฉัน"
      if ((!contentId || !ownedIds.has(contentId)) && fallbackContentId) contentId = fallbackContentId;

      if (!contentId || !ownedIds.has(contentId)) {
        res.status(400).send(`กรุณาอัปโหลดไฟล์เข้าคลัง Content ก่อนถึงจะจองได้ (Slot ${slotNumber})`);
        return;
      }
      slotContentMap[slotNumber] = contentId;
    }

    const { data: office } = await supabase.from('office_accounts').select('price_per_week').eq('id', officeId).single();
    if (!office) {
      res.status(404).send('ไม่พบ Office นี้');
      return;
    }

    let groupId;
    try {
      const result = await createBookings({
        sponsorId: sponsor.id,
        officeAccountId: officeId,
        slotNumbers,
        weekStart,
        slotContentMap,
        pricePerSlot: office.price_per_week,
      });
      groupId = result.groupId;
    } catch (err) {
      res.status(400).send(err.message || 'จองไม่สำเร็จ ลองเลือกช่วงอื่น');
      return;
    }

    // จองเสร็จแล้ว พาไปหน้าชำระเงินของรายการนี้ทันที (จ่ายรวมทีเดียวทั้งกลุ่ม)
    res.writeHead(302, { Location: `/api/sponsor?page=bookings&pay=${groupId}` });
    res.end();
    return;
  }

  if (actionParam === 'update_booking_content') {
    const contentId = params.get('sponsor_content_id');
    const { data: contentRow } = await supabase
      .from('sponsor_content')
      .select('id')
      .eq('id', contentId)
      .eq('sponsor_id', sponsor.id)
      .maybeSingle();
    if (!contentRow) {
      res.status(400).send('ไม่ใช่ไฟล์ของบัญชีคุณ');
      return;
    }
    try {
      await updateBookingContent(params.get('booking_id'), sponsor.id, contentId);
    } catch (err) {
      res.status(400).send(err.message);
      return;
    }
    res.writeHead(302, { Location: '/api/sponsor?page=bookings' });
    res.end();
    return;
  }

  // ---------- แชทกับทีมงาน ----------
  if (actionParam === 'chat_send') {
    try {
      await sendMessage({
        threadType: 'sponsor',
        threadId: sponsor.id,
        senderType: 'sponsor',
        senderLabel: `Sponsor ${sponsor.company_name}`,
        message: params.get('message'),
      });
    } catch (err) {
      res.status(400).send(err.message);
      return;
    }
    res.status(200).send('ok');
    return;
  }

  if (actionParam === 'cancel_booking') {
    await cancelUnpaidBooking(params.get('booking_id'), sponsor.id);
    res.writeHead(302, { Location: '/api/sponsor?page=bookings' });
    res.end();
    return;
  }

  // ---------- ชำระด้วยบัตร (Omise) — รองรับทั้งบัตรบันทึกไว้และบัตรใหม่ + ใช้เครดิตร่วมได้ ----------
  if (actionParam === 'pay_by_card') {
    const groupId = params.get('group_id');
    const group = await getBookingGroup(groupId, sponsor.id);
    if (!group.length) {
      res.status(404).json({ error: 'ไม่พบรายการจองนี้' });
      return;
    }
    if (group[0].payment_status === 'paid') {
      res.status(200).json({ paid: true });
      return;
    }
    const totalPrice = group.reduce((sum, b) => sum + Number(b.price), 0);

    // เช็คเครดิตที่จะใช้ (ถ้ามี) แล้วคำนวณยอดที่เหลือต้องตัดผ่านบัตรจริง
    const creditBalance = await getSponsorCreditBalance(sponsor.id);
    const creditToApply = Math.min(Math.max(0, parseFloat(params.get('credit_to_apply')) || 0), creditBalance, totalPrice);
    const amountToCharge = Math.round((totalPrice - creditToApply) * 100) / 100;

    const cardId = params.get('card_id'); // ถ้าเลือกบัตรที่บันทึกไว้แล้ว
    const token = params.get('omise_token'); // ถ้าเป็นบัตรใหม่
    const shouldSaveCard = params.get('save_card') === '1';

    try {
      let customerId = sponsor.omise_customer_id;
      let chargeCardId = cardId || null;

      // บัตรใหม่ + อยากบันทึกไว้ → สร้าง/ผูกเข้ากับ Customer ก่อน
      if (!cardId && token && shouldSaveCard) {
        if (!customerId) {
          const customer = await createOmiseCustomer({ email: sponsor.email, token });
          customerId = customer.id;
          await supabase.from('sponsors').update({ omise_customer_id: customerId }).eq('id', sponsor.id);
          chargeCardId = customer.cards?.data?.[0]?.id || null;
        } else {
          const customer = await attachCardToCustomer(customerId, token);
          chargeCardId = customer.cards?.data?.[customer.cards.data.length - 1]?.id || null;
        }
      }

      let charge;
      if (amountToCharge <= 0) {
        // เครดิตครอบยอดเต็มพอดี ไม่ต้องตัดบัตรเลย
        charge = { paid: true, id: null };
      } else if (cardId || chargeCardId) {
        // จ่ายด้วยบัตรที่บันทึกไว้ (เดิมหรือที่เพิ่งบันทึกใหม่)
        const returnUri = `${process.env.APP_BASE_URL}/api/sponsor/action?action=omise_return&group_id=${groupId}&credit=${creditToApply}`;
        charge = await createOmiseCharge({
          amountBaht: amountToCharge,
          customerId,
          cardId: cardId || chargeCardId,
          returnUri,
          description: `Booking group ${groupId}`,
        });
      } else {
        // บัตรใหม่ ไม่บันทึก (จ่ายครั้งเดียว)
        const returnUri = `${process.env.APP_BASE_URL}/api/sponsor/action?action=omise_return&group_id=${groupId}&credit=${creditToApply}`;
        charge = await createOmiseCharge({
          amountBaht: amountToCharge,
          token,
          returnUri,
          description: `Booking group ${groupId}`,
        });
      }

      if (charge.id) {
        await supabase.from('slot_bookings').update({ omise_charge_id: charge.id }).eq('booking_group_id', groupId);
      }

      if (charge.authorize_uri) {
        // ต้องยืนยันตัวตนแบบ 3D Secure ก่อน — ค่าเครดิตที่จะหักส่งไปกับ return_uri แล้ว จัดการต่อตอนกลับมาที่ omise_return
        res.status(200).json({ redirect: charge.authorize_uri });
        return;
      }

      if (charge.paid) {
        if (creditToApply > 0) await spendSponsorCredit(sponsor.id, creditToApply, `used_for_booking_group:${groupId}`);
        await supabase
          .from('slot_bookings')
          .update({ payment_status: 'paid', payment_method: creditToApply > 0 ? 'card+credit' : 'omise' })
          .eq('booking_group_id', groupId);
        res.status(200).json({ paid: true });
        return;
      }

      res.status(200).json({ paid: false, message: charge.failure_message || 'การชำระเงินไม่สำเร็จ' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
    return;
  }

  // ---------- ชำระผ่านธนาคารออนไลน์ (Omise Internet Banking) — ครั้งเดียว ไม่ผูกบัญชีถาวร ----------
  if (actionParam === 'pay_by_bank') {
    const groupId = params.get('group_id');
    const group = await getBookingGroup(groupId, sponsor.id);
    if (!group.length) {
      res.status(404).json({ error: 'ไม่พบรายการจองนี้' });
      return;
    }
    if (group[0].payment_status === 'paid') {
      res.status(200).json({ paid: true });
      return;
    }
    const totalPrice = group.reduce((sum, b) => sum + Number(b.price), 0);

    const bankCode = params.get('bank_code');
    if (!SUPPORTED_BANKS.some((b) => b.code === bankCode)) {
      res.status(400).json({ error: 'ไม่รองรับธนาคารนี้' });
      return;
    }

    const creditBalance = await getSponsorCreditBalance(sponsor.id);
    const creditToApply = Math.min(Math.max(0, parseFloat(params.get('credit_to_apply')) || 0), creditBalance, totalPrice);
    const amountToCharge = Math.round((totalPrice - creditToApply) * 100) / 100;

    if (amountToCharge <= 0) {
      // เครดิตครอบยอดเต็มพอดี ไม่ต้องผ่านธนาคารเลย
      await spendSponsorCredit(sponsor.id, creditToApply, `used_for_booking_group:${groupId}`);
      await supabase.from('slot_bookings').update({ payment_status: 'paid', payment_method: 'credit' }).eq('booking_group_id', groupId);
      res.status(200).json({ paid: true });
      return;
    }

    try {
      const returnUri = `${process.env.APP_BASE_URL}/api/sponsor/action?action=omise_return&group_id=${groupId}&credit=${creditToApply}`;
      const charge = await createOmiseBankCharge({
        amountBaht: amountToCharge,
        bankCode,
        returnUri,
        description: `Booking group ${groupId}`,
      });

      await supabase.from('slot_bookings').update({ omise_charge_id: charge.id }).eq('booking_group_id', groupId);

      if (charge.authorize_uri) {
        res.status(200).json({ redirect: charge.authorize_uri });
        return;
      }

      res.status(200).json({ paid: false, message: 'ไม่ได้รับลิงก์ไปหน้าธนาคาร กรุณาลองใหม่' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
    return;
  }

  // ---------- ชำระด้วยเครดิตล้วน (ไม่ต้องผ่านบัตร/โอนเงินเลย) ----------
  if (actionParam === 'pay_with_credit') {
    const groupId = params.get('group_id');
    const group = await getBookingGroup(groupId, sponsor.id);
    if (!group.length) {
      res.status(404).json({ error: 'ไม่พบรายการจองนี้' });
      return;
    }
    if (group[0].payment_status === 'paid') {
      res.status(200).json({ paid: true });
      return;
    }
    const totalPrice = group.reduce((sum, b) => sum + Number(b.price), 0);
    const creditBalance = await getSponsorCreditBalance(sponsor.id);

    if (creditBalance < totalPrice) {
      res.status(400).json({ error: 'เครดิตไม่พอสำหรับยอดนี้' });
      return;
    }

    await spendSponsorCredit(sponsor.id, totalPrice, `used_for_booking_group:${groupId}`);
    await supabase.from('slot_bookings').update({ payment_status: 'paid', payment_method: 'credit' }).eq('booking_group_id', groupId);
    res.status(200).json({ paid: true });
    return;
  }

  // ---------- จัดการบัตรที่บันทึกไว้ (แท็บ Profile) ----------
  if (actionParam === 'set_default_card') {
    if (sponsor.omise_customer_id) {
      try {
        await setDefaultCard(sponsor.omise_customer_id, params.get('card_id'));
      } catch (err) {
        res.status(500).send(err.message);
        return;
      }
    }
    res.writeHead(302, { Location: '/api/sponsor?page=profile' });
    res.end();
    return;
  }

  if (actionParam === 'remove_card') {
    if (sponsor.omise_customer_id) {
      try {
        await deleteCustomerCard(sponsor.omise_customer_id, params.get('card_id'));
      } catch (err) {
        res.status(500).send(err.message);
        return;
      }
    }
    res.writeHead(302, { Location: '/api/sponsor?page=profile' });
    res.end();
    return;
  }

  // ---------- PromptPay QR (คืนภาพ QR ตามยอดที่ต้องจ่ายจริง) ----------
  if (actionParam === 'promptpay_qr') {
    const amount = parseFloat(req.query.amount);
    const qrUrl = getPromptPayQrImageUrl(amount > 0 ? amount : 0);
    if (!qrUrl) {
      res.status(404).send('PromptPay ยังไม่ได้ตั้งค่า');
      return;
    }
    res.writeHead(302, { Location: qrUrl });
    res.end();
    return;
  }

  // ---------- อัปโหลด + ตรวจสอบสลิปโอนเงิน (SlipOK) ----------
  if (actionParam === 'get_slip_upload_url') {
    const groupId = params.get('group_id');
    const group = await getBookingGroup(groupId, sponsor.id);
    if (!group.length) {
      res.status(404).json({ error: 'ไม่พบรายการจองนี้' });
      return;
    }
    try {
      const target = await createSlipUploadTarget(sponsor.id, groupId, params.get('file_name') || 'slip.jpg');
      res.status(200).json(target);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
    return;
  }

  if (actionParam === 'verify_slip') {
    const groupId = params.get('group_id');
    const group = await getBookingGroup(groupId, sponsor.id);
    if (!group.length) {
      res.status(404).json({ error: 'ไม่พบรายการจองนี้' });
      return;
    }
    const totalPrice = group.reduce((sum, b) => sum + Number(b.price), 0);
    const creditBalance = await getSponsorCreditBalance(sponsor.id);
    const creditToApply = Math.min(Math.max(0, parseFloat(params.get('credit_to_apply')) || 0), creditBalance, totalPrice);
    const expectedAmount = Math.round((totalPrice - creditToApply) * 100) / 100;

    const filePath = params.get('file_path');
    try {
      const fileBytes = await downloadSlipBytes(filePath);
      const result = await verifySlipWithSlipOK({
        fileBytes,
        fileName: 'slip.jpg',
        expectedAmount,
      });

      await supabase
        .from('slot_bookings')
        .update({ payment_slip_path: filePath, payment_verification: result })
        .eq('booking_group_id', groupId);

      const isValid = result.success && result.data?.success;
      if (isValid) {
        if (creditToApply > 0) await spendSponsorCredit(sponsor.id, creditToApply, `used_for_booking_group:${groupId}`);
        await supabase
          .from('slot_bookings')
          .update({ payment_status: 'paid', payment_method: creditToApply > 0 ? 'transfer+credit' : 'transfer', payment_reference: result.data.transRef })
          .eq('booking_group_id', groupId);
        res.status(200).json({ paid: true });
        return;
      }

      res.status(200).json({ paid: false, message: result.data?.message || 'ตรวจสอบสลิปไม่ผ่าน' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
    return;
  }

  // ---------- สร้าง QR แคมเปญของตัวเอง (พาไปปลายทาง หรือโชว์โค้ดโปรโมชั่น) ----------
  if (actionParam === 'qr_campaign_create') {
    const campaignType = params.get('campaign_type');
    if (!['link', 'promo_code'].includes(campaignType)) {
      res.status(400).send('ประเภทแคมเปญไม่ถูกต้อง');
      return;
    }

    // สร้าง creative_id ที่ไม่ซ้ำ อิงจาก Sponsor Code + สุ่มสั้นๆ อ่านง่ายพอสมควร
    const creativeId = `sp${sponsor.sponsor_code}-${Math.random().toString(36).slice(2, 8)}`;

    const insertData = {
      creative_id: creativeId,
      sponsor_id: sponsor.id,
      campaign_name: params.get('campaign_name') || null,
      campaign_type: campaignType,
      active: true,
    };

    if (campaignType === 'link') {
      const destination = params.get('destination_url');
      if (!destination) {
        res.status(400).send('กรุณากรอกลิงก์ปลายทาง');
        return;
      }
      insertData.destination_url = destination;
    } else {
      const promoCode = params.get('promo_code');
      if (!promoCode) {
        res.status(400).send('กรุณากรอกโค้ดโปรโมชั่น');
        return;
      }
      insertData.promo_code = promoCode;
      insertData.promo_instructions = params.get('promo_instructions') || null;
    }

    const { error } = await supabase.from('creatives').insert(insertData);
    if (error) {
      res.status(400).send(`สร้างแคมเปญไม่สำเร็จ: ${error.message}`);
      return;
    }
    res.writeHead(302, { Location: '/api/sponsor?page=qr' });
    res.end();
    return;
  }

  if (actionParam === 'qr_campaign_toggle') {
    const { data: campaign } = await supabase
      .from('creatives')
      .select('active')
      .eq('creative_id', params.get('creative_id'))
      .eq('sponsor_id', sponsor.id)
      .maybeSingle();
    if (!campaign) {
      res.status(404).send('ไม่พบแคมเปญนี้');
      return;
    }
    await supabase.from('creatives').update({ active: !campaign.active }).eq('creative_id', params.get('creative_id')).eq('sponsor_id', sponsor.id);
    res.writeHead(302, { Location: '/api/sponsor?page=qr' });
    res.end();
    return;
  }

  res.status(400).send('ไม่รู้จัก action นี้');
}

const TERMS_CONTENT = `
<h3>ข้อกำหนดและนโยบายการแสดงผลเนื้อหา (Content &amp; Display Guidelines)</h3>
<p>เอกสารฉบับนี้จัดทำขึ้นเพื่อกำหนดมาตรฐาน ขอบเขต ข้อจำกัดของเนื้อหา รวมถึงข้อตกลงในการป้องกันความขัดแย้งทางผลประโยชน์ ที่จะถูกเผยแพร่ผ่านเครือข่ายหน้าจอดิจิทัล (Digital Screen Network) ภายในพื้นที่สำนักงาน เพื่อรักษาภาพลักษณ์อันดี ปกป้องความปลอดภัยขององค์กร และป้องกันผลกระทบทางกฎหมาย</p>

<h4>หมวดที่ 1: เนื้อหาที่ห้ามเผยแพร่เด็ดขาด (Prohibited Content)</h4>
<p>ห้ามนำเข้า ส่งออก แพร่ภาพ หรือแสดงผลคอนเทนต์ที่มีลักษณะดังต่อไปนี้บนหน้าจอเด็ดขาด:</p>
<p><strong>1.1 ความผิดทางกฎหมายและความมั่นคง</strong><br/>
การละเมิดกฎหมายทุกประเภท รวมถึง พ.ร.บ. ว่าด้วยการกระทำความผิดเกี่ยวกับคอมพิวเตอร์ — ทรัพย์สินทางปัญญาที่ละเมิดลิขสิทธิ์ของบุคคลอื่นโดยไม่ได้รับอนุญาต — การเมืองและการเลือกตั้งในทุกรูปแบบ — การพนันและสิ่งผิดกฎหมาย ยาเสพติด อาวุธปืน</p>
<p><strong>1.2 ศีลธรรม ความปลอดภัย และสุขอนามัย</strong><br/>
เนื้อหาลามกอนาจาร (NSFW) — ความรุนแรงและความน่ากลัว — แอลกอฮอล์ ยาสูบ และสารมึนเมา</p>
<p><strong>1.3 ธุรกิจสีเทาและการเงินที่มีความเสี่ยงสูง</strong><br/>
คริปโตเคอร์เรนซี/โทเคนดิจิทัลที่ไม่มีใบอนุญาต — สินเชื่อนอกระบบและแชร์ลูกโซ่ — ผลิตภัณฑ์สุขภาพที่กล่าวอ้างสรรพคุณเกินจริงหรือไม่ได้รับอนุญาตจาก อย.</p>

<h4>หมวดที่ 2: มาตรฐานความเหมาะสมในพื้นที่สำนักงาน (Workplace Appropriateness)</h4>
<p><strong>2.1 พฤติกรรมและสังคม</strong><br/>
ห้าม Hate Speech & Discrimination — ห้ามโฆษณาที่พาดพิงหรือโจมตีคู่แข่งในลักษณะเสียหาย — ห้ามเนื้อหาที่สร้างความตื่นตระหนกหรือข่าวปลอม</p>
<p><strong>2.2 เทคนิคและการรบกวนทางสายตา</strong><br/>
ห้ามการกะพริบถี่ๆ ที่อาจเป็นอันตรายต่อผู้ป่วยลมชัก — ตัวหนังสือต้องอ่านง่าย ห้ามตัววิ่งที่เร็วเกินไป — หลีกเลี่ยงโทนสีฉูดฉาดเกินความจำเป็น</p>

<h4>หมวดที่ 3: ข้อกำหนดการจำกัดการแสดงผลโฆษณาและคู่แข่งทางธุรกิจ</h4>
<p><strong>3.1</strong> สปอนเซอร์ไม่มีสิทธิ์เจาะจงหรือบังคับให้นำโฆษณาไปแสดงในสำนักงานของคู่แข่งทางธุรกิจโดยตรง ผู้ให้บริการมีระบบคัดกรองป้องกันไว้</p>
<p><strong>3.2</strong> ผู้ให้บริการมีสิทธิ์ปฏิเสธเนื้อหาที่มีความเสี่ยงก่อให้เกิดความขัดแย้งทางผลประโยชน์ได้ทันที โดยผู้สนับสนุนไม่มีสิทธิ์เรียกร้องค่าเสียหาย</p>
<p><strong>3.3</strong> หากพบเนื้อหาไปปรากฏในสำนักงานคู่แข่ง สปอนเซอร์แจ้งขอถอดถอนได้ทันที ผู้ให้บริการจะดำเนินการแก้ไขในเวลาอันสมควร</p>

<h4>หมวดที่ 4: ข้อตกลงห้ามแข่งขัน (Non-Competition Agreement)</h4>
<p><strong>4.1</strong> ห้ามนำโมเดลธุรกิจ ซอฟต์แวร์ ระบบ CMS หรือโครงข่ายไปใช้ทำธุรกิจแข่งขันไม่ว่าทางตรงหรือทางอ้อม — ห้ามใช้ประโยชน์จากข้อมูลตำแหน่งออฟฟิศ รายชื่อผู้ติดต่อ หรือข้อมูลวิเคราะห์นอกขอบเขตความร่วมมือ</p>
<p><strong>4.2</strong> ห้ามติดต่อชักชวนพาร์ทเนอร์หรือบุคลากรของผู้ให้บริการโดยตรงในระหว่างสัญญาและหลังสิ้นสุดสัญญาตามระยะเวลาที่กำหนด</p>
<p><strong>4.3</strong> การฝ่าฝืนข้อตกลงห้ามแข่งขัน ผู้ให้บริการมีสิทธิ์บอกเลิกสัญญาทันทีและเรียกค่าเสียหายที่เกิดขึ้นจริงรวมค่าใช้จ่ายทางกฎหมาย</p>

<h4>หมวดที่ 5: กระบวนการตรวจสอบและบทลงโทษทั่วไป</h4>
<p>ผู้ลงโฆษณาต้องส่งไฟล์คอนเทนต์ให้ตรวจสอบล่วงหน้าก่อนวันฉายจริง ผู้ให้บริการมีสิทธิ์ปฏิเสธการเผยแพร่ทันทีหากขัดต่อข้อกำหนด และมีอำนาจถอดถอนฉุกเฉิน (Emergency Kill-Switch) ได้โดยไม่ต้องแจ้งล่วงหน้าหากพบผลกระทบทางลบภายหลัง หากฝ่าฝืนซ้ำซ้อนผู้ให้บริการมีสิทธิ์ระงับบริการทันที</p>

<h4>หมวดที่ 6: การรับรองสิทธิ์ในทรัพย์สินทางปัญญาของผู้ลงโฆษณา</h4>
<p>ผู้ลงโฆษณารับรองและยืนยันว่าเนื้อหา ภาพ วิดีโอ ข้อความ เพลง หรือทรัพย์สินทางปัญญาใดๆ ที่อัปโหลดเข้าสู่ระบบ เป็นทรัพย์สินของตนเองหรือได้รับอนุญาตให้ใช้งานโดยถูกต้องตามกฎหมาย หากมีข้อพิพาทด้านลิขสิทธิ์หรือทรัพย์สินทางปัญญาเกิดขึ้นจากเนื้อหาที่อัปโหลด ผู้ลงโฆษณาต้องเป็นผู้รับผิดชอบแต่เพียงผู้เดียว และต้องชดใช้ค่าเสียหายที่เกิดขึ้นกับผู้ให้บริการหรือบุคคลที่สาม</p>

<h4>หมวดที่ 7: การเก็บและการลบข้อมูลหลังสิ้นสุดสัญญา</h4>
<p>เมื่อสัญญาสิ้นสุดหรือบัญชีถูกยกเลิกไม่ว่าด้วยเหตุใด ผู้ให้บริการจะเก็บรักษาข้อมูลบัญชี ประวัติการจอง และไฟล์เนื้อหาไว้ต่ออีกระยะเวลาหนึ่งตามความจำเป็นทางบัญชีและกฎหมาย หลังจากนั้นข้อมูลจะถูกลบออกจากระบบตามรอบการดูแลระบบตามปกติ ผู้ลงโฆษณาสามารถร้องขอสำเนาข้อมูลหรือขอให้ลบข้อมูลก่อนกำหนดได้โดยติดต่อทีมงาน ทั้งนี้ข้อมูลบางส่วนอาจต้องเก็บไว้ต่อตามที่กฎหมายกำหนด</p>

<h4>หมวดที่ 8: ข้อจำกัดความรับผิดของผู้ให้บริการ</h4>
<p>ผู้ให้บริการจะดำเนินการด้วยความระมัดระวังตามสมควรในการให้บริการระบบ แต่ไม่รับประกันว่าระบบจะทำงานได้อย่างต่อเนื่องปราศจากข้อผิดพลาดตลอดเวลา ผู้ให้บริการไม่รับผิดชอบต่อความเสียหายทางอ้อม การสูญเสียโอกาสทางธุรกิจ หรือความเสียหายที่เกิดจากเหตุสุดวิสัยที่อยู่นอกเหนือการควบคุม ความรับผิดของผู้ให้บริการในทุกกรณีจะไม่เกินมูลค่าที่ผู้ลงโฆษณาชำระจริงสำหรับการจองที่เกี่ยวข้อง</p>

<h4>หมวดที่ 9: การเปลี่ยนแปลงข้อกำหนด</h4>
<p>ผู้ให้บริการสงวนสิทธิ์ในการปรับปรุงหรือเปลี่ยนแปลงข้อกำหนดฉบับนี้ได้ตามความเหมาะสม โดยจะแจ้งให้ผู้ลงโฆษณาทราบล่วงหน้าผ่านช่องทางที่ลงทะเบียนไว้ (เช่น อีเมล หรือประกาศในระบบ) ก่อนมีผลบังคับใช้ตามระยะเวลาอันสมควร การใช้งานระบบต่อไปหลังการเปลี่ยนแปลงมีผลบังคับใช้ ถือว่าผู้ลงโฆษณายอมรับข้อกำหนดฉบับใหม่แล้ว</p>
`;

function renderSignupPage(error, formValues) {
  const v = (name) => (formValues ? (formValues.get(name) || '') : '');
  return `<!DOCTYPE html>
<html lang="th">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<link rel="stylesheet" href="/theme.css" />
<script src="/theme.js" defer></script>
<title>สมัครสมาชิก Sponsor</title>
<style>
  body { font-family: sans-serif; background: #f7f8fa; margin: 0; padding: 24px; color: #1b1f27; }
  .card { background: white; border-radius: 16px; padding: 32px; max-width: 440px; margin: 24px auto; box-shadow: 0 1px 4px rgba(0,0,0,0.08); }
  h1 { font-size: 18px; margin: 0 0 20px; }
  label { display: block; font-size: 13px; color: #6b7280; margin: 12px 0 4px; }
  input { width: 100%; box-sizing: border-box; padding: 10px 12px; border: 1px solid #e5e7eb; border-radius: 8px; font-size: 14px; }
  button { width: 100%; background: #1b1f27; color: white; border: none; padding: 12px; border-radius: 8px; font-size: 14px; cursor: pointer; margin-top: 20px; }
  .error { color: #e76f51; font-size: 13px; margin-bottom: 12px; }
  .link { text-align: center; margin-top: 16px; font-size: 13px; }
  .terms-row { display: flex; align-items: flex-start; gap: 8px; margin-top: 16px; font-size: 13px; }
  .terms-row input { width: auto; margin-top: 2px; }
  .terms-link { color: #2a78d6; text-decoration: underline; cursor: pointer; background: none; border: none; padding: 0; font-size: 13px; }

  .modal-overlay { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.5); z-index: 1000; align-items: center; justify-content: center; padding: 24px; }
  .modal-overlay.open { display: flex; }
  .modal-box { background: white; border-radius: 12px; max-width: 640px; width: 100%; max-height: 80vh; display: flex; flex-direction: column; }
  .modal-header { padding: 16px 20px; border-bottom: 1px solid #e5e7eb; display: flex; justify-content: space-between; align-items: center; }
  .modal-header h2 { font-size: 16px; margin: 0; }
  .modal-close { background: none; border: none; font-size: 20px; cursor: pointer; color: #6b7280; width: auto; margin: 0; padding: 0; }
  .modal-body { padding: 20px; overflow-y: auto; font-size: 13px; line-height: 1.6; color: #374151; }
  .modal-body h3 { font-size: 15px; margin: 0 0 8px; }
  .modal-body h4 { font-size: 13px; margin: 16px 0 6px; color: #1b1f27; }
  .modal-body p { margin: 0 0 8px; }
  .modal-footer { padding: 12px 20px; border-top: 1px solid #e5e7eb; }
  .modal-footer button { margin-top: 0; }
</style>
</head>
<body>
  <div class="card">
    <h1>สมัครสมาชิก Sponsor</h1>
    ${error ? `<p class="error">${error}</p>` : ''}
    <form method="POST" action="/api/sponsor/action?action=signup" id="signupForm">
      <label>ชื่อบริษัท *</label>
      <input type="text" name="company_name" value="${v('company_name')}" required />
      <label>เลขประจำตัวผู้เสียภาษี</label>
      <input type="text" name="tax_id" value="${v('tax_id')}" />
      <label>ที่อยู่บริษัท</label>
      <input type="text" name="address" value="${v('address')}" />
      <label>ชื่อผู้ติดต่อ</label>
      <input type="text" name="contact_name" value="${v('contact_name')}" />
      <label>เบอร์โทรติดต่อ</label>
      <input type="text" name="contact_phone" value="${v('contact_phone')}" />
      <label>ประเภทธุรกิจ</label>
      <input type="text" name="business_type" value="${v('business_type')}" />
      <label>อีเมล (ใช้ login) *</label>
      <input type="email" name="email" value="${v('email')}" required />
      <label>รหัสผ่าน *</label>
      <input type="password" name="password" required minlength="6" />

      <div class="terms-row">
        <input type="checkbox" name="agree_terms" id="agreeTerms" required />
        <label for="agreeTerms" style="margin:0;">
          ฉันได้อ่านและยอมรับ<button type="button" class="terms-link" onclick="openTerms()">ข้อกำหนดและนโยบายการแสดงผลเนื้อหา</button>
        </label>
      </div>

      <button type="submit">สมัครสมาชิก</button>
    </form>
    <p class="link">มีบัญชีอยู่แล้ว? <a href="/api/sponsor/action?action=login">เข้าสู่ระบบ</a></p>
  </div>

  <div class="modal-overlay" id="termsModal">
    <div class="modal-box">
      <div class="modal-header">
        <h2>ข้อกำหนดและนโยบายการแสดงผลเนื้อหา</h2>
        <button type="button" class="modal-close" onclick="closeTerms()">&times;</button>
      </div>
      <div class="modal-body">${TERMS_CONTENT}</div>
      <div class="modal-footer">
        <button type="button" onclick="closeTerms()">ปิด</button>
      </div>
    </div>
  </div>

  <script>
    function openTerms() { document.getElementById('termsModal').classList.add('open'); }
    function closeTerms() { document.getElementById('termsModal').classList.remove('open'); }
    document.getElementById('termsModal').addEventListener('click', (e) => {
      if (e.target.id === 'termsModal') closeTerms();
    });
  </script>
</body>
</html>`;
}

function renderLoginPage(error) {
  return `<!DOCTYPE html>
<html lang="th">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<link rel="stylesheet" href="/theme.css" />
<script src="/theme.js" defer></script>
<title>Sponsor Login</title>
<style>
  body { font-family: sans-serif; background: #f7f8fa; margin: 0; padding: 24px; color: #1b1f27; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
  .card { background: white; border-radius: 16px; padding: 32px; max-width: 360px; width: 100%; box-shadow: 0 1px 4px rgba(0,0,0,0.08); }
  h1 { font-size: 18px; margin: 0 0 20px; }
  label { display: block; font-size: 13px; color: #6b7280; margin-bottom: 4px; }
  input { width: 100%; box-sizing: border-box; padding: 10px 12px; border: 1px solid #e5e7eb; border-radius: 8px; margin-bottom: 16px; font-size: 14px; }
  button { width: 100%; background: #1b1f27; color: white; border: none; padding: 12px; border-radius: 8px; font-size: 14px; cursor: pointer; }
  .error { color: #e76f51; font-size: 13px; margin-bottom: 12px; }
  .link { text-align: center; margin-top: 16px; font-size: 13px; }
</style>
</head>
<body>
  <div class="card">
    <h1>Sponsor Login</h1>
    ${error ? `<p class="error">${error}</p>` : ''}
    <form method="POST" action="/api/sponsor/action?action=login">
      <label>อีเมล</label>
      <input type="email" name="email" required autofocus />
      <label>รหัสผ่าน</label>
      <input type="password" name="password" required />
      <button type="submit">เข้าสู่ระบบ</button>
    </form>
    <p class="link">ยังไม่มีบัญชี? <a href="/api/sponsor/action?action=signup">สมัครสมาชิก</a></p>
    <p class="link"><a href="/api/sponsor/action?action=forgot_password">ลืมรหัสผ่าน?</a></p>
  </div>
</body>
</html>`;
}

function renderForgotPasswordPage(error, message) {
  return `<!DOCTYPE html>
<html lang="th">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<link rel="stylesheet" href="/theme.css" />
<script src="/theme.js" defer></script>
<title>ลืมรหัสผ่าน</title>
<style>
  body { font-family: sans-serif; background: #f7f8fa; margin: 0; padding: 24px; color: #1b1f27; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
  .card { background: white; border-radius: 16px; padding: 32px; max-width: 360px; width: 100%; box-shadow: 0 1px 4px rgba(0,0,0,0.08); }
  h1 { font-size: 18px; margin: 0 0 20px; }
  label { display: block; font-size: 13px; color: #6b7280; margin-bottom: 4px; }
  input { width: 100%; box-sizing: border-box; padding: 10px 12px; border: 1px solid #e5e7eb; border-radius: 8px; margin-bottom: 16px; font-size: 14px; }
  button { width: 100%; background: #1b1f27; color: white; border: none; padding: 12px; border-radius: 8px; font-size: 14px; cursor: pointer; }
  .error { color: #e76f51; font-size: 13px; margin-bottom: 12px; }
  .success { color: #06c755; font-size: 13px; margin-bottom: 12px; }
  .link { text-align: center; margin-top: 16px; font-size: 13px; }
</style>
</head>
<body>
  <div class="card">
    <h1>ลืมรหัสผ่าน</h1>
    ${error ? `<p class="error">${error}</p>` : ''}
    ${message ? `<p class="success">${message}</p>` : ''}
    <form method="POST" action="/api/sponsor/action?action=forgot_password">
      <label>อีเมลที่ใช้สมัคร</label>
      <input type="email" name="email" required autofocus />
      <button type="submit">ส่งลิงก์รีเซ็ตรหัสผ่าน</button>
    </form>
    <p class="link"><a href="/api/sponsor/action?action=login">กลับไปหน้าเข้าสู่ระบบ</a></p>
  </div>
</body>
</html>`;
}

function renderResetPasswordPage(token, error) {
  const form = token
    ? `
    <form method="POST" action="/api/sponsor/action?action=reset_password">
      <input type="hidden" name="token" value="${token}" />
      <label>รหัสผ่านใหม่</label>
      <input type="password" name="new_password" required minlength="6" autofocus />
      <button type="submit">ตั้งรหัสผ่านใหม่</button>
    </form>`
    : `<p class="link"><a href="/api/sponsor/action?action=forgot_password">ขอลิงก์ใหม่</a></p>`;

  return `<!DOCTYPE html>
<html lang="th">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<link rel="stylesheet" href="/theme.css" />
<script src="/theme.js" defer></script>
<title>ตั้งรหัสผ่านใหม่</title>
<style>
  body { font-family: sans-serif; background: #f7f8fa; margin: 0; padding: 24px; color: #1b1f27; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
  .card { background: white; border-radius: 16px; padding: 32px; max-width: 360px; width: 100%; box-shadow: 0 1px 4px rgba(0,0,0,0.08); }
  h1 { font-size: 18px; margin: 0 0 20px; }
  label { display: block; font-size: 13px; color: #6b7280; margin-bottom: 4px; }
  input { width: 100%; box-sizing: border-box; padding: 10px 12px; border: 1px solid #e5e7eb; border-radius: 8px; margin-bottom: 16px; font-size: 14px; }
  button { width: 100%; background: #1b1f27; color: white; border: none; padding: 12px; border-radius: 8px; font-size: 14px; cursor: pointer; }
  .error { color: #e76f51; font-size: 13px; margin-bottom: 12px; }
  .link { text-align: center; margin-top: 16px; font-size: 13px; }
</style>
</head>
<body>
  <div class="card">
    <h1>ตั้งรหัสผ่านใหม่</h1>
    ${error ? `<p class="error">${error}</p>` : ''}
    ${form}
  </div>
</body>
</html>`;
}

function renderResetSuccessPage() {
  return `<!DOCTYPE html>
<html lang="th">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<link rel="stylesheet" href="/theme.css" />
<script src="/theme.js" defer></script>
<title>ตั้งรหัสผ่านสำเร็จ</title>
<style>
  body { font-family: sans-serif; background: #f7f8fa; margin: 0; padding: 24px; color: #1b1f27; display: flex; align-items: center; justify-content: center; min-height: 100vh; text-align: center; }
  .card { background: white; border-radius: 16px; padding: 32px; max-width: 360px; width: 100%; box-shadow: 0 1px 4px rgba(0,0,0,0.08); }
  .link { margin-top: 16px; font-size: 14px; }
</style>
</head>
<body>
  <div class="card">
    <p>🎉 ตั้งรหัสผ่านใหม่สำเร็จแล้ว</p>
    <p class="link"><a href="/api/sponsor/action?action=login">เข้าสู่ระบบด้วยรหัสผ่านใหม่</a></p>
  </div>
</body>
</html>`;
}
