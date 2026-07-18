// POST /webhooks/stripe — รับ event จาก Stripe (raw body, ตรวจลายเซ็นด้วย STRIPE_WEBHOOK_SECRET)
// ตั้ง webhook ใน Stripe Dashboard ให้ชี้มาที่ https://<โดเมน>/webhooks/stripe
const express = require('express');
const { query } = require('../db');
const stripe = require('../stripe');
const billing = require('../api/billing');
const { sendReceipt } = require('../email');
const { guardSecret, WebhookConfigError } = require('./webhook-guard');
const router = express.Router();

router.post('/stripe', async (req, res) => {
  if (!stripe.hasKeys()) return res.status(503).send('stripe not configured');

  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  let mode;
  try {
    mode = guardSecret(!!secret);   // fail closed: no secret -> WebhookConfigError (prod-safe)
  } catch (e) {
    console.error('[stripe-webhook] rejected: webhook secret not configured');
    return res.status(503).send('webhook secret not configured');
  }

  const sig = req.headers['stripe-signature'];
  let event;
  try {
    // req.body เป็น Buffer (raw) จาก express.raw ใน app.js
    if (mode === 'bypass') {
      // explicit dev/test-only bypass (never true in production) — no signature check
      event = JSON.parse(Buffer.isBuffer(req.body) ? req.body.toString('utf8') : JSON.stringify(req.body));
    } else {
      event = stripe.client().webhooks.constructEvent(req.body, sig, secret);
    }
  } catch (e) {
    console.error('[stripe-webhook] rejected: signature verification failed');
    return res.status(401).send('invalid signature');
  }

  try {
    const sc = stripe.client();

    switch (event.type) {
      // ผูก subscription id จริงเข้ากับร้าน (ตอน checkout เก็บ session.id ไว้ชั่วคราว)
      case 'checkout.session.completed': {
        const s = event.data.object;
        if (s.subscription && s.metadata && s.metadata.shop_id) {
          await query(
            'update subscriptions set provider_sub_id=$1, provider_customer_id=$2, provider=$3 where shop_id=$4',
            [s.subscription, s.customer || null, 'stripe', s.metadata.shop_id]
          );
        }
        break;
      }

      // จ่ายสำเร็จ (ทั้งรอบแรกและรอบต่ออายุ) -> active + บันทึก payment + ส่งใบเสร็จ
      case 'invoice.paid': {
        const invoice = event.data.object;
        const subId = invoice.subscription;
        if (subId) {
          const sub = await sc.subscriptions.retrieve(subId);
          const shopId = sub.metadata && sub.metadata.shop_id;
          if (shopId) {
            const periodEnd = new Date(sub.current_period_end * 1000).toISOString();
            await billing.activate(
              shopId, sub.metadata.plan_id || null, sub.metadata.billing_cycle || 'month',
              invoice.customer, subId, periodEnd, (invoice.amount_paid || 0) / 100, 'stripe'
            );
            const email = (await query(
              `select u.email from users u join memberships m on m.user_id=u.id
                where m.shop_id=$1 order by m.role='owner' desc limit 1`, [shopId]
            )).rows[0]?.email;
            sendReceipt(email, { plan: sub.metadata.plan_id || 'Recipro', amount: (invoice.amount_paid || 0) / 100, chargeId: invoice.id }).catch(() => {});
          }
        }
        break;
      }

      // จ่ายไม่ผ่าน -> past_due (cron จะพักร้านเมื่อเกิน GRACE_DAYS)
      case 'invoice.payment_failed': {
        const subId = event.data.object.subscription;
        if (subId) await query("update subscriptions set status='past_due' where provider_sub_id=$1", [subId]);
        break;
      }

      // ยกเลิก subscription -> canceled + พักร้าน
      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        const r = await query("update subscriptions set status='canceled' where provider_sub_id=$1 returning shop_id", [sub.id]);
        if (r.rows[0]) await query("update shops set status='suspended' where id=$1", [r.rows[0].shop_id]);
        break;
      }
    }

    res.json({ received: true });
  } catch (e) {
    console.error('[stripe webhook]', e.message);
    res.status(500).send(e.message);
  }
});

module.exports = router;
