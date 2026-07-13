// Material Engine V2 — materialResolver tests. node test/materialResolver.test.js
// Proves: (1) business fixtures resolve to the correct cost/source/health,
// (2) English unit aliases behave identically to Thai ones, (3) the
// non-standard kg/L override confirmation gate works both ways, (4) no
// Infinity/NaN ever leaks out on a bad denominator, (5) the SAME file is
// consumable from both Node (require) and the browser (UMD global), and both
// modes agree on the answer.
const R = require('../../frontend/materialResolver.js');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

let passed = 0, failed = 0;
function check(name, cond, extra) { if (cond) { passed++; console.log('  ✓', name); } else { failed++; console.log('  ✗', name, extra !== undefined ? JSON.stringify(extra) : ''); } }

console.log('\n=== Material Engine V2 — materialResolver ===\n');

function round2(n) { return Math.round(n * 100) / 100; }

// --- Mandatory business fixtures ---------------------------------------

// A. Flour: standard kg fallback
{
  const res = R.resolveMaterialCost({ price: 100, qty: 1, unit: 'กิโลกรัม' });
  const recipeCost = round2(res.costPerStockUnit * 200);
  check('A Flour source=standard_fallback', res.source === 'standard_fallback', res.source);
  check('A Flour health=GREEN', res.health === 'GREEN', res.health);
  check('A Flour cost/unit ~ 0.10', round2(res.costPerStockUnit) === 0.10, res.costPerStockUnit);
  check('A Flour recipe cost (200 use) = 20.00', recipeCost === 20.00, recipeCost);
}

// B. Milk: standard L fallback
{
  const res = R.resolveMaterialCost({ price: 80, qty: 2, unit: 'ลิตร' });
  const recipeCost = round2(res.costPerStockUnit * 250);
  check('B Milk source=standard_fallback', res.source === 'standard_fallback', res.source);
  check('B Milk health=GREEN', res.health === 'GREEN', res.health);
  check('B Milk cost/unit ~ 0.04', round2(res.costPerStockUnit) === 0.04, res.costPerStockUnit);
  check('B Milk recipe cost (250 use) = 10.00', recipeCost === 10.00, recipeCost);
}

// C. Matcha: explicit conversion
{
  const res = R.resolveMaterialCost({ price: 1200, qty: 1, unit: 'ถุง', conv_qty: 500, stock_unit: 'กรัม' });
  const recipeCost = round2(res.costPerStockUnit * 10);
  check('C Matcha source=explicit', res.source === 'explicit', res.source);
  check('C Matcha health=GREEN', res.health === 'GREEN', res.health);
  check('C Matcha cost/unit ~ 2.40', round2(res.costPerStockUnit) === 2.40, res.costPerStockUnit);
  check('C Matcha recipe cost (10 use) = 24.00', recipeCost === 24.00, recipeCost);
}

// D. Ambiguous bag: no conversion, non-standard unit
{
  const res = R.resolveMaterialCost({ unit: 'ถุง' });
  check('D Ambiguous source=ambiguous', res.source === 'ambiguous', res.source);
  check('D Ambiguous health=RED', res.health === 'RED', res.health);
  check('D Ambiguous receivingBlocked===true', res.receivingBlocked === true, res.receivingBlocked);
  check('D Ambiguous costPerStockUnit===null (no numeric cost emitted)', res.costPerStockUnit === null, res.costPerStockUnit);
  check('D Ambiguous costPerStockUnit is not a number', typeof res.costPerStockUnit !== 'number', typeof res.costPerStockUnit);
}

// --- Identity units (same-unit inventory, factor 1) ---------------------

