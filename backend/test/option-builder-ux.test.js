// Option Builder UX rebuild — pure unit tests (no DB, no browser).
// node backend/test/option-builder-ux.test.js
//
// Context: the Compact Option Editor (backend/test/compact-option-editor.test.js)
// PASSED its five-block acceptance criteria but FAILED Founder authoring
// testing — "forces the owner to think in technical ingredient replacement
// instead of menu customization." This suite proves the CUSTOMER-INTENT
// authoring layer built on top of it in frontend/index.html: the two-level
// model (Level 1 = option group = customer intent, Level 2 = option item =
// one of the unchanged 5 blocks), the menu eligibility engine, the guided
// Replace/Add/Change-Quantity flows, the impact preview, the large-menu
// selector, and legacy compatibility classification.
//
// Same extraction technique as compact-option-editor.test.js: extractFn
// pulls REAL function bodies out of frontend/index.html and evals them in a
// minimal sandbox, so a rename/deletion fails loudly instead of silently
// testing nothing. This file owns its OWN function list — it never edits
// compact-option-editor.test.js.
//
// Test groups (20 acceptance points from the task):
//   1  — eligibility: selecting a source material returns only recipes containing it
//   2  — eligibility: a recipe lacking the material is excluded
//   3  — eligibility: matches by canonical ID, never by name
//   4  — Replace cannot link to an ineligible menu (validation blocks it)
//   5  — MATCH_SOURCE uses each recipe's own actual quantity
//   6  — FIXED warns on mismatches
//   7  — impact preview lists every affected menu
//   8  — invalid/mismatched menus stay visible as review items (never dropped)
//   9  — Add eligibility filter: all / containing / manual
//   10 — Change Quantity: absolute (FIXED)
//   11 — Change Quantity: percent-of-base (10→5, 15→7.5)
//   12 — Recipe Variant gate still safe (unchanged)
//   13 — instruction-only has no stock/price/recipe effect
//   14 — no technical effect rows or raw IDs reach owner-facing UI
//   15 — search/category/selected-only filters + select-all/clear-all-visible + counts
//   16 — draft survives a save→reload round-trip
//   17 — an invalid option cannot reach POS (enabled=false)
//   18 — a valid option resolves a deterministic BOM/quantity
//   19 — a valid option resolves the correct price
//   20 — quantity mode is always read from the stored mode, never inferred from a label
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log('  ✓', name); }
  else { failed++; console.log('  ✗', name, extra !== undefined ? JSON.stringify(extra) : ''); }
}

const readSrc = (p) => fs.readFileSync(path.join(__dirname, p), 'utf8').replace(/\r\n/g, '\n');
const INDEX_SRC = readSrc('../../frontend/index.html');
const SYNC_SRC = readSrc('../src/api/sync.js');
const MIGRATE_SRC = readSrc('../src/migrate.js');
const SCHEMA_AUTHORING_SRC = readSrc('../db/schema-option-authoring.sql');

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
// Extracts the parenthesised arrow expression immediately following an
// anchor that ENDS with '(' — e.g. anchor '....map(' yields the source text
// '(c => ({...}))', which evals directly to the real function. Used to pull
// the REAL bootstrap mapper / sync payload builder out of the two large
// enclosing functions (applyBootstrapData / syncToSupabase) without having
// to stand up their entire global environment.
function extractArrowAfter(src, anchor, label) {
  const idx = src.indexOf(anchor);
  if (idx === -1) throw new Error('cannot find anchor "' + anchor + '" in ' + (label || 'source'));
  const open = idx + anchor.length - 1; // the '(' that anchor ends with
  let depth = 0, i = open, inStr = null, inTpl = false;
  for (; i < src.length; i++) {
    const ch = src[i], prev = src[i - 1];
    if (inStr) { if (ch === inStr && prev !== '\\') inStr = null; continue; }
    if (inTpl) { if (ch === '`' && prev !== '\\') inTpl = false; continue; }
    if (ch === '"' || ch === "'") { inStr = ch; continue; }
    if (ch === '`') { inTpl = true; continue; }
    if (ch === '/' && src[i + 1] === '/') { const nl = src.indexOf('\n', i); i = nl === -1 ? src.length : nl; continue; }
    if (ch === '(') depth++;
    else if (ch === ')') { depth--; if (depth === 0) { i++; break; } }
  }
  return src.slice(open, i);
}

// recIsOnMenu is a `const recIsOnMenu = r => ...` arrow function defined
// elsewhere in index.html (used by ogRecipeUsedIngredients/
// ogEligibleMenusForMaterial/ogAddEligibleMenus). Extracted verbatim (not
// re-implemented) so this suite can never silently drift from production.
function extractStatement(src, anchor) {
  const idx = src.indexOf(anchor);
  if (idx === -1) throw new Error('cannot find statement starting with: ' + anchor);
  const end = src.indexOf(';', idx);
  return src.slice(idx, end + 1);
}
const REC_IS_ON_MENU_SRC = extractStatement(INDEX_SRC, 'const recIsOnMenu = ');

// Every option-builder-UX function the sandbox links together, in source order.
const FRONT_FNS = [
  // unchanged engine/derivation layer (reused, not re-implemented)
  'ogBlockLabel', 'ogBlockTypeOf', 'ogLinkedRecipeIdsLive', 'ogSourceIngredients',
  'ogRecipeDependencyCycle', 'ogRecipeBomResolvable', 'ogRecipeVariantGate',
  'ogValidateChoice', 'ogChoiceSummary', 'ogDetectConflicts',
  // customer-intent authoring layer (new)
  'ogIntentBlockType', 'ogApplyIntent',
  'ogEffectiveRecipeBom', 'ogRecipeUsedIngredients', 'ogEligibleMenusForMaterial',
  'ogLinkedRecipesMissingSource', 'ogLegacyClassifyChoice',
  'ogResolveReplaceQuantity', 'ogResolveChangeQuantity', 'ogReplaceMismatches',
  'ogAddEligibleMenus', 'ogMenuSelectorState', 'ogImpactPreview',
  'ogSetQuantityMode', 'ogSetQuantityValue', 'ogSetAddMenuMode', 'ogAckMismatch', 'ogSetKitchenNote',
  'ogNumFocus', 'ogNumTargetSet', 'ogNumInput', 'ogNumBlur',
  'ogRenderIntentStepHtml', 'ogRenderLegacyBadge', 'ogRenderImpactPreviewHtml',
  // rendering / form lifecycle (exercised for the round-trip + UI-text tests)
  'renderOptionsPage', 'openGroupForm', 'ogInstructionStep2Html', 'ogAddStep2Html',
  'ogReplaceStep2Html', 'ogQuantityStep2Html', 'ogVariantStep2Html', 'ogPriceFieldHtml',
  'renderGroupChoices', 'ogRefreshChoicePreview', 'setChoiceDefault', 'ogChoiceSetLink',
  'ogSetBlockType', 'addChoiceRow', 'renderGroupRecipePicker', 'ogSelectAllVisibleMenus',
  'ogClearAllVisibleMenus', 'saveGroupForm',
];
const F = {};
for (const n of FRONT_FNS) F[n] = extractFn(INDEX_SRC, n, 'frontend/index.html');
const OG_BLOCK_TYPES_SRC = extractConst(INDEX_SRC, 'OG_BLOCK_TYPES');
const OG_INTENT_STARTERS_SRC = extractConst(INDEX_SRC, 'OG_INTENT_STARTERS');

