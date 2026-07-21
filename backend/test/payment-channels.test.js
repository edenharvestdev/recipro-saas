// Payment Channel config layer (PC-1) — API + migration tests.
// Design: PAYMENT_CHANNEL_DESIGN_2026-07-20.md (REV 3) §9 test scenarios (config-layer subset —
// intent/transaction binding scenarios are PC-2).
// Harness pattern: payment-platform.test.js — real HTTP against the REAL express app + REAL
// local Postgres, throwaway shops per run, deleted in after().
// NODE_ENV=test uses rate-limit.js's built-in test escape: this suite registers >10 throwaway
// owners, which would otherwise trip the 10/hour/IP register limiter mid-suite.
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
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
process.env.PAYMENT_PLATFORM_ENABLED = '1';   // flag ON for this file (checked per request)

const { pool, query } = require('../src/db');
const app = require('../src/app');
const { PRESETS } = require('../src/permissions/catalog');

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
  const reg = await req('POST', '/auth/register', { email, password: 'PayChan#2026test', shopName: 'PAYMENT CHANNEL TEST ' + prefix });
  assert.strictEqual(reg.status, 200, 'register failed: ' + JSON.stringify(reg.body));
  const shopId = reg.body.memberships[0].shop_id;
  shopsToDelete.push(shopId);
  return { token: reg.body.accessToken, shopId, userId: reg.body.user.id, email };
}

// Registers a user and attaches them to `shopId` as staff with the given per-user permissions
// object (memberships.permissions — the granular path tenant.js resolves first). Pattern:
// payment-dashboard.test.js.
async function registerStaff(shopId, perms) {
  const email = 'paych_staff_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6) + '@local.test';
  const reg = await req('POST', '/auth/register', { email, password: 'PayChan#2026test', shopName: 'PAYCH STAFF OWN SHOP' });
  assert.strictEqual(reg.status, 200);
  shopsToDelete.push(reg.body.memberships[0].shop_id);
  await query(`INSERT INTO memberships(user_id, shop_id, role, permissions) VALUES ($1,$2,'staff',$3)`,
    [reg.body.user.id, shopId, JSON.stringify(perms || {})]);
  return { token: reg.body.accessToken, userId: reg.body.user.id };
}

const PP_BODY = () => ({
  display_name: 'พร้อมเพย์ทดสอบ', method: 'STATIC_QR', provider_type: 'PROMPTPAY_STATIC',
  account_ref: '0811111111', business_type: 'PERSONAL',
});

async function createChannel(owner, overrides) {
  const r = await req('POST', '/api/payments/channels', Object.assign(PP_BODY(), overrides || {}), owner.token, owner.shopId);
  assert.strictEqual(r.status, 201, 'create failed: ' + JSON.stringify(r.body));
  return r.body.channel;
}

let ownerA, ownerB;

test.before(async () => {
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  base = 'http://127.0.0.1:' + server.address().port;
  ownerA = await registerOwner('cha');
  ownerB = await registerOwner('chb');
});

test.after(async () => {
  for (const id of shopsToDelete) {
    await pool.query('delete from shops where id=$1', [id]);
  }
  await new Promise((r) => server.close(r));
  await pool.end();
});

// ─── CRUD happy path ─────────────────────────────────────────────────────────

test('PC1 create channel: 201, masked response, owner-shop assignment row auto-created (REV 3)', async () => {
  const ch = await createChannel(ownerA, { display_name: 'ช่องทางแรก' });
  assert.ok(ch.id);
  assert.strictEqual(ch.display_name, 'ช่องทางแรก');
  assert.strictEqual(ch.verification_mode, 'MANUAL', 'MANUAL family defaults/forces MANUAL');
  assert.strictEqual(ch.qr_version, 1);
  assert.strictEqual(ch.source, 'MANUAL_ADMIN');
  assert.strictEqual(ch.account_ref_masked, 'xxx-xxx-1111');
  assert.ok(!('account_ref' in ch), 'account_ref must NEVER be serialized');
  // The assignment row IS the access — created in the same transaction, default for a fresh shop.
  const asg = (await query('SELECT * FROM payment_channel_shops WHERE channel_id=$1', [ch.id])).rows;
  assert.strictEqual(asg.length, 1);
  assert.strictEqual(asg[0].shop_id, ownerA.shopId);
  assert.strictEqual(asg[0].is_default, true, 'first channel of the shop becomes default');
  assert.strictEqual(ch.is_default, true);
});