// 1. Gram identity
{
  const res = R.resolveMaterialCost({ price: 100, qty: 500, unit: 'กรัม' });
  check('Identity gram source=identity', res.source === 'identity', res.source);
  check('Identity gram health=GREEN', res.health === 'GREEN', res.health);
  check('Identity gram receiving allowed', res.receivingBlocked === false, res.receivingBlocked);
  check('Identity gram costPerStockUnit = 0.20', round2(res.costPerStockUnit) === 0.20, res.costPerStockUnit);
}
// 2. Piece identity
{
  const res = R.resolveMaterialCost({ price: 120, qty: 12, unit: 'ชิ้น' });
  check('Identity piece source=identity', res.source === 'identity', res.source);
  check('Identity piece health=GREEN', res.health === 'GREEN', res.health);
  check('Identity piece receiving allowed', res.receivingBlocked === false, res.receivingBlocked);
  check('Identity piece costPerStockUnit = 10.00', round2(res.costPerStockUnit) === 10.00, res.costPerStockUnit);
}
// 3. Egg identity
{
  const res = R.resolveMaterialCost({ price: 150, qty: 30, unit: 'ฟอง' });
  check('Identity egg source=identity', res.source === 'identity', res.source);
  check('Identity egg health=GREEN', res.health === 'GREEN', res.health);
  check('Identity egg receiving allowed', res.receivingBlocked === false, res.receivingBlocked);
  check('Identity egg costPerStockUnit = 5.00', round2(res.costPerStockUnit) === 5.00, res.costPerStockUnit);
}
// 4. Milliliter identity
{
  const res = R.resolveMaterialCost({ price: 80, qty: 1000, unit: 'มล.' });
  check('Identity ml source=identity', res.source === 'identity', res.source);
  check('Identity ml health=GREEN', res.health === 'GREEN', res.health);
  check('Identity ml receiving allowed', res.receivingBlocked === false, res.receivingBlocked);
  check('Identity ml costPerStockUnit = 0.08', round2(res.costPerStockUnit) === 0.08, res.costPerStockUnit);
}
// English identity aliases behave the same
{
  const g = R.resolveMaterialCost({ price: 100, qty: 500, unit: 'g' });
  const pcs = R.resolveMaterialCost({ price: 120, qty: 12, unit: 'pcs' });
  check('Identity alias "g" = identity/GREEN', g.source === 'identity' && g.health === 'GREEN', g);
  check('Identity alias "pcs" = identity/GREEN', pcs.source === 'identity' && pcs.health === 'GREEN', pcs);
}

// --- Ambiguous packaging must NOT be auto-trusted -----------------------

// 5. Bare bag remains ambiguous/RED/blocked/null
{
  const res = R.resolveMaterialCost({ price: 50, qty: 1, unit: 'ถุง' });
  check('Bare bag source=ambiguous', res.source === 'ambiguous', res.source);
  check('Bare bag health=RED', res.health === 'RED', res.health);
  check('Bare bag receivingBlocked===true', res.receivingBlocked === true, res.receivingBlocked);
  check('Bare bag costPerStockUnit===null', res.costPerStockUnit === null, res.costPerStockUnit);
}
// Other packaging units also stay ambiguous
{
  for (const u of ['กล่อง', 'แพ็ค', 'ลัง', 'ถาด', 'แผง', 'สุ่มมั่ว-custom']) {
    const res = R.resolveMaterialCost({ price: 50, qty: 1, unit: u });
    check('Packaging "' + u + '" stays ambiguous/RED/blocked/null',
      res.source === 'ambiguous' && res.health === 'RED' && res.receivingBlocked === true && res.costPerStockUnit === null, res);
  }
}

// --- Bottle rule: bare ขวด ambiguous; explicit relationship trusted -----

