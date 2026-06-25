const { Client } = require('pg');
(async () => {
  const c = new Client({ connectionString: process.env.DB, ssl: { rejectUnauthorized: false } });
  await c.connect();
  const t = await c.query("select to_regclass('public.shop_snapshots') as tbl");
  const cols = await c.query("select count(*)::int n from information_schema.columns where table_name='shop_snapshots'");
  console.log('shop_snapshots table:', t.rows[0].tbl || 'MISSING', '| columns:', cols.rows[0].n);
  await c.end();
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
