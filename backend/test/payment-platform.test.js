// Payment Platform (Phase 6+7) — core flow tests.
// Real HTTP against the REAL express app + REAL local Postgres (pattern:
// option-persistence-roundtrip.test.js). Throwaway shops per run, deleted in after().
// Mock provider only — zero external network (see payment-platform-guards.test.js for the
// network guard + flag-off/menu-regression tests; this file runs with the flag ON).
require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const crypto = require('node:crypto');

const DB = process.env.DATABASE_URL || '';
if (!/@(localhost|127\.0\.0\.1)[:/]/.test(DB)) {
  throw new Error('refusing to run: DATABASE_URL is not local');
}
process.env.PAYMENT_PLATFORM_ENABLED = '1';   // flag ON for this file (checked per request)

const { pool, query } = require('../src/db');
const app = require('../src/app');
const { MockProviderAdapter } = require('../src/payments/mock-adapter');
const adapter = new MockProviderAdapter();

let server, base;
const shopsToDelete = [];

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

async function registerOwner(prefix) {
  const email = prefix + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6) + '@local.test';
  const reg = await req('POST', '/auth/register', { email, password: 'PayPlat#2026test', shopName: 'PAYMENT PLATFORM TEST ' + prefix });
  assert.strictEqual(reg.status, 200, 'register failed: ' + JSON.stringify(reg.body));
  const shopId = reg.body.memberships[0].shop_id;
  shopsToDelete.push(shopId);
  return { token: reg.body.accessToken, shopId, userId: reg.body.user.id, email };
}

// Creates + confirms a payment-platform bill of `amount`; returns bill id.
async function confirmedBill(owner, amount) {
  const created = await req('POST', '/api/payments/bills', { amount_due: amount }, owner.token, owner.shopId);
  assert.strictEqual(created.status, 201, JSON.stringify(created.body));
  const billId = created.body.bill.id;
  const conf = await req('POST', '/api/payments/bills/' + billId + '/confirm', {}, owner.token, owner.shopId);
  assert.strictEqual(conf.status, 201, JSON.stringify(conf.body));
  return { billId, bill: conf.body.bill };
}

async function makeIntent(owner, billId, method, extra) {
  const r = await req('POST', '/api/payments/intents',
    Object.assign({ bill_id: billId, method }, extra || {}), owner.token, owner.shopId);
  assert.ok(r.status === 201 || r.status === 200, 'intent create failed: ' + JSON.stringify(r.body));
  return r.body.intent;
}

async function billRow(billId) {
  return (await query('SELECT * FROM bills WHERE id=$1', [billId])).rows[0];
}

let ownerA, ownerB;

test.before(async () => {
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  base = 'http://127.0.0.1:' + server.address().port;
  ownerA = await registerOwner('paya');
  ownerB = await registerOwner('payb');
});

test.after(async () => {
  for (const id of shopsToDelete) {
    await pool.query('delete from shops where id=$1', [id]);
  }
  await new Promise((r) => server.close(r));
  await pool.end();
});

// ─── 1-2: bill create/confirm + state separation ─────────────────────────────

test('T1 bill create -> confirm assigns number, AWAITING_PAYMENT, UNPAID', async () => {
  const { bill } = await confirmedBill(ownerA, 100);
  assert.strictEqual(bill.lifecycle_status, 'CONFIRMED');
  assert.ok(bill.number, 'confirmed bill must have a number');
  assert.strictEqual(bill.payment_state, 'AWAITING_PAYMENT');
  assert.strictEqual(bill.paid_state, 'UNPAID');
});

test('T2 BILL_CONFIRMED != PAYMENT_CONFIRMED — confirm never marks paid', async () => {
  const { bill, billId } = await confirmedBill(ownerA, 50);
  assert.notStrictEqual(bill.status, 'paid', 'bill confirm must NOT set legacy status=paid');
  assert.strictEqual(bill.paid_state, 'UNPAID');
  assert.strictEqual(bill.kitchen_release_eligible, false);
  // No transaction, no allocation exists after a bare confirm.
  const txns = (await query('SELECT count(*)::int c FROM payment_transactions WHERE bill_id=$1', [billId])).rows[0].c;
  assert.strictEqual(txns, 0);
});

test('T2b invalid bill transition rejected with a clear typed error', async () => {
  const created = await req('POST', '/api/payments/bills', { amount_due: 10 }, ownerA.token, ownerA.shopId);
  const billId = created.body.bill.id;
  // DRAFT -> VOIDED is not a legal transition (only CONFIRMED can be VOIDED).
  const bad = await req('POST', '/api/payments/bills/' + billId + '/void', { reason: 'x' }, ownerA.token, ownerA.shopId);
  assert.strictEqual(bad.status, 409, JSON.stringify(bad.body));
  assert.strictEqual(bad.body.code, 'INVALID_TRANSITION');
});

// ─── 3-6: cash confirm / duplicate / insufficient / change ───────────────────

