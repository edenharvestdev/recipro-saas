// Permission mapping safety — Founder-revised conservative dry-run proposal (fix/permission-mapping-safety-p1).
// Runs against real local Postgres. node test/permission-mapping.test.js
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
  try {
    console.log('\n=== Permission Mapping Safety Tests (PM1-PM12) ===\n');
    const saEmail = 'pmsa_' + sfx + '@t.local';
    const reg = await api('POST', '/auth/register', { body: { email: saEmail, password: 'password123' } });
    const hq = (await query("insert into shops(name) values('PM-HQ') returning id")).rows[0];
    await query("insert into memberships(user_id,shop_id,role) values($1,$2,'superadmin')", [reg.data.user.id, hq.id]);
    const saToken = (await api('POST', '/auth/login', { body: { email: saEmail, password: 'password123' } })).data.accessToken;
    const ownerEmail = 'pmowner_' + sfx + '@t.local';
    const shopA = (await api('POST', '/api/admin/shops', { token: saToken, body: { shopName: 'PM A', ownerEmail, ownerPassword: 'password123' } })).data.shopId;
    const ownerToken = (await api('POST', '/auth/login', { body: { email: ownerEmail, password: 'password123' } })).data.accessToken;
    const staffEmail = 'pmstaff_' + sfx + '@t.local';
    await api('POST', '/auth/register', { body: { email: staffEmail, password: 'password123' } });
    const staffLogin = await api('POST', '/auth/login', { body: { email: staffEmail, password: 'password123' } });
    await query("INSERT INTO memberships(user_id,shop_id,role) VALUES($1,$2,'staff')", [staffLogin.data.user.id, shopA]);
    // Legacy shop-level permissions covering all the revised cases.
    await query("INSERT INTO shop_settings(shop_id, staff_permissions) VALUES($1,$2) ON CONFLICT (shop_id) DO UPDATE SET staff_permissions=$2",
      [shopA, JSON.stringify({ discount: true, edit_recipes: true, stock_receive: true, view_cost: true, void: true, petty_cash: true, delivery_entry: true })]);

    // baseline for no-write assertions
    const permCountBefore = (await query('select count(*)::int c from memberships where shop_id=$1 and permissions is not null', [shopA])).rows[0].c;
    const auditCountBefore = (await query('select count(*)::int c from permission_audit_log where shop_id=$1', [shopA])).rows[0].c;

    const dry = await api('GET', '/api/permissions/dry-run', { token: ownerToken, shop: shopA });
    const P = dry.data.proposal;
    check('PM0 dry-run 200 + backfilled:false', dry.status === 200 && dry.data.backfilled === false && dry.data.dry_run === true, dry.data);

    // PM1: stock_receive does NOT grant stock_produce
    check('PM1 stock_receive → stock_receive only (no stock_produce)', P.safe_auto_map.stock_receive === true && P.safe_auto_map.stock_produce === undefined, P.safe_auto_map);
    // PM2: stock_receive does NOT grant production_execute
    check('PM2 stock_receive does not grant production_execute', P.safe_auto_map.production_execute === undefined, P.safe_auto_map);
    // PM3: edit_recipes does NOT grant recipe_create by default (it is REVIEW_REQUIRED)
    check('PM3 edit_recipes → recipe_edit only; recipe_create not auto', P.safe_auto_map.recipe_edit === true && P.safe_auto_map.recipe_create === undefined && !!P.review_required.edit_recipes && P.review_required.edit_recipes.proposed_keys.includes('recipe_create'), { safe: P.safe_auto_map.recipe_create, review: P.review_required.edit_recipes });
    // PM4: edit_recipes does NOT grant any cost permission
    check('PM4 edit_recipes grants no cost permission', P.safe_auto_map.recipe_edit_cost === undefined && P.safe_auto_map.recipe_view_cost === undefined, P.safe_auto_map);
    // PM5: orphan pos_void is NOT emitted; void maps to legacy 'void'
    const emitsPosVoid = JSON.stringify(P.safe_auto_map).includes('pos_void') || JSON.stringify(P.review_required).includes('pos_void');
    check('PM5 orphan pos_void not emitted; void→void', !emitsPosVoid && P.safe_auto_map.void === true && P.deprecated_orphan.some((o) => o.key === 'pos_void'), { emitsPosVoid, void: P.safe_auto_map.void, orphan: P.deprecated_orphan });
    // PM6: view_cost is REVIEW_REQUIRED (not auto-mapped)
    check('PM6 view_cost is REVIEW_REQUIRED (not in safe_auto_map)', !!P.review_required.view_cost && P.cost_review.length === 5 && P.safe_auto_map.recipe_view_cost === undefined && P.safe_auto_map.pos_view_cost === undefined, { review: P.review_required.view_cost, cost: P.cost_review });
    // PM7: petty_cash remains legacy-compatible (unmapped, future key noted)
    check('PM7 petty_cash unmapped + petty_cash_manage proposed', P.unmapped_legacy.some((u) => u.key === 'petty_cash' && /petty_cash_manage/.test(u.note)), P.unmapped_legacy);
    // PM8: dry-run wrote NO memberships
    const permCountAfter = (await query('select count(*)::int c from memberships where shop_id=$1 and permissions is not null', [shopA])).rows[0].c;
    check('PM8 dry-run wrote no memberships.permissions', permCountAfter === permCountBefore && permCountAfter === 0, { before: permCountBefore, after: permCountAfter });
    // PM9: dry-run wrote NO audit rows
    const auditCountAfter = (await query('select count(*)::int c from permission_audit_log where shop_id=$1', [shopA])).rows[0].c;
    check('PM9 dry-run wrote no audit rows', auditCountAfter === auditCountBefore, { before: auditCountBefore, after: auditCountAfter });
    // PM10: backfilled remains false
    check('PM10 backfilled:false', dry.data.backfilled === false, dry.data.backfilled);
    // PM11: safe maps are pure preservation (no POTENTIAL_ACCESS_GAIN)
    check('PM11 no unintended access gain', Array.isArray(P.potential_access_gain) && P.potential_access_gain.length === 0, P.potential_access_gain);
    // PM12: runtime enforcement UNCHANGED — legacy edit_recipes still grants recipe_edit (definition,
    // no cost) via the sync guard; a definition-only material create (no price) succeeds.
    const s12 = await api('POST', '/api/sync', { token: staffLogin.data.accessToken, shop: shopA, body: { materials: [{ id: require('crypto').randomUUID(), name: 'PM-def', unit: 'ml', stock_unit: 'ml' }] } });
    check('PM12 runtime legacy edit_recipes → recipe_edit (definition create) intact → 200', s12.status === 200, s12.data);
    // PM12b: but legacy edit_recipes does NOT grant cost — a material WITH a price still needs recipe_edit_cost.
    const s12b = await api('POST', '/api/sync', { token: staffLogin.data.accessToken, shop: shopA, body: { materials: [{ id: require('crypto').randomUUID(), name: 'PM-cost', unit: 'ml', stock_unit: 'ml', price: 9 }] } });
    check('PM12b legacy edit_recipes still ≠ cost (material with price → 403)', s12b.status === 403 && s12b.data.code === 'RECIPE_COST_READ_ONLY', s12b.data);

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
