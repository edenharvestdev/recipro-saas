// P0 security fix: payment webhooks must fail CLOSED, never open.
//
// Before this fix, backend/src/webhooks/omise.js, backend/src/api/pay.js (omiseWebhook,
// mounted at /webhooks/omise-charge) and backend/src/webhooks/stripe.js all processed a
// webhook UNVERIFIED whenever the relevant *_WEBHOOK_SECRET env var was unset — a classic
// fail-open hole. This test drives the REAL app over HTTP against the REAL local Postgres
// (no stubs) and proves:
//   - missing secret in production mode -> rejected, no mutation
//   - incorrect / malformed signature -> rejected, no mutation
//   - valid signature -> processed
//   - repeated valid webhook -> idempotent (no duplicate mutation)
//   - dev-mode explicit bypass flag works, and is powerless in production
//
// NODE_ENV and the *_WEBHOOK_SECRET / ALLOW_UNVERIFIED_WEBHOOKS env vars are saved and
// restored around each assertion — this test never touches real environment config.
require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const crypto = require('node:crypto');
const Stripe = require('stripe');
const { pool } = require('../src/db');
const app = require('../src/app');

const DB = process.env.DATABASE_URL || '';
if (!/@(localhost|127\.0\.0\.1)[:/]/.test(DB)) {
  throw new Error('refusing to run: DATABASE_URL is not local');
}

let server, base, shopId;

// Low-level raw POST — webhooks read the raw Buffer body (express.raw), not JSON middleware.
const rawPost = (path, bodyStr, headers) => new Promise((resolve, reject) => {
  const data = Buffer.from(bodyStr, 'utf8');
  const r = http.request(base + path, {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json', 'Content-Length': data.length }, headers || {}),
  }, (res) => {
    let s = '';
    res.on('data', (d) => s += d);
    res.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (_) {} resolve({ status: res.statusCode, body: j, text: s }); });
  });
  r.on('error', reject);
  r.write(data);
  r.end();
});

