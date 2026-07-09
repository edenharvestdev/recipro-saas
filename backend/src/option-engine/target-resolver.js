// Shared target resolver for the Option Stock Effect Engine admin layer.
// Maps each semantic target_type to its physical table and provides shop-scoped search + validation.
const { matchesQuery, normalizeSearch } = require('./normalize');

// target_type → physical table. NOTE: PRODUCED_ITEM / FINISHED_GOOD / RECIPE_COMPONENT are three distinct
// SEMANTIC types that currently all resolve to `recipes` (distinguished by is_raw / on_menu, else any
// recipe). MATERIAL / PACKAGING both resolve to `materials` (PACKAGING = item_type='PACKAGING').
const TARGET_MAP = {
  MATERIAL:         { table: 'materials', name: 'name', code: 'sku',  stock: 'stock',    unit: 'unit',       price: 'price',      where: '',                                        label: 'วัตถุดิบ' },
  PACKAGING:        { table: 'materials', name: 'name', code: 'sku',  stock: 'stock',    unit: 'unit',       price: 'price',      where: "and coalesce(item_type,'')='PACKAGING'",  label: 'แพ็กเกจ/บรรจุภัณฑ์' },
  PRODUCED_ITEM:    { table: 'recipes',   name: 'name', code: 'code', stock: 'fg_stock', unit: 'yield_unit', price: 'sell_price', where: 'and coalesce(is_raw,false)=true',          label: 'ของผลิต/ของกลาง' },
  FINISHED_GOOD:    { table: 'recipes',   name: 'name', code: 'code', stock: 'fg_stock', unit: 'yield_unit', price: 'sell_price', where: 'and coalesce(on_menu,true)=true',          label: 'สินค้าสำเร็จรูป' },
  RECIPE_COMPONENT: { table: 'recipes',   name: 'name', code: 'code', stock: 'fg_stock', unit: 'yield_unit', price: 'sell_price', where: '',                                        label: 'ส่วนประกอบสูตร (สูตรซ้อน)' },
  NO_STOCK:         { table: null, label: 'ไม่มีผลต่อสต๊อก' },
};

function targetTypeTable() {
  return Object.entries(TARGET_MAP).map(([type, m]) => ({
    target_type: type, source_table: m.table || '(none)', id_column: m.table ? 'id' : '(n/a)',
    display_label: m.label, stock_field: m.stock || '(n/a)', unit_field: m.unit || '(n/a)',
    cost_source: m.price ? (m.table + '.' + m.price) : '(n/a)',
    limitation: type === 'NO_STOCK' ? 'no stock target'
      : (m.table === 'recipes' ? 'semantic type; physically = recipes (distinguished by is_raw/on_menu)'
        : (type === 'PACKAGING' ? 'materials filtered by item_type=PACKAGING' : 'materials (no code column; searches sku)')),
  }));
}

// Shop-scoped search: fetch the candidate pool for the type, then substring-match (Thai NFC-safe) on
// name + code/sku in JS so multi-character Thai vowels/tone marks and mid-name fragments all match.
async function searchTargets(c, shopId, opts) {
  const map = TARGET_MAP[(opts && opts.target_type) || ''];
  if (!map || !map.table) return [];
  const limit = Math.min(Math.max(Number(opts.limit) || 20, 1), 50);
  const rows = (await c.query(
    `select id, ${map.name} as name, ${map.code} as code, ${map.stock} as stock, ${map.unit} as unit
       from ${map.table} where shop_id=$1 ${map.where} order by ${map.name} limit 2000`, [shopId])).rows;
  const q = normalizeSearch(opts.q);
  const hit = q ? rows.filter((r) => matchesQuery((r.name || '') + ' ' + (r.code || ''), q)) : rows;
  return hit.slice(0, limit).map((r) => ({
    target_type: opts.target_type, ref_id: r.id, name: r.name, code: r.code || null,
    stock: r.stock == null ? null : Number(r.stock), unit: r.unit || null,
  }));
}

// Validate a single target belongs to this shop + type. Returns { ok } or { ok:false, code }.
async function validateTarget(c, shopId, target_type, ref_id) {
  if (target_type === 'NO_STOCK') return { ok: true };
  const map = TARGET_MAP[target_type];
  if (!map || !map.table) return { ok: false, code: 'INVALID_TARGET_TYPE' };
  if (!ref_id) return { ok: false, code: 'TARGET_REQUIRED' };
  const inShop = (await c.query(`select 1 from ${map.table} where id=$1 and shop_id=$2 ${map.where}`, [ref_id, shopId])).rowCount > 0;
  if (inShop) return { ok: true };
  const globally = (await c.query(`select 1 from ${map.table} where id=$1`, [ref_id])).rowCount > 0;
  return { ok: false, code: globally ? 'CROSS_SHOP_TARGET' : 'TARGET_NOT_FOUND' };
}

// RECIPE_COMPONENT cycle guard: does `targetRecipeId`'s sub-recipe closure reach any of `parentRecipeIds`
// (the recipes this option choice is attached to) or itself? If so → circular.
async function hasRecipeCycle(c, shopId, targetRecipeId, parentRecipeIds) {
  const forbidden = new Set([...(parentRecipeIds || []), targetRecipeId].map(String));
  const seen = new Set();
  let frontier = [targetRecipeId];
  let depth = 0;
  while (frontier.length && depth < 50) {
    const rows = (await c.query(
      `select distinct sub_recipe_id from recipe_items ri join recipes r on r.id=ri.recipe_id
        where ri.recipe_id = any($1::uuid[]) and ri.sub_recipe_id is not null and r.shop_id=$2`,
      [frontier, shopId])).rows;
    const next = [];
    for (const row of rows) {
      const sid = String(row.sub_recipe_id);
      if (forbidden.has(sid) && sid !== String(targetRecipeId)) return true;   // reaches a parent → cycle
      if (sid === String(targetRecipeId)) return true;                         // self loop
      if (!seen.has(sid)) { seen.add(sid); next.push(row.sub_recipe_id); }
    }
    frontier = next; depth++;
  }
  return false;
}

module.exports = { TARGET_MAP, targetTypeTable, searchTargets, validateTarget, hasRecipeCycle };
