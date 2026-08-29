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
import { createOmiseCharge, getOmiseCharge, verifySlipWithSlipOK, createOmiseCustomer, attachCardToCustomer, listCustomerCards, setDefaultCard, deleteCustomerCard, getPromptPayQrImageUrl } from '../../lib/payments.js';
import { getSponsorCreditBalance, spendSponsorCredit } from '../../lib/sponsorArea.js';
import { sendEmail } from '../../lib/email.js';
import { createResetToken, verifyResetToken, markTokenUsed } from '../../lib/passwordReset.js';

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

      const { data: existing } = await supabase.from('sponsors').select('id').eq('email', email).maybeSingle();
      if (existing) {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.status(200).send(renderSignupPage('อีเมลนี้ถูกใช้สมัครไปแล้ว'));
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
        })
        .select('id')
        .single();

      if (error) {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.status(200).send(renderSignupPage('สมัครไม่สำเร็จ ลองใหม่อีกครั้ง'));
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
    const { data: ownedRows } = await supabase.from('sponsor_content').select('id').eq('sponsor_id', sponsor.id);
    const ownedIds = new Set((ownedRows || []).map((r) => r.id));
    const onlyContentId = ownedRows && ownedRows.length === 1 ? ownedRows[0].id : null;

    const slotContentMap = {};
    for (const slotNumber of slotNumbers) {
      let contentId = params.get(`content_slot_${slotNumber}`);
      // เผื่อ dropdown ไม่ได้ถูกเลือกมา (เช่น JS ไม่ทำงาน) — ถ้ามีไฟล์แค่ไฟล์เดียวในคลัง ใช้ไฟล์นั้นให้อัตโนมัติ
      if (!contentId && onlyContentId) contentId = onlyContentId;

      if (!contentId || !ownedIds.has(contentId)) {
        res.status(400).send(`กรุณาเลือกไฟล์ให้ครบทุก slot (Slot ${slotNumber} ยังไม่ได้เลือกไฟล์ หรือไฟล์ไม่ถูกต้อง)`);
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
    await updateBookingContent(params.get('booking_id'), sponsor.id, contentId);
    res.writeHead(302, { Location: '/api/sponsor?page=bookings' });
    res.end();
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

  res.status(400).send('ไม่รู้จัก action นี้');
}

function renderSignupPage(error) {
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
</style>
</head>
<body>
  <div class="card">
    <h1>สมัครสมาชิก Sponsor</h1>
    ${error ? `<p class="error">${error}</p>` : ''}
    <form method="POST" action="/api/sponsor/action?action=signup">
      <label>ชื่อบริษัท *</label>
      <input type="text" name="company_name" required />
      <label>เลขประจำตัวผู้เสียภาษี</label>
      <input type="text" name="tax_id" />
      <label>ที่อยู่บริษัท</label>
      <input type="text" name="address" />
      <label>ชื่อผู้ติดต่อ</label>
      <input type="text" name="contact_name" />
      <label>เบอร์โทรติดต่อ</label>
      <input type="text" name="contact_phone" />
      <label>ประเภทธุรกิจ</label>
      <input type="text" name="business_type" />
      <label>อีเมล (ใช้ login) *</label>
      <input type="email" name="email" required />
      <label>รหัสผ่าน *</label>
      <input type="password" name="password" required minlength="6" />
      <button type="submit">สมัครสมาชิก</button>
    </form>
    <p class="link">มีบัญชีอยู่แล้ว? <a href="/api/sponsor/action?action=login">เข้าสู่ระบบ</a></p>
  </div>
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
