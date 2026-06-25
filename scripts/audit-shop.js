// ตรวจคุณภาพข้อมูลก่อนโคลน (READ-ONLY) — หาที่กรอกผิด/ขาด เพื่อแก้ให้ตรงก่อน
const { Client } = require('pg');
const HB = process.env.SHOP || 'c5cbb867-c3c6-40c2-8396-b6893da09b37';
(async () => {
  const c = new Client({ connectionString: process.env.DB, ssl: { rejectUnauthorized: false } });
  await c.connect();
  const q = (sql, p = [HB]) => c.query(sql, p).then(r => r.rows);
  const shop = (await q('select name from shops where id=$1'))[0];
  console.log('=== AUDIT:', shop ? shop.name : HB, '===');

  const tot = (await q('select (select count(*) from materials where shop_id=$1) m, (select count(*) from recipes where shop_id=$1) r'))[0];
  console.log(`รวม: วัตถุดิบ ${tot.m} · สูตร ${tot.r}`);

  // เมนู (on_menu) ที่ไม่มีรูป
  const noImg = await q(`select name from recipes where shop_id=$1 and coalesce(on_menu, not coalesce(is_raw,false))=true and (img_data is null or img_data='') order by name`);
  console.log(`\n[เมนูไม่มีรูป] ${noImg.length} รายการ`); noImg.slice(0,40).forEach(x => console.log('  -', x.name));

  // เมนูขายแต่ราคา 0
  const noPrice = await q(`select name from recipes where shop_id=$1 and coalesce(on_menu, not coalesce(is_raw,false))=true and (sell_price is null or sell_price=0) order by name`);
  console.log(`\n[เมนูราคา 0] ${noPrice.length} รายการ`); noPrice.slice(0,40).forEach(x => console.log('  -', x.name));

  // สูตรที่ไม่มีส่วนผสมเลย (ต้นทุน = 0 → กำไรเพี้ยน)
  const noItems = await q(`select r.name from recipes r where r.shop_id=$1 and not exists(select 1 from recipe_items ri where ri.recipe_id=r.id) order by r.name`);
  console.log(`\n[สูตรไม่มีส่วนผสม] ${noItems.length} รายการ`); noItems.slice(0,40).forEach(x => console.log('  -', x.name));

  // สูตร batch_yield ผิด (0/null → หารต้นทุนพัง)
  const badYield = await q(`select name, batch_yield from recipes where shop_id=$1 and (batch_yield is null or batch_yield<=0) order by name`);
  console.log(`\n[สูตร batch_yield ผิด (0/ว่าง)] ${badYield.length}`); badYield.slice(0,40).forEach(x => console.log('  -', x.name, '=', x.batch_yield));

  // วัตถุดิบยังไม่ระบุหมวด (item_type ว่าง)
  const noCat = await q(`select count(*)::int n from materials where shop_id=$1 and (item_type is null or item_type='') and coalesce(is_consumable,false)=false`);
  console.log(`\n[วัตถุดิบยังไม่ระบุหมวด] ${noCat[0].n} รายการ`);

  // วัตถุดิบราคาทุน 0 (ต้นทุนหาย)
  const noCost = await q(`select name from materials where shop_id=$1 and (price is null or price=0) and coalesce(is_consumable,false)=false order by name`);
  console.log(`\n[วัตถุดิบราคาทุน 0] ${noCost.length}`); noCost.slice(0,30).forEach(x => console.log('  -', x.name));

  // สต๊อกติดลบ
  const negM = await q(`select name, stock from materials where shop_id=$1 and stock<0`);
  const negR = await q(`select name, fg_stock from recipes where shop_id=$1 and fg_stock<0`);
  console.log(`\n[สต๊อกติดลบ] วัตถุดิบ ${negM.length} · สูตร ${negR.length}`);
  negM.forEach(x=>console.log('  วัตถุดิบ', x.name, x.stock)); negR.forEach(x=>console.log('  สูตร', x.name, x.fg_stock));

  // ชื่อซ้ำ (วัตถุดิบ)
  const dupM = await q(`select name, count(*)::int n from materials where shop_id=$1 group by name having count(*)>1 order by n desc`);
  console.log(`\n[วัตถุดิบชื่อซ้ำ] ${dupM.length} ชื่อ`); dupM.slice(0,20).forEach(x => console.log('  -', x.name, '×' + x.n));
  const dupR = await q(`select name, count(*)::int n from recipes where shop_id=$1 group by name having count(*)>1 order by n desc`);
  console.log(`[สูตรชื่อซ้ำ] ${dupR.length} ชื่อ`); dupR.slice(0,20).forEach(x => console.log('  -', x.name, '×' + x.n));

  // recipe_items อ้างวัตถุดิบ/สูตรที่หายไป (dangling)
  const dang = await q(`select count(*)::int n from recipe_items ri join recipes r on r.id=ri.recipe_id where r.shop_id=$1 and ri.material_id is null and ri.sub_recipe_id is null`);
  console.log(`\n[ส่วนผสมว่าง (ไม่มีวัตถุดิบ/สูตรย่อย)] ${dang[0].n} แถว`);

  await c.end();
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