// 6. Bare bottle remains ambiguous
{
  const bare = R.resolveMaterialCost({ price: 60, qty: 1, unit: 'ขวด' });
  check('Bare bottle source=ambiguous', bare.source === 'ambiguous', bare.source);
  check('Bare bottle receivingBlocked===true', bare.receivingBlocked === true, bare.receivingBlocked);
  check('Bare bottle costPerStockUnit===null', bare.costPerStockUnit === null, bare.costPerStockUnit);

  // explicit 1 ขวด = 1 ขวด → trusted 1:1
  const same = R.resolveMaterialCost({ price: 60, qty: 1, unit: 'ขวด', conv_qty: 1, stock_unit: 'ขวด' });
  check('Bottle explicit 1:1 source=explicit/GREEN', same.source === 'explicit' && same.health === 'GREEN', same);
  check('Bottle explicit 1:1 cost = 60.00', round2(same.costPerStockUnit) === 60.00, same.costPerStockUnit);

  // explicit 1 ขวด = 2000 มล. → trusted, cost per ml
  const toMl = R.resolveMaterialCost({ price: 60, qty: 1, unit: 'ขวด', conv_qty: 2000, stock_unit: 'มิลลิลิตร' });
  check('Bottle explicit 2000ml source=explicit/GREEN', toMl.source === 'explicit' && toMl.health === 'GREEN', toMl);
  check('Bottle explicit 2000ml cost/ml = 0.03', round2(toMl.costPerStockUnit) === 0.03, toMl.costPerStockUnit);
}

// --- English-alias robustness -------------------------------------------

{
  const th = R.resolveMaterialCost({ price: 100, qty: 1, unit: 'กิโลกรัม' });
  const en = R.resolveMaterialCost({ price: 100, qty: 1, unit: 'kg' });
  check('English "kg" resolves to standard_fallback', en.source === 'standard_fallback', en.source);
  check('English "kg" cost matches Thai "กิโลกรัม"', en.costPerStockUnit === th.costPerStockUnit, { en: en.costPerStockUnit, th: th.costPerStockUnit });
}
{
  const th = R.resolveMaterialCost({ price: 80, qty: 2, unit: 'ลิตร' });
  const en = R.resolveMaterialCost({ price: 80, qty: 2, unit: 'L' });
  check('English "L" resolves to standard_fallback', en.source === 'standard_fallback', en.source);
  check('English "L" cost matches Thai "ลิตร"', en.costPerStockUnit === th.costPerStockUnit, { en: en.costPerStockUnit, th: th.costPerStockUnit });
}

// --- Non-standard kg/L override confirmation gate -----------------------

{
  const unconfirmed = R.resolveMaterialCost({ price: 100, qty: 1, unit: 'กิโลกรัม', conv_qty: 800, stock_unit: 'กรัม' });
  check('Override unconfirmed: source=explicit', unconfirmed.source === 'explicit', unconfirmed.source);
  check('Override unconfirmed: needsConfirmation===true', unconfirmed.needsConfirmation === true, unconfirmed.needsConfirmation);
  check('Override unconfirmed: health=YELLOW', unconfirmed.health === 'YELLOW', unconfirmed.health);
  check('Override unconfirmed: warningCode=MAT_KGL_OVERRIDE_UNCONFIRMED', unconfirmed.warningCode === 'MAT_KGL_OVERRIDE_UNCONFIRMED', unconfirmed.warningCode);

  const confirmed = R.resolveMaterialCost({ price: 100, qty: 1, unit: 'กิโลกรัม', conv_qty: 800, stock_unit: 'กรัม', confirmed: true });
  check('Override confirmed: health=GREEN', confirmed.health === 'GREEN', confirmed.health);
  check('Override confirmed: needsConfirmation===false', confirmed.needsConfirmation === false, confirmed.needsConfirmation);
  check('Override confirmed: warningCode=null', confirmed.warningCode === null, confirmed.warningCode);
}

// --- No Infinity/NaN on zero/blank denominator ---------------------------

