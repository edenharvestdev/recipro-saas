const { Pool } = require('pg');

const PROD_URL = 'postgresql://postgres:HhpGjcYHzNmWzzfLvvwxDKzmUgxArHpK@thomas.proxy.rlwy.net:23626/railway';

const pool = new Pool({
  connectionString: PROD_URL,
  ssl: { rejectUnauthorized: false },
});

async function run() {
  const client = await pool.connect();
  try {
    const q = `
      SELECT m.id, m.shop_id, s.name as shop_name, m.name as material_name, m.qty, m.unit, m.price, m.stock, m.low_stock,
             sup.name as supplier_name, m.conv_qty, m.stock_unit
        FROM materials m
        JOIN shops s ON s.id = m.shop_id
        LEFT JOIN suppliers sup ON sup.id = m.supplier_id
       WHERE m.name ILIKE '%ถ้วยน้ำจิ้มฝาติด 4%' OR m.name ILIKE '%เอโร่%4%ออนซ์%'
       ORDER BY s.name, m.name
    `;
    const mats = (await client.query(q)).rows;

    let md = '| Recipe Code | Recipe Name | Branch | Current Amount | Current Unit | Batch Yield | Proposed Amount in Pieces | Cost Impact | Stock Impact | Is Conversion Safe |\n';
    md += '|---|---|---|---|---|---|---|---|---|---|\n';

    for (const m of mats) {
      const recQuery = `
        SELECT r.code as recipe_code, r.name as recipe_name, r.batch_yield, r.yield_unit, ri.amount, ri.role
          FROM recipe_items ri
          JOIN recipes r ON r.id = ri.recipe_id
         WHERE ri.material_id = $1
      `;
      const recs = (await client.query(recQuery, [m.id])).rows;
      
      const costPerPiece = m.price / (m.conv_qty || 50);
      const currentStock = Number(m.stock);

      if (recs.length === 0) {
        md += `| N/A | N/A | ${m.shop_name} | 0 | ${m.unit} | N/A | 0 | Price: ${m.price} per ${m.qty} ${m.unit}. Cost/pcs (conv=50): ${costPerPiece.toFixed(4)} THB | Current stock: ${currentStock} ${m.unit} = ${currentStock * 50} pieces | No active recipes |\n`;
      }

      for (const r of recs) {
        const currentAmount = Number(r.amount);
        
        md += `| ${r.recipe_code} | ${r.recipe_name} | ${m.shop_name} | ${currentAmount} | ${m.unit} | ${r.batch_yield} ${r.yield_unit} | ${currentAmount} | Price: ${m.price} per ${m.qty} ${m.unit}. Cost of recipe item: ${(currentAmount * (m.price / m.qty)).toFixed(2)} THB | Current stock: ${currentStock} ${m.unit} (${currentStock * 50} pieces). Deduction: ${currentAmount} pieces = ${(currentAmount / 50).toFixed(2)} packs | Yes, if material unit changed to "ชิ้น" and stock converted from packs to pieces (e.g. 78 packs -> 3900 pieces) |\n`;
      }
    }

    console.log('\n=== MD_TABLE_START ===');
    console.log(md);
    console.log('=== MD_TABLE_END ===');

  } catch (e) {
    console.error(e);
  } finally {
    client.release();
    await pool.end();
  }
}

run();
