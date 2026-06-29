const { Pool } = require('pg');

const PROD_URL = 'postgresql://postgres:HhpGjcYHzNmWzzfLvvwxDKzmUgxArHpK@thomas.proxy.rlwy.net:23626/railway';

const pool = new Pool({
  connectionString: PROD_URL,
  ssl: { rejectUnauthorized: false },
});

async function run() {
  const client = await pool.connect();
  const dryRun = process.argv.includes('--dry-run');

  try {
    const shopId = 'c5cbb867-c3c6-40c2-8396-b6893da09b37'; // HB05-Nak Niwat48
    const hbt02Id = 'bf6e22ee-0a7b-4b43-a73b-7fe47ff7fb13'; // HBT02
    const refKey = 'HBT02_BATCH1_CORRECTION_20260629';

    console.log(dryRun ? '=== IDEMPOTENT PRODUCTION CORRECTION DRY-RUN ===' : '=== IDEMPOTENT PRODUCTION CORRECTION EXECUTION ===');
    
    // 1. Check if movement exists
    const checkMove = await client.query(
      "SELECT id, created_at, qty_before, qty_after FROM stock_movements WHERE shop_id = $1 AND note = $2",
      [shopId, refKey]
    );

    if (checkMove.rowCount > 0) {
      const mv = checkMove.rows[0];
      console.log(`✓ Correction already applied on ${mv.created_at}.`);
      console.log(`  Movement ID: ${mv.id}`);
      console.log(`  Details: Before=${mv.qty_before}, After=${mv.qty_after}`);
      return;
    }

    // 2. Query Shop Name
    const shop = (await client.query("SELECT name FROM shops WHERE id=$1", [shopId])).rows[0];
    const shopName = shop ? shop.name : 'Unknown';

    // 3. Query current recipe state
    const rec = (await client.query(
      "SELECT id, name, fg_stock, yield_unit, inventory_mode FROM recipes WHERE id = $1 AND shop_id = $2",
      [hbt02Id, shopId]
    )).rows[0];

    if (!rec) {
      throw new Error(`Recipe HBT02 not found for shop ${shopId}`);
    }

    const before = Number(rec.fg_stock) || 0;
    const delta = 11;
    const after = before + delta;

    console.log('\n--- PREVIEW ---');
    console.log(`  - Target Shop: ${shopName} (${shopId})`);
    console.log(`  - Target Recipe ID: ${rec.id}`);
    console.log(`  - Recipe Code: HBT02`);
    console.log(`  - Recipe Name: ${rec.name}`);
    console.log(`  - Current Inventory Mode: ${rec.inventory_mode}`);
    console.log(`  - Expected Inventory Mode: finished_goods`);
    console.log(`  - Current fg_stock: ${before} ${rec.yield_unit}`);
    console.log(`  - Correction Delta: +${delta} ${rec.yield_unit}`);
    console.log(`  - Expected fg_stock: ${after} ${rec.yield_unit}`);
    console.log(`  - Correction Reference: "${refKey}"`);
    console.log('----------------\n');

    if (dryRun) {
      console.log('DRY-RUN completed. No data was modified.');
      return;
    }

    console.log('Preconditions checked. Starting execution transaction...');
    await client.query('BEGIN');

    // 4. Set mode
    await client.query(
      "UPDATE recipes SET inventory_mode = 'finished_goods', updated_at = now() WHERE id = $1",
      [hbt02Id]
    );

    // 5. Log movement
    const moveRes = await client.query(`
      INSERT INTO stock_movements (
        shop_id, user_id, kind, ref_type, ref_id, ref_name, unit, qty_before, qty_after, delta, note, consumption_category, actor_name
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13
      ) RETURNING id
    `, [
      shopId, null, 'adjust', 'recipe', hbt02Id, rec.name, rec.yield_unit,
      before, after, delta, refKey, 'adjust', 'Founder'
    ]);
    const moveId = moveRes.rows[0].id;

    // 6. Update stock
    await client.query(
      "UPDATE recipes SET fg_stock = $1, updated_at = now() WHERE id = $2",
      [after, hbt02Id]
    );

    await client.query('COMMIT');
    console.log(`✓ Production stock correction applied successfully!`);
    console.log(`  Movement ID: ${moveId}`);

  } catch (e) {
    await client.query('ROLLBACK');
    console.error('❌ Error during execution:', e);
  } finally {
    client.release();
    await pool.end();
  }
}

run();
