const { Pool } = require('pg');
require('dotenv').config();

const dbUrl = process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/recipro';

const pool = new Pool({
  connectionString: dbUrl,
});

async function run() {
  const client = await pool.connect();
  try {
    console.log('=== RUNNING CUP 4OZ UNIT CONVERSION ===');
    
    // Find all cup materials
    const mats = (await client.query(`
      SELECT m.id, m.shop_id, s.name as shop_name, s.code as shop_code, m.name, m.stock, m.qty, m.unit, m.conv_qty, m.stock_unit
        FROM materials m
        JOIN shops s ON s.id = m.shop_id
       WHERE m.name ILIKE '%ถ้วยน้ำจิ้มฝาติด 4%' OR m.name ILIKE '%เอโร่%4%ออนซ์%'
    `)).rows;

    console.log(`Found ${mats.length} cup materials to convert.`);

    for (const m of mats) {
      const shopCode = m.shop_code || m.shop_name.split('-')[0] || 'SHOP';
      const refKey = `CUP4OZ_UNIT_CONVERSION_${shopCode}_20260629`;

      // Check if already converted
      const checkMove = await client.query(
        "SELECT id FROM stock_movements WHERE shop_id = $1 AND note = $2",
        [m.shop_id, refKey]
      );

      if (checkMove.rowCount > 0 || Number(m.conv_qty) === 50) {
        console.log(`- Shop ${m.shop_name}: Material "${m.name}" already converted. Skipping.`);
        continue;
      }

      await client.query('BEGIN');

      const beforeStock = Number(m.stock) || 0;
      const conversionFactor = 50;
      const afterStock = beforeStock * conversionFactor;

      console.log(`Converting "${m.name}" for shop ${m.shop_name}:`);
      console.log(`  - Stock: ${beforeStock} packs -> ${afterStock} pieces`);
      console.log(`  - conv_qty: ${m.conv_qty} -> ${conversionFactor}`);
      console.log(`  - stock_unit: ${m.stock_unit} -> ชิ้น`);

      // 1. Update material
      await client.query(`
        UPDATE materials
           SET conv_qty = $1,
               stock_unit = $2,
               stock = $3,
               qty = $1,
               unit = 'แพ็ค',
               updated_at = now()
         WHERE id = $4
      `, [conversionFactor, 'ชิ้น', afterStock, m.id]);

      // 2. Insert stock movement
      await client.query(`
        INSERT INTO stock_movements (
          shop_id, user_id, kind, ref_type, ref_id, ref_name, unit, qty_before, qty_after, delta, note, consumption_category, actor_name
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13
        )
      `, [
        m.shop_id, null, 'adjust', 'material', m.id, m.name, 'ชิ้น',
        beforeStock, afterStock, afterStock - beforeStock, refKey, 'adjust', 'Founder'
      ]);

      await client.query('COMMIT');
      console.log(`✓ Converted successfully!`);
    }

  } catch (e) {
    await client.query('ROLLBACK');
    console.error('Error during conversion:', e);
  } finally {
    client.release();
    await pool.end();
  }
}

run();