test('PC2 GET list: assignment-rule visibility, masked only, never account_ref', async () => {
  const r = await req('GET', '/api/payments/channels', null, ownerA.token, ownerA.shopId);
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.ok(Array.isArray(r.body.channels) && r.body.channels.length >= 1);
  for (const c of r.body.channels) {
    assert.ok(!('account_ref' in c), 'account_ref leaked in GET');
    assert.ok(!JSON.stringify(c).includes('0811111111'), 'full ref value leaked somewhere in the payload');
    if (c.account_ref_masked) assert.match(c.account_ref_masked, /^xxx-xxx-.{4}$/);
    assert.ok('is_default' in c && 'sort_order' in c, 'per-shop assignment fields present');
  }
});

test('PC3 update: qr_version bumps on account_ref change but NOT on display_name change', async () => {
  const ch = await createChannel(ownerA, { display_name: 'จะถูกแก้ชื่อ' });
  const r1 = await req('PUT', '/api/payments/channels/' + ch.id, { display_name: 'ชื่อใหม่' }, ownerA.token, ownerA.shopId);
  assert.strictEqual(r1.status, 200, JSON.stringify(r1.body));
  assert.strictEqual(r1.body.channel.qr_version, 1, 'name-only edit must not bump qr_version');
  assert.strictEqual(r1.body.channel.display_name, 'ชื่อใหม่');
  const r2 = await req('PUT', '/api/payments/channels/' + ch.id, { account_ref: '0822222222' }, ownerA.token, ownerA.shopId);
  assert.strictEqual(r2.status, 200, JSON.stringify(r2.body));
  assert.strictEqual(r2.body.channel.qr_version, 2, 'account_ref change must bump qr_version');
  assert.strictEqual(r2.body.channel.account_ref_masked, 'xxx-xxx-2222');
  const r3 = await req('PUT', '/api/payments/channels/' + ch.id, { qr_image_ref: 'uploads/qr-demo.png' }, ownerA.token, ownerA.shopId);
  assert.strictEqual(r3.body.channel.qr_version, 3, 'qr_image_ref change must bump qr_version');
});

test('PC4 deactivate/activate: soft only, inactive excluded from GET, no DELETE route exists', async () => {
  const ch = await createChannel(ownerA, { display_name: 'จะถูกปิด' });
  const d = await req('POST', '/api/payments/channels/' + ch.id + '/deactivate', {}, ownerA.token, ownerA.shopId);
  assert.strictEqual(d.status, 200);
  assert.strictEqual(d.body.channel.is_active, false);
  const list = await req('GET', '/api/payments/channels', null, ownerA.token, ownerA.shopId);
  assert.ok(!list.body.channels.some((c) => c.id === ch.id), 'inactive channel must not appear');
  // row still exists (soft) and no hard-delete endpoint is mounted
  const row = (await query('SELECT id FROM payment_channels WHERE id=$1', [ch.id])).rows;
  assert.strictEqual(row.length, 1);
  const del = await req('DELETE', '/api/payments/channels/' + ch.id, null, ownerA.token, ownerA.shopId);
  assert.strictEqual(del.status, 404, 'there must be no DELETE /channels/:id endpoint');
  const a = await req('POST', '/api/payments/channels/' + ch.id + '/activate', {}, ownerA.token, ownerA.shopId);
  assert.strictEqual(a.body.channel.is_active, true);
});

test('PC5 effective window: expired (until yesterday) and not-yet (from tomorrow) excluded from GET', async () => {
  const day = (offset) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
  const expired = await createChannel(ownerA, { display_name: 'หมดอายุแล้ว', effective_until: day(-1) });
  const future = await createChannel(ownerA, { display_name: 'ยังไม่เริ่ม', effective_from: day(1) });
  const current = await createChannel(ownerA, { display_name: 'อยู่ในช่วง', effective_from: day(-1), effective_until: day(1) });
  const list = await req('GET', '/api/payments/channels', null, ownerA.token, ownerA.shopId);
  const ids = list.body.channels.map((c) => c.id);
  assert.ok(!ids.includes(expired.id), 'expired channel visible');
  assert.ok(!ids.includes(future.id), 'not-yet-effective channel visible');
  assert.ok(ids.includes(current.id), 'in-window channel missing');
});

// ─── validation ──────────────────────────────────────────────────────────────

test('PC6 business_type required on create -> 400 (REV 2)', async () => {
  const body = PP_BODY(); delete body.business_type;
  const r = await req('POST', '/api/payments/channels', body, ownerA.token, ownerA.shopId);
  assert.strictEqual(r.status, 400, JSON.stringify(r.body));
  assert.strictEqual(r.body.code, 'BUSINESS_TYPE_REQUIRED');
});

