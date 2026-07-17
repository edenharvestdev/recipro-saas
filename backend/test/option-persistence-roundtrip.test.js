// Founder-mandated persistence proof for the Option Builder.
//
// "Every field used by validation must persist through a real database reload.
//  No in-memory proof is accepted."
//
// So this test uses NO stubs and NO extracted-source simulation. It drives the REAL
// express app over HTTP against the REAL local Postgres:
//
//   register owner -> POST /api/sync (create) -> GET /api/bootstrap (reload #1)
//   -> POST /api/sync (save again, byte-identical) -> GET /api/bootstrap (reload #2)
//
// and asserts every validation-bearing field is unchanged at every step, and that a
// legacy row (all authoring metadata null) is never silently disabled by a save cycle.
//
// The shop is created fresh per run and deleted afterwards, so it cannot touch anything else.
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

// The choice under test: every field validation depends on, all non-default so a
// reset-to-default would be caught rather than coincidentally matching.
const CHOICE = {
  label: 'Oat Milk',
  price_add: 20,
  effect_type: 'REPLACE',
  enabled: true,
  is_default: false,
  sort: 0,
  max_qty: 1,
  target_role: '',
  is_metadata_only: false,
  amount: 0,
  quantity_mode: 'MATCH_SOURCE',
  quantity_value: null,
  kitchen_note: 'ใช้นมโอ๊ตแทนนมสด คนให้เข้ากัน',
  add_menu_mode: 'CONTAINING',
  mismatch_ack: true,
};
const FIELDS = ['label', 'price_add', 'effect_type', 'enabled', 'is_default', 'quantity_mode',
  'quantity_value', 'kitchen_note', 'add_menu_mode', 'mismatch_ack', 'amount', 'is_metadata_only'];

// Normalise pg's numeric-as-string so equality compares values, not driver formatting.
const norm = (c) => {
  const o = {};
  for (const f of FIELDS) {
    let v = c[f];
    if (v !== null && v !== undefined && (f === 'price_add' || f === 'quantity_value' || f === 'amount')) v = Number(v);
    o[f] = v === undefined ? null : v;
  }
  return o;
};

test.before(async () => {
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  base = 'http://127.0.0.1:' + server.address().port;
  const email = 'persist_' + Date.now() + '@local.test';
  const reg = await req('POST', '/auth/register', { email, password: 'Persist#2026test', shopName: 'PERSISTENCE ROUNDTRIP TEST' });
  assert.strictEqual(reg.status, 200, 'register failed: ' + JSON.stringify(reg.body));
  token = reg.body.accessToken;
  shopId = reg.body.memberships[0].shop_id;
});

test.after(async () => {
  if (shopId) await pool.query('delete from shops where id=$1', [shopId]);
  await new Promise((r) => server.close(r));
  await pool.end();
});

