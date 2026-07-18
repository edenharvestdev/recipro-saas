// Track B generator — produces staged item lines (verified IDs only) + the exception file.
// Pure-local: reads catalog-snapshot.json + source/*.csv. No DB, no network, no writes.
// Rules: B2 include EXACT_CODE / BRANCH_CODE_RESOLVED / EXACT_NAME / unique material-name / verified
// toppings / HBC01M06C→Yame(B4). Hold Cool Pack (B3.1 no menu exists), unmatched toppings (B5), Blush
// (B6), HBD11P (B7), ambiguous name (B8), menu-not-found. unit_price=0 (financials pending).
const fs = require('fs');
const DIR = __dirname;
const snap = JSON.parse(fs.readFileSync(DIR + '/catalog-snapshot.json', 'utf8'));

const SHOP = {
  HB01: '581c5f9b-bc79-4270-8ad8-98a288be7933', HB02: '2a91e65b-cd05-4110-8878-883482ba9228',
  HB03: '116a5eda-3b6b-4c2c-97a8-3393fa8a1115', HB04: '3ebea0b3-f3a9-40ae-b6b4-080e4b48efcc',
};
const SHOP_NAME = { HB01: 'HB01-Ladprao107', HB02: 'HB02-Samyan', HB03: 'HB03-Nawamin111', HB04: 'HB04-Saphan Khwai' };
const BR = ['HB01', 'HB02', 'HB03', 'HB04'];
const idToShop = {}; for (const b of BR) idToShop[SHOP[b]] = b;

const catByCode = {}, recByName = {}, matByName = {};
for (const b of BR) { catByCode[b] = new Map(); recByName[b] = new Map(); matByName[b] = new Map(); }
for (const r of snap.recipes) { const b = idToShop[r.shop_id]; if (!b) continue; if (r.code) catByCode[b].set(r.code.trim(), { id: r.id, name: r.name, code: r.code.trim() }); if (r.name) { const k = r.name.trim().toLowerCase(); (recByName[b].get(k) ? recByName[b].get(k).push({ id: r.id, name: r.name }) : recByName[b].set(k, [{ id: r.id, name: r.name }])); } }
for (const m of snap.materials) { const b = idToShop[m.shop_id]; if (!b || !m.name) continue; const k = m.name.trim().toLowerCase(); (matByName[b].get(k) ? matByName[b].get(k).push({ id: m.id, name: m.name }) : matByName[b].set(k, [{ id: m.id, name: m.name }])); }

function parseCSV(t){const rows=[];let row=[],f='',i=0,q=false;while(i<t.length){const c=t[i];if(q){if(c==='"'){if(t[i+1]==='"'){f+='"';i+=2;continue;}q=false;i++;continue;}f+=c;i++;continue;}if(c==='"'){q=true;i++;continue;}if(c===','){row.push(f);f='';i++;continue;}if(c==='\r'){i++;continue;}if(c==='\n'){row.push(f);rows.push(row);row=[];f='';i++;continue;}f+=c;i++;}if(f.length||row.length){row.push(f);rows.push(row);}return rows;}
function siblings(code){const out=new Set([code]);const m=code.match(/^(.*M)(21|23|19|29)(C|L)$/);if(m){for(const v of['21','23','19','29'])out.add(m[1]+v+m[3]);}return[...out];}

const HELD = { COOL:'COOL_PACK_MENU_CREATION_REQUIRED', TOP:'TOPPING_MAPPING_REQUIRED', BLUSH:'MISSING_CODE_MANUAL_REVIEW', PACK:'PACK_CONVERSION_REQUIRED', NAME:'NAME_CONFIRMATION_REQUIRED', NF:'MENU_NOT_FOUND' };

