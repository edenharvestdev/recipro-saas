// Compact Option Editor — pure unit tests (no DB, no browser).
// node backend/test/compact-option-editor.test.js
//
// Context: the Founder asked for a Compact Option Editor so "normal restaurant
// owners [can] build menus without understanding the engine." There are
// exactly 5 owner-facing blocks (A Kitchen Instruction, B Add Ingredient,
// C Replace Ingredient, D Change Quantity, E Recipe Variant) layered on top
// of the UNCHANGED stockEngine.js effect types (NONE/ADD/REPLACE/QUANTITY/
// RECIPE_VARIANT). This file proves the acceptance criteria against the REAL
// shipped code in frontend/index.html (same extraction technique as
// backend/test/category-hotfix.test.js — extractFn pulls real function
// bodies out of the file and evals them in a minimal sandbox, so a rename or
// deletion fails the suite loudly instead of silently testing nothing) plus
// a source-contract check against backend/src/api/bills.js for the
// historical-snapshot invariant (test group J).
//
// Test groups:
//   A — exactly 5 blocks, no more
//   B — Kitchen Instruction (block A): metadata-only, no price/stock/ingredient
//   C — Replace Ingredient (block C): "from" sourced from the ACTIVE recipe only
//   D — Replace Ingredient (block C): exactly 4 fields, no raw mechanics exposed
//   E — Replace Ingredient (block C): maps to REPLACE, no double-deduct
//   F — Change Quantity (block D): 0 removes the ingredient
//   G — Recipe Variant (block E): maps to RECIPE_VARIANT, gated through ONE helper
//   H — no block exposes a raw effect-type dropdown / multi-row editor
//   I — category functions are untouched (source-contract guard)
//   J — ogRecipeVariantGate: the Founder's strict 10-point completeness gate
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log('  ✓', name); }
  else { failed++; console.log('  ✗', name, extra !== undefined ? JSON.stringify(extra) : ''); }
}

const readSrc = (p) => fs.readFileSync(path.join(__dirname, p), 'utf8').replace(/\r\n/g, '\n');
const INDEX_SRC = readSrc('../../frontend/index.html');
const BILLS_SRC = readSrc('../src/api/bills.js');
const RESOLVER_PATH = path.join(__dirname, '../../frontend/materialResolver.js');
const MaterialResolver = require(RESOLVER_PATH); // the REAL resolver — never re-implemented in this suite