test('every validation-bearing option field survives a real DB reload, twice', async () => {
  const gid = '11111111-1111-4111-8111-111111111111';
  const cid = '22222222-2222-4222-8222-222222222222';
  const legacyId = '33333333-3333-4333-8333-333333333333';

  // ---- CREATE ----
  const boot0 = await req('GET', '/api/bootstrap', null, token);
  assert.strictEqual(boot0.status, 200);
  const payload = (baseVersion) => ({
    _base_version: baseVersion,
    option_groups: [{ id: gid, label: 'เปลี่ยนนม', select_type: 'single', required: false, min_select: 0, max_select: 1, sort: 0, enabled: true }],
    option_choices: [
      Object.assign({ id: cid, group_id: gid }, CHOICE),
      // A LEGACY row: enabled, but carrying none of the new authoring metadata.
      { id: legacyId, group_id: gid, label: 'Legacy Choice', price_add: 5, effect_type: 'ADD',
        enabled: true, is_default: false, sort: 1, max_qty: 1, target_role: '', is_metadata_only: false, amount: 0 },
    ],
  });

  const save1 = await req('POST', '/api/sync', payload(boot0.body.settings.data_version), token);
  assert.strictEqual(save1.status, 200, 'create sync failed: ' + JSON.stringify(save1.body));

  // ---- RELOAD #1 (real bootstrap, real DB) ----
  const boot1 = await req('GET', '/api/bootstrap', null, token);
  assert.strictEqual(boot1.status, 200);
  const after1 = (boot1.body.option_choices || []).find((c) => c.id === cid);
  assert.ok(after1, 'choice missing after reload #1 — it did not persist at all');

  for (const f of FIELDS) {
    const expected = f in CHOICE ? CHOICE[f] : after1[f];
    const actual = norm(after1)[f];
    assert.deepStrictEqual(actual, expected === undefined ? null : expected,
      `field "${f}" changed across reload #1: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
  assert.strictEqual(after1.kitchen_note, CHOICE.kitchen_note, 'kitchen instruction disappeared after reload');
  assert.strictEqual(after1.add_menu_mode, 'CONTAINING', 'addMenuMode lost after reload');
  assert.strictEqual(after1.mismatch_ack, true, 'mismatchAck lost after reload');
  assert.strictEqual(after1.quantity_mode, 'MATCH_SOURCE', 'quantityMode lost after reload');

  const legacy1 = (boot1.body.option_choices || []).find((c) => c.id === legacyId);
  assert.ok(legacy1, 'legacy choice missing after reload #1');
  assert.strictEqual(legacy1.enabled, true, 'legacy option was disabled by the first save');
  assert.strictEqual(legacy1.quantity_mode, null, 'legacy row should keep null quantity_mode (resolves as FIXED)');
  assert.strictEqual(legacy1.add_menu_mode, null, 'legacy row should keep null add_menu_mode');

  const snap1 = norm(after1);

  // ---- SAVE AGAIN (re-save exactly what came back — the common "edit something else" path) ----
  const resave = {
    _base_version: boot1.body.settings.data_version,
    option_groups: [{ id: gid, label: 'เปลี่ยนนม', select_type: 'single', required: false, min_select: 0, max_select: 1, sort: 0, enabled: true }],
    option_choices: [after1, legacy1],
  };
  const save2 = await req('POST', '/api/sync', resave, token);
  assert.strictEqual(save2.status, 200, 're-save failed: ' + JSON.stringify(save2.body));

  // ---- RELOAD #2 ----
  const boot2 = await req('GET', '/api/bootstrap', null, token);
  assert.strictEqual(boot2.status, 200);
  const after2 = (boot2.body.option_choices || []).find((c) => c.id === cid);
  assert.ok(after2, 'choice missing after reload #2');

  assert.deepStrictEqual(norm(after2), snap1,
    'a field changed across save->reload #2 — state is not stable across an edit cycle');

  const legacy2 = (boot2.body.option_choices || []).find((c) => c.id === legacyId);
  assert.strictEqual(legacy2.enabled, true,
    'REGRESSION: a legacy option was silently disabled by a load+save cycle');
  assert.strictEqual(legacy2.quantity_mode, null, 'legacy row must not be auto-converted to a quantity mode');
  assert.strictEqual(legacy2.add_menu_mode, null, 'legacy row must not be auto-assigned an add_menu_mode');

  // ---- publish state identical end-to-end ----
  assert.strictEqual(after2.enabled, CHOICE.enabled, 'publish state changed across two full reload cycles');
});

test('the five authoring columns physically exist with the right defaults', async () => {
  const cols = (await pool.query(
    `select column_name, data_type, column_default from information_schema.columns
      where table_name='option_choices'
        and column_name in ('quantity_mode','quantity_value','kitchen_note','add_menu_mode','mismatch_ack')`
  )).rows;
  assert.strictEqual(cols.length, 5, 'expected all 5 authoring columns to exist, found: ' + cols.map(c => c.column_name).join(','));
  const ack = cols.find(c => c.column_name === 'mismatch_ack');
  assert.match(String(ack.column_default), /false/, 'mismatch_ack must default to false');
});
