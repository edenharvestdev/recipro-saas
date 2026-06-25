const fs = require('fs');
const raw = JSON.parse(fs.readFileSync(process.env.F, 'utf8'));
console.log('TOP-LEVEL KEYS:', Object.keys(raw).join(', '));
// ถ้ามี wrapper เช่น {tables:{...}} หรือ {data:{...}}
const root = raw.tables || raw.data || raw;
console.log('ROOT KEYS:', Object.keys(root).join(', '));
for (const k of Object.keys(root)) {
  const v = root[k];
  if (Array.isArray(v)) {
    console.log(`  ${k}: ${v.length} rows  sampleKeys=[${v[0] ? Object.keys(v[0]).slice(0,12).join(',') : ''}]`);
  } else if (v && typeof v === 'object') {
    console.log(`  ${k}: object keys=[${Object.keys(v).slice(0,12).join(',')}]`);
  } else {
    console.log(`  ${k}: ${JSON.stringify(v)}`);
  }
}
// เดา shop id จาก materials/recipes ถ้ามี
const mats = root.materials || [];
const shopIds = [...new Set(mats.map(m => m.shop_id || m.shopId).filter(Boolean))];
console.log('SHOP IDS in materials:', shopIds.join(', ') || '(none / frontend export w/o shop_id)');