test('PC7 combo validation: bad promptpay ref, DYNAMIC_QR without mock, manual family + PROVIDER_VERIFIED', async () => {
  const bad1 = await req('POST', '/api/payments/channels', Object.assign(PP_BODY(), { account_ref: '12345' }), ownerA.token, ownerA.shopId);
  assert.strictEqual(bad1.status, 400);
  assert.strictEqual(bad1.body.code, 'INVALID_PROMPTPAY_REF');
  const bad2 = await req('POST', '/api/payments/channels', {
    display_name: 'dyn', method: 'DYNAMIC_QR', provider_type: 'MANUAL', business_type: 'COMPANY',
  }, ownerA.token, ownerA.shopId);
  assert.strictEqual(bad2.status, 400);
  assert.strictEqual(bad2.body.code, 'DYNAMIC_QR_REQUIRES_MOCK_PROVIDER');
  const bad3 = await req('POST', '/api/payments/channels', Object.assign(PP_BODY(), { verification_mode: 'PROVIDER_VERIFIED' }), ownerA.token, ownerA.shopId);
  assert.strictEqual(bad3.status, 400);
  assert.strictEqual(bad3.body.code, 'VERIFICATION_MODE_MUST_BE_MANUAL');
  // mock dynamic-QR is the one allowed PROVIDER_VERIFIED combination in PC-1
  const ok = await req('POST', '/api/payments/channels', {
    display_name: 'Dynamic QR (mock)', method: 'DYNAMIC_QR', provider_type: 'MOCK_PROVIDER',
    verification_mode: 'PROVIDER_VERIFIED', business_type: 'COMPANY',
  }, ownerA.token, ownerA.shopId);
  assert.strictEqual(ok.status, 201, JSON.stringify(ok.body));
});

// ─── permissions (owner-only manage) ─────────────────────────────────────────

test('PC8 staff & manager preset -> 403 on ALL manage endpoints; read stays available', async () => {
  const staff = await registerStaff(ownerA.shopId, {});                 // bare staff
  const manager = await registerStaff(ownerA.shopId, PRESETS.manager);  // manager preset (payment_channel_manage excluded)
  const ch = await createChannel(ownerA, { display_name: 'สำหรับทดสอบสิทธิ์' });
  const attempts = [
    ['POST', '/api/payments/channels', PP_BODY()],
    ['PUT', '/api/payments/channels/' + ch.id, { display_name: 'x' }],
    ['POST', '/api/payments/channels/' + ch.id + '/deactivate', {}],
    ['POST', '/api/payments/channels/' + ch.id + '/activate', {}],
    ['POST', '/api/payments/channels/' + ch.id + '/shops', { shop_id: ownerA.shopId }],
    ['DELETE', '/api/payments/channels/' + ch.id + '/shops/' + ownerA.shopId, null],
  ];
  for (const who of [staff, manager]) {
    for (const [m, p, b] of attempts) {
      const r = await req(m, p, b, who.token, ownerA.shopId);
      assert.strictEqual(r.status, 403, m + ' ' + p + ' should 403: ' + JSON.stringify(r.body));
      assert.strictEqual(r.body.code, 'PERMISSION_DENIED');
    }
  }
  // read: staff sells (bill_confirm default) so the masked list is visible — masked only.
  const read = await req('GET', '/api/payments/channels', null, staff.token, ownerA.shopId);
  assert.strictEqual(read.status, 200);
  for (const c of read.body.channels) assert.ok(!('account_ref' in c));
  // owner succeeds on a mutation (control)
  const ok = await req('PUT', '/api/payments/channels/' + ch.id, { display_name: 'owner ok' }, ownerA.token, ownerA.shopId);
  assert.strictEqual(ok.status, 200);
});

// ─── branch availability = assignment row ONLY (REV 3) ───────────────────────

test('PC9 availability: second shop blind until assigned; unassign removes access immediately', async () => {
  const ch = await createChannel(ownerA, { display_name: 'แชร์ข้ามสาขา' });
  // shop B sees nothing of shop A's channel
  const before = await req('GET', '/api/payments/channels', null, ownerB.token, ownerB.shopId);
  assert.ok(!before.body.channels.some((c) => c.id === ch.id), 'shop B must not see the channel before assignment');

  // cross-tenant guard: ownerA does NOT hold the owner role in shop B -> 403
  const denied = await req('POST', '/api/payments/channels/' + ch.id + '/shops', { shop_id: ownerB.shopId }, ownerA.token, ownerA.shopId);
  assert.strictEqual(denied.status, 403, JSON.stringify(denied.body));
  assert.strictEqual(denied.body.code, 'NOT_OWNER_OF_TARGET_SHOP');

  // make ownerA an owner of shop B (multi-branch owner) -> assignment now allowed
  await query(`INSERT INTO memberships(user_id, shop_id, role) VALUES ($1,$2,'owner')`, [ownerA.userId, ownerB.shopId]);
  const asg = await req('POST', '/api/payments/channels/' + ch.id + '/shops', { shop_id: ownerB.shopId, sort_order: 5 }, ownerA.token, ownerA.shopId);
  assert.strictEqual(asg.status, 201, JSON.stringify(asg.body));
  assert.strictEqual(asg.body.assignment.shop_id, ownerB.shopId);

  const after = await req('GET', '/api/payments/channels', null, ownerB.token, ownerB.shopId);
  const seen = after.body.channels.find((c) => c.id === ch.id);
  assert.ok(seen, 'shop B must see the channel once assigned');
  assert.strictEqual(seen.sort_order, 5);
  assert.ok(!('account_ref' in seen));

  // remove the assignment -> disappears immediately (owner shop removal also allowed by design)
  const un = await req('DELETE', '/api/payments/channels/' + ch.id + '/shops/' + ownerB.shopId, null, ownerA.token, ownerA.shopId);
  assert.strictEqual(un.status, 200);
  const gone = await req('GET', '/api/payments/channels', null, ownerB.token, ownerB.shopId);
  assert.ok(!gone.body.channels.some((c) => c.id === ch.id), 'unassigned channel must vanish immediately');
});

