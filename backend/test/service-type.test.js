// ARCH-2: first-class SERVICE item_type — backend tests. node backend/test/service-type.test.js
//
// Covers: migration idempotency, catalog exposure, deduction safety (the core
// invariant — a SERVICE material must never deduct stock), unchanged RESALE
// (SALE) behavior, the narrow behavior_type='G'+item_type='ASSET' remap, and
// the frontend Type-G contract (SERVICE mapping, quick-sell exclusion,
// deriveBehaviorType SERVICE+legacy-ASSET branches, fallback catalog row).
//
// NOTE: requires `npm run migrate` to have been run against the local dev DB
// first (registers + applies backend/db/schema-service-type.sql).
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const fs = require('fs');
const path = require('path');
const { pool, query } = require('../src/db');
const { deductMaterial, loadCats } = require('../src/stockEngine');

let passed = 0, failed = 0;
function check(name, cond, extra) { if (cond) { passed++; console.log('  ✓', name); } else { failed++; console.log('  ✗', name, extra !== undefined ? JSON.stringify(extra) : ''); } }

const SCHEMA_SQL = fs.readFileSync(path.join(__dirname, '../db/schema-service-type.sql'), 'utf8');
const STOCK_ENGINE_SRC = fs.readFileSync(path.join(__dirname, '../src/stockEngine.js'), 'utf8');
const INDEX_HTML_SRC = fs.readFileSync(path.join(__dirname, '../../frontend/index.html'), 'utf8');

