// สำรองข้อมูล prod ทั้งหมดเป็นไฟล์ JSON (กันข้อมูลหาย)
// รัน: BACKUP_DB_URL=<public-url> BACKUP_OUT=<path> node scripts/backup-prod.js
const { Client } = require('pg');
const fs = require('fs');

const url = process.env.BACKUP_DB_URL;
const out = process.env.BACKUP_OUT;
if (!url || !out) { console.error('BACKUP_FAIL missing env'); process.exit(1); }

(async () => {
  const c = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await c.connect();
  const t = await c.query(
    "select tablename from pg_tables where schemaname='public' order by tablename"
  );
  const dump = { _meta: { at: new Date().toISOString(), source: 'prod', tableCount: t.rows.length }, tables: {} };
  const counts = {};
  for (const { tablename } of t.rows) {
    const r = await c.query(`select * from "${tablename}"`);
    dump.tables[tablename] = r.rows;
    counts[tablename] = r.rows.length;
  }
  await c.end();
  fs.writeFileSync(out, JSON.stringify(dump, null, 2), 'utf8');
  const size = fs.statSync(out).size;
  console.log('BACKUP_OK ' + out + ' bytes=' + size);
  console.log('COUNTS ' + JSON.stringify(counts));
})().catch((e) => { console.error('BACKUP_FAIL', e.message); process.exit(1); });