// ─── per-shop default uniqueness (REV 3 §16) ─────────────────────────────────

test('PC10 default: setting a second default atomically clears the old; raw SQL double-default rejected by DB', async () => {
  const owner = await registerOwner('chdef');
  const ch1 = await createChannel(owner, { display_name: 'ตัวแรก' });
  const ch2 = await createChannel(owner, { display_name: 'ตัวสอง' });
  assert.strictEqual(ch1.is_default, true);
  assert.strictEqual(ch2.is_default, false, 'second channel must not steal default');

  const setDef = await req('POST', '/api/payments/channels/' + ch2.id + '/shops',
    { shop_id: owner.shopId, is_default: true }, owner.token, owner.shopId);
  assert.strictEqual(setDef.status, 201, JSON.stringify(setDef.body));
  const rows = (await query(
    'SELECT channel_id, is_default FROM payment_channel_shops WHERE shop_id=$1 ORDER BY is_default DESC', [owner.shopId])).rows;
  assert.strictEqual(rows.filter((r) => r.is_default).length, 1, 'exactly one default per shop');
  assert.strictEqual(rows[0].channel_id, ch2.id, 'new default is ch2');

  // the DB itself rejects a second default (partial unique index), independent of the API
  await assert.rejects(
    () => query('UPDATE payment_channel_shops SET is_default=TRUE WHERE channel_id=$1 AND shop_id=$2', [ch1.id, owner.shopId]),
    (e) => e.code === '23505',
    'partial unique index uq_payment_channel_shop_default must reject a second default'
  );
});

// ─── audit ───────────────────────────────────────────────────────────────────

test('PC11 audit rows written to logs for create/update/assign/unassign/deactivate — masked refs only', async () => {
  const owner = await registerOwner('chaud');
  const ch = await createChannel(owner, { display_name: 'ตรวจ audit', account_ref: '0855555555' });
  await req('PUT', '/api/payments/channels/' + ch.id, { account_ref: '0866666666' }, owner.token, owner.shopId);
  await req('POST', '/api/payments/channels/' + ch.id + '/shops', { shop_id: owner.shopId, sort_order: 3 }, owner.token, owner.shopId);
  await req('DELETE', '/api/payments/channels/' + ch.id + '/shops/' + owner.shopId, null, owner.token, owner.shopId);
  await req('POST', '/api/payments/channels/' + ch.id + '/deactivate', {}, owner.token, owner.shopId);
  const rows = (await query(
    "SELECT action, user_id, detail FROM logs WHERE shop_id=$1 AND action LIKE 'payment_channel.%' ORDER BY created_at", [owner.shopId])).rows;
  const actions = rows.map((r) => r.action);
  for (const a of ['payment_channel.create', 'payment_channel.update', 'payment_channel.assign_shop', 'payment_channel.unassign_shop', 'payment_channel.deactivate']) {
    assert.ok(actions.includes(a), 'missing audit action ' + a + ' (got: ' + actions.join(',') + ')');
  }
  for (const r of rows) {
    assert.strictEqual(r.user_id, owner.userId, 'actor recorded on ' + r.action);
    const detail = JSON.stringify(r.detail);
    assert.ok(!detail.includes('0855555555') && !detail.includes('0866666666'), 'FULL account_ref leaked into audit log: ' + r.action);
  }
  const upd = rows.find((r) => r.action === 'payment_channel.update');
  assert.ok(upd.detail.old && upd.detail.new, 'update audit carries old/new snapshots');
  assert.strictEqual(upd.detail.old.account_ref_masked, 'xxx-xxx-5555');
  assert.strictEqual(upd.detail.new.account_ref_masked, 'xxx-xxx-6666');
});