// ---------------------------------------------------------------------------
// Sandbox — a minimal, DOM-free environment plus a tiny fake element
// registry so the large-menu-selector filters/checkbox state can be
// exercised end-to-end (search/category/selected-only + select/clear-all-
// visible), not just as isolated pure functions.
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
  };
  // Fake checkbox registry keyed by recipeId, rebuilt every time
  // renderGroupRecipePicker runs (mirrors innerHTML replacement) — lets
  // ogSelectAllVisibleMenus/ogClearAllVisibleMenus + the picker's own
  // :checked query operate against real, queryable state.
  const chkRegistry = new Map();
  const preamble = `
    const OG_BLOCK_TYPES = ${OG_BLOCK_TYPES_SRC};
    const OG_INTENT_STARTERS = ${OG_INTENT_STARTERS_SRC};
    ${REC_IS_ON_MENU_SRC}
    let editGroupId = null;
    let editGroupChoices = [];
    let groupIntentKey = null;
    let ogMenuFilter = { search: '', category: '', selectedOnly: false };
    let optionGroups = ENV.optionGroups;
    const materials = ENV.materials;
    const recipes = ENV.recipes;
    const window = { MaterialResolver: null };
    const uid = () => 'u' + Math.random().toString(36).slice(2);
    const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const money = n => String(Number(n) || 0);
    const icon = (name) => '<i data-icon="' + name + '"></i>';
    const baseU = m => m.stockUnit || m.unit;
    const recById = id => recipes.find(r => r.id === id);
    const matById = id => materials.find(m => m.id === id);
    const _els = {};
    function $(id) { if (!_els[id]) _els[id] = { value: '', checked: false, innerHTML: '' }; return _els[id]; }
    // ---- fake #ogRecipePicker checkbox registry --------------------------
    function _rebuildPickerRegistry(html) {
      CHK.clear();
      const re = /<input type="checkbox" class="og-recipe-chk" data-rid="([^"]+)" data-visible="([01])"( checked)?/g;
      let m;
      while ((m = re.exec(html))) CHK.set(m[1], { dataset: { rid: m[1], visible: m[2] }, checked: !!m[3] });
    }
    const document = {
      querySelectorAll: (sel) => {
        if (sel === '.og-recipe-chk:checked') return [...CHK.values()].filter(el => el.checked);
        if (sel === '#ogRecipePicker .og-recipe-chk[data-visible="1"]') return [...CHK.values()].filter(el => el.dataset.visible === '1');
        return [];
      },
      getElementById: () => null,
    };
    const ui = { toast: (msg, kind) => ENV.toasts.push({ msg, kind }) };
    function renderIcons() {}
    function openDrawer() {}
    function closeDrawer() {}
    function saveAll() { ENV.saveAllCalls++; }
  `;
  const body = FRONT_FNS.map(n => F[n]).join('\n\n');
  const factory = new Function('ENV', 'CHK', preamble + '\n' + body + `
    // wrap $('ogRecipePicker') writes so the fake DOM registry stays in
    // sync with whatever HTML renderGroupRecipePicker just produced.
    const _origPickerEl = $('ogRecipePicker');
    Object.defineProperty(_origPickerEl, 'innerHTML', {
      get() { return this._html || ''; },
      set(v) { this._html = v; _rebuildPickerRegistry(v); },
    });
    return {
      OG_BLOCK_TYPES, OG_INTENT_STARTERS,
      ${FRONT_FNS.join(', ')},
      getEditGroupChoices: () => editGroupChoices,
      setEditGroupChoices: (v) => { editGroupChoices = v; },
      getEditGroupId: () => editGroupId,
      getOptionGroups: () => optionGroups,
      getGroupIntentKey: () => groupIntentKey,
      getMenuFilter: () => ogMenuFilter,
      setMenuFilter: (v) => { Object.assign(ogMenuFilter, v); },
      elValue: (id) => $(id),
      checkRecipe: (rid, checked) => { const el = CHK.get(rid); if (el) el.checked = checked; },
      pickerHtml: () => $('ogRecipePicker').innerHTML,
    };
  `);
  const api = factory(env, chkRegistry);
  api.ENV = env;
  api.CHK = chkRegistry;
  // Seed the fake checkbox registry from opts.checkedRecipeIds so
  // ogLinkedRecipeIdsLive()'s document.querySelectorAll('.og-recipe-chk:checked')
  // reflects it immediately, without requiring a prior renderGroupRecipePicker call.
  (opts.checkedRecipeIds || []).forEach(rid => chkRegistry.set(rid, { dataset: { rid, visible: '1' }, checked: true }));
  return api;
}

// ---------------------------------------------------------------------------
// Shared fixtures — generic café/bar catalogue. No HIBI/matcha/tea/branch
// names anywhere (Founder platform rule).
// ---------------------------------------------------------------------------
const MAT_MILK = { id: 'm-milk', name: 'นมสด', price: 60, qty: 1000, unit: 'มิลลิลิตร', isConsumable: false };
const MAT_OATMILK = { id: 'm-oat', name: 'นมโอ๊ต', price: 80, qty: 1000, unit: 'มิลลิลิตร', isConsumable: false };
const MAT_ALMONDMILK = { id: 'm-almond', name: 'นมอัลมอนด์', price: 90, qty: 1000, unit: 'มิลลิลิตร', isConsumable: false };
const MAT_SYRUP = { id: 'm-syrup', name: 'ไซรัป', price: 40, qty: 1000, unit: 'มิลลิลิตร', isConsumable: false };
const MAT_SHOT = { id: 'm-shot', name: 'เอสเพรสโซ่ช็อต', price: 12, qty: 100, unit: 'ช็อต', isConsumable: false };
// Same DISPLAY NAME as MAT_MILK but a DIFFERENT canonical id — proves the
// eligibility engine matches by ID, never by free-text name (test group 3).
const MAT_MILK_DUP_NAME = { id: 'm-milk-lookalike', name: 'นมสด', price: 55, qty: 1000, unit: 'มิลลิลิตร', isConsumable: false };

const REC_LATTE = { id: 'r-latte', name: 'ลาเต้', category: 'เครื่องดื่มร้อน', items: [{ matId: MAT_MILK.id, amount: 200 }], onMenu: true, active: true, batchYield: 1, isRaw: false };
const REC_CAPPUCCINO = { id: 'r-capp', name: 'คาปูชิโน่', category: 'เครื่องดื่มร้อน', items: [{ matId: MAT_MILK.id, amount: 150 }], onMenu: true, active: true, batchYield: 1, isRaw: false };
const REC_HOTCHOC = { id: 'r-hotchoc', name: 'ช็อกโกแลตร้อน', category: 'เครื่องดื่มร้อน', items: [{ matId: MAT_MILK.id, amount: 180 }], onMenu: true, active: false, batchYield: 1, isRaw: false };
const REC_SMOOTHIE = { id: 'r-smoothie', name: 'สมูทตี้ผลไม้', category: 'เครื่องดื่มเย็น', items: [{ matId: MAT_SYRUP.id, amount: 10 }], onMenu: true, active: true, batchYield: 1, isRaw: false };
const REC_MOCKTAIL_INVALID = { id: 'r-mocktail', name: 'ม็อกเทลผลไม้', category: 'เครื่องดื่มเย็น', items: [], onMenu: true, active: true, batchYield: 1, isRaw: false };
const REC_AMERICANO = { id: 'r-americano', name: 'อเมริกาโน่', category: 'เครื่องดื่มร้อน', items: [{ matId: MAT_SHOT.id, amount: 1 }, { matId: MAT_SYRUP.id, amount: 15 }], onMenu: true, active: true, batchYield: 1, isRaw: false };
const REC_LOOKALIKE = { id: 'r-lookalike', name: 'เครื่องดื่มนมทางเลือก', category: 'เครื่องดื่มร้อน', items: [{ matId: MAT_MILK_DUP_NAME.id, amount: 100 }], onMenu: true, active: true, batchYield: 1, isRaw: false };

const ALL_MATERIALS = [MAT_MILK, MAT_OATMILK, MAT_ALMONDMILK, MAT_SYRUP, MAT_SHOT, MAT_MILK_DUP_NAME];
const ALL_RECIPES = [REC_LATTE, REC_CAPPUCCINO, REC_HOTCHOC, REC_SMOOTHIE, REC_MOCKTAIL_INVALID, REC_AMERICANO, REC_LOOKALIKE];

console.log('\n=== Option Builder UX — customer-intent authoring layer ===\n');

// ===========================================================================
// 1/2/3 — MENU ELIGIBILITY ENGINE
// ===========================================================================
{
  const api = build({ materials: ALL_MATERIALS, recipes: ALL_RECIPES });
  const eligible = api.ogEligibleMenusForMaterial(MAT_MILK.id);
  const ids = eligible.map(x => x.recipeId).sort();

  check('1 selecting a source material returns only recipes containing it',
    ids.length === 3 && ids.includes(REC_LATTE.id) && ids.includes(REC_CAPPUCCINO.id) && ids.includes(REC_HOTCHOC.id), ids);
  check('1 each eligible entry carries recipeId/recipeName/category/sourceAmount/sourceUnit/active/valid',
    eligible.every(x => 'recipeId' in x && 'recipeName' in x && 'category' in x && 'sourceAmount' in x && 'sourceUnit' in x && 'active' in x && 'valid' in x), eligible[0]);
  check('1 sourceAmount reflects the ACTUAL amount used in that recipe (latte 200)',
    eligible.find(x => x.recipeId === REC_LATTE.id).sourceAmount === 200);
  check('1 an inactive-but-still-linked menu is included, just flagged active:false (not excluded)',
    eligible.find(x => x.recipeId === REC_HOTCHOC.id).active === false);

  check('2 a recipe lacking the material is excluded (smoothie has no milk)',
    !ids.includes(REC_SMOOTHIE.id));
  check('2 a structurally invalid recipe (0 ingredients) is excluded outright',
    !ids.includes(REC_MOCKTAIL_INVALID.id));
  check('2 ogRecipeBomResolvable independently confirms the invalid recipe fails',
    api.ogRecipeBomResolvable(REC_MOCKTAIL_INVALID.id) === false);

  check('3 eligibility matches by canonical ID, not by free-text name (lookalike excluded)',
    !ids.includes(REC_LOOKALIKE.id));
  const eligibleForLookalike = api.ogEligibleMenusForMaterial(MAT_MILK_DUP_NAME.id);
  check('3 the SAME-NAME-different-ID material resolves to its OWN recipe only',
    eligibleForLookalike.length === 1 && eligibleForLookalike[0].recipeId === REC_LOOKALIKE.id, eligibleForLookalike);

  const usedIngs = api.ogRecipeUsedIngredients();
  const milkEntry = usedIngs.find(x => x.matId === MAT_MILK.id);
  check('ogRecipeUsedIngredients is a GLOBAL scan (never the whole Material Registry) with a "used in N menus" count',
    !!milkEntry && milkEntry.menuCount === 3, milkEntry);
  check('ogRecipeUsedIngredients never lists a material that appears in zero on-menu recipes',
    !usedIngs.some(x => x.matId === MAT_ALMONDMILK.id));
}