test('T3 cash confirm: txn CONFIRMED + allocation ACTIVE + bill PAID + receipt', async () => {
  const { billId } = await confirmedBill(ownerA, 120);
  const intent = await makeIntent(ownerA, billId, 'CASH');
  const c = await req('POST', '/api/payments/intents/' + intent.id + '/cash-confirm',
    { amount_received: 120, terminal_id: 'T-01', idempotency_key: 'cash-' + billId }, ownerA.token, ownerA.shopId);
  assert.strictEqual(c.status, 201, JSON.stringify(c.body));
  assert.strictEqual(c.body.transaction.status, 'CONFIRMED');
  assert.strictEqual(c.body.transaction.confirmed_by, String(ownerA.userId), 'confirming actor recorded');
  assert.strictEqual(c.body.transaction.terminal_id, 'T-01');
  assert.strictEqual(c.body.paid_state, 'PAID');
  const alloc = (await query(`SELECT * FROM payment_allocations WHERE bill_id=$1`, [billId])).rows;
  assert.strictEqual(alloc.length, 1);
  assert.strictEqual(alloc[0].kind, 'PAYMENT');
  assert.strictEqual(alloc[0].status, 'ACTIVE');
  assert.strictEqual(Number(alloc[0].amount), 120);
  assert.ok(c.body.receipt && c.body.receipt.status === 'ISSUED', 'receipt issued referencing the txn');
  assert.strictEqual(c.body.receipt.payment_transaction_id, c.body.transaction.id);
  const b = await billRow(billId);
  assert.strictEqual(b.paid_state, 'PAID');
});

test('T4 duplicate cash confirm (same idempotency key) is idempotent — one txn, one allocation', async () => {
  const { billId } = await confirmedBill(ownerA, 80);
  const intent = await makeIntent(ownerA, billId, 'CASH');
  const key = 'dup-' + billId;
  const c1 = await req('POST', '/api/payments/intents/' + intent.id + '/cash-confirm',
    { amount_received: 100, idempotency_key: key }, ownerA.token, ownerA.shopId);
  assert.strictEqual(c1.status, 201, JSON.stringify(c1.body));
  const c2 = await req('POST', '/api/payments/intents/' + intent.id + '/cash-confirm',
    { amount_received: 100, idempotency_key: key }, ownerA.token, ownerA.shopId);
  assert.strictEqual(c2.status, 200, JSON.stringify(c2.body));
  assert.strictEqual(c2.body.already, true);
  assert.strictEqual(c2.body.transaction.id, c1.body.transaction.id);
  const n = (await query('SELECT count(*)::int c FROM payment_transactions WHERE bill_id=$1', [billId])).rows[0].c;
  assert.strictEqual(n, 1, 'exactly one transaction despite the double-tap');
  const na = (await query('SELECT count(*)::int c FROM payment_allocations WHERE bill_id=$1', [billId])).rows[0].c;
  assert.strictEqual(na, 1, 'exactly one allocation despite the double-tap');
});

test('T5 cash below due rejected (explicit partial flow requires a partial-amount intent)', async () => {
  const { billId } = await confirmedBill(ownerA, 200);
  const intent = await makeIntent(ownerA, billId, 'CASH');   // full-amount intent (200)
  const c = await req('POST', '/api/payments/intents/' + intent.id + '/cash-confirm',
    { amount_received: 150 }, ownerA.token, ownerA.shopId);
  assert.strictEqual(c.status, 400, JSON.stringify(c.body));
  assert.strictEqual(c.body.code, 'CASH_RECEIVED_INSUFFICIENT');
  assert.strictEqual((await billRow(billId)).paid_state, 'UNPAID');
});

test('T6 change computed server-side: received - due', async () => {
  const { billId } = await confirmedBill(ownerA, 85);
  const intent = await makeIntent(ownerA, billId, 'CASH');
  const c = await req('POST', '/api/payments/intents/' + intent.id + '/cash-confirm',
    { amount_received: 100 }, ownerA.token, ownerA.shopId);
  assert.strictEqual(c.status, 201, JSON.stringify(c.body));
  assert.strictEqual(Number(c.body.change_amount), 15);
  assert.strictEqual(Number(c.body.transaction.amount_received), 100);
  assert.strictEqual(Number(c.body.transaction.change_amount), 15);
  // Allocation carries the DUE amount, not the received amount.
  const alloc = (await query('SELECT amount FROM payment_allocations WHERE bill_id=$1', [billId])).rows[0];
  assert.strictEqual(Number(alloc.amount), 85);
});

// ─── 7-9: static QR ──────────────────────────────────────────────────────────

test('T7 static QR display + customer signal NEVER confirm', async () => {
  const { billId } = await confirmedBill(ownerA, 60);
  const intent = await makeIntent(ownerA, billId, 'STATIC_QR');
  const d = await req('POST', '/api/payments/intents/' + intent.id + '/static-qr/display', {}, ownerA.token, ownerA.shopId);
  assert.strictEqual(d.status, 200, JSON.stringify(d.body));
  assert.strictEqual(d.body.intent.status, 'QR_DISPLAYED');
  // Customer-paid signal is a structural no-op.
  const sig = await req('POST', '/api/payments/intents/' + intent.id + '/customer-paid-signal', {}, ownerA.token, ownerA.shopId);
  assert.strictEqual(sig.status, 200);
  assert.strictEqual(sig.body.state_changed, false);
  // Server state unchanged: still QR_DISPLAYED, bill still UNPAID, zero transactions.
  const i = (await query('SELECT status FROM payment_intents WHERE id=$1', [intent.id])).rows[0];
  assert.strictEqual(i.status, 'QR_DISPLAYED');
  assert.strictEqual((await billRow(billId)).paid_state, 'UNPAID');
  const n = (await query('SELECT count(*)::int c FROM payment_transactions WHERE bill_id=$1', [billId])).rows[0].c;
  assert.strictEqual(n, 0);
});