{
  const zeroQty = R.resolveMaterialCost({ price: 100, qty: 0, unit: 'กิโลกรัม' });
  check('Zero qty: costPerStockUnit is not finite-number', Number.isFinite(zeroQty.costPerStockUnit) === false, zeroQty.costPerStockUnit);
  check('Zero qty: costPerStockUnit !== Infinity', zeroQty.costPerStockUnit !== Infinity);
  check('Zero qty: costPerStockUnit is not NaN', !(typeof zeroQty.costPerStockUnit === 'number' && isNaN(zeroQty.costPerStockUnit)));
  check('Zero qty: costPerStockUnit === null', zeroQty.costPerStockUnit === null, zeroQty.costPerStockUnit);
  check('Zero qty: health=YELLOW / MAT_INVALID_QUANTITY', zeroQty.health === 'YELLOW' && zeroQty.warningCode === 'MAT_INVALID_QUANTITY', { health: zeroQty.health, code: zeroQty.warningCode });

  const missingQty = R.resolveMaterialCost({ price: 100, unit: 'ลิตร' });
  check('Missing qty: costPerStockUnit is not finite-number', Number.isFinite(missingQty.costPerStockUnit) === false, missingQty.costPerStockUnit);
  check('Missing qty: costPerStockUnit !== Infinity', missingQty.costPerStockUnit !== Infinity);
  check('Missing qty: costPerStockUnit is not NaN', !(typeof missingQty.costPerStockUnit === 'number' && isNaN(missingQty.costPerStockUnit)));
  check('Missing qty: costPerStockUnit === null', missingQty.costPerStockUnit === null, missingQty.costPerStockUnit);
}

// --- Node consumption proof ----------------------------------------------

check('Node require: R.resolveMaterialCost is a function', typeof R.resolveMaterialCost === 'function', typeof R.resolveMaterialCost);

// --- Browser/UMD consumption proof ----------------------------------------

const resolverSrc = fs.readFileSync(path.join(__dirname, '../../frontend/materialResolver.js'), 'utf8');
const sandbox = { window: {} };
vm.createContext(sandbox);
let vmOk = true;
try {
  vm.runInContext(resolverSrc, sandbox);
} catch (e) {
  vmOk = false;
  console.error(e.message);
}
check('Browser/UMD: script runs in vm sandbox without module/exports', vmOk);
check('Browser/UMD: window.MaterialResolver exists', !!(sandbox.window && sandbox.window.MaterialResolver));
check('Browser/UMD: window.MaterialResolver.resolveMaterialCost is a function',
  !!(sandbox.window && sandbox.window.MaterialResolver && typeof sandbox.window.MaterialResolver.resolveMaterialCost === 'function'));

// --- Both-modes-agree ------------------------------------------------------

{
  const nodeRes = R.resolveMaterialCost({ price: 100, qty: 1, unit: 'กิโลกรัม' });
  const browserRes = sandbox.window.MaterialResolver.resolveMaterialCost({ price: 100, qty: 1, unit: 'กิโลกรัม' });
  check('Both modes agree: costPerStockUnit identical', nodeRes.costPerStockUnit === browserRes.costPerStockUnit, { node: nodeRes.costPerStockUnit, browser: browserRes.costPerStockUnit });
  check('Both modes agree: source identical', nodeRes.source === browserRes.source, { node: nodeRes.source, browser: browserRes.source });
}

// =========================================================================
// ARCH-3: centralized UNIT_REGISTRY — new coverage
// =========================================================================

// --- New WEIGHT multiple unit: ขีด (100g) --------------------------------

{
  const res = R.resolveMaterialCost({ price: 50, qty: 5, unit: 'ขีด' });
  check('ขีด source=standard_fallback', res.source === 'standard_fallback', res.source);
  check('ขีด stockUnit=กรัม', res.stockUnit === 'กรัม', res.stockUnit);
  check('ขีด health=GREEN', res.health === 'GREEN', res.health);
  check('ขีด costPerStockUnit = 0.10', round2(res.costPerStockUnit) === 0.10, res.costPerStockUnit);
}

// --- New COUNT units: ใบ, อัน, คู่ -----------------------------------------