// ===========================================================================
// 4 — Replace cannot link to an ineligible menu
// ===========================================================================
{
  const api = build({ materials: ALL_MATERIALS, recipes: ALL_RECIPES, checkedRecipeIds: [REC_LATTE.id, REC_SMOOTHIE.id] });
  // REC_SMOOTHIE is linked to the group but does NOT contain MAT_MILK — the
  // eligibility engine must flag it as missing, and ogValidateChoice must
  // block publication (§10: "a selected menu lacks the source" / §3 hard filter).
  const missing = api.ogLinkedRecipesMissingSource(MAT_MILK.id, [REC_LATTE.id, REC_SMOOTHIE.id]);
  check('4 the eligibility check finds the ineligible linked menu', missing.length === 1 && missing[0].recipeId === REC_SMOOTHIE.id, missing);

  const choice = {
    id: 'c1', label: 'เปลี่ยนเป็นนมโอ๊ต', priceAdd: 10, effectType: 'REPLACE', enabled: true, isDefault: false,
    targetRole: '', targetMaterialId: MAT_MILK.id, variantRecipeId: null,
    links: [{ matId: MAT_OATMILK.id, amount: 200 }], amount: 0, isMetadataOnly: false,
    quantityMode: 'MATCH_SOURCE', quantityValue: null,
  };
  const v = api.ogValidateChoice(choice);
  check('4 ogValidateChoice BLOCKS publication while an ineligible menu is linked', v.ok === false, v);
  check('4 the failure names the specific ineligible menu (never silent)',
    v.items.some(it => !it.ok && /สมูทตี้ผลไม้/.test(it.label)), v.items);
}

// ===========================================================================
// 5 — MATCH_SOURCE uses each recipe's actual quantity
// ===========================================================================
{
  const api = build({});
  check('5 MATCH_SOURCE resolves to the SOURCE recipe\'s own amount (latte=200)',
    api.ogResolveReplaceQuantity({ quantityMode: 'MATCH_SOURCE', links: [{ matId: MAT_OATMILK.id, amount: 999 }] }, 200) === 200);
  check('5 MATCH_SOURCE resolves differently per recipe (capp=150)',
    api.ogResolveReplaceQuantity({ quantityMode: 'MATCH_SOURCE', links: [{ matId: MAT_OATMILK.id, amount: 999 }] }, 150) === 150);
  check('5 FIXED ignores the source amount and uses the link\'s own fixed amount',
    api.ogResolveReplaceQuantity({ quantityMode: 'FIXED', links: [{ matId: MAT_OATMILK.id, amount: 180 }] }, 200) === 180);
  check('5 legacy null quantityMode resolves as FIXED (unchanged behaviour, §11)',
    api.ogResolveReplaceQuantity({ quantityMode: null, links: [{ matId: MAT_OATMILK.id, amount: 180 }] }, 200) === 180);
}

// ===========================================================================
// 6 — FIXED warns on mismatches
// ===========================================================================
{
  const api = build({ materials: ALL_MATERIALS, recipes: ALL_RECIPES });
  const eligible = api.ogEligibleMenusForMaterial(MAT_MILK.id).filter(m => m.recipeId !== REC_HOTCHOC.id);
  const fixedChoice = { quantityMode: 'FIXED', links: [{ matId: MAT_OATMILK.id, amount: 200 }] };
  const mismatches = api.ogReplaceMismatches(fixedChoice, eligible);
  check('6 a FIXED choice flags every eligible menu whose OWN amount differs (capp=150 vs fixed=200)',
    mismatches.length === 1 && mismatches[0].recipeId === REC_CAPPUCCINO.id, mismatches);

  const matchSourceChoice = { quantityMode: 'MATCH_SOURCE', links: [{ matId: MAT_OATMILK.id, amount: 200 }] };
  check('6 MATCH_SOURCE never reports mismatches (there is no fixed amount to mismatch against)',
    api.ogReplaceMismatches(matchSourceChoice, eligible).length === 0);

  // ogValidateChoice must block until the mismatch is explicitly resolved —
  // never silently proceed with a mismatched FIXED amount.
  const cUnresolved = { id: 'c2', label: 'x', priceAdd: 0, effectType: 'REPLACE', enabled: true, isDefault: false, targetRole: '', targetMaterialId: MAT_MILK.id, variantRecipeId: null, links: [{ matId: MAT_OATMILK.id, amount: 200 }], amount: 0, isMetadataOnly: false, quantityMode: 'FIXED', quantityValue: null, mismatchAck: false };
  const apiV = build({ materials: ALL_MATERIALS, recipes: ALL_RECIPES, checkedRecipeIds: [REC_LATTE.id, REC_CAPPUCCINO.id] });
  const vUnresolved = apiV.ogValidateChoice(cUnresolved);
  check('6 ogValidateChoice blocks publication while a FIXED mismatch is unacknowledged', vUnresolved.ok === false, vUnresolved);
  const cAcked = { ...cUnresolved, mismatchAck: true };
  const vAcked = apiV.ogValidateChoice(cAcked);
  check('6 explicitly acknowledging the mismatch (option B — force fixed) allows publication', vAcked.ok === true, vAcked);
}

// ===========================================================================
// 7 — impact preview lists every affected menu
// ===========================================================================
{
  const api = build({ materials: ALL_MATERIALS, recipes: ALL_RECIPES });
  const choice = { id: 'c3', label: 'เปลี่ยนเป็นนมโอ๊ต', priceAdd: 10, effectType: 'REPLACE', enabled: true, isDefault: false, targetRole: '', targetMaterialId: MAT_MILK.id, variantRecipeId: null, links: [{ matId: MAT_OATMILK.id, amount: 0 }], amount: 0, isMetadataOnly: false, quantityMode: 'MATCH_SOURCE', quantityValue: null };
  const group = { label: 'เปลี่ยนนม', recipeIds: [REC_LATTE.id, REC_CAPPUCCINO.id, REC_HOTCHOC.id] };
  const preview = api.ogImpactPreview(group, choice);
  check('7 the impact preview lists every affected (eligible+linked) menu',
    preview.menus.length === 3 && [REC_LATTE.id, REC_CAPPUCCINO.id, REC_HOTCHOC.id].every(id => preview.menus.some(m => m.recipeId === id)), preview.menus);
  check('7 each menu row carries a resolved quantity (MATCH_SOURCE ⇒ per-recipe amount)',
    preview.menus.find(m => m.recipeId === REC_LATTE.id).resolvedAmount === 200 &&
    preview.menus.find(m => m.recipeId === REC_CAPPUCCINO.id).resolvedAmount === 150);
}

// ===========================================================================
// 8 — invalid/mismatched menus stay visible as review items (never dropped)
// ===========================================================================
{
  const api = build({ materials: ALL_MATERIALS, recipes: ALL_RECIPES });
  const legacyChoice = { id: 'c4', label: 'ของเดิม', priceAdd: 0, effectType: 'REPLACE', enabled: true, isDefault: false, targetRole: '', targetMaterialId: MAT_MILK.id, variantRecipeId: null, links: [{ matId: MAT_OATMILK.id, amount: 200 }], amount: 0, isMetadataOnly: false, quantityMode: 'FIXED' };
  const linkedIncludingBad = [REC_LATTE.id, REC_SMOOTHIE.id]; // smoothie has no milk — legacy bad link
  const cls = api.ogLegacyClassifyChoice(legacyChoice, linkedIncludingBad);
  check('8 a Replace linked to a menu lacking the source classifies as NEEDS_REVIEW (not INVALID, not silently dropped)',
    cls.status === 'NEEDS_REVIEW', cls);
  check('8 the invalid/mismatching menu is LISTED for review, never silently removed',
    cls.invalidRecipes.length === 1 && cls.invalidRecipes[0].recipeId === REC_SMOOTHIE.id, cls);
  check('8 ogLegacyClassifyChoice never mutates the choice (still has both links)',
    legacyChoice.targetMaterialId === MAT_MILK.id);

  const impact = api.ogImpactPreview({ label: 'x', recipeIds: linkedIncludingBad }, legacyChoice);
  check('8 the impact preview surfaces the same invalid menu (visible, not dropped)',
    impact.invalidMenus.some(m => m.recipeId === REC_SMOOTHIE.id), impact.invalidMenus);
}

// ===========================================================================
// 9 — Add eligibility filter: all / containing / manual
// ===========================================================================
{
  const api = build({ materials: ALL_MATERIALS, recipes: ALL_RECIPES });
  const all = api.ogAddEligibleMenus('ALL', MAT_SHOT.id);
  check('9 mode ALL returns every on-menu, resolvable recipe', all.length === ALL_RECIPES.filter(r => r.id !== REC_MOCKTAIL_INVALID.id).length, all.length);

  const containing = api.ogAddEligibleMenus('CONTAINING', MAT_SHOT.id);
  check('9 mode CONTAINING returns only recipes that already contain the ingredient (americano)',
    containing.length === 1 && containing[0].recipeId === REC_AMERICANO.id, containing);

  const manual = api.ogAddEligibleMenus('MANUAL', MAT_SHOT.id);
  check('9 mode MANUAL returns empty — the owner drives selection through the menu selector directly', manual.length === 0);
}