test('T8 static QR manual confirm: audited, provider_verified=false, confirming user recorded', async () => {
  const { billId } = await confirmedBill(ownerA, 60);
  const intent = await makeIntent(ownerA, billId, 'STATIC_QR');
  await req('POST', '/api/payments/intents/' + intent.id + '/static-qr/display', {}, ownerA.token, ownerA.shopId);
  const c = await req('POST', '/api/payments/intents/' + intent.id + '/static-qr/confirm', { slip_ref: 'slip-001' }, ownerA.token, ownerA.shopId);
  assert.strictEqual(c.status, 201, JSON.stringify(c.body));
  assert.strictEqual(c.body.transaction.provider_verified, false, 'static QR is NEVER provider-verified');
  assert.strictEqual(c.body.transaction.confirmed_by, String(ownerA.userId), 'confirmed by a user, never webhook');
  assert.strictEqual(c.body.paid_state, 'PAID');
  const audit = (await query(
    `SELECT action FROM bill_audit_log WHERE bill_id=$1 AND action='STATIC_QR_MANUALLY_CONFIRMED'`, [billId])).rows;
  assert.strictEqual(audit.length, 1, 'manual confirm audit row exists');
});

test('T9 static QR confirm permission-gated: staff without payment_static_qr_confirm -> 403', async () => {
  const { billId } = await confirmedBill(ownerA, 30);
  const intent = await makeIntent(ownerA, billId, 'STATIC_QR');
  // A staff member of shop A with NO payment permissions.
  const staffEmail = 'paystaff_' + Date.now() + '@local.test';
  const sReg = await req('POST', '/auth/register', { email: staffEmail, password: 'PayPlat#2026test', shopName: 'STAFF OWN SHOP' });
  shopsToDelete.push(sReg.body.memberships[0].shop_id);
  await query(`INSERT INTO memberships(user_id, shop_id, role) VALUES ($1,$2,'staff')`, [sReg.body.user.id, ownerA.shopId]);
  const sTok = (await req('POST', '/auth/login', { email: staffEmail, password: 'PayPlat#2026test' })).body.accessToken;
  const c = await req('POST', '/api/payments/intents/' + intent.id + '/static-qr/confirm', {}, sTok, ownerA.shopId);
  assert.strictEqual(c.status, 403, 'fail-closed: ' + JSON.stringify(c.body));
  assert.strictEqual((await billRow(billId)).paid_state, 'UNPAID');
  // Cash confirm also denied for the bare staff member (payment_cash_confirm not defaulted on).
  const cashIntent = await makeIntent(ownerA, billId, 'CASH', { idempotency_key: 'sperm-' + billId });
  const cc = await req('POST', '/api/payments/intents/' + cashIntent.id + '/cash-confirm', { amount_received: 30 }, sTok, ownerA.shopId);
  assert.strictEqual(cc.status, 403, JSON.stringify(cc.body));
});

// ─── 10-13: mock dynamic QR + provider events ────────────────────────────────

async function webhook(owner, intent, { eventId, status, amount, currency }) {
  const delivery = adapter.buildWebhookDelivery({
    eventId, providerTxnId: intent.provider_ref, status,
    amount: amount != null ? amount : Number(intent.amount_due),
    currency: currency || intent.currency,
  });
  return req('POST', '/api/payments/webhooks/mock',
    { raw_body: delivery.rawBody, signature: delivery.signature }, owner.token, owner.shopId);
}

test('T10 mock dynamic QR success: verified webhook confirms, provider_verified=true, kitchen eligible', async () => {
  const { billId } = await confirmedBill(ownerA, 150);
  const intent = await makeIntent(ownerA, billId, 'DYNAMIC_QR');
  assert.strictEqual(intent.status, 'INITIATED');
  assert.ok(intent.provider_ref, 'provider txn ref assigned by adapter');
  const w = await webhook(ownerA, intent, { eventId: 'evt-ok-' + billId, status: 'SUCCESS' });
  assert.strictEqual(w.status, 200, JSON.stringify(w.body));
  assert.strictEqual(w.body.outcome, 'CONFIRMED');
  assert.strictEqual(w.body.transaction.provider_verified, true);
  assert.strictEqual(w.body.transaction.confirmed_by, 'webhook:MOCK', 'dynamic QR is never user-confirmed');
  const b = await billRow(billId);
  assert.strictEqual(b.paid_state, 'PAID');
  assert.strictEqual(b.kitchen_release_eligible, true, 'kitchen_release_eligible computed true once PAID');
});

test('T10b invalid webhook signature rejected, nothing recorded', async () => {
  const { billId } = await confirmedBill(ownerA, 40);
  const intent = await makeIntent(ownerA, billId, 'DYNAMIC_QR');
  const delivery = adapter.buildWebhookDelivery({ eventId: 'evt-forged-' + billId, providerTxnId: intent.provider_ref, status: 'SUCCESS', amount: 40 });
  const w = await req('POST', '/api/payments/webhooks/mock',
    { raw_body: delivery.rawBody, signature: 'deadbeef'.repeat(8) }, ownerA.token, ownerA.shopId);
  assert.strictEqual(w.status, 401, JSON.stringify(w.body));
  const ev = (await query(`SELECT count(*)::int c FROM payment_provider_events WHERE event_id=$1`, ['evt-forged-' + billId])).rows[0].c;
  assert.strictEqual(ev, 0, 'unverified event is never persisted as valid');
  assert.strictEqual((await billRow(billId)).paid_state, 'UNPAID');
});

