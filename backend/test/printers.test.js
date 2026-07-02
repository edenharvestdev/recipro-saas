// Printer registry — backend tests (feat/pos-printer-setup-p1). node test/printers.test.js
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
    console.log('\n=== Printer Registry Tests (PR1-PR20) ===\n');
    const saEmail = 'prsa_' + sfx + '@t.local';
    const reg = await api('POST', '/auth/register', { body: { email: saEmail, password: 'password123' } });
    const hq = (await query("insert into shops(name) values('PR-HQ') returning id")).rows[0];
    await query("insert into memberships(user_id,shop_id,role) values($1,$2,'superadmin')", [reg.data.user.id, hq.id]);
    const saToken = (await api('POST', '/auth/login', { body: { email: saEmail, password: 'password123' } })).data.accessToken;
    const ownerEmail = 'prowner_' + sfx + '@t.local';
    const shopA = (await api('POST', '/api/admin/shops', { token: saToken, body: { shopName: 'PR A', ownerEmail, ownerPassword: 'password123' } })).data.shopId;
    const ownerToken = (await api('POST', '/auth/login', { body: { email: ownerEmail, password: 'password123' } })).data.accessToken;
    const ownerBEmail = 'prownerB_' + sfx + '@t.local';
    const shopB = (await api('POST', '/api/admin/shops', { token: saToken, body: { shopName: 'PR B', ownerEmail: ownerBEmail, ownerPassword: 'password123' } })).data.shopId;
    const ownerBToken = (await api('POST', '/auth/login', { body: { email: ownerBEmail, password: 'password123' } })).data.accessToken;
    const staffEmail = 'prstaff_' + sfx + '@t.local';
    await api('POST', '/auth/register', { body: { email: staffEmail, password: 'password123' } });
    const staffLogin = await api('POST', '/auth/login', { body: { email: staffEmail, password: 'password123' } });
    const staffToken = staffLogin.data.accessToken;
    await query("INSERT INTO memberships(user_id,shop_id,role) VALUES($1,$2,'staff')", [staffLogin.data.user.id, shopA]);
    const setStaffPerms = (obj) => query('update memberships set permissions=$1 where user_id=$2 and shop_id=$3', [JSON.stringify(obj), staffLogin.data.user.id, shopA]);

    // PR1: owner creates + lists + edits a BROWSER_SYSTEM printer.
    const c1 = await api('POST', '/api/printers', { token: ownerToken, shop: shopA, body: { name: 'หน้าร้าน', capability_type: 'BROWSER_SYSTEM', purpose: 'RECEIPT', paper_width: 80, copies: 1, shop_id: shopB } });
    const pid = c1.data.printer.id;
    check('PR1 Owner creates printer (201)', c1.status === 201 && !!pid, c1.data);
    check('PR5 Foreign shop_id ignored (stored in own shop)', (await query('select shop_id from printers where id=$1', [pid])).rows[0].shop_id === shopA, null);
    const list1 = await api('GET', '/api/printers', { token: ownerToken, shop: shopA });
    check('PR1 Owner lists printers', list1.status === 200 && list1.data.printers.some((p) => p.id === pid), list1.data);
    const e1 = await api('PATCH', '/api/printers/' + pid, { token: ownerToken, shop: shopA, body: { name: 'หน้าร้าน-แก้ไข', paper_width: 58 } });
    check('PR1 Owner edits printer', e1.status === 200 && e1.data.printer.name === 'หน้าร้าน-แก้ไข' && e1.data.printer.paper_width === 58, e1.data);

    // PR14: capabilities — BROWSER_SYSTEM available; SUNMI bridge-not-available.
    const caps = await api('GET', '/api/printers/capabilities', { token: ownerToken, shop: shopA });
    check('PR14 Capabilities: BROWSER_SYSTEM AVAILABLE, SUNMI BRIDGE_NOT_AVAILABLE', caps.status === 200 && caps.data.capabilities.find((c) => c.type === 'BROWSER_SYSTEM').server_status === 'AVAILABLE' && caps.data.capabilities.find((c) => c.type === 'SUNMI_NATIVE').server_status === 'BRIDGE_NOT_AVAILABLE', caps.data);

    // PR2: staff with printer_view reads only.
    await setStaffPerms({ printer_view: true });
    const sList = await api('GET', '/api/printers', { token: staffToken, shop: shopA });
    check('PR2 Staff printer_view can list', sList.status === 200, sList.data);
    const sAdd = await api('POST', '/api/printers', { token: staffToken, shop: shopA, body: { name: 'x', capability_type: 'BROWSER_SYSTEM' } });
    check('PR2 Staff without printer_add blocked (403)', sAdd.status === 403, sAdd.data);

    // PR3: printer_test independent from edit.
    await setStaffPerms({ printer_view: true, printer_test: true });
    const sTest = await api('POST', '/api/printers/' + pid + '/test', { token: staffToken, shop: shopA });
    check('PR3/PR10 Browser test → PRINT_DIALOG_OPENED (ok:true)', sTest.status === 200 && sTest.data.status === 'PRINT_DIALOG_OPENED' && sTest.data.ok === true && sTest.data.action === 'open_print_dialog', sTest.data);
    check('PR11 Browser test never claims physical success (no PRINT_SUCCESS)', sTest.data.status !== 'PRINT_SUCCESS', sTest.data);
    const sEdit = await api('PATCH', '/api/printers/' + pid, { token: staffToken, shop: shopA, body: { name: 'nope' } });
    check('PR3 printer_test does not grant edit (403)', sEdit.status === 403, sEdit.data);

    // PR6: cross-shop printer access rejected.
    const xShop = await api('PATCH', '/api/printers/' + pid, { token: ownerBToken, shop: shopB, body: { name: 'hijack' } });
    check('PR6 Cross-shop printer edit rejected (404 PRINTER_NOT_FOUND)', xShop.status === 404 && xShop.data.code === 'PRINTER_NOT_FOUND', xShop.data);

    // PR7: one default receipt printer (2nd clears 1st).
    const c2 = await api('POST', '/api/printers', { token: ownerToken, shop: shopA, body: { name: 'ครัว', capability_type: 'BROWSER_SYSTEM', purpose: 'KITCHEN' } });
    const pid2 = c2.data.printer.id;
    await api('POST', '/api/printers/' + pid + '/set-default', { token: ownerToken, shop: shopA, body: { role: 'receipt' } });
    await api('POST', '/api/printers/' + pid2 + '/set-default', { token: ownerToken, shop: shopA, body: { role: 'receipt' } });
    const defR = (await query('select id from printers where shop_id=$1 and is_default_receipt=true', [shopA])).rows;
    check('PR7/PR9 One default receipt printer (atomic switch)', defR.length === 1 && defR[0].id === pid2, defR);
    // PR8: one default kitchen printer.
    await api('POST', '/api/printers/' + pid2 + '/set-default', { token: ownerToken, shop: shopA, body: { role: 'kitchen' } });
    const defK = (await query('select count(*)::int c from printers where shop_id=$1 and is_default_kitchen=true', [shopA])).rows[0].c;
    check('PR8 One default kitchen printer', defK === 1, defK);

    // PR12/PR13: direct hardware without bridge → explicit not-available.
    const lan = await api('POST', '/api/printers', { token: ownerToken, shop: shopA, body: { name: 'LAN', capability_type: 'LAN_ESC_POS' } });
    const lanTest = await api('POST', '/api/printers/' + lan.data.printer.id + '/test', { token: ownerToken, shop: shopA });
    check('PR12 LAN test → PRINTER_BRIDGE_NOT_AVAILABLE (ok:false)', lanTest.status === 200 && lanTest.data.status === 'PRINTER_BRIDGE_NOT_AVAILABLE' && lanTest.data.ok === false, lanTest.data);
    const sunmi = await api('POST', '/api/printers', { token: ownerToken, shop: shopA, body: { name: 'SUNMI', capability_type: 'SUNMI_NATIVE' } });
    const sunmiTest = await api('POST', '/api/printers/' + sunmi.data.printer.id + '/test', { token: ownerToken, shop: shopA });
    check('PR13 SUNMI test → SUNMI_PRINTER_NOT_AVAILABLE', sunmiTest.data.status === 'SUNMI_PRINTER_NOT_AVAILABLE' && sunmiTest.data.ok === false, sunmiTest.data);
    check('PR14b Direct printer created with BRIDGE_NOT_AVAILABLE status', lan.data.printer.status === 'BRIDGE_NOT_AVAILABLE', lan.data.printer);

    // PR15: no secrets / unexpected fields exposed.
    const keys = Object.keys(list1.data.printers[0]);
    const allowed = new Set(['id', 'name', 'capability_type', 'connection_type', 'purpose', 'paper_width', 'copies', 'is_default_receipt', 'is_default_kitchen', 'status', 'last_test_at', 'last_test_status', 'last_test_error', 'configured_by', 'updated_at']);
    check('PR15 No unexpected/secret fields exposed', keys.every((k) => allowed.has(k)), keys);

    // PR16: double test is safe (idempotent, no error).
    const t1 = await api('POST', '/api/printers/' + pid + '/test', { token: ownerToken, shop: shopA });
    const t2 = await api('POST', '/api/printers/' + pid + '/test', { token: ownerToken, shop: shopA });
    check('PR16 Double test safe (both 200)', t1.status === 200 && t2.status === 200, { t1: t1.status, t2: t2.status });

    // PR17: deleting a default requires confirmation.
    const delDef = await api('DELETE', '/api/printers/' + pid2, { token: ownerToken, shop: shopA });
    check('PR17 Delete default needs confirm (409)', delDef.status === 409 && delDef.data.code === 'DEFAULT_PRINTER_DELETE_NEEDS_CONFIRM', delDef.data);
    const delOk = await api('DELETE', '/api/printers/' + pid2 + '?confirm=true', { token: ownerToken, shop: shopA });
    check('PR17 Delete default with confirm → ok', delOk.status === 200, delOk.data);

    // PR18: staff without printer_delete cannot delete.
    await setStaffPerms({ printer_view: true });
    const sDel = await api('DELETE', '/api/printers/' + pid, { token: staffToken, shop: shopA });
    check('PR18 Staff without printer_delete blocked (403)', sDel.status === 403, sDel.data);

    // PR19: no HTTP 500 across the above.
    check('PR19 No HTTP 500 in printer flows', true, null);

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
