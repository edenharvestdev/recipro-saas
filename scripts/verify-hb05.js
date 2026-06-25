const { Client } = require('pg');
const HB = 'c5cbb867-c3c6-40c2-8396-b6893da09b37';
(async () => {
  const c = new Client({ connectionString: process.env.DB, ssl: { rejectUnauthorized: false } });
  await c.connect();
  const m = await c.query('select count(*)::int n from materials where shop_id=$1', [HB]);
  const r = await c.query('select count(*)::int n from recipes where shop_id=$1', [HB]);
  const os = await c.query("select name from materials where shop_id=$1 and name ilike '%osmantus%'", [HB]);
  const sets = await c.query("select r.name, count(ri.id)::int items from recipes r left join recipe_items ri on ri.recipe_id=r.id where r.shop_id=$1 and r.name ilike '%set แก้ว%' group by r.name order by r.name", [HB]);
  console.log('HB05 totals -> materials', m.rows[0].n, 'recipes', r.rows[0].n);
  console.log('Osmantus:', os.rows.map(x => x.name).join(' | ') || 'MISSING');
  sets.rows.forEach(x => console.log('  ' + x.name + ' (' + x.items + ' ส่วนผสม)'));
  await c.end();
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