test('T11 mock dynamic QR failure: intent FAILED, bill stays UNPAID', async () => {
  const { billId } = await confirmedBill(ownerA, 70);
  const intent = await makeIntent(ownerA, billId, 'DYNAMIC_QR');
  const w = await webhook(ownerA, intent, { eventId: 'evt-fail-' + billId, status: 'FAILED' });
  assert.strictEqual(w.status, 200, JSON.stringify(w.body));
  assert.strictEqual(w.body.outcome, 'FAILED');
  const i = (await query('SELECT status FROM payment_intents WHERE id=$1', [intent.id])).rows[0];
  assert.strictEqual(i.status, 'FAILED');
  assert.strictEqual((await billRow(billId)).paid_state, 'UNPAID');
});

test('T12 expiry is lazy: expired intent cannot be confirmed by any path, audit PAYMENT_EXPIRED', async () => {
  const { billId } = await confirmedBill(ownerA, 90);
  // Cash path: intent already past expires_at.
  const cashIntent = await makeIntent(ownerA, billId, 'CASH', { expires_in_sec: -1 });
  const c = await req('POST', '/api/payments/intents/' + cashIntent.id + '/cash-confirm',
    { amount_received: 90 }, ownerA.token, ownerA.shopId);
  assert.strictEqual(c.status, 409, JSON.stringify(c.body));
  assert.strictEqual(c.body.code, 'INTENT_EXPIRED');
  const i1 = (await query('SELECT status FROM payment_intents WHERE id=$1', [cashIntent.id])).rows[0];
  assert.strictEqual(i1.status, 'EXPIRED', 'lazily transitioned to EXPIRED');
  // Dynamic path: a late success webhook on an expired intent cannot confirm either.
  const dynIntent = await makeIntent(ownerA, billId, 'DYNAMIC_QR', { expires_in_sec: -1 });
  const w = await webhook(ownerA, dynIntent, { eventId: 'evt-late-' + billId, status: 'SUCCESS' });
  assert.strictEqual(w.status, 200, JSON.stringify(w.body));
  assert.strictEqual(w.body.outcome, 'EXPIRED');
  const i2 = (await query('SELECT status FROM payment_intents WHERE id=$1', [dynIntent.id])).rows[0];
  assert.strictEqual(i2.status, 'EXPIRED');
  assert.strictEqual((await billRow(billId)).paid_state, 'UNPAID');
  const audit = (await query(
    `SELECT count(*)::int c FROM bill_audit_log WHERE bill_id=$1 AND action='PAYMENT_EXPIRED'`, [billId])).rows[0].c;
  assert.ok(audit >= 2, 'PAYMENT_EXPIRED audited for both lazy expiries, got ' + audit);
});

test('T13 duplicate provider event is a no-op (DB-level dedupe)', async () => {
  const { billId } = await confirmedBill(ownerA, 55);
  const intent = await makeIntent(ownerA, billId, 'DYNAMIC_QR');
  const eventId = 'evt-dup-' + billId;
  const w1 = await webhook(ownerA, intent, { eventId, status: 'SUCCESS' });
  assert.strictEqual(w1.body.outcome, 'CONFIRMED');
  const w2 = await webhook(ownerA, intent, { eventId, status: 'SUCCESS' });
  assert.strictEqual(w2.status, 200, JSON.stringify(w2.body));
  assert.strictEqual(w2.body.duplicate, true, 'replay detected as duplicate');
  const n = (await query('SELECT count(*)::int c FROM payment_transactions WHERE bill_id=$1', [billId])).rows[0].c;
  assert.strictEqual(n, 1, 'exactly one transaction despite the replayed event');
  const ev = (await query(`SELECT count(*)::int c FROM payment_provider_events WHERE event_id=$1`, [eventId])).rows[0].c;
  assert.strictEqual(ev, 1, 'exactly one event row');
});

// ─── 14: intent idempotency ──────────────────────────────────────────────────

test('T14 intent creation idempotent per (shop, provider, idempotency_key)', async () => {
  const { billId } = await confirmedBill(ownerA, 45);
  const i1 = await req('POST', '/api/payments/intents',
    { bill_id: billId, method: 'DYNAMIC_QR', idempotency_key: 'ik-' + billId }, ownerA.token, ownerA.shopId);
  assert.strictEqual(i1.status, 201);
  const i2 = await req('POST', '/api/payments/intents',
    { bill_id: billId, method: 'DYNAMIC_QR', idempotency_key: 'ik-' + billId }, ownerA.token, ownerA.shopId);
  assert.strictEqual(i2.status, 200, JSON.stringify(i2.body));
  assert.strictEqual(i2.body.already, true);
  assert.strictEqual(i2.body.intent.id, i1.body.intent.id, 'same intent returned for the double-tap');
});

// ─── 15-17: matching (amount/currency) ───────────────────────────────────────

