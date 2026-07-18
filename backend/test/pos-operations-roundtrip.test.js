// POS Operations Manager (P0) — real DB round-trip + permission-enforcement proof.
// node backend/test/pos-operations-roundtrip.test.js
//
// Follows the same "no stubs, real HTTP against real local Postgres" discipline as
// backend/test/option-persistence-roundtrip.test.js:
//   register owner -> POST /api/sync (create) -> GET /api/bootstrap (reload)
//   -> POST /api/sync (re-save) -> GET /api/bootstrap (reload again)
// plus a staff membership to prove server-side permission enforcement is real (not just
// frontend hiding), and a direct `logs` table check to prove the audit trail lands.
//
// A fresh shop is created per run and deleted afterwards, so this cannot touch anything else.
require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { pool, query } = require('../src/db');
const app = require('../src/app');

const DB = process.env.DATABASE_URL || '';
if (!/@(localhost|127\.0\.0\.1)[:/]/.test(DB)) {
  throw new Error('refusing to run: DATABASE_URL is not local');
}

let server, base, ownerToken, shopId, ownerUserId, staffToken, staffUserId;
// NOTE: /auth/register ALWAYS creates a brand-new shop + 'owner' membership for the registering
// user (see backend/src/auth/routes.js) — so the staff test user here is ALSO an owner of its
// OWN unrelated auto-created shop. tenant.js picks `X-Shop-Id` if given, else the first membership
// row, which would silently resolve to that owner membership (full bypass!) instead of the 'staff'
// membership on the shop under test. Every staff-authenticated request below MUST carry
// X-Shop-Id so tenant.js resolves to the intended (non-owner) membership.
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
// Convenience: staff requests are ALWAYS shop-scoped explicitly (see note above); owner requests
// don't need it (single membership) but scoping them too costs nothing and removes ambiguity.
const asOwner = (method, path, body) => req(method, path, body, ownerToken, shopId);
const asStaff = (method, path, body) => req(method, path, body, staffToken, shopId);
const setStaffPerms = (obj) => query('update memberships set permissions=$1 where user_id=$2 and shop_id=$3',
  [obj === null ? null : JSON.stringify(obj), staffUserId, shopId]);

test.before(async () => {
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  base = 'http://127.0.0.1:' + server.address().port;
  const email = 'posops_' + Date.now() + '@local.test';
  const reg = await req('POST', '/auth/register', { email, password: 'PosOps#2026test', shopName: 'POS OPS ROUNDTRIP TEST' });
  assert.strictEqual(reg.status, 200, 'owner register failed: ' + JSON.stringify(reg.body));
  ownerToken = reg.body.accessToken;
  shopId = reg.body.memberships[0].shop_id;
  ownerUserId = reg.body.user.id;

  const staffEmail = 'posops_staff_' + Date.now() + '@local.test';
  const staffReg = await req('POST', '/auth/register', { email: staffEmail, password: 'PosOps#2026test' });
  assert.strictEqual(staffReg.status, 200, 'staff register failed: ' + JSON.stringify(staffReg.body));
  staffUserId = staffReg.body.user.id;
  await query("insert into memberships(user_id, shop_id, role, permissions) values ($1,$2,'staff',$3)", [staffUserId, shopId, JSON.stringify({})]);
  const staffLogin = await req('POST', '/auth/login', { email: staffEmail, password: 'PosOps#2026test' });
  assert.strictEqual(staffLogin.status, 200, 'staff login failed: ' + JSON.stringify(staffLogin.body));
  staffToken = staffLogin.body.accessToken;
});

test.after(async () => {
  if (shopId) await pool.query('delete from shops where id=$1', [shopId]);
  await new Promise((r) => server.close(r));
  await pool.end();
});

test('the two new columns physically exist on both tables with NOT NULL + default true', async () => {
  for (const table of ['recipes', 'materials']) {
    const cols = (await pool.query(
      `select column_name, is_nullable, column_default from information_schema.columns
        where table_name=$1 and column_name in ('pos_available','pos_unavailable_reason')`, [table]
    )).rows;
    assert.strictEqual(cols.length, 2, `expected both columns on ${table}, found: ${cols.map(c => c.column_name).join(',')}`);
    const avail = cols.find((c) => c.column_name === 'pos_available');
    const reason = cols.find((c) => c.column_name === 'pos_unavailable_reason');
    assert.strictEqual(avail.is_nullable, 'NO', `${table}.pos_available must be NOT NULL`);
    assert.match(String(avail.column_default), /true/, `${table}.pos_available must default to true`);
    assert.strictEqual(reason.is_nullable, 'YES', `${table}.pos_unavailable_reason must stay nullable`);
  }
});

