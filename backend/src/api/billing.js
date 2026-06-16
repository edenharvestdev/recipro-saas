// /api/plans + /api/billing/checkout (Omise)
const express = require('express');
const { query } = require('../db');
const omise = require('../omise');
const { sendReceipt } = require('../email');
const router = express.Router();

// แพ็กเกจที่เปิดขาย
router.get('/plans', async (req, res) => {
  try {
    const { rows } = await query('select * from plans where active = true order by price_month');
    res.json({ plans: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ชำระเงินครั้งแรกด้วย Omise
// frontend สร้าง card token ด้วย Omise.js แล้วส่ง { planId, billingCycle, omiseToken } มา
router.post('/billing/checkout', async (req, res) => {
  try {
    if (req.role !== 'owner' && req.role !== 'superadmin') {
      return res.status(403).json({ error: 'เฉพาะเจ้าของร้านเท่านั้นที่ซื้อแพ็กเกจได้' });
    }
    if (!req.shopId) return res.status(400).json({ error: 'ไม่พบร้านปัจจุบัน' });
    if (!omise.hasKeys()) return res.status(503).json({ error: 'ระบบยังไม่ได้ตั้งค่า Omise (OMISE_SECRET_KEY)' });

    const { planId, billingCycle, omiseToken } = req.body || {};
    if (!omiseToken) return res.status(400).json({ error: 'ไม่พบ token บัตร (omiseToken)' });

    const plan = (await query('select * from plans where id = $1', [planId])).rows[0];
    if (!plan) return res.status(404).json({ error: 'ไม่พบแพ็กเกจ' });

    const cycle = billingCycle === 'year' ? 'year' : 'month';
    const amountThb = cycle === 'year' ? Number(plan.price_year) : Number(plan.price_month);
    const amountSatang = Math.round(amountThb * 100);

    // ผูกบัตรเข้ากับ customer (ไว้ตัดบัตรรอบถัดไป) แล้วเรียกเก็บเงินรอบแรก
    const ownerEmail = (await query(
      `select u.email from users u join memberships m on m.user_id = u.id
        where m.shop_id = $1 order by m.role = 'owner' desc limit 1`, [req.shopId]
    )).rows[0]?.email;

    const customer = await omise.createCustomer(ownerEmail || undefined, omiseToken);
    const charge = await omise.createCharge({
      amount: amountSatang,
      currency: 'thb',
      customer: customer.id,
      description: `Recipro ${plan.name} (${cycle === 'year' ? 'รายปี' : 'รายเดือน'})`,
      'metadata[shop_id]': req.shopId,
      'metadata[plan_id]': planId,
      'metadata[billing_cycle]': cycle,
    });

    // 3-D Secure: ต้อง redirect ผู้ใช้ไปยืนยัน แล้วผลจริงจะมาทาง webhook
    if (charge.authorize_uri && charge.status !== 'successful') {
      await upsertSubscription(req.shopId, planId, cycle, customer.id, charge.id, 'trialing', null);
      return res.json({ authorizeUri: charge.authorize_uri });
    }

    if (charge.status === 'successful' || charge.paid === true) {
      const periodEnd = nextPeriodEnd(cycle);
      await activate(req.shopId, planId, cycle, customer.id, charge.id, periodEnd, amountThb);
      sendReceipt(ownerEmail, { plan: plan.name, amount: amountThb, chargeId: charge.id }).catch(() => {});
      return res.json({ ok: true });
    }

    return res.status(402).json({ error: 'การชำระเงินไม่สำเร็จ', status: charge.status });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

function nextPeriodEnd(cycle) {
  const d = new Date();
  if (cycle === 'year') d.setFullYear(d.getFullYear() + 1);
  else d.setMonth(d.getMonth() + 1);
  return d.toISOString();
}

async function upsertSubscription(shopId, planId, cycle, customerId, subId, status, periodEnd) {
  const existing = (await query('select id from subscriptions where shop_id = $1 limit 1', [shopId])).rows[0];
  if (existing) {
    await query(
      `update subscriptions set plan_id=$2, billing_cycle=$3, provider='omise',
         provider_customer_id=$4, provider_sub_id=$5, status=$6,
         current_period_end=coalesce($7, current_period_end) where id=$1`,
      [existing.id, planId, cycle, customerId, subId, status, periodEnd]
    );
  } else {
    await query(
      `insert into subscriptions (shop_id, plan_id, billing_cycle, provider, provider_customer_id, provider_sub_id, status, current_period_end)
       values ($1,$2,$3,'omise',$4,$5,$6,$7)`,
      [shopId, planId, cycle, customerId, subId, status, periodEnd]
    );
  }
}

async function activate(shopId, planId, cycle, customerId, chargeId, periodEnd, amountThb) {
  await upsertSubscription(shopId, planId, cycle, customerId, chargeId, 'active', periodEnd);
  await query("update shops set status = 'active' where id = $1", [shopId]);
  await query(
    `insert into payments (shop_id, amount, currency, status, paid_at, provider_invoice_id)
     values ($1, $2, 'THB', 'paid', now(), $3)`,
    [shopId, amountThb, chargeId]
  );
}

module.exports = router;
module.exports.activate = activate;
module.exports.upsertSubscription = upsertSubscription;
module.exports.nextPeriodEnd = nextPeriodEnd;
