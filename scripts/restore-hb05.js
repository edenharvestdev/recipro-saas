// กู้คืนข้อมูล HB05 ที่หาย — insert เฉพาะแถวที่ "มีใน peak แต่ไม่มีใน now" (ON CONFLICT DO NOTHING)
// ปลอดภัย: ไม่ลบ/ไม่ทับแถวเดิมใน prod เลย — เพิ่มเฉพาะที่หายเท่านั้น
// รัน: BACKUP_DB_URL=<public> PEAK=<peak.json> NOW=<now.json> node scripts/restore-hb05.js
const { Client } = require('pg');
const fs = require('fs');
const HB = 'c5cbb867-c3c6-40c2-8396-b6893da09b37';
const peak = JSON.parse(fs.readFileSync(process.env.PEAK, 'utf8')).tables;
const now = JSON.parse(fs.readFileSync(process.env.NOW, 'utf8')).tables;

const nowMatIds = new Set((now.materials || []).filter(r => r.shop_id === HB).map(r => r.id));
const missMat = (peak.materials || []).filter(r => r.shop_id === HB && !nowMatIds.has(r.id));
const peakRecIds = new Set((peak.recipes || []).filter(r => r.shop_id === HB).map(r => r.id));
const nowRecIds = new Set((now.recipes || []).filter(r => r.shop_id === HB).map(r => r.id));
const missRec = (peak.recipes || []).filter(r => r.shop_id === HB && !nowRecIds.has(r.id));
const nowRiIds = new Set((now.recipe_items || []).map(r => r.id));
const missRi = (peak.recipe_items || []).filter(r => peakRecIds.has(r.recipe_id) && !nowRiIds.has(r.id));

async function ins(c, t, rows) {
  let inserted = 0;
  for (const row of rows) {
    const keys = Object.keys(row);
    const vals = keys.map(k => { const v = row[k]; return (v !== null && typeof v === 'object' && !(v instanceof Date)) ? JSON.stringify(v) : v; });
    const ph = keys.map((_, i) => '$' + (i + 1)).join(',');
    const r = await c.query(`insert into ${t} (${keys.join(',')}) values (${ph}) on conflict (id) do nothing`, vals);
    inserted += r.rowCount;
  }
  return inserted;
}
(async () => {
  const c = new Client({ connectionString: process.env.BACKUP_DB_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  console.log('to-restore: materials', missMat.length, 'recipes', missRec.length, 'recipe_items', missRi.length);
  console.log('inserted materials:', await ins(c, 'materials', missMat));
  console.log('inserted recipes:', await ins(c, 'recipes', missRec));   // ต้องก่อน recipe_items (FK)
  console.log('inserted recipe_items:', await ins(c, 'recipe_items', missRi));
  await c.end();
  console.log('RESTORE_DONE');
})().catch(e => { console.error('RESTORE_FAIL', e.message); process.exit(1); });