test('legacy row (no pos_available sent at all) is fully available, and a load+re-save cycle does not change it', async () => {
  const recId = '10000000-0000-4000-8000-000000000001';
  const matId = '10000000-0000-4000-8000-000000000002';
  const boot0 = await asOwner('GET', '/api/bootstrap', null);
  const create = await asOwner('POST', '/api/sync', {
    _base_version: boot0.body.settings.data_version,
    recipes: [{ id: recId, name: 'Legacy Recipe', yield_unit: 'cup', batch_yield: 1 }],
    materials: [{ id: matId, name: 'Legacy Material', unit: 'g', stock_unit: 'g', qty: 1, conv_qty: 1 }],
  });
  assert.strictEqual(create.status, 200, 'legacy create failed: ' + JSON.stringify(create.body));

  const boot1 = await asOwner('GET', '/api/bootstrap', null);
  const rec1 = boot1.body.recipes.find((r) => r.id === recId);
  const mat1 = boot1.body.materials.find((m) => m.id === matId);
  assert.ok(rec1 && mat1, 'legacy rows missing after reload');
  assert.strictEqual(rec1.pos_available, true, 'legacy recipe must default to available');
  assert.strictEqual(rec1.pos_unavailable_reason, null, 'legacy recipe must have no reason');
  assert.strictEqual(mat1.pos_available, true, 'legacy material must default to available');
  assert.strictEqual(mat1.pos_unavailable_reason, null, 'legacy material must have no reason');

  // Re-save exactly what came back (the common "edit something unrelated" path) — must not flip anything.
  const resave = await asOwner('POST', '/api/sync', {
    _base_version: boot1.body.settings.data_version,
    recipes: [{ id: recId, name: 'Legacy Recipe', yield_unit: 'cup', batch_yield: 1 }],
    materials: [{ id: matId, name: 'Legacy Material', unit: 'g', stock_unit: 'g', qty: 1, conv_qty: 1 }],
  });
  assert.strictEqual(resave.status, 200, 're-save failed: ' + JSON.stringify(resave.body));

  const boot2 = await asOwner('GET', '/api/bootstrap', null);
  const rec2 = boot2.body.recipes.find((r) => r.id === recId);
  const mat2 = boot2.body.materials.find((m) => m.id === matId);
  assert.strictEqual(rec2.pos_available, true, 'REGRESSION: a load+re-save cycle flipped a legacy recipe to unavailable');
  assert.strictEqual(mat2.pos_available, true, 'REGRESSION: a load+re-save cycle flipped a legacy material to unavailable');
});

test('manager closes a menu with a reason; it survives a real DB reload; re-opening clears the reason', async () => {
  const recId = '20000000-0000-4000-8000-000000000001';
  const boot0 = await asOwner('GET', '/api/bootstrap', null);
  await asOwner('POST', '/api/sync', {
    _base_version: boot0.body.settings.data_version,
    recipes: [{ id: recId, name: 'Closeable Recipe', yield_unit: 'cup', batch_yield: 1 }],
  });

  const boot1 = await asOwner('GET', '/api/bootstrap', null);
  const close = await asOwner('POST', '/api/sync', {
    _base_version: boot1.body.settings.data_version,
    recipes: [{ id: recId, name: 'Closeable Recipe', yield_unit: 'cup', batch_yield: 1, pos_available: false, pos_unavailable_reason: 'ของหมด' }],
  });
  assert.strictEqual(close.status, 200, 'close failed: ' + JSON.stringify(close.body));

  const boot2 = await asOwner('GET', '/api/bootstrap', null);
  const closed = boot2.body.recipes.find((r) => r.id === recId);
  assert.strictEqual(closed.pos_available, false, 'recipe should read as unavailable after reload');
  assert.strictEqual(closed.pos_unavailable_reason, 'ของหมด', 'reason should survive the reload verbatim');

  // Re-open: available again, reason cleared (posSetAvailability's own contract on the frontend).
  const reopen = await asOwner('POST', '/api/sync', {
    _base_version: boot2.body.settings.data_version,
    recipes: [{ id: recId, name: 'Closeable Recipe', yield_unit: 'cup', batch_yield: 1, pos_available: true, pos_unavailable_reason: null }],
  });
  assert.strictEqual(reopen.status, 200, 'reopen failed: ' + JSON.stringify(reopen.body));

  const boot3 = await asOwner('GET', '/api/bootstrap', null);
  const reopened = boot3.body.recipes.find((r) => r.id === recId);
  assert.strictEqual(reopened.pos_available, true, 'recipe should read as available again after reopening');
  assert.strictEqual(reopened.pos_unavailable_reason, null, 'reason should be cleared on reopen');
});

