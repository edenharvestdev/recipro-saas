// กู้รูปเมนูจาก backup (frontend export) → บีบอัด (sharp) → อัปเดต recipes.img_data บน prod ตาม id
// READ backup, WRITE only recipes.img_data (ไม่แตะข้อมูลอื่น) · จับคู่ด้วย recipe id · เฉพาะร้านที่ id ตรง
const fs = require('fs');
const sharp = require('sharp');
const { Client } = require('pg');
const root = JSON.parse(fs.readFileSync(process.env.F, 'utf8'));
const recs = (root.recipes || []).filter(r => r.id && r.imgData && r.imgData.length > 100);

async function compress(dataUrl) {
  const m = /^data:image\/[\w.+-]+;base64,(.+)$/s.exec(dataUrl || '');
  if (!m) return null;
  const buf = Buffer.from(m[1], 'base64');
  const out = await sharp(buf).rotate().resize({ width: 900, height: 900, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 72 }).toBuffer();
  return 'data:image/jpeg;base64,' + out.toString('base64');
}

(async () => {
  const c = new Client({ connectionString: process.env.DB, ssl: { rejectUnauthorized: false } });
  await c.connect();
  // หาร้านปลายทางจาก id ที่ตรงกับ prod มากสุด
  const ids = recs.map(r => r.id);
  const own = await c.query('select shop_id, count(*)::int n from recipes where id = any($1::uuid[]) group by shop_id order by n desc', [ids]);
  const shopId = own.rows[0] && own.rows[0].shop_id;
  console.log('backup recipes w/img:', recs.length, '| target shop:', shopId, '| matched ids:', own.rows[0] && own.rows[0].n);
  if (!shopId) { console.log('NO SHOP MATCH'); await c.end(); return; }
  const prodIds = new Set((await c.query('select id from recipes where shop_id=$1', [shopId])).rows.map(r => r.id));

  let updated = 0, skipped = 0, beforeMB = 0, afterMB = 0, fail = 0;
  if (process.env.DRYRUN === '1') console.log('*** DRY RUN — ไม่เขียน DB ***');
  for (const r of recs) {
    if (!prodIds.has(r.id)) { skipped++; continue; }
    let comp;
    try { comp = await compress(r.imgData); } catch (e) { fail++; continue; }
    if (!comp) { fail++; continue; }
    beforeMB += r.imgData.length; afterMB += comp.length;
    if (process.env.DRYRUN !== '1') {
      await c.query('update recipes set img_data=$1, updated_at=now() where id=$2 and shop_id=$3', [comp, r.id, shopId]);
    }
    updated++;
    if (updated % 10 === 0) process.stdout.write('  ' + updated + ' done\n');
  }
  console.log('UPDATED:', updated, '| skipped(id not in prod):', skipped, '| fail:', fail);
  console.log('img size:', (beforeMB / 1048576).toFixed(1) + 'MB →', (afterMB / 1048576).toFixed(1) + 'MB');
  await c.end();
  console.log('DONE');
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