// ===========================================================================
// 10/11 — Change Quantity: absolute + percent-of-base
// ===========================================================================
{
  const api = build({});
  check('10 FIXED (absolute) ignores the base amount entirely',
    api.ogResolveChangeQuantity({ quantityMode: 'FIXED', amount: 5 }, 999) === 5);
  check('10 legacy null quantityMode resolves as FIXED using c.amount (unchanged behaviour)',
    api.ogResolveChangeQuantity({ quantityMode: null, amount: 3 }, 999) === 3);

  check('11 PERCENT_OF_BASE: 10 base at 50% resolves to 5', api.ogResolveChangeQuantity({ quantityMode: 'PERCENT_OF_BASE', quantityValue: 50 }, 10) === 5);
  check('11 PERCENT_OF_BASE: 15 base at 50% resolves to 7.5', api.ogResolveChangeQuantity({ quantityMode: 'PERCENT_OF_BASE', quantityValue: 50 }, 15) === 7.5);
  check('11 PERCENT_OF_BASE at 0% removes the ingredient (resolves to 0)', api.ogResolveChangeQuantity({ quantityMode: 'PERCENT_OF_BASE', quantityValue: 0 }, 10) === 0);
  check('11 PERCENT_OF_BASE at 100% preserves the base amount', api.ogResolveChangeQuantity({ quantityMode: 'PERCENT_OF_BASE', quantityValue: 100 }, 10) === 10);
  check('11 USE_BASE always returns the base amount unchanged', api.ogResolveChangeQuantity({ quantityMode: 'USE_BASE' }, 15) === 15);
  check('11 an invalid/missing percent is unresolvable (returns null, caller must block)', api.ogResolveChangeQuantity({ quantityMode: 'PERCENT_OF_BASE', quantityValue: null }, 10) === null);

  // Per-menu preview: syrup 10→5 and 15→7.5 at 50%, mirroring the exact
  // example in the task spec.
  const menus = [{ recipeId: 'a', recipeName: 'A', sourceAmount: 10 }, { recipeId: 'b', recipeName: 'B', sourceAmount: 15 }];
  const c = { quantityMode: 'PERCENT_OF_BASE', quantityValue: 50 };
  const resolved = menus.map(m => api.ogResolveChangeQuantity(c, m.sourceAmount));
  check('11 per-menu preview resolves 10→5 and 15→7.5 at 50%', resolved[0] === 5 && resolved[1] === 7.5, resolved);
}

// ===========================================================================
// 12 — Recipe Variant gate still safe (unchanged)
// ===========================================================================
{
  const CLEAN_RECIPE = { id: 'r-clean', name: 'สูตรสมบูรณ์', items: [{ matId: MAT_SYRUP.id, amount: 10 }] };
  const api = build({ materials: ALL_MATERIALS, recipes: [...ALL_RECIPES, CLEAN_RECIPE] });
  const ok = api.ogRecipeVariantGate({}, CLEAN_RECIPE, [REC_LATTE.id]);
  check('12 a complete target recipe can still publish through the unchanged gate', ok.ok === true, ok);
  const selfRef = api.ogRecipeVariantGate({}, REC_LATTE, [REC_LATTE.id]);
  check('12 self-reference is still blocked (gate untouched by this branch)', selfRef.ok === false, selfRef);
  const unlinked = api.ogRecipeVariantGate({}, CLEAN_RECIPE, []);
  check('12 an unlinked variant still fails closed (gate untouched)', unlinked.ok === false, unlinked);
}

// ===========================================================================
// 13 — instruction-only has no stock/price/recipe effect
// ===========================================================================
{
  const api = build({ materials: ALL_MATERIALS, recipes: ALL_RECIPES });
  const c = { id: 'c5', label: 'ไม่ใส่วิปครีม', priceAdd: 0, effectType: 'NONE', enabled: true, isDefault: false, targetRole: '', targetMaterialId: null, variantRecipeId: null, links: [], amount: 0, isMetadataOnly: true };
  const preview = api.ogImpactPreview({ label: 'คำสั่งครัว', recipeIds: [REC_LATTE.id] }, c);
  check('13 instruction-only impact preview states no price/stock/recipe effect (Founder wording)',
    preview.effectSummary === 'ตัวเลือกนี้แจ้งครัวเท่านั้น ไม่เปลี่ยนราคา สูตร หรือสต๊อก', preview.effectSummary);
  check('13 instruction-only has zero priceDelta and empty stock-effect summary',
    preview.priceDelta === 0 && preview.stockEffectSummary === '');
  const instructionHtml = api.ogInstructionStep2Html();
  check('13 the instruction-only step-2 markup carries the exact required Founder sentence',
    instructionHtml.includes('ตัวเลือกนี้แจ้งครัวเท่านั้น ไม่เปลี่ยนราคา สูตร หรือสต๊อก'));
  check('13 ogLegacyClassifyChoice always treats instruction-only as SAFE (no recipe/stock dependency)',
    api.ogLegacyClassifyChoice(c, []).status === 'SAFE');
}

// ===========================================================================
// 14 — no technical effect rows or raw IDs reach owner-facing UI
// ===========================================================================
{
  const api = build({ materials: ALL_MATERIALS, recipes: ALL_RECIPES });
  const choice = { id: 'c6', label: 'เปลี่ยนเป็นนมโอ๊ต', priceAdd: 10, effectType: 'REPLACE', enabled: true, isDefault: false, targetRole: '', targetMaterialId: MAT_MILK.id, variantRecipeId: null, links: [{ matId: MAT_OATMILK.id, amount: 200 }], amount: 0, isMetadataOnly: false, quantityMode: 'MATCH_SOURCE' };
  const group = { label: 'เปลี่ยนนม', recipeIds: [REC_LATTE.id, REC_CAPPUCCINO.id] };
  const preview = api.ogImpactPreview(group, choice);
  const rendered = api.ogRenderImpactPreviewHtml(preview);
  check('14 the rendered impact preview never shows raw effect types',
    !/\bREPLACE\b/.test(rendered) && !/\bADD\b/.test(rendered) && !/\bQUANTITY\b/.test(rendered) && !/\bRECIPE_VARIANT\b/.test(rendered), rendered);
  check('14 the rendered impact preview never shows a raw material/recipe UUID',
    !rendered.includes(MAT_MILK.id) && !rendered.includes(MAT_OATMILK.id) && !rendered.includes(REC_LATTE.id), rendered);
  check('14 the rendered impact preview never says MATERIAL_ID/RECIPE_ID/EFFECT literally',
    !/MATERIAL_ID|RECIPE_ID|EFFECT_TYPE/i.test(rendered), rendered);
  // Also confirm the SOURCE of the guided-flow renderers never leaks raw tokens.
  const guidedSrc = [F.ogReplaceStep2Html, F.ogQuantityStep2Html, F.ogAddStep2Html, F.ogImpactPreview, F.ogRenderImpactPreviewHtml].join('\n');
  check('14 no raw effect-type dropdown / mechanics wording in the guided-flow source',
    !/effOpts/.test(guidedSrc) && !/setChoiceEffect/.test(guidedSrc) && !/\btarget_role\b/i.test(guidedSrc));
}

