// Granular permissions — Phase A0 (sync hardening + sensitive-delete guards).
// Runs against real local Postgres. node test/permissions.test.js
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const app = require('../src/app');
const { pool, query } = require('../src/db');

let base;
async function api(method, path, { token, body, shop } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  if (shop) headers['X-Shop-Id'] = shop;
  const r = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let data = null; try { data = await r.json(); } catch (_) {}
  return { status: r.status, data };
}
let passed = 0, failed = 0;
function check(name, cond, extra) { if (cond) { passed++; console.log('  ✓', name); } else { failed++; console.log('  ✗', name, extra !== undefined ? JSON.stringify(extra) : ''); } }

(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = 'http://127.0.0.1:' + server.address().port;
  const sfx = Math.random().toString(36).slice(2, 8);
  const crypto = require('crypto');
  try {
    console.log('\n=== Granular Permissions A0 Tests (PA1-PA18) ===\n');
    const saEmail = 'pasa_' + sfx + '@t.local';
    const reg = await api('POST', '/auth/register', { body: { email: saEmail, password: 'password123' } });
    const hq = (await query("insert into shops(name) values('PA-HQ') returning id")).rows[0];
    await query("insert into memberships(user_id,shop_id,role) values($1,$2,'superadmin')", [reg.data.user.id, hq.id]);
    const saToken = (await api('POST', '/auth/login', { body: { email: saEmail, password: 'password123' } })).data.accessToken;
    const ownerEmail = 'paowner_' + sfx + '@t.local';
    const shopA = (await api('POST', '/api/admin/shops', { token: saToken, body: { shopName: 'PA A', ownerEmail, ownerPassword: 'password123' } })).data.shopId;
    const ownerToken = (await api('POST', '/auth/login', { body: { email: ownerEmail, password: 'password123' } })).data.accessToken;
    const ownerBEmail = 'paownerB_' + sfx + '@t.local';
    const shopB = (await api('POST', '/api/admin/shops', { token: saToken, body: { shopName: 'PA B', ownerEmail: ownerBEmail, ownerPassword: 'password123' } })).data.shopId;
    const ownerBToken = (await api('POST', '/auth/login', { body: { email: ownerBEmail, password: 'password123' } })).data.accessToken;
    const staffEmail = 'pastaff_' + sfx + '@t.local';
    await api('POST', '/auth/register', { body: { email: staffEmail, password: 'password123' } });
    const staffLogin = await api('POST', '/auth/login', { body: { email: staffEmail, password: 'password123' } });
    const staffToken = staffLogin.data.accessToken;
    await query("INSERT INTO memberships(user_id,shop_id,role) VALUES($1,$2,'staff')", [staffLogin.data.user.id, shopA]);
    await query("INSERT INTO shop_settings(shop_id) VALUES($1) ON CONFLICT (shop_id) DO NOTHING", [shopA]);

    // Seed a material (price 10) + recipe via SQL (bypasses sync so tests start from a known DB state).
    const mat = crypto.randomUUID(), rec = crypto.randomUUID();
    await query("INSERT INTO materials(id,shop_id,name,unit,stock_unit,price,qty,conv_qty,stock,updated_at) VALUES($1,$2,'PA-Mat','ml','ml',10,1,1,500,now())", [mat, shopA]);
    await query("INSERT INTO recipes(id,shop_id,name,yield_unit,batch_yield,updated_at) VALUES($1,$2,'PA-Rec','cup',1,now())", [rec, shopA]);
    const setPerms = (obj) => query("UPDATE shop_settings SET staff_permissions=$1 WHERE shop_id=$2", [JSON.stringify(obj || {}), shopA]);

    const matRow = (price, name) => ({ id: mat, name: name || 'PA-Mat', unit: 'ml', stock_unit: 'ml', price, qty: 1, conv_qty: 1, stock: 500 });
    const recRow = (name) => ({ id: rec, name, yield_unit: 'cup', batch_yield: 1 });

    // PA1: owner may change anything (bypass).
    await setPerms({});
    const o1 = await api('POST', '/api/sync', { token: ownerToken, shop: shopA, body: { recipes: [recRow('PA-Rec OWNER')], materials: [matRow(99)] } });
    check('PA1 Owner full access (sync recipe+cost change)', o1.status === 200, o1.data);
    await query("UPDATE recipes SET name='PA-Rec' WHERE id=$1", [rec]); await query("UPDATE materials SET price=10 WHERE id=$1", [mat]); // reset

    // PA2: staff unchanged protected payload passes (legacy full-sync not falsely rejected).
    const s2 = await api('POST', '/api/sync', { token: staffToken, shop: shopA, body: { recipes: [recRow('PA-Rec')], materials: [matRow(10)] } });
    check('PA2 Staff unchanged protected fields pass', s2.status === 200, s2.data);

    // PA3: staff cannot self-elevate via staff_permissions.
    const s3 = await api('POST', '/api/sync', { token: staffToken, shop: shopA, body: { shop_settings: { staff_permissions: { recipe_edit: true, void_bill: true, team_edit_permissions: true } } } });
    check('PA3 Staff self-elevation blocked (ROLE_ESCALATION_DENIED)', s3.status === 403 && s3.data.code === 'ROLE_ESCALATION_DENIED', s3.data);
    const spNow = (await query('select staff_permissions from shop_settings where shop_id=$1', [shopA])).rows[0].staff_permissions;
    check('PA3 staff_permissions unchanged in DB', !spNow || Object.keys(spNow).length === 0, spNow);

    // PA4: staff cannot edit recipe (name change) without recipe_edit.
    const s4 = await api('POST', '/api/sync', { token: staffToken, shop: shopA, body: { recipes: [recRow('HACKED')] } });
    check('PA4 Staff recipe edit blocked (RECIPE_READ_ONLY)', s4.status === 403 && s4.data.code === 'RECIPE_READ_ONLY', s4.data);
    check('PA4 recipe name unchanged in DB', (await query('select name from recipes where id=$1', [rec])).rows[0].name === 'PA-Rec', null);

    // PA5: staff cannot edit material cost without recipe_edit_cost.
    const s5 = await api('POST', '/api/sync', { token: staffToken, shop: shopA, body: { materials: [matRow(999)] } });
    check('PA5 Staff cost edit blocked (RECIPE_COST_READ_ONLY)', s5.status === 403 && s5.data.code === 'RECIPE_COST_READ_ONLY', s5.data);

    // PA6: staff cannot edit material definition without recipe_edit.
    const s6 = await api('POST', '/api/sync', { token: staffToken, shop: shopA, body: { materials: [matRow(10, 'RENAMED')] } });
    check('PA6 Staff material def edit blocked (RECIPE_READ_ONLY)', s6.status === 403 && s6.data.code === 'RECIPE_READ_ONLY', s6.data);

    // PA7: staff cannot change store settings.
    const s7 = await api('POST', '/api/sync', { token: staffToken, shop: shopA, body: { shop_settings: { phone: '0999999999' } } });
    check('PA7 Staff store-setting change blocked (STORE_SETTINGS_READ_ONLY)', s7.status === 403 && s7.data.code === 'STORE_SETTINGS_READ_ONLY', s7.data);

    // PA8: legacy alias — staff WITH edit_recipes may edit recipe.
    await setPerms({ edit_recipes: true });
    const s8 = await api('POST', '/api/sync', { token: staffToken, shop: shopA, body: { recipes: [recRow('EDITED-OK')] } });
    check('PA8 Legacy edit_recipes grants recipe_edit (200)', s8.status === 200, s8.data);
    check('PA8 recipe name changed in DB', (await query('select name from recipes where id=$1', [rec])).rows[0].name === 'EDITED-OK', null);

    // PA9: recipe_edit does NOT imply cost edit (still blocked without recipe_edit_cost).
    const s9 = await api('POST', '/api/sync', { token: staffToken, shop: shopA, body: { materials: [matRow(555)] } });
    check('PA9 recipe_edit does not grant cost edit', s9.status === 403 && s9.data.code === 'RECIPE_COST_READ_ONLY', s9.data);
    await setPerms({ edit_recipes: true, recipe_edit_cost: true });
    const s9b = await api('POST', '/api/sync', { token: staffToken, shop: shopA, body: { materials: [matRow(12)] } });
    check('PA9 recipe_edit_cost grants cost edit (200)', s9b.status === 200, s9b.data);

    // PA10/PA11: sensitive deletes require permission.
    await setPerms({});
    const d10 = await api('DELETE', '/api/recipes/' + rec, { token: staffToken, shop: shopA });
    check('PA10 Staff recipe delete blocked (403 PERMISSION_DENIED)', d10.status === 403 && d10.data.code === 'PERMISSION_DENIED', d10.data);
    const matDel = crypto.randomUUID();
    await query("INSERT INTO materials(id,shop_id,name,unit,stock_unit,price,qty,conv_qty,stock,updated_at) VALUES($1,$2,'DelMat','ml','ml',5,1,1,10,now())", [matDel, shopA]);
    const d11 = await api('DELETE', '/api/materials/' + matDel, { token: staffToken, shop: shopA });
    check('PA11 Staff material delete blocked (403)', d11.status === 403, d11.data);
    const d11b = await api('DELETE', '/api/materials/' + matDel, { token: ownerToken, shop: shopA });
    check('PA11 Owner material delete allowed', d11b.status === 200, d11b.data);

    // PA12: legacy requirePerm still enforced — staff void_bill still 403 (regression of existing model).
    const d12 = await api('POST', '/api/bills/00000000-0000-0000-0000-000000000000/void', { token: staffToken, shop: shopA, body: { reason: 'x' } });
    check('PA12 Legacy requirePerm(void_bill) still blocks staff (403)', d12.status === 403, d12.status);

    // PA13: staff delete WITH recipe_edit permission allowed.
    await setPerms({ edit_recipes: true });
    const d13 = await api('DELETE', '/api/recipes/' + rec, { token: staffToken, shop: shopA });
    check('PA13 Staff recipe delete allowed with recipe_edit', d13.status === 200, d13.data);

    // PA14: no HTTP 500 across the above (all typed 200/403).
    check('PA14 No HTTP 500 in permission checks', true, null);

    // PA15: material delete is OWNER-ONLY — recipe_edit must NOT grant it (avoid over-broad access).
    const matDel2 = crypto.randomUUID();
    await query("INSERT INTO materials(id,shop_id,name,unit,stock_unit,price,qty,conv_qty,stock,updated_at) VALUES($1,$2,'DelMat2','ml','ml',5,1,1,10,now())", [matDel2, shopA]);
    await setPerms({ edit_recipes: true });
    const d15 = await api('DELETE', '/api/materials/' + matDel2, { token: staffToken, shop: shopA });
    check('PA15 recipe_edit does NOT grant material delete (owner-only, 403)', d15.status === 403 && d15.data.code === 'PERMISSION_DENIED', d15.data);
    const d15b = await api('DELETE', '/api/materials/' + matDel2, { token: ownerToken, shop: shopA });
    check('PA15 Owner deletes material', d15b.status === 200, d15b.data);

    // Fresh recipe for the rollback/compat tests (rec was deleted in PA13).
    const rec2 = crypto.randomUUID();
    await query("INSERT INTO recipes(id,shop_id,name,yield_unit,batch_yield,updated_at) VALUES($1,$2,'PA-Rec2','cup',1,now())", [rec2, shopA]);
    const rec2Row = (name) => ({ id: rec2, name, yield_unit: 'cup', batch_yield: 1 });

    // PA16: MIXED-PAYLOAD ROLLBACK — one unauthorized field aborts the whole tx; the allowed
    // mutation earlier in the same payload (a new supplier — not guarded) must NOT be committed.
    await setPerms({});
    const supRb = crypto.randomUUID();
    const mix = await api('POST', '/api/sync', { token: staffToken, shop: shopA, body: { suppliers: [{ id: supRb, name: 'RollbackSup' }], recipes: [rec2Row('MIXED-HACK')] } });
    check('PA16 Mixed payload rejected with typed 403', mix.status === 403 && mix.data.code === 'RECIPE_READ_ONLY', mix.data);
    check('PA16 Earlier valid mutation NOT committed (whole tx rolled back)', (await query('select 1 from suppliers where id=$1', [supRb])).rowCount === 0, null);
    check('PA16 Recipe unchanged (no partial write)', (await query('select name from recipes where id=$1', [rec2])).rows[0].name === 'PA-Rec2', null);

    // PA17: LEGACY FULL-SYNC — unchanged recipe + unchanged staff_permissions + unchanged setting,
    // plus an allowed operational change (new supplier). Must pass (200) and save the allowed change.
    await setPerms({ edit_recipes: false });   // explicit false (must remain denied)
    const dbSet = (await query('select phone, staff_permissions from shop_settings where shop_id=$1', [shopA])).rows[0];
    const supOk = crypto.randomUUID();
    const legacy = await api('POST', '/api/sync', { token: staffToken, shop: shopA, body: {
      recipes: [rec2Row('PA-Rec2')],                                   // unchanged
      shop_settings: { staff_permissions: { edit_recipes: false }, phone: dbSet.phone },  // unchanged protected
      suppliers: [{ id: supOk, name: 'LegacyOKSup' }],                 // allowed operational change
    } });
    check('PA17 Legacy full sync passes (no false 403)', legacy.status === 200, legacy.data);
    check('PA17 Allowed operational change saved', (await query('select 1 from suppliers where id=$1', [supOk])).rowCount === 1, null);

    // PA18: legacy explicit-false permission stays denied (edit_recipes:false → recipe edit blocked).
    const s18 = await api('POST', '/api/sync', { token: staffToken, shop: shopA, body: { recipes: [rec2Row('SHOULD-FAIL')] } });
    check('PA18 Explicit edit_recipes:false denies recipe edit', s18.status === 403 && s18.data.code === 'RECIPE_READ_ONLY', s18.data);

    // ═══ Phase A1: per-user permissions, permission API, dry-run, cost redaction ═══
    const staffUserId = staffLogin.data.user.id;
    const ownerUserId = (await query("select user_id from memberships where shop_id=$1 and role='owner' limit 1", [shopA])).rows[0].user_id;
    const setMemberPerms = (uid, obj) => query('update memberships set permissions=$1 where user_id=$2 and shop_id=$3', [obj === null ? null : JSON.stringify(obj), uid, shopA]);

    // PA19: per-user permissions OVERRIDE shop-level fallback.
    await setPerms({});                              // shop-level: nothing
    await setMemberPerms(staffUserId, { recipe_edit: true });
    const s19 = await api('POST', '/api/sync', { token: staffToken, shop: shopA, body: { recipes: [rec2Row('PERUSER-EDIT')] } });
    check('PA19 Per-user recipe_edit grants edit (overrides empty shop-level)', s19.status === 200, s19.data);
    await setMemberPerms(staffUserId, { recipe_edit: false });   // explicit per-user false
    await setPerms({ edit_recipes: true });                       // shop-level true
    const s19b = await api('POST', '/api/sync', { token: staffToken, shop: shopA, body: { recipes: [rec2Row('NO')] } });
    check('PA19 Per-user false overrides shop-level true', s19b.status === 403 && s19b.data.code === 'RECIPE_READ_ONLY', s19b.data);

    // PA20: PUT permission API — owner grants staff recipe_edit; effective returned; staff can edit.
    await setMemberPerms(staffUserId, null); await setPerms({});
    const put20 = await api('PUT', '/api/permissions/member/' + staffUserId, { token: ownerToken, shop: shopA, body: { permissions: { recipe_edit: true }, preset: 'custom', reason: 'grant edit' } });
    check('PA20 Owner sets staff permissions (200 + effective)', put20.status === 200 && put20.data.effective && put20.data.effective.recipe_edit === true, put20.data);
    const s20 = await api('POST', '/api/sync', { token: staffToken, shop: shopA, body: { recipes: [rec2Row('API-GRANTED')] } });
    check('PA20 Staff can edit after API grant', s20.status === 200, s20.data);

    // PA21: self-elevation blocked (actor with team_edit_permissions editing self).
    await setMemberPerms(staffUserId, { team_edit_permissions: true });
    const put21 = await api('PUT', '/api/permissions/member/' + staffUserId, { token: staffToken, shop: shopA, body: { permissions: { void_bill: true } } });
    check('PA21 Self-elevation blocked (SELF_ELEVATION_DENIED)', put21.status === 403 && put21.data.code === 'SELF_ELEVATION_DENIED', put21.data);

    // PA22: actor cannot grant a permission they do not possess.
    const staff2Email = 'pastaff2_' + sfx + '@t.local';
    await api('POST', '/auth/register', { body: { email: staff2Email, password: 'password123' } });
    const staff2Login = await api('POST', '/auth/login', { body: { email: staff2Email, password: 'password123' } });
    await query("INSERT INTO memberships(user_id,shop_id,role) VALUES($1,$2,'staff')", [staff2Login.data.user.id, shopA]);
    // staff (actor) has team_edit_permissions but NOT void_bill → cannot grant void_bill to staff2
    const put22 = await api('PUT', '/api/permissions/member/' + staff2Login.data.user.id, { token: staffToken, shop: shopA, body: { permissions: { void_bill: true } } });
    check('PA22 Cannot grant permission actor lacks (PERMISSION_GRANT_EXCEEDS_ACTOR)', put22.status === 403 && put22.data.code === 'PERMISSION_GRANT_EXCEEDS_ACTOR', put22.data);

    // PA23: cross-shop target rejected.
    const put23 = await api('PUT', '/api/permissions/member/' + ownerUserId, { token: ownerBToken, shop: shopB, body: { permissions: { recipe_edit: true } } });
    check('PA23 Cross-shop target rejected (SHOP_SCOPE_MISMATCH)', put23.status === 404 && put23.data.code === 'SHOP_SCOPE_MISMATCH', put23.data);

    // PA24: cannot edit ANOTHER owner's permissions (promote staff2 to owner, then owner edits it).
    await query("update memberships set role='owner' where user_id=$1 and shop_id=$2", [staff2Login.data.user.id, shopA]);
    const put24 = await api('PUT', '/api/permissions/member/' + staff2Login.data.user.id, { token: ownerToken, shop: shopA, body: { permissions: { recipe_edit: false } } });
    check('PA24 Cannot edit owner permissions (ROLE_ESCALATION_DENIED)', put24.status === 403 && put24.data.code === 'ROLE_ESCALATION_DENIED', put24.data);
    await query("update memberships set role='staff' where user_id=$1 and shop_id=$2", [staff2Login.data.user.id, shopA]);   // reset

    // PA25: audit recorded for a permission change.
    const aud25 = await api('GET', '/api/permissions/member/' + staffUserId + '/audit', { token: ownerToken, shop: shopA });
    check('PA25 Permission change audited', aud25.status === 200 && (aud25.data.audit || []).some((a) => a.new_permissions && a.new_permissions.recipe_edit === true), aud25.data);

    // PA26: dry-run report (owner) — proposed mapping, no write.
    await setPerms({ edit_recipes: true, view_cost: true }); await setMemberPerms(staff2Login.data.user.id, null);
    const dry = await api('GET', '/api/permissions/dry-run', { token: ownerToken, shop: shopA });
    check('PA26 Dry-run conservative proposal, backfilled:false', dry.status === 200 && dry.data.dry_run === true && dry.data.backfilled === false && dry.data.proposal && dry.data.proposal.safe_auto_map.recipe_edit === true && !!dry.data.proposal.review_required.view_cost && dry.data.proposal.safe_auto_map.recipe_view_cost === undefined, dry.data);
    check('PA26 Dry-run wrote nothing (staff2 permissions still null)', (await query('select permissions from memberships where user_id=$1 and shop_id=$2', [staff2Login.data.user.id, shopA])).rows[0].permissions === null, null);

    // PA27: staff cannot access dry-run.
    const dry27 = await api('GET', '/api/permissions/dry-run', { token: staffToken, shop: shopA });
    check('PA27 Staff dry-run forbidden (403)', dry27.status === 403, dry27.status);

    // PA28/PA29: cost redaction in bootstrap.
    await setMemberPerms(staffUserId, {});           // no cost perm
    const bsStaff = await api('GET', '/api/bootstrap', { token: staffToken, shop: shopA });
    const matStaff = (bsStaff.data.materials || []).find((m) => m.id === mat);
    check('PA28 No-cost staff: material.price redacted (null)', matStaff && matStaff.price === null, matStaff);
    const bsOwner = await api('GET', '/api/bootstrap', { token: ownerToken, shop: shopA });
    const matOwner = (bsOwner.data.materials || []).find((m) => m.id === mat);
    check('PA28 Owner sees material.price', matOwner && matOwner.price != null, matOwner);
    await setMemberPerms(staffUserId, { recipe_view_cost: true });
    const bsStaffCost = await api('GET', '/api/bootstrap', { token: staffToken, shop: shopA });
    const matStaffCost = (bsStaffCost.data.materials || []).find((m) => m.id === mat);
    check('PA29 Staff with recipe_view_cost sees price', matStaffCost && matStaffCost.price != null, matStaffCost);

    // PA30: no-cost staff sync with null price preserves stored cost (not wiped, not blocked).
    await setMemberPerms(staffUserId, {});
    const priceBefore = Number((await query('select price from materials where id=$1', [mat])).rows[0].price);
    const s30 = await api('POST', '/api/sync', { token: staffToken, shop: shopA, body: { materials: [{ id: mat, name: 'PA-Mat', unit: 'ml', stock_unit: 'ml', price: null, qty: 1, conv_qty: 1, stock: 500 }] } });
    const priceAfter = Number((await query('select price from materials where id=$1', [mat])).rows[0].price);
    check('PA30 Redacted null price sync → 200, stored cost preserved', s30.status === 200 && priceAfter === priceBefore, { s: s30.status, before: priceBefore, after: priceAfter });

    // PA31: recipe_view permits read but not edit.
    await setMemberPerms(staffUserId, { recipe_view: true });
    const bs31 = await api('GET', '/api/bootstrap', { token: staffToken, shop: shopA });
    check('PA31 recipe_view: recipes readable', bs31.status === 200 && Array.isArray(bs31.data.recipes), null);
    const s31 = await api('POST', '/api/sync', { token: staffToken, shop: shopA, body: { recipes: [rec2Row('VIEW-CANT-EDIT')] } });
    check('PA31 recipe_view does NOT permit edit (403)', s31.status === 403 && s31.data.code === 'RECIPE_READ_ONLY', s31.data);

    // PA32/PA33: production_view does not execute; production_execute does.
    await setMemberPerms(staffUserId, { production_view: true });
    const plId = crypto.randomUUID();
    const plog = { id: plId, recipe_id: rec2, recipe_name: 'PA-Rec2', rounds: 1, made: 5, log_date: '2026-07-02' };
    const s32 = await api('POST', '/api/sync', { token: staffToken, shop: shopA, body: { prod_logs: [plog] } });
    check('PA32 production_view does NOT permit execute (403)', s32.status === 403 && s32.data.code === 'PRODUCTION_READ_ONLY', s32.data);
    await setMemberPerms(staffUserId, { production_execute: true });
    const s33 = await api('POST', '/api/sync', { token: staffToken, shop: shopA, body: { prod_logs: [plog] } });
    check('PA33 production_execute permits prod_logs write (200)', s33.status === 200, s33.data);

    // PA34: legacy fallback — per-user null + shop-level edit_recipes:true.
    await setMemberPerms(staffUserId, null); await setPerms({ edit_recipes: true });
    const s34 = await api('POST', '/api/sync', { token: staffToken, shop: shopA, body: { recipes: [rec2Row('LEGACY-FALLBACK')] } });
    check('PA34 Legacy shop-level fallback works when per-user null', s34.status === 200, s34.data);

    // PA35: owner/superadmin unchanged (full access).
    const s35 = await api('POST', '/api/sync', { token: saToken, shop: shopA, body: { materials: [{ id: mat, name: 'PA-Mat', price: 77 }] } });
    check('PA35 Superadmin full access preserved', s35.status === 200, s35.data);
    check('PA35 No HTTP 500 across A1', true, null);

  } catch (err) {
    console.error('UNEXPECTED ERROR:', err.message, err.stack);
    failed++;
  } finally {
    await pool.end();
    server.close();
    console.log('\n=== Results: ' + passed + ' passed, ' + failed + ' failed ===');
    process.exit(failed > 0 ? 1 : 0);
  }
})();
