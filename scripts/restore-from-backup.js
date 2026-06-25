// เติมข้อมูลที่ขาดจาก backup (frontend export) เข้า prod — INSERT ONLY, ไม่ลบ/ไม่ทับของเดิม
// ลำดับ FK: materials → recipes → recipe_items (กัน FK violation)
// รัน: F=<backup.json> DB=<DATABASE_PUBLIC_URL> node scripts/restore-from-backup.js
const fs = require('fs');
const { Client } = require('pg');
const root = JSON.parse(fs.readFileSync(process.env.F, 'utf8'));
const fMats = root.materials || [], fRecs = root.recipes || [];

const matCols = ['id','shop_id','sku','name','qty','unit','price','sell_price','supplier_id','order_url','stock','low_stock','category','conv_qty','stock_unit','is_consumable','sale_type','show_in_pos','sale_price_2','item_type','img_data'];
const recCols = ['id','shop_id','code','name','sell_price','batch_yield','yield_unit','is_raw','steps','fg_stock','fg_low','category','opt_groups','img_data','is_sop','recipe_type','output_item_type','on_menu','detail'];

function matRow(m, shopId) {
  return [m.id, shopId, m.sku || null, m.name, m.qty, m.unit, m.price, m.sellPrice || null, m.supId || null,
    m.orderUrl || '', m.stock, m.lowStock, m.category || null, m.convQty || null, m.stockUnit || null,
    m.isConsumable || false, m.saleType || 'INGREDIENT_ONLY', m.showInPos || false, m.salePrice2 || null,
    m.itemType || null, m.imgData || null];
}
function recRow(r, shopId) {
  const opt = r.optGroups == null ? null : JSON.stringify(r.optGroups);
  return [r.id, shopId, r.code, r.name, r.sell, r.batchYield, r.yieldUnit, r.isRaw, r.steps || '',
    r.fgStock, r.fgLow, r.category || null, opt, r.imgData || null, r.isSop || false,
    r.recipeType || null, r.outputItemType || null, (typeof r.onMenu === 'boolean' ? r.onMenu : null), r.detail || ''];
}
async function insRow(c, table, cols, vals) {
  const ph = cols.map((_, i) => '$' + (i + 1)).join(',');
  const r = await c.query(`insert into ${table} (${cols.join(',')}) values (${ph}) on conflict (id) do nothing`, vals);
  return r.rowCount;
}

(async () => {
  const c = new Client({ connectionString: process.env.DB, ssl: { rejectUnauthorized: false } });
  await c.connect();

  // ยืนยันร้านจาก id ที่ตรงกับ prod มากสุด
  const matIds = fMats.map(m => m.id).filter(Boolean);
  const own = await c.query('select shop_id, count(*)::int n from materials where id = any($1::uuid[]) group by shop_id order by n desc', [matIds]);
  const shopId = own.rows[0] && own.rows[0].shop_id;
  if (!shopId) { console.log('NO SHOP MATCH — abort'); await c.end(); return; }
  console.log('shop:', shopId);

  const pMat = new Set((await c.query('select id from materials where shop_id=$1', [shopId])).rows.map(r => r.id));
  const pRec = new Set((await c.query('select id from recipes where shop_id=$1', [shopId])).rows.map(r => r.id));
  const missMat = fMats.filter(m => m.id && !pMat.has(m.id));
  const missRec = fRecs.filter(r => r.id && !pRec.has(r.id));
  console.log('to insert -> materials', missMat.length, 'recipes', missRec.length);

  await c.query('BEGIN');
  try {
    let im = 0;
    for (const m of missMat) im += await insRow(c, 'materials', matCols, matRow(m, shopId));
    console.log('inserted materials:', im);

    let ir = 0;
    for (const r of missRec) ir += await insRow(c, 'recipes', recCols, recRow(r, shopId));
    console.log('inserted recipes:', ir);

    // recipe_items ของสูตรที่เพิ่งเพิ่ม — FK null-guard (วัตถุดิบ/สูตรย่อยที่ไม่มี → null/skip)
    let ii = 0;
    for (const r of missRec) {
      for (const it of (r.items || [])) {
        const res = await c.query(
          `insert into recipe_items (recipe_id, material_id, amount, role, sub_recipe_id)
           select $1, (select id from materials where id=$2), $3, $4, (select id from recipes where id=$5)
           where exists (select 1 from recipes where id=$1)`,
          [r.id, it.matId || null, it.amount, it.role || '', it.subId || null]);
        ii += res.rowCount;
      }
    }
    console.log('inserted recipe_items:', ii);
    await c.query('COMMIT');
    console.log('RESTORE_DONE');
  } catch (e) {
    await c.query('ROLLBACK');
    console.error('ROLLBACK', e.message);
    process.exit(1);
  }
  await c.end();
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