// ─── legacy bridge migration (design §8) ─────────────────────────────────────
// These tests re-execute the REAL shipped migration SQL, sliced at the legacy-bridge marker:
// the full file's ALTER TABLE ... ADD COLUMN IF NOT EXISTS statements take AccessExclusiveLock
// on payment_intents/transactions even when they are no-ops, which deadlocks against the other
// payment test files node --test runs concurrently. The bridge INSERTs are the part whose
// idempotence is under test here; full-file run-twice idempotence is proven by running
// `node backend/src/migrate.js` twice (serialized, as Railway does at boot).
function bridgeSql() {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema-payment-channels.sql'), 'utf8');
  const at = sql.indexOf('Legacy bridge');
  assert.ok(at > 0, 'legacy bridge marker missing from schema-payment-channels.sql');
  return sql.slice(sql.lastIndexOf('\n-- ', at));
}

test('PC12 legacy bridge: shop with settings.promptpay gets exactly ONE LEGACY_SETTINGS channel — run twice = still one', async () => {
  const owner = await registerOwner('chleg');
  await query('UPDATE shop_settings SET promptpay=$1 WHERE shop_id=$2', ['0899999999', owner.shopId]);
  const sql = bridgeSql();
  await pool.query(sql);   // run 1
  await pool.query(sql);   // run 2 — must be idempotent
  const chans = (await query(
    "SELECT * FROM payment_channels WHERE shop_id=$1 AND source='LEGACY_SETTINGS'", [owner.shopId])).rows;
  assert.strictEqual(chans.length, 1, 'exactly one LEGACY_SETTINGS channel after two runs');
  const c = chans[0];
  assert.strictEqual(c.display_name, 'QR พร้อมเพย์ร้าน');
  assert.strictEqual(c.method, 'STATIC_QR');
  assert.strictEqual(c.provider_type, 'PROMPTPAY_STATIC');
  assert.strictEqual(c.verification_mode, 'MANUAL');
  assert.strictEqual(c.account_ref, '0899999999');
  assert.strictEqual(c.business_type, 'PERSONAL');
  const asg = (await query('SELECT * FROM payment_channel_shops WHERE channel_id=$1', [c.id])).rows;
  assert.strictEqual(asg.length, 1, 'bridge creates exactly one owner-shop assignment row');
  assert.strictEqual(asg[0].shop_id, owner.shopId);
  assert.strictEqual(asg[0].is_default, true, 'fresh shop: bridged channel becomes default');
  // and the bridged channel is served (masked) through the normal availability rule
  const list = await req('GET', '/api/payments/channels', null, owner.token, owner.shopId);
  const seen = list.body.channels.find((x) => x.id === c.id);
  assert.ok(seen, 'bridged channel visible to its shop');
  assert.strictEqual(seen.account_ref_masked, 'xxx-xxx-9999');
  assert.ok(!('account_ref' in seen));
});

test('PC13 legacy bridge respects an existing default (partial unique index survives)', async () => {
  const owner = await registerOwner('chleg2');
  const manual = await createChannel(owner, { display_name: 'มาก่อน bridge' });   // becomes the default
  assert.strictEqual(manual.is_default, true);
  await query('UPDATE shop_settings SET promptpay=$1 WHERE shop_id=$2', ['0877777777', owner.shopId]);
  await pool.query(bridgeSql());
  const defs = (await query(
    'SELECT channel_id FROM payment_channel_shops WHERE shop_id=$1 AND is_default=TRUE', [owner.shopId])).rows;
  assert.strictEqual(defs.length, 1, 'still exactly one default');
  assert.strictEqual(defs[0].channel_id, manual.id, 'pre-existing default untouched by the bridge');
  const bridged = (await query(
    "SELECT id FROM payment_channels WHERE shop_id=$1 AND source='LEGACY_SETTINGS'", [owner.shopId])).rows;
  assert.strictEqual(bridged.length, 1, 'bridge still created the channel (non-default)');
});

// ─── flag gate ───────────────────────────────────────────────────────────────

test('PC14 flag OFF -> every channel endpoint 503 PAYMENT_PLATFORM_DISABLED', async () => {
  const ch = await createChannel(ownerA, { display_name: 'ก่อนปิด flag' });
  process.env.PAYMENT_PLATFORM_ENABLED = '0';
  try {
    const paths = [
      ['GET', '/api/payments/channels', null],
      ['POST', '/api/payments/channels', PP_BODY()],
      ['PUT', '/api/payments/channels/' + ch.id, { display_name: 'x' }],
      ['POST', '/api/payments/channels/' + ch.id + '/deactivate', {}],
      ['POST', '/api/payments/channels/' + ch.id + '/shops', { shop_id: ownerA.shopId }],
      ['DELETE', '/api/payments/channels/' + ch.id + '/shops/' + ownerA.shopId, null],
    ];
    for (const [m, p, b] of paths) {
      const r = await req(m, p, b, ownerA.token, ownerA.shopId);
      assert.strictEqual(r.status, 503, m + ' ' + p + ': ' + JSON.stringify(r.body));
      assert.strictEqual(r.body.error, 'PAYMENT_PLATFORM_DISABLED');
    }
  } finally {
    process.env.PAYMENT_PLATFORM_ENABLED = '1';
  }
});