test('T16 amount mismatch -> VERIFICATION_PENDING + PAYMENT_CONFIRMATION_REJECTED audit, never CONFIRMED', async () => {
  const { billId } = await confirmedBill(ownerA, 100);
  const intent = await makeIntent(ownerA, billId, 'DYNAMIC_QR');
  const w = await webhook(ownerA, intent, { eventId: 'evt-amt-' + billId, status: 'SUCCESS', amount: 99 });
  assert.strictEqual(w.status, 200, JSON.stringify(w.body));
  assert.strictEqual(w.body.outcome, 'VERIFICATION_PENDING');
  const i = (await query('SELECT status FROM payment_intents WHERE id=$1', [intent.id])).rows[0];
  assert.strictEqual(i.status, 'VERIFICATION_PENDING');
  assert.strictEqual((await billRow(billId)).paid_state, 'UNPAID');
  const audit = (await query(
    `SELECT reason FROM bill_audit_log WHERE bill_id=$1 AND action='PAYMENT_CONFIRMATION_REJECTED'`, [billId])).rows;
  assert.strictEqual(audit.length, 1);
  assert.strictEqual(audit[0].reason, 'AMOUNT_MISMATCH');
});

test('T17 currency mismatch -> VERIFICATION_PENDING, never CONFIRMED', async () => {
  const { billId } = await confirmedBill(ownerA, 100);
  const intent = await makeIntent(ownerA, billId, 'DYNAMIC_QR');
  const w = await webhook(ownerA, intent, { eventId: 'evt-cur-' + billId, status: 'SUCCESS', currency: 'USD' });
  assert.strictEqual(w.body.outcome, 'VERIFICATION_PENDING');
  const audit = (await query(
    `SELECT reason FROM bill_audit_log WHERE bill_id=$1 AND action='PAYMENT_CONFIRMATION_REJECTED'`, [billId])).rows;
  assert.strictEqual(audit.length, 1);
  assert.strictEqual(audit[0].reason, 'CURRENCY_MISMATCH');
  assert.strictEqual((await billRow(billId)).paid_state, 'UNPAID');
});

// ─── 15: online order mock flow (order-payment matching + kitchen release) ───

test('T15 online order mock flow: order accepted + kitchen_release_eligible ONLY after PAYMENT_CONFIRMED', async () => {
  const ok = await req('POST', '/api/payments/online-orders/mock-submit',
    { amount_due: 250 }, ownerA.token, ownerA.shopId);
  assert.strictEqual(ok.status, 201, JSON.stringify(ok.body));
  assert.strictEqual(ok.body.webhook_outcome, 'CONFIRMED');
  assert.strictEqual(ok.body.order_accepted, true);
  assert.strictEqual(ok.body.kitchen_release_eligible, true);
  assert.strictEqual(ok.body.bill.paid_state, 'PAID');
  // Failure path: payment fails -> order NOT accepted, kitchen NOT released.
  const bad = await req('POST', '/api/payments/online-orders/mock-submit',
    { amount_due: 250, simulate: 'fail' }, ownerA.token, ownerA.shopId);
  assert.strictEqual(bad.status, 201, JSON.stringify(bad.body));
  assert.strictEqual(bad.body.order_accepted, false);
  assert.strictEqual(bad.body.kitchen_release_eligible, false);
  assert.strictEqual(bad.body.bill.paid_state, 'UNPAID');
});

// ─── 18: receipt issuance ────────────────────────────────────────────────────

test('T18 receipt is ISSUED referencing the confirming transaction (all methods)', async () => {
  const { billId } = await confirmedBill(ownerA, 33);
  const intent = await makeIntent(ownerA, billId, 'DYNAMIC_QR');
  await webhook(ownerA, intent, { eventId: 'evt-rc-' + billId, status: 'SUCCESS' });
  const receipts = (await query('SELECT * FROM receipts WHERE bill_id=$1', [billId])).rows;
  assert.strictEqual(receipts.length, 1);
  assert.strictEqual(receipts[0].status, 'ISSUED');
  assert.ok(receipts[0].payment_transaction_id, 'receipt references its confirming transaction');
  assert.ok(receipts[0].receipt_no, 'receipt has a number');
  const audit = (await query(
    `SELECT count(*)::int c FROM bill_audit_log WHERE bill_id=$1 AND action='RECEIPT_ISSUED'`, [billId])).rows[0].c;
  assert.strictEqual(audit, 1);
});

// ─── 19: refund request model ────────────────────────────────────────────────

