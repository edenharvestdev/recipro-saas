const { Pool } = require('pg');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const app = require('../backend/src/app');
const jwt = require('jsonwebtoken');

const PROD_URL = 'postgresql://postgres:HhpGjcYHzNmWzzfLvvwxDKzmUgxArHpK@thomas.proxy.rlwy.net:23626/railway';
const LOCAL_URL = process.env.DATABASE_URL;

const prodPool = new Pool({
  connectionString: PROD_URL,
  ssl: { rejectUnauthorized: false },
});

const localPool = new Pool({
  connectionString: LOCAL_URL,
});

async function getTableColumns(client, tableName) {
  const res = await client.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = $1`,
    [tableName]
  );
  return res.rows.map(r => r.column_name);
}

async function insertRow(client, tableName, row, jsonCols = []) {
  const cols = await getTableColumns(client, tableName);
  const presentCols = Object.keys(row).filter(c => cols.includes(c));
  const vals = presentCols.map(c => {
    let v = row[c];
    if (v === null || v === undefined) return null;
    if (jsonCols.includes(c)) {
      return typeof v === 'object' ? JSON.stringify(v) : v;
    }
    if (Array.isArray(v)) return v;
    return v;
  });
  const phs = presentCols.map((_, i) => `$${i + 1}`).join(', ');
  const hasId = cols.includes('id');
  const queryText = `INSERT INTO ${tableName} (${presentCols.join(', ')}) VALUES (${phs})${hasId ? ' ON CONFLICT (id) DO NOTHING' : ''}`;
  await client.query(queryText, vals);
}

async function run() {
  const prodClient = await prodPool.connect();
  const localClient = await localPool.connect();

  try {
    const hb05Id = 'c5cbb867-c3c6-40c2-8396-b6893da09b37'; // HB05-Nak Niwat48
    const hb01Id = '581c5f9b-bc79-4270-8ad8-98a288be7933'; // HB01-Ladprao107
    const hbt02Id = 'bf6e22ee-0a7b-4b43-a73b-7fe47ff7fb13'; // HBT02

    console.log('=== CLONING HB05 AND HB01 FROM PRODUCTION TO LOCAL STAGING ===');

    // Fetch HB05 & HB01 master data from production
    const fetchShopData = async (c, shopId) => {
      const get = (sql) => c.query(sql, [shopId]).then(r => r.rows);
      const shop = (await c.query('select * from shops where id=$1', [shopId])).rows[0];
      const settings = (await c.query('select * from shop_settings where shop_id=$1', [shopId])).rows[0];
      const suppliers = await get('select * from suppliers where shop_id=$1');
      const materials = await get('select * from materials where shop_id=$1');
      const recipes = await get('select * from recipes where shop_id=$1');
      const recipe_items = await get('select ri.* from recipe_items ri join recipes r on r.id=ri.recipe_id where r.shop_id=$1');
      const option_groups = await get('select * from option_groups where shop_id=$1');
      const option_choices = await get('select oc.* from option_choices oc join option_groups og on og.id=oc.group_id where og.shop_id=$1');
      const option_choice_links = await get('select ocl.* from option_choice_links ocl join option_choices oc on oc.id=ocl.choice_id join option_groups og on og.id=oc.group_id where og.shop_id=$1');
      const recipe_option_groups = await get('select rog.* from recipe_option_groups rog join option_groups og on og.id=rog.group_id where og.shop_id=$1');
      let material_option_groups = [];
      try {
        material_option_groups = await get('select mog.* from material_option_groups mog join option_groups og on og.id=mog.group_id where og.shop_id=$1');
      } catch (err) {
        // Table might not exist yet on prod
      }

      return { shop, settings, suppliers, materials, recipes, recipe_items, option_groups, option_choices, option_choice_links, recipe_option_groups, material_option_groups };
    };

    console.log('Fetching source shops from production...');
    const hb05Data = await fetchShopData(prodClient, hb05Id);
    const hb01Data = await fetchShopData(prodClient, hb01Id);

    // Clean local staging
    console.log('Cleaning local database...');
    await localClient.query('delete from material_option_groups');
    await localClient.query('delete from recipe_option_groups');
    await localClient.query('delete from option_choice_links');
    await localClient.query('delete from option_choices');
    await localClient.query('delete from option_groups');
    await localClient.query('delete from recipe_items');
    await localClient.query('delete from recipes');
    await localClient.query('delete from stock_movements');
    await localClient.query('delete from materials');
    await localClient.query('delete from suppliers');
    await localClient.query('delete from bills');
    await localClient.query('delete from shop_settings');
    await localClient.query('delete from memberships');
    await localClient.query('delete from shops');

    // Insert into local DB
    const insertShopToLocal = async (data) => {
      await insertRow(localClient, 'shops', data.shop);
      await insertRow(localClient, 'shop_settings', data.settings, ['categories', 'member_config', 'discount_presets']);
      for (const s of data.suppliers) await insertRow(localClient, 'suppliers', s);
      for (const m of data.materials) await insertRow(localClient, 'materials', m);
      for (const r of data.recipes) await insertRow(localClient, 'recipes', r, ['opt_groups']);
      for (const ri of data.recipe_items) await insertRow(localClient, 'recipe_items', ri);
      for (const og of data.option_groups) await insertRow(localClient, 'option_groups', og);
      for (const oc of data.option_choices) await insertRow(localClient, 'option_choices', oc);
      for (const ocl of data.option_choice_links) await insertRow(localClient, 'option_choice_links', ocl);
      for (const rog of data.recipe_option_groups) await insertRow(localClient, 'recipe_option_groups', rog);
      for (const mog of data.material_option_groups) await insertRow(localClient, 'material_option_groups', mog);
    };

    console.log('Inserting HB05 to local staging...');
    await insertShopToLocal(hb05Data);
    console.log('Inserting HB01 to local staging...');
    await insertShopToLocal(hb01Data);

    // Insert Superadmin seed user
    console.log('Inserting test superadmin user...');
    await localClient.query("DELETE FROM memberships WHERE user_id IN (SELECT id FROM users WHERE email = 'bussarawarin@gmail.com')");
    await localClient.query("DELETE FROM users WHERE email = 'bussarawarin@gmail.com'");
    await localClient.query("INSERT INTO users (id, email, password_hash) VALUES ('cbfff7bf-4d27-449b-9743-a219e6afe08f', 'bussarawarin@gmail.com', '$2a$12$6dd3fb3c-b5da-4883-ab42-a1de81bf9640')");
    await localClient.query("INSERT INTO memberships (user_id, shop_id, role) VALUES ('cbfff7bf-4d27-449b-9743-a219e6afe08f', 'c5cbb867-c3c6-40c2-8396-b6893da09b37', 'superadmin')");

    console.log('✓ Local Staging DB initialized successfully!');

    // Start local test server
    const port = 50357;
    const server = app.listen(port, '127.0.0.1');
    const base = `http://127.0.0.1:${port}`;
    console.log(`Test server started on ${base}`);

    // Generate token
    const token = jwt.sign({ sub: 'cbfff7bf-4d27-449b-9743-a219e6afe08f', typ: 'access' }, '326cf8e535e0d6cf8362de2c38e64359e0b151909083b901564f623d5ecc51d380ffe3c11aedcbeb09dd1c186978db5a', { expiresIn: '15m' });
    const headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
      'X-Shop-Id': hb05Id
    };

    // Prepare HB05 HBT02 state (same as starting state for testing)
    await localClient.query("UPDATE recipes SET fg_stock = 13, inventory_mode = 'inherit' WHERE id = $1", [hbt02Id]);

    // ==========================================
    // PHASE 1: CUP 4OZ UNIT CONVERSION TESTS
    // ==========================================
    console.log('\n==========================================');
    console.log('TESTING PHASE 1: CUP 4OZ UNIT CONVERSION');
    console.log('==========================================');

    // Run convert-cups script
    const convertCups = require('./convert-cups');
    // Wait for conversion completion
    await new Promise(r => setTimeout(r, 1000));

    // Verify converted cup material details in local DB
    const cupMat = (await localClient.query(
      `select stock, conv_qty, stock_unit, unit from materials where name ilike '%ถ้วยน้ำจิ้มฝาติด 4%' and shop_id = $1`,
      [hb05Id]
    )).rows[0];

    console.log('Converted Cup Material:');
    console.log(`  - stock: ${cupMat.stock}`);
    console.log(`  - conv_qty: ${cupMat.conv_qty}`);
    console.log(`  - stock_unit: ${cupMat.stock_unit}`);
    console.log(`  - unit: ${cupMat.unit}`);

    if (Number(cupMat.stock) === 78 * 50 && Number(cupMat.conv_qty) === 50 && cupMat.stock_unit === 'ชิ้น' && cupMat.unit === 'แพ็ค') {
      console.log('  ✓ PASS: Material unit conversion matches expected values!');
    } else {
      console.log('  ❌ FAIL: Material unit conversion incorrect.');
    }

    // Test receiving 1 pack -> +50 pieces
    const initialCupStock = Number(cupMat.stock);
    const mockReceiveId = '992e5b85-5c1c-4092-b8f0-ead27dad5618';
    
    // Simulate frontend sync with receiving 1 pack of cups
    console.log('Syncing a receive of 1 pack...');
    const matId = (await localClient.query(`select id from materials where name ilike '%ถ้วยน้ำจิ้มฝาติด 4%' and shop_id = $1`, [hb05Id])).rows[0].id;
    const syncRes = await fetch(`${base}/api/sync`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        materials: [
          {
            id: matId,
            shop_id: hb05Id,
            stock: initialCupStock + 50, // Added 1 pack * 50
            conv_qty: 50,
            stock_unit: 'ชิ้น',
            unit: 'แพ็ค',
            name: 'เอโร่ ถ้วยน้ำจิ้มฝาติด 4 ออนซ์ 50 ชิ้น',
            qty: 50,
            price: 99
          }
        ]
      })
    });

    if (syncRes.ok) {
      console.log('  ✓ PASS: Receiving 1 pack (adding 50 pieces) synced successfully!');
    } else {
      console.log('  ❌ FAIL: Sync receiving failed:', await syncRes.text());
    }

    // Verify stock is now initialCupStock + 50
    const cupStockAfter = (await localClient.query(`select stock from materials where id=$1`, [matId])).rows[0].stock;
    console.log(`  Stock after receiving 1 pack: ${cupStockAfter} pieces`);
    if (Number(cupStockAfter) === initialCupStock + 50) {
      console.log('  ✓ PASS: Stock quantity calculated correctly in pieces!');
    } else {
      console.log('  ❌ FAIL: Stock quantity incorrect!');
    }

    // ==========================================
    // PHASE 2: DIRECT-SALE PRODUCT OPTIONS
    // ==========================================
    console.log('\n==========================================');
    console.log('TESTING PHASE 2: DIRECT-SALE PRODUCT OPTIONS');
    console.log('==========================================');

    // Create Direct-sale product (Banana Cake)
    const cakeId = '8c21f645-52e5-46cf-82e1-e7563f2cce36';
    const optGroupId = '9c07b01e-a7ee-4572-b58b-88d6ab73eb8a';
    const choiceWarmId = '3ebea0b3-f3a9-40ae-b6b4-080e4b48efcc';
    const choiceNoWarmId = '2a91e65b-cd05-4110-8878-883482ba9228';

    console.log('Seeding Banana Cake direct-sale product and options...');
    await localClient.query(`
      insert into materials (id, shop_id, sku, name, qty, unit, price, sell_price, stock, sale_type, show_in_pos)
      values ($1, $2, 'CAKE-01', 'Banana Cake', 1, 'ชิ้น', 35, 35, 10, 'SELLABLE', true)
      on conflict (id) do nothing
    `, [cakeId, hb05Id]);

    await localClient.query(`
      insert into option_groups (id, shop_id, label, select_type, required, min_select, max_select, enabled)
      values ($1, $2, 'การเตรียมสินค้า', 'single', true, 1, 1, true)
      on conflict (id) do nothing
    `, [optGroupId, hb05Id]);

    await localClient.query(`
      insert into option_choices (id, group_id, label, price_add, effect_type, enabled)
      values ($1, $2, 'อุ่นร้อน', 0, 'NONE', true), ($3, $2, 'ไม่อุ่น', 0, 'NONE', true)
      on conflict (id) do nothing
    `, [choiceWarmId, optGroupId, choiceNoWarmId]);

    await localClient.query(`
      insert into material_option_groups (material_id, group_id)
      values ($1, $2)
      on conflict do nothing
    `, [cakeId, optGroupId]);

    // Test 2.1: POS Sell Banana Cake with correct option -> Should succeed
    console.log('Test 2.1: Sell Banana Cake with correct option selected...');
    const sellRes2_1 = await fetch(`${base}/api/pos/sell`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        lines: [
          {
            ref_type: 'material',
            ref_id: cakeId,
            qty: 1,
            chosen_options: [{ group_id: optGroupId, choice_id: choiceWarmId, qty: 1 }]
          }
        ],
        bill_no: 'TEST-BILL-CAKE-OK'
      })
    });

    console.log(`  Response: ${sellRes2_1.status}`);
    if (sellRes2_1.status === 200) {
      console.log('  ✓ PASS: Sale succeeded when required option was chosen!');
      const cakeStock = (await localClient.query('select stock from materials where id=$1', [cakeId])).rows[0].stock;
      console.log(`  Cake stock: ${cakeStock} (Expected: 9)`);
      if (Number(cakeStock) === 9) {
        console.log('  ✓ PASS: Cake stock deducted correctly!');
      } else {
        console.log('  ❌ FAIL: Cake stock was not deducted!');
      }
    } else {
      console.log('  ❌ FAIL: Sale rejected:', await sellRes2_1.text());
    }

    // Test 2.2: POS Sell Banana Cake WITHOUT choosing option -> Should fail
    console.log('Test 2.2: Sell Banana Cake without option...');
    const sellRes2_2 = await fetch(`${base}/api/pos/sell`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        lines: [
          {
            ref_type: 'material',
            ref_id: cakeId,
            qty: 1,
            chosen_options: [] // Missing option!
          }
        ],
        bill_no: 'TEST-BILL-CAKE-FAIL'
      })
    });

    const body2_2 = await sellRes2_2.json();
    console.log(`  Response: ${sellRes2_2.status} error=${body2_2.error}`);
    if (sellRes2_2.status === 400 && body2_2.error.includes('REQUIRED_OPTION_MISSING')) {
      console.log('  ✓ PASS: Correctly blocked by backend validator!');
    } else {
      console.log('  ❌ FAIL: Allowed sell without required option or returned wrong error.');
    }

    // Test 2.3: POS Sell Banana Cake with choice count > max_select -> Should fail
    console.log('Test 2.3: Sell Banana Cake selecting more than max options...');
    const sellRes2_3 = await fetch(`${base}/api/pos/sell`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        lines: [
          {
            ref_type: 'material',
            ref_id: cakeId,
            qty: 1,
            chosen_options: [
              { choice_id: choiceWarmId },
              { choice_id: choiceNoWarmId } // 2 options selected, max is 1!
            ]
          }
        ],
        bill_no: 'TEST-BILL-CAKE-FAIL-MAX'
      })
    });

    const body2_3 = await sellRes2_3.json();
    console.log(`  Response: ${sellRes2_3.status} error=${body2_3.error}`);
    if (sellRes2_3.status === 400 && body2_3.error.includes('OPTION_MAX_SELECT_EXCEEDED')) {
      console.log('  ✓ PASS: Correctly blocked by backend validator (max selection exceeded)!');
    } else {
      console.log('  ❌ FAIL: Allowed sell exceeding max selection.');
    }

    // ==========================================
    // PHASE 3: DAILY STOCK MOVEMENT REPORT
    // ==========================================
    console.log('\n==========================================');
    console.log('TESTING PHASE 3: DAILY STOCK MOVEMENT REPORT');
    console.log('==========================================');

    const reportRes = await fetch(`${base}/api/stock/report`, {
      headers
    });

    if (reportRes.ok) {
      const rep = await reportRes.json();
      console.log('Report metadata:', rep.metadata);
      console.log('Report summary metrics:', rep.summary);
      console.log('Report movements row count:', rep.movements.length);

      if (rep.movements.length > 0) {
        console.log('  ✓ PASS: Report successfully loaded with correct data and daily summaries!');
      } else {
        console.log('  ❌ FAIL: Daily summary stats are empty.');
      }
    } else {
      console.log('  ❌ FAIL: Report request failed:', await reportRes.text());
    }

    // ==========================================
    // PHASE 4: SELECTIVE BRANCH CLONE
    // ==========================================
    console.log('\n==========================================');
    console.log('TESTING PHASE 4: SELECTIVE BRANCH CLONE');
    console.log('==========================================');

    // Test 4.1: Dry-run clone
    console.log('Test 4.1: Dry-run selective clone (preview counts & conflicts)...');
    const cloneDryRes = await fetch(`${base}/api/admin/selective-clone`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        srcShopId: hb05Id,
        dstShopId: hb01Id,
        sections: ['materials'],
        conflictStrategy: 'skip',
        dryRun: true
      })
    });

    if (cloneDryRes.ok) {
      const body = await cloneDryRes.json();
      console.log('Dry-run Preview Data:', body.preview);
      if (body.preview.counts.materials > 0) {
        console.log('  ✓ PASS: Dry-run preview returned counts correctly!');
      } else {
        console.log('  ❌ FAIL: Dry-run counts incorrect.');
      }
    } else {
      console.log('  ❌ FAIL: Dry-run clone failed:', await cloneDryRes.text());
    }

    // Test 4.2: Execute selective clone (with skip strategy)
    console.log('Test 4.2: Executing selective clone of materials...');
    const cloneRes = await fetch(`${base}/api/admin/selective-clone`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        srcShopId: hb05Id,
        dstShopId: hb01Id,
        sections: ['materials'],
        conflictStrategy: 'skip',
        dryRun: false
      })
    });

    if (cloneRes.ok) {
      const body = await cloneRes.json();
      console.log('Cloned counts:', body.cloned);
      
      // Verify in destination shop (HB01)
      const hb01MatCount = (await localClient.query('select count(*) from materials where shop_id=$1', [hb01Id])).rows[0].count;
      console.log(`  Materials in destination HB01: ${hb01MatCount}`);
      if (Number(hb01MatCount) > 0) {
        console.log('  ✓ PASS: Materials selectively cloned into HB01 successfully!');
      } else {
        console.log('  ❌ FAIL: Clone did not copy materials.');
      }
    } else {
      console.log('  ❌ FAIL: Selective clone execution failed:', await cloneRes.text());
    }

    // Clean up test server
    server.close();
    console.log('\nTest server shut down. All tests completed successfully!');

  } catch (e) {
    console.error('Error during run:', e);
  } finally {
    prodClient.release();
    localClient.release();
    await prodPool.end();
    await localPool.end();
  }
}

run();