// ─── cross-tenant channel scoping ────────────────────────────────────────────

test('PC15 shop B cannot mutate shop A\'s channel (404, tenant scope — never confirms existence)', async () => {
  const ch = await createChannel(ownerA, { display_name: 'ของร้าน A' });
  const r1 = await req('PUT', '/api/payments/channels/' + ch.id, { display_name: 'hijack' }, ownerB.token, ownerB.shopId);
  assert.strictEqual(r1.status, 404, JSON.stringify(r1.body));
  const r2 = await req('POST', '/api/payments/channels/' + ch.id + '/deactivate', {}, ownerB.token, ownerB.shopId);
  assert.strictEqual(r2.status, 404);
  const r3 = await req('POST', '/api/payments/channels/' + ch.id + '/shops', { shop_id: ownerB.shopId }, ownerB.token, ownerB.shopId);
  assert.strictEqual(r3.status, 404, 'owner of B owns B but channel is scoped to A -> 404');
});

// ─── PC16–PC23: review-gate additions (F1 regression + N1–N3 + coverage gaps) ────────────────

test('PC16 F1 regression: bridge never resurrects an owner-removed assignment (reboot-safe)', async () => {
  const owner = await registerOwner('chf1');
  await query('UPDATE shop_settings SET promptpay=$1 WHERE shop_id=$2', ['0877777777', owner.shopId]);
  const sql = bridgeSql();
  await pool.query(sql);
  const ch = (await query(
    "SELECT * FROM payment_channels WHERE shop_id=$1 AND source='LEGACY_SETTINGS'", [owner.shopId])).rows[0];
  assert.ok(ch, 'bridge created the channel');
  let asg = (await query('SELECT * FROM payment_channel_shops WHERE channel_id=$1', [ch.id])).rows;
  assert.strictEqual(asg.length, 1, 'exactly one assignment after first bridge run');

  // Owner intentionally removes the owner-shop assignment (design §19 — supported + audited).
  const del = await req('DELETE', '/api/payments/channels/' + ch.id + '/shops/' + owner.shopId, null, owner.token, owner.shopId);
  assert.strictEqual(del.status, 200, JSON.stringify(del.body));
  asg = (await query('SELECT * FROM payment_channel_shops WHERE channel_id=$1', [ch.id])).rows;
  assert.strictEqual(asg.length, 0, 'assignment removed');
  const auditBefore = (await query(
    "SELECT count(*)::int c FROM logs WHERE shop_id=$1 AND action LIKE 'payment_channel.%'", [owner.shopId])).rows[0].c;
  assert.ok(auditBefore >= 1, 'unassign was audited');

  // "Reboot": rerun the full bridge twice. The deleted assignment must STAY deleted.
  await pool.query(sql);
  await pool.query(sql);
  asg = (await query('SELECT * FROM payment_channel_shops WHERE channel_id=$1', [ch.id])).rows;
  assert.strictEqual(asg.length, 0, 'F1: rerun must NOT resurrect the removed assignment');
  const defaults = (await query(
    'SELECT count(*)::int c FROM payment_channel_shops WHERE shop_id=$1 AND is_default=TRUE', [owner.shopId])).rows[0].c;
  assert.strictEqual(defaults, 0, 'F1: rerun must NOT recreate a default');
  const chans = (await query(
    "SELECT count(*)::int c FROM payment_channels WHERE shop_id=$1 AND source='LEGACY_SETTINGS'", [owner.shopId])).rows[0].c;
  assert.strictEqual(chans, 1, 'channel row itself remains (historical integrity)');
  const auditAfter = (await query(
    "SELECT count(*)::int c FROM logs WHERE shop_id=$1 AND action LIKE 'payment_channel.%'", [owner.shopId])).rows[0].c;
  assert.strictEqual(auditAfter, auditBefore, 'bridge rerun writes no audit rows and removes none');
});

test('PC17 default is per-branch: default at shop A does not imply default at shop B', async () => {
  const owner = await registerOwner('chd2');
  const other = await registerOwner('chd2b');
  // Make the actor owner of BOTH shops so cross-assign is legal.
  await query(`INSERT INTO memberships(user_id, shop_id, role) VALUES ($1,$2,'owner') ON CONFLICT DO NOTHING`,
    [owner.userId, other.shopId]);
  const ch = await createChannel(owner, { display_name: 'ครัวกลาง' });   // default at owner shop
  const add = await req('POST', '/api/payments/channels/' + ch.id + '/shops',
    { shop_id: other.shopId, is_default: false }, owner.token, owner.shopId);
  assert.strictEqual(add.status, 201, JSON.stringify(add.body));
  const rows = (await query('SELECT shop_id, is_default FROM payment_channel_shops WHERE channel_id=$1', [ch.id])).rows;
  assert.strictEqual(rows.length, 2);
  const atA = rows.find((r) => r.shop_id === owner.shopId);
  const atB = rows.find((r) => r.shop_id === other.shopId);
  assert.strictEqual(atA.is_default, true, 'default at A');
  assert.strictEqual(atB.is_default, false, 'same channel NOT default at B');
});

