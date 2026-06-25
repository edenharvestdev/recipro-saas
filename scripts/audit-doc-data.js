const { Client } = require('pg');
const HB = 'c5cbb867-c3c6-40c2-8396-b6893da09b37';
(async () => {
  const c = new Client({ connectionString: process.env.DB, ssl: { rejectUnauthorized: false } });
  await c.connect();
  const q = (sql) => c.query(sql, [HB]).then(r => r.rows);
  const matNames = new Set((await q('select name from materials where shop_id=$1')).rows ? [] : []);
  const mats = (await q('select name from materials where shop_id=$1')).map(r => r.name);
  const matSet = new Set(mats.map(n => (n || '').trim().toLowerCase()));

  const empty = await q(`select r.name, coalesce(r.on_menu, not coalesce(r.is_raw,false)) on_menu, r.sell_price
      from recipes r where r.shop_id=$1 and not exists(select 1 from recipe_items ri where ri.recipe_id=r.id) order by r.name`);
  console.log('EMPTY_START');
  empty.forEach(r => console.log((r.name) + '\t' + (r.on_menu ? 'ขาย' : 'ของกลาง') + '\t' + (matSet.has((r.name || '').trim().toLowerCase()) ? 'ซ้ำกับวัตถุดิบ' : '-')));
  console.log('EMPTY_END ' + empty.length);

  const zeroPrice = await q(`select name from recipes where shop_id=$1 and coalesce(on_menu, not coalesce(is_raw,false))=true and (sell_price is null or sell_price=0) order by name`);
  console.log('ZEROPRICE_START'); zeroPrice.forEach(r => console.log(r.name)); console.log('ZEROPRICE_END ' + zeroPrice.length);

  const noCat = await q(`select name from materials where shop_id=$1 and (item_type is null or item_type='') and coalesce(is_consumable,false)=false order by name`);
  console.log('NOCAT_START'); noCat.forEach(r => console.log(r.name)); console.log('NOCAT_END ' + noCat.length);

  const noCost = await q(`select name from materials where shop_id=$1 and (price is null or price=0) and coalesce(is_consumable,false)=false order by name`);
  console.log('NOCOST_START'); noCost.forEach(r => console.log(r.name)); console.log('NOCOST_END ' + noCost.length);

  const dup = await q(`select name, count(*)::int n from materials where shop_id=$1 group by name having count(*)>1`);
  console.log('DUP_START'); dup.forEach(r => console.log(r.name + ' ×' + r.n)); console.log('DUP_END ' + dup.length);

  const noImg = await q(`select name from recipes where shop_id=$1 and coalesce(on_menu, not coalesce(is_raw,false))=true and (img_data is null or img_data='') order by name`);
  console.log('NOIMG_START'); noImg.forEach(r => console.log(r.name)); console.log('NOIMG_END ' + noImg.length);
  await c.end();
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