test('T19 refund model: REQUESTED -> APPROVED records requester/approver/reason, moves NO stock', async () => {
  const { billId } = await confirmedBill(ownerA, 100);
  const intent = await makeIntent(ownerA, billId, 'CASH');
  const c = await req('POST', '/api/payments/intents/' + intent.id + '/cash-confirm', { amount_received: 100 }, ownerA.token, ownerA.shopId);
  const txnId = c.body.transaction.id;
  const movesBefore = (await query('SELECT count(*)::int c FROM stock_movements WHERE shop_id=$1', [ownerA.shopId])).rows[0].c;

  const rq = await req('POST', '/api/payments/refunds', { transaction_id: txnId, amount: 40, reason: 'ลูกค้าเปลี่ยนใจ' }, ownerA.token, ownerA.shopId);
  assert.strictEqual(rq.status, 201, JSON.stringify(rq.body));
  assert.strictEqual(rq.body.refund.status, 'REQUESTED');
  assert.strictEqual(rq.body.refund.requested_by, ownerA.userId);

  const ap = await req('POST', '/api/payments/refunds/' + rq.body.refund.id + '/approve', { reason: 'อนุมัติ' }, ownerA.token, ownerA.shopId);
  assert.strictEqual(ap.status, 200, JSON.stringify(ap.body));
  assert.strictEqual(ap.body.refund.status, 'APPROVED');
  assert.strictEqual(ap.body.refund.approved_by, ownerA.userId);
  assert.ok(ap.body.refund.allocation_id, 'approval created a REFUND allocation');

  const movesAfter = (await query('SELECT count(*)::int c FROM stock_movements WHERE shop_id=$1', [ownerA.shopId])).rows[0].c;
  assert.strictEqual(movesAfter, movesBefore, 'refund approval moved ZERO stock');
  // A rejected refund creates no allocation.
  const rq2 = await req('POST', '/api/payments/refunds', { transaction_id: txnId, amount: 10 }, ownerA.token, ownerA.shopId);
  const rj = await req('POST', '/api/payments/refunds/' + rq2.body.refund.id + '/reject', { reason: 'no' }, ownerA.token, ownerA.shopId);
  assert.strictEqual(rj.body.refund.status, 'REJECTED');
  assert.strictEqual(rj.body.refund.allocation_id, null);
});

// ─── 20-21: tenant + branch isolation ────────────────────────────────────────

test('T20 tenant isolation: shop B cannot see or act on shop A bills/intents', async () => {
  const { billId } = await confirmedBill(ownerA, 25);
  const intent = await makeIntent(ownerA, billId, 'CASH');
  const g = await req('GET', '/api/payments/bills/' + billId, null, ownerB.token, ownerB.shopId);
  assert.strictEqual(g.status, 404, JSON.stringify(g.body));
  const c = await req('POST', '/api/payments/intents/' + intent.id + '/cash-confirm', { amount_received: 25 }, ownerB.token, ownerB.shopId);
  assert.strictEqual(c.status, 404, JSON.stringify(c.body));
  assert.strictEqual((await billRow(billId)).paid_state, 'UNPAID');
});

test('T21 branch isolation: a cashier of branch B cannot confirm branch A intents', async () => {
  // "Branch" = shop scoping in this platform. A staff cashier WITH payment_cash_confirm on
  // shop B still cannot touch shop A's intents (tenant middleware scopes them to B).
  const cashierEmail = 'paycashier_' + Date.now() + '@local.test';
  const cReg = await req('POST', '/auth/register', { email: cashierEmail, password: 'PayPlat#2026test', shopName: 'CASHIER OWN SHOP' });
  shopsToDelete.push(cReg.body.memberships[0].shop_id);
  await query(`INSERT INTO memberships(user_id, shop_id, role, permissions) VALUES ($1,$2,'staff',$3)`,
    [cReg.body.user.id, ownerB.shopId, JSON.stringify({ payment_cash_confirm: true, billing_view: true })]);
  const cTok = (await req('POST', '/auth/login', { email: cashierEmail, password: 'PayPlat#2026test' })).body.accessToken;

  const { billId } = await confirmedBill(ownerA, 20);
  const intent = await makeIntent(ownerA, billId, 'CASH');
  // Cashier asks for shop A explicitly — tenant middleware refuses (not a member) and scopes to
  // their own membership; the intent is invisible there.
  const c = await req('POST', '/api/payments/intents/' + intent.id + '/cash-confirm', { amount_received: 20 }, cTok, ownerA.shopId);
  assert.ok(c.status === 404 || c.status === 403, 'cross-branch confirm blocked: ' + c.status);
  assert.strictEqual((await billRow(billId)).paid_state, 'UNPAID');
});

// ─── 22: dashboard permissions + shape ───────────────────────────────────────

test('T22 dashboard read API: permission-gated, joined view + filters', async () => {
  const { billId } = await confirmedBill(ownerA, 100);
  const intent = await makeIntent(ownerA, billId, 'CASH');
  await req('POST', '/api/payments/intents/' + intent.id + '/cash-confirm', { amount_received: 100 }, ownerA.token, ownerA.shopId);

  // Bare staff (no billing_view) -> 403 fail-closed.
  const sEmail = 'paydash_' + Date.now() + '@local.test';
  const sReg = await req('POST', '/auth/register', { email: sEmail, password: 'PayPlat#2026test', shopName: 'DASH STAFF SHOP' });
  shopsToDelete.push(sReg.body.memberships[0].shop_id);
  await query(`INSERT INTO memberships(user_id, shop_id, role) VALUES ($1,$2,'staff')`, [sReg.body.user.id, ownerA.shopId]);
  const sTok = (await req('POST', '/auth/login', { email: sEmail, password: 'PayPlat#2026test' })).body.accessToken;
  const denied = await req('GET', '/api/payments/dashboard', null, sTok, ownerA.shopId);
  assert.strictEqual(denied.status, 403, JSON.stringify(denied.body));

  // Owner sees the joined row for the bill, with method filter applied.
  const ok = await req('GET', '/api/payments/dashboard?method=CASH&bill_id=' + billId, null, ownerA.token, ownerA.shopId);
  assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
  const row = ok.body.rows.find((r) => r.bill_id === billId);
  assert.ok(row, 'dashboard returns the bill');
  assert.strictEqual(row.method, 'CASH');
  assert.strictEqual(row.transaction_status, 'CONFIRMED');
  assert.strictEqual(row.intent_status, 'CONFIRMED');
  assert.strictEqual(row.paid_state, 'PAID');
  assert.ok('amount_matches' in row && 'manual_review_flag' in row && 'confirmed_by' in row && 'expires_at' in row,
    'joined view carries verification/confirmer/expiry columns');
  // Tenant scope: owner B sees none of shop A's rows.
  const other = await req('GET', '/api/payments/dashboard?bill_id=' + billId, null, ownerB.token, ownerB.shopId);
  assert.strictEqual(other.body.rows.length, 0);
});