test('PC18 qr_version: bumps exactly once per sensitive change, never for same value or name-only', async () => {
  const owner = await registerOwner('chqr');
  const ch = await createChannel(owner, { account_ref: '0833333333' });
  assert.strictEqual(ch.qr_version, 1);
  // Same account_ref value -> no bump.
  let r = await req('PUT', '/api/payments/channels/' + ch.id, { account_ref: '0833333333' }, owner.token, owner.shopId);
  assert.strictEqual(r.body.channel.qr_version, 1, 'unchanged value must not bump');
  // display_name only -> no bump.
  r = await req('PUT', '/api/payments/channels/' + ch.id, { display_name: 'เปลี่ยนชื่อ' }, owner.token, owner.shopId);
  assert.strictEqual(r.body.channel.qr_version, 1, 'name-only must not bump');
  // account_ref change -> exactly +1.
  r = await req('PUT', '/api/payments/channels/' + ch.id, { account_ref: '0844444444' }, owner.token, owner.shopId);
  assert.strictEqual(r.body.channel.qr_version, 2, 'ref change bumps exactly once');
  // qr_image_ref change -> exactly +1.
  r = await req('PUT', '/api/payments/channels/' + ch.id, { qr_image_ref: 'asset-demo-1' }, owner.token, owner.shopId);
  assert.strictEqual(r.body.channel.qr_version, 3, 'qr image change bumps exactly once');
});

test('PC19 N1 masking: refs of length 1-4 are never revealed; 5 keeps only last 4', async () => {
  const owner = await registerOwner('chmask');
  for (const ref of ['7', '99', '333', '4444']) {
    const r = await req('POST', '/api/payments/channels', {
      display_name: 'สั้น ' + ref.length, method: 'BANK_TRANSFER', provider_type: 'MANUAL',
      verification_mode: 'MANUAL', business_type: 'COMPANY', account_ref: ref,
    }, owner.token, owner.shopId);
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    assert.strictEqual(r.body.channel.account_ref_masked, 'xxx-xxx-xxxx', 'len ' + ref.length + ' must be fully masked');
    assert.ok(!JSON.stringify(r.body).includes('"' + ref + '"'), 'short ref value must not appear in response');
  }
  const r5 = await req('POST', '/api/payments/channels', {
    display_name: 'ห้าตัว', method: 'BANK_TRANSFER', provider_type: 'MANUAL',
    verification_mode: 'MANUAL', business_type: 'COMPANY', account_ref: '56789',
  }, owner.token, owner.shopId);
  assert.strictEqual(r5.body.channel.account_ref_masked, 'xxx-xxx-6789');
  // Audit rows for the short-ref channels: fixed mask only.
  const logsRows = (await query(
    "SELECT detail FROM logs WHERE shop_id=$1 AND action='payment_channel.create'", [owner.shopId])).rows;
  for (const l of logsRows) {
    const d = JSON.stringify(l.detail);
    for (const ref of ['"7"', '"99"', '"333"', '"4444"']) assert.ok(!d.includes(ref), 'short ref leaked into audit');
  }
});

test('PC20 N2 effective window: inverted rejected on create AND update; equality (one-day) allowed', async () => {
  const owner = await registerOwner('chwin');
  const bad = await req('POST', '/api/payments/channels', Object.assign(PP_BODY(), {
    effective_from: '2026-08-10', effective_until: '2026-08-01',
  }), owner.token, owner.shopId);
  assert.strictEqual(bad.status, 400);
  assert.strictEqual(bad.body.code, 'INVALID_EFFECTIVE_WINDOW');
  const ok = await req('POST', '/api/payments/channels', Object.assign(PP_BODY(), {
    effective_from: '2026-08-01', effective_until: '2026-08-01',
  }), owner.token, owner.shopId);
  assert.strictEqual(ok.status, 201, 'from = until = valid for exactly one day (documented policy)');
  const upd = await req('PUT', '/api/payments/channels/' + ok.body.channel.id,
    { effective_until: '2026-07-01' }, owner.token, owner.shopId);
  assert.strictEqual(upd.status, 400, 'update path must validate the MERGED window');
  assert.strictEqual(upd.body.code, 'INVALID_EFFECTIVE_WINDOW');
});