// ===========================================================================
// 15 — search/category/selected-only filters + select-all/clear-all-visible + counts
// ===========================================================================
{
  // Scale test: 120 synthetic menus across 4 categories.
  const bigList = [];
  for (let i = 0; i < 120; i++) {
    bigList.push({ recipeId: 'gen-' + i, recipeName: (i % 5 === 0 ? 'พิเศษ ' : 'เมนู ') + i, category: ['ร้อน', 'เย็น', 'ของหวาน', 'เบเกอรี่'][i % 4] });
  }
  const api = build({});
  const selectedIds = new Set(['gen-1', 'gen-2', 'gen-3']);
  const stAll = api.ogMenuSelectorState(bigList, { selectedIds });
  check('15 with no filter, all 120 are visible and counted', stAll.visible.length === 120 && stAll.eligibleCount === 120);
  check('15 selectedCount reflects the selection regardless of filters', stAll.selectedCount === 3);

  const stSearch = api.ogMenuSelectorState(bigList, { search: 'พิเศษ', selectedIds });
  check('15 search filters by name (case/substring-insensitive)', stSearch.visible.length === 24 && stSearch.visible.every(m => m.recipeName.includes('พิเศษ')), stSearch.visible.length);

  const stCategory = api.ogMenuSelectorState(bigList, { category: 'ของหวาน', selectedIds });
  check('15 category filter narrows to the exact category', stCategory.visible.length === 30 && stCategory.visible.every(m => m.category === 'ของหวาน'));

  const stSelectedOnly = api.ogMenuSelectorState(bigList, { selectedOnly: true, selectedIds });
  check('15 "selected only" narrows to exactly the selected set', stSelectedOnly.visible.length === 3 && stSelectedOnly.visible.every(m => selectedIds.has(m.recipeId)));

  const withInvalid = bigList.slice(0, 10).map((m, i) => ({ ...m, valid: i < 3 ? false : true }));
  const stInvalid = api.ogMenuSelectorState(withInvalid, { selectedIds: new Set() });
  check('15 invalidCount is reported separately from eligibleCount', stInvalid.invalidCount === 3 && stInvalid.eligibleCount === 7);

  // End-to-end select-all-visible / clear-all-visible against the REAL
  // renderGroupRecipePicker + fake checkbox registry (not just the pure
  // ogMenuSelectorState function) — proves the "-visible" scoping actually
  // holds when wired into rendering.
  const apiUI = build({ materials: ALL_MATERIALS, recipes: ALL_RECIPES });
  apiUI.renderGroupRecipePicker([REC_HOTCHOC.id]); // pre-seed one selection
  apiUI.setMenuFilter({ category: 'เครื่องดื่มร้อน' });
  apiUI.renderGroupRecipePicker([REC_HOTCHOC.id]);
  check('15 the filtered picker shows only the matching category as "visible" checkboxes',
    [...apiUI.CHK.values()].filter(c => c.dataset.visible === '1').length ===
      ALL_RECIPES.filter(r => r.category === 'เครื่องดื่มร้อน').length);
  apiUI.ogSelectAllVisibleMenus();
  const checkedAfterSelectAll = [...apiUI.CHK.values()].filter(c => c.checked).map(c => c.dataset.rid);
  check('15 select-all-visible checks every visible (filtered) row',
    ALL_RECIPES.filter(r => r.category === 'เครื่องดื่มร้อน').every(r => checkedAfterSelectAll.includes(r.id)), checkedAfterSelectAll);
  apiUI.ogClearAllVisibleMenus();
  const checkedAfterClear = [...apiUI.CHK.values()].filter(c => c.checked).map(c => c.dataset.rid);
  check('15 clear-all-visible unchecks every visible (filtered) row', checkedAfterClear.length === 0, checkedAfterClear);
}

// ===========================================================================
// 16 — draft survives a save→reload round-trip
// ===========================================================================
{
  const api = build({ materials: ALL_MATERIALS, recipes: ALL_RECIPES, optionGroups: [], checkedRecipeIds: [REC_LATTE.id] });
  api.elValue('ogLabel').value = 'เปลี่ยนนม';
  api.elValue('ogSelectType').value = 'single';
  api.elValue('ogEnabled').checked = true;
  api.setEditGroupChoices([{
    id: 'c7', label: 'เปลี่ยนเป็นนมโอ๊ต', priceAdd: 10, effectType: 'REPLACE', enabled: true, isDefault: false,
    targetRole: '', targetMaterialId: MAT_MILK.id, variantRecipeId: null,
    links: [{ matId: MAT_OATMILK.id, amount: 200 }], amount: 0, isMetadataOnly: false,
    quantityMode: 'MATCH_SOURCE', quantityValue: null, kitchenNote: 'คนให้เข้ากันก่อนเสิร์ฟ', addMenuMode: null,
  }]);
  // mimic the real recipe-picker checkbox state at save time
  api.CHK.set(REC_LATTE.id, { dataset: { rid: REC_LATTE.id, visible: '1' }, checked: true });
  api.saveGroupForm();
  const savedGroup = api.getOptionGroups()[0];
  check('16 the group is saved with its recipe link intact', !!savedGroup && savedGroup.recipeIds.includes(REC_LATTE.id), savedGroup);

  // "reload": open a FRESH sandbox seeded with the saved group (simulates a
  // real bootstrap reload from the saved in-memory model).
  const api2 = build({ materials: ALL_MATERIALS, recipes: ALL_RECIPES, optionGroups: [savedGroup] });
  api2.openGroupForm(savedGroup.id);
  const reloaded = api2.getEditGroupChoices()[0];
  check('16 quantityMode survives the round-trip', reloaded.quantityMode === 'MATCH_SOURCE', reloaded);
  check('16 kitchenNote survives the round-trip', reloaded.kitchenNote === 'คนให้เข้ากันก่อนเสิร์ฟ', reloaded);
  check('16 targetMaterialId/links survive the round-trip', reloaded.targetMaterialId === MAT_MILK.id && reloaded.links[0].matId === MAT_OATMILK.id);
}

// ===========================================================================
// 17 — an invalid option cannot reach POS (enabled=false)
// ===========================================================================
{
  const api = build({ materials: ALL_MATERIALS, recipes: ALL_RECIPES, optionGroups: [], checkedRecipeIds: [REC_LATTE.id] });
  api.elValue('ogLabel').value = 'เปลี่ยนนม';
  api.elValue('ogSelectType').value = 'single';
  api.elValue('ogEnabled').checked = true;
  // Missing quantityMode entirely — must be forced to draft/disabled, never reach POS.
  api.setEditGroupChoices([{
    id: 'c8', label: 'เปลี่ยนเป็นนมโอ๊ต', priceAdd: 10, effectType: 'REPLACE', enabled: true, isDefault: false,
    targetRole: '', targetMaterialId: MAT_MILK.id, variantRecipeId: null,
    links: [{ matId: MAT_OATMILK.id, amount: 200 }], amount: 0, isMetadataOnly: false,
    quantityMode: null, quantityValue: null,
  }]);
  api.CHK.set(REC_LATTE.id, { dataset: { rid: REC_LATTE.id, visible: '1' }, checked: true });
  api.saveGroupForm();
  const saved = api.getOptionGroups()[0].choices[0];
  check('17 the choice is saved as an incomplete draft (never lost)', saved.incomplete === true, saved);
  check('17 it is forced disabled — cannot reach POS/Delivery', saved.enabled === false, saved);
  check('17 the real POS filter (c => c.enabled) excludes it', [saved].filter(c => c.enabled).length === 0);
}

// ===========================================================================
// 18 — a valid option resolves a deterministic BOM/quantity
// ===========================================================================
{
  const api = build({ materials: ALL_MATERIALS, recipes: ALL_RECIPES });
  const c = { quantityMode: 'PERCENT_OF_BASE', quantityValue: 50, amount: 0 };
  const r1 = api.ogResolveChangeQuantity(c, 10);
  const r2 = api.ogResolveChangeQuantity(c, 10);
  check('18 identical inputs always produce the identical resolved quantity (deterministic)', r1 === r2 && r1 === 5);

  const choice = { id: 'c9', label: 'x', priceAdd: 0, effectType: 'REPLACE', targetMaterialId: MAT_MILK.id, links: [{ matId: MAT_OATMILK.id, amount: 200 }], quantityMode: 'MATCH_SOURCE', isMetadataOnly: false, enabled: true };
  const group = { label: 'x', recipeIds: [REC_LATTE.id, REC_CAPPUCCINO.id] };
  const p1 = api.ogImpactPreview(group, choice);
  const p2 = api.ogImpactPreview(group, choice);
  check('18 the impact preview\'s resolved BOM is deterministic across repeated calls',
    JSON.stringify(p1.menus) === JSON.stringify(p2.menus), { p1: p1.menus, p2: p2.menus });
}

// ===========================================================================
// 19 — a valid option resolves the correct price
// ===========================================================================
{
  const api = build({ materials: ALL_MATERIALS, recipes: ALL_RECIPES });
  const choice = { id: 'c10', label: 'เปลี่ยนเป็นนมโอ๊ต', priceAdd: 15, effectType: 'REPLACE', targetMaterialId: MAT_MILK.id, links: [{ matId: MAT_OATMILK.id, amount: 200 }], quantityMode: 'MATCH_SOURCE', isMetadataOnly: false, enabled: true };
  const preview = api.ogImpactPreview({ label: 'x', recipeIds: [REC_LATTE.id] }, choice);
  check('19 priceDelta resolves to the exact configured price add', preview.priceDelta === 15);
  check('19 resolvedPriceExample states the correct signed amount', preview.resolvedPriceExample.includes('+') && preview.resolvedPriceExample.includes('15'), preview.resolvedPriceExample);

  const discount = { ...choice, priceAdd: -5 };
  const previewDiscount = api.ogImpactPreview({ label: 'x', recipeIds: [REC_LATTE.id] }, discount);
  check('19 a negative priceAdd (discount) resolves correctly, not clamped to 0', previewDiscount.priceDelta === -5);

  const free = { id: 'c11', label: 'เพิ่มน้ำแข็ง', priceAdd: 0, effectType: 'ADD', isMetadataOnly: false, enabled: true, links: [{ matId: MAT_SYRUP.id, amount: 5 }] };
  const previewFree = api.ogImpactPreview({ label: 'x', recipeIds: [] }, free);
  check('19 a zero-price option states "no effect on price" rather than a false "+0"', previewFree.resolvedPriceExample === 'ไม่มีผลต่อราคา', previewFree.resolvedPriceExample);
}

