const { Pool } = require('pg');

const PROD_URL = 'postgresql://postgres:HhpGjcYHzNmWzzfLvvwxDKzmUgxArHpK@thomas.proxy.rlwy.net:23626/railway';

const pool = new Pool({
  connectionString: PROD_URL,
  ssl: { rejectUnauthorized: false },
});

async function run() {
  const client = await pool.connect();
  try {
    const shopId = 'c5cbb867-c3c6-40c2-8396-b6893da09b37'; // HB05-Nak Niwat48
    const hbt02Id = 'bf6e22ee-0a7b-4b43-a73b-7fe47ff7fb13'; // HBT02
    const refKey = 'HBT02_BATCH1_CORRECTION_20260629';

    console.log('=== IDEMPOTENT PRODUCTION CORRECTION CHECK ===');
    
    // Check if movement exists
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

    console.log('Correction not applied yet. Starting transaction...');
    await client.query('BEGIN');

    // Get current recipe state
    const rec = (await client.query(
      "SELECT id, name, fg_stock, yield_unit, inventory_mode FROM recipes WHERE id = $1 AND shop_id = $2 FOR UPDATE",
      [hbt02Id, shopId]
    )).rows[0];

    if (!rec) {
      throw new Error(`Recipe HBT02 not found for shop ${shopId}`);
    }

    const before = Number(rec.fg_stock) || 0;
    const delta = 11;
    const after = before + delta;

    console.log(`Applying correction for "${rec.name}":`);
    console.log(`  - Inventory Mode: ${rec.inventory_mode} -> finished_goods`);
    console.log(`  - Stock: ${before} -> ${after} (delta +${delta})`);

    // 1. Set mode
    await client.query(
      "UPDATE recipes SET inventory_mode = 'finished_goods', updated_at = now() WHERE id = $1",
      [hbt02Id]
    );

    // 2. Log movement
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

    // 3. Update stock
    await client.query(
      "UPDATE recipes SET fg_stock = $1, updated_at = now() WHERE id = $2",
      [after, hbt02Id]
    );

    await client.query('COMMIT');
    console.log(`✓ Staging stock correction applied successfully! Movement ID: ${moveId}`);

  } catch (e) {
    await client.query('ROLLBACK');
    console.error('❌ Error applying production correction:', e);
  } finally {
    client.release();
    await pool.end();
  }
}

// Run only if executed directly
if (require.main === module) {
  run();
}
