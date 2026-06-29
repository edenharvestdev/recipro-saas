// เฟส 2: โคลน/นำเข้า-ส่งออกข้อมูลร้าน (master data) ข้ามสาขา
// แก้จุดบกพร่องเดิม: สร้าง id ใหม่ทุกตัว + remap การอ้างอิงทั้งหมด (recipe_items, สูตรย่อย, options)
// → ไม่ชน primary key ข้ามร้าน · โคลน options ครบ · สต๊อกตั้งต้น 0
const express = require('express');
const { query, tx } = require('../db');
const { logEvent } = require('../logs');
const router = express.Router();

// ---- รวบรวมข้อมูล master ของร้าน (ใช้ทั้ง export และ clone) ----
async function gatherFullShopData(c, shopId) {
  const get = (sql) => c.query(sql, [shopId]).then(r => r.rows);
  const suppliers = await get('select * from suppliers where shop_id=$1');
  const materials = await get('select * from materials where shop_id=$1');
  const recipes = await get('select * from recipes where shop_id=$1');
  const recipe_items = await get('select ri.* from recipe_items ri join recipes r on r.id=ri.recipe_id where r.shop_id=$1');
  const option_groups = await get('select * from option_groups where shop_id=$1');
  const option_choices = await get('select oc.* from option_choices oc join option_groups og on og.id=oc.group_id where og.shop_id=$1');
  const option_choice_links = await get('select ocl.* from option_choice_links ocl join option_choices oc on oc.id=ocl.choice_id join option_groups og on og.id=oc.group_id where og.shop_id=$1');
  const recipe_option_groups = await get('select rog.* from recipe_option_groups rog join option_groups og on og.id=rog.group_id where og.shop_id=$1');
  const settings = (await get('select * from shop_settings where shop_id=$1'))[0] || null;
  return { suppliers, materials, recipes, recipe_items, option_groups, option_choices, option_choice_links, recipe_option_groups, settings };
}

function genUUID(c) { return c.query('select gen_random_uuid() id').then(r => r.rows[0].id); }