// resolve a MENU row to a single verified target (recipe by code/branch/name, else unique material by name)
function resolveMenu(shop, code, name){
  const cat = catByCode[shop];
  if (code && code.includes('/')) {                       // combined → pick the variant present
    const hit = code.split(/\/+/).map(s=>s.trim()).filter(Boolean).filter(c=>cat.has(c));
    if (hit.length===1) return { ok:true, status:'BRANCH_CODE_RESOLVED', menu_type:'recipe', ...cat.get(hit[0]) };
    if (hit.length>1) return { ok:false, status:'MANUAL_REVIEW_REQUIRED', note:'multiple combined variants' };
    // fall through to name
  } else if (code && cat.has(code)) {
    const c = cat.get(code);
    if (name && c.name.trim().toLowerCase() !== name.trim().toLowerCase()) {
      // duplicate-code / name mismatch. B4: HBC01M06C resolves by code to catalog item.
      return { ok:true, status:'SOURCE_NAME_MISMATCH_RESOLVED_BY_CATALOG_CODE', menu_type:'recipe', ...c };
    }
    return { ok:true, status:'EXACT_CODE_MATCH', menu_type:'recipe', ...c };
  } else if (code) {
    const sib = siblings(code).filter(x=>x!==code && cat.has(x));
    if (sib.length===1) return { ok:true, status:'BRANCH_CODE_RESOLVED', menu_type:'recipe', ...cat.get(sib[0]) };
    if (sib.length>1) return { ok:false, status:'MANUAL_REVIEW_REQUIRED', note:'multiple sibling variants' };
  }
  const k = (name||'').trim().toLowerCase();
  const rn = recByName[shop].get(k), mn = matByName[shop].get(k);
  const recUnique = rn && rn.length===1, matUnique = mn && mn.length===1;
  if (recUnique && !mn) return { ok:true, status:'EXACT_NAME_MATCH', menu_type:'recipe', id:rn[0].id, name:rn[0].name };
  if (matUnique && !rn) return { ok:true, status:'MATERIAL_NAME_MATCH', menu_type:'material', id:mn[0].id, name:mn[0].name };
  if ((rn&&rn.length>1)||(mn&&mn.length>1)||(rn&&mn)) return { ok:false, status:HELD.NAME, note:'ambiguous name (multiple/both recipe+material)' };
  return { ok:false, status:HELD.NF, note:'no code or name match' };
}
function classify(cat, code, name){
  if (/option ที่มีตัดของ/.test(cat) || /\+ cool pack|cool pack/i.test(name)) return 'COOL';
  if (/^topping/i.test(cat) || /^topping /i.test(name)) return 'TOPPING';
  if (!code || !code.trim()) return 'MISSING';
  return 'MENU';
}

