// Delivery Release A â€” Integration Tests
// Runs against real local Postgres. node test/delivery.test.js
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const app = require('../src/app');
const { pool, query } = require('../src/db');

let base;
async function api(method, path, { token, body, shop } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  if (shop) headers['X-Shop-Id'] = shop;
  const r = await fetch(base + path, {
    method, headers, body: body ? JSON.stringify(body) : undefined
  });
  let data = null;
  try { data = await r.json(); } catch (_) {}
  return { status: r.status, data };
}

let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log('  âœ“', name); }
  else { failed++; console.log('  âœ—', name, extra || ''); }
}

// Count movement links by operation_type for a batch
async function countLinks(batchId, type) {
  const sql = type
    ? 'SELECT count(*)::int as n FROM delivery_batch_stock_movements WHERE batch_id=$1 AND operation_type=$2'
    : 'SELECT count(*)::int as n FROM delivery_batch_stock_movements WHERE batch_id=$1';
  const args = type ? [batchId, type] : [batchId];
  const r = await query(sql, args);
  return r.rows[0].n;
}

(async () => {
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  base = 'http://127.0.0.1:' + server.address().port;
  const sfx = Math.random().toString(36).slice(2, 8);

  try {
    // â”€â”€â”€ Setup â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const saEmail = 'sa_' + sfx + '@test.local';
    const reg = await api('POST', '/auth/register', { body: { email: saEmail, password: 'password123' } });
    const saUserId = reg.data.user.id;
    const hq = (await query("insert into shops(name) values('HQ') returning id")).rows[0];
    await query("insert into memberships(user_id,shop_id,role) values($1,$2,'superadmin')", [saUserId, hq.id]);
    const saLogin = await api('POST', '/auth/login', { body: { email: saEmail, password: 'password123' } });
    const saToken = saLogin.data.accessToken;

    // Shop A
    const ownerEmail = 'owner_' + sfx + '@test.local';
    const created = await api('POST', '/api/admin/shops', {
      token: saToken,
      body: { shopName: 'Delivery Test Shop', ownerEmail, ownerPassword: 'password123' }
    });
    const shopA = created.data.shopId;
    const ownerLogin = await api('POST', '/auth/login', { body: { email: ownerEmail, password: 'password123' } });
    const ownerToken = ownerLogin.data.accessToken;

    // Materials + recipes
    const matId = crypto.randomUUID();
    const recId = crypto.randomUUID();
    const recipeId2 = crypto.randomUUID();
    const matId2 = crypto.randomUUID();
    await api('POST', '/api/sync', { token: ownerToken, shop: shopA, body: {
      materials: [
        { id: matId, name: 'Milk', unit: 'ml', stock: 1000, sku: 'MILK01', updatedAt: new Date().toISOString() },
        { id: matId2, name: 'Espresso', unit: 'ml', stock: 500, sku: 'ESP01', updatedAt: new Date().toISOString() }
      ],
      recipes: [
        { id: recId, name: 'Matcha Latte', yield_unit: 'cup', fg_stock: 10, inventory_mode: 'finished_goods', updatedAt: new Date().toISOString() },
        { id: recipeId2, name: 'Americano', yield_unit: 'cup', fg_stock: 0, inventory_mode: 'make_to_order', updatedAt: new Date().toISOString() }
      ],
      recipe_items: [{ recipe_id: recipeId2, material_id: matId2, amount: 30, role: null }],
      bills: [], expenses: [], suppliers: []
    }});

    // Shop B
    const ownerBEmail = 'ownerB_' + sfx + '@test.local';
    const createdB = await api('POST', '/api/admin/shops', {
      token: saToken,
      body: { shopName: 'Shop B', ownerEmail: ownerBEmail, ownerPassword: 'password123' }
    });
    const shopB = createdB.data.shopId;
    const ownerBLogin = await api('POST', '/auth/login', { body: { email: ownerBEmail, password: 'password123' } });
    const ownerBToken = ownerBLogin.data.accessToken;

    // Staff (no delivery_entry by default)
    const staffEmail = 'staff_' + sfx + '@test.local';
    await api('POST', '/auth/register', { body: { email: staffEmail, password: 'password123' } });
    const staffLogin = await api('POST', '/auth/login', { body: { email: staffEmail, password: 'password123' } });
    const staffToken = staffLogin.data.accessToken;
    const staffId = staffLogin.data.user.id;
    await query("insert into memberships(user_id,shop_id,role) values($1,$2,'staff')", [staffId, shopA]);

    console.log('\n=== Delivery Release A â€” Test Matrix ===\n');

    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    // LEGACY ROUTE GATE TESTS (LG1â€“LG8)
    // Batch/settlement write routes are disabled (410) in Release A+.
    // Read routes remain accessible. Daily Bill routes are the active writes.
    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    console.log('\n=== Legacy Route Gate Tests (LG1â€“LG8) ===\n');

    // â”€â”€â”€ LG1: Legacy GET /batches still readable â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const lg1 = await api('GET', '/api/delivery/batches', { token: ownerToken, shop: shopA });
    check('LG1 GET /batches returns 200', lg1.status === 200, lg1.data);
    check('LG1 Response has batches array', Array.isArray(lg1.data?.batches), lg1.data);

    // â”€â”€â”€ LG2: Legacy GET /batch/:id still accessible â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const lg2 = await api('GET', '/api/delivery/batch/' + crypto.randomUUID(), { token: ownerToken, shop: shopA });
    check('LG2 GET /batch/:id route accessible (200 or 404)', lg2.status === 200 || lg2.status === 404, lg2.status);

    // â”€â”€â”€ LG3: POST /batch â†’ 410 LEGACY_DELIVERY_WRITE_DISABLED â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const lg3 = await api('POST', '/api/delivery/batch', { token: ownerToken, shop: shopA, body: {
      platform: 'Grab', sales_date_from: '2026-07-15', mode: 'financial_only', gross_sales: 1000, items: []
    }});
    check('LG3 POST /batch â†’ 410', lg3.status === 410, lg3.data);
    check('LG3 Error = LEGACY_DELIVERY_WRITE_DISABLED', lg3.data?.error === 'LEGACY_DELIVERY_WRITE_DISABLED', lg3.data?.error);

    // â”€â”€â”€ LG4: POST /batch/:id/confirm â†’ 410 â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const lg4 = await api('POST', '/api/delivery/batch/' + crypto.randomUUID() + '/confirm', { token: ownerToken, shop: shopA });
    check('LG4 POST /batch/:id/confirm â†’ 410', lg4.status === 410, lg4.data);
    check('LG4 Error = LEGACY_DELIVERY_WRITE_DISABLED', lg4.data?.error === 'LEGACY_DELIVERY_WRITE_DISABLED', lg4.data?.error);

    // â”€â”€â”€ LG5: POST /settlement â†’ 410 â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const lg5 = await api('POST', '/api/delivery/settlement', { token: ownerToken, shop: shopA, body: {
      platform: 'Grab', gross_sales: 1000, commission_amount: 300,
      discount_funding_source: 'merchant', merchant_discount_amount: 0, platform_discount_amount: 0,
      promotion_fee: 0, advertising_fee: 0, vat_on_fee: 0, refund_amount: 0,
      withholding_tax: 0, other_deduction: 0, other_adjustment: 0, actual_bank_deposit: 700
    }});
    check('LG5 POST /settlement â†’ 410', lg5.status === 410, lg5.data);
    check('LG5 Error = LEGACY_DELIVERY_WRITE_DISABLED', lg5.data?.error === 'LEGACY_DELIVERY_WRITE_DISABLED', lg5.data?.error);

    // â”€â”€â”€ LG6: No stock movement created by legacy write â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const lg6StockBefore = (await query('SELECT count(*)::int as n FROM stock_movements WHERE shop_id=$1', [shopA])).rows[0].n;
    await api('POST', '/api/delivery/batch', { token: ownerToken, shop: shopA, body: {
      platform: 'Grab', sales_date_from: '2026-07-16', mode: 'stock_aware', gross_sales: 300,
      items: [{ menu_type: 'recipe', recipe_id: recId, quantity: 2 }]
    }});
    const lg6StockAfter = (await query('SELECT count(*)::int as n FROM stock_movements WHERE shop_id=$1', [shopA])).rows[0].n;
    check('LG6 Legacy batch write creates zero stock movements', lg6StockAfter === lg6StockBefore, { before: lg6StockBefore, after: lg6StockAfter });

    // â”€â”€â”€ LG7: No delivery_sales_batches record from legacy POST /batch â”€â”€â”€â”€â”€â”€â”€â”€
    const lg7BatchBefore = (await query('SELECT count(*)::int as n FROM delivery_sales_batches WHERE shop_id=$1', [shopA])).rows[0].n;
    await api('POST', '/api/delivery/batch', { token: ownerToken, shop: shopA, body: {
      platform: 'LG7Ghost', sales_date_from: '2026-07-17', mode: 'financial_only', gross_sales: 500, items: []
    }});
    const lg7BatchAfter = (await query('SELECT count(*)::int as n FROM delivery_sales_batches WHERE shop_id=$1', [shopA])).rows[0].n;
    check('LG7 Legacy POST /batch creates no batch record in DB', lg7BatchAfter === lg7BatchBefore, { before: lg7BatchBefore, after: lg7BatchAfter });

    // â”€â”€â”€ LG8: Daily Bill flow remains active â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const lg8 = await api('POST', '/api/delivery/bill/open', { token: ownerToken, shop: shopA, body: {
      platform: 'LG8Test', sales_date: '2026-07-15'
    }});
    check('LG8 POST /bill/open returns 200/201 (Daily Bill active)', lg8.status === 200 || lg8.status === 201, lg8.data);
    check('LG8 bill.status = open', lg8.data?.bill?.status === 'open', lg8.data?.bill?.status);

    // â”€â”€â”€ T2 through T30 removed â€” these tested batch-model writes which are now â”€â”€
    // â”€â”€â”€ disabled (410). Legacy Gate tests LG1â€“LG8 cover the new expectations.  â”€â”€

    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    // DAILY BILL MODEL TESTS (DB1-DB24)
    // Phase 3 Delivery Workflow Correction
    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    console.log('\n=== Daily Bill Model Tests (DB1-DB24) ===\n');

    // Set price on materials for COGS tests
    await query('UPDATE materials SET price=50 WHERE id=$1', [matId]);   // Milk à¸¿50/ml
    await query('UPDATE materials SET price=10 WHERE id=$1', [matId2]);  // Espresso à¸¿10/ml

    const DB_DATE   = '2026-07-10';  // isolated date â€” won't conflict with old batch tests
    const DB_DATE2  = '2026-07-11';

    // â”€â”€â”€ DB1: POST /bill/open creates new open bill â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const db1 = await api('POST', '/api/delivery/bill/open', { token: ownerToken, shop: shopA, body: { platform: 'Grab', sales_date: DB_DATE } });
    check('DB1 Bill created (201)', db1.status === 201, db1.data);
    check('DB1 status = open', db1.data.bill?.status === 'open', db1.data.bill?.status);
    check('DB1 created = true', db1.data.created === true);
    const db1BillId = db1.data.bill?.id;

    // â”€â”€â”€ DB2: Reopening same platform+date returns existing bill (idempotent) â”€
    const db2 = await api('POST', '/api/delivery/bill/open', { token: ownerToken, shop: shopA, body: { platform: 'Grab', sales_date: DB_DATE } });
    check('DB2 Returns same bill (200)', db2.status === 200, db2.data);
    check('DB2 Same bill id', db2.data.bill?.id === db1BillId, { got: db2.data.bill?.id, want: db1BillId });
    check('DB2 created = false', db2.data.created === false);

    // â”€â”€â”€ DB3: Two different platforms same day get separate bills â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const db3 = await api('POST', '/api/delivery/bill/open', { token: ownerToken, shop: shopA, body: { platform: 'LINE MAN', sales_date: DB_DATE } });
    check('DB3 Second platform gets its own bill (201)', db3.status === 201, db3.data);
    check('DB3 Different bill id', db3.data.bill?.id !== db1BillId);
    const db3BillId = db3.data.bill?.id;

    // â”€â”€â”€ DB4: GET /bill/queue returns today section â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // Use DB_DATE as "today" by checking the awaiting or creating bills with that date
    const db4 = await api('GET', '/api/delivery/bill/queue', { token: ownerToken, shop: shopA });
    check('DB4 Queue endpoint returns 200', db4.status === 200, db4.data);
    check('DB4 Has today/awaiting_settlement/recent_reconciled keys', db4.data && 'today' in db4.data && 'awaiting_settlement' in db4.data, db4.data);

    // â”€â”€â”€ DB5: GET /bill/:id returns bill + items + movements â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const db5 = await api('GET', '/api/delivery/bill/' + db1BillId, { token: ownerToken, shop: shopA });
    check('DB5 Bill detail returned (200)', db5.status === 200, db5.data);
    check('DB5 bill object present', !!db5.data.bill);
    check('DB5 items array present', Array.isArray(db5.data.items));
    check('DB5 movements array present', Array.isArray(db5.data.movements));

    // â”€â”€â”€ DB6: Add FG recipe item â€” deducts fg_stock â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const fgBeforeDb6 = Number((await query('SELECT fg_stock FROM recipes WHERE id=$1', [recId])).rows[0]?.fg_stock);
    const db6 = await api('POST', '/api/delivery/bill/' + db1BillId + '/item', { token: ownerToken, shop: shopA, body: {
      menu_type: 'recipe', recipe_id: recId, menu_name: 'Matcha Latte',
      quantity: 2, unit_price: 150, chosen_options: []
    }});
    check('DB6 Item added (201)', db6.status === 201, db6.data);
    check('DB6 movement_count >= 1', (db6.data.movement_count || 0) >= 1, db6.data.movement_count);
    // Verify fg_stock deducted by qty=2 (delta check, robust to prior tests)
    const fgAfterDb6 = Number((await query('SELECT fg_stock FROM recipes WHERE id=$1', [recId])).rows[0]?.fg_stock);
    check('DB6 FG stock deducted by qty=2', fgBeforeDb6 - fgAfterDb6 === 2, { before: fgBeforeDb6, after: fgAfterDb6 });

    // â”€â”€â”€ DB7: Add MTO recipe item â€” deducts BOM materials â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const matStockBefore = (await query('SELECT stock FROM materials WHERE id=$1', [matId2])).rows[0]?.stock;
    const db7 = await api('POST', '/api/delivery/bill/' + db1BillId + '/item', { token: ownerToken, shop: shopA, body: {
      menu_type: 'recipe', recipe_id: recipeId2, menu_name: 'Americano',
      quantity: 1, unit_price: 80, chosen_options: []
    }});
    check('DB7 MTO item added (201)', db7.status === 201, db7.data);
    const matStockAfter = (await query('SELECT stock FROM materials WHERE id=$1', [matId2])).rows[0]?.stock;
    // Americano: 30ml Ã— 1 qty = 30ml deducted
    check('DB7 BOM material deducted (30ml)', Number(matStockBefore) - Number(matStockAfter) === 30, { before: matStockBefore, after: matStockAfter });

    // â”€â”€â”€ DB8: batch_item_gross accumulates from items â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const db8Bill = (await api('GET', '/api/delivery/bill/' + db1BillId, { token: ownerToken, shop: shopA })).data.bill;
    // 2 Ã— 150 (Matcha) + 1 Ã— 80 (Americano) = 380
    check('DB8 batch_item_gross = 380', Number(db8Bill.batch_item_gross) === 380, db8Bill.batch_item_gross);
    check('DB8 item_count = 2', Number(db8Bill.item_count) === 2, db8Bill.item_count);

    // â”€â”€â”€ DB9: COGS tracked per item (MTO path) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // Americano: matId2 price=10, 30ml Ã— 1qty = à¸¿300
    const db9Americano = (await query(
      'SELECT cogs_amount FROM delivery_sales_items WHERE batch_id=$1 AND recipe_id=$2',
      [db1BillId, recipeId2]
    )).rows[0];
    check('DB9 COGS tracked on Americano item (à¸¿300)', Math.abs(Number(db9Americano?.cogs_amount) - 300) < 0.01, db9Americano?.cogs_amount);
    const db9Bill = (await api('GET', '/api/delivery/bill/' + db1BillId, { token: ownerToken, shop: shopA })).data.bill;
    check('DB9 cogs_total > 0 on bill', Number(db9Bill.cogs_total) > 0, db9Bill.cogs_total);

    // â”€â”€â”€ DB10: Duplicate order_no in same bill blocked â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const db10a = await api('POST', '/api/delivery/bill/' + db3BillId + '/item', { token: ownerToken, shop: shopA, body: {
      menu_type: 'recipe', recipe_id: recId, menu_name: 'Matcha Latte',
      quantity: 1, unit_price: 150, order_no: 'GRAB-001', chosen_options: []
    }});
    check('DB10 First item with order_no ok (201)', db10a.status === 201, db10a.data);
    const db10b = await api('POST', '/api/delivery/bill/' + db3BillId + '/item', { token: ownerToken, shop: shopA, body: {
      menu_type: 'recipe', recipe_id: recId, menu_name: 'Matcha Latte',
      quantity: 1, unit_price: 150, order_no: 'GRAB-001', chosen_options: []
    }});
    check('DB10 Duplicate order_no â†’ 409', db10b.status === 409, db10b.data);
    check('DB10 Error = DUPLICATE_ORDER_NO', db10b.data?.error === 'DUPLICATE_ORDER_NO', db10b.data?.error);

    // â”€â”€â”€ DB11: Different order_no in same bill allowed â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const db11 = await api('POST', '/api/delivery/bill/' + db3BillId + '/item', { token: ownerToken, shop: shopA, body: {
      menu_type: 'recipe', recipe_id: recId, menu_name: 'Matcha Latte',
      quantity: 1, unit_price: 150, order_no: 'GRAB-002', chosen_options: []
    }});
    check('DB11 Different order_no allowed (201)', db11.status === 201, db11.data);

    // â”€â”€â”€ DB12: Item removal uses audit-preserving reversal (FOUNDER POINT 6) â”€â”€â”€
    // Add a temporary item to db1BillId then remove it
    const db12add = await api('POST', '/api/delivery/bill/' + db1BillId + '/item', { token: ownerToken, shop: shopA, body: {
      menu_type: 'recipe', recipe_id: recId, menu_name: 'Matcha Latte',
      quantity: 1, unit_price: 200, chosen_options: []
    }});
    check('DB12 Temp item added', db12add.status === 201);
    const db12ItemId = db12add.data.item?.id;
    const db12BillBefore = (await api('GET', '/api/delivery/bill/' + db1BillId, { token: ownerToken, shop: shopA })).data.bill;
    const db12GrossBefore = Number(db12BillBefore.batch_item_gross);

    // Capture deduct link ids BEFORE removal â€” they must survive (not be deleted)
    const db12DeductsBefore = (await query(
      `SELECT id FROM delivery_batch_stock_movements
       WHERE batch_id=$1 AND item_id=$2 AND operation_type='deduct'`,
      [db1BillId, db12ItemId]
    )).rows;

    const db12del = await api('DELETE', '/api/delivery/bill/' + db1BillId + '/item/' + db12ItemId, { token: ownerToken, shop: shopA });
    check('DB12 Item removed (200)', db12del.status === 200, db12del.data);
    const db12BillAfter = (await api('GET', '/api/delivery/bill/' + db1BillId, { token: ownerToken, shop: shopA })).data.bill;
    check('DB12 batch_item_gross reduced by 200', Math.abs(Number(db12BillAfter.batch_item_gross) - (db12GrossBefore - 200)) < 0.01, { before: db12GrossBefore, after: db12BillAfter.batch_item_gross });

    // AUDIT TRAIL: deduct rows must be PRESERVED (reversed_at stamped, NOT deleted)
    if (db12DeductsBefore.length > 0) {
      const db12DeductAfter = (await query(
        `SELECT id, reversed_at FROM delivery_batch_stock_movements
         WHERE id=ANY($1::uuid[]) AND operation_type='deduct'`,
        [db12DeductsBefore.map(r => r.id)]
      )).rows;
      check('DB12 Deduct rows preserved (NOT deleted)', db12DeductAfter.length === db12DeductsBefore.length, { before: db12DeductsBefore.length, after: db12DeductAfter.length });
      check('DB12 reversed_at stamped on deduct row', db12DeductAfter.every(r => r.reversed_at !== null), db12DeductAfter.map(r => r.reversed_at));
      // Note: item_id is SET NULL by FK cascade when delivery_sales_items row is deleted.
      // Query reverse rows by reversal_of (link to deduct dbsm row id) â€” robust to item_id nullification.
      const deductDbsmIds = db12DeductsBefore.map(r => r.id);
      const db12RevRows = (await query(
        `SELECT id, reversal_of FROM delivery_batch_stock_movements
         WHERE batch_id=$1 AND reversal_of=ANY($2::uuid[]) AND operation_type='reverse'`,
        [db1BillId, deductDbsmIds]
      )).rows;
      check('DB12 Reverse rows created for item removal', db12RevRows.length > 0, db12RevRows.length);
      const deductIdSet = new Set(deductDbsmIds);
      check('DB12 reversal_of links back to original deduct row', db12RevRows.some(r => deductIdSet.has(r.reversal_of)), db12RevRows.map(r => r.reversal_of));
    }

    // â”€â”€â”€ DB13: Sequential item adds don't double-deduct â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const deductsBefore = (await query(
      "SELECT count(*)::int as n FROM delivery_batch_stock_movements WHERE batch_id=$1 AND operation_type='deduct'",
      [db1BillId]
    )).rows[0].n;
    const db13 = await api('POST', '/api/delivery/bill/' + db1BillId + '/item', { token: ownerToken, shop: shopA, body: {
      menu_type: 'recipe', recipe_id: recipeId2, menu_name: 'Americano',
      quantity: 1, unit_price: 80, chosen_options: []
    }});
    const deductsAfter = (await query(
      "SELECT count(*)::int as n FROM delivery_batch_stock_movements WHERE batch_id=$1 AND operation_type='deduct'",
      [db1BillId]
    )).rows[0].n;
    check('DB13 Exactly 1 new deduct movement per item add', deductsAfter - deductsBefore === 1, { before: deductsBefore, after: deductsAfter });

    // â”€â”€â”€ DB14: AWAITING_SETTLEMENT bill blocks new items â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // Open a fresh bill for this test
    const db14open = await api('POST', '/api/delivery/bill/open', { token: ownerToken, shop: shopA, body: { platform: 'Foodpanda', sales_date: DB_DATE } });
    const db14BillId = db14open.data.bill?.id;
    await api('POST', '/api/delivery/bill/' + db14BillId + '/close', { token: ownerToken, shop: shopA });
    const db14add = await api('POST', '/api/delivery/bill/' + db14BillId + '/item', { token: ownerToken, shop: shopA, body: {
      menu_type: 'recipe', recipe_id: recId, menu_name: 'Matcha Latte', quantity: 1, unit_price: 150, chosen_options: []
    }});
    check('DB14 AWAITING_SETTLEMENT blocks item add (409)', db14add.status === 409, db14add.data);
    check('DB14 Error = BILL_NOT_EDITABLE', db14add.data?.error === 'BILL_NOT_EDITABLE', db14add.data?.error);

    // â”€â”€â”€ DB15: POST /bill/:id/close â†’ awaiting_settlement â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const db15open = await api('POST', '/api/delivery/bill/open', { token: ownerToken, shop: shopA, body: { platform: 'ShopeeFood', sales_date: DB_DATE } });
    const db15BillId = db15open.data.bill?.id;
    const db15close = await api('POST', '/api/delivery/bill/' + db15BillId + '/close', { token: ownerToken, shop: shopA });
    check('DB15 Close returns 200', db15close.status === 200, db15close.data);
    check('DB15 status = awaiting_settlement', db15close.data?.status === 'awaiting_settlement', db15close.data);
    const db15bill = (await api('GET', '/api/delivery/bill/' + db15BillId, { token: ownerToken, shop: shopA })).data.bill;
    check('DB15 Bill status in DB = awaiting_settlement', db15bill?.status === 'awaiting_settlement', db15bill?.status);

    // â”€â”€â”€ DB16: Settlement fees + bank deposit saved â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const db16 = await api('PATCH', '/api/delivery/bill/' + db14BillId + '/settle', { token: ownerToken, shop: shopA, body: {
      commission_amount: 50, withholding_tax: 5, actual_bank_deposit: 95
    }});
    check('DB16 Settle returns 200', db16.status === 200, db16.data);
    check('DB16 merchant_net computed', db16.data?.merchant_net != null, db16.data);
    check('DB16 expected_bank_cash = merchant_net - WHT', Math.abs(db16.data.expected_bank_cash - (db16.data.merchant_net - 5)) < 0.01, db16.data);

    // â”€â”€â”€ DB17: No bank deposit â†’ status stays awaiting_settlement â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const db17 = await api('PATCH', '/api/delivery/bill/' + db15BillId + '/settle', { token: ownerToken, shop: shopA, body: {
      commission_amount: 20
    }});
    check('DB17 Settle without deposit returns 200', db17.status === 200, db17.data);
    const db17bill = (await api('GET', '/api/delivery/bill/' + db15BillId, { token: ownerToken, shop: shopA })).data.bill;
    check('DB17 Status remains awaiting_settlement', db17bill?.status === 'awaiting_settlement', db17bill?.status);

    // â”€â”€â”€ DB18: Near-zero variance â†’ RECONCILED â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // Bill with 0 items â†’ batch_item_net = 0, merchantNet = 0
    const db18open = await api('POST', '/api/delivery/bill/open', { token: ownerToken, shop: shopA, body: { platform: 'Shopee', sales_date: DB_DATE } });
    const db18BillId = db18open.data.bill?.id;
    await api('POST', '/api/delivery/bill/' + db18BillId + '/close', { token: ownerToken, shop: shopA });
    const db18 = await api('PATCH', '/api/delivery/bill/' + db18BillId + '/settle', { token: ownerToken, shop: shopA, body: {
      actual_bank_deposit: 0  // variance = 0 - 0 = 0 â†’ reconciled
    }});
    check('DB18 Settle with zero variance â†’ reconciled', db18.data?.status === 'reconciled', db18.data?.status);

    // â”€â”€â”€ DB19: Large variance â†’ DISCREPANCY â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const db19open = await api('POST', '/api/delivery/bill/open', { token: ownerToken, shop: shopA, body: { platform: 'à¸­à¸·à¹ˆà¸™à¹†', sales_date: DB_DATE } });
    const db19BillId = db19open.data.bill?.id;
    await api('POST', '/api/delivery/bill/' + db19BillId + '/close', { token: ownerToken, shop: shopA });
    const db19 = await api('PATCH', '/api/delivery/bill/' + db19BillId + '/settle', { token: ownerToken, shop: shopA, body: {
      actual_bank_deposit: 999  // expected = 0, variance = 999 â†’ discrepancy
    }});
    check('DB19 Large variance â†’ discrepancy', db19.data?.status === 'discrepancy', db19.data?.status);

    // â”€â”€â”€ DB20: actual_bank_deposit does not overwrite batch_item_net â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // batch_item_net should remain unchanged after settling
    const db20bill = (await api('GET', '/api/delivery/bill/' + db14BillId, { token: ownerToken, shop: shopA })).data.bill;
    check('DB20 batch_item_net unchanged after settle', Number(db20bill?.batch_item_net) === 0, db20bill?.batch_item_net);

    // â”€â”€â”€ DB21: Staff without delivery_settlement cannot /settle â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // Create fresh staff on shopB (shopB has no delivery_settlement granted)
    const staffB21Email = 'staffb21_' + sfx + '@test.local';
    await api('POST', '/auth/register', { body: { email: staffB21Email, password: 'password123' } });
    const staffB21Login = await api('POST', '/auth/login', { body: { email: staffB21Email, password: 'password123' } });
    const staffB21Token = staffB21Login.data.accessToken;
    const staffB21Id = staffB21Login.data.user.id;
    await query("INSERT INTO memberships(user_id,shop_id,role) VALUES($1,$2,'staff')", [staffB21Id, shopB]);
    // Open a bill on shopB
    const db21open = await api('POST', '/api/delivery/bill/open', { token: ownerBToken, shop: shopB, body: { platform: 'Grab', sales_date: DB_DATE } });
    const db21BillId = db21open.data.bill?.id;
    await api('POST', '/api/delivery/bill/' + db21BillId + '/close', { token: ownerBToken, shop: shopB });
    const db21settle = await api('PATCH', '/api/delivery/bill/' + db21BillId + '/settle', { token: staffB21Token, shop: shopB, body: { actual_bank_deposit: 0 } });
    check('DB21 Staff without delivery_settlement â†’ 403', db21settle.status === 403, db21settle.data);

    // â”€â”€â”€ DB22: Tenant isolation â€” Shop B cannot access Shop A bills â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const db22 = await api('GET', '/api/delivery/bill/' + db1BillId, { token: ownerBToken, shop: shopB });
    check('DB22 Shop B cannot read Shop A bill (404)', db22.status === 404, db22.data);

    // â”€â”€â”€ DB23: Void audit-preserving reversal (FOUNDER POINT 6) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // db1BillId has items with movements â€” void it and check full audit integrity
    const deductsBeforeVoid = await countLinks(db1BillId, 'deduct');
    check('DB23 Bill has deduct movements before void', deductsBeforeVoid > 0, deductsBeforeVoid);

    // Record the actual deduct row ids so we can verify they are preserved
    const db23DeductIds = (await query(
      `SELECT id FROM delivery_batch_stock_movements WHERE batch_id=$1 AND operation_type='deduct'`,
      [db1BillId]
    )).rows.map(r => r.id);

    const db23void = await api('POST', '/api/delivery/bill/' + db1BillId + '/void', { token: ownerToken, shop: shopA, body: { reason: 'test void' } });
    check('DB23 Void returns 200', db23void.status === 200, db23void.data);
    check('DB23 reversed > 0', (db23void.data?.reversed || 0) > 0, db23void.data?.reversed);
    const db23RevLinks = await countLinks(db1BillId, 'reverse');
    check('DB23 Reverse movement links created', db23RevLinks > 0, db23RevLinks);

    // AUDIT TRAIL: All deduct rows must still exist with reversed_at set (none deleted)
    if (db23DeductIds.length > 0) {
      const db23DeductAfter = (await query(
        `SELECT id, reversed_at FROM delivery_batch_stock_movements
         WHERE id=ANY($1::uuid[]) AND operation_type='deduct'`,
        [db23DeductIds]
      )).rows;
      check('DB23 All deduct rows preserved after void (NOT deleted)', db23DeductAfter.length === db23DeductIds.length, { expected: db23DeductIds.length, got: db23DeductAfter.length });
      check('DB23 reversed_at set on all deduct rows after void', db23DeductAfter.every(r => r.reversed_at !== null), db23DeductAfter.map(r => r.reversed_at));
    }

    // Double-void must NOT create additional reversals (already: true OR reversed: 0)
    const db23void2 = await api('POST', '/api/delivery/bill/' + db1BillId + '/void', { token: ownerToken, shop: shopA, body: { reason: 'duplicate void attempt' } });
    check('DB23 Second void returns 200 (idempotent)', db23void2.status === 200, db23void2.data);
    check('DB23 Second void reports already=true OR reversed=0', db23void2.data?.already === true || db23void2.data?.reversed === 0, db23void2.data);

    // â”€â”€â”€ DB24: Items preserved in DB after void (audit trail) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const db24items = (await query('SELECT count(*)::int as n FROM delivery_sales_items WHERE batch_id=$1', [db1BillId])).rows[0].n;
    check('DB24 Items still in DB after void (not deleted)', db24items > 0, db24items);
    const db24bill = (await api('GET', '/api/delivery/bill/' + db1BillId, { token: ownerToken, shop: shopA })).data.bill;
    check('DB24 Bill status = voided', db24bill?.status === 'voided', db24bill?.status);

    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    // COGS UNIT TESTS (C1â€“C13)
    // Validates fix: costPerBaseUnit = price / (purchase_qty Ã— conv_qty)
    // Bug was: price Ã— raw_amount (ignored pack/conversion factor)
    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    console.log('\n=== COGS Unit Tests (C1â€“C13) ===\n');

    // Materials with explicit pack pricing
    const cMatSugar  = crypto.randomUUID();  // à¸¿90/kg, qty=1, conv_qty=1000 g
    const cMatOil    = crypto.randomUUID();  // à¸¿120/litre, qty=1, conv_qty=1000 ml
    const cMatEgg    = crypto.randomUUID();  // à¸¿5/piece, qty=1, conv_qty=1
    const cMatChoc   = crypto.randomUUID();  // à¸¿61/pack, qty=1, conv_qty=400 g  â† exact bug-report case
    const cMatMatcha = crypto.randomUUID();  // à¸¿250/bag, qty=1, conv_qty=500 g

    await query('INSERT INTO materials(id,shop_id,name,unit,stock_unit,price,qty,conv_qty,stock,updated_at) VALUES($1,$2,\'C-Sugar\',\'kg\',\'g\',90,1,1000,99999,now())', [cMatSugar, shopA]);
    await query('INSERT INTO materials(id,shop_id,name,unit,stock_unit,price,qty,conv_qty,stock,updated_at) VALUES($1,$2,\'C-Oil\',\'litre\',\'ml\',120,1,1000,99999,now())', [cMatOil, shopA]);
    await query('INSERT INTO materials(id,shop_id,name,unit,stock_unit,price,qty,conv_qty,stock,updated_at) VALUES($1,$2,\'C-Egg\',\'piece\',\'piece\',5,1,1,99999,now())', [cMatEgg, shopA]);
    await query('INSERT INTO materials(id,shop_id,name,unit,stock_unit,price,qty,conv_qty,stock,updated_at) VALUES($1,$2,\'C-Choc\',\'pack\',\'g\',61,1,400,99999,now())', [cMatChoc, shopA]);
    await query('INSERT INTO materials(id,shop_id,name,unit,stock_unit,price,qty,conv_qty,stock,updated_at) VALUES($1,$2,\'C-Matcha\',\'bag\',\'g\',250,1,500,99999,now())', [cMatMatcha, shopA]);

    // Recipes
    const cRecSugar50  = crypto.randomUUID();  // C1,C11: 50 g sugar, MTO
    const cRecOil200   = crypto.randomUUID();  // C2: 200 ml oil, MTO
    const cRecEgg2     = crypto.randomUUID();  // C3: 2 egg pieces, MTO
    const cRecChoc100  = crypto.randomUUID();  // C4: 100 g choc, MTO
    const cRecMatcha10 = crypto.randomUUID();  // C5: 10 g matcha, MTO
    const cRecFG       = crypto.randomUUID();  // C10: FG (no BOM COGS)
    const cRecSub      = crypto.randomUUID();  // C9: sub-recipe FG component
    const cRecWithSub  = crypto.randomUUID();  // C9: MTO recipe using sub-recipe only
    const cRecBase     = crypto.randomUUID();  // C6/C7/C8: 50 g sugar base with options

    await query('INSERT INTO recipes(id,shop_id,name,yield_unit,fg_stock,inventory_mode,updated_at) VALUES($1,$2,\'C-SugarDrink\',\'cup\',99,\'make_to_order\',now())', [cRecSugar50, shopA]);
    await query('INSERT INTO recipe_items(recipe_id,material_id,amount,role) VALUES($1,$2,50,NULL)', [cRecSugar50, cMatSugar]);

    await query('INSERT INTO recipes(id,shop_id,name,yield_unit,fg_stock,inventory_mode,updated_at) VALUES($1,$2,\'C-OilDrink\',\'cup\',99,\'make_to_order\',now())', [cRecOil200, shopA]);
    await query('INSERT INTO recipe_items(recipe_id,material_id,amount,role) VALUES($1,$2,200,NULL)', [cRecOil200, cMatOil]);

    await query('INSERT INTO recipes(id,shop_id,name,yield_unit,fg_stock,inventory_mode,updated_at) VALUES($1,$2,\'C-EggDish\',\'pcs\',99,\'make_to_order\',now())', [cRecEgg2, shopA]);
    await query('INSERT INTO recipe_items(recipe_id,material_id,amount,role) VALUES($1,$2,2,NULL)', [cRecEgg2, cMatEgg]);

    await query('INSERT INTO recipes(id,shop_id,name,yield_unit,fg_stock,inventory_mode,updated_at) VALUES($1,$2,\'C-ChocCake\',\'pcs\',99,\'make_to_order\',now())', [cRecChoc100, shopA]);
    await query('INSERT INTO recipe_items(recipe_id,material_id,amount,role) VALUES($1,$2,100,NULL)', [cRecChoc100, cMatChoc]);

    await query('INSERT INTO recipes(id,shop_id,name,yield_unit,fg_stock,inventory_mode,updated_at) VALUES($1,$2,\'C-MatchaDrink\',\'cup\',99,\'make_to_order\',now())', [cRecMatcha10, shopA]);
    await query('INSERT INTO recipe_items(recipe_id,material_id,amount,role) VALUES($1,$2,10,NULL)', [cRecMatcha10, cMatMatcha]);

    await query('INSERT INTO recipes(id,shop_id,name,yield_unit,fg_stock,inventory_mode,updated_at) VALUES($1,$2,\'C-FGItem\',\'pcs\',50,\'finished_goods\',now())', [cRecFG, shopA]);

    await query('INSERT INTO recipes(id,shop_id,name,yield_unit,fg_stock,inventory_mode,updated_at) VALUES($1,$2,\'C-SubRec\',\'pcs\',50,\'finished_goods\',now())', [cRecSub, shopA]);
    await query('INSERT INTO recipes(id,shop_id,name,yield_unit,fg_stock,inventory_mode,updated_at) VALUES($1,$2,\'C-WithSub\',\'cup\',99,\'make_to_order\',now())', [cRecWithSub, shopA]);
    await query('INSERT INTO recipe_items(recipe_id,sub_recipe_id,amount) VALUES($1,$2,1)', [cRecWithSub, cRecSub]);

    await query('INSERT INTO recipes(id,shop_id,name,yield_unit,fg_stock,inventory_mode,updated_at) VALUES($1,$2,\'C-OptionBase\',\'cup\',99,\'make_to_order\',now())', [cRecBase, shopA]);
    await query('INSERT INTO recipe_items(recipe_id,material_id,amount,role) VALUES($1,$2,50,\'cogs_base\')', [cRecBase, cMatSugar]);

    // Variant recipe for C8: 100 g sugar
    const cRecVariant = crypto.randomUUID();
    await query('INSERT INTO recipes(id,shop_id,name,yield_unit,fg_stock,inventory_mode,updated_at) VALUES($1,$2,\'C-Variant100g\',\'cup\',99,\'make_to_order\',now())', [cRecVariant, shopA]);
    await query('INSERT INTO recipe_items(recipe_id,material_id,amount,role) VALUES($1,$2,100,NULL)', [cRecVariant, cMatSugar]);

    // Option groups/choices: ADD 20 g sugar (C6)
    const cGrpAdd     = crypto.randomUUID();
    const cChoiceAdd  = crypto.randomUUID();
    await query('INSERT INTO option_groups(id,shop_id,label,required,enabled) VALUES($1,$2,\'C-ExtraSugar\',false,true)', [cGrpAdd, shopA]);
    await query('INSERT INTO option_choices(id,group_id,label,effect_type,enabled) VALUES($1,$2,\'AddSugar20g\',\'ADD\',true)', [cChoiceAdd, cGrpAdd]);
    await query('INSERT INTO option_choice_links(choice_id,material_id,amount) VALUES($1,$2,20)', [cChoiceAdd, cMatSugar]);
    await query('INSERT INTO recipe_option_groups(recipe_id,group_id) VALUES($1,$2)', [cRecBase, cGrpAdd]);

    // REPLACE sugar (role=cogs_base) with 200 ml oil (C7)
    const cGrpReplace    = crypto.randomUUID();
    const cChoiceReplace = crypto.randomUUID();
    await query('INSERT INTO option_groups(id,shop_id,label,required,enabled) VALUES($1,$2,\'C-Sweetener\',false,true)', [cGrpReplace, shopA]);
    await query('INSERT INTO option_choices(id,group_id,label,effect_type,target_role,enabled) VALUES($1,$2,\'OilInstead\',\'REPLACE\',\'cogs_base\',true)', [cChoiceReplace, cGrpReplace]);
    await query('INSERT INTO option_choice_links(choice_id,material_id,amount) VALUES($1,$2,200)', [cChoiceReplace, cMatOil]);
    await query('INSERT INTO recipe_option_groups(recipe_id,group_id) VALUES($1,$2)', [cRecBase, cGrpReplace]);

    // RECIPE_VARIANT â†’ cRecVariant (C8)
    const cGrpVariant    = crypto.randomUUID();
    const cChoiceVariant = crypto.randomUUID();
    await query('INSERT INTO option_groups(id,shop_id,label,required,enabled) VALUES($1,$2,\'C-Size\',false,true)', [cGrpVariant, shopA]);
    await query('INSERT INTO option_choices(id,group_id,label,effect_type,variant_recipe_id,enabled) VALUES($1,$2,\'Large\',\'RECIPE_VARIANT\',$3,true)', [cChoiceVariant, cGrpVariant, cRecVariant]);
    await query('INSERT INTO recipe_option_groups(recipe_id,group_id) VALUES($1,$2)', [cRecBase, cGrpVariant]);

    // Open a dedicated bill for COGS tests
    const cBillOpen = await api('POST', '/api/delivery/bill/open', {
      token: ownerToken, shop: shopA,
      body: { platform: 'COGSTest', sales_date: '2026-07-20' }
    });
    const cBillId = cBillOpen.data.bill?.id;
    check('C0 COGS test bill opened', !!cBillId, cBillOpen.data);

    // â”€â”€â”€ C1: g from kg â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // Sugar: price=90, qty=1, conv_qty=1000 â†’ 0.09/g ; 50 g Ã— 1 = à¸¿4.50
    const c1 = await api('POST', '/api/delivery/bill/' + cBillId + '/item', {
      token: ownerToken, shop: shopA,
      body: { menu_type: 'recipe', recipe_id: cRecSugar50, menu_name: 'Sugar Drink', quantity: 1, unit_price: 100, chosen_options: [] }
    });
    check('C1 item added (201)', c1.status === 201, c1.data);
    const c1row = (await query('SELECT cogs_amount FROM delivery_sales_items WHERE id=$1', [c1.data.item?.id])).rows[0];
    check('C1 g from kg: cogs_amount = à¸¿4.50', Math.abs(Number(c1row?.cogs_amount) - 4.50) < 0.01, c1row?.cogs_amount);

    // â”€â”€â”€ C2: ml from litre â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // Oil: price=120, qty=1, conv_qty=1000 â†’ 0.12/ml ; 200 ml Ã— 1 = à¸¿24.00
    const c2 = await api('POST', '/api/delivery/bill/' + cBillId + '/item', {
      token: ownerToken, shop: shopA,
      body: { menu_type: 'recipe', recipe_id: cRecOil200, menu_name: 'Oil Drink', quantity: 1, unit_price: 100, chosen_options: [] }
    });
    const c2row = (await query('SELECT cogs_amount FROM delivery_sales_items WHERE id=$1', [c2.data.item?.id])).rows[0];
    check('C2 ml from litre: cogs_amount = à¸¿24.00', Math.abs(Number(c2row?.cogs_amount) - 24.00) < 0.01, c2row?.cogs_amount);

    // â”€â”€â”€ C3: piece â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // Egg: price=5, qty=1, conv_qty=1 ; 2 pieces Ã— 1 = à¸¿10.00
    const c3 = await api('POST', '/api/delivery/bill/' + cBillId + '/item', {
      token: ownerToken, shop: shopA,
      body: { menu_type: 'recipe', recipe_id: cRecEgg2, menu_name: 'Egg Dish', quantity: 1, unit_price: 100, chosen_options: [] }
    });
    const c3row = (await query('SELECT cogs_amount FROM delivery_sales_items WHERE id=$1', [c3.data.item?.id])).rows[0];
    check('C3 piece: cogs_amount = à¸¿10.00', Math.abs(Number(c3row?.cogs_amount) - 10.00) < 0.01, c3row?.cogs_amount);

    // â”€â”€â”€ C4: pack (exact bug-report case) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // ChocChip: price=61, qty=1, conv_qty=400 â†’ 0.1525/g ; 100 g Ã— 1 = à¸¿15.25
    // (Old bug: 61 Ã— 100 = à¸¿6,100 â€” 400Ã— overcharge)
    const c4 = await api('POST', '/api/delivery/bill/' + cBillId + '/item', {
      token: ownerToken, shop: shopA,
      body: { menu_type: 'recipe', recipe_id: cRecChoc100, menu_name: 'Choc Cake', quantity: 1, unit_price: 100, chosen_options: [] }
    });
    const c4row = (await query('SELECT cogs_amount FROM delivery_sales_items WHERE id=$1', [c4.data.item?.id])).rows[0];
    check('C4 pack: cogs_amount = à¸¿15.25 (not à¸¿6,100 from old bug)', Math.abs(Number(c4row?.cogs_amount) - 15.25) < 0.01, c4row?.cogs_amount);

    // â”€â”€â”€ C5: custom conversion (bagâ†’g) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // Matcha: price=250, qty=1, conv_qty=500 â†’ 0.50/g ; 10 g Ã— 1 = à¸¿5.00
    const c5 = await api('POST', '/api/delivery/bill/' + cBillId + '/item', {
      token: ownerToken, shop: shopA,
      body: { menu_type: 'recipe', recipe_id: cRecMatcha10, menu_name: 'Matcha Drink', quantity: 1, unit_price: 100, chosen_options: [] }
    });
    const c5row = (await query('SELECT cogs_amount FROM delivery_sales_items WHERE id=$1', [c5.data.item?.id])).rows[0];
    check('C5 custom bagâ†’g: cogs_amount = à¸¿5.00', Math.abs(Number(c5row?.cogs_amount) - 5.00) < 0.01, c5row?.cogs_amount);

    // â”€â”€â”€ C6: option ADD â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // cRecBase base BOM: 50 g sugar. ADD option appends 20 g sugar.
    // Effective BOM: 70 g sugar â†’ cogs = 70 Ã— 0.09 = à¸¿6.30
    const c6 = await api('POST', '/api/delivery/bill/' + cBillId + '/item', {
      token: ownerToken, shop: shopA,
      body: { menu_type: 'recipe', recipe_id: cRecBase, menu_name: 'OptionBase+Add', quantity: 1, unit_price: 100,
              chosen_options: [{ group_id: cGrpAdd, choice_id: cChoiceAdd }] }
    });
    check('C6 ADD item added (201)', c6.status === 201, c6.data);
    const c6row = (await query('SELECT cogs_amount FROM delivery_sales_items WHERE id=$1', [c6.data.item?.id])).rows[0];
    check('C6 option ADD: cogs_amount = à¸¿6.30  (50+20=70 g Ã— 0.09)', Math.abs(Number(c6row?.cogs_amount) - 6.30) < 0.01, c6row?.cogs_amount);

    // â”€â”€â”€ C7: option REPLACE â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // REPLACE removes cogs_base (sugar 50 g) and substitutes 200 ml oil.
    // Effective BOM: oil=200 ml â†’ cogs = 200 Ã— 0.12 = à¸¿24.00
    const c7 = await api('POST', '/api/delivery/bill/' + cBillId + '/item', {
      token: ownerToken, shop: shopA,
      body: { menu_type: 'recipe', recipe_id: cRecBase, menu_name: 'OptionBase+Replace', quantity: 1, unit_price: 100,
              chosen_options: [{ group_id: cGrpReplace, choice_id: cChoiceReplace }] }
    });
    check('C7 REPLACE item added (201)', c7.status === 201, c7.data);
    const c7row = (await query('SELECT cogs_amount FROM delivery_sales_items WHERE id=$1', [c7.data.item?.id])).rows[0];
    check('C7 option REPLACE: cogs_amount = à¸¿24.00  (oil 200 ml Ã— 0.12)', Math.abs(Number(c7row?.cogs_amount) - 24.00) < 0.01, c7row?.cogs_amount);

    // â”€â”€â”€ C8: variant recipe â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // RECIPE_VARIANT choice switches BOM to cRecVariant (100 g sugar).
    // cogs = 100 Ã— 0.09 = à¸¿9.00
    const c8 = await api('POST', '/api/delivery/bill/' + cBillId + '/item', {
      token: ownerToken, shop: shopA,
      body: { menu_type: 'recipe', recipe_id: cRecBase, menu_name: 'OptionBase+Variant', quantity: 1, unit_price: 100,
              chosen_options: [{ group_id: cGrpVariant, choice_id: cChoiceVariant }] }
    });
    check('C8 VARIANT item added (201)', c8.status === 201, c8.data);
    const c8row = (await query('SELECT cogs_amount FROM delivery_sales_items WHERE id=$1', [c8.data.item?.id])).rows[0];
    check('C8 variant recipe: cogs_amount = à¸¿9.00  (100 g sugar Ã— 0.09)', Math.abs(Number(c8row?.cogs_amount) - 9.00) < 0.01, c8row?.cogs_amount);

    // â”€â”€â”€ C9: sub-recipe â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // cRecWithSub has only a sub_recipe_id row (no direct materials).
    // Sub-recipe fg_stock is deducted but contributes no material COGS â†’ itemCogs = 0
    const c9 = await api('POST', '/api/delivery/bill/' + cBillId + '/item', {
      token: ownerToken, shop: shopA,
      body: { menu_type: 'recipe', recipe_id: cRecWithSub, menu_name: 'WithSub', quantity: 1, unit_price: 100, chosen_options: [] }
    });
    check('C9 sub-recipe item added (201)', c9.status === 201, c9.data);
    const c9row = (await query('SELECT cogs_amount FROM delivery_sales_items WHERE id=$1', [c9.data.item?.id])).rows[0];
    check('C9 sub-recipe: cogs_amount = à¸¿0.00 (no BOM materials)', Math.abs(Number(c9row?.cogs_amount)) < 0.01, c9row?.cogs_amount);

    // â”€â”€â”€ C10: finished goods â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // FG recipe deducts fg_stock; COGS path is not triggered â†’ itemCogs = 0
    const c10 = await api('POST', '/api/delivery/bill/' + cBillId + '/item', {
      token: ownerToken, shop: shopA,
      body: { menu_type: 'recipe', recipe_id: cRecFG, menu_name: 'FG Item', quantity: 1, unit_price: 100, chosen_options: [] }
    });
    check('C10 FG item added (201)', c10.status === 201, c10.data);
    const c10row = (await query('SELECT cogs_amount FROM delivery_sales_items WHERE id=$1', [c10.data.item?.id])).rows[0];
    check('C10 finished goods: cogs_amount = à¸¿0.00 (FG deducts fg_stock, not BOM)', Math.abs(Number(c10row?.cogs_amount)) < 0.01, c10row?.cogs_amount);

    // â”€â”€â”€ C11: multiple item quantities â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // Sugar recipe qty=3: cogs = 50 g Ã— 3 Ã— 0.09 = à¸¿13.50
    const c11 = await api('POST', '/api/delivery/bill/' + cBillId + '/item', {
      token: ownerToken, shop: shopA,
      body: { menu_type: 'recipe', recipe_id: cRecSugar50, menu_name: 'Sugar Drink x3', quantity: 3, unit_price: 100, chosen_options: [] }
    });
    check('C11 qty=3 item added (201)', c11.status === 201, c11.data);
    const c11row = (await query('SELECT cogs_amount FROM delivery_sales_items WHERE id=$1', [c11.data.item?.id])).rows[0];
    check('C11 qty=3: cogs_amount = à¸¿13.50  (50 g Ã— 3 Ã— 0.09)', Math.abs(Number(c11row?.cogs_amount) - 13.50) < 0.01, c11row?.cogs_amount);

    // â”€â”€â”€ C12: batch total COGS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // C1=4.50 C2=24.00 C3=10.00 C4=15.25 C5=5.00 C6=6.30 C7=24.00 C8=9.00 C9=0 C10=0 C11=13.50
    // Total = 111.55
    const c12bill = (await api('GET', '/api/delivery/bill/' + cBillId, { token: ownerToken, shop: shopA })).data.bill;
    check('C12 batch cogs_total = à¸¿111.55', Math.abs(Number(c12bill?.cogs_total) - 111.55) < 0.01, c12bill?.cogs_total);

    // â”€â”€â”€ C13: gross profit â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // 10 items Ã— qty=1 Ã— à¸¿100 + 1 item Ã— qty=3 Ã— à¸¿100 = à¸¿1300 gross (no discounts)
    // gross_profit = à¸¿1300 âˆ’ à¸¿111.55 = à¸¿1188.45
    check('C13 gross_profit = batch_item_net âˆ’ cogs_total = à¸¿1188.45',
      Math.abs(Number(c12bill?.gross_profit) - 1188.45) < 0.01, c12bill?.gross_profit);

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
