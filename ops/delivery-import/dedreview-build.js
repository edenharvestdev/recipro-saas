// Build DELIVERY STOCK DEDUCTION REVIEW — 22–30 JUNE 2026 (report only; no deduction executed).
// Pure-local: staged-lines.json + dedreview-raw.json (read-only prod BOM/materials snapshot).
const fs = require('fs');
const DIR = __dirname;
const staged = JSON.parse(fs.readFileSync(DIR + '/staged-lines.json', 'utf8'));
const raw = JSON.parse(fs.readFileSync(DIR + '/dedreview-raw.json', 'utf8'));

const recMeta = {}; raw.recMeta.forEach(r => recMeta[r.id] = r);
const matMeta = {}; raw.matMeta.forEach(m => matMeta[m.id] = m);
const bom = {}; for (const it of raw.items) (bom[it.recipe_id] = bom[it.recipe_id] || []).push(it);

// per-draft source/held reference (from import reconciliation)
const REF = {
  '35ea8f3e-5a8f-49bb-81b2-da3b1e8806be': { source: 228, held: 56 }, 'a42667d7-7bf6-4e40-8c2a-89ecf070b067': { source: 274, held: 65 },
  'a7184619-373b-44f3-ab74-d52eeb43eeea': { source: 430, held: 41 }, '89d90f8a-0c12-46d4-ab59-5e9242c8ea8e': { source: 366, held: 76 },
  'd377ec13-38a6-4a0f-8b78-013a967c4476': { source: 404, held: 68 }, 'da4dc381-72b9-4ef1-b22f-9e1acfd10324': { source: 1058, held: 242 },
  '235eb598-c31f-4ef8-b92e-ee95e652fa20': { source: 386, held: 77 }, '5521580f-fe7a-456a-b2d1-db0fe81e0df0': { source: 400, held: 106 },
};
// batch id per shop×platform (staged-lines has no id; map by shop+platform order matching import)
const BATCH = {
  'HB01|LINE_MAN':'35ea8f3e-5a8f-49bb-81b2-da3b1e8806be','HB02|LINE_MAN':'a42667d7-7bf6-4e40-8c2a-89ecf070b067',
  'HB03|LINE_MAN':'a7184619-373b-44f3-ab74-d52eeb43eeea','HB04|LINE_MAN':'89d90f8a-0c12-46d4-ab59-5e9242c8ea8e',
  'HB01|GRAB':'d377ec13-38a6-4a0f-8b78-013a967c4476','HB02|GRAB':'da4dc381-72b9-4ef1-b22f-9e1acfd10324',
  'HB03|GRAB':'235eb598-c31f-4ef8-b92e-ee95e652fa20','HB04|GRAB':'5521580f-fe7a-456a-b2d1-db0fe81e0df0',
};
const esc = s => '"' + String(s == null ? '' : s).replace(/"/g, '""') + '"';
const H = ['section','shop','platform','draft_id','source_period','source_qty','staged_qty','held_qty','item_name','item_code','recipe_material_id','item_type','line_qty','stock_mode','proposed_ingredient','proposed_material_id','proposed_material_qty','unit','mapping_source','exception_status','review_status','notes'];
const rows = [H.map(esc).join(',')];
let brokenLineFlags = 0, nameOnlyLines = 0, mismatchLines = 0, readyUnits = 0;
const matInvolved = new Set(), recInvolved = new Set();

for (const dr of staged.drafts) {
  const bid = BATCH[dr.shop + '|' + dr.platform];
  const ref = REF[bid] || { source: 0, held: 0 };
  const stagedQty = dr.lines.reduce((s, l) => s + l.quantity, 0);
  for (const l of dr.lines) {
    readyUnits += l.quantity;
    const mismatch = (l.menu_code === 'HBC01M06C' && /Yame/.test(l.menu_name)); // Uji→Yame resolved lines merged
    const base = { section:'READY_TO_DEDUCT_LATER', shop:dr.shop, platform:dr.platform, draft_id:bid,
      period:'2026-06-22..2026-06-30', source:ref.source, staged:stagedQty, held:ref.held,
      item_name:l.menu_name, item_code:l.menu_code||'', id:l.ref_id, type:l.menu_type, qty:l.quantity, stock_mode:'HOLD_FOR_REVIEW' };
    if (l.menu_type === 'material') {
      nameOnlyLines++; matInvolved.add(l.ref_id);
      const m = matMeta[l.ref_id] || {};
      rows.push([base.section,base.shop,base.platform,base.draft_id,base.period,base.source,base.staged,base.held,base.item_name,base.item_code,base.id,base.type,base.qty,base.stock_mode,
        m.name||l.menu_name, l.ref_id, l.quantity, m.unit||'', 'MATERIAL_NAME_MATCH','', 'READY (name-only — confirm exact material)', 'direct material deduction 1:1'].map(esc).join(','));
    } else {
      recInvolved.add(l.ref_id);
      const meta = recMeta[l.ref_id] || {}; const by = Number(meta.batch_yield) || 1;
      const ings = bom[l.ref_id] || [];
      const broken = ings.filter(i => !i.material_id || !i.mat_name);
      if (broken.length) brokenLineFlags++;
      if (mismatch) mismatchLines++;
      const mapSrc = mismatch ? 'SOURCE_NAME_MISMATCH_RESOLVED_BY_CATALOG_CODE' : (l.menu_code ? 'CODE/BRANCH_MATCH' : 'NAME_MATCH');
      if (!ings.length) {
        rows.push([base.section,base.shop,base.platform,base.draft_id,base.period,base.source,base.staged,base.held,base.item_name,base.item_code,base.id,base.type,base.qty,base.stock_mode,
          '(no BOM ingredients)', '', '', '', mapSrc, 'NO_BOM', 'REVIEW — recipe has no ingredient lines', 'may deduct finished-goods stock instead'].map(esc).join(','));
      }
      for (const ing of ings) {
        const linked = ing.material_id && ing.mat_name;
        const perUnit = (Number(ing.amount) || 0) / by;
        const proposed = linked ? +(perUnit * l.quantity).toFixed(3) : '';
        rows.push([base.section,base.shop,base.platform,base.draft_id,base.period,base.source,base.staged,base.held,base.item_name,base.item_code,base.id,base.type,base.qty,base.stock_mode,
          linked ? ing.mat_name : '(UNRESOLVED ingredient link)', ing.material_id||'', proposed, linked?(ing.mat_unit||''):'', mapSrc,
          linked ? '' : 'UNRESOLVED_INGREDIENT_LINK', linked ? 'READY' : 'DATA_QUALITY — cannot deduct (no material)',
          mismatch ? 'source "Uji Okumidori" resolved to catalog "Yame Okumidori" by code' : ''].map(esc).join(','));
      }
    }
  }
}

// HOLD sections (from exception reconciliation) — one summary row per parent×shop×platform
const HOLD = [
  // Cool Pack rows
  ['HOLD_COOL_PACK','HB01','LINE_MAN','Matcha Latte (Milk Whisk) + Cool Pack','HBM01M18L',27],['HOLD_COOL_PACK','HB01','LINE_MAN','Clear Matcha + Cool Pack','HBR01M21C/HBR01M23C',3],['HOLD_COOL_PACK','HB01','LINE_MAN','Clear Matcha Coconut + Cool Pack','HBR07M21C/HBR07M23C',26],
  ['HOLD_COOL_PACK','HB02','LINE_MAN','Matcha Latte (Milk Whisk) + Cool Pack','HBM01M18L',32],['HOLD_COOL_PACK','HB02','LINE_MAN','Clear Matcha + Cool Pack','HBR01M21C/HBR01M23C',7],['HOLD_COOL_PACK','HB02','LINE_MAN','Clear Matcha Coconut + Cool Pack','HBR07M21C/HBR07M23C',25],
  ['HOLD_COOL_PACK','HB03','LINE_MAN','Matcha Latte (Milk Whisk) + Cool Pack','HBM01M18L',21],['HOLD_COOL_PACK','HB03','LINE_MAN','Clear Matcha Coconut + Cool Pack','HBR07M21C/HBR07M23C',20],
  ['HOLD_COOL_PACK','HB04','LINE_MAN','Matcha Latte (Milk Whisk) + Cool Pack','HBM01M18L',35],['HOLD_COOL_PACK','HB04','LINE_MAN','Clear Matcha + Cool Pack','HBR01M21C/HBR01M23C',6],['HOLD_COOL_PACK','HB04','LINE_MAN','Clear Matcha Coconut + Cool Pack','HBR07M21C/HBR07M23C',35],
  ['HOLD_COOL_PACK','HB01','GRAB','Matcha Latte (Milk Whisk) + Cool Pack','HBM01M18L',37],['HOLD_COOL_PACK','HB01','GRAB','Clear Matcha Coconut + Cool Pack','HBR07M21C/HBR07M23C',30],
  ['HOLD_COOL_PACK','HB02','GRAB','Matcha Latte (Milk Whisk) + Cool Pack','HBM01M18L',121],['HOLD_COOL_PACK','HB02','GRAB','Clear Matcha Coconut + Cool Pack','HBR07M21C/HBR07M23C',120],
  ['HOLD_COOL_PACK','HB03','GRAB','Matcha Latte (Milk Whisk) + Cool Pack','HBM01M18L',41],['HOLD_COOL_PACK','HB03','GRAB','Clear Matcha Coconut + Cool Pack','HBR07M21C/HBR07M23C',35],
  ['HOLD_COOL_PACK','HB04','GRAB','Matcha Latte (Milk Whisk) + Cool Pack','HBM01M18L',56],['HOLD_COOL_PACK','HB04','GRAB','Clear Matcha Coconut + Cool Pack','HBR07M21C/HBR07M23C',50],
  ['HOLD_BLUSH','HB01','GRAB','Blush Coconut Peach Rose Matcha Velvet','',1],['HOLD_BLUSH','HB02','GRAB','Blush Coconut Peach Rose Matcha Velvet','',1],['HOLD_BLUSH','HB03','GRAB','Blush Coconut Peach Rose Matcha Velvet','',1],
  ['HOLD_HBD11P','HB02','LINE_MAN','Mochi Butter Bun แพ็ค 5 ชิ้น','HBD11P',1],
];
let coolU=0,blushU=0,packU=0;
for (const h of HOLD) {
  const [sec,shop,plat,name,code,qty]=h;
  if(sec==='HOLD_COOL_PACK')coolU+=qty; else if(sec==='HOLD_BLUSH')blushU+=qty; else packU+=qty;
  const bid=BATCH[shop+'|'+plat];
  const status = sec==='HOLD_COOL_PACK'?'COOL_PACK_MENU_CREATION_REQUIRED':sec==='HOLD_BLUSH'?'MISSING_CODE_MANUAL_REVIEW':'PACK_CONVERSION_REQUIRED';
  const note = sec==='HOLD_COOL_PACK'?'no Cool Pack menu + no packaging mapping — base beverage + packaging both undeducted':sec==='HOLD_BLUSH'?'no source code, no catalog target ID':'candidate material "Mochi Butter Bun 5ea/Pack"; 1 pack=? pcs + possible double-count with normal Mochi rows';
  rows.push([sec,shop,plat,bid,'2026-06-22..2026-06-30','','','',name,code,'','',qty,'HOLD','(none — held)','','','', 'HELD', status, 'HOLD — Founder review', note].map(esc).join(','));
}

fs.writeFileSync(DIR+'/DELIVERY-STOCK-DEDUCTION-REVIEW-22-30-JUNE-2026.csv', rows.join('\n'));
console.log('report rows (excl header):', rows.length-1);
console.log('SUMMARY:');
console.log('  total source units: 3546 | staged (ready-for-later): '+readyUnits+' | held: '+(coolU+blushU+packU));
console.log('  held by reason: CoolPack '+coolU+' Blush '+blushU+' HBD11P '+packU);
console.log('  recipes involved: '+recInvolved.size+' | materials involved: '+matInvolved.size);
console.log('  unresolved ingredient links (rows): '+raw.items.filter(i=>!i.material_id||!i.mat_name).length+' across '+brokenLineFlags+' staged recipe lines');
console.log('  name-only (material) staged lines: '+nameOnlyLines);
console.log('  source-name/catalog mismatch lines (HBC01M06C Uji→Yame): '+mismatchLines);
