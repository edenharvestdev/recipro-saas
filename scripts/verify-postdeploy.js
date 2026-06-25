const { Client } = require('pg');
const HB = 'c5cbb867-c3c6-40c2-8396-b6893da09b37';
(async () => {
  const c = new Client({ connectionString: process.env.DB, ssl: { rejectUnauthorized: false } });
  await c.connect();
  const counts = {};
  for (const t of ['materials', 'recipes', 'recipe_items', 'bills', 'suppliers', 'customers', 'shops']) {
    counts[t] = (await c.query(`select count(*)::int n from ${t}`)).rows[0].n;
  }
  console.log('TOTAL COUNTS:', JSON.stringify(counts));
  const hb = {
    materials: (await c.query('select count(*)::int n from materials where shop_id=$1', [HB])).rows[0].n,
    recipes: (await c.query('select count(*)::int n from recipes where shop_id=$1', [HB])).rows[0].n,
  };
  console.log('HB05:', JSON.stringify(hb));
  const cols = (await c.query(
    "select column_name from information_schema.columns where table_name='shop_settings' and column_name = any($1)",
    [['vat_enabled', 'vat_rate', 'staff_discount_max', 'staff_discount_max_baht', 'discount_presets']])).rows.map(r => r.column_name);
  console.log('NEW COLS PRESENT (' + cols.length + '/5):', cols.sort().join(', '));
  await c.end();
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
