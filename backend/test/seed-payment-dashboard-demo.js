#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════════════════════
// PAYMENT DASHBOARD — DEV-ONLY DEMO SEEDER (feat/payment-dashboard-foundation)
// ═══════════════════════════════════════════════════════════════════════════════════════════
// NOT a production route, NOT part of `npm test` (the glob is backend/test/*.test.js — this
// file deliberately has no .test in its name). Mock provider only, zero external network.
// Refuses to run against anything but a LOCAL Postgres.
//
// What it does: registers a throwaway demo owner + shop, then drives the REAL payment-platform
// service through real HTTP (same pattern as payment-platform.test.js) to produce one row of
// every interesting dashboard state:
//   1. CASH confirmed (PAID, amount matches, receipt issued)
//   2. STATIC_QR displayed, awaiting manual confirmation
//   3. STATIC_QR manually confirmed
//   4. DYNAMIC_QR confirmed via signed mock webhook (provider-verified)
//   5. DYNAMIC_QR failed webhook
//   6. expired intent (lazy-expired via a touch)
//   7. partial payment (PARTIALLY_PAID)
//   8. refund approved (PAID -> PARTIALLY_PAID)
//   9. reconciliation-flagged transaction (manual-review filter target)
//  10. cash confirm linked to an online order row (order_no column demo)
//
// ── HOW TO DEMO THE DASHBOARD LOCALLY ──
//   1. Local Postgres running, backend/.env has a LOCAL DATABASE_URL
//      (schema already applied — npm run migrate if needed).
//   2. Seed:                node backend/test/seed-payment-dashboard-demo.js
//      → prints the demo login (email / password) at the end.
//   3. Start the server WITH the platform flag ON (PowerShell):
//         $env:PAYMENT_PLATFORM_ENABLED='1'; npm start
//      (or bash: PAYMENT_PLATFORM_ENABLED=1 npm start)
//   4. Open http://localhost:3100 (local dev port), log in with the printed
//      credentials → the "ชำระเงิน" nav item appears (it stays hidden when the
//      flag is off) → the dashboard shows the seeded rows; click a row for its
//      audit history; try the filters (status/method/date/order no/bill no/
//      manual-review-only).
// ═══════════════════════════════════════════════════════════════════════════════════════════
require('dotenv').config();
const http = require('node:http');

const DB = process.env.DATABASE_URL || '';
if (!/@(localhost|127\.0\.0\.1)[:/]/.test(DB)) {
  console.error('refusing to run: DATABASE_URL is not local');
  process.exit(1);
}
process.env.PAYMENT_PLATFORM_ENABLED = '1';   // flag ON for the seeding requests (per-request check)

const { pool, query } = require('../src/db');
const app = require('../src/app');
const { MockProviderAdapter } = require('../src/payments/mock-adapter');
const adapter = new MockProviderAdapter();

let base;
const req = (method, path, body, tok, shop) => new Promise((resolve, reject) => {
  const data = body != null ? JSON.stringify(body) : null;
  const r = http.request(base + path, {
    method,
    headers: Object.assign(
      { 'Content-Type': 'application/json' },
      data ? { 'Content-Length': Buffer.byteLength(data) } : {},
      tok ? { Authorization: 'Bearer ' + tok } : {},
      shop ? { 'X-Shop-Id': shop } : {}
    ),
  }, (res) => {
    let s = '';
    res.on('data', (d) => s += d);
    res.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (_) {} resolve({ status: res.statusCode, body: j }); });
  });
  r.on('error', reject);
  if (data) r.write(data);
  r.end();
});

function must(r, what) {
  if (r.status >= 400) { throw new Error(what + ' failed (' + r.status + '): ' + JSON.stringify(r.body)); }
  return r.body;
}

