// Material Engine V2 (Track D) — Receive Delta V2 tests. node test/receive-delta.test.js
//
// Proves, DB-free:
// 1. Resolver-parity: computeReceiveV2() — the REAL function shipped in frontend/index.html,
//    extracted by source and run against the REAL materialResolver.js (same physical module
//    required('../../frontend/materialResolver.js')) — resolves the exact factor/addBase/cost
//    the receive preview uses, for the mandatory fixtures (Flour/Milk/Syrup/Cup/bag).
// 2. Text-contract locks on frontend/index.html source: the flag-gated branch exists in both
//    bulkReceive() and receiveMat(), the delta commit posts mode:'delta'/kind:'receive', the
//    ambiguous-unit block message is present, and adjMat() (stocktake) still uses set-mode only
//    — it never references the new delta helper.
// 3. Flag-OFF guarantee: the original (pre-Track-D) addBase expression in bulkReceive() is still
//    present verbatim — the legacy UNITS[] math path is untouched when the flag is off.
// 4. Boundary check: backend/src/api/stock.js (FORBIDDEN file for this task) still contains the
//    mode==='set' ? v : before+v line this whole feature depends on — documents that Track D only
//    changes what the CLIENT sends, never the server's already-existing delta support.
const fs = require('fs');
const path = require('path');
const R = require('../../frontend/materialResolver.js');
const html = fs.readFileSync(path.join(__dirname, '../../frontend/index.html'), 'utf8');

let passed = 0, failed = 0;
function check(name, cond, extra) { if (cond) { passed++; console.log('  ✓', name); } else { failed++; console.log('  ✗', name, extra !== undefined ? JSON.stringify(extra) : ''); } }

console.log('\n=== Material Engine V2 — Receive Delta V2 (Track D) ===\n');

function round2(n) { return Math.round(n * 100) / 100; }