test('PC21 N3 whitespace legacy promptpay: no junk channel, no assignment', async () => {
  const owner = await registerOwner('chws');
  await query('UPDATE shop_settings SET promptpay=$1 WHERE shop_id=$2', ['   ', owner.shopId]);
  const sql = bridgeSql();
  await pool.query(sql);
  const chans = (await query(
    "SELECT count(*)::int c FROM payment_channels WHERE shop_id=$1 AND source='LEGACY_SETTINGS'", [owner.shopId])).rows[0].c;
  assert.strictEqual(chans, 0, 'whitespace-only legacy value must not create a channel');
});

test('PC22 concurrent set-default: DB always ends with exactly one default, no sensitive leak', async () => {
  const owner = await registerOwner('chrace');
  const chans = [];
  for (let i = 0; i < 3; i++) chans.push(await createChannel(owner, { display_name: 'แข่ง ' + i, account_ref: '081111111' + i }));
  const attempts = [];
  for (let round = 0; round < 4; round++) {
    for (const ch of chans) {
      attempts.push(req('POST', '/api/payments/channels/' + ch.id + '/shops',
        { shop_id: owner.shopId, is_default: true }, owner.token, owner.shopId));
    }
  }
  const results = await Promise.all(attempts);
  for (const r of results) {
    const s = JSON.stringify(r.body || {});
    for (const ref of ['0811111110', '0811111111', '0811111112']) {
      assert.ok(!s.includes('"' + ref + '"'), 'full ref leaked through concurrent-error path');
    }
  }
  const defaults = (await query(
    'SELECT count(*)::int c FROM payment_channel_shops WHERE shop_id=$1 AND is_default=TRUE', [owner.shopId])).rows[0].c;
  assert.strictEqual(defaults, 1, 'concurrency must never end with 0 or 2+ defaults');
});

test('PC23 error responses never echo the submitted account_ref', async () => {
  const owner = await registerOwner('cherr');
  const bad = await req('POST', '/api/payments/channels', Object.assign(PP_BODY(), {
    account_ref: '12345678901234567890',
  }), owner.token, owner.shopId);
  assert.strictEqual(bad.status, 400);
  assert.ok(!JSON.stringify(bad.body).includes('12345678901234567890'), 'validation error echoed the ref');
});

test('PC24 M1 regression: response dates are plain YYYY-MM-DD; UI round-trip never shifts the stored day', async () => {
  const owner = await registerOwner('chtz');
  const created = await req('POST', '/api/payments/channels', Object.assign(PP_BODY(), {
    effective_from: '2026-08-01', effective_until: '2026-12-31',
  }), owner.token, owner.shopId);
  assert.strictEqual(created.status, 201);
  // Response must carry the exact civil date — never a UTC-shifted ISO timestamp.
  assert.strictEqual(created.body.channel.effective_from, '2026-08-01', 'create response date must be plain YYYY-MM-DD');
  assert.strictEqual(created.body.channel.effective_until, '2026-12-31');
  const id = created.body.channel.id;

  const listed = await req('GET', '/api/payments/channels?include_inactive=1', null, owner.token, owner.shopId);
  const row = listed.body.channels.find((c) => c.id === id);
  assert.strictEqual(row.effective_from, '2026-08-01', 'list response date must be plain YYYY-MM-DD');

  // UI round-trip: the edit form prefills from the response and sends the values back verbatim.
  const roundTrip = await req('PUT', '/api/payments/channels/' + id, {
    display_name: 'แก้ชื่อเฉย ๆ',
    effective_from: row.effective_from,
    effective_until: row.effective_until,
  }, owner.token, owner.shopId);
  assert.strictEqual(roundTrip.status, 200, JSON.stringify(roundTrip.body));
  assert.strictEqual(roundTrip.body.channel.effective_from, '2026-08-01');

  // The stored civil date must be EXACTLY what was created — no drift after the round-trip.
  const db = (await query(
    "SELECT to_char(effective_from,'YYYY-MM-DD') f, to_char(effective_until,'YYYY-MM-DD') u FROM payment_channels WHERE id=$1", [id])).rows[0];
  assert.strictEqual(db.f, '2026-08-01', 'M1: stored date must not shift after a UI round-trip');
  assert.strictEqual(db.u, '2026-12-31');

  // Audit snapshots carry plain dates too (they feed the same masked snapshot shape).
  const lastAudit = (await query(
    "SELECT detail FROM logs WHERE shop_id=$1 AND action='payment_channel.update' ORDER BY id DESC LIMIT 1", [owner.shopId])).rows[0];
  const d = JSON.stringify(lastAudit.detail);
  assert.ok(!/T\d\d:\d\d:\d\d/.test(d), 'audit snapshot must not contain UTC-shifted ISO timestamps for dates');
});