// ---- นำเข้าข้อมูลลงร้านปลายทาง: สร้าง id ใหม่ + remap ทั้งหมด (additive insert, ไม่ลบของเดิมถ้า replace=false) ----
// opts: { replace=true ลบ master เดิมของปลายทางก่อน, resetStock=true สต๊อกตั้งต้น 0, includeSettings=true คัดลอกการตั้งค่า config }
async function importIntoShop(c, dstShopId, data, opts = {}) {
  const { replace = true, resetStock = true, includeSettings = true } = opts;
  const out = { suppliers: 0, materials: 0, recipes: 0, recipe_items: 0, option_groups: 0, option_choices: 0, option_choice_links: 0, recipe_option_groups: 0 };

  if (replace) {
    // ลบ master เดิมของปลายทาง (ตามลำดับ FK) — bills/orders/stock_movements ไม่แตะ
    await c.query('delete from recipe_option_groups where group_id in (select id from option_groups where shop_id=$1)', [dstShopId]);
    await c.query('delete from option_choice_links where choice_id in (select oc.id from option_choices oc join option_groups og on og.id=oc.group_id where og.shop_id=$1)', [dstShopId]);
    await c.query('delete from option_choices where group_id in (select id from option_groups where shop_id=$1)', [dstShopId]);
    await c.query('delete from option_groups where shop_id=$1', [dstShopId]);
    await c.query('delete from recipe_items where recipe_id in (select id from recipes where shop_id=$1)', [dstShopId]);
    await c.query('delete from recipes where shop_id=$1', [dstShopId]);
    await c.query('delete from materials where shop_id=$1', [dstShopId]);
    await c.query('delete from suppliers where shop_id=$1', [dstShopId]);
  }

  const supMap = new Map(), matMap = new Map(), recMap = new Map(), grpMap = new Map(), choMap = new Map();

  // suppliers
  for (const s of data.suppliers || []) {
    const id = await genUUID(c); supMap.set(s.id, id);
    await c.query('insert into suppliers (id, shop_id, name, note) values ($1,$2,$3,$4)', [id, dstShopId, s.name, s.note || null]);
    out.suppliers++;
  }
  // materials (สต๊อกตั้งต้น 0, remap supplier_id)
  for (const m of data.materials || []) {
    const id = await genUUID(c); matMap.set(m.id, id);
    await c.query(
      `insert into materials (id, shop_id, sku, name, qty, unit, price, sell_price, supplier_id, order_url, stock, low_stock, category, conv_qty, stock_unit, is_consumable, sale_type, show_in_pos, sale_price_2, item_type, img_data)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
      [id, dstShopId, m.sku || null, m.name, m.qty, m.unit, m.price, m.sell_price, m.supplier_id ? (supMap.get(m.supplier_id) || null) : null,
       m.order_url || '', resetStock ? 0 : (m.stock || 0), m.low_stock || 0, m.category || null, m.conv_qty || null, m.stock_unit || null,
       m.is_consumable ?? false, m.sale_type || 'INGREDIENT_ONLY', m.show_in_pos ?? false, m.sale_price_2 ?? null, m.item_type || null, m.img_data || null]);
    out.materials++;
  }
  // recipes (สต๊อก fg 0, remap ทีหลังสำหรับ items)
  for (const r of data.recipes || []) {
    const id = await genUUID(c); recMap.set(r.id, id);
    await c.query(
      `insert into recipes (id, shop_id, code, name, sell_price, batch_yield, yield_unit, is_raw, steps, detail, fg_stock, fg_low, category, opt_groups, img_data, is_sop, recipe_type, output_item_type, on_menu)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
      [id, dstShopId, r.code, r.name, r.sell_price, r.batch_yield, r.yield_unit, r.is_raw, r.steps || '', r.detail || '',
       resetStock ? 0 : (r.fg_stock || 0), r.fg_low || 0, r.category || null,
       r.opt_groups == null ? null : (typeof r.opt_groups === 'string' ? r.opt_groups : JSON.stringify(r.opt_groups)),
       r.img_data || null, r.is_sop || false, r.recipe_type || null, r.output_item_type || null, r.on_menu]);
    out.recipes++;
  }
  // recipe_items (remap recipe_id, material_id, sub_recipe_id)
  for (const it of data.recipe_items || []) {
    const recipe_id = recMap.get(it.recipe_id);
    if (!recipe_id) continue;
    const material_id = it.material_id ? (matMap.get(it.material_id) || null) : null;
    const sub_recipe_id = it.sub_recipe_id ? (recMap.get(it.sub_recipe_id) || null) : null;
    await c.query('insert into recipe_items (recipe_id, material_id, amount, role, sub_recipe_id) values ($1,$2,$3,$4,$5)',
      [recipe_id, material_id, it.amount, it.role || '', sub_recipe_id]);
    out.recipe_items++;
  }
  // option_groups
  for (const g of data.option_groups || []) {
    const id = await genUUID(c); grpMap.set(g.id, id);
    await c.query(
      `insert into option_groups (id, shop_id, label, select_type, required, min_select, max_select, sort, enabled)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [id, dstShopId, g.label, g.select_type, g.required, g.min_select, g.max_select, g.sort, g.enabled]);
    out.option_groups++;
  }
  // option_choices (remap group_id, target_material_id, variant_recipe_id)
  for (const ch of data.option_choices || []) {
    const group_id = grpMap.get(ch.group_id);
    if (!group_id) continue;
    const id = await genUUID(c); choMap.set(ch.id, id);
    await c.query(
      `insert into option_choices (id, group_id, label, price_add, effect_type, enabled, is_default, sort, max_qty, target_role, target_material_id, variant_recipe_id, is_metadata_only, amount)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [id, group_id, ch.label, ch.price_add ?? 0, ch.effect_type || 'NONE', ch.enabled ?? true, ch.is_default ?? false, ch.sort ?? 0, ch.max_qty ?? 1,
       ch.target_role || '', ch.target_material_id ? (matMap.get(ch.target_material_id) || null) : null,
       ch.variant_recipe_id ? (recMap.get(ch.variant_recipe_id) || null) : null, ch.is_metadata_only ?? false, ch.amount ?? 0]);
    out.option_choices++;
  }
  // option_choice_links (remap choice_id, material_id)
  for (const l of data.option_choice_links || []) {
    const choice_id = choMap.get(l.choice_id);
    const material_id = matMap.get(l.material_id);
    if (!choice_id || !material_id) continue;
    await c.query('insert into option_choice_links (id, choice_id, material_id, amount) values (gen_random_uuid(),$1,$2,$3)',
      [choice_id, material_id, l.amount]);
    out.option_choice_links++;
  }
  // recipe_option_groups (remap recipe_id, group_id)
  for (const rg of data.recipe_option_groups || []) {
    const recipe_id = recMap.get(rg.recipe_id);
    const group_id = grpMap.get(rg.group_id);
    if (!recipe_id || !group_id) continue;
    await c.query('insert into recipe_option_groups (recipe_id, group_id, sort) values ($1,$2,$3) on conflict do nothing',
      [recipe_id, group_id, rg.sort ?? 0]);
    out.recipe_option_groups++;
  }
  // settings: คัดลอกเฉพาะ config (ไม่แตะ public_slug/token ที่ต้อง unique ต่อสาขา)
  if (includeSettings && data.settings) {
    const s = data.settings;
    await c.query(
      `update shop_settings set categories=$2, make_to_order=$3, member_config=$4, business_type=$5,
         vat_enabled=$6, vat_rate=$7, staff_discount_max=$8, staff_discount_max_baht=$9, discount_presets=$10,
         kitchen_ticket_mode=$11, use_delivery=$12, use_petty_cash=$13
       where shop_id=$1`,
      [dstShopId,
       s.categories == null ? null : (typeof s.categories === 'string' ? s.categories : JSON.stringify(s.categories)),
       s.make_to_order ?? false,
       s.member_config == null ? null : (typeof s.member_config === 'string' ? s.member_config : JSON.stringify(s.member_config)),
       s.business_type || 'fnb', s.vat_enabled ?? false, s.vat_rate ?? 7, s.staff_discount_max ?? 100, s.staff_discount_max_baht ?? 0,
       s.discount_presets == null ? null : (typeof s.discount_presets === 'string' ? s.discount_presets : JSON.stringify(s.discount_presets)),
       s.kitchen_ticket_mode || 'receipt', s.use_delivery ?? false, s.use_petty_cash ?? false]);
  }
  return out;
}