// ─── 23: audit coverage ──────────────────────────────────────────────────────

test('T23 audit trail covers >= 6 distinct payment event kinds in this run', async () => {
  const kinds = (await query(
    `SELECT DISTINCT action FROM bill_audit_log WHERE shop_id=$1 AND action IN
       ('BILL_CREATED','BILL_CONFIRMED','PAYMENT_INTENT_CREATED','CASH_PAYMENT_CONFIRMED',
        'STATIC_QR_DISPLAYED','STATIC_QR_MANUALLY_CONFIRMED','PAYMENT_CONFIRMATION_REJECTED',
        'PAYMENT_EXPIRED','PAYMENT_CANCELLED','RECEIPT_ISSUED','REFUND_REQUESTED',
        'REFUND_APPROVED','REFUND_REJECTED','RECONCILIATION_FLAGGED','RECONCILIATION_RESOLVED')`,
    [ownerA.shopId]
  )).rows.map((r) => r.action);
  assert.ok(kinds.length >= 6, 'expected >=6 distinct audit kinds, got: ' + kinds.join(','));
});

// ═══ FOUNDER CORRECTION TESTS (6) ════════════════════════════════════════════

test('C1 two valid partial payments on one bill: sum == due -> PAID', async () => {
  const { billId } = await confirmedBill(ownerA, 100);
  const i1 = await makeIntent(ownerA, billId, 'CASH', { amount: 60 });
  const c1 = await req('POST', '/api/payments/intents/' + i1.id + '/cash-confirm', { amount_received: 60 }, ownerA.token, ownerA.shopId);
  assert.strictEqual(c1.status, 201, JSON.stringify(c1.body));
  assert.strictEqual(c1.body.paid_state, 'PARTIALLY_PAID');
  assert.strictEqual((await billRow(billId)).paid_state, 'PARTIALLY_PAID');
  const i2 = await makeIntent(ownerA, billId, 'CASH', { amount: 40 });
  const c2 = await req('POST', '/api/payments/intents/' + i2.id + '/cash-confirm', { amount_received: 40 }, ownerA.token, ownerA.shopId);
  assert.strictEqual(c2.status, 201, JSON.stringify(c2.body));
  assert.strictEqual(c2.body.paid_state, 'PAID');
  // TWO CONFIRMED transactions coexist on one bill — the overruled index would have forbidden this.
  const n = (await query(`SELECT count(*)::int c FROM payment_transactions WHERE bill_id=$1 AND status='CONFIRMED'`, [billId])).rows[0].c;
  assert.strictEqual(n, 2, 'two CONFIRMED transactions on one bill are valid');
});

test('C2 mixed methods cash + QR on one bill -> PAID', async () => {
  const { billId } = await confirmedBill(ownerA, 200);
  const cash = await makeIntent(ownerA, billId, 'CASH', { amount: 120 });
  const cc = await req('POST', '/api/payments/intents/' + cash.id + '/cash-confirm', { amount_received: 120 }, ownerA.token, ownerA.shopId);
  assert.strictEqual(cc.body.paid_state, 'PARTIALLY_PAID');
  const qr = await makeIntent(ownerA, billId, 'DYNAMIC_QR', { amount: 80 });
  const w = await webhook(ownerA, qr, { eventId: 'evt-mix-' + billId, status: 'SUCCESS', amount: 80 });
  assert.strictEqual(w.body.outcome, 'CONFIRMED', JSON.stringify(w.body));
  const b = await billRow(billId);
  assert.strictEqual(b.paid_state, 'PAID');
  const methods = (await query(
    `SELECT DISTINCT method FROM payment_transactions WHERE bill_id=$1 AND status='CONFIRMED' ORDER BY method`, [billId]
  )).rows.map((r) => r.method);
  assert.deepStrictEqual(methods, ['CASH', 'DYNAMIC_QR'], 'both methods confirmed on the same bill');
});

test('C3 over-allocation rejected: second confirm that would exceed due fails atomically', async () => {
  const { billId } = await confirmedBill(ownerA, 100);
  // Both intents created while remaining=100 — so intent-level caps pass; the ALLOCATION
  // invariant is what must catch the second confirm.
  const i1 = await makeIntent(ownerA, billId, 'CASH', { amount: 60, idempotency_key: 'oa1-' + billId });
  const i2 = await makeIntent(ownerA, billId, 'CASH', { amount: 60, idempotency_key: 'oa2-' + billId });
  const c1 = await req('POST', '/api/payments/intents/' + i1.id + '/cash-confirm', { amount_received: 60 }, ownerA.token, ownerA.shopId);
  assert.strictEqual(c1.status, 201);
  const c2 = await req('POST', '/api/payments/intents/' + i2.id + '/cash-confirm', { amount_received: 60 }, ownerA.token, ownerA.shopId);
  assert.strictEqual(c2.status, 409, JSON.stringify(c2.body));
  assert.strictEqual(c2.body.code, 'OVER_ALLOCATION');
  // The whole confirm rolled back: net stays 60, exactly one CONFIRMED txn + one allocation.
  const b = await billRow(billId);
  assert.strictEqual(b.paid_state, 'PARTIALLY_PAID');
  const n = (await query(`SELECT count(*)::int c FROM payment_transactions WHERE bill_id=$1 AND status='CONFIRMED'`, [billId])).rows[0].c;
  assert.strictEqual(n, 1, 'over-allocating transaction was rolled back with its allocation');
  const na = (await query(`SELECT count(*)::int c FROM payment_allocations WHERE bill_id=$1`, [billId])).rows[0].c;
  assert.strictEqual(na, 1);
});

