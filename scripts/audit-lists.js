const { Client } = require('pg');
const HB = process.env.SHOP || 'c5cbb867-c3c6-40c2-8396-b6893da09b37';
const DELETE = ['63fd7afb','f9f133c7','6bd769ce','97093c04','873f181c','bad4d4b1']; // ตัวว่างที่จะลบ
(async () => {
  const c = new Client({ connectionString: process.env.DB, ssl: { rejectUnauthorized: false } });
  await c.connect();
  const q = (sql) => c.query(sql, [HB]).then(r => r.rows);
  // เมนูไม่มีรูป (ไม่นับตัวที่จะลบ) — distinct ชื่อ
  const noImg = await q(`select distinct name from recipes where shop_id=$1 and coalesce(on_menu, not coalesce(is_raw,false))=true and (img_data is null or img_data='') order by name`);
  console.log('NOIMG_START');
  noImg.filter(x => true).forEach(x => console.log(x.name));
  console.log('NOIMG_END count=' + noImg.length);
  // วัตถุดิบยังไม่ระบุหมวด
  const noCat = await q(`select name from materials where shop_id=$1 and (item_type is null or item_type='') and coalesce(is_consumable,false)=false order by name`);
  console.log('NOCAT_START');
  noCat.forEach(x => console.log(x.name));
  console.log('NOCAT_END count=' + noCat.length);
  await c.end();
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
