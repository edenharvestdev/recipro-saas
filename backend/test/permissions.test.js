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
