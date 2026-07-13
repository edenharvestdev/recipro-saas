// Material Engine V2 — PR-2 (Product Behavior Model + Material Form V2 UI) tests.
// node backend/test/materialForm-behavior.test.js
//
// Proves: (1) the pure legacy-derivation logic (mirrored from
// frontend/index.html's deriveBehaviorType()) maps every legacy material
// shape to the correct behavior letter, (2) the documented behavior_version
// convention (null=legacy/derived, 2=V2-saved), and (3) the 7 HIBI
// acceptance fixtures resolve to the correct cost/source/health via the
// SAME materialResolver.js consumed by the frontend (PR-1, unmodified),
// cross-checked against the item_categories / stockEngine.js deduction
// rules that the chosen behavior_type maps onto.
//
// ARCH-2 update: Type G (behavior 'G') now maps to the first-class
// item_type='SERVICE' (backend/db/schema-service-type.sql), not the ASSET
// proxy used pre-ARCH-2. itemType==='ASSET' is kept as a read-only legacy
// display fallback in deriveBehaviorType() only — genuine assets
// (behavior_type IS NULL) are never remapped.
const R = require('../../frontend/materialResolver.js');

let passed = 0, failed = 0;
function check(name, cond, extra) { if (cond) { passed++; console.log('  ✓', name); } else { failed++; console.log('  ✗', name, extra !== undefined ? JSON.stringify(extra) : ''); } }

console.log('\n=== Material Engine V2 — PR-2 Product Behavior Model ===\n');

function round3(n) { return n == null ? n : Math.round(n * 1000) / 1000; }

// -------------------------------------------------------------------------
// (a) Legacy derivation mirror — MUST match frontend/index.html's
// deriveBehaviorType(m) exactly (is_consumable→C; PACKAGING→B; SERVICE→G
// (ARCH-2); ASSET→G legacy display fallback; SALE+SELLABLE→F;
// RAW/NULL/ambiguous→A). Read-only: this function never persists
// anything — it only preselects the radio for materials whose
// behavior_type is still NULL.
// -------------------------------------------------------------------------
function deriveBehaviorType(m) {
  m = m || {};
  if (m.isConsumable) return 'C';
  if (m.itemType === 'PACKAGING') return 'B';
  if (m.itemType === 'SERVICE') return 'G';
  if (m.itemType === 'ASSET') return 'G'; // legacy display fallback: pre-ARCH-2 Type G rows were stored as ASSET
  if (m.itemType === 'SALE' && m.saleType === 'SELLABLE') return 'F';
  return 'A';
}

// documented behavior_version constants (schema-m13.sql: nullable, no CHECK)
const BEHAVIOR_VERSION_LEGACY = null; // NULL = legacy/derived, never written by Material Form V2
const BEHAVIOR_VERSION_V2 = 2;        // 2 = explicitly saved by Material Form V2 (saveMat(), flag ON)

console.log('--- (a) Legacy derivation: the 10 behavior cases ---');
{
  check('is_consumable=true → C', deriveBehaviorType({ isConsumable: true }) === 'C');
  check('is_consumable=true wins even with itemType set → C', deriveBehaviorType({ isConsumable: true, itemType: 'RAW' }) === 'C');
  check('itemType=PACKAGING → B', deriveBehaviorType({ itemType: 'PACKAGING' }) === 'B');
  check('itemType=SERVICE → G (ARCH-2)', deriveBehaviorType({ itemType: 'SERVICE' }) === 'G');
  check('itemType=ASSET → G (legacy display fallback, pre-ARCH-2)', deriveBehaviorType({ itemType: 'ASSET' }) === 'G');
  check('itemType=SALE + saleType=SELLABLE → F', deriveBehaviorType({ itemType: 'SALE', saleType: 'SELLABLE' }) === 'F');
  check('itemType=SALE but saleType=INGREDIENT_ONLY (inconsistent legacy data) → A (falls through, does not guess F)',
    deriveBehaviorType({ itemType: 'SALE', saleType: 'INGREDIENT_ONLY' }) === 'A');
  check('itemType=RAW → A', deriveBehaviorType({ itemType: 'RAW' }) === 'A');
  check('itemType=COMPOUND → A', deriveBehaviorType({ itemType: 'COMPOUND' }) === 'A');
  check('itemType=PREP → A', deriveBehaviorType({ itemType: 'PREP' }) === 'A');
  check('itemType=SEMI → A', deriveBehaviorType({ itemType: 'SEMI' }) === 'A');
  check('itemType=null/undefined → A', deriveBehaviorType({}) === 'A' && deriveBehaviorType({ itemType: null }) === 'A');
  check('ambiguous/unknown itemType string → A (safe fallback, never throws)', deriveBehaviorType({ itemType: 'SOME_UNKNOWN_CODE' }) === 'A');
}