test('C4 duplicate provider transaction rejected: unique (provider, provider_txn_id)', async () => {
  const { billId } = await confirmedBill(ownerA, 30);
  const txnRef = 'mock_txn_dup_' + billId.slice(0, 8);
  await query(
    `INSERT INTO payment_transactions (shop_id, bill_id, method, provider, expected_amount, paid_amount, currency, status, provider_txn_id, confirmed_at, confirmed_by)
     VALUES ($1,$2,'DYNAMIC_QR','MOCK',30,30,'THB','CONFIRMED',$3,now(),'webhook:MOCK')`,
    [ownerA.shopId, billId, txnRef]);
  await assert.rejects(
    query(
      `INSERT INTO payment_transactions (shop_id, bill_id, method, provider, expected_amount, paid_amount, currency, status, provider_txn_id, confirmed_at, confirmed_by)
       VALUES ($1,$2,'DYNAMIC_QR','MOCK',30,30,'THB','CONFIRMED',$3,now(),'webhook:MOCK')`,
      [ownerA.shopId, billId, txnRef]),
    (e) => e.code === '23505' && /payment_transactions_provider_txn_idx/.test(e.message || e.constraint || ''),
    'same provider txn id must violate the unique index');
});

test('C5 reversal then replacement payment succeeds', async () => {
  const { billId } = await confirmedBill(ownerA, 100);
  const i1 = await makeIntent(ownerA, billId, 'CASH');
  const c1 = await req('POST', '/api/payments/intents/' + i1.id + '/cash-confirm', { amount_received: 100 }, ownerA.token, ownerA.shopId);
  assert.strictEqual(c1.body.paid_state, 'PAID');
  // Reverse (wrong payment recorded) — net returns to 0, bill payable again.
  const rv = await req('POST', '/api/payments/transactions/' + c1.body.transaction.id + '/reverse', { reason: 'keyed wrong' }, ownerA.token, ownerA.shopId);
  assert.strictEqual(rv.status, 200, JSON.stringify(rv.body));
  assert.strictEqual(rv.body.paid_state, 'UNPAID');
  const t1 = (await query('SELECT status FROM payment_transactions WHERE id=$1', [c1.body.transaction.id])).rows[0];
  assert.strictEqual(t1.status, 'REVERSED');
  // Replacement payment on the same bill.
  const i2 = await makeIntent(ownerA, billId, 'CASH');
  const c2 = await req('POST', '/api/payments/intents/' + i2.id + '/cash-confirm', { amount_received: 100 }, ownerA.token, ownerA.shopId);
  assert.strictEqual(c2.status, 201, JSON.stringify(c2.body));
  assert.strictEqual(c2.body.paid_state, 'PAID');
  const b = await billRow(billId);
  assert.strictEqual(b.paid_state, 'PAID');
});

test('C6 approved refund reduces net paid: PAID -> PARTIALLY_PAID', async () => {
  const { billId } = await confirmedBill(ownerA, 100);
  const intent = await makeIntent(ownerA, billId, 'CASH');
  const c = await req('POST', '/api/payments/intents/' + intent.id + '/cash-confirm', { amount_received: 100 }, ownerA.token, ownerA.shopId);
  assert.strictEqual(c.body.paid_state, 'PAID');
  const rq = await req('POST', '/api/payments/refunds', { transaction_id: c.body.transaction.id, amount: 30, reason: 'ของหมด 1 รายการ' }, ownerA.token, ownerA.shopId);
  const ap = await req('POST', '/api/payments/refunds/' + rq.body.refund.id + '/approve', {}, ownerA.token, ownerA.shopId);
  assert.strictEqual(ap.status, 200, JSON.stringify(ap.body));
  assert.strictEqual(ap.body.paid_state, 'PARTIALLY_PAID');
  const b = await billRow(billId);
  assert.strictEqual(b.paid_state, 'PARTIALLY_PAID');
  const t = (await query('SELECT status, refund_total FROM payment_transactions WHERE id=$1', [c.body.transaction.id])).rows[0];
  assert.strictEqual(t.status, 'PARTIALLY_REFUNDED');
  assert.strictEqual(Number(t.refund_total), 30);
  // Net = 100 - 30 = 70 from allocations directly.
  const net = (await query(
    `SELECT COALESCE(SUM(amount) FILTER (WHERE kind='PAYMENT' AND status='ACTIVE'),0)
          - COALESCE(SUM(amount) FILTER (WHERE kind='REFUND' AND status='ACTIVE'),0) AS net
       FROM payment_allocations WHERE bill_id=$1`, [billId])).rows[0].net;
  assert.strictEqual(Number(net), 70);
});
