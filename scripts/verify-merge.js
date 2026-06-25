const { Client } = require('pg');
const HB = 'c5cbb867-c3c6-40c2-8396-b6893da09b37';
const names = ['ดอกหอมหมื่นลี้แห้ง 0.5g','Kori Osmanthus Matcha','Set แก้ว Clear 16 Oz','ดอกเก๊กฮวยแแห้ง 0.5g','ไซรัปเก๊กฮวยแห้ง 3.5 L','Set แก้ว Clear 8 Oz','Set แก้ว Hibi Cold Whisk','Osmanthus Matcha Latte'];
(async () => {
  const c = new Client({ connectionString: process.env.DB, ssl: { rejectUnauthorized: false } });
  await c.connect();
  for (const n of names) {
    const r = await c.query(
      `select r.name, count(ri.id)::int items,
              count(ri.material_id)::int mat, count(ri.sub_recipe_id)::int sub
         from recipes r left join recipe_items ri on ri.recipe_id=r.id
        where r.shop_id=$1 and r.name=$2 group by r.name`, [HB, n]);
    const x = r.rows[0];
    console.log(x ? `  ✓ ${x.name} — ${x.items} items (mat ${x.mat}, sub ${x.sub})` : `  ✗ MISSING: ${n}`);
  }
  const tot = await c.query('select count(*)::int m from materials where shop_id=$1', [HB]);
  const tr = await c.query('select count(*)::int r from recipes where shop_id=$1', [HB]);
  console.log('HB05 totals: materials', tot.rows[0].m, 'recipes', tr.rows[0].r);
  await c.end();
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