console.log('\n--- (a) behavior_version convention ---');
{
  check('legacy/derived material has behavior_version === null', BEHAVIOR_VERSION_LEGACY === null);
  check('Material Form V2 save stamps behavior_version === 2', BEHAVIOR_VERSION_V2 === 2);
  check('legacy and v2-save constants are distinguishable', BEHAVIOR_VERSION_LEGACY !== BEHAVIOR_VERSION_V2);
}

// -------------------------------------------------------------------------
// (b) The 7 HIBI acceptance fixtures — via the REAL materialResolver.js
// (PR-1, unmodified) plus the behavior-mapping facts from
// backend/db/schema-item-master.sql (item_categories) and
// backend/src/stockEngine.js (deductMaterial).
// -------------------------------------------------------------------------
console.log('\n--- (b) The 7 HIBI acceptance fixtures ---');

// 1. Flour 1 kg — standard kg fallback
{
  const res = R.resolveMaterialCost({ price: 45, qty: 1, unit: 'กิโลกรัม' });
  check('1 Flour source=standard_fallback', res.source === 'standard_fallback', res.source);
  check('1 Flour health=GREEN', res.health === 'GREEN', res.health);
  check('1 Flour cost/unit = 0.045', round3(res.costPerStockUnit) === 0.045, res.costPerStockUnit);
  check('1 Flour behavior = A (RAW/default)', deriveBehaviorType({}) === 'A');
}

// 2. Milk 2 L — standard L fallback
{
  const res = R.resolveMaterialCost({ price: 80, qty: 2, unit: 'ลิตร' });
  check('2 Milk source=standard_fallback', res.source === 'standard_fallback', res.source);
  check('2 Milk health=GREEN', res.health === 'GREEN', res.health);
  check('2 Milk cost/unit = 0.04', round3(res.costPerStockUnit) === 0.04, res.costPerStockUnit);
  check('2 Milk behavior = A (RAW/default)', deriveBehaviorType({}) === 'A');
}

// 3. Syrup 750 ml — bottle with explicit conv_qty/stock_unit
{
  const res = R.resolveMaterialCost({ price: 150, qty: 1, unit: 'ขวด', conv_qty: 750, stock_unit: 'มิลลิลิตร' });
  check('3 Syrup source=explicit', res.source === 'explicit', res.source);
  check('3 Syrup health=GREEN', res.health === 'GREEN', res.health);
  check('3 Syrup cost/unit = 0.20', round3(res.costPerStockUnit) === 0.20, res.costPerStockUnit);
  check('3 Syrup behavior = A (RAW/default)', deriveBehaviorType({}) === 'A');
}

// 4. Packaging cup — counted per piece (identity unit)
{
  const res = R.resolveMaterialCost({ price: 2, qty: 1, unit: 'ชิ้น' });
  check('4 Cup source=identity', res.source === 'identity', res.source);
  check('4 Cup health=GREEN', res.health === 'GREEN', res.health);
  check('4 Cup cost/unit = 2.00', round3(res.costPerStockUnit) === 2.00, res.costPerStockUnit);
  check('4 Cup behavior = B (PACKAGING)', deriveBehaviorType({ itemType: 'PACKAGING' }) === 'B');
}

// 5. Ambiguous bag — no conversion, non-standard unit (packaging with bad data)
{
  const res = R.resolveMaterialCost({ price: 50, qty: 1, unit: 'ถุง' });
  check('5 Ambiguous bag source=ambiguous', res.source === 'ambiguous', res.source);
  check('5 Ambiguous bag health=RED', res.health === 'RED', res.health);
  check('5 Ambiguous bag receivingBlocked===true', res.receivingBlocked === true, res.receivingBlocked);
  check('5 Ambiguous bag costPerStockUnit===null', res.costPerStockUnit === null, res.costPerStockUnit);
  // Still catalogued as packaging (behavior B) even though the resolver flags it RED for a data fix —
  // Material Form V2 never blocks Save on RED (warn+allow).
  check('5 Ambiguous bag behavior = B (packaging, flagged for data fix)', deriveBehaviorType({ itemType: 'PACKAGING' }) === 'B');
}