async function main() {
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  base = 'http://127.0.0.1:' + server.address().port;

  const email = 'paydash_demo_' + Date.now() + '@local.test';
  const password = 'PayDash#Demo2026';
  const reg = must(await req('POST', '/auth/register', { email, password, shopName: 'PAYDASH DEMO SHOP' }), 'register');
  const tok = reg.accessToken, shopId = reg.memberships[0].shop_id, userId = reg.user.id;

  const bill = async (amount) => {
    const c = must(await req('POST', '/api/payments/bills', { amount_due: amount }, tok, shopId), 'create bill');
    must(await req('POST', '/api/payments/bills/' + c.bill.id + '/confirm', {}, tok, shopId), 'confirm bill');
    return c.bill.id;
  };
  const intent = async (billId, method, extra) => must(
    await req('POST', '/api/payments/intents', Object.assign({ bill_id: billId, method }, extra || {}), tok, shopId), 'create intent').intent;
  // NOTE: `amount` here is SATANG (the mock provider/webhook layer is satang-native — see
  // backend/src/payments/service.js#processProviderWebhook), not baht.
  const webhook = async (i, { eventId, status, amount }) => {
    const d = adapter.buildWebhookDelivery({ eventId, providerTxnId: i.provider_ref, status, amount, currency: 'THB' });
    return must(await req('POST', '/api/payments/webhooks/mock', { raw_body: d.rawBody, signature: d.signature }, tok, shopId), 'webhook');
  };

  // 1. CASH confirmed — PAID
  const b1 = await bill(120);
  const i1 = await intent(b1, 'CASH');
  const cc1 = must(await req('POST', '/api/payments/intents/' + i1.id + '/cash-confirm',
    { amount_received: 150, terminal_id: 'DEMO-T1' }, tok, shopId), 'cash confirm');

  // 2. STATIC_QR displayed, awaiting manual confirmation
  const b2 = await bill(89);
  const i2 = await intent(b2, 'STATIC_QR');
  must(await req('POST', '/api/payments/intents/' + i2.id + '/static-qr/display', {}, tok, shopId), 'static display');

  // 3. STATIC_QR manually confirmed
  const b3 = await bill(240);
  const i3 = await intent(b3, 'STATIC_QR');
  must(await req('POST', '/api/payments/intents/' + i3.id + '/static-qr/display', {}, tok, shopId), 'static display');
  must(await req('POST', '/api/payments/intents/' + i3.id + '/static-qr/confirm', { slip_ref: 'SLIP-DEMO-3' }, tok, shopId), 'static confirm');

  // 4. DYNAMIC_QR confirmed via signed webhook (provider-verified)
  const b4 = await bill(350);
  const i4 = await intent(b4, 'DYNAMIC_QR');
  await webhook(i4, { eventId: 'demo-evt-ok-' + b4, status: 'SUCCESS', amount: 35000 });

  // 5. DYNAMIC_QR failed webhook
  const b5 = await bill(60);
  const i5 = await intent(b5, 'DYNAMIC_QR');
  await webhook(i5, { eventId: 'demo-evt-fail-' + b5, status: 'FAILED', amount: 6000 });

  // 6. expired intent — created with a 1s TTL, lazily expired by the cancel touch
  const b6 = await bill(45);
  const i6 = await intent(b6, 'CASH', { expires_in_sec: 1 });
  await new Promise((r) => setTimeout(r, 1200));
  await req('POST', '/api/payments/intents/' + i6.id + '/cancel', {}, tok, shopId); // 409 INTENT_EXPIRED is the point

  // 7. partial payment — 100 of 300 paid -> PARTIALLY_PAID
  const b7 = await bill(300);
  const i7 = await intent(b7, 'CASH', { amount: 100 });
  must(await req('POST', '/api/payments/intents/' + i7.id + '/cash-confirm', { amount_received: 100 }, tok, shopId), 'partial cash');

  // 8. refund approved — PAID -> PARTIALLY_PAID
  const b8 = await bill(500);
  const i8 = await intent(b8, 'CASH');
  const cc8 = must(await req('POST', '/api/payments/intents/' + i8.id + '/cash-confirm', { amount_received: 500 }, tok, shopId), 'cash confirm');
  const rf = must(await req('POST', '/api/payments/refunds',
    { transaction_id: cc8.transaction.id, amount: 120, reason: 'สินค้าเสียหาย (demo)' }, tok, shopId), 'refund request');
  must(await req('POST', '/api/payments/refunds/' + rf.refund.id + '/approve', { reason: 'อนุมัติ (demo)' }, tok, shopId), 'refund approve');

  // 9. reconciliation-flagged transaction (manual-review filter target)
  must(await req('POST', '/api/payments/reconciliation/' + cc1.transaction.id + '/flag',
    { status: 'AMOUNT_MISMATCH', notes: 'ยอด settlement ไม่ตรง (demo)' }, tok, shopId), 'reconciliation flag');

  // 10. cash confirm linked to an online order row → order_no column demo
  const b10 = await bill(75);
  const i10 = await intent(b10, 'CASH');
  const cc10 = must(await req('POST', '/api/payments/intents/' + i10.id + '/cash-confirm', { amount_received: 75 }, tok, shopId), 'cash confirm');
  const ord = (await query(
    `INSERT INTO orders (shop_id, order_no, customer_name, total, status) VALUES ($1,'Q-0042','ลูกค้า Demo',75,'collected') RETURNING id`,
    [shopId])).rows[0];
  await query(`UPDATE payment_transactions SET order_id=$1 WHERE id=$2`, [ord.id, cc10.transaction.id]);
  await query(`UPDATE payment_intents SET order_id=$1 WHERE id=$2`, [ord.id, i10.id]);

  await new Promise((r) => server.close(r));
  await pool.end();

  console.log('');
  console.log('══════════════════════════════════════════════════════');
  console.log(' PAYDASH DEMO SEEDED — 9 bills (10 demo steps) in shop "PAYDASH DEMO SHOP"');
  console.log('   login email    : ' + email);
  console.log('   login password : ' + password);
  console.log('   shop id        : ' + shopId);
  console.log('');
  console.log(' Next: PAYMENT_PLATFORM_ENABLED=1 npm start  → log in →');
  console.log(' nav "ชำระเงิน" → dashboard shows the seeded states.');
  console.log('══════════════════════════════════════════════════════');
}

main().catch((e) => { console.error('SEED FAILED:', e); process.exit(1); });
