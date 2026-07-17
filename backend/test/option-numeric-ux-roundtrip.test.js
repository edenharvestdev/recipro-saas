// Founder-mandated persistence proof for the Option Builder numeric-input UX
// fix (frontend/index.html ogNumFocus/ogNumInput/ogNumBlur).
//
// "save and reload preserves the entered value" — a typed 7.5 (decimal) and a
// typed 1250 (4-digit) must survive a REAL save -> DB -> reload cycle, not
// just an in-memory round-trip. Same technique as
// option-persistence-roundtrip.test.js: no stubs, real express app, real
// local Postgres, register -> POST /api/sync -> GET /api/bootstrap.
//
// This exercises the two persisted columns the fixed UI fields actually
// write: option_choice_links.amount (the REPLACE/ADD "replacement quantity"
// field, links[0].amount) and option_choices.amount / price_add (the
// CHANGE_QUANTITY fixed-amount and price-adjustment fields) — the exact
// model fields ogNumTargetSet commits to.
require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { pool } = require('../src/db');
const app = require('../src/app');

const DB = process.env.DATABASE_URL || '';
if (!/@(localhost|127\.0\.0\.1)[:/]/.test(DB)) {
  throw new Error('refusing to run: DATABASE_URL is not local');
}

let server, base, token, shopId;
const req = (method, path, body, tok) => new Promise((resolve, reject) => {
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

test.before(async () => {
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  base = 'http://127.0.0.1:' + server.address().port;
  const email = 'numux_' + Date.now() + '@local.test';
  const reg = await req('POST', '/auth/register', { email, password: 'NumUX#2026test', shopName: 'NUMERIC UX ROUNDTRIP TEST' });
  assert.strictEqual(reg.status, 200, 'register failed: ' + JSON.stringify(reg.body));
  token = reg.body.accessToken;
  shopId = reg.body.memberships[0].shop_id;
});

test.after(async () => {
  if (shopId) await pool.query('delete from shops where id=$1', [shopId]);
  await new Promise((r) => server.close(r));
  await pool.end();
});

test('a typed 7.5 (decimal replacement quantity) and a typed 1250 (4-digit change-amount/price) survive sync -> bootstrap', async () => {
  const matFromId = '44444444-4444-4444-8444-444444444444';
  const matToId = '55555555-5555-4555-8555-555555555555';
  const gid = '66666666-6666-4666-8666-666666666666';
  const replaceChoiceId = '77777777-7777-4777-8777-777777777777';
  const quantityChoiceId = '88888888-8888-4888-8888-888888888888';
  const linkId = '99999999-9999-4999-8999-999999999999';

  const boot0 = await req('GET', '/api/bootstrap', null, token);
  assert.strictEqual(boot0.status, 200);

  const payload = {
    _base_version: boot0.body.settings.data_version,
    materials: [
      { id: matFromId, name: 'Espresso' },
      { id: matToId, name: 'Fresh Milk' },
    ],
    option_groups: [{ id: gid, label: 'เปลี่ยนนม', select_type: 'single', required: false, min_select: 0, max_select: 1, sort: 0, enabled: true }],
    option_choices: [
      // The REPLACE quantity field — as typed via ogNumInput/ogNumBlur('amount') — persists as an option_choice_links row.
      {
        id: replaceChoiceId, group_id: gid, label: 'Fresh Milk 7.5ml', price_add: 0, effect_type: 'REPLACE',
        enabled: true, is_default: false, sort: 0, max_qty: 1, target_role: '', is_metadata_only: false,
        amount: 0, target_material_id: matFromId, quantity_mode: 'FIXED', quantity_value: null,
      },
      // The CHANGE_QUANTITY fixed-amount field (c.amount, via ogNumInput/ogNumBlur('changeAmount'))
      // and the price-adjustment field (c.priceAdd, via ogNumInput/ogNumBlur('price')) — both a typed
      // 4-digit value.
      {
        id: quantityChoiceId, group_id: gid, label: 'ปรับปริมาณ 1250', price_add: 1250, effect_type: 'QUANTITY',
        enabled: true, is_default: false, sort: 1, max_qty: 1, target_role: '', is_metadata_only: false,
        amount: 1250, target_material_id: matFromId, quantity_mode: 'FIXED', quantity_value: null,
      },
    ],
    option_choice_links: [
      { id: linkId, choice_id: replaceChoiceId, material_id: matToId, amount: 7.5 },
    ],
  };

  const save1 = await req('POST', '/api/sync', payload, token);
  assert.strictEqual(save1.status, 200, 'create sync failed: ' + JSON.stringify(save1.body));

  // ---- RELOAD #1 ----
  const boot1 = await req('GET', '/api/bootstrap', null, token);
  assert.strictEqual(boot1.status, 200);
  const replaceAfter1 = (boot1.body.option_choices || []).find((c) => c.id === replaceChoiceId);
  const quantityAfter1 = (boot1.body.option_choices || []).find((c) => c.id === quantityChoiceId);
  const linkAfter1 = (boot1.body.option_choice_links || []).find((l) => l.id === linkId);
  assert.ok(replaceAfter1, 'REPLACE choice missing after reload #1');
  assert.ok(quantityAfter1, 'CHANGE_QUANTITY choice missing after reload #1');
  assert.ok(linkAfter1, 'replacement-quantity link missing after reload #1');

  assert.strictEqual(Number(linkAfter1.amount), 7.5, 'typed decimal 7.5 (replacement quantity) did not survive reload #1');
  assert.strictEqual(Number(quantityAfter1.amount), 1250, 'typed 4-digit 1250 (change-quantity amount) did not survive reload #1');
  assert.strictEqual(Number(quantityAfter1.price_add), 1250, 'typed 4-digit 1250 (price adjustment) did not survive reload #1');

  // ---- SAVE AGAIN (re-save exactly what came back) ----
  const resave = {
    _base_version: boot1.body.settings.data_version,
    option_groups: [{ id: gid, label: 'เปลี่ยนนม', select_type: 'single', required: false, min_select: 0, max_select: 1, sort: 0, enabled: true }],
    option_choices: [replaceAfter1, quantityAfter1],
    option_choice_links: [linkAfter1],
  };
  const save2 = await req('POST', '/api/sync', resave, token);
  assert.strictEqual(save2.status, 200, 're-save failed: ' + JSON.stringify(save2.body));

  // ---- RELOAD #2 ----
  const boot2 = await req('GET', '/api/bootstrap', null, token);
  assert.strictEqual(boot2.status, 200);
  const linkAfter2 = (boot2.body.option_choice_links || []).find((l) => l.id === linkId);
  const quantityAfter2 = (boot2.body.option_choices || []).find((c) => c.id === quantityChoiceId);
  assert.strictEqual(Number(linkAfter2.amount), 7.5, 'the decimal 7.5 drifted or was lost across a second save->reload cycle');
  assert.strictEqual(Number(quantityAfter2.amount), 1250, 'the 4-digit 1250 (amount) drifted or was lost across a second save->reload cycle');
  assert.strictEqual(Number(quantityAfter2.price_add), 1250, 'the 4-digit 1250 (price_add) drifted or was lost across a second save->reload cycle');
});