test('availability changes write a real audit row (menu.availability_change) with actor, old/new state and reason', async () => {
  const matId = '30000000-0000-4000-8000-000000000001';
  const boot0 = await asOwner('GET', '/api/bootstrap', null);
  await asOwner('POST', '/api/sync', {
    _base_version: boot0.body.settings.data_version,
    materials: [{ id: matId, name: 'Audited Material', unit: 'g', stock_unit: 'g', qty: 1, conv_qty: 1 }],
  });

  const boot1 = await asOwner('GET', '/api/bootstrap', null);
  const correlation = 'test_corr_' + Date.now();
  const closeWithAudit = await asOwner('POST', '/api/sync', {
    _base_version: boot1.body.settings.data_version,
    materials: [{ id: matId, name: 'Audited Material', unit: 'g', stock_unit: 'g', qty: 1, conv_qty: 1, pos_available: false, pos_unavailable_reason: 'Kitchen unavailable' }],
    // NOTE: the real client (posAvailAuditPush in frontend/index.html) always sends old/new as the
    // literal strings 'available'/'unavailable', never raw booleans — mirror that here.
    _availability_audit: [{
      action: 'menu.availability_change', target_type: 'material', target_id: matId, target_name: 'Audited Material',
      old: 'available', new: 'unavailable', reason: 'Kitchen unavailable', correlation, at: new Date().toISOString(),
    }],
  });
  assert.strictEqual(closeWithAudit.status, 200, 'sync with audit failed: ' + JSON.stringify(closeWithAudit.body));

  // logEvent is fire-and-forget (writes after res.json is queued) — poll briefly for the row.
  let row = null;
  for (let i = 0; i < 20 && !row; i++) {
    const r = await pool.query(
      "select * from logs where shop_id=$1 and action='menu.availability_change' and detail->>'correlation'=$2",
      [shopId, correlation]
    );
    row = r.rows[0] || null;
    if (!row) await new Promise((r2) => setTimeout(r2, 100));
  }
  assert.ok(row, 'no menu.availability_change log row appeared within 2s of a successful sync');
  assert.strictEqual(row.user_id, ownerUserId, 'audit row must record the actor');
  assert.strictEqual(row.shop_id, shopId, 'audit row must be tenant-scoped');
  assert.strictEqual(row.detail.target_type, 'material');
  assert.strictEqual(row.detail.target_id, matId);
  assert.strictEqual(row.detail.old, 'available');
  assert.strictEqual(row.detail.new, 'unavailable');
  assert.strictEqual(row.detail.reason, 'Kitchen unavailable');
  assert.strictEqual(row.detail.reason_controlled, true, 'a Founder-listed reason must be flagged as controlled');
});

