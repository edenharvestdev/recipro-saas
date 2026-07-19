// Store Payment Dashboard (feat/payment-dashboard-foundation) — API + frontend-extraction tests.
// Real HTTP against the REAL express app + REAL local Postgres (pattern:
// payment-platform.test.js). Throwaway shops per run, deleted in after().
// Mock provider only — zero external network. Flag ON for this file (per-request check),
// except the explicit flag-off test which flips it per request.
require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const DB = process.env.DATABASE_URL || '';
if (!/@(localhost|127\.0\.0\.1)[:/]/.test(DB)) {
  throw new Error('refusing to run: DATABASE_URL is not local');
}
process.env.PAYMENT_PLATFORM_ENABLED = '1';

const { pool, query } = require('../src/db');
const app = require('../src/app');
const { MockProviderAdapter } = require('../src/payments/mock-adapter');
const adapter = new MockProviderAdapter();

let server, base;
const shopsToDelete = [];

const req = (method, p, body, tok, shop) => new Promise((resolve, reject) => {
  const data = body != null ? JSON.stringify(body) : null;
  const r = http.request(base + p, {
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
  const reg = await req('POST', '/auth/register', { email, password: 'PayDash#2026test', shopName: 'PAYDASH TEST ' + prefix });
  assert.strictEqual(reg.status, 200, 'register failed: ' + JSON.stringify(reg.body));
  const shopId = reg.body.memberships[0].shop_id;
  shopsToDelete.push(shopId);
  return { token: reg.body.accessToken, shopId, userId: reg.body.user.id, email };
}

// Registers a user, attaches them to `shopId` as staff with the given explicit per-user
// permissions object (memberships.permissions — the A1 granular path tenant.js resolves first).
async function registerStaff(shopId, perms) {
  const email = 'paydash_staff_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6) + '@local.test';
  const reg = await req('POST', '/auth/register', { email, password: 'PayDash#2026test', shopName: 'PAYDASH STAFF OWN ' + email.slice(0, 8) });
  assert.strictEqual(reg.status, 200, JSON.stringify(reg.body));
  shopsToDelete.push(reg.body.memberships[0].shop_id);
  await query(`INSERT INTO memberships(user_id, shop_id, role, permissions) VALUES ($1,$2,'staff',$3)`,
    [reg.body.user.id, shopId, perms ? JSON.stringify(perms) : null]);
  const login = await req('POST', '/auth/login', { email, password: 'PayDash#2026test' });
  return { token: login.body.accessToken, userId: reg.body.user.id };
}

async function confirmedBill(owner, amount) {
  const created = await req('POST', '/api/payments/bills', { amount_due: amount }, owner.token, owner.shopId);
  assert.strictEqual(created.status, 201, JSON.stringify(created.body));
  const billId = created.body.bill.id;
  const conf = await req('POST', '/api/payments/bills/' + billId + '/confirm', {}, owner.token, owner.shopId);
  assert.strictEqual(conf.status, 201, JSON.stringify(conf.body));
  return { billId, billNo: conf.body.bill.number };
}

async function makeIntent(owner, billId, method, extra) {
  const r = await req('POST', '/api/payments/intents',
    Object.assign({ bill_id: billId, method }, extra || {}), owner.token, owner.shopId);
  assert.ok(r.status === 201 || r.status === 200, 'intent create failed: ' + JSON.stringify(r.body));
  return r.body.intent;
}

async function cashConfirm(owner, intentId, amount) {
  const r = await req('POST', '/api/payments/intents/' + intentId + '/cash-confirm',
    { amount_received: amount }, owner.token, owner.shopId);
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  return r.body;
}

async function webhook(owner, intent, { eventId, status, amount }) {
  const d = adapter.buildWebhookDelivery({
    eventId, providerTxnId: intent.provider_ref, status,
    amount: amount != null ? amount : Number(intent.amount_due), currency: 'THB',
  });
  return req('POST', '/api/payments/webhooks/mock',
    { raw_body: d.rawBody, signature: d.signature }, owner.token, owner.shopId);
}

const dash = (owner, qs) => req('GET', '/api/payments/dashboard' + (qs ? '?' + qs : ''), null, owner.token, owner.shopId);

let ownerA, ownerB;
// Fixture bills (created once in before(), asserted across the filter tests)
let fx = {};

test.before(async () => {
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  base = 'http://127.0.0.1:' + server.address().port;
  ownerA = await registerOwner('pdasha');
  ownerB = await registerOwner('pdashb');

  // billCash: CASH confirmed + reconciliation-flagged (manual-review target)
  const bc = await confirmedBill(ownerA, 100);
  const ic = await makeIntent(ownerA, bc.billId, 'CASH');
  const cc = await cashConfirm(ownerA, ic.id, 100);
  const flag = await req('POST', '/api/payments/reconciliation/' + cc.transaction.id + '/flag',
    { status: 'AMOUNT_MISMATCH', notes: 'test mismatch' }, ownerA.token, ownerA.shopId);
  assert.strictEqual(flag.status, 201, JSON.stringify(flag.body));
  fx.billCash = { ...bc, txnId: cc.transaction.id };

  // billDyn: DYNAMIC_QR confirmed via signed webhook (clean row — NOT manual-review)
  const bd = await confirmedBill(ownerA, 250);
  const idn = await makeIntent(ownerA, bd.billId, 'DYNAMIC_QR');
  const w = await webhook(ownerA, idn, { eventId: 'pd-evt-ok-' + bd.billId, status: 'SUCCESS' });
  assert.strictEqual(w.status, 200, JSON.stringify(w.body));
  fx.billDyn = bd;

  // billFail: DYNAMIC_QR failed webhook → intent FAILED. NOTE: a failed webhook records NO
  // payment_transactions row (service.js only flips the intent), so this bill is invisible to
  // the transaction-status filter by design — kept as the intent-failure display fixture.
  const bf = await confirmedBill(ownerA, 60);
  const ifl = await makeIntent(ownerA, bf.billId, 'DYNAMIC_QR');
  const wf = await webhook(ownerA, ifl, { eventId: 'pd-evt-fail-' + bf.billId, status: 'FAILED' });
  assert.strictEqual(wf.status, 200, JSON.stringify(wf.body));
  fx.billFail = bf;

  // billRev: CASH confirmed then REVERSED — a real terminal transaction state the status
  // filter can select (unlike a failed webhook, a reversal lives on the transaction row).
  const brv = await confirmedBill(ownerA, 130);
  const irv = await makeIntent(ownerA, brv.billId, 'CASH');
  const crv = await cashConfirm(ownerA, irv.id, 130);
  const rev = await req('POST', '/api/payments/transactions/' + crv.transaction.id + '/reverse',
    { reason: 'test reversal' }, ownerA.token, ownerA.shopId);
  assert.strictEqual(rev.status, 200, JSON.stringify(rev.body));
  fx.billRev = brv;

  // billOrder: CASH confirmed + linked to an orders row (order_no filter/column target)
  const bo = await confirmedBill(ownerA, 75);
  const io = await makeIntent(ownerA, bo.billId, 'CASH');
  const co = await cashConfirm(ownerA, io.id, 75);
  const ord = (await query(
    `INSERT INTO orders (shop_id, order_no, total, status) VALUES ($1,'PD-ORD-4242',75,'collected') RETURNING id`,
    [ownerA.shopId])).rows[0];
  await query(`UPDATE payment_transactions SET order_id=$1 WHERE id=$2`, [ord.id, co.transaction.id]);
  fx.billOrder = bo;

  // shop B: one confirmed cash bill of its own (tenant-isolation control row)
  const bb = await confirmedBill(ownerB, 40);
  const ib = await makeIntent(ownerB, bb.billId, 'CASH');
  await cashConfirm(ownerB, ib.id, 40);
  fx.billB = bb;
});

test.after(async () => {
  for (const id of shopsToDelete) await pool.query('delete from shops where id=$1', [id]);
  await new Promise((r) => server.close(r));
  await pool.end();
});

// ─── D1: permission enforcement ──────────────────────────────────────────────

test('D1 dashboard/audit/status: no permission -> 403; billing_view OR payment_review -> 200', async () => {
  // Bare staff (explicit empty perms object → no payment keys granted) — fail-closed on all three.
  const bare = await registerStaff(ownerA.shopId, { pos_view: true });
  for (const p of ['/api/payments/dashboard', '/api/payments/status', '/api/payments/bills/' + fx.billCash.billId + '/audit']) {
    const r = await req('GET', p, null, bare.token, ownerA.shopId);
    assert.strictEqual(r.status, 403, p + ' should 403 for bare staff: ' + JSON.stringify(r.body));
  }
  // billing_view alone is enough…
  const viewer = await registerStaff(ownerA.shopId, { billing_view: true });
  assert.strictEqual((await req('GET', '/api/payments/dashboard', null, viewer.token, ownerA.shopId)).status, 200);
  assert.strictEqual((await req('GET', '/api/payments/status', null, viewer.token, ownerA.shopId)).status, 200);
  // …and payment_review alone is too (requireAnyPerm OR-gate, per the Founder's access spec).
  const reviewer = await registerStaff(ownerA.shopId, { payment_review: true });
  assert.strictEqual((await req('GET', '/api/payments/dashboard', null, reviewer.token, ownerA.shopId)).status, 200);
  const aud = await req('GET', '/api/payments/bills/' + fx.billCash.billId + '/audit', null, reviewer.token, ownerA.shopId);
  assert.strictEqual(aud.status, 200, JSON.stringify(aud.body));
});

// ─── D2: filters actually filter ─────────────────────────────────────────────

test('D2 status filter: REVERSED returns only the reversed-txn bill, CONFIRMED excludes it', async () => {
  const r = await dash(ownerA, 'status=REVERSED');
  assert.strictEqual(r.status, 200);
  const ids = r.body.rows.map((x) => x.bill_id);
  assert.ok(ids.includes(fx.billRev.billId), 'reversed bill present');
  assert.ok(!ids.includes(fx.billCash.billId) && !ids.includes(fx.billDyn.billId), 'confirmed bills excluded');
  assert.ok(r.body.rows.every((x) => x.transaction_status === 'REVERSED'), 'every row matches the filter');
  const c = await dash(ownerA, 'status=CONFIRMED');
  assert.ok(!c.body.rows.some((x) => x.bill_id === fx.billRev.billId && x.transaction_status === 'REVERSED'),
    'CONFIRMED filter excludes the reversed transaction');
});

test('D2b method filter: DYNAMIC_QR excludes cash bills (and vice versa)', async () => {
  const dyn = await dash(ownerA, 'method=DYNAMIC_QR');
  const dynIds = dyn.body.rows.map((x) => x.bill_id);
  assert.ok(dynIds.includes(fx.billDyn.billId));
  assert.ok(!dynIds.includes(fx.billCash.billId));
  const cash = await dash(ownerA, 'method=CASH');
  const cashIds = cash.body.rows.map((x) => x.bill_id);
  assert.ok(cashIds.includes(fx.billCash.billId));
  assert.ok(!cashIds.includes(fx.billDyn.billId));
});

test('D2c date-range filter includes today and excludes a disjoint range', async () => {
  const inRange = await dash(ownerA, 'date_from=2000-01-01T00:00:00Z&date_to=2099-01-01T00:00:00Z');
  assert.ok(inRange.body.rows.some((x) => x.bill_id === fx.billCash.billId), 'wide range contains the bill');
  const future = await dash(ownerA, 'date_from=2099-01-01T00:00:00Z');
  assert.strictEqual(future.body.rows.filter((x) => x.transaction_id).length, 0, 'future-only range has no txn rows');
  const past = await dash(ownerA, 'date_to=2000-01-01T00:00:00Z');
  assert.strictEqual(past.body.rows.filter((x) => x.transaction_id).length, 0, 'past-only range has no txn rows');
});

test('D2d bill_no filter matches exactly the one bill (partial, case-insensitive)', async () => {
  const r = await dash(ownerA, 'bill_no=' + encodeURIComponent(fx.billDyn.billNo));
  assert.strictEqual(r.status, 200);
  assert.ok(r.body.rows.length >= 1, 'at least the matching row');
  assert.ok(r.body.rows.every((x) => x.bill_no === fx.billDyn.billNo), 'every row carries the filtered bill number');
  assert.ok(r.body.rows.some((x) => x.bill_id === fx.billDyn.billId));
});

test('D2e order_no filter resolves through the orders join and surfaces order_no in the row', async () => {
  const r = await dash(ownerA, 'order_no=PD-ORD-4242');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.rows.length, 1, JSON.stringify(r.body.rows));
  assert.strictEqual(r.body.rows[0].bill_id, fx.billOrder.billId);
  assert.strictEqual(r.body.rows[0].order_no, 'PD-ORD-4242');
});

test('D2f manual_review=1 returns only reconciliation-flagged rows, with the flag set', async () => {
  const r = await dash(ownerA, 'manual_review=1');
  assert.strictEqual(r.status, 200);
  assert.ok(r.body.rows.length >= 1);
  assert.ok(r.body.rows.every((x) => x.manual_review_flag === true), 'every row is flagged');
  const ids = r.body.rows.map((x) => x.bill_id);
  assert.ok(ids.includes(fx.billCash.billId), 'flagged bill present');
  assert.ok(!ids.includes(fx.billDyn.billId), 'clean bill excluded');
});

// ─── D3: tenant isolation ────────────────────────────────────────────────────

test('D3 tenant isolation: shop B never sees shop A rows (and vice versa), incl. audit', async () => {
  const b = await dash(ownerB);
  assert.strictEqual(b.status, 200);
  const aBillIds = [fx.billCash.billId, fx.billDyn.billId, fx.billFail.billId, fx.billOrder.billId];
  assert.ok(b.body.rows.every((x) => !aBillIds.includes(x.bill_id)), 'no shop A bill leaks into shop B');
  assert.ok(b.body.rows.some((x) => x.bill_id === fx.billB.billId), 'shop B sees its own bill');
  const a = await dash(ownerA);
  assert.ok(a.body.rows.every((x) => x.bill_id !== fx.billB.billId), 'no shop B bill leaks into shop A');
  // audit endpoint is shop-scoped too: shop B asking for shop A's bill gets an empty trail
  const aud = await req('GET', '/api/payments/bills/' + fx.billCash.billId + '/audit', null, ownerB.token, ownerB.shopId);
  assert.strictEqual(aud.status, 200);
  assert.strictEqual(aud.body.audit.length, 0, 'cross-tenant audit read returns nothing');
});

// ─── D4: no raw provider payloads / secrets in any dashboard response ───────

test('D4 responses carry provider reference id only — no raw payloads/signatures/snapshots', async () => {
  const r = await dash(ownerA);
  assert.strictEqual(r.status, 200);
  const raw = JSON.stringify(r.body);
  for (const forbidden of ['raw_body', '"payload"', '"signature"', '"snapshot"', 'secret', 'MOCK_WEBHOOK']) {
    assert.ok(!raw.includes(forbidden), 'dashboard response must not contain ' + forbidden);
  }
  const dynRow = r.body.rows.find((x) => x.bill_id === fx.billDyn.billId);
  assert.ok(dynRow.provider_txn_id, 'provider reference id IS present');
  assert.ok(!('raw_event_ref' in dynRow), 'raw event reference not exposed');
  // audit endpoint: action/actor/reason/time only — the snapshot jsonb (which can embed
  // provider event data) is never selected
  const aud = await req('GET', '/api/payments/bills/' + fx.billDyn.billId + '/audit', null, ownerA.token, ownerA.shopId);
  assert.strictEqual(aud.status, 200);
  assert.ok(aud.body.audit.length >= 3, 'audit trail exists');
  for (const row of aud.body.audit) {
    assert.deepStrictEqual(Object.keys(row).sort(), ['action', 'actor_name', 'created_at', 'reason']);
  }
});

// ─── D5: flag OFF → 503 everywhere (server half of "nav absent when flag off") ──

test('D5 flag OFF: dashboard, status probe and audit all 503 — so the nav probe fails closed', async () => {
  delete process.env.PAYMENT_PLATFORM_ENABLED;
  try {
    for (const p of ['/api/payments/dashboard', '/api/payments/status', '/api/payments/bills/' + fx.billCash.billId + '/audit']) {
      const r = await req('GET', p, null, ownerA.token, ownerA.shopId);
      assert.strictEqual(r.status, 503, p + ' must 503 while OFF');
      assert.strictEqual(r.body.error, 'PAYMENT_PLATFORM_DISABLED');
    }
  } finally {
    process.env.PAYMENT_PLATFORM_ENABLED = '1';
  }
});

// ─── F: frontend extraction checks (static source assertions on the SPA) ────

const INDEX_SRC = fs.readFileSync(path.join(__dirname, '../../frontend/index.html'), 'utf8');

test('F1 dashboard page + nav item exist; nav ships hidden and is only un-hidden by the /status probe', () => {
  assert.ok(INDEX_SRC.includes('id="paydashPage"'), 'paydashPage section exists');
  const nav = INDEX_SRC.match(/<a class="([^"]*)" id="menuPaydash"/);
  assert.ok(nav, 'menuPaydash nav item exists');
  assert.ok(nav[1].split(/\s+/).includes('hidden'), 'nav item ships hidden in static HTML (flag off ⇒ zero UI difference)');
  // The ONLY un-hide of menuPaydash lives inside initPayDashNav, after the status probe succeeds.
  const initFn = INDEX_SRC.slice(INDEX_SRC.indexOf('async function initPayDashNav'), INDEX_SRC.indexOf('async function loadPayDash'));
  assert.ok(initFn.includes("API.get('/api/payments/status')"), 'nav probe hits /api/payments/status');
  assert.ok(initFn.includes("classList.remove('hidden')"), 'probe success un-hides the nav');
  const removals = (INDEX_SRC.match(/menuPaydash[\s\S]{0,120}?classList\.remove\('hidden'\)/g) || []).length;
  assert.strictEqual(removals, 1, 'exactly one code path un-hides the dashboard nav');
});

test('F2 all 14 Founder columns are present in the dashboard table header', () => {
  const section = INDEX_SRC.slice(INDEX_SRC.indexOf('<section id="paydashPage"'), INDEX_SRC.indexOf('</section>', INDEX_SRC.indexOf('<section id="paydashPage"')));
  const columns = ['เลขออเดอร์', 'เลขที่บิล', 'ยอดเงิน', 'วิธีชำระ', 'สถานะ Intent', 'สถานะธุรกรรม',
    'การตรวจสอบ', 'เวลาสร้าง', 'เวลาชำระ', 'หมดอายุ', 'ผู้ยืนยัน', 'อ้างอิงผู้ให้บริการ',
    'ยอดตรงกัน', 'ตรวจสอบด้วยตนเอง'];
  assert.ok(section.includes('<th'), 'table header exists');
  for (const col of columns) assert.ok(section.includes(col), 'missing column header: ' + col);
});

test('F3 client render is permission-gated on billing_view/payment_review (server stays the authority)', () => {
  assert.ok(/t === 'paydash'\)\s*return can\('billing_view'\) \|\| can\('payment_review'\)/.test(INDEX_SRC),
    'staffTabAllowed gates the paydash tab on billing_view OR payment_review');
  assert.ok(INDEX_SRC.includes("USER_ROLE !== 'staff' || can('billing_view') || can('payment_review')"),
    'paydashAllowed mirrors the server requireAnyPerm keys');
});

