// ทดสอบ end-to-end ของ API จริง (ต่อ Postgres จริง) — node test/integration.js
require('dotenv').config();
const app = require('../src/app');
const { pool, query } = require('../src/db');

let base;
async function api(method, path, { token, body, shop } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  if (shop) headers['X-Shop-Id'] = shop;
  const r = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let data = null;
  try { data = await r.json(); } catch (_) {}
  return { status: r.status, data };
}

let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log('  ✓', name); }
  else { failed++; console.log('  ✗', name); }
}

(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = 'http://127.0.0.1:' + server.address().port;
  const sfx = Math.random().toString(36).slice(2, 8);

  try {
    // --- auth: register superadmin then promote ---
    const saEmail = `sa_${sfx}@test.local`;
    const reg = await api('POST', '/auth/register', { body: { email: saEmail, password: 'password123' } });
    check('register returns tokens', reg.status === 200 && !!reg.data.accessToken);
    const saUserId = reg.data.user.id;
    const hq = (await query("insert into shops (name) values ('HQ') returning id")).rows[0];
    await query("insert into memberships (user_id, shop_id, role) values ($1,$2,'superadmin')", [saUserId, hq.id]);

    const saLogin = await api('POST', '/auth/login', { body: { email: saEmail, password: 'password123' } });
    const saToken = saLogin.data.accessToken;
    check('login ok + superadmin membership', saLogin.status === 200 && saLogin.data.memberships.some((m) => m.role === 'superadmin'));
    check('login wrong password rejected', (await api('POST', '/auth/login', { body: { email: saEmail, password: 'nope' } })).status === 401);

    // --- superadmin creates shop + owner ---
    const ownerEmail = `owner_${sfx}@test.local`;
    const created = await api('POST', '/api/admin/shops', { token: saToken, body: { shopName: 'ร้านทดสอบ A', ownerEmail, ownerPassword: 'password123' } });
    check('admin creates shop+owner', created.status === 200 && created.data.success);
    const shopA = created.data.shopId;

    // --- owner login + access ---
    const ownerLogin = await api('POST', '/auth/login', { body: { email: ownerEmail, password: 'password123' } });
    const ownerToken = ownerLogin.data.accessToken;
    check('owner is member of shop A', ownerLogin.data.memberships[0].shop_id === shopA);
    check('owner blocked from /api/admin (403)', (await api('GET', '/api/admin/shops', { token: ownerToken })).status === 403);
    check('no token -> 401', (await api('GET', '/api/bootstrap', {})).status === 401);

    // --- bootstrap empty, then sync, then bootstrap full ---
    const boot1 = await api('GET', '/api/bootstrap', { token: ownerToken });
    check('bootstrap shows shop A, empty data', boot1.data.shop.id === shopA && boot1.data.materials.length === 0);

    const supId = crypto.randomUUID(), matId = crypto.randomUUID(), recId = crypto.randomUUID(), billId = crypto.randomUUID();
    const sync = await api('POST', '/api/sync', { token: ownerToken, body: {
      suppliers: [{ id: supId, name: 'แม็คโคร', note: '' }],
      materials: [{ id: matId, name: 'แป้ง', qty: 1, unit: 'กิโลกรัม', price: 30, supplier_id: supId, order_url: '', stock: 5, low_stock: 1 }],
      recipes: [{ id: recId, code: 'R01', name: 'ครัวซอง', sell_price: 50, batch_yield: 10, yield_unit: 'ชิ้น', is_raw: false, steps: 'อบ', fg_stock: 0, fg_low: 0 }],
      recipe_items: [{ recipe_id: recId, material_id: matId, amount: 0.1 }],
      bills: [{ id: billId, number: 'HB-001', status: 'wait', items_json: { items: [], date: '2026-06-16' } }],
      shop_settings: { phone: '0812345678', theme: 'rose' },
      shop: { name: 'ร้านทดสอบ A' },
    } });
    check('sync ok', sync.status === 200 && sync.data.ok);

    const boot2 = await api('GET', '/api/bootstrap', { token: ownerToken });
    check('material persisted', boot2.data.materials.length === 1 && boot2.data.materials[0].name === 'แป้ง');
    check('recipe_item persisted', boot2.data.recipe_items.length === 1 && Number(boot2.data.recipe_items[0].amount) === 0.1);
    check('bill jsonb persisted', boot2.data.bills[0].items_json.date === '2026-06-16');
    check('settings persisted', boot2.data.settings.phone === '0812345678');

    // re-sync (idempotent upsert, no duplicate recipe_items)
    await api('POST', '/api/sync', { token: ownerToken, body: { recipes: [{ id: recId, code: 'R01', name: 'ครัวซอง2', sell_price: 55, batch_yield: 10, yield_unit: 'ชิ้น', is_raw: false, steps: 'อบ', fg_stock: 0, fg_low: 0 }], recipe_items: [{ recipe_id: recId, material_id: matId, amount: 0.2 }] } });
    const boot3 = await api('GET', '/api/bootstrap', { token: ownerToken });
    check('re-sync updates not duplicates', boot3.data.recipe_items.length === 1 && Number(boot3.data.recipe_items[0].amount) === 0.2 && boot3.data.recipes[0].name === 'ครัวซอง2');

    // --- tenant isolation ---
    const ownerBEmail = `ownerb_${sfx}@test.local`;
    const createdB = await api('POST', '/api/admin/shops', { token: saToken, body: { shopName: 'ร้านทดสอบ B', ownerEmail: ownerBEmail, ownerPassword: 'password123' } });
    const ownerBLogin = await api('POST', '/auth/login', { body: { email: ownerBEmail, password: 'password123' } });
    const bootB = await api('GET', '/api/bootstrap', { token: ownerBLogin.data.accessToken });
    check('shop B isolated (0 materials)', bootB.data.materials.length === 0);
    const spoof = await api('GET', '/api/bootstrap', { token: ownerToken, shop: createdB.data.shopId });
    check('owner A cannot spoof X-Shop-Id to shop B', spoof.data.shop.id === shopA);

    // --- dashboard + plans + billing guard ---
    const dash = await api('GET', '/api/admin/dashboard', { token: saToken });
    check('dashboard returns arrays', dash.status === 200 && dash.data.shops.length >= 2);
    const plans = await api('GET', '/api/plans', { token: ownerToken });
    check('plans available', plans.data.plans.length >= 1);
    const checkout = await api('POST', '/api/billing/checkout', { token: ownerToken, body: { planId: plans.data.plans[0].id, billingCycle: 'month', omiseToken: 'tokn_test' } });
    check('checkout without Omise keys -> 503', checkout.status === 503);
  } catch (e) {
    console.error('TEST ERROR', e);
    failed++;
  } finally {
    server.close();
    await pool.end();
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  }
})();