test('permission enforcement: creating a brand-new default-available item needs no permission, but toggling an existing one is fail-closed for staff without the key', async () => {
  // Staff with ZERO explicit permissions may still create a plain new recipe (default available) —
  // creation itself is gated by recipe_edit-style rules elsewhere, not by pos_toggle_availability.
  // Grant only what's needed to prove the availability gate specifically: recipe_edit for creation.
  await setStaffPerms({ recipe_edit: true });
  const newRecId = '40000000-0000-4000-8000-000000000001';
  const create = await asStaff('POST', '/api/sync', {
    recipes: [{ id: newRecId, name: 'Staff Created', yield_unit: 'cup', batch_yield: 1 }],
  });
  assert.strictEqual(create.status, 200, 'staff should be able to create a plain (default-available) recipe with only recipe_edit: ' + JSON.stringify(create.body));
  const afterCreate = (await pool.query('select pos_available from recipes where id=$1', [newRecId])).rows[0];
  assert.strictEqual(afterCreate.pos_available, true, 'new recipe should default to available');

  // Now an OWNER-created existing recipe, and staff (still only recipe_edit, no pos_toggle_availability)
  // tries to close it — must be denied without touching the row.
  const boot = await asOwner('GET', '/api/bootstrap', null);
  const existingId = '40000000-0000-4000-8000-000000000002';
  await asOwner('POST', '/api/sync', {
    _base_version: boot.body.settings.data_version,
    recipes: [{ id: existingId, name: 'Owner Existing', yield_unit: 'cup', batch_yield: 1 }],
  });

  const deny1 = await asStaff('POST', '/api/sync', {
    recipes: [{ id: existingId, name: 'Owner Existing', yield_unit: 'cup', batch_yield: 1, pos_available: false, pos_unavailable_reason: 'ของหมด' }],
  });
  assert.strictEqual(deny1.status, 403, 'staff with only recipe_edit must be denied toggling availability: ' + JSON.stringify(deny1.body));
  assert.strictEqual(deny1.body.code, 'POS_AVAILABILITY_PERMISSION_DENIED');
  const dbAfterDeny1 = (await pool.query('select pos_available, pos_unavailable_reason from recipes where id=$1', [existingId])).rows[0];
  assert.strictEqual(dbAfterDeny1.pos_available, true, 'denied toggle attempt must not have touched the DB row');
  assert.strictEqual(dbAfterDeny1.pos_unavailable_reason, null);

  // Grant ONLY pos_toggle_availability (no recipe_edit) — toggle must now succeed...
  await setStaffPerms({ pos_toggle_availability: true });
  const allow = await asStaff('POST', '/api/sync', {
    recipes: [{ id: existingId, name: 'Owner Existing', yield_unit: 'cup', batch_yield: 1, pos_available: false, pos_unavailable_reason: 'ของหมด' }],
  });
  assert.strictEqual(allow.status, 200, 'staff with pos_toggle_availability must be able to close the menu: ' + JSON.stringify(allow.body));
  const dbAfterAllow = (await pool.query('select pos_available, pos_unavailable_reason from recipes where id=$1', [existingId])).rows[0];
  assert.strictEqual(dbAfterAllow.pos_available, false);
  assert.strictEqual(dbAfterAllow.pos_unavailable_reason, 'ของหมด');

  // ...but that SAME staff (pos_toggle_availability only, no recipe_edit) must still be denied
  // editing the recipe's name — proving the two permissions are genuinely decoupled, not aliased.
  const denyEdit = await asStaff('POST', '/api/sync', {
    recipes: [{ id: existingId, name: 'RENAMED-BY-STAFF', yield_unit: 'cup', batch_yield: 1, pos_available: false, pos_unavailable_reason: 'ของหมด' }],
  });
  assert.strictEqual(denyEdit.status, 403, 'pos_toggle_availability must not imply recipe_edit');
  assert.strictEqual(denyEdit.body.code, 'RECIPE_READ_ONLY');
  const dbAfterDenyEdit = (await pool.query('select name from recipes where id=$1', [existingId])).rows[0];
  assert.strictEqual(dbAfterDenyEdit.name, 'Owner Existing', 'denied rename must not have touched the DB row');
});

test('permission enforcement mirrors for materials too (independent of recipe_edit_cost)', async () => {
  await setStaffPerms({});
  const boot = await asOwner('GET', '/api/bootstrap', null);
  const matId = '50000000-0000-4000-8000-000000000001';
  await asOwner('POST', '/api/sync', {
    _base_version: boot.body.settings.data_version,
    materials: [{ id: matId, name: 'Owner Material', unit: 'g', stock_unit: 'g', qty: 1, conv_qty: 1 }],
  });

  const deny = await asStaff('POST', '/api/sync', {
    materials: [{ id: matId, name: 'Owner Material', unit: 'g', stock_unit: 'g', qty: 1, conv_qty: 1, pos_available: false, pos_unavailable_reason: 'Seasonal' }],
  });
  assert.strictEqual(deny.status, 403);
  assert.strictEqual(deny.body.code, 'POS_AVAILABILITY_PERMISSION_DENIED');

  await setStaffPerms({ pos_toggle_availability: true });
  const allow = await asStaff('POST', '/api/sync', {
    materials: [{ id: matId, name: 'Owner Material', unit: 'g', stock_unit: 'g', qty: 1, conv_qty: 1, pos_available: false, pos_unavailable_reason: 'Seasonal' }],
  });
  assert.strictEqual(allow.status, 200, JSON.stringify(allow.body));
  const db = (await pool.query('select pos_available, pos_unavailable_reason from materials where id=$1', [matId])).rows[0];
  assert.strictEqual(db.pos_available, false);
  assert.strictEqual(db.pos_unavailable_reason, 'Seasonal');
});
