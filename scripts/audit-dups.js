const { Client } = require('pg');
const HB = process.env.SHOP || 'c5cbb867-c3c6-40c2-8396-b6893da09b37';
(async () => {
  const c = new Client({ connectionString: process.env.DB, ssl: { rejectUnauthorized: false } });
  await c.connect();
  const rows = (await c.query(`
    select r.id, r.name, r.sell_price, coalesce(r.on_menu, not coalesce(r.is_raw,false)) on_menu,
           (r.img_data is not null and r.img_data<>'') has_img,
           (select count(*) from recipe_items ri where ri.recipe_id=r.id)::int items,
           (select count(*) from bills b where b.shop_id=$1 and b.items_json::text like '%'||r.id||'%')::int used_in_bills
      from recipes r
     where r.shop_id=$1 and r.name in (
       select name from recipes where shop_id=$1 group by name having count(*)>1)
     order by r.name, items desc`, [HB])).rows;
  let cur = '';
  for (const x of rows) {
    if (x.name !== cur) { console.log('\n● ' + x.name); cur = x.name; }
    console.log(`   id ${x.id.slice(0,8)} | items ${x.items} | ราคา ${x.sell_price} | onMenu ${x.on_menu} | รูป ${x.has_img?'มี':'ไม่มี'} | เคยขาย ${x.used_in_bills} บิล`);
  }
  await c.end();
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