const files = [{ f:'source/LM22-30-06.csv', platform:'LINE_MAN', sheet:'LM22-30/06' }, { f:'source/Grab22-30-06.csv', platform:'GRAB', sheet:'Grab22-30/06' }];
const drafts = []; const exceptions = [];
for (const F of files) {
  const rows = parseCSV(fs.readFileSync(DIR + '/' + F.f, 'utf8'));
  let cur = '';
  const staged = {}; BR.forEach(b => staged[b] = new Map());   // key: menu_type:id  -> {menu_type,id,code,name,qty}
  const srcTot = {}, accepted = {}, heldUnits = {}; BR.forEach(b => { srcTot[b]=0; accepted[b]=0; heldUnits[b]=0; });
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r]; if (!row || row.length < 3) continue;
    const catRaw = (row[0]||'').replace(/\s+/g,' ').trim(); if (catRaw) cur = catRaw;
    const code = (row[1]||'').trim(), name = (row[2]||'').trim();
    const kind = classify(cur, code, name);
    BR.forEach((b, k) => {
      const qty = parseInt((row[3+k]||'').trim(), 10) || 0; if (!qty) return;
      srcTot[b] += qty;
      const exc = (status, note, target) => { exceptions.push({ platform:F.platform, shop:b, sheet:F.sheet, row:r+1, code, name, qty, target_code:target?target.code:'', target_name:target?target.name:'', target_id:target?target.id:'', status, note: note||'' }); heldUnits[b]+=qty; };
      if (kind === 'COOL') return exc(HELD.COOL, 'Cool Pack sold as distinct menu; no Cool Pack menu/packaging exists in shop catalog (B3.1)');
      if (kind === 'MISSING') return exc(HELD.BLUSH, 'no source code; no verified catalog target (B6)');
      if (code === 'HBD11P') return exc(HELD.PACK, 'pack conversion unverified (1 pack = ? pcs) (B7)');
      const res = resolveMenu(b, code, name);
      if (kind === 'TOPPING') {
        if (res.ok) { const key = res.menu_type+':'+res.id; const cur2 = staged[b].get(key)||{menu_type:res.menu_type,id:res.id,code:res.code||code,name:res.name,qty:0,kind:'topping'}; cur2.qty+=qty; staged[b].set(key,cur2); accepted[b]+=qty; }
        else exc(HELD.TOP, res.note||'topping id not uniquely verified', res.id?res:null);
        return;
      }
      // MENU
      if (res.ok) { const key = res.menu_type+':'+res.id; const cur2 = staged[b].get(key)||{menu_type:res.menu_type,id:res.id,code:res.code||code,name:res.name,qty:0,kind:'menu'}; cur2.qty+=qty; staged[b].set(key,cur2); accepted[b]+=qty; }
      else exc(res.status, res.note, res.id?res:null);
    });
  }
  for (const b of BR) {
    drafts.push({ shop:b, shopId:SHOP[b], shopName:SHOP_NAME[b], platform:F.platform, sheet:F.sheet,
      sales_date_from:'2026-06-22', sales_date_to:'2026-06-30',
      lines:[...staged[b].values()].map(x=>({menu_type:x.menu_type, ref_id:x.id, menu_code:x.code, menu_name:x.name, quantity:x.qty, kind:x.kind})),
      source_units:srcTot[b], accepted_units:accepted[b], held_units:heldUnits[b],
      client_request_id: `agg:${b}:${F.platform}:2026-06-22_2026-06-30:1ormPlOZvLpnjFggfxY3KnTX2AxDSKCQIHL9TMSqpBwg:${F.sheet}` });
  }
}
fs.writeFileSync(DIR+'/staged-lines.json', JSON.stringify({ generated_period:'2026-06-22_2026-06-30', drafts }, null, 1));
// exception CSV
const H = ['platform','shop','source_sheet','source_row','source_code','source_name','source_qty','proposed_target_code','proposed_target_name','proposed_target_id','exception_type','stock_risk','recommended_action','status','notes'];
const esc = s => '"'+String(s==null?'':s).replace(/"/g,'""')+'"';
const RISK = { COOL_PACK_MENU_CREATION_REQUIRED:'Base beverage + separate packaging would be under-deducted; needs distinct Cool Pack menu + verified packaging materials before any stock deduction', TOPPING_MAPPING_REQUIRED:'Topping stock not deducted until a verified same-shop topping ID is confirmed', MISSING_CODE_MANUAL_REVIEW:'No target; cannot deduct any stock', PACK_CONVERSION_REQUIRED:'Wrong stock deduction if pack≠pieces mismatch', NAME_CONFIRMATION_REQUIRED:'Name matches >1 item or both recipe+material; wrong item could be deducted', MENU_NOT_FOUND:'No catalog target; cannot map' };
const ACT = { COOL_PACK_MENU_CREATION_REQUIRED:'Founder: define Cool Pack menu (base recipe + packaging materials/qty), then import', TOPPING_MAPPING_REQUIRED:'Founder: confirm topping ID + stock behavior', MISSING_CODE_MANUAL_REVIEW:'Founder: provide code/target or skip', PACK_CONVERSION_REQUIRED:'Founder: confirm 1 pack=5 pcs, stock unit, HB02 target ID', NAME_CONFIRMATION_REQUIRED:'Founder: pick the correct target ID', MENU_NOT_FOUND:'Founder: provide catalog target or skip' };
const lines = [H.map(esc).join(',')];
for (const e of exceptions.sort((a,b)=> (a.status).localeCompare(b.status) || a.platform.localeCompare(b.platform) || a.shop.localeCompare(b.shop)))
  lines.push([e.platform,e.shop,e.sheet,e.row,e.code,e.name,e.qty,e.target_code,e.target_name,e.target_id,e.status,RISK[e.status]||'',ACT[e.status]||'CHECK_TOMORROW',e.status,e.note].map(esc).join(','));
fs.writeFileSync(DIR+'/DELIVERY-IMPORT-EXCEPTIONS-22-30-JUNE-2026.csv', lines.join('\n'));

// summary
let sSrc=0,sAcc=0,sHeld=0;
console.log('draft            source accepted held  lines  reconcΔ');
for (const d of drafts){ sSrc+=d.source_units;sAcc+=d.accepted_units;sHeld+=d.held_units;
  const delta = d.accepted_units + d.held_units - d.source_units;
  console.log((d.shop+' '+d.platform).padEnd(16)+String(d.source_units).padStart(6)+String(d.accepted_units).padStart(9)+String(d.held_units).padStart(6)+String(d.lines.length).padStart(6)+'   '+delta);
}
console.log('TOTAL             '+sSrc+'   acc='+sAcc+'  held='+sHeld+'  (reconc '+(sAcc+sHeld-sSrc)+')');
const byType={}; for(const e of exceptions){byType[e.status]=(byType[e.status]||0)+e.qty;}
console.log('held by type:', JSON.stringify(byType));
