// Payment Platform — guard tests: flag OFF by default (503), menu display provably unchanged,
// and the no-external-network guard (static source scan + runtime fetch/http/https monkeypatch).
// Runs in its own process (node --test isolates files), so PAYMENT_PLATFORM_ENABLED stays at its
// real-world default (unset) except where a single test flips it at request time.
require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');

const DB = process.env.DATABASE_URL || '';
if (!/@(localhost|127\.0\.0\.1)[:/]/.test(DB)) {
  throw new Error('refusing to run: DATABASE_URL is not local');
}
delete process.env.PAYMENT_PLATFORM_ENABLED;   // the production default: OFF

const { pool, query, tx } = require('../src/db');
const app = require('../src/app');

let server, base, owner = null;
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

test.before(async () => {
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  base = 'http://127.0.0.1:' + server.address().port;
  const email = 'payguard_' + Date.now() + '@local.test';
  const reg = await req('POST', '/auth/register', { email, password: 'PayPlat#2026test', shopName: 'PAYMENT GUARD TEST' });
  assert.strictEqual(reg.status, 200, JSON.stringify(reg.body));
  owner = { token: reg.body.accessToken, shopId: reg.body.memberships[0].shop_id, userId: reg.body.user.id };
  shopsToDelete.push(owner.shopId);
});

test.after(async () => {
  for (const id of shopsToDelete) await pool.query('delete from shops where id=$1', [id]);
  await new Promise((r) => server.close(r));
  await pool.end();
});

// ─── flag OFF (default): every /api/payments route 503s ──────────────────────

test('G1 flag OFF by default: all /api/payments/* return 503 PAYMENT_PLATFORM_DISABLED', async () => {
  assert.notStrictEqual(process.env.PAYMENT_PLATFORM_ENABLED, '1');
  const g = await req('GET', '/api/payments/dashboard', null, owner.token, owner.shopId);
  assert.strictEqual(g.status, 503, JSON.stringify(g.body));
  assert.strictEqual(g.body.error, 'PAYMENT_PLATFORM_DISABLED');
  const p = await req('POST', '/api/payments/bills', { amount_due: 10 }, owner.token, owner.shopId);
  assert.strictEqual(p.status, 503);
  const w = await req('POST', '/api/payments/webhooks/mock', { raw_body: 'x', signature: 'y' }, owner.token, owner.shopId);
  assert.strictEqual(w.status, 503, 'even the webhook path is dark while OFF');
});

// ─── menu display provably unchanged with the flag off ───────────────────────

test('G2 public menu payload is byte-identical whether the payment flag is off or on', async () => {
  // Give the throwaway shop a public menu with one item.
  const token = 'payguard' + Date.now().toString(36);
  await query(`UPDATE shop_settings SET public_menu_token=$1, public_menu_enabled=true WHERE shop_id=$2`, [token, owner.shopId]);
  await query(
    `INSERT INTO recipes (id, shop_id, name, sell_price, yield_unit, batch_yield, updated_at)
     VALUES (gen_random_uuid(), $1, 'Guard Latte', 65, 'cup', 1, now())`, [owner.shopId]);

  const off = await req('GET', '/public/menu/' + token);
  assert.strictEqual(off.status, 200, JSON.stringify(off.body));
  assert.ok(off.body.items.some((it) => it.name === 'Guard Latte'), 'menu serves the item with flag off');

  process.env.PAYMENT_PLATFORM_ENABLED = '1';
  try {
    const on = await req('GET', '/public/menu/' + token);
    assert.strictEqual(on.status, 200);
    assert.deepStrictEqual(on.body, off.body, 'flag flip must not change the menu payload at all');
  } finally {
    delete process.env.PAYMENT_PLATFORM_ENABLED;
  }
});

test('G3 bootstrap payload unchanged by the flag (menu management surface untouched)', async () => {
  const off = await req('GET', '/api/bootstrap', null, owner.token, owner.shopId);
  assert.strictEqual(off.status, 200);
  process.env.PAYMENT_PLATFORM_ENABLED = '1';
  try {
    const on = await req('GET', '/api/bootstrap', null, owner.token, owner.shopId);
    assert.strictEqual(on.status, 200);
    // data_version can advance only via writes; none happened — payloads must match apart from
    // the wall-clock `server_now` field, which differs between any two requests by definition.
    const strip = (o) => { const c = JSON.parse(JSON.stringify(o)); delete c.server_now; return c; };
    assert.deepStrictEqual(strip(on.body), strip(off.body));
  } finally {
    delete process.env.PAYMENT_PLATFORM_ENABLED;
  }
});

// ─── no-external-network guard ───────────────────────────────────────────────

const PAYMENT_SOURCES = [
  ...fs.readdirSync(path.join(__dirname, '../src/payments')).map((f) => path.join(__dirname, '../src/payments', f)),
  path.join(__dirname, '../src/api/payments.js'),
];

test('G4 source scan: payment platform code references no network module and no external URL', () => {
  const NETWORK_REQUIRES = /require\(\s*['"](node:)?(https?|net|tls|dgram|dns)['"]\s*\)/;
  const THIRD_PARTY_HTTP = /require\(\s*['"](axios|node-fetch|undici|got|request|superagent)['"]\s*\)/;
  const FETCH_CALL = /\bfetch\s*\(/;
  const EXTERNAL_URL = /https?:\/\/(?!127\.0\.0\.1|localhost)/;
  for (const file of PAYMENT_SOURCES) {
    const src = fs.readFileSync(file, 'utf8');
    const rel = path.relative(path.join(__dirname, '..'), file);
    assert.ok(!NETWORK_REQUIRES.test(src), rel + ' must not require a network module');
    assert.ok(!THIRD_PARTY_HTTP.test(src), rel + ' must not require an HTTP client package');
    assert.ok(!FETCH_CALL.test(src), rel + ' must not call fetch');
    assert.ok(!EXTERNAL_URL.test(src), rel + ' must not reference an external URL');
  }
});

test('G5 runtime guard: full mock payment flow succeeds with fetch/http/https disabled', async () => {
  process.env.PAYMENT_PLATFORM_ENABLED = '1';
  const svc = require('../src/payments/service');
  const origFetch = global.fetch;
  const origHttpReq = http.request;
  const origHttpsReq = https.request;
  const origHttpGet = http.get;
  const origHttpsGet = https.get;
  const boom = () => { throw new Error('NETWORK_CALL_ATTEMPTED — payment platform must be network-free'); };
  global.fetch = boom;
  http.request = boom; http.get = boom;
  https.request = boom; https.get = boom;
  try {
    // Drive the ENTIRE flow (bill -> confirm -> dynamic intent -> adapter -> signed webhook ->
    // txn + allocation + receipt) directly at the service layer while every Node network
    // primitive throws. pg uses raw TCP sockets (net inside the pg driver, untouched here);
    // any http(s)/fetch attempt by payment code would explode this test.
    const out = await tx((c) => svc.runOnlineOrderMockFlow(c, {
      shopId: owner.shopId, userId: owner.userId, userName: 'guard', amountDue: 99,
    }));
    assert.strictEqual(out.webhook_outcome, 'CONFIRMED');
    assert.strictEqual(out.kitchen_release_eligible, true);
  } finally {
    global.fetch = origFetch;
    http.request = origHttpReq; http.get = origHttpGet;
    https.request = origHttpsReq; https.get = origHttpsGet;
    delete process.env.PAYMENT_PLATFORM_ENABLED;
  }
});