// GET /api/admin/export-shop/:id — ดาวน์โหลด bundle ข้อมูลร้าน (master) เป็น JSON
router.get('/export-shop/:id', async (req, res) => {
  try {
    const shop = (await query('select id, name from shops where id=$1', [req.params.id])).rows[0];
    if (!shop) return res.status(404).json({ error: 'ไม่พบร้าน' });
    const data = await tx(async (c) => gatherFullShopData(c, req.params.id));
    res.json({ ok: true, exported_at: new Date().toISOString(), source_shop: { id: shop.id, name: shop.name },
      counts: { materials: data.materials.length, recipes: data.recipes.length, option_groups: data.option_groups.length }, data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/admin/import-shop — นำเข้า bundle ลงร้านปลายทาง (id ใหม่ + remap)
router.post('/import-shop', async (req, res) => {
  const { dstShopId, bundle, replace, resetStock, includeSettings } = req.body || {};
  if (!dstShopId || !bundle || !bundle.data) return res.status(400).json({ error: 'ต้องมี dstShopId และ bundle.data' });
  try {
    const dst = (await query('select id from shops where id=$1', [dstShopId])).rows[0];
    if (!dst) return res.status(404).json({ error: 'ไม่พบร้านปลายทาง' });
    const out = await tx(async (c) => importIntoShop(c, dstShopId, bundle.data,
      { replace: replace !== false, resetStock: resetStock !== false, includeSettings: includeSettings !== false }));
    logEvent(dstShopId, req.userId, 'admin.import-shop', { source: bundle.source_shop && bundle.source_shop.name, ...out });
    res.json({ ok: true, imported: out });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/admin/clone-shop2 — โคลนตรงร้าน→ร้าน (gather + import ในทรานแซกชันเดียว, id ใหม่ + remap ครบ)
router.post('/clone-shop2', async (req, res) => {
  const { srcShopId, dstShopId, replace, resetStock, includeSettings } = req.body || {};
  if (!srcShopId || !dstShopId) return res.status(400).json({ error: 'ระบุ srcShopId และ dstShopId' });
  if (srcShopId === dstShopId) return res.status(400).json({ error: 'ต้นทาง/ปลายทางต้องไม่ใช่ร้านเดียวกัน' });
  try {
    const src = (await query('select id from shops where id=$1', [srcShopId])).rows[0];
    const dst = (await query('select id from shops where id=$1', [dstShopId])).rows[0];
    if (!src) return res.status(404).json({ error: 'ไม่พบร้านต้นทาง' });
    if (!dst) return res.status(404).json({ error: 'ไม่พบร้านปลายทาง' });
    const out = await tx(async (c) => {
      const data = await gatherFullShopData(c, srcShopId);
      return importIntoShop(c, dstShopId, data,
        { replace: replace !== false, resetStock: resetStock !== false, includeSettings: includeSettings !== false });
    });
    logEvent(dstShopId, req.userId, 'admin.clone-shop2', { srcShopId, ...out });
    res.json({ ok: true, cloned: out });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
module.exports.gatherFullShopData = gatherFullShopData;
module.exports.importIntoShop = importIntoShop;
module.exports.gatherFullShopData = gatherFullShopData;
module.exports.importIntoShop = importIntoShop;
