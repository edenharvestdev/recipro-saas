// POST /api/sync — อัปเซิร์ตข้อมูลร้านปัจจุบันทั้งก้อน (แทน syncToSupabase())
// รับ payload ที่ frontend map เป็น snake_case แล้ว; server บังคับ shop_id = req.shopId เสมอ (กันเขียนข้ามร้าน)
const express = require('express');
const { tx } = require('../db');
const { logEvent } = require('../logs');
const router = express.Router();

// upsert ช่วย: ระบุ table, คอลัมน์, แถว, และคีย์ conflict
async function upsertRows(client, table, cols, rows, conflict, touchUpdatedAt) {
  for (const row of rows) {
    const values = cols.map((c) => row[c]);
    const ph = cols.map((_, i) => `$${i + 1}`).join(', ');
    let updates = cols.filter((c) => c !== conflict)
      .map((c) => `${c} = excluded.${c}`).join(', ');
    if (touchUpdatedAt) updates += ', updated_at = now()'; // R2: ให้ /changes ตรวจจับการแก้ไขได้
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
        ['id', 'shop_id', 'sku', 'name', 'qty', 'unit', 'price', 'sell_price', 'supplier_id', 'order_url', 'stock', 'low_stock', 'category', 'conv_qty', 'stock_unit', 'is_consumable', 'sale_type', 'show_in_pos', 'sale_price_2', 'item_type', 'img_data'],
        withShop(b.materials), 'id', true);

      await upsertRows(client, 'recipes',
        ['id', 'shop_id', 'code', 'name', 'sell_price', 'batch_yield', 'yield_unit', 'is_raw', 'steps', 'fg_stock', 'fg_low', 'category', 'opt_groups', 'img_data', 'is_sop', 'recipe_type', 'output_item_type', 'on_menu'],
        withShop((b.recipes || []).map(r => ({
          ...r,
          opt_groups: r.opt_groups == null ? null : (typeof r.opt_groups === 'string' ? r.opt_groups : JSON.stringify(r.opt_groups))
        }))), 'id', true);

      // recipe_items: ลบของสูตรในร้านนี้ทั้งหมดแล้วใส่ใหม่ (ตรงกับ logic เดิม)
      const recIds = (b.recipes || []).map((r) => r.id);
      if (recIds.length) {
        await client.query('delete from recipe_items where recipe_id = any($1::uuid[])', [recIds]);
        for (const it of (b.recipe_items || [])) {
          // null-guard FK: ถ้าวัตถุดิบ/สูตรย่อยถูกลบไปแล้ว ให้ลงเป็น null แทน — กัน FK violation ทำทั้ง sync rollback
          await client.query(
            `insert into recipe_items (recipe_id, material_id, amount, role, sub_recipe_id)
             select $1, (select id from materials where id = $2), $3, $4, (select id from recipes where id = $5)
             where exists (select 1 from recipes where id = $1)`,
            [it.recipe_id, it.material_id || null, it.amount, it.role || '', it.sub_recipe_id || null]
          );
        }
      }

      await upsertRows(client, 'bills',
        ['id', 'shop_id', 'number', 'status', 'items_json'], withShop(b.bills), 'id');

      await upsertRows(client, 'prod_logs',
        ['id', 'shop_id', 'recipe_id', 'recipe_name', 'rounds', 'made', 'log_date'],
        withShop(b.prod_logs || []), 'id');

      await upsertRows(client, 'stock_receives',
        ['id', 'shop_id', 'received_at', 'note', 'lines'],
        withShop((b.stock_receives || []).map(r => ({
          ...r,
          lines: typeof r.lines === 'string' ? r.lines : JSON.stringify(r.lines)
        }))), 'id');

      if (b.shop_settings) {
        const s = { ...b.shop_settings, shop_id: shopId };
        if (s.categories != null && typeof s.categories !== 'string') s.categories = JSON.stringify(s.categories);
        await upsertRows(client, 'shop_settings',
          ['shop_id', 'phone', 'tax_id', 'address', 'bank', 'account', 'holder', 'promptpay', 'logo_url', 'theme', 'categories', 'make_to_order', 'use_petty_cash', 'public_menu_enabled', 'use_delivery', 'order_payment_mode'],
          [s], 'shop_id');
      }

      await upsertRows(client, 'expenses',
        ['id', 'shop_id', 'expense_date', 'category', 'description', 'amount', 'payment_type', 'note', 'kind', 'slip_data'],
        withShop(b.expenses || []), 'id');

      await upsertRows(client, 'recurring_expenses',
        ['id', 'shop_id', 'name', 'category', 'default_amount', 'day_of_month', 'active'],
        withShop(b.recurring_expenses || []), 'id');

      await upsertRows(client, 'cash_topups',
        ['id', 'shop_id', 'topup_date', 'amount', 'note'],
        withShop(b.cash_topups || []), 'id');

      // option_groups
      await upsertRows(client, 'option_groups',
        ['id', 'shop_id', 'label', 'select_type', 'required', 'min_select', 'max_select', 'sort', 'enabled'],
        withShop(b.option_groups || []), 'id');

      // option_choices
      for (const c of (b.option_choices || [])) {
        await client.query(
          `insert into option_choices (id,group_id,label,price_add,effect_type,enabled,is_default,sort,max_qty,target_role,variant_recipe_id,is_metadata_only,amount,target_material_id)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,(select id from recipes where id = $11),$12,$13,(select id from materials where id = $14))
           on conflict (id) do update set group_id=$2,label=$3,price_add=$4,effect_type=$5,enabled=$6,is_default=$7,sort=$8,max_qty=$9,target_role=$10,variant_recipe_id=(select id from recipes where id = $11),is_metadata_only=$12,amount=$13,target_material_id=(select id from materials where id = $14)`,
          [c.id, c.group_id, c.label, c.price_add ?? 0, c.effect_type || 'NONE',
           c.enabled ?? true, c.is_default ?? false, c.sort ?? 0, c.max_qty ?? 1,
           c.target_role || '', c.variant_recipe_id || null, c.is_metadata_only ?? false, c.amount ?? 0, c.target_material_id || null]);
      }

      // option_choice_links: delete+reinsert for all groups synced
      const groupIds = (b.option_groups || []).map(g => g.id);
      if (groupIds.length) {
        await client.query(
          'delete from option_choice_links where choice_id in (select id from option_choices where group_id = any($1::uuid[]))',
          [groupIds]);
        for (const l of (b.option_choice_links || [])) {
          // material_id เป็น NOT NULL — ถ้าวัตถุดิบ/choice ถูกลบแล้ว ข้ามแถวนี้ (กัน FK violation rollback ทั้ง sync)
          await client.query(
            `insert into option_choice_links (id,choice_id,material_id,amount)
             select $1,$2,$3,$4
             where exists (select 1 from materials where id=$3)
               and exists (select 1 from option_choices where id=$2)`,
            [l.id, l.choice_id, l.material_id, l.amount]);
        }
        await client.query('delete from recipe_option_groups where group_id = any($1::uuid[])', [groupIds]);
        for (const rg of (b.recipe_option_groups || [])) {
          // recipe_id/group_id เป็น NOT NULL — ถ้าสูตร/กลุ่มถูกลบแล้ว ข้ามแถวนี้ (กัน FK violation rollback ทั้ง sync)
          await client.query(
            `insert into recipe_option_groups (recipe_id,group_id,sort)
             select $1,$2,$3
             where exists (select 1 from recipes where id=$1)
               and exists (select 1 from option_groups where id=$2)
             on conflict do nothing`,
            [rg.recipe_id, rg.group_id, rg.sort ?? 0]);
        }
      }

      if (b.shop && b.shop.name) {
        await client.query('update shops set name = $1 where id = $2', [b.shop.name, shopId]);
      }
    });
    logEvent(shopId, req.userId, 'data.sync', {
      suppliers: (b.suppliers || []).length, materials: (b.materials || []).length,
      recipes: (b.recipes || []).length, bills: (b.bills || []).length,
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