const jreq = (method, path, body, tok) => new Promise((resolve, reject) => {
  const data = body != null ? JSON.stringify(body) : null;
  const r = http.request(base + path, {
    method,
    headers: Object.assign(
      { 'Content-Type': 'application/json' },
      data ? { 'Content-Length': Buffer.byteLength(data) } : {},
      tok ? { Authorization: 'Bearer ' + tok } : {}
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

// Save/restore a set of env vars around a callback so a test can never leak state.
async function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) saved[k] = process.env[k];
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

function omiseSign(secret, rawBodyStr) {
  return crypto.createHmac('sha256', secret).update(rawBodyStr).digest('hex');
}

test.before(async () => {
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  base = 'http://127.0.0.1:' + server.address().port;
  const email = 'webhook_' + Date.now() + '@local.test';
  const reg = await jreq('POST', '/auth/register', { email, password: 'Webhook#2026test', shopName: 'WEBHOOK FAILCLOSED TEST' });
  assert.strictEqual(reg.status, 200, 'register failed: ' + JSON.stringify(reg.body));
  shopId = reg.body.memberships[0].shop_id;
});

test.after(async () => {
  if (shopId) await pool.query('delete from shops where id=$1', [shopId]);
  await new Promise((r) => server.close(r));
  await pool.end();
});

// ---------------------------------------------------------------------------
// /webhooks/omise-charge (backend/src/api/pay.js -> omiseWebhook) — pay_charges table
// ---------------------------------------------------------------------------

test('omise-charge: missing secret in production -> 503, no mutation', async () => {
  const chargeId = 'chrg_test_' + Date.now();
  await pool.query(
    `insert into pay_charges (id, shop_id, amount, status, source_type, bill_no) values ($1,$2,10,'pending','promptpay','T1')`,
    [chargeId, shopId]);
  try {
    await withEnv({ NODE_ENV: 'production', OMISE_WEBHOOK_SECRET: undefined, ALLOW_UNVERIFIED_WEBHOOKS: undefined }, async () => {
      const body = JSON.stringify({ key: 'charge.complete', data: { id: chargeId, status: 'successful', paid: true } });
      const r = await rawPost('/webhooks/omise-charge', body, {});
      assert.strictEqual(r.status, 503, 'expected 503 config error, got ' + r.status + ' ' + r.text);
    });
    const row = (await pool.query('select status from pay_charges where id=$1', [chargeId])).rows[0];
    assert.strictEqual(row.status, 'pending', 'REGRESSION: charge was mutated despite missing webhook secret');
  } finally {
    await pool.query('delete from pay_charges where id=$1', [chargeId]);
  }
});

test('omise-charge: incorrect secret -> 401, no mutation', async () => {
  const chargeId = 'chrg_test_' + Date.now() + '_b';
  await pool.query(
    `insert into pay_charges (id, shop_id, amount, status, source_type, bill_no) values ($1,$2,10,'pending','promptpay','T2')`,
    [chargeId, shopId]);
  try {
    await withEnv({ NODE_ENV: 'production', OMISE_WEBHOOK_SECRET: 'correct-secret-abc', ALLOW_UNVERIFIED_WEBHOOKS: undefined }, async () => {
      const body = JSON.stringify({ key: 'charge.complete', data: { id: chargeId, status: 'successful', paid: true } });
      const sig = omiseSign('wrong-secret-xyz', body);   // signed with the WRONG secret
      const r = await rawPost('/webhooks/omise-charge', body, { 'Opn-Signature': sig });
      assert.strictEqual(r.status, 401, 'expected 401 invalid signature, got ' + r.status + ' ' + r.text);
    });
    const row = (await pool.query('select status from pay_charges where id=$1', [chargeId])).rows[0];
    assert.strictEqual(row.status, 'pending', 'REGRESSION: charge was mutated despite incorrect signature');
  } finally {
    await pool.query('delete from pay_charges where id=$1', [chargeId]);
  }
});

test('omise-charge: malformed signature header -> 401, no mutation', async () => {
  const chargeId = 'chrg_test_' + Date.now() + '_c';
  await pool.query(
    `insert into pay_charges (id, shop_id, amount, status, source_type, bill_no) values ($1,$2,10,'pending','promptpay','T3')`,
    [chargeId, shopId]);
  try {
    await withEnv({ NODE_ENV: 'production', OMISE_WEBHOOK_SECRET: 'correct-secret-abc', ALLOW_UNVERIFIED_WEBHOOKS: undefined }, async () => {
      const body = JSON.stringify({ key: 'charge.complete', data: { id: chargeId, status: 'successful', paid: true } });
      // not hex, not the right length — garbage
      const r1 = await rawPost('/webhooks/omise-charge', body, { 'Opn-Signature': 'not-a-real-signature' });
      assert.strictEqual(r1.status, 401, 'malformed signature should be rejected, got ' + r1.status);
      // missing header entirely, even though a secret IS configured
      const r2 = await rawPost('/webhooks/omise-charge', body, {});
      assert.strictEqual(r2.status, 401, 'missing signature header (secret configured) should be rejected, got ' + r2.status);
    });
    const row = (await pool.query('select status from pay_charges where id=$1', [chargeId])).rows[0];
    assert.strictEqual(row.status, 'pending', 'REGRESSION: charge was mutated despite malformed/missing signature');
  } finally {
    await pool.query('delete from pay_charges where id=$1', [chargeId]);
  }
});

test('omise-charge: valid signature -> processed, and repeated delivery is idempotent', async () => {
  const chargeId = 'chrg_test_' + Date.now() + '_d';
  await pool.query(
    `insert into pay_charges (id, shop_id, amount, status, source_type, bill_no) values ($1,$2,10,'pending','promptpay','T4')`,
    [chargeId, shopId]);
  try {
    await withEnv({ NODE_ENV: 'production', OMISE_WEBHOOK_SECRET: 'correct-secret-abc', ALLOW_UNVERIFIED_WEBHOOKS: undefined }, async () => {
      const body = JSON.stringify({ key: 'charge.complete', data: { id: chargeId, status: 'successful', paid: true } });
      const sig = omiseSign('correct-secret-abc', body);

      const r1 = await rawPost('/webhooks/omise-charge', body, { 'Opn-Signature': sig });
      assert.strictEqual(r1.status, 200, 'valid signature should be processed, got ' + r1.status + ' ' + r1.text);
      const row1 = (await pool.query('select status, paid_at from pay_charges where id=$1', [chargeId])).rows[0];
      assert.strictEqual(row1.status, 'paid', 'charge should be marked paid after valid webhook');
      const paidAt1 = row1.paid_at;

      // redeliver the SAME valid webhook (Omise retries on any non-2xx, and can also just retry) —
      // must not error and must not duplicate/corrupt state.
      const r2 = await rawPost('/webhooks/omise-charge', body, { 'Opn-Signature': sig });
      assert.strictEqual(r2.status, 200, 'repeated valid webhook should still be accepted (idempotent), got ' + r2.status);
      const row2 = (await pool.query('select status, paid_at from pay_charges where id=$1', [chargeId])).rows[0];
      assert.strictEqual(row2.status, 'paid', 'charge should remain paid after redelivery');
      assert.strictEqual(
        new Date(row2.paid_at).getTime() >= new Date(paidAt1).getTime(), true,
        'idempotent redelivery should not corrupt paid_at'
      );
      const count = (await pool.query('select count(*)::int as c from pay_charges where id=$1', [chargeId])).rows[0].c;
      assert.strictEqual(count, 1, 'REGRESSION: repeated webhook created a duplicate row instead of updating in place');
    });
  } finally {
    await pool.query('delete from pay_charges where id=$1', [chargeId]);
  }
});

test('omise-charge: dev-mode vs prod-mode behavior differs, and the dev bypass is powerless in production', async () => {
  const chargeIdDev = 'chrg_test_' + Date.now() + '_dev';
  const chargeIdProd = 'chrg_test_' + Date.now() + '_prod';
  await pool.query(
    `insert into pay_charges (id, shop_id, amount, status, source_type, bill_no) values ($1,$2,10,'pending','promptpay','T5'),($3,$2,10,'pending','promptpay','T6')`,
    [chargeIdDev, shopId, chargeIdProd]);
  try {
    // Dev mode + explicit bypass flag + NO secret configured -> processed unverified (opt-in only).
    await withEnv({ NODE_ENV: 'development', OMISE_WEBHOOK_SECRET: undefined, ALLOW_UNVERIFIED_WEBHOOKS: '1' }, async () => {
      const body = JSON.stringify({ key: 'charge.complete', data: { id: chargeIdDev, status: 'successful', paid: true } });
      const r = await rawPost('/webhooks/omise-charge', body, {});
      assert.strictEqual(r.status, 200, 'explicit dev bypass should allow unverified processing, got ' + r.status + ' ' + r.text);
    });
    const rowDev = (await pool.query('select status from pay_charges where id=$1', [chargeIdDev])).rows[0];
    assert.strictEqual(rowDev.status, 'paid', 'dev-mode explicit bypass should have processed the webhook');

    // Same flag, but NODE_ENV=production -> the bypass must be POWERLESS. Still 503, still no mutation.
    await withEnv({ NODE_ENV: 'production', OMISE_WEBHOOK_SECRET: undefined, ALLOW_UNVERIFIED_WEBHOOKS: '1' }, async () => {
      const body = JSON.stringify({ key: 'charge.complete', data: { id: chargeIdProd, status: 'successful', paid: true } });
      const r = await rawPost('/webhooks/omise-charge', body, {});
      assert.strictEqual(r.status, 503, 'REGRESSION: ALLOW_UNVERIFIED_WEBHOOKS must be ignored in production, got ' + r.status);
    });
    const rowProd = (await pool.query('select status from pay_charges where id=$1', [chargeIdProd])).rows[0];
    assert.strictEqual(rowProd.status, 'pending', 'REGRESSION: production processed an unverified webhook via the dev bypass flag');
  } finally {
    await pool.query('delete from pay_charges where id in ($1,$2)', [chargeIdDev, chargeIdProd]);
  }
});

// ---------------------------------------------------------------------------
// /webhooks/omise (backend/src/webhooks/omise.js) — billing path, same guard applied
// ---------------------------------------------------------------------------

test('billing webhook (/webhooks/omise): missing secret in production -> 503', async () => {
  await withEnv({ NODE_ENV: 'production', OMISE_WEBHOOK_SECRET: undefined, ALLOW_UNVERIFIED_WEBHOOKS: undefined }, async () => {
    const body = JSON.stringify({ key: 'ping', id: 'evt_x' });
    const r = await rawPost('/webhooks/omise', body, {});
    assert.strictEqual(r.status, 503, 'expected 503, got ' + r.status + ' ' + r.text);
  });
});

test('billing webhook (/webhooks/omise): incorrect secret -> 401', async () => {
  await withEnv({ NODE_ENV: 'production', OMISE_WEBHOOK_SECRET: 'correct-secret-abc', ALLOW_UNVERIFIED_WEBHOOKS: undefined }, async () => {
    const body = JSON.stringify({ key: 'ping', id: 'evt_x' });
    const sig = omiseSign('wrong-secret', body);
    const r = await rawPost('/webhooks/omise', body, { 'Opn-Signature': sig });
    assert.strictEqual(r.status, 401, 'expected 401, got ' + r.status + ' ' + r.text);
  });
});

test('billing webhook (/webhooks/omise): valid signature -> processed (200)', async () => {
  await withEnv({ NODE_ENV: 'production', OMISE_WEBHOOK_SECRET: 'correct-secret-abc', ALLOW_UNVERIFIED_WEBHOOKS: undefined }, async () => {
    // Unrecognised key so no billing mutation is attempted — proves the signature gate passes
    // and the handler proceeds to normal processing (which then no-ops on an unhandled key).
    const body = JSON.stringify({ key: 'ping', id: 'evt_x' });
    const sig = omiseSign('correct-secret-abc', body);
    const r = await rawPost('/webhooks/omise', body, { 'Opn-Signature': sig });
    assert.strictEqual(r.status, 200, 'expected 200, got ' + r.status + ' ' + r.text);
    assert.strictEqual(r.body && r.body.ok, true);
  });
});

// ---------------------------------------------------------------------------
// /webhooks/stripe (backend/src/webhooks/stripe.js) — same guard applied
// ---------------------------------------------------------------------------

test('stripe webhook: missing secret in production -> 503', async () => {
  await withEnv({
    NODE_ENV: 'production',
    STRIPE_SECRET_KEY: 'sk_test_fake0000000000000000000000',
    STRIPE_WEBHOOK_SECRET: undefined,
    ALLOW_UNVERIFIED_WEBHOOKS: undefined,
  }, async () => {
    const body = JSON.stringify({ id: 'evt_1', type: 'ping' });
    const r = await rawPost('/webhooks/stripe', body, {});
    assert.strictEqual(r.status, 503, 'expected 503, got ' + r.status + ' ' + r.text);
  });
});

test('stripe webhook: incorrect/malformed signature -> 401', async () => {
  await withEnv({
    NODE_ENV: 'production',
    STRIPE_SECRET_KEY: 'sk_test_fake0000000000000000000000',
    STRIPE_WEBHOOK_SECRET: 'whsec_test_correct',
    ALLOW_UNVERIFIED_WEBHOOKS: undefined,
  }, async () => {
    const body = JSON.stringify({ id: 'evt_1', type: 'ping' });
    const badSig = Stripe.webhooks.generateTestHeaderString({ payload: body, secret: 'whsec_wrong' });
    const r = await rawPost('/webhooks/stripe', body, { 'Stripe-Signature': badSig });
    assert.strictEqual(r.status, 401, 'expected 401, got ' + r.status + ' ' + r.text);

    const r2 = await rawPost('/webhooks/stripe', body, {});   // no signature header at all
    assert.strictEqual(r2.status, 401, 'missing signature should also be rejected, got ' + r2.status);
  });
});

test('stripe webhook: valid signature -> processed (200)', async () => {
  await withEnv({
    NODE_ENV: 'production',
    STRIPE_SECRET_KEY: 'sk_test_fake0000000000000000000000',
    STRIPE_WEBHOOK_SECRET: 'whsec_test_correct',
    ALLOW_UNVERIFIED_WEBHOOKS: undefined,
  }, async () => {
    // Unhandled event type so no billing mutation is attempted — proves the signature gate
    // passes and the switch falls through cleanly.
    const body = JSON.stringify({ id: 'evt_1', type: 'ping', data: { object: {} } });
    const sig = Stripe.webhooks.generateTestHeaderString({ payload: body, secret: 'whsec_test_correct' });
    const r = await rawPost('/webhooks/stripe', body, { 'Stripe-Signature': sig });
    assert.strictEqual(r.status, 200, 'expected 200, got ' + r.status + ' ' + r.text);
  });
});
