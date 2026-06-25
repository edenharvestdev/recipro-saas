// เทียบ backup (frontend export) กับ prod — หาว่าขาดอะไร + ยืนยันว่าเป็นร้านไหน
// READ-ONLY: แค่เทียบ ไม่เขียนอะไรลง prod
const fs = require('fs');
const { Client } = require('pg');
const root = JSON.parse(fs.readFileSync(process.env.F, 'utf8'));
const fMats = root.materials || [], fRecs = root.recipes || [], fSups = root.suppliers || [];

(async () => {
  const c = new Client({ connectionString: process.env.DB, ssl: { rejectUnauthorized: false } });
  await c.connect();

  // ยืนยันร้าน: ดู id ของ file ว่าอยู่ในร้านไหนของ prod
  const matIds = fMats.map(m => m.id).filter(Boolean);
  const own = await c.query(
    `select shop_id, count(*)::int n from materials where id = any($1::uuid[]) group by shop_id order by n desc`, [matIds]);
  console.log('=== file materials matched to prod shops ===');
  own.rows.forEach(r => console.log('  shop', r.shop_id, '→', r.n, 'matches'));
  const shopId = own.rows[0] ? own.rows[0].shop_id : null;
  console.log('BEST MATCH SHOP:', shopId);
  if (!shopId) { console.log('NO MATCH — cannot determine shop'); await c.end(); return; }

  // ดึง id ที่มีใน prod สำหรับร้านนี้
  const pMat = new Set((await c.query('select id from materials where shop_id=$1', [shopId])).rows.map(r => r.id));
  const pRec = new Set((await c.query('select id from recipes where shop_id=$1', [shopId])).rows.map(r => r.id));
  const pSup = new Set((await c.query('select id from suppliers where shop_id=$1', [shopId])).rows.map(r => r.id));

  const missMat = fMats.filter(m => m.id && !pMat.has(m.id));
  const missRec = fRecs.filter(r => r.id && !pRec.has(r.id));
  const missSup = fSups.filter(s => s.id && !pSup.has(s.id));

  console.log('\n=== COUNTS (file vs prod-this-shop) ===');
  console.log('  materials: file', fMats.length, 'prod', pMat.size, '→ MISSING in prod:', missMat.length);
  console.log('  recipes  : file', fRecs.length, 'prod', pRec.size, '→ MISSING in prod:', missRec.length);
  console.log('  suppliers: file', fSups.length, 'prod', pSup.size, '→ MISSING in prod:', missSup.length);

  console.log('\n=== MISSING MATERIALS ===');
  missMat.forEach(m => console.log('  -', m.name, '| stock', m.stock, '| id', (m.id||'').slice(0,8)));
  console.log('=== MISSING RECIPES ===');
  missRec.forEach(r => console.log('  -', r.name, '| items', (r.items||[]).length, '| onMenu', r.onMenu, '| id', (r.id||'').slice(0,8)));
  console.log('=== MISSING SUPPLIERS ===');
  missSup.forEach(s => console.log('  -', s.name, '| id', (s.id||'').slice(0,8)));

  // เช็คว่า recipe ใน file มี items embedded ไหม (สำหรับ recipe_items)
  const withItems = fRecs.filter(r => (r.items||[]).length).length;
  console.log('\nrecipes in file that carry items[]:', withItems, '/', fRecs.length);
  await c.end();
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