{
  const res = R.resolveMaterialCost({ price: 100, qty: 50, unit: 'ใบ' });
  check('ใบ source=identity', res.source === 'identity', res.source);
  check('ใบ health=GREEN', res.health === 'GREEN', res.health);
  check('ใบ receivingBlocked===false', res.receivingBlocked === false, res.receivingBlocked);
  check('ใบ costPerStockUnit = 2.00', round2(res.costPerStockUnit) === 2.00, res.costPerStockUnit);
}
{
  const res = R.resolveMaterialCost({ price: 120, qty: 12, unit: 'อัน' });
  check('อัน source=identity', res.source === 'identity', res.source);
  check('อัน health=GREEN', res.health === 'GREEN', res.health);
  check('อัน costPerStockUnit = 10.00', round2(res.costPerStockUnit) === 10.00, res.costPerStockUnit);
}
{
  const res = R.resolveMaterialCost({ price: 300, qty: 10, unit: 'คู่' });
  check('คู่ source=identity', res.source === 'identity', res.source);
  check('คู่ health=GREEN', res.health === 'GREEN', res.health);
  check('คู่ costPerStockUnit = 30.00', round2(res.costPerStockUnit) === 30.00, res.costPerStockUnit);
}

// --- ขวด stays PACKAGING (bare = ambiguous; explicit = trusted) ----------

{
  const bare = R.resolveMaterialCost({ price: 60, qty: 1, unit: 'ขวด' });
  check('ขวด bare source=ambiguous', bare.source === 'ambiguous', bare.source);
  check('ขวด bare health=RED', bare.health === 'RED', bare.health);
  check('ขวด bare receivingBlocked===true', bare.receivingBlocked === true, bare.receivingBlocked);
  check('ขวด bare costPerStockUnit===null', bare.costPerStockUnit === null, bare.costPerStockUnit);

  const explicit = R.resolveMaterialCost({ price: 60, qty: 1, unit: 'ขวด', conv_qty: 2000, stock_unit: 'มิลลิลิตร' });
  check('ขวด explicit 2000ml source=explicit', explicit.source === 'explicit', explicit.source);
  check('ขวด explicit 2000ml health=GREEN', explicit.health === 'GREEN', explicit.health);
}

// --- Unknown custom unit stays ambiguous ---------------------------------

{
  const res = R.resolveMaterialCost({ price: 50, qty: 1, unit: 'สุ่มมั่ว-xyz' });
  check('Unknown unit source=ambiguous', res.source === 'ambiguous', res.source);
  check('Unknown unit health=RED', res.health === 'RED', res.health);
  check('Unknown unit receivingBlocked===true', res.receivingBlocked === true, res.receivingBlocked);
  check('Unknown unit costPerStockUnit===null', res.costPerStockUnit === null, res.costPerStockUnit);
}

// --- lookupUnit contract --------------------------------------------------

{
  const cases = [
    ['กิโลกรัม', { family: 'WEIGHT', canonicalUnit: 'กรัม', toBaseFactor: 1000, trusted: true }],
    ['ขีด', { family: 'WEIGHT', canonicalUnit: 'กรัม', toBaseFactor: 100, trusted: true }],
    ['ลิตร', { family: 'VOLUME', canonicalUnit: 'มิลลิลิตร', toBaseFactor: 1000, trusted: true }],
    ['pcs', { family: 'COUNT', canonicalUnit: 'ชิ้น', toBaseFactor: 1, trusted: true }],
    ['คู่', { family: 'COUNT', canonicalUnit: 'คู่', toBaseFactor: 1, trusted: true }],
    ['ขวด', { family: 'PACKAGING', canonicalUnit: 'ขวด', toBaseFactor: null, trusted: false }]
  ];
  cases.forEach(function (c) {
    const unit = c[0], expected = c[1];
    const got = R.lookupUnit(unit);
    check('lookupUnit(' + unit + ') family', got.family === expected.family, got.family);
    check('lookupUnit(' + unit + ') canonicalUnit', got.canonicalUnit === expected.canonicalUnit, got.canonicalUnit);
    check('lookupUnit(' + unit + ') toBaseFactor', got.toBaseFactor === expected.toBaseFactor, got.toBaseFactor);
    check('lookupUnit(' + unit + ') trusted', got.trusted === expected.trusted, got.trusted);
  });

  const unknown = R.lookupUnit('ไม่มีจริง');
  check('lookupUnit(ไม่มีจริง) family=UNKNOWN', unknown.family === 'UNKNOWN', unknown.family);
  check('lookupUnit(ไม่มีจริง) toBaseFactor===null', unknown.toBaseFactor === null, unknown.toBaseFactor);
  check('lookupUnit(ไม่มีจริง) trusted===false', unknown.trusted === false, unknown.trusted);
}