(async () => {
  const sfx = Math.random().toString(36).slice(2, 8);
  const tempMatIds = [];
  let shopId = null;
  try {
    console.log('\n=== ARCH-2 — SERVICE item_type (schema-service-type.sql) ===\n');

    // ---------------------------------------------------------------------
    // 1. Migration idempotency: run the schema content twice → no error,
    //    exactly one SERVICE row with the expected flags.
    // ---------------------------------------------------------------------
    await query(SCHEMA_SQL);
    await query(SCHEMA_SQL);
    const svcRows = (await query("select * from item_categories where code='SERVICE'")).rows;
    check('1 Exactly one SERVICE row after running schema twice', svcRows.length === 1, svcRows.length);
    const svc = svcRows[0] || {};
    check('1 SERVICE is_stock_deducted=false', svc.is_stock_deducted === false, svc.is_stock_deducted);
    check('1 SERVICE deduct_event=none', svc.deduct_event === 'none', svc.deduct_event);
    check('1 SERVICE can_be_recipe_output=false', svc.can_be_recipe_output === false, svc.can_be_recipe_output);

    // ---------------------------------------------------------------------
    // 2. Category catalog: item_categories select includes SERVICE
    //    (bootstrap does a plain `select *` so this proves catalog exposure).
    // ---------------------------------------------------------------------
    const allCats = (await query('select * from item_categories')).rows;
    check('2 item_categories catalog includes SERVICE', allCats.some((c) => c.code === 'SERVICE'), allCats.map((c) => c.code));

    // ---------------------------------------------------------------------
    // Shared temp shop for the deduction-safety tests.
    // ---------------------------------------------------------------------
    shopId = (await query("insert into shops(name) values($1) returning id", ['ARCH2-test-' + sfx])).rows[0].id;
    const cats = await loadCats(pool);

    // ---------------------------------------------------------------------
    // 3. Deduction safety (the core): item_type='SERVICE', stock=5 → skip,
    //    stock unchanged, zero stock_movements rows.
    // ---------------------------------------------------------------------
    {
      const mat = (await query(
        "insert into materials(shop_id,name,unit,stock,item_type) values($1,$2,$3,5,'SERVICE') returning id",
        [shopId, 'Service fixture ' + sfx, 'ครั้ง']
      )).rows[0];
      tempMatIds.push(mat.id);
      const res = await deductMaterial(pool, shopId, null, cats, mat.id, 2, 'on_sale', 'test-service');
      check('3 SERVICE deductMaterial() returns type:skip', res.type === 'skip', res);
      const after = (await query('select stock from materials where id=$1', [mat.id])).rows[0];
      check('3 SERVICE stock unchanged (still 5)', Number(after.stock) === 5, after.stock);
      const moves = (await query("select count(*)::int c from stock_movements where ref_id=$1", [mat.id])).rows[0];
      check('3 SERVICE zero stock_movements rows created', moves.c === 0, moves.c);
    }

    // ---------------------------------------------------------------------
    // 4. RESALE (SALE) unchanged: direct sale still deducts own stock.
    // ---------------------------------------------------------------------
    {
      const mat = (await query(
        "insert into materials(shop_id,name,unit,stock,item_type) values($1,$2,$3,5,'SALE') returning id",
        [shopId, 'Resale fixture ' + sfx, 'ชิ้น']
      )).rows[0];
      tempMatIds.push(mat.id);
      const res = await deductMaterial(pool, shopId, null, cats, mat.id, 2, 'on_sale', 'test-resale');
      check('4 SALE deductMaterial() returns type:material', res.type === 'material', res);
      const after = (await query('select stock from materials where id=$1', [mat.id])).rows[0];
      check('4 SALE stock deducted 5→3', Number(after.stock) === 3, after.stock);
      const moves = (await query("select count(*)::int c from stock_movements where ref_id=$1", [mat.id])).rows[0];
      check('4 SALE stock_movements row created', moves.c === 1, moves.c);
    }

    // ---------------------------------------------------------------------
    // 5. Narrow remap: only behavior_type='G' + item_type='ASSET' rows flip
    //    to SERVICE. Genuine assets (behavior_type NULL) are untouched.
    //    Already-SERVICE rows with behavior_type='G' are a no-op (idempotent).
    // ---------------------------------------------------------------------
    {
      const gAsset = (await query(
        "insert into materials(shop_id,name,unit,item_type,behavior_type) values($1,$2,'ครั้ง','ASSET','G') returning id",
        [shopId, 'Remap-G-ASSET ' + sfx]
      )).rows[0];
      const genuineAsset = (await query(
        "insert into materials(shop_id,name,unit,item_type,behavior_type) values($1,$2,'ชิ้น','ASSET',null) returning id",
        [shopId, 'Remap-genuine-ASSET ' + sfx]
      )).rows[0];
      const alreadyService = (await query(
        "insert into materials(shop_id,name,unit,item_type,behavior_type) values($1,$2,'ครั้ง','SERVICE','G') returning id",
        [shopId, 'Remap-already-SERVICE ' + sfx]
      )).rows[0];
      tempMatIds.push(gAsset.id, genuineAsset.id, alreadyService.id);

      await query("update materials set item_type='SERVICE' where behavior_type='G' and item_type='ASSET'");

      const a = (await query('select item_type from materials where id=$1', [gAsset.id])).rows[0];
      check('5a behavior_type=G + item_type=ASSET → remapped to SERVICE', a.item_type === 'SERVICE', a.item_type);

      const b = (await query('select item_type from materials where id=$1', [genuineAsset.id])).rows[0];
      check('5b behavior_type=NULL + item_type=ASSET (genuine asset) → stays ASSET', b.item_type === 'ASSET', b.item_type);

      const c = (await query('select item_type from materials where id=$1', [alreadyService.id])).rows[0];
      check('5c behavior_type=G + item_type=SERVICE (already migrated) → unchanged (idempotent)', c.item_type === 'SERVICE', c.item_type);
    }

    // ---------------------------------------------------------------------
    // 6. Unknown item_type behavior UNCHANGED: this PR did not alter
    //    deductMaterial()'s guard — documents the boundary.
    // ---------------------------------------------------------------------
    check(
      '6 stockEngine.js deductMaterial() guard unchanged (exact source match)',
      STOCK_ENGINE_SRC.includes("cat && cat.deducted === false && !(m.item_type === 'SALE' && isDirectSale)"),
      null
    );

    // ---------------------------------------------------------------------
    // 7. Frontend Type-G contract (text-level, DB-free, locks the contract).
    // ---------------------------------------------------------------------
    console.log('\n--- 7. frontend/index.html Type-G contract ---');
    check(
      '7a MATERIAL_BEHAVIOR_FIELD_MAP.G maps itemType to SERVICE',
      /G:\s*\{\s*itemType:\s*'SERVICE'/.test(INDEX_HTML_SRC),
      null
    );
    check(
      '7b deriveBehaviorType has itemType===SERVICE → G branch',
      /if\s*\(m\.itemType === 'SERVICE'\)\s*return 'G';/.test(INDEX_HTML_SRC),
      null
    );
    check(
      '7c deriveBehaviorType keeps legacy itemType===ASSET → G branch',
      /if\s*\(m\.itemType === 'ASSET'\)\s*return 'G';/.test(INDEX_HTML_SRC),
      null
    );
    check(
      '7d quick-sell button excludes SERVICE (itemType!==SALE && itemType!==SERVICE)',
      /m\.itemType !== 'SALE' && m\.itemType !== 'SERVICE'/.test(INDEX_HTML_SRC),
      null
    );
    check(
      '7e fallback catalog array (DEFAULT_ITEM_CATEGORIES) includes SERVICE',
      /code:'SERVICE',\s*name_th:'บริการ'/.test(INDEX_HTML_SRC),
      null
    );

  } catch (err) {
    console.error('UNEXPECTED ERROR:', err.message, err.stack);
    failed++;
  } finally {
    // Clean up temp rows.
    try {
      if (tempMatIds.length) {
        await query('delete from stock_movements where ref_id = any($1::uuid[])', [tempMatIds]);
        await query('delete from materials where id = any($1::uuid[])', [tempMatIds]);
      }
      if (shopId) await query('delete from shops where id=$1', [shopId]);
    } catch (cleanupErr) {
      console.error('cleanup error:', cleanupErr.message);
    }
    await pool.end();
    console.log('\n=== Results: ' + passed + ' passed, ' + failed + ' failed ===');
    process.exit(failed > 0 ? 1 : 0);
  }
})();
