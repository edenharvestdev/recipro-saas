const { Client } = require('pg');
(async () => {
  const c = new Client({ connectionString: process.env.DB, ssl: { rejectUnauthorized: false } });
  await c.connect();
  const q = async (sql) => (await c.query(sql)).rows[0];
  const r = await q(`select
    (select count(*) from materials)::int mats,
    (select count(*) from recipes)::int recs,
    (select count(*) from recipe_items)::int items,
    (select count(*) from bills)::int bills,
    (select count(*) from suppliers)::int sups,
    (select count(*) from materials where img_data is not null and img_data<>'')::int mat_imgs,
    (select count(*) from recipes where img_data is not null and img_data<>'')::int rec_imgs,
    (select coalesce(sum(length(img_data)),0) from recipes)::bigint rec_img_bytes,
    (select coalesce(sum(length(img_data)),0) from materials)::bigint mat_img_bytes`);
  console.log(JSON.stringify(r));
  await c.end();
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