// ===========================================================================
// 20 — quantity mode is always read from the stored mode, never inferred from a label
// ===========================================================================
{
  const api = build({});
  // A deliberately MISLEADING label ("ตามสูตรแต่ละเมนู" = "per-recipe") while
  // the STORED mode is explicitly FIXED — resolution must follow the mode.
  const misleading = { label: 'ตามสูตรแต่ละเมนู', quantityMode: 'FIXED', links: [{ matId: MAT_OATMILK.id, amount: 77 }] };
  check('20 resolution follows the STORED mode (FIXED=77), ignoring a label that suggests otherwise',
    api.ogResolveReplaceQuantity(misleading, 200) === 77);

  const misleading2 = { label: 'กำหนดปริมาณเดียวทุกเมนู', quantityMode: 'MATCH_SOURCE', links: [{ matId: MAT_OATMILK.id, amount: 77 }] };
  check('20 resolution follows the STORED mode (MATCH_SOURCE=200), ignoring a label suggesting FIXED',
    api.ogResolveReplaceQuantity(misleading2, 200) === 200);

  const misleadingQty = { label: 'ใช้ปริมาณตามสูตรเดิม', quantityMode: 'FIXED', amount: 42 };
  check('20 change-quantity resolution also follows the stored mode, not the label text',
    api.ogResolveChangeQuantity(misleadingQty, 999) === 42);

  // Source-level guard: ogResolveReplaceQuantity/ogResolveChangeQuantity must
  // never reference `.label` at all.
  check('20 ogResolveReplaceQuantity never reads choice.label', !/\.label/.test(F.ogResolveReplaceQuantity));
  check('20 ogResolveChangeQuantity never reads choice.label', !/\.label/.test(F.ogResolveChangeQuantity));
}

// ===========================================================================
// 21 — REAL persistence contract: schema ⇄ migrate ⇄ sync ⇄ bootstrap
// ===========================================================================
// Group 16 above only proved an IN-MEMORY round-trip. These five fields have
// real columns (schema-option-authoring.sql) and ogValidateChoice READS
// three of them, so if any layer drops one, a reloaded-but-previously-valid
// choice fails validation and saveGroupForm forces enabled=false — silently
// pulling a working option off POS. This group drives the REAL bootstrap
// mapper and the REAL sync payload builder (extracted from index.html)
// through sync.js's REAL column whitelist.
const AUTHORING_COLS = ['quantity_mode', 'quantity_value', 'kitchen_note', 'add_menu_mode', 'mismatch_ack'];

// The real sync.js option_choices INSERT column list + on-conflict update set.
const SYNC_INSERT_COLS = (() => {
  const m = /insert into option_choices \(([^)]+)\)/.exec(SYNC_SRC);
  if (!m) throw new Error('cannot find the option_choices INSERT in sync.js');
  return m[1].split(',').map(s => s.trim());
})();
const SYNC_UPDATE_CLAUSE = (() => {
  const i = SYNC_SRC.indexOf('on conflict (id) do update set');
  if (i === -1) throw new Error('cannot find the option_choices on-conflict clause in sync.js');
  return SYNC_SRC.slice(i, SYNC_SRC.indexOf('`', i));
})();

// The REAL bootstrap mapper and sync payload builder, pulled from the two
// large enclosing functions rather than re-implemented here.
const BOOT_CHOICE_MAPPER_SRC = extractArrowAfter(
  INDEX_SRC, 'choices: ocData.filter(c => c.group_id === g.id).map(', 'frontend/index.html applyBootstrapData');
const SYNC_CHOICE_PAYLOAD_SRC = extractArrowAfter(
  INDEX_SRC, 'option_choices: optionGroups.flatMap(g => (g.choices || []).map(', 'frontend/index.html syncToSupabase');

// Bind each to the minimal scope it closes over.
const bootMapChoice = new Function('oclData', 'return ' + BOOT_CHOICE_MAPPER_SRC)([]);
const syncMapChoice = new Function('g', 'return ' + SYNC_CHOICE_PAYLOAD_SRC)({ id: 'g-1' });

// Simulates the DB: only columns sync.js actually writes survive a save, and
// each takes the schema's own default when the client omits it. A column
// missing from sync.js's whitelist therefore VANISHES here, exactly as it
// would in production.
const COLUMN_DEFAULTS = { quantity_mode: null, quantity_value: null, kitchen_note: null, add_menu_mode: null, mismatch_ack: false };
function simulatePersist(payloadRow) {
  const stored = {};
  for (const col of SYNC_INSERT_COLS) {
    stored[col] = payloadRow[col] !== undefined ? payloadRow[col] : (COLUMN_DEFAULTS[col] !== undefined ? COLUMN_DEFAULTS[col] : null);
  }
  return stored;
}
function roundTrip(choice) {
  return bootMapChoice(simulatePersist(syncMapChoice(choice, 0)));
}

{
  // -- schema + migrate registration ------------------------------------
  for (const col of ['kitchen_note', 'add_menu_mode', 'mismatch_ack', 'quantity_mode', 'quantity_value']) {
    check(`21 schema-option-authoring.sql adds ${col} additively (add column if not exists)`,
      new RegExp('alter table option_choices add column if not exists ' + col + '\\b', 'i').test(SCHEMA_AUTHORING_SRC));
  }
  check('21 the schema file alters nothing and drops nothing (additive only)',
    !/drop\s+(column|table)/i.test(SCHEMA_AUTHORING_SRC) && !/alter\s+column/i.test(SCHEMA_AUTHORING_SRC));
  // An UNREGISTERED schema file never runs in production — the single most
  // important check in this group.
  check('21 the renamed schema file IS registered in migrate.js',
    MIGRATE_SRC.includes("'../db/schema-option-authoring.sql'"));
  check('21 migrate.js no longer references the old filename',
    !MIGRATE_SRC.includes('schema-option-quantity-mode'));
  check('21 the schema file still runs BEFORE seed.sql (position preserved)',
    MIGRATE_SRC.indexOf("'../db/schema-option-authoring.sql'") < MIGRATE_SRC.indexOf("'../db/seed.sql'"));
  check('21 the renamed schema file exists on disk', fs.existsSync(path.join(__dirname, '../db/schema-option-authoring.sql')));
  check('21 the old schema filename is gone from disk', !fs.existsSync(path.join(__dirname, '../db/schema-option-quantity-mode.sql')));

  // -- sync.js whitelist (source contract) --------------------------------
  for (const col of AUTHORING_COLS) {
    check(`21 sync.js option_choices INSERT persists ${col}`, SYNC_INSERT_COLS.includes(col), SYNC_INSERT_COLS);
    check(`21 sync.js on-conflict UPDATE also persists ${col} (the common re-save path)`,
      new RegExp(col + '=\\$\\d+').test(SYNC_UPDATE_CLAUSE), SYNC_UPDATE_CLAUSE);
  }

  // -- the real end-to-end round-trip -------------------------------------
  const authored = {
    id: 'c-rt', label: 'เปลี่ยนเป็นนมโอ๊ต', priceAdd: 10, effectType: 'REPLACE', enabled: true, isDefault: false,
    maxQty: 1, targetRole: '', targetMaterialId: MAT_MILK.id, variantRecipeId: null,
    links: [{ id: 'l1', matId: MAT_OATMILK.id, amount: 200 }], amount: 0, isMetadataOnly: false,
    quantityMode: 'FIXED', quantityValue: null,
    kitchenNote: 'คนให้เข้ากันก่อนเสิร์ฟ', addMenuMode: 'CONTAINING', mismatchAck: true,
  };
  const reloaded = roundTrip(authored);
  check('21 kitchenNote survives save → persist → bootstrap (real column contract)',
    reloaded.kitchenNote === 'คนให้เข้ากันก่อนเสิร์ฟ', reloaded.kitchenNote);
  check('21 addMenuMode survives save → persist → bootstrap (real column contract)',
    reloaded.addMenuMode === 'CONTAINING', reloaded.addMenuMode);
  check('21 mismatchAck survives save → persist → bootstrap (real column contract)',
    reloaded.mismatchAck === true, reloaded.mismatchAck);
  check('21 quantityMode survives save → persist → bootstrap (real column contract)',
    reloaded.quantityMode === 'FIXED', reloaded.quantityMode);
  const pct = roundTrip({ ...authored, quantityMode: 'PERCENT_OF_BASE', quantityValue: 50 });
  check('21 quantityValue survives the round-trip as a number, not a string',
    pct.quantityValue === 50 && typeof pct.quantityValue === 'number', pct.quantityValue);

  // mismatchAck=false must round-trip as false (not lost, not flipped true)
  const notAcked = roundTrip({ ...authored, mismatchAck: false });
  check('21 mismatchAck=false round-trips as false (never silently true)', notAcked.mismatchAck === false);
  // An empty kitchen note must round-trip as '' (column null ⇒ '')
  const noNote = roundTrip({ ...authored, kitchenNote: '' });
  check('21 an empty kitchenNote round-trips as an empty string, not null/undefined', noNote.kitchenNote === '');

  // legacyAuthoringExempt is DERIVED, never persisted.
  check('21 legacyAuthoringExempt is never written to the sync payload (derived, not stored)',
    syncMapChoice({ ...authored, legacyAuthoringExempt: true }, 0).legacy_authoring_exempt === undefined);
}