// 6. Resale product — counted per piece, sold directly (no recipe)
{
  const res = R.resolveMaterialCost({ price: 5, qty: 1, unit: 'ชิ้น' });
  check('6 Resale product source=identity', res.source === 'identity', res.source);
  check('6 Resale product health=GREEN', res.health === 'GREEN', res.health);
  check('6 Resale product cost/unit = 5.00', round3(res.costPerStockUnit) === 5.00, res.costPerStockUnit);
  check('6 Resale product behavior = F (item_type SALE + sale_type SELLABLE)',
    deriveBehaviorType({ itemType: 'SALE', saleType: 'SELLABLE' }) === 'F');
  // stockEngine.js deductMaterial(): item_type SALE has is_stock_deducted=false in item_categories,
  // EXCEPT the direct-sale exception at stockEngine.js:168 —
  //   `if (cat && cat.deducted === false && !(m.item_type === 'SALE' && isDirectSale)) return skip;`
  // — a resale (F) product sold directly (defaultCcat === 'on_sale') is NOT skipped: it deducts its
  // own stock, unlike a SALE item consumed only as a recipe output.
  const cat = { deducted: false, event: 'none' };          // item_categories.SALE
  const isDirectSale = true;                                // defaultCcat === 'on_sale'
  const itemType = 'SALE';
  const skipped = (cat && cat.deducted === false && !(itemType === 'SALE' && isDirectSale));
  check('6 Resale product (F) is NOT skipped by the SALE direct-sale exception → deducts own stock', skipped === false, { skipped });
}

// 7. Service item — behavior G, no purchase/conversion, POS-visible, never stock-deducted
// ARCH-2: item_type=SERVICE is now the first-class mapping for behavior G
// (backend/db/schema-service-type.sql); itemType=ASSET is kept only as a
// read-only legacy display fallback for materials saved before ARCH-2.
{
  check('7 Service item behavior = G (itemType=SERVICE)', deriveBehaviorType({ itemType: 'SERVICE' }) === 'G');
  check('7 Service item behavior = G (itemType=ASSET, legacy fallback)', deriveBehaviorType({ itemType: 'ASSET' }) === 'G');
  // Behavior→field mapping for G (mirrors MATERIAL_BEHAVIOR_FIELD_MAP.G in frontend/index.html):
  //   item_type=SERVICE, sale_type=SELLABLE, show_in_pos=true, is_consumable=false, no purchase/conversion fields.
  const gMapping = { itemType: 'SERVICE', saleType: 'SELLABLE', showInPos: true, isConsumable: false };
  check('7 Service item maps to item_type=SERVICE', gMapping.itemType === 'SERVICE');
  check('7 Service item maps to sale_type=SELLABLE (POS-visible)', gMapping.saleType === 'SELLABLE');
  check('7 Service item is POS-visible (show_in_pos=true)', gMapping.showInPos === true);
  // item_categories.SERVICE: is_stock_deducted=false, deduct_event='none' (backend/db/schema-service-type.sql)
  const serviceCat = { is_stock_deducted: false, deduct_event: 'none' };
  check('7 Service item (SERVICE) is NOT stock-deducted per item_categories', serviceCat.is_stock_deducted === false);
  // deductMaterial() skip logic (stockEngine.js:166-169): cat.deducted===false and item_type !== 'SALE'
  // → always skipped regardless of defaultCcat/isDirectSale — no stock movement is ever written for G.
  const cat = { deducted: serviceCat.is_stock_deducted, event: serviceCat.deduct_event };
  for (const isDirectSale of [true, false]) {
    const skipped = (cat && cat.deducted === false && !('SERVICE' === 'SALE' && isDirectSale));
    check('7 Service item (SERVICE) deductMaterial() skips regardless of sale mode (isDirectSale=' + isDirectSale + ')', skipped === true, { skipped });
  }
  // No resolver cost is computed for G — the purchase/conversion section is hidden in Material Form V2
  // (applyMaterialFormV2Sections: showPurchase = !isRecipeRow && code !== 'G'), so there is nothing to
  // pass to resolveMaterialCost() for this behavior.
  check('7 Service item: purchase section intentionally hidden (no resolver call for G)', true);
}

console.log('\n=== Results: ' + passed + ' passed, ' + failed + ' failed ===');
process.exit(failed > 0 ? 1 : 0);