test('F4 dashboard markup + code reference no external URL', () => {
  const sectionStart = INDEX_SRC.indexOf('<section id="paydashPage"');
  const section = INDEX_SRC.slice(sectionStart, INDEX_SRC.indexOf('</section>', sectionStart));
  const jsStart = INDEX_SRC.indexOf('STORE PAYMENT DASHBOARD (feat/payment-dashboard-foundation)');
  const js = INDEX_SRC.slice(jsStart, INDEX_SRC.indexOf('</script>', jsStart));
  assert.ok(jsStart > 0, 'dashboard JS block found');
  const EXTERNAL_URL = /https?:\/\/(?!127\.0\.0\.1|localhost)/;
  assert.ok(!EXTERNAL_URL.test(section), 'no external URL in the dashboard section markup');
  assert.ok(!EXTERNAL_URL.test(js), 'no external URL in the dashboard JS');
});

test('F5 badge maps cover every intent, transaction and paid state', () => {
  const block = (name) => {
    const s = INDEX_SRC.indexOf('const ' + name + ' = {');
    assert.ok(s > 0, name + ' map exists');
    return INDEX_SRC.slice(s, INDEX_SRC.indexOf('};', s));
  };
  const intentBlock = block('PAYDASH_INTENT_BADGES');
  // state lists mirror backend/db/schema-payment-platform.sql CHECK constraints
  const INTENT_STATES = ['CREATED', 'AWAITING_PAYMENT', 'QR_DISPLAYED', 'AWAITING_MANUAL_CONFIRMATION',
    'INITIATED', 'VERIFICATION_PENDING', 'CONFIRMED', 'FAILED', 'EXPIRED', 'CANCELLED'];
  for (const st of INTENT_STATES) assert.ok(new RegExp('\\b' + st + ':').test(intentBlock), 'intent badge missing: ' + st);
  const txnBlock = block('PAYDASH_TXN_BADGES');
  const TXN_STATES = ['RECEIVED', 'VERIFYING', 'CONFIRMED', 'FAILED', 'REVERSED', 'PARTIALLY_REFUNDED', 'REFUNDED'];
  for (const st of TXN_STATES) assert.ok(new RegExp('\\b' + st + ':').test(txnBlock), 'txn badge missing: ' + st);
  const paidBlock = block('PAYDASH_PAID_BADGES');
  for (const st of ['UNPAID', 'PARTIALLY_PAID', 'PAID']) assert.ok(new RegExp('\\b' + st + ':').test(paidBlock), 'paid badge missing: ' + st);
});

test('F6 filters and audit-expand are wired in the page', () => {
  const ids = ['pdFilterStatus', 'pdFilterMethod', 'pdFilterFrom', 'pdFilterTo',
    'pdFilterOrderNo', 'pdFilterBillNo', 'pdFilterManualReview'];
  for (const id of ids) assert.ok(INDEX_SRC.includes('id="' + id + '"'), 'missing filter control: ' + id);
  assert.ok(INDEX_SRC.includes('togglePayDashAudit'), 'row expand → audit handler exists');
  assert.ok(INDEX_SRC.includes("'/api/payments/bills/' + billId + '/audit'"), 'audit fetch targets the gated endpoint');
});