// --- Node vs browser: lookupUnit + UNIT_REGISTRY parity -------------------

{
  const nodeLook = R.lookupUnit('ขีด');
  const browserLook = sandbox.window.MaterialResolver.lookupUnit('ขีด');
  check('Both modes agree: lookupUnit(ขีด) identical', JSON.stringify(nodeLook) === JSON.stringify(browserLook), { node: nodeLook, browser: browserLook });

  const nodeRes = R.resolveMaterialCost({ price: 50, qty: 5, unit: 'ขีด' });
  const browserRes = sandbox.window.MaterialResolver.resolveMaterialCost({ price: 50, qty: 5, unit: 'ขีด' });
  check('Both modes agree: resolveMaterialCost(ขีด) identical', JSON.stringify(nodeRes) === JSON.stringify(browserRes), { node: nodeRes, browser: browserRes });

  check('Node UNIT_REGISTRY exported', !!(R.UNIT_REGISTRY && R.UNIT_REGISTRY.WEIGHT), typeof R.UNIT_REGISTRY);
  check('Browser UNIT_REGISTRY exported', !!(sandbox.window.MaterialResolver.UNIT_REGISTRY && sandbox.window.MaterialResolver.UNIT_REGISTRY.WEIGHT), typeof sandbox.window.MaterialResolver.UNIT_REGISTRY);
}

// --- Invalid denominator on new units -------------------------------------

{
  const res = R.resolveMaterialCost({ price: 50, qty: 0, unit: 'ขีด' });
  check('ขีด zero qty: costPerStockUnit===null', res.costPerStockUnit === null, res.costPerStockUnit);
  check('ขีด zero qty: not Infinity', res.costPerStockUnit !== Infinity);
  check('ขีด zero qty: not NaN', !(typeof res.costPerStockUnit === 'number' && isNaN(res.costPerStockUnit)));
  check('ขีด zero qty: health=YELLOW/MAT_INVALID_QUANTITY', res.health === 'YELLOW' && res.warningCode === 'MAT_INVALID_QUANTITY', { health: res.health, code: res.warningCode });
}

// --- No-regression alias sweep: every previously-supported alias --------
// kg/L MULTIPLE aliases -> standard_fallback, cost 0.10 (price 100, qty 1, factor 1000)
// gram/ml/piece/egg BASE aliases -> identity, cost 100.00 (price 100, qty 1, factor 1)

{
  const kgLAliases = ['กิโลกรัม', 'กก.', 'กก', 'กิโล', 'kg', 'kilogram', 'kilograms', 'ลิตร', 'ล.', 'l', 'liter', 'litre', 'liters'];
  kgLAliases.forEach(function (u) {
    const res = R.resolveMaterialCost({ price: 100, qty: 1, unit: u });
    check('Alias sweep "' + u + '" source=standard_fallback', res.source === 'standard_fallback', res.source);
    check('Alias sweep "' + u + '" cost = 0.10', round2(res.costPerStockUnit) === 0.10, res.costPerStockUnit);
  });

  const identityAliases = ['กรัม', 'g', 'มล.', 'มล', 'มิลลิลิตร', 'ml', 'ชิ้น', 'piece', 'pcs', 'pc', 'ฟอง', 'egg', 'eggs'];
  identityAliases.forEach(function (u) {
    const res = R.resolveMaterialCost({ price: 100, qty: 1, unit: u });
    check('Alias sweep "' + u + '" source=identity', res.source === 'identity', res.source);
    check('Alias sweep "' + u + '" cost = 100.00', round2(res.costPerStockUnit) === 100.00, res.costPerStockUnit);
  });
}

console.log('\n=== Results: ' + passed + ' passed, ' + failed + ' failed ===');
process.exit(failed > 0 ? 1 : 0);