// ===========================================================================
// 22 — BACKWARD COMPATIBILITY: a load+save cycle can never disable a
//      working option (the silent-data-loss class this track exists to stop)
// ===========================================================================
{
  // A REAL legacy DB row: authored long before the guided flow, enabled and
  // working on POS today, carrying none of the new metadata.
  const legacyAddRow = {
    id: 'c-legacy-add', group_id: 'g-1', label: 'เพิ่มช็อต', price_add: 15, effect_type: 'ADD',
    enabled: true, is_default: false, sort: 0, max_qty: 1, target_role: '',
    target_material_id: null, variant_recipe_id: null, is_metadata_only: false, amount: 0,
    quantity_mode: null, quantity_value: null, kitchen_note: null, add_menu_mode: null, mismatch_ack: false,
  };
  const bootWithLinks = new Function('oclData', 'return ' + BOOT_CHOICE_MAPPER_SRC)(
    [{ id: 'l-legacy', choice_id: 'c-legacy-add', material_id: MAT_SHOT.id, amount: 1 }]);
  const loadedAdd = bootWithLinks(legacyAddRow);
  check('22 a legacy enabled ADD row loads as exempt from the NEW explicit-metadata rules',
    loadedAdd.legacyAuthoringExempt === true, loadedAdd);
  check('22 the legacy ADD row keeps add_menu_mode null (nothing invented on load)', loadedAdd.addMenuMode === null);

  const api = build({ materials: ALL_MATERIALS, recipes: ALL_RECIPES, optionGroups: [], checkedRecipeIds: [REC_AMERICANO.id] });
  api.elValue('ogLabel').value = 'เพิ่มช็อต';
  api.elValue('ogSelectType').value = 'single';
  api.elValue('ogEnabled').checked = true;
  api.setEditGroupChoices([loadedAdd]);
  const validated = api.ogValidateChoice(loadedAdd);
  check('22 a legacy enabled ADD choice VALIDATES (the new addMenuMode rule is not retroactive)',
    validated.ok === true, validated);
  api.saveGroupForm();
  const resaved = api.getOptionGroups()[0].choices[0];
  check('22 ⚠ CORE: a legacy enabled ADD option is STILL ENABLED after load + re-save',
    resaved.enabled === true, resaved);
  check('22 it is not flagged as an incomplete draft either', resaved.incomplete === false, resaved);

  // Same guarantee for a legacy REPLACE row (quantity_mode null). This is the
  // BROADER instance of the same bug: ogValidateChoice's `!c.quantityMode`
  // check would also have silently disabled every legacy REPLACE option.
  const legacyReplaceRow = {
    ...legacyAddRow, id: 'c-legacy-rep', label: 'เปลี่ยนเป็นนมโอ๊ต', effect_type: 'REPLACE',
    target_material_id: MAT_MILK.id, price_add: 10,
  };
  const bootRep = new Function('oclData', 'return ' + BOOT_CHOICE_MAPPER_SRC)(
    [{ id: 'l-rep', choice_id: 'c-legacy-rep', material_id: MAT_OATMILK.id, amount: 200 }]);
  const loadedRep = bootRep(legacyReplaceRow);
  // Linked to latte(200) AND cappuccino(150) ⇒ a real FIXED mismatch exists.
  const apiRep = build({ materials: ALL_MATERIALS, recipes: ALL_RECIPES, optionGroups: [], checkedRecipeIds: [REC_LATTE.id, REC_CAPPUCCINO.id] });
  apiRep.elValue('ogLabel').value = 'เปลี่ยนนม';
  apiRep.elValue('ogSelectType').value = 'single';
  apiRep.elValue('ogEnabled').checked = true;
  apiRep.setEditGroupChoices([loadedRep]);
  check('22 a legacy enabled REPLACE choice (quantity_mode null) VALIDATES',
    apiRep.ogValidateChoice(loadedRep).ok === true, apiRep.ogValidateChoice(loadedRep));
  apiRep.saveGroupForm();
  const resavedRep = apiRep.getOptionGroups()[0].choices[0];
  check('22 ⚠ CORE: a legacy enabled REPLACE option is STILL ENABLED after load + re-save (mismatch not retroactive)',
    resavedRep.enabled === true, resavedRep);
  check('22 the legacy REPLACE is still surfaced for review (visible, not silently blessed)',
    apiRep.ogLegacyClassifyChoice(loadedRep, [REC_LATTE.id, REC_CAPPUCCINO.id]).status !== 'INVALID');

  // The exemption must NOT leak to genuinely NEW items authored in the flow.
  const apiNew = build({ materials: ALL_MATERIALS, recipes: ALL_RECIPES, checkedRecipeIds: [REC_AMERICANO.id] });
  apiNew.setEditGroupChoices([]);
  apiNew.addChoiceRow();
  apiNew.ogSetBlockType(0, 'ADD_ONE_INGREDIENT');
  const fresh = apiNew.getEditGroupChoices()[0];
  fresh.label = 'เพิ่มช็อต'; fresh.links = [{ matId: MAT_SHOT.id, amount: 1 }];
  check('22 a BRAND-NEW ADD item is NOT exempt — it must still choose a menu filter explicitly',
    apiNew.ogValidateChoice(fresh).ok === false, apiNew.ogValidateChoice(fresh));

  // Re-authoring a legacy item (switching its block) drops the exemption.
  const apiSwitch = build({ materials: ALL_MATERIALS, recipes: ALL_RECIPES, checkedRecipeIds: [REC_AMERICANO.id] });
  apiSwitch.setEditGroupChoices([{ ...loadedAdd }]);
  apiSwitch.ogSetBlockType(0, 'REPLACE_ONE_INGREDIENT');
  check('22 actively re-authoring a legacy item clears its exemption (explicit choices now required)',
    apiSwitch.getEditGroupChoices()[0].legacyAuthoringExempt === false);

  // The exemption must never override a genuine DATA-INTEGRITY failure (§11):
  // a legacy REPLACE linked to a menu that lacks the source still blocks.
  const apiBad = build({ materials: ALL_MATERIALS, recipes: ALL_RECIPES, checkedRecipeIds: [REC_LATTE.id, REC_SMOOTHIE.id] });
  const vBad = apiBad.ogValidateChoice(loadedRep);
  check('22 the exemption does NOT excuse a linked menu lacking the source (§11 still blocks publication)',
    vBad.ok === false, vBad);
  check('22 that block still names the offending menu in clear Thai',
    vBad.items.some(it => !it.ok && /สมูทตี้ผลไม้/.test(it.label)), vBad.items);
}

