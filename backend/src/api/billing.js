// /api/plans + /api/billing/checkout — รองรับ Stripe (หลัก) และ Omise (ทางเลือก)
const express = require('express');
const { query } = require('../db');
const omise = require('../omise');
const stripe = require('../stripe');
const slipverify = require('../slipverify');
const { sendReceipt } = require('../email');
const { logEvent } = require('../logs');
const router = express.Router();

const APP_URL = () => (process.env.APP_URL || 'http://localhost:3000').replace(/\/$/, '');

// เลือกผู้ให้บริการจ่ายเงิน: ตั้ง PAYMENT_PROVIDER ได้ ไม่งั้นเดาจากคีย์ที่ตั้งไว้ (Stripe ก่อน)
function provider() {
  const p = (process.env.PAYMENT_PROVIDER || '').toLowerCase();
  if (p === 'stripe' || p === 'omise') return p;
  if (stripe.hasKeys()) return 'stripe';
  if (omise.hasKeys()) return 'omise';
  return 'stripe'; // ค่าเริ่มต้น (จะตอบ 503 ถ้ายังไม่ใส่คีย์)
}

// แพ็กเกจที่เปิดขาย
router.get('/plans', async (req, res) => {
  try {
    const { rows } = await query('select * from plans where active = true order by sort, price_month');
    res.json({
      plans: rows,
      provider: provider(),
      promptpay: process.env.RECIPRO_PROMPTPAY || null,   // บัญชีรับเงินแพลตฟอร์ม (โชว์ QR ให้โอน)
      slip_verify: slipverify.hasKeys(),                   // เปิดตรวจสลิปอัตโนมัติไหม
      card_auto: stripe.hasKeys() || omise.hasKeys(),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ชำระเงินครั้งแรก
// Stripe: คืน { url } ให้ frontend redirect ไปหน้า Stripe Checkout (ไม่ต้องแตะเลขบัตร)
// Omise:  ต้องส่ง { omiseToken } (frontend สร้างด้วย Omise.js) — คืน { ok } หรือ { authorizeUri }
router.post('/billing/checkout', async (req, res) => {
  try {
    if (req.role !== 'owner' && req.role !== 'superadmin') {
      return res.status(403).json({ error: 'เฉพาะเจ้าของร้านเท่านั้นที่ซื้อแพ็กเกจได้' });
    }
    if (!req.shopId) return res.status(400).json({ error: 'ไม่พบร้านปัจจุบัน' });

    const { planId, billingCycle } = req.body || {};
    const plan = (await query('select * from plans where id = $1', [planId])).rows[0];
    if (!plan) return res.status(404).json({ error: 'ไม่พบแพ็กเกจ' });

    const cycle = billingCycle === 'year' ? 'year' : 'month';
    const amountThb = cycle === 'year' ? Number(plan.price_year) : Number(plan.price_month);
    const ownerEmail = (await query(
      `select u.email from users u join memberships m on m.user_id = u.id
        where m.shop_id = $1 order by m.role = 'owner' desc limit 1`, [req.shopId]
    )).rows[0]?.email;

    const prov = provider();

    // ---------- STRIPE (Checkout Session แบบ subscription) ----------
    if (prov === 'stripe') {
      if (!stripe.hasKeys()) {
        return res.status(503).json({ error: 'ระบบยังไม่ได้ตั้งค่า Stripe (STRIPE_SECRET_KEY) — ใส่คีย์ใน Railway Variables แล้วใช้งานได้ทันที' });
      }
      const meta = { shop_id: req.shopId, plan_id: String(planId), billing_cycle: cycle };
      const session = await stripe.client().checkout.sessions.create({
        mode: 'subscription',
        payment_method_types: ['card'],
        customer_email: ownerEmail || undefined,
        line_items: [{
          quantity: 1,
          price_data: {
            currency: 'thb',
            unit_amount: Math.round(amountThb * 100),
            recurring: { interval: cycle === 'year' ? 'year' : 'month' },
            product_data: { name: `Recipro ${plan.name} (${cycle === 'year' ? 'รายปี' : 'รายเดือน'})` },
          },
        }],
        success_url: `${APP_URL()}/?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${APP_URL()}/?checkout=cancel`,
        metadata: meta,
        subscription_data: { metadata: meta },
      });
      // บันทึก subscription ตั้งต้น (รอผลจริงจาก webhook)
      await upsertSubscription(req.shopId, planId, cycle, null, session.id, 'trialing', null, 'stripe');
      logEvent(req.shopId, req.userId, 'billing.checkout', { provider: 'stripe', plan: plan.name, cycle, amount: amountThb });
      return res.json({ url: session.url });
    }

    // ---------- OMISE (ทางเลือก) ----------
    if (!omise.hasKeys()) return res.status(503).json({ error: 'ระบบยังไม่ได้ตั้งค่า Omise (OMISE_SECRET_KEY)' });
    const { omiseToken } = req.body || {};
    if (!omiseToken) return res.status(400).json({ error: 'ไม่พบ token บัตร (omiseToken)' });
    const amountSatang = Math.round(amountThb * 100);
    const customer = await omise.createCustomer(ownerEmail || undefined, omiseToken);
    const charge = await omise.createCharge({
      amount: amountSatang, currency: 'thb', customer: customer.id,
      description: `Recipro ${plan.name} (${cycle === 'year' ? 'รายปี' : 'รายเดือน'})`,
      'metadata[shop_id]': req.shopId, 'metadata[plan_id]': planId, 'metadata[billing_cycle]': cycle,
    });
    if (charge.authorize_uri && charge.status !== 'successful') {
      await upsertSubscription(req.shopId, planId, cycle, customer.id, charge.id, 'trialing', null, 'omise');
      return res.json({ authorizeUri: charge.authorize_uri });
    }
    if (charge.status === 'successful' || charge.paid === true) {
      await activate(req.shopId, planId, cycle, customer.id, charge.id, nextPeriodEnd(cycle), amountThb, 'omise');
      sendReceipt(ownerEmail, { plan: plan.name, amount: amountThb, chargeId: charge.id }).catch(() => {});
      return res.json({ ok: true });
    }
    return res.status(402).json({ error: 'การชำระเงินไม่สำเร็จ', status: charge.status });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// เจ้าของแจ้งว่าโอนชำระแล้ว (manual) → บันทึก event ให้ superadmin ตามไปยืนยัน/ต่ออายุ
router.post('/billing/notify-paid', async (req, res) => {
  try {
    if (!req.shopId) return res.status(400).json({ error: 'ไม่พบร้าน' });
    logEvent(req.shopId, req.userId, 'billing.paid_notice', { note: (req.body && req.body.note) || '', at: new Date().toISOString() });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

function nextPeriodEnd(cycle) {
  const d = new Date();
  if (cycle === 'year') d.setFullYear(d.getFullYear() + 1);
  else d.setMonth(d.getMonth() + 1);
  return d.toISOString();
}

async function upsertSubscription(shopId, planId, cycle, customerId, subId, status, periodEnd, prov = 'stripe') {
  const existing = (await query('select id from subscriptions where shop_id = $1 limit 1', [shopId])).rows[0];
  if (existing) {
    await query(
      `update subscriptions set plan_id=$2, billing_cycle=$3, provider=$8,
         provider_customer_id=coalesce($4, provider_customer_id), provider_sub_id=$5, status=$6,
         current_period_end=coalesce($7, current_period_end) where id=$1`,
      [existing.id, planId, cycle, customerId, subId, status, periodEnd, prov]
    );
  } else {
    await query(
      `insert into subscriptions (shop_id, plan_id, billing_cycle, provider, provider_customer_id, provider_sub_id, status, current_period_end)
       values ($1,$2,$3,$8,$4,$5,$6,$7)`,
      [shopId, planId, cycle, customerId, subId, status, periodEnd, prov]
    );
  }
}

async function activate(shopId, planId, cycle, customerId, refId, periodEnd, amountThb, prov = 'stripe') {
  await upsertSubscription(shopId, planId, cycle, customerId, refId, 'active', periodEnd, prov);
  await query("update shops set status = 'active' where id = $1", [shopId]);
  await query(
    `insert into payments (shop_id, amount, currency, status, paid_at, provider_invoice_id)
     values ($1, $2, 'THB', 'paid', now(), $3)`,
    [shopId, amountThb, refId]
  );
}

module.exports = router;
module.exports.activate = activate;
module.exports.upsertSubscription = upsertSubscription;
module.exports.nextPeriodEnd = nextPeriodEnd;