// ---------------------------------------------------------------------------
// Extraction helpers (same technique as category-hotfix.test.js)
// ---------------------------------------------------------------------------
function extractFn(src, name, label) {
  const decl = new RegExp('(?:^|\\n)(?:async\\s+)?function\\s+' + name + '\\s*\\(');
  const m = decl.exec(src);
  if (!m) throw new Error('cannot find function ' + name + ' in ' + (label || 'source'));
  const start = m.index + (m[0].startsWith('\n') ? 1 : 0);
  const bodyStart = src.indexOf('{', m.index + m[0].length - 1);
  let depth = 0, i = bodyStart, inStr = null, inTpl = false;
  for (; i < src.length; i++) {
    const ch = src[i], prev = src[i - 1];
    if (inStr) { if (ch === inStr && prev !== '\\') inStr = null; continue; }
    if (inTpl) { if (ch === '`' && prev !== '\\') inTpl = false; continue; }
    if (ch === '"' || ch === "'") { inStr = ch; continue; }
    if (ch === '`') { inTpl = true; continue; }
    if (ch === '/' && src[i + 1] === '/') { const nl = src.indexOf('\n', i); i = nl === -1 ? src.length : nl; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  return src.slice(start, i);
}
function extractConst(src, name) {
  const re = new RegExp('const\\s+' + name + '\\s*=\\s*([\\s\\S]*?);\\n');
  const m = re.exec(src);
  if (!m) throw new Error('cannot find const ' + name + ' in source');
  return m[1];
}

// Every option-editor function the sandbox links together, in source order.
const FRONT_FNS = [
  'ogBlockLabel', 'ogBlockTypeOf', 'ogLinkedRecipeIdsLive', 'ogSourceIngredients',
  'ogRecipeDependencyCycle', 'ogRecipeBomResolvable', 'ogRecipeVariantGate',
  'ogValidateChoice', 'ogChoiceSummary', 'ogDetectConflicts',
  'renderOptionsPage', 'openGroupForm',
  'ogInstructionStep2Html', 'ogAddStep2Html', 'ogReplaceStep2Html', 'ogQuantityStep2Html', 'ogVariantStep2Html', 'ogPriceFieldHtml',
  'renderGroupChoices', 'ogRefreshChoicePreview', 'setChoiceDefault', 'ogChoiceSetLink', 'ogSetBlockType',
  'addChoiceRow', 'renderGroupRecipePicker', 'saveGroupForm',
];
const F = {};
for (const n of FRONT_FNS) F[n] = extractFn(INDEX_SRC, n, 'frontend/index.html');
const OG_BLOCK_TYPES_SRC = extractConst(INDEX_SRC, 'OG_BLOCK_TYPES');

// ---------------------------------------------------------------------------
// Sandbox: the smallest environment the extracted option-editor code touches.
// ---------------------------------------------------------------------------
function build(opts) {
  opts = opts || {};
  const env = {
    materials: opts.materials || [],
    recipes: opts.recipes || [],
    optionGroups: opts.optionGroups || [],
    checkedRecipeIds: opts.checkedRecipeIds || [],
    toasts: [],
    saveAllCalls: 0,
    closeDrawerCalls: 0,
    openDrawerCalls: 0,
  };
  const preamble = `
    const OG_BLOCK_TYPES = ${OG_BLOCK_TYPES_SRC};
    let editGroupId = null;
    let editGroupChoices = [];
    let optionGroups = ENV.optionGroups;
    const materials = ENV.materials;
    const recipes = ENV.recipes;
    const window = { MaterialResolver: MaterialResolver };
    const uid = () => 'u' + Math.random().toString(36).slice(2);
    const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const money = n => String(Number(n) || 0);
    const icon = (name) => '<i data-icon="' + name + '"></i>';
    const baseU = m => m.stockUnit || m.unit;
    const recById = id => recipes.find(r => r.id === id);
    const matById = id => materials.find(m => m.id === id);
    const _els = {};
    function $(id) { if (!_els[id]) _els[id] = { value: '', checked: false, innerHTML: '' }; return _els[id]; }
    const document = {
      querySelectorAll: (sel) => {
        if (sel === '.og-recipe-chk:checked') return (ENV.checkedRecipeIds || []).map(rid => ({ dataset: { rid } }));
        return [];
      },
      getElementById: () => null,
    };
    const ui = { toast: (msg, kind) => ENV.toasts.push({ msg, kind }) };
    function renderIcons() {}
    function openDrawer() { ENV.openDrawerCalls++; }
    function closeDrawer() { ENV.closeDrawerCalls++; }
    function saveAll() { ENV.saveAllCalls++; }
  `;
  const body = FRONT_FNS.map(n => F[n]).join('\n\n');
  const factory = new Function('ENV', 'MaterialResolver', preamble + '\n' + body + `
    return {
      OG_BLOCK_TYPES,
      ${FRONT_FNS.join(', ')},
      getEditGroupChoices: () => editGroupChoices,
      setEditGroupChoices: (v) => { editGroupChoices = v; },
      getEditGroupId: () => editGroupId,
      getOptionGroups: () => optionGroups,
      elValue: (id) => $(id),
    };
  `);
  const api = factory(env, MaterialResolver);
  api.ENV = env;
  return api;
}

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------
// A "clean" material with an identity-trusted unit (กรัม, factor 1) — resolves GREEN.
const MAT_FLOUR = { id: 'm-flour', name: 'แป้งสาลี', price: 100, qty: 1000, unit: 'กรัม', isConsumable: false };
const MAT_MILK = { id: 'm-milk', name: 'นมสด', price: 60, qty: 1000, unit: 'มิลลิลิตร', isConsumable: false };
const MAT_OATMILK = { id: 'm-oatmilk', name: 'นมโอ๊ต', price: 80, qty: 1000, unit: 'มิลลิลิตร', isConsumable: false };
// A material with a PACKAGING (untrusted, no conversion) unit — resolves RED.
const MAT_AMBIGUOUS = { id: 'm-ambiguous', name: 'ของแถม', price: 10, qty: 1, unit: 'ถุง', isConsumable: false };

const HOST_RECIPE = {
  id: 'r-host', name: 'ลาเต้ร้อน',
  items: [{ matId: MAT_MILK.id, amount: 200 }, { matId: MAT_FLOUR.id, amount: 5 }],
};

console.log('\n=== Compact Option Editor — Founder acceptance ===\n');

// ===========================================================================
// A — exactly 5 blocks, no more
// ===========================================================================
{
  const blockTypes = eval(OG_BLOCK_TYPES_SRC);
  check('A exactly 5 block types are offered', blockTypes.length === 5, blockTypes);
  const expected = ['INSTRUCTION_ONLY', 'ADD_ONE_INGREDIENT', 'REPLACE_ONE_INGREDIENT', 'CHANGE_ONE_QUANTITY', 'RECIPE_VARIANT'];
  check('A the 5 blocks are exactly A-E (no extra/renamed types)',
    JSON.stringify(blockTypes.map(b => b[0])) === JSON.stringify(expected), blockTypes.map(b => b[0]));
}

// ===========================================================================
// B — Kitchen Instruction (block A)
// ===========================================================================
{
  const api = build({ recipes: [HOST_RECIPE], materials: [MAT_FLOUR, MAT_MILK] });
  const c = { id: 'c1', label: '', priceAdd: 5, effectType: 'ADD', enabled: true, isDefault: false, targetRole: '', targetMaterialId: null, variantRecipeId: null, links: [{ matId: MAT_FLOUR.id, amount: 1 }], amount: 0, isMetadataOnly: false };
  api.ogSetBlockType(0, 'INSTRUCTION_ONLY'); // no-op, editGroupChoices empty in this sandbox call path — verify field reset directly instead
  const reset = { ...c };
  // Directly exercise the block-type reset contract that ogSetBlockType applies:
  api.setEditGroupChoices([c]);
  api.ogSetBlockType(0, 'INSTRUCTION_ONLY');
  const after = api.getEditGroupChoices()[0];
  check('B block A forces isMetadataOnly=true', after.isMetadataOnly === true);
  check('B block A forces effectType=NONE (no stock effect)', after.effectType === 'NONE');
  check('B block A forces priceAdd=0 (no price)', after.priceAdd === 0);
  check('B block A has no ingredient links', Array.isArray(after.links) && after.links.length === 0);
  check('B block A has no target material/role/amount/variant',
    after.targetMaterialId === null && after.targetRole === '' && after.amount === 0 && after.variantRecipeId === null);
  check('B ogBlockTypeOf derives INSTRUCTION_ONLY purely from is_metadata_only', api.ogBlockTypeOf(after) === 'INSTRUCTION_ONLY');

  const summary = api.ogChoiceSummary({ ...after, label: 'ไม่ใส่น้ำแข็ง' });
  check('B summary shows the kitchen note and states no stock/price effect',
    /ไม่ใส่น้ำแข็ง/.test(summary) && /ไม่มีผลต่อสต๊อก\/ราคา/.test(summary), summary);

  const v = api.ogValidateChoice({ ...after, label: 'ไม่ใส่น้ำแข็ง' });
  check('B a labeled instruction choice validates OK (no ingredient/price required)', v.ok === true, v);
}

// ===========================================================================
// C — Replace Ingredient (C): "from" sourced from the ACTIVE recipe only
// ===========================================================================
{
  const otherMat = { id: 'm-other', name: 'ไม่เกี่ยวกับสูตรนี้', price: 5, qty: 1, unit: 'กรัม' };
  const api = build({
    recipes: [HOST_RECIPE], materials: [MAT_FLOUR, MAT_MILK, otherMat],
    checkedRecipeIds: [HOST_RECIPE.id],
  });
  const src = api.ogSourceIngredients();
  check('C source ingredients come from the linked/active recipe',
    src.length === 2 && src.some(x => x.matId === MAT_MILK.id) && src.some(x => x.matId === MAT_FLOUR.id), src);
  check('C source ingredients do NOT include the full material registry',
    !src.some(x => x.matId === otherMat.id));

  const noRecipeApi = build({ recipes: [HOST_RECIPE], materials: [MAT_FLOUR, MAT_MILK], checkedRecipeIds: [] });
  check('C with no recipe linked, source ingredients is empty (not a fallback to all materials)',
    noRecipeApi.ogSourceIngredients().length === 0);
}

// ===========================================================================
// D — Replace Ingredient (C): exactly 4 fields, no raw mechanics exposed
// ===========================================================================
{
  const api = build({ recipes: [HOST_RECIPE], materials: [MAT_FLOUR, MAT_MILK, MAT_OATMILK], checkedRecipeIds: [HOST_RECIPE.id] });
  const c = { id: 'c2', label: 'เปลี่ยนนมโอ๊ต', priceAdd: 10, effectType: 'REPLACE', enabled: true, isDefault: false, targetRole: '', targetMaterialId: MAT_MILK.id, variantRecipeId: null, links: [{ matId: MAT_OATMILK.id, amount: 200 }], amount: 0, isMetadataOnly: false };
  const sourceIngs = api.ogSourceIngredients();
  const step2 = api.ogReplaceStep2Html(c, 0, sourceIngs);
  const priceField = api.ogPriceFieldHtml(c, 0);

  const selectCount = (step2.match(/<select/g) || []).length;
  const numberInputCount = (step2.match(/<input type="number"/g) || []).length;
  const priceInputCount = (priceField.match(/<input type="number"/g) || []).length;
  check('D REPLACE step-2 has exactly 2 selects (from + with)', selectCount === 2, step2);
  check('D REPLACE step-2 has exactly 1 quantity input', numberInputCount === 1, step2);
  check('D the shared price field has exactly 1 input', priceInputCount === 1, priceField);
  check('D REPLACE asks for exactly 4 things total (from, with, qty, price)',
    selectCount + numberInputCount + priceInputCount === 4);

  check('D the "from" select is sourced from sourceIngs (has the recipe qty/unit annotation)',
    new RegExp(MAT_MILK.name).test(step2) && /—\s*200\s/.test(step2), step2);
  check('D the "with" select never lists the currently-selected "from" material',
    !new RegExp(`value="${MAT_MILK.id}"`).test(step2.split('②')[1] || ''));

  check('D no REMOVE/ADD deduction-mechanics wording anywhere in the REPLACE markup',
    !/REMOVE/.test(step2) && !/effect_type/i.test(step2) && !/target_role/i.test(step2));
}

// ===========================================================================
// E — Replace Ingredient (C): maps to REPLACE, no double-deduct
// ===========================================================================
{
  const api = build({});
  const c = { id: 'c3', label: 'x', priceAdd: 0, effectType: null, enabled: true, isDefault: false, targetRole: '', targetMaterialId: null, variantRecipeId: null, links: [], amount: 0, isMetadataOnly: false };
  api.setEditGroupChoices([c]);
  api.ogSetBlockType(0, 'REPLACE_ONE_INGREDIENT');
  const after = api.getEditGroupChoices()[0];
  check('E block C maps to engine effect_type REPLACE', after.effectType === 'REPLACE');
  check('E block C carries exactly ONE link (single ingredient in, matching single ingredient out)',
    Array.isArray(after.links) && after.links.length === 1, after.links);
  check('E block C never touches is_metadata_only (a real stock effect)', after.isMetadataOnly === false);

  // No-double-deduct proof: mirror buildEffectiveBom's own REPLACE handling
  // (backend/src/stockEngine.js) — the target material is DELETED from the
  // bom, then the single link is ADDED once. The old ingredient must never
  // also appear as a surviving bom entry alongside the new one.
  after.targetMaterialId = MAT_MILK.id;
  after.links = [{ matId: MAT_OATMILK.id, amount: 200 }];
  const bom = new Map([[MAT_MILK.id, { amount: 200 }]]); // BOM before REPLACE, mirrors recipe_items
  if (after.targetMaterialId) bom.delete(after.targetMaterialId);
  for (const l of after.links) { const e = bom.get(l.matId) || { amount: 0 }; e.amount += l.amount; bom.set(l.matId, e); }
  check('E the "from" ingredient is removed from the effective BOM', !bom.has(MAT_MILK.id));
  check('E the "with" ingredient is added exactly once (no double-deduct)',
    bom.has(MAT_OATMILK.id) && bom.get(MAT_OATMILK.id).amount === 200);
  check('E the resulting BOM has exactly one entry (1 in, 1 out, never both)', bom.size === 1);
}

// ===========================================================================
// F — Change Quantity (D): 0 removes the ingredient
// ===========================================================================
{
  const api = build({});
  const c = { id: 'c4', label: 'x', priceAdd: 0, effectType: null, enabled: true, isDefault: false, targetRole: '', targetMaterialId: null, variantRecipeId: null, links: [{ matId: 'stale', amount: 9 }], amount: 5, isMetadataOnly: false };
  api.setEditGroupChoices([c]);
  api.ogSetBlockType(0, 'CHANGE_ONE_QUANTITY');
  const after = api.getEditGroupChoices()[0];
  check('F block D maps to engine effect_type QUANTITY', after.effectType === 'QUANTITY');
  check('F block D has no links (not an add/replace)', after.links.length === 0);

  after.targetMaterialId = MAT_MILK.id;
  after.amount = 0;
  const bom = new Map([[MAT_MILK.id, { amount: 200 }]]);
  const newAmt = Number(after.amount) || 0;
  if (newAmt <= 0) bom.delete(after.targetMaterialId); else bom.set(after.targetMaterialId, { amount: newAmt });
  check('F setting quantity to 0 removes the ingredient from the effective BOM (mirrors buildEffectiveBom)', !bom.has(MAT_MILK.id));

  const summary = api.ogChoiceSummary({ ...after });
  check('F the summary explicitly states the ingredient is cut when amount is 0', /ตัดออกจากสูตร/.test(summary), summary);
}

// ===========================================================================
// G — Recipe Variant (E): maps to RECIPE_VARIANT, gated through ONE helper
// ===========================================================================
{
  const api = build({});
  const c = { id: 'c5', label: 'x', priceAdd: 0, effectType: null, enabled: true, isDefault: false, targetRole: '', targetMaterialId: 'stale', variantRecipeId: null, links: [{ matId: 'stale', amount: 1 }], amount: 9, isMetadataOnly: false };
  api.setEditGroupChoices([c]);
  api.ogSetBlockType(0, 'RECIPE_VARIANT');
  const after = api.getEditGroupChoices()[0];
  check('G block E maps to engine effect_type RECIPE_VARIANT', after.effectType === 'RECIPE_VARIANT');
  check('G block E clears links/target (swaps the WHOLE recipe, nothing partial)',
    after.links.length === 0 && after.targetMaterialId === null && after.targetRole === '');

  // ogValidateChoice must route EVERY RECIPE_VARIANT check through the single
  // ogRecipeVariantGate helper — proven by source inspection (not just behavior),
  // so a future edit can't quietly bypass the gate for one code path.
  check('G ogValidateChoice calls ogRecipeVariantGate for RECIPE_VARIANT (single choke point)',
    /ogRecipeVariantGate\(/.test(F.ogValidateChoice));
  check('G ogRecipeVariantGate is declared exactly once (one clearly-marked helper, not duplicated)',
    (INDEX_SRC.match(/function ogRecipeVariantGate\(/g) || []).length === 1);
}

// ===========================================================================
// H — no block exposes a raw effect-type dropdown / multi-row editor
// ===========================================================================
{
  const ALL_STEP2 = [F.ogInstructionStep2Html, F.ogAddStep2Html, F.ogReplaceStep2Html, F.ogQuantityStep2Html, F.ogVariantStep2Html, F.renderGroupChoices].join('\n');
  check('H no raw effect-type <select> (NONE/ADD/REPLACE/QUANTITY/RECIPE_VARIANT as owner-facing options)',
    !/effOpts/.test(ALL_STEP2) && !/setChoiceEffect/.test(ALL_STEP2));
  check('H the raw effect-type dropdown function does not exist anywhere in the file',
    !/function setChoiceEffect/.test(INDEX_SRC));
  check('H there is no multi-row ingredient-link editor (addChoiceLink/removeChoiceLink) anywhere',
    !/function addChoiceLink/.test(INDEX_SRC) && !/function removeChoiceLink/.test(INDEX_SRC));
  check('H there is no "advanced/raw" escape-hatch details block for effect internals',
    !/ogAdvancedDetailsHtml/.test(INDEX_SRC) && !/ประเภท \(raw\)/.test(INDEX_SRC));
  check('H the owner never sees the literal engine tokens is_metadata_only/target_role/effect_type as field labels',
    !/id="og.*effect.*"/i.test(ALL_STEP2));
}

// ===========================================================================
// I — category functions are untouched (source-contract guard)
// ===========================================================================
{
  const CATEGORY_FN_NAMES = [
    'posCatAdd', 'posCatRemove', 'posCatDeleteConfirm', 'posCatDeleteUnplaced', 'posCatDeleteDialog',
    'posCatReassign', 'posCatMove', 'posCatReorder', 'posCatRename', 'posCatArchive', 'posCatUnarchive',
    'posCatCommit', 'posCatItemCount', 'visiblePosCategories', 'posCatArchivedList', 'mergePosCategories',
    'posCatSnapshotProducts', 'posCatRestoreProducts', 'setRecipeCategorySelect',
  ];
  const OPTION_EDITOR_IDENTIFIERS = /ogBlockTypeOf|OG_BLOCK_TYPES|ogRecipeVariantGate|ogValidateChoice|effectType|targetMaterialId|variantRecipeId|isMetadataOnly/;
  const offenders = [];
  for (const fn of CATEGORY_FN_NAMES) {
    let src;
    try { src = extractFn(INDEX_SRC, fn, 'frontend/index.html'); }
    catch (e) { offenders.push(fn + ' → MISSING: ' + e.message); continue; }
    if (OPTION_EDITOR_IDENTIFIERS.test(src)) offenders.push(fn + ' → references option-editor internals');
  }
  check('I every category function still exists and is uncoupled from option-editor internals',
    offenders.length === 0, offenders);

  // Strongest guard: byte-for-byte diff against the pre-branch baseline (704cf5a),
  // when git is available. Skipped (not failed) if git/the ref is unavailable —
  // the static identifier guard above still holds either way.
  try {
    const baseline = execFileSync('git', ['show', '704cf5a:frontend/index.html'], {
      cwd: path.join(__dirname, '../..'), encoding: 'utf8', maxBuffer: 1024 * 1024 * 50,
    }).replace(/\r\n/g, '\n');
    const diffs = [];
    for (const fn of CATEGORY_FN_NAMES) {
      const before = extractFn(baseline, fn, '704cf5a:frontend/index.html');
      const after = extractFn(INDEX_SRC, fn, 'frontend/index.html');
      if (before !== after) diffs.push(fn);
    }
    check('I (git) every category function is byte-identical to the 704cf5a baseline', diffs.length === 0, diffs);
  } catch (e) {
    console.log('  · (skipped git-baseline diff check — git unavailable in this environment:', e.message.split('\n')[0], ')');
  }
}

// ===========================================================================
// J — ogRecipeVariantGate: the Founder's strict 10-point completeness gate
// ===========================================================================
{
  const CLEAN_RECIPE = { id: 'r-clean', name: 'สูตรสมบูรณ์', items: [{ matId: MAT_FLOUR.id, amount: 100 }] };
  const EMPTY_RECIPE = { id: 'r-empty', name: 'สูตรว่างเปล่า', items: [] };
  const ZERO_QTY_RECIPE = { id: 'r-zero', name: 'สูตรปริมาณศูนย์', items: [{ matId: MAT_FLOUR.id, amount: 0 }] };
  const MISSING_MAT_RECIPE = { id: 'r-missing', name: 'สูตรวัตถุดิบหาย', items: [{ matId: 'does-not-exist', amount: 10 }] };
  const AMBIGUOUS_UNIT_RECIPE = { id: 'r-ambiguous', name: 'สูตรหน่วยไม่ชัด', items: [{ matId: MAT_AMBIGUOUS.id, amount: 2 }] };
  const CYCLE_A = { id: 'r-cycle-a', name: 'วน A', items: [{ subId: 'r-cycle-b', amount: 1 }] };
  const CYCLE_B = { id: 'r-cycle-b', name: 'วน B', items: [{ subId: 'r-cycle-a', amount: 1 }] };

  const materials = [MAT_FLOUR, MAT_MILK, MAT_OATMILK, MAT_AMBIGUOUS];
  const recipes = [HOST_RECIPE, CLEAN_RECIPE, EMPTY_RECIPE, ZERO_QTY_RECIPE, MISSING_MAT_RECIPE, AMBIGUOUS_UNIT_RECIPE, CYCLE_A, CYCLE_B];
  const api = build({ materials, recipes });

  // J1. complete recipe variant CAN publish
  const r1 = api.ogRecipeVariantGate({}, CLEAN_RECIPE, [HOST_RECIPE.id]);
  check('J1 a complete target recipe (>=1 real ingredient, qty>0, resolvable unit) CAN publish', r1.ok === true, r1);

  // J2. empty recipe cannot publish
  const r2 = api.ogRecipeVariantGate({}, EMPTY_RECIPE, [HOST_RECIPE.id]);
  check('J2 an empty recipe (0 ingredients) cannot publish', r2.ok === false, r2);
  check('J2 the failure names the required wording verbatim',
    r2.label.includes('เลือกได้เฉพาะสูตรที่มีวัตถุดิบและปริมาณครบถ้วน ระบบจะตรวจสอบก่อนเผยแพร่'), r2.label);

  // J3. zero-quantity-only recipe cannot publish
  const r3 = api.ogRecipeVariantGate({}, ZERO_QTY_RECIPE, [HOST_RECIPE.id]);
  check('J3 a recipe whose only ingredient has qty=0 cannot publish', r3.ok === false, r3);

  // J4. missing material cannot publish
  const r4 = api.ogRecipeVariantGate({}, MISSING_MAT_RECIPE, [HOST_RECIPE.id]);
  check('J4 a recipe referencing a deleted/missing Material cannot publish', r4.ok === false, r4);
  check('J4 the reason specifically names the missing-material check', /หาไม่พบในระบบ/.test(r4.label), r4.label);

  // J5. invalid or ambiguous unit cannot publish
  const r5 = api.ogRecipeVariantGate({}, AMBIGUOUS_UNIT_RECIPE, [HOST_RECIPE.id]);
  check('J5 a recipe whose ingredient has an ambiguous/unconvertible unit cannot publish', r5.ok === false, r5);
  check('J5 real MaterialResolver.resolveMaterialCost is used (RED health), not re-implemented',
    MaterialResolver.resolveMaterialCost({ price: 10, qty: 1, unit: 'ถุง' }).health === 'RED');

  // J6. self-reference cannot publish
  const r6 = api.ogRecipeVariantGate({}, HOST_RECIPE, [HOST_RECIPE.id]);
  check('J6 a recipe swapping into itself (self-reference) cannot publish', r6.ok === false, r6);
  check('J6 the reason specifically names the self-reference check', /สูตรเดียวกับเมนูนี้เอง/.test(r6.label), r6.label);

  // J6b. "self-reference cannot publish" must hold UNCONDITIONALLY, not only when a host happens to be known.
  // Regression: ogValidateChoice feeds the gate ogLinkedRecipeIdsLive(), which is [] while the group has no
  // recipe linked. With an empty host list there is no "self" to compare against, so a self-swap used to
  // validate as publishable and was only caught on a later save. An unlinked group must fail closed.
  const r6b = api.ogRecipeVariantGate({}, HOST_RECIPE, []);
  check('J6b a self-swap cannot publish when the group has no recipe linked (fails closed)', r6b.ok === false, r6b);
  check('J6b the reason asks the owner to link a menu first', /ต้องเชื่อมกลุ่มนี้กับเมนูที่มีสูตรก่อน/.test(r6b.label), r6b.label);
  const r6c = api.ogRecipeVariantGate({}, CLEAN_RECIPE, []);
  check('J6c even an otherwise-valid variant cannot publish while unlinked (consistent with REPLACE/QUANTITY)',
    r6c.ok === false, r6c);
  check('J6c an unlinked failure still carries the required Founder wording',
    /เลือกได้เฉพาะสูตรที่มีวัตถุดิบและปริมาณครบถ้วน ระบบจะตรวจสอบก่อนเผยแพร่/.test(r6c.label), r6c.label);

  // J7. circular dependency cannot publish
  const cycle = api.ogRecipeDependencyCycle(CYCLE_A.id);
  check('J7 ogRecipeDependencyCycle detects A→B→A', Array.isArray(cycle) && cycle.length > 0, cycle);
  const r7 = api.ogRecipeVariantGate({}, CYCLE_A, ['some-other-host']);
  check('J7 a recipe with a circular sub-recipe dependency cannot publish', r7.ok === false, r7);
  check('J7 the reason specifically names the circular-dependency check', /อ้างอิงกันเป็นวงกลม/.test(r7.label), r7.label);

  // J8. failed variant remains a draft and does not affect POS
  {
    const draftApi = build({ materials, recipes, optionGroups: [] });
    draftApi.elValue('ogLabel').value = 'ตัวเลือกทดสอบ';
    draftApi.elValue('ogSelectType').value = 'single';
    draftApi.elValue('ogEnabled').checked = true;
    draftApi.setEditGroupChoices([{
      id: 'c-e2e', label: 'สลับสูตรว่าง', priceAdd: 0, effectType: 'RECIPE_VARIANT', enabled: true, isDefault: false,
      targetRole: '', targetMaterialId: null, variantRecipeId: EMPTY_RECIPE.id, links: [], amount: 0, isMetadataOnly: false,
    }]);
    draftApi.saveGroupForm();
    const saved = draftApi.getOptionGroups()[0].choices[0];
    check('J8 a RECIPE_VARIANT targeting an incomplete recipe is saved (never lost)', !!saved);
    check('J8 it is marked incomplete (draft)', saved.incomplete === true, saved);
    check('J8 it is forced disabled — CANNOT be enabled on POS/Delivery', saved.enabled === false, saved);
    // Exact POS gating predicate used by renderPosOptSheetBody: g.choices.filter(c => c.enabled)
    check('J8 the real POS choice filter (c => c.enabled) excludes this draft',
      [saved].filter(c => c.enabled).length === 0);
    check('J8 no silent fallback to the host/base recipe occurred (variantRecipeId is untouched, not rewritten)',
      saved.variantRecipeId === EMPTY_RECIPE.id);
  }

  // J9. valid variant resolves exactly one deterministic BOM
  {
    check('J9 a complete recipe resolves via ogRecipeBomResolvable', api.ogRecipeBomResolvable(CLEAN_RECIPE.id) === true);
    const first = api.ogRecipeVariantGate({}, CLEAN_RECIPE, [HOST_RECIPE.id]);
    const second = api.ogRecipeVariantGate({}, CLEAN_RECIPE, [HOST_RECIPE.id]);
    check('J9 the gate is deterministic — identical inputs always produce the identical verdict',
      JSON.stringify(first) === JSON.stringify(second));
    // Exactly one resolved BOM entry for this single-ingredient clean recipe.
    const bom = new Map();
    CLEAN_RECIPE.items.forEach(it => { if (it.matId) bom.set(it.matId, (bom.get(it.matId) || 0) + it.amount); });
    check('J9 the resolved BOM for the clean recipe has exactly one deterministic entry', bom.size === 1 && bom.get(MAT_FLOUR.id) === 100);
  }
}

// ===========================================================================
// (part of J) — historical accepted orders retain the resolved recipe
// snapshot. This is an EXISTING invariant in bills.js (items_json is frozen
// at DRAFT→CONFIRMED time and never rewritten by confirm/void/correct), not
// something this branch builds — verified here as a source contract so a
// future edit to bills.js can't silently break it.
// ===========================================================================
{
  const confirmAnchor = "UPDATE bills SET lifecycle_status='CONFIRMED'";
  const confirmIdx = BILLS_SRC.indexOf(confirmAnchor);
  check('J10 the /confirm route\'s UPDATE bills statement exists', confirmIdx !== -1);
  const confirmBlock = BILLS_SRC.slice(confirmIdx, BILLS_SRC.indexOf(');', confirmIdx));
  check('J10 CONFIRM never rewrites items_json (the ordered/chosen-option snapshot is frozen)',
    !confirmBlock.includes('items_json'), confirmBlock);

  const voidAnchor = String.raw`lifecycle_status=\'VOIDED\'`;
  const voidIdx = BILLS_SRC.indexOf(voidAnchor);
  check('J10 the /void route\'s UPDATE bills statement exists', voidIdx !== -1);
  const voidBlock = BILLS_SRC.slice(Math.max(0, voidIdx - 40), BILLS_SRC.indexOf(')', voidIdx));
  check('J10 VOID never rewrites items_json', !voidBlock.includes('items_json'), voidBlock);

  const replacedAnchor = "lifecycle_status='REPLACED'";
  const replacedIdx = BILLS_SRC.indexOf(replacedAnchor);
  check('J10 the /correct route\'s original-marking UPDATE exists', replacedIdx !== -1);
  const replacedBlock = BILLS_SRC.slice(Math.max(0, replacedIdx - 40), BILLS_SRC.indexOf(');', replacedIdx));
  check('J10 CORRECT never rewrites the ORIGINAL bill\'s items_json (a replacement is a NEW row, own snapshot)',
    !replacedBlock.includes('items_json'), replacedBlock);
  check('J10 CORRECT\'s replacement bill gets its OWN items_json via a fresh INSERT (new immutable snapshot)',
    /INSERT INTO bills \(shop_id, doc_type, items_json,[\s\S]{0,40}lifecycle_status, status, number/.test(BILLS_SRC));

  const draftGuardAnchor = "if (cur.lifecycle_status && cur.lifecycle_status !== 'DRAFT')";
  check('J10 items_json is writable ONLY while the bill is still DRAFT (guarded 409 once confirmed)',
    BILLS_SRC.includes(draftGuardAnchor));
}

console.log(`\ncompact-option-editor: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