// ===========================================================================
// 23 — FOUNDER NUMERIC-INPUT UX FIX: the quantity/price fields behaved like a
//      spinner because (a) `+this.value` coerced on every keystroke and
//      (b) `oninput` triggered a full renderGroupChoices() that rebuilt the
//      focused input, destroying focus/caret. Proves the shared
//      ogNumFocus/ogNumInput/ogNumBlur handler fixes both, and that MATCH_
//      SOURCE no longer shows/quotes a misleading replacement quantity.
// ===========================================================================
{
  const api = build({ materials: ALL_MATERIALS, recipes: ALL_RECIPES });
  api.setEditGroupChoices([{
    id: 'c-num', label: 'เปลี่ยนเป็นนมโอ๊ต', priceAdd: 10, effectType: 'REPLACE', enabled: true, isDefault: false,
    targetRole: '', targetMaterialId: MAT_MILK.id, variantRecipeId: null,
    links: [{ matId: MAT_OATMILK.id, amount: 50 }], amount: 0, isMetadataOnly: false,
    quantityMode: 'FIXED', quantityValue: null,
  }]);

  // A fake <input>: value/dataset/select(), enough to drive focus→input→blur
  // exactly the way the browser would, without a real DOM.
  function fakeInput(initialValue) {
    return { value: String(initialValue), dataset: {}, selectCalled: 0, select() { this.selectCalled++; } };
  }
  function type(el, ci, target, text) { el.value = text; api.ogNumInput(el, ci, target); }

  // 23.1 — replace 50 with 150 by typing: focus selects all, typed value wins.
  {
    const el = fakeInput(50);
    api.ogNumFocus(el);
    check('23.1 focus selects the whole value (el.select() called)', el.selectCalled === 1);
    type(el, 0, 'amount', '150');
    check('23.1 typing 150 after focus-select commits 150 live (via oninput)',
      api.getEditGroupChoices()[0].links[0].amount === 150, api.getEditGroupChoices()[0].links[0]);
    api.ogNumBlur(el, 0, 'amount');
    check('23.1 blur keeps 150 committed', api.getEditGroupChoices()[0].links[0].amount === 150);
  }

  // 23.2 — clear and enter 250: the cleared intermediate state never becomes 0.
  {
    const el = fakeInput(150);
    type(el, 0, 'amount', '');
    check('23.2 clearing the field does NOT snap the model to 0 mid-typing',
      api.getEditGroupChoices()[0].links[0].amount === 150, api.getEditGroupChoices()[0].links[0]);
    type(el, 0, 'amount', '250');
    check('23.2 typing 250 next commits 250', api.getEditGroupChoices()[0].links[0].amount === 250);
  }

  // 23.3 — 7.5 decimal survives (not truncated to 7).
  {
    const el = fakeInput(250);
    type(el, 0, 'amount', '7.5');
    check('23.3 typing 7.5 commits the exact decimal',
      api.getEditGroupChoices()[0].links[0].amount === 7.5, api.getEditGroupChoices()[0].links[0]);
  }

  // 23.4 — 1250 (4-digit value, no clamping/mangling).
  {
    const el = fakeInput(7.5);
    type(el, 0, 'amount', '1250');
    check('23.4 typing a 4-digit value (1250) is not clamped or mangled',
      api.getEditGroupChoices()[0].links[0].amount === 1250);
  }

  // 23.5 — backspace to empty then retype: intermediate empty never becomes
  // 0, and the final retyped value still commits.
  {
    const el = fakeInput(1250);
    type(el, 0, 'amount', '125');
    type(el, 0, 'amount', '12');
    type(el, 0, 'amount', '1');
    type(el, 0, 'amount', '');
    check('23.5 the intermediate empty string never becomes 0 in the model',
      api.getEditGroupChoices()[0].links[0].amount === 1, api.getEditGroupChoices()[0].links[0]);
    type(el, 0, 'amount', '99');
    check('23.5 retyping after the empty intermediate commits the final value (99)',
      api.getEditGroupChoices()[0].links[0].amount === 99);
  }

  // 23.6 — '1.' mid-typing does not collapse to 1.
  {
    const el = fakeInput(99);
    type(el, 0, 'amount', '1.');
    check("23.6 a trailing-dot partial decimal ('1.') does not collapse the model to 1",
      api.getEditGroupChoices()[0].links[0].amount === 99, api.getEditGroupChoices()[0].links[0]);
    type(el, 0, 'amount', '1.2');
    check('23.6 completing the decimal commits 1.2', api.getEditGroupChoices()[0].links[0].amount === 1.2);
  }

  // 23.7 — oninput never re-renders the focused field (source-contract).
  check('23.7 ogNumInput never calls renderGroupChoices (that rebuild destroyed focus/caret)',
    !/renderGroupChoices\s*\(/.test(F.ogNumInput), F.ogNumInput);
  check('23.7 ogNumInput never calls renderOptionsPage either', !/renderOptionsPage\s*\(/.test(F.ogNumInput));
  check('23.7 ogNumInput only refreshes the summary text node (ogRefreshChoicePreview), never the input itself',
    /ogRefreshChoicePreview/.test(F.ogNumInput));

  // 23.8 — focus selects the entire value.
  {
    const el = fakeInput(42);
    api.ogNumFocus(el);
    check('23.8 ogNumFocus calls el.select()', el.selectCalled === 1);
  }

  // 23.9 — blur commits + clamps (negative → 0).
  {
    const el = fakeInput(-5);
    el.dataset.raw = '-5';
    api.ogNumBlur(el, 0, 'amount');
    check('23.9 blur clamps a negative value to 0 (min-0 rule)',
      api.getEditGroupChoices()[0].links[0].amount === 0, api.getEditGroupChoices()[0].links[0]);
    check('23.9 blur also normalises the displayed field value to the clamped number', el.value === 0);
  }

  // 23 (contract) — every persisted target is reachable through the ONE
  // shared setter, so behaviour can never drift between fields.
  check('23 links[0].amount (ADD/REPLACE quantity) is reachable through ogNumTargetSet',
    (() => { api.setEditGroupChoices([{ id: 'x', links: [] }]); api.ogNumTargetSet(0, 'amount', 33); return api.getEditGroupChoices()[0].links[0].amount === 33; })());
  check('23 c.amount (CHANGE_QUANTITY fixed amount) is reachable through ogNumTargetSet',
    (() => { api.setEditGroupChoices([{ id: 'x' }]); api.ogNumTargetSet(0, 'changeAmount', 44); return api.getEditGroupChoices()[0].amount === 44; })());
  check('23 c.quantityValue (percent-of-base) is reachable through ogNumTargetSet',
    (() => { api.setEditGroupChoices([{ id: 'x' }]); api.ogNumTargetSet(0, 'percent', 55); return api.getEditGroupChoices()[0].quantityValue === 55; })());
  check('23 c.priceAdd (price adjustment) is reachable through ogNumTargetSet',
    (() => { api.setEditGroupChoices([{ id: 'x' }]); api.ogNumTargetSet(0, 'price', 66); return api.getEditGroupChoices()[0].priceAdd === 66; })());

  // percent field: empty commits to null (not 0) on blur — preserves the
  // pre-existing ogSetQuantityValue('') ⇒ null semantics (optional field).
  {
    api.setEditGroupChoices([{ id: 'x', quantityMode: 'PERCENT_OF_BASE', quantityValue: 50 }]);
    const el = fakeInput(50);
    el.dataset.raw = '';
    api.ogNumBlur(el, 0, 'percent');
    check('23 an emptied percent field commits to null on blur, not 0',
      api.getEditGroupChoices()[0].quantityValue === null, api.getEditGroupChoices()[0]);
  }

  // every Option Builder numeric field's SOURCE actually routes through the
  // shared helper — guards against a future field quietly reintroducing
  // `+this.value` or a per-keystroke render.
  const numericFieldSrcs = [F.ogAddStep2Html, F.ogReplaceStep2Html, F.ogQuantityStep2Html, F.ogPriceFieldHtml].join('\n');
  const numberInputTags = numericFieldSrcs.match(/<input type="number"[^>]*>/g) || [];
  check('23 every Option Builder <input type="number"> uses onfocus="ogNumFocus(this)"',
    numberInputTags.length > 0 && numberInputTags.every(t => /onfocus="ogNumFocus\(this\)"/.test(t)), numberInputTags);
  check('23 every Option Builder <input type="number"> uses oninput="ogNumInput(...)"',
    numberInputTags.every(t => /oninput="ogNumInput\(/.test(t)), numberInputTags);
  check('23 every Option Builder <input type="number"> uses onblur="ogNumBlur(...)"',
    numberInputTags.every(t => /onblur="ogNumBlur\(/.test(t)), numberInputTags);
  check('23 no Option Builder numeric field still uses the old per-keystroke `+this.value` coercion',
    !/\+this\.value/.test(numericFieldSrcs), numericFieldSrcs);

  // MATCH_SOURCE hides the misleading editable replacement-quantity input.
  const sourceIngsForHide = api.ogSourceIngredients();
  const matchSourceChoice = {
    id: 'c-ms', label: 'x', priceAdd: 0, effectType: 'REPLACE', enabled: true, isDefault: false,
    targetRole: '', targetMaterialId: MAT_MILK.id, variantRecipeId: null,
    links: [{ matId: MAT_OATMILK.id, amount: 49 }], amount: 0, isMetadataOnly: false,
    quantityMode: 'MATCH_SOURCE', quantityValue: null,
  };
  const matchSourceHtml = api.ogReplaceStep2Html(matchSourceChoice, 0, sourceIngsForHide);
  check('23 MATCH_SOURCE renders NO editable replacement-quantity <input>',
    !/<input type="number"/.test(matchSourceHtml), matchSourceHtml);
  check('23 MATCH_SOURCE still shows the "with" material select (only the quantity input is suppressed)',
    (matchSourceHtml.match(/<select/g) || []).length === 2, matchSourceHtml);

  const fixedChoiceForCompare = { ...matchSourceChoice, quantityMode: 'FIXED' };
  const fixedHtml = api.ogReplaceStep2Html(fixedChoiceForCompare, 0, sourceIngsForHide);
  check('23 FIXED mode (not MATCH_SOURCE) still renders the editable quantity input',
    /<input type="number"/.test(fixedHtml), fixedHtml);

  // MATCH_SOURCE summary never quotes the stored-but-ignored link amount (49).
  const summaryMatchSource = api.ogChoiceSummary(matchSourceChoice);
  check('23 MATCH_SOURCE summary does NOT quote the ignored stored amount (49)',
    !/\b49\b/.test(summaryMatchSource), summaryMatchSource);
  check('23 MATCH_SOURCE summary states the quantity follows each recipe',
    /ตามสูตรแต่ละเมนู/.test(summaryMatchSource), summaryMatchSource);

  // FIXED mode summary still quotes the real, meaningful fixed amount.
  const summaryFixed = api.ogChoiceSummary(fixedChoiceForCompare);
  check('23 FIXED-mode summary still quotes the actual configured amount (49)',
    /\b49\b/.test(summaryFixed), summaryFixed);

  // "เปลี่ยนEspresso" missing-space fix + "฿5.00 บาท" doubled-currency fix.
  check('23 the REPLACE summary has a space between "เปลี่ยน" and the material name',
    /เปลี่ยน \S/.test(summaryFixed), summaryFixed);
  // (the sandbox's `money` stub renders plain digits — real money() prepends
  // ฿ — either way the bug was the redundant trailing "บาท" doubling the
  // currency indicator, which is what this asserts against.)
  const summaryWithPrice = api.ogChoiceSummary({ ...fixedChoiceForCompare, priceAdd: 5 });
  check('23 the price clause states the amount', /เพิ่มราคา 5/.test(summaryWithPrice), summaryWithPrice);
  check('23 the price clause never doubles the currency indicator (no "บาท" suffix after the price)',
    !/เพิ่มราคา[^·]*บาท/.test(summaryWithPrice), summaryWithPrice);
}

console.log(`\noption-builder-ux: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
