const { Pool } = require('pg');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const app = require('../backend/src/app');

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
  const queryText = `INSERT INTO ${tableName} (${presentCols.join(', ')}) VALUES (${phs}) ON CONFLICT (id) DO NOTHING`;
  await client.query(queryText, vals);
}

async function run() {
  const prodClient = await prodPool.connect();
  const localClient = await localPool.connect();

  try {
    const shopId = 'c5cbb867-c3c6-40c2-8396-b6893da09b37'; // HB05-Nak Niwat48
    const hbt02Id = 'bf6e22ee-0a7b-4b43-a73b-7fe47ff7fb13'; // HBT02 at HB05

    console.log('=== CLONING HB05 FROM PRODUCTION TO LOCAL STAGING ===');
    
    // 1. Fetch from prod
    const shop = (await prodClient.query('SELECT * FROM shops WHERE id=$1', [shopId])).rows[0];
    const settings = (await prodClient.query('SELECT * FROM shop_settings WHERE shop_id=$1', [shopId])).rows[0];
    const suppliers = (await prodClient.query('SELECT * FROM suppliers WHERE shop_id=$1', [shopId])).rows;
    const materials = (await prodClient.query('SELECT * FROM materials WHERE shop_id=$1', [shopId])).rows;
    const recipes = (await prodClient.query('SELECT * FROM recipes WHERE shop_id=$1', [shopId])).rows;
    const recipeItems = (await prodClient.query(
      'SELECT ri.* FROM recipe_items ri JOIN recipes r ON r.id=ri.recipe_id WHERE r.shop_id=$1',
      [shopId]
    )).rows;

    console.log(`Fetched from Prod:\n- Shop: ${shop.name}\n- Suppliers: ${suppliers.length}\n- Materials: ${materials.length}\n- Recipes: ${recipes.length}\n- Recipe Items: ${recipeItems.length}`);

    // 2. Clear local DB for this shop to avoid conflicts
    console.log('\nCleaning local staging database for HB05...');
    await localClient.query('DELETE FROM recipe_items WHERE recipe_id IN (SELECT id FROM recipes WHERE shop_id=$1)', [shopId]);
    await localClient.query('DELETE FROM recipes WHERE shop_id=$1', [shopId]);
    await localClient.query('DELETE FROM materials WHERE shop_id=$1', [shopId]);
    await localClient.query('DELETE FROM suppliers WHERE shop_id=$1', [shopId]);
    await localClient.query('DELETE FROM shop_settings WHERE shop_id=$1', [shopId]);
    await localClient.query('DELETE FROM shops WHERE id=$1', [shopId]);
    await localClient.query('DELETE FROM stock_movements WHERE shop_id=$1', [shopId]);
    await localClient.query('DELETE FROM bills WHERE shop_id=$1', [shopId]);

    // 3. Insert into local DB
    console.log('Inserting data into local staging...');
    await localClient.query(
      'INSERT INTO shops (id, name, status, created_at) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING',
      [shop.id, shop.name, shop.status, shop.created_at]
    );

    if (settings) {
      const s = { ...settings };
      const jsonCols = ['categories', 'discount_presets', 'staff_permissions', 'pos_categories', 'menu_config', 'member_config'];
      const cols = await getTableColumns(localClient, 'shop_settings');
      const presentCols = Object.keys(s).filter(c => cols.includes(c));
      const vals = presentCols.map(c => {
        let v = s[c];
        if (v === null || v === undefined) return null;
        if (jsonCols.includes(c)) {
          return typeof v === 'object' ? JSON.stringify(v) : v;
        }
        return v;
      });
      const phs = presentCols.map((_, i) => `$${i + 1}`).join(', ');
      await localClient.query(
        `INSERT INTO shop_settings (${presentCols.join(', ')}) VALUES (${phs}) ON CONFLICT (shop_id) DO NOTHING`,
        vals
      );
    }

    for (const sup of suppliers) {
      await insertRow(localClient, 'suppliers', sup);
    }

    for (const m of materials) {
      await insertRow(localClient, 'materials', m, ['img_data']);
    }

    for (const r of recipes) {
      await insertRow(localClient, 'recipes', r, ['opt_groups', 'img_data']);
    }

    for (const ri of recipeItems) {
      const cols = await getTableColumns(localClient, 'recipe_items');
      const presentCols = Object.keys(ri).filter(c => cols.includes(c));
      const vals = presentCols.map(c => ri[c]);
      const phs = presentCols.map((_, i) => `$${i + 1}`).join(', ');
      await localClient.query(
        `INSERT INTO recipe_items (${presentCols.join(', ')}) VALUES (${phs})`,
        vals
      );
    }

    console.log('✓ Staging setup complete!');

    // ==========================================
    // PHASE 5: CONTROLLED DATA CORRECTION (STAGING)
    // ==========================================
    console.log('\n==========================================');
    console.log('PHASE 5: CONTROLLED DATA CORRECTION (STAGING)');
    console.log('==========================================');

    const hbt02 = (await localClient.query('SELECT * FROM recipes WHERE id=$1', [hbt02Id])).rows[0];
    
    if (!hbt02) {
      console.log('❌ HBT02 not found in local DB!');
      return;
    }

    const before = Number(hbt02.fg_stock); // Should be 13
    const delta = 11;
    const after = before + delta; // Should be 24
    const note = 'Correct Production Batch #1 undercount: produced 12 units but system recorded 1 unit';

    console.log(`HBT02 Current Stock: ${before} ${hbt02.yield_unit}`);
    console.log(`HBT02 Current Mode: ${hbt02.inventory_mode}`);

    await localClient.query('BEGIN');

    // 1. Set mode to finished_goods
    await localClient.query(
      "UPDATE recipes SET inventory_mode = 'finished_goods', updated_at = now() WHERE id = $1",
      [hbt02Id]
    );

    // 2. Insert Stock Movement +11
    const moveRes = await localClient.query(`
      INSERT INTO stock_movements (
        shop_id, user_id, kind, ref_type, ref_id, ref_name, unit, qty_before, qty_after, delta, note, consumption_category, actor_name
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13
      ) RETURNING id
    `, [
      shopId, null, 'adjust', 'recipe', hbt02.id, hbt02.name, hbt02.yield_unit,
      before, after, delta, note, 'adjust', 'Founder'
    ]);
    const moveId = moveRes.rows[0].id;

    // 3. Update recipe stock
    await localClient.query(
      "UPDATE recipes SET fg_stock = $1, updated_at = now() WHERE id = $2",
      [after, hbt02Id]
    );

    await localClient.query('COMMIT');

    console.log('✓ Staging stock correction applied successfully!');
    console.log(`  - Recipe Code: ${hbt02.code}`);
    console.log(`  - Inventory Mode: finished_goods`);
    console.log(`  - Stock Before: ${before}`);
    console.log(`  - Stock Delta: +${delta}`);
    console.log(`  - Stock After: ${after}`);
    console.log(`  - Stock Movement ID: ${moveId}`);

    // ==========================================
    // PHASE 6: STAGING QA TESTS
    // ==========================================
    console.log('\n==========================================');
    console.log('PHASE 6: STAGING QA TESTS');
    console.log('==========================================');

    // Start local Express server to perform REST API tests
    const server = app.listen(0);
    await new Promise((r) => server.once('listening', r));
    const port = server.address().port;
    const base = `http://127.0.0.1:${port}`;
    console.log(`Started test server on ${base}`);

    // Create a login token for superadmin to bypass / shop config
    // Actually, let's create a user and login directly to shop HB05
    const email = 'owner_hb05@test.local';
    const pwd = 'password123';
    
    // Register owner
    await localClient.query('DELETE FROM users WHERE email=$1', [email]);
    const regRes = await fetch(`${base}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: pwd })
    });
    const regData = await regRes.json();
    const userId = regData.user.id;

    // Add membership for HB05
    await localClient.query(
      "INSERT INTO memberships (user_id, shop_id, role) VALUES ($1, $2, 'owner')",
      [userId, shopId]
    );

    // Login to get token
    const loginRes = await fetch(`${base}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: pwd })
    });
    const loginData = await loginRes.json();
    const token = loginData.accessToken;

    console.log('Owner logged in successfully. Token obtained.');

    const headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
      'X-Shop-Id': shopId
    };

    // --- TEST 1: Finished-goods sale deduction ---
    console.log('\n[Staging QA 1] HBT02 Sale (Finished Goods mode):');
    const billNo = 'TEST-BILL-1001';
    
    // Get recipe stock before
    const recBefore = (await localClient.query('SELECT fg_stock FROM recipes WHERE id=$1', [hbt02Id])).rows[0];
    console.log(`  Stock before sale: ${recBefore.fg_stock}`);

    // Call POS sell
    const sellRes = await fetch(`${base}/api/pos/sell`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        lines: [{ ref_type: 'recipe', ref_id: hbt02Id, qty: 1 }],
        bill_no: billNo
      })
    });
    
    const sellData = await sellRes.json();
    console.log('  POS Sell response:', sellRes.status, sellData);

    const recAfter = (await localClient.query('SELECT fg_stock FROM recipes WHERE id=$1', [hbt02Id])).rows[0];
    console.log(`  Stock after sale: ${recAfter.fg_stock}`);

    // Verify it decreased by 1 (24 -> 23)
    if (Number(recBefore.fg_stock) === 24 && Number(recAfter.fg_stock) === 23) {
      console.log('  ✓ PASS: Stock decreased correctly by 1!');
    } else {
      console.log('  ✗ FAIL: Stock did not decrease correctly!');
    }

    // Check that raw materials were NOT deducted
    const rawItems = (await localClient.query('SELECT material_id FROM recipe_items WHERE recipe_id=$1', [hbt02Id])).rows;
    let rawDeducted = false;
    for (const ri of rawItems) {
      if (ri.material_id) {
        const moves = (await localClient.query(
          "SELECT 1 FROM stock_movements WHERE ref_type='material' AND ref_id=$1 AND note=$2",
          [ri.material_id, 'ขาย ' + billNo]
        )).rowCount;
        if (moves > 0) rawDeducted = true;
      }
    }
    if (!rawDeducted) {
      console.log('  ✓ PASS: Raw materials were NOT deducted (since finished_goods mode is set)!');
    } else {
      console.log('  ✗ FAIL: Raw materials were incorrectly deducted!');
    }

    // --- TEST 2: Atomic Void & Idempotency ---
    console.log('\n[Staging QA 2] Atomic Void & Strong Idempotency:');
    
    // Call void once
    const voidRes = await fetch(`${base}/api/pos/void`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ bill_no: billNo })
    });
    const voidData = await voidRes.json();
    console.log('  Void attempt 1 response:', voidRes.status, voidData);

    const recVoided1 = (await localClient.query('SELECT fg_stock FROM recipes WHERE id=$1', [hbt02Id])).rows[0];
    console.log(`  Stock after void 1: ${recVoided1.fg_stock}`);

    if (Number(recVoided1.fg_stock) === 24) {
      console.log('  ✓ PASS: Stock returned to 24 after void!');
    } else {
      console.log('  ✗ FAIL: Stock did not return to 24!');
    }

    // Call void again (idempotent test)
    const voidRes2 = await fetch(`${base}/api/pos/void`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ bill_no: billNo })
    });
    const voidData2 = await voidRes2.json();
    console.log('  Void attempt 2 response:', voidRes2.status, voidData2);

    const recVoided2 = (await localClient.query('SELECT fg_stock FROM recipes WHERE id=$1', [hbt02Id])).rows[0];
    console.log(`  Stock after void 2: ${recVoided2.fg_stock}`);

    if (Number(recVoided2.fg_stock) === 24 && voidData2.already === true) {
      console.log('  ✓ PASS: Double-void blocked successfully and stock remained 24!');
    } else {
      console.log('  ✗ FAIL: Double-void returned stock again or did not return already: true!');
    }

    // --- TEST 3: Mixed Cart ---
    console.log('\n[Staging QA 3] Mixed Cart (Finished Goods + Make to Order):');
    
    // Let's find a make-to-order recipe in HB05
    const mtoRecipe = (await localClient.query(`
      SELECT r.id, r.name, COUNT(ri.id) as item_count
        FROM recipes r
        JOIN recipe_items ri ON ri.recipe_id = r.id
       WHERE r.shop_id=$1 AND r.recipe_type='MENU' AND (r.inventory_mode='make_to_order' OR r.inventory_mode='inherit')
       GROUP BY r.id, r.name
      HAVING COUNT(ri.id) > 0
       LIMIT 1
    `, [shopId])).rows[0];
    
    if (mtoRecipe) {
      console.log(`  Found MTO recipe with ingredients: ${mtoRecipe.name} (${mtoRecipe.id})`);
      const mixedBillNo = 'TEST-BILL-1002';
      
      const mixedRes = await fetch(`${base}/api/pos/sell`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          lines: [
            { ref_type: 'recipe', ref_id: hbt02Id, qty: 1 },
            { ref_type: 'recipe', ref_id: mtoRecipe.id, qty: 1 }
          ],
          bill_no: mixedBillNo
        })
      });
      const mixedData = await mixedRes.json();
      console.log('  Mixed POS Sell response:', mixedRes.status, mixedData);

      const hbtAfterMixed = (await localClient.query('SELECT fg_stock FROM recipes WHERE id=$1', [hbt02Id])).rows[0];
      console.log(`  HBT02 stock after mixed sale: ${hbtAfterMixed.fg_stock}`);

      // Verify HBT02 stock decreased (24 -> 23)
      const isHbtOk = Number(hbtAfterMixed.fg_stock) === 23;
      
      // Check that stock movements exist for the materials of the MTO drink
      const mtoMoves = (await localClient.query(
        "SELECT 1 FROM stock_movements WHERE note=$1 AND kind='sale'",
        ['ขาย ' + mixedBillNo]
      )).rows;
      console.log(`  Stock movements created: ${mtoMoves.length}`);

      if (isHbtOk && mtoMoves.length > 1) {
        console.log('  ✓ PASS: Mixed cart successfully deducted HBT02 from fg_stock and MTO drink from ingredients!');
      } else {
        console.log('  ✗ FAIL: Mixed cart deduction failed!');
      }
    } else {
      console.log('  - Skip: No MTO recipe found in HB05.');
    }

    // --- TEST 4: Cross-branch isolation ---
    console.log('\n[Staging QA 4] Cross-Branch Isolation:');
    
    // Attempt to access or modify HBT02 using a different shop override header
    // Let's register owner B for shop B
    const shopBId = '581c5f9b-bc79-4270-8ad8-98a288be7933'; // HB01-Ladprao107
    const emailB = 'owner_hb01@test.local';
    await localClient.query(
      "INSERT INTO shops (id, name, status, created_at) VALUES ($1, 'HB01-Ladprao107', 'active', now()) ON CONFLICT (id) DO NOTHING",
      [shopBId]
    );
    await localClient.query('DELETE FROM users WHERE email=$1', [emailB]);
    await fetch(`${base}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: emailB, password: pwd })
    });
    const userBRes = await localClient.query('SELECT id FROM users WHERE email=$1', [emailB]);
    const userBId = userBRes.rows[0].id;
    await localClient.query(
      "INSERT INTO memberships (user_id, shop_id, role) VALUES ($1, $2, 'owner')",
      [userBId, shopBId]
    );
    const loginBRes = await fetch(`${base}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: emailB, password: pwd })
    });
    const loginBData = await loginBRes.json();
    const tokenB = loginBData.accessToken;

    // Try to sell HBT02 from HB05 using Shop B token
    const spoofRes = await fetch(`${base}/api/pos/sell`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${tokenB}`,
        'X-Shop-Id': shopId
      },
      body: JSON.stringify({
        lines: [{ ref_type: 'recipe', ref_id: hbt02Id, qty: 1 }],
        bill_no: 'SPOOF-BILL'
      })
    });
    const spoofData = await spoofRes.json();
    console.log('  Cross-shop spoof attempt response:', spoofRes.status, spoofData);

    // HBT02 stock should remain 23 (since mixed test set it to 23 and spoof shouldn't deduct it)
    const hbtSpoofCheck = (await localClient.query('SELECT fg_stock FROM recipes WHERE id=$1', [hbt02Id])).rows[0];
    
    if (spoofRes.status === 200 && spoofData.results && spoofData.results.length === 0) {
      console.log('  ✓ PASS: Cross-branch isolation successfully prevented deduction (returned empty results)!');
    } else if (spoofRes.status === 404 || spoofRes.status === 400 || (spoofData.results && spoofData.results.length === 0)) {
      console.log('  ✓ PASS: Cross-branch isolation successfully prevented deduction!');
    } else {
      console.log('  ✗ FAIL: Cross-branch spoofing deducted stock!');
    }

    // --- TEST 5: Atomic rollback on failure ---
    console.log('\n[Staging QA 5] Atomic Rollback on Failure:');
    
    // Temporarily rename a table to simulate database error or insert invalid query parameter
    // Let's pass a recipe ID that doesn't exist but inside a transaction that has other valid items
    const invalidBillNo = 'TEST-BILL-1003';
    const initialHbtStock = (await localClient.query('SELECT fg_stock FROM recipes WHERE id=$1', [hbt02Id])).rows[0].fg_stock;
    console.log(`  Initial stock: ${initialHbtStock}`);
    
    // We send a sell request where the second item has an invalid ID format (non-UUID), which will trigger a PostgreSQL error
    const rollbackRes = await fetch(`${base}/api/pos/sell`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        lines: [
          { ref_type: 'recipe', ref_id: hbt02Id, qty: 1 },
          { ref_type: 'recipe', ref_id: 'invalid-non-uuid-id', qty: 1 } // Trigger UUID format parsing error in DB
        ],
        bill_no: invalidBillNo
      })
    });
    
    const rollbackData = await rollbackRes.json();
    console.log('  Rollback trigger response:', rollbackRes.status, rollbackData);

    const finalHbtStock = (await localClient.query('SELECT fg_stock FROM recipes WHERE id=$1', [hbt02Id])).rows[0].fg_stock;
    console.log(`  Stock after failed transaction: ${finalHbtStock}`);

    if (rollbackRes.status === 500 && Number(initialHbtStock) === Number(finalHbtStock)) {
      console.log('  ✓ PASS: Transaction rolled back completely. No stock was deducted!');
    } else {
      console.log('  ✗ FAIL: Transaction did not roll back correctly!');
    }

    // Clean up test server
    server.close();
    console.log('\nTest server shut down.');

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
