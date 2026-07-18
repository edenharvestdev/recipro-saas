// POST /webhooks/omise — รับ event จาก Omise (ไม่มี auth)
// ยืนยันความถูกต้อง: (1) HMAC signature ถ้าตั้ง OMISE_WEBHOOK_SECRET, (2) re-fetch event จาก Omise API
const crypto = require('crypto');
const express = require('express');
const { query } = require('../db');
const omise = require('../omise');
const billing = require('../api/billing');
const { sendReceipt } = require('../email');
const { guardSecret, WebhookConfigError } = require('./webhook-guard');
const router = express.Router();

// ตรวจ HMAC signature (ถ้าตั้ง OMISE_WEBHOOK_SECRET) — เหมือนใน api/pay.js
// FAIL-CLOSED (see webhook-guard.js): no secret -> WebhookConfigError; missing/invalid
// signature -> Error. Neither path lets processing continue.
function verifyHmac(rawBody, req) {
  const secret = process.env.OMISE_WEBHOOK_SECRET;
  const mode = guardSecret(!!secret);   // throws WebhookConfigError if unconfigured (prod-safe)
  if (mode === 'bypass') return;        // explicit dev/test-only bypass, never true in production
  const sig = req.headers['opn-signature'] || req.headers['x-opn-signature'] || '';
  if (!sig) {
    throw Object.assign(new Error('missing Opn-Signature header'), { code: 'WEBHOOK_SIG_MISSING' });
  }
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const sigBuf = Buffer.from(sig.length === expected.length ? sig : '', 'hex');
  const expBuf = Buffer.from(expected, 'hex');
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    throw Object.assign(new Error('invalid webhook signature'), { code: 'WEBHOOK_SIG_INVALID' });
  }
}

router.post('/omise', async (req, res) => {
  // parse raw body (express.raw middleware ใน app.js)
  const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body || {}));

  // Verify BEFORE any parsing/mutation below. Fail closed: config error -> 503, bad/missing
  // signature -> 401. Never leak the secret or the raw payload in logs.
  try {
    verifyHmac(rawBody, req);
  } catch (e) {
    if (e instanceof WebhookConfigError) {
      console.error('[omise-webhook] rejected: webhook secret not configured');
      return res.status(503).json({ error: 'webhook not configured' });
    }
    console.error('[omise-webhook] rejected: signature verification failed (' + (e.code || 'invalid') + ')');
    return res.status(401).json({ error: 'invalid signature' });
  }

  try {
    const evt = JSON.parse(rawBody.toString('utf8'));
    if (!evt || !evt.key) return res.status(400).send('bad event');

    // ยืนยัน: ดึง event จริงจาก Omise (กัน payload ปลอม)
    let verified = evt;
    if (omise.hasKeys() && evt.id) {
      try { verified = await omise.retrieveEvent(evt.id); } catch (_) { /* ใช้ payload เดิม */ }
    }

    const key = verified.key;
    const charge = verified.data && verified.data.object === 'charge' ? verified.data : null;
    const shopId = charge?.metadata?.shop_id;
    const cycle = charge?.metadata?.billing_cycle || 'month';
    const planId = charge?.metadata?.plan_id || null;

    if (key === 'charge.complete' && charge) {
      if (charge.status === 'successful' && shopId) {
        const amountThb = (charge.amount || 0) / 100;
        await billing.activate(shopId, planId, cycle, charge.customer, charge.id,
          billing.nextPeriodEnd(cycle), amountThb);
        // ส่งใบเสร็จ
        const email = (await query(
          `select u.email from users u join memberships m on m.user_id=u.id
            where m.shop_id=$1 order by m.role='owner' desc limit 1`, [shopId]
        )).rows[0]?.email;
        sendReceipt(email, { plan: planId || 'Recipro', amount: amountThb, chargeId: charge.id }).catch(() => {});
      } else if (shopId) {
        // ชำระไม่สำเร็จ → past_due
        await query("update subscriptions set status='past_due' where shop_id=$1", [shopId]);
      }
    }

    if (key === 'charge.expire' && charge && shopId) {
      await query("update subscriptions set status='past_due' where shop_id=$1", [shopId]);
    }

    // (เผื่ออนาคต) ยกเลิก subscription/schedule → canceled + พักร้าน
    if (key === 'schedule.destroy' || key === 'customer.destroy') {
      const custId = verified.data?.id || charge?.customer;
      if (custId) {
        const sub = (await query(
          'select shop_id from subscriptions where provider_customer_id=$1 limit 1', [custId]
        )).rows[0];
        if (sub) {
          await query("update subscriptions set status='canceled' where shop_id=$1", [sub.shop_id]);
          await query("update shops set status='suspended' where id=$1", [sub.shop_id]);
        }
      }
    }

    res.json({ ok: true });
  } catch (e) {
    console.error('[webhook] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
