// POST /api/sync — อัปเซิร์ตข้อมูลร้านปัจจุบันทั้งก้อน (แทน syncToSupabase())
// รับ payload ที่ frontend map เป็น snake_case แล้ว; server บังคับ shop_id = req.shopId เสมอ (กันเขียนข้ามร้าน)
const express = require('express');
const { tx } = require('../db');
const router = express.Router();

// upsert ช่วย: ระบุ table, คอลัมน์, แถว, และคีย์ conflict
async function upsertRows(client, table, cols, rows, conflict) {
  for (const row of rows) {
    const values = cols.map((c) => row[c]);
    const ph = cols.map((_, i) => `$${i + 1}`).join(', ');
    const updates = cols.filter((c) => c !== conflict)
      .map((c) => `${c} = excluded.${c}`).join(', ');
    await client.query(
      `insert into ${table} (${cols.join(', ')}) values (${ph})
       on conflict (${conflict}) do update set ${updates}`,
      values
    );
  }
}

router.post('/sync', async (req, res) => {
  const shopId = req.shopId;
  if (!shopId) return res.status(400).json({ error: 'No current shop' });
  const b = req.body || {};

  try {
    await tx(async (client) => {
      const withShop = (arr) => (arr || []).map((x) => ({ ...x, shop_id: shopId }));

      await upsertRows(client, 'suppliers',
        ['id', 'shop_id', 'name', 'note'], withShop(b.suppliers), 'id');

      await upsertRows(client, 'materials',
        ['id', 'shop_id', 'name', 'qty', 'unit', 'price', 'supplier_id', 'order_url', 'stock', 'low_stock'],
        withShop(b.materials), 'id');

      await upsertRows(client, 'recipes',
        ['id', 'shop_id', 'code', 'name', 'sell_price', 'batch_yield', 'yield_unit', 'is_raw', 'steps', 'fg_stock', 'fg_low'],
        withShop(b.recipes), 'id');

      // recipe_items: ลบของสูตรในร้านนี้ทั้งหมดแล้วใส่ใหม่ (ตรงกับ logic เดิม)
      const recIds = (b.recipes || []).map((r) => r.id);
      if (recIds.length) {
        await client.query('delete from recipe_items where recipe_id = any($1::uuid[])', [recIds]);
        for (const it of (b.recipe_items || [])) {
          await client.query(
            'insert into recipe_items (recipe_id, material_id, amount) values ($1, $2, $3)',
            [it.recipe_id, it.material_id || null, it.amount]
          );
        }
      }

      await upsertRows(client, 'bills',
        ['id', 'shop_id', 'number', 'status', 'items_json'], withShop(b.bills), 'id');

      if (b.shop_settings) {
        const s = { ...b.shop_settings, shop_id: shopId };
        await upsertRows(client, 'shop_settings',
          ['shop_id', 'phone', 'tax_id', 'address', 'bank', 'account', 'holder', 'promptpay', 'logo_url', 'theme'],
          [s], 'shop_id');
      }

      if (b.shop && b.shop.name) {
        await client.query('update shops set name = $1 where id = $2', [b.shop.name, shopId]);
      }
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
