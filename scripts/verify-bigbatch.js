const { Client } = require('pg');
(async () => {
  const c = new Client({ connectionString: process.env.DB, ssl: { rejectUnauthorized: false } });
  await c.connect();
  const r = (await c.query(`select
    (select count(*) from materials)::int mats,(select count(*) from recipes)::int recs,
    (select count(*) from recipe_items)::int items,(select count(*) from bills)::int bills,
    (select count(*) from suppliers)::int sups,
    (select count(*) from recipes where img_data is not null and img_data<>'')::int rec_imgs`)).rows[0];
  console.log('COUNTS:', JSON.stringify(r));
  const cols = (await c.query(`select column_name from information_schema.columns where table_name='shop_settings' and column_name = any($1)`,
    [['vat_enabled','staff_discount_max','discount_presets','staff_permissions','pos_categories','pay_gateway','omise_secret_key']])).rows.map(x=>x.column_name).sort();
  console.log('NEW shop_settings cols ('+cols.length+'/7):', cols.join(', '));
  const recLink = (await c.query(`select count(*)::int n from information_schema.columns where table_name='recipes' and column_name='link'`)).rows[0].n;
  const tbls = (await c.query(`select table_name from information_schema.tables where table_name = any($1)`,
    [['shop_snapshots','pay_charges','pos_display']])).rows.map(x=>x.table_name).sort();
  console.log('recipes.link:', recLink===1?'OK':'MISSING', '| new tables:', tbls.join(', '));
  await c.end();
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