// --------------------------------------------------------------------------
// String/comment/regex-aware extractor (same approach as test/print-routing.test.js)
// — pulls the REAL function source out of index.html so tests run the shipped code,
// not a re-implementation of it.
// --------------------------------------------------------------------------
function extractFn(name) {
  const start = html.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('function not found: ' + name);
  let i = html.indexOf('{', start);
  let depth = 0, str = null, prevSig = '(';
  for (; i < html.length; i++) {
    const ch = html[i], nx = html[i + 1];
    if (str) {
      if (ch === '\\') { i++; continue; }
      if (ch === str) str = null;
      continue;
    }
    if (ch === '/' && nx === '/') { i = html.indexOf('\n', i); if (i < 0) break; continue; }
    if (ch === '/' && nx === '*') { i = html.indexOf('*/', i + 2) + 1; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { str = ch; prevSig = ch; continue; }
    if (ch === '/' && '([{,;:=!&|?+-*%~^<>'.includes(prevSig)) {
      i++; while (i < html.length && html[i] !== '/') { if (html[i] === '\\') i++; i++; }
      prevSig = '/'; continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return html.slice(start, i + 1); }
    if (!/\s/.test(ch)) prevSig = ch;
  }
  throw new Error('unbalanced braces for: ' + name);
}

// =========================================================================
// 1. Resolver-parity — run the REAL computeReceiveV2() (extracted from
//    index.html) against the REAL materialResolver.js module.
// =========================================================================
const computeReceiveV2Src = extractFn('computeReceiveV2');
const factory = new Function('MaterialResolver', `
  var window = { MaterialResolver: MaterialResolver };
  ${computeReceiveV2Src}
  return computeReceiveV2;
`);
const computeReceiveV2 = factory(R);

check('computeReceiveV2 extracted as a function', typeof computeReceiveV2 === 'function', typeof computeReceiveV2);

// --- Flour: standard kg fallback, no explicit conversion -----------------
{
  const m = { price: 45, qty: 1, unit: 'กิโลกรัม', convQty: null, stockUnit: null };
  const c = computeReceiveV2(m, 2);
  check('Flour factor = 1000', c.factor === 1000, c.factor);
  check('Flour not blocked', c.blocked === false, c.blocked);
  check('Flour addBase (qty 2) = 2000', c.addBase === 2000, c.addBase);
  check('Flour stockUnit = กรัม', c.stockUnit === 'กรัม', c.stockUnit);
  check('Flour source=standard_fallback', c.res.source === 'standard_fallback', c.res.source);
  const value = round2(c.res.costPerStockUnit * c.addBase);
  check('Flour value (cost/unit x addBase) = 90.00', value === 90.00, value);
}

// --- Milk: standard L fallback --------------------------------------------
{
  const m = { price: 80, qty: 2, unit: 'ลิตร', convQty: null, stockUnit: null };
  const c = computeReceiveV2(m, 3);
  check('Milk factor = 1000', c.factor === 1000, c.factor);
  check('Milk not blocked', c.blocked === false, c.blocked);
  check('Milk addBase (qty 3) = 3000', c.addBase === 3000, c.addBase);
  check('Milk source=standard_fallback', c.res.source === 'standard_fallback', c.res.source);
}

// --- Syrup: explicit conversion (ขวด -> 750 มล.) --------------------------
{
  const m = { price: 150, qty: 1, unit: 'ขวด', convQty: 750, stockUnit: 'มิลลิลิตร' };
  const c = computeReceiveV2(m, 1);
  check('Syrup factor = 750', c.factor === 750, c.factor);
  check('Syrup not blocked', c.blocked === false, c.blocked);
  check('Syrup addBase (qty 1) = 750', c.addBase === 750, c.addBase);
  check('Syrup source=explicit', c.res.source === 'explicit', c.res.source);
}

// --- Cup: identity unit (ชิ้น, factor 1) -----------------------------------
{
  const m = { price: 120, qty: 12, unit: 'ชิ้น', convQty: null, stockUnit: null };
  const c = computeReceiveV2(m, 5);
  check('Cup factor = 1', c.factor === 1, c.factor);
  check('Cup not blocked', c.blocked === false, c.blocked);
  check('Cup addBase (qty 5) = 5', c.addBase === 5, c.addBase);
  check('Cup source=identity', c.res.source === 'identity', c.res.source);
}

// --- Bag: packaging unit, no explicit conversion -> BLOCKED ---------------
{
  const m = { price: 500, qty: 1, unit: 'ถุง', convQty: null, stockUnit: null };
  const c = computeReceiveV2(m, 1);
  check('Bag factor === null', c.factor === null, c.factor);
  check('Bag blocked === true', c.blocked === true, c.blocked);
  check('Bag addBase === 0 (never silently computed with factor 1)', c.addBase === 0, c.addBase);
  check('Bag source=ambiguous', c.res.source === 'ambiguous', c.res.source);
  check('Bag res.receivingBlocked===true', c.res.receivingBlocked === true, c.res.receivingBlocked);
  check('Bag warningCode=MAT_UNIT_AMBIGUOUS_NO_CONVERSION', c.res.warningCode === 'MAT_UNIT_AMBIGUOUS_NO_CONVERSION', c.res.warningCode);
}

// --- kg/L override, unconfirmed: not blocked, factor = explicit conv ------
{
  const m = { price: 100, qty: 1, unit: 'กิโลกรัม', convQty: 800, stockUnit: 'กรัม' };
  const c = computeReceiveV2(m, 2);
  check('kg/L override factor = explicit conv (800)', c.factor === 800, c.factor);
  check('kg/L override not blocked (warn but allow)', c.blocked === false, c.blocked);
  check('kg/L override addBase (qty 2) = 1600', c.addBase === 1600, c.addBase);
  check('kg/L override warningCode=MAT_KGL_OVERRIDE_UNCONFIRMED', c.res.warningCode === 'MAT_KGL_OVERRIDE_UNCONFIRMED', c.res.warningCode);
}

// =========================================================================
// 2. Text-contract locks on index.html source
// =========================================================================

const bulkReceiveSrc = extractFn('bulkReceive');
const bulkReceiveV2Src = extractFn('bulkReceiveV2');
const receiveMatSrc = extractFn('receiveMat');
const receiveMatV2Src = extractFn('receiveMatV2');
const pushReceiveDeltaSrc = extractFn('pushReceiveDelta');
const adjMatSrc = extractFn('adjMat');

check('bulkReceive() checks matEngineV2Enabled()', /matEngineV2Enabled\s*\(\s*\)/.test(bulkReceiveSrc), bulkReceiveSrc.slice(0, 200));
check('receiveMat() checks matEngineV2Enabled()', /matEngineV2Enabled\s*\(\s*\)/.test(receiveMatSrc), receiveMatSrc.slice(0, 400));
check('bulkReceive() dispatches to bulkReceiveV2()', /bulkReceiveV2\s*\(\s*\)/.test(bulkReceiveSrc), bulkReceiveSrc);
check('receiveMat() dispatches to receiveMatV2(', /receiveMatV2\s*\(/.test(receiveMatSrc), receiveMatSrc);

check('pushReceiveDelta() posts mode: \'delta\'', /mode:\s*'delta'/.test(pushReceiveDeltaSrc), pushReceiveDeltaSrc);
check('pushReceiveDelta() posts kind: \'receive\'', /kind:\s*'receive'/.test(pushReceiveDeltaSrc), pushReceiveDeltaSrc);
check('pushReceiveDelta() posts to /api/stock/move', pushReceiveDeltaSrc.includes('/api/stock/move'), pushReceiveDeltaSrc);
check('bulkReceiveV2() commits via pushReceiveDelta(', /pushReceiveDelta\s*\(/.test(bulkReceiveV2Src), bulkReceiveV2Src);
check('receiveMatV2() commits via pushReceiveDelta(', /pushReceiveDelta\s*\(/.test(receiveMatV2Src), receiveMatV2Src);

// Ambiguous-block Thai explanation present somewhere in the file (RECEIVE_WARNING_TH map).
check('Ambiguous-block Thai string present (MAT_UNIT_AMBIGUOUS_NO_CONVERSION explanation)',
  html.includes("ยังไม่มีการแปลงหน่วย") && html.includes("ปริมาณต่อหน่วยซื้อ") && html.includes("หน่วยตัดสต๊อก"), true);
check('bulkReceiveV2() lists blocked items as "รับไม่ได้"', bulkReceiveV2Src.includes('รับไม่ได้') || html.includes('รับไม่ได้ — ต้องระบุการแปลงหน่วยก่อน'), true);
check('receiveMatV2() blocks ambiguous receives before committing', /if\s*\(\s*c\.blocked\s*\)/.test(receiveMatV2Src), receiveMatV2Src);
check('bulkReceiveV2() blocks ambiguous receives before committing', /if\s*\(\s*c\.blocked\s*\)/.test(bulkReceiveV2Src), bulkReceiveV2Src);

// adjMat (stocktake) must stay on set-mode ALWAYS — never touch the delta helper.
check('adjMat() still calls pushMovement (set-mode)', /pushMovement\s*\(/.test(adjMatSrc), adjMatSrc);
check('adjMat() does NOT reference pushReceiveDelta', !adjMatSrc.includes('pushReceiveDelta'), adjMatSrc);
check('adjMat() does NOT check matEngineV2Enabled (stocktake is never gated)', !adjMatSrc.includes('matEngineV2Enabled'), adjMatSrc);

// =========================================================================
// 3. Flag-OFF guarantee — legacy addBase expression preserved verbatim
// =========================================================================

const LEGACY_ADD_BASE_EXPR = "const addBase = m.convQty ? qty * m.convQty : qty * (UNITS[m.unit] || { f: 1 }).f;";
check('Legacy bulkReceive addBase expression preserved verbatim', html.includes(LEGACY_ADD_BASE_EXPR), true);
check('Legacy expression lives inside bulkReceive() (flag-OFF path), not only bulkReceiveV2()',
  bulkReceiveSrc.includes(LEGACY_ADD_BASE_EXPR) && !bulkReceiveV2Src.includes(LEGACY_ADD_BASE_EXPR), true);

const LEGACY_RECEIVE_MAT_ADD_EXPR = "const add = m.convQty ? (+v || 0) * m.convQty : (+v || 0) * u.f;";
check('Legacy receiveMat add expression preserved verbatim', html.includes(LEGACY_RECEIVE_MAT_ADD_EXPR), true);
check('Legacy expression lives inside receiveMat() (flag-OFF path), not only receiveMatV2()',
  receiveMatSrc.includes(LEGACY_RECEIVE_MAT_ADD_EXPR) && !receiveMatV2Src.includes(LEGACY_RECEIVE_MAT_ADD_EXPR), true);

// Legacy pushMovement(...) commit call (set-mode) still present, unmodified, in both functions.
check('bulkReceive() (flag-OFF path) still commits via pushMovement(...) set-mode',
  /pushMovement\(\{ kind: 'receive'/.test(bulkReceiveSrc), bulkReceiveSrc);
check('receiveMat() (flag-OFF path) still commits via pushMovement(...) set-mode',
  /pushMovement\(\{ kind: 'receive'/.test(receiveMatSrc), receiveMatSrc);

// pushMovement() itself (the shared, pre-existing set-mode helper) is untouched: still posts mode:'set'.
const pushMovementSrc = extractFn('pushMovement');
check('pushMovement() (shared helper) unmodified: still posts mode: \'set\'', /mode:\s*'set'/.test(pushMovementSrc), pushMovementSrc);
check('pushMovement() (shared helper) does not itself reference delta mode', !/mode:\s*'delta'/.test(pushMovementSrc), pushMovementSrc);

// =========================================================================
// 4. Boundary check — backend/src/api/stock.js (FORBIDDEN file) untouched;
//    documents the server-side delta support this whole feature relies on.
// =========================================================================

const stockJsSrc = fs.readFileSync(path.join(__dirname, '../src/api/stock.js'), 'utf8');
check("stock.js still contains: after = Math.max(0, mode === 'set' ? v : before + v)",
  stockJsSrc.includes("const after = Math.max(0, mode === 'set' ? v : before + v);"), true);
check('stock.js /stock/move route still exists (mode delta/set entry point)',
  stockJsSrc.includes("router.post('/stock/move'"), true);

console.log('\n=== Results: ' + passed + ' passed, ' + failed + ' failed ===');
process.exit(failed > 0 ? 1 : 0);
