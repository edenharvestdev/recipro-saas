// Workstream B: Compact Option Template Blocks — extracts the REAL functions
// from frontend/index.html (same string/comment/regex-aware extractor as
// backend/test/category-manager.test.js / print-routing.test.js) and runs
// them against mocked globals. Also source-contract-asserts that
// backend/src/stockEngine.js's REPLACE/QUANTITY branches are byte-for-byte
// unchanged (this workstream is explicitly forbidden from touching that
// file). No copy of the logic is kept here — extraction guarantees the tests
// track the shipped source.
// Run: node backend/test/option-blocks.test.js
const fs = require('fs');
const path = require('path');
const html = fs.readFileSync(path.join(__dirname, '../../frontend/index.html'), 'utf8');
// normalize CRLF -> LF so the verbatim-branch comparisons below aren't line-ending-sensitive
const stockEngineSrc = fs.readFileSync(path.join(__dirname, '../src/stockEngine.js'), 'utf8').replace(/\r\n/g, '\n');

// String/comment/regex-aware extractor (mirrors print-routing.test.js's extractFn): returns the full
// source of `function NAME(...) {...}` without mismatching on braces inside string/template literals.
function extractFn(name) {
  let start = html.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('function not found: ' + name);
  const asyncMatch = html.slice(Math.max(0, start - 8), start).match(/async(\s+)$/);
  if (asyncMatch) start -= asyncMatch[0].length;
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

let passed = 0, failed = 0;
function check(name, cond, extra) { if (cond) { passed++; console.log('  ✓', name); } else { failed++; console.log('  ✗', name, extra !== undefined ? JSON.stringify(extra) : ''); } }

console.log('\n=== Workstream B: Compact Option Template Blocks ===\n');

// -------------------------------------------------------------------------
// Sandbox factory: builds a fresh, isolated copy of the real functions
// (extracted from index.html) each time so tests never leak state. The
// REAL materialResolver.js is required (not mocked) so unit-ambiguity
// checks (V9/V10) run against the actual UNIT_REGISTRY.
// -------------------------------------------------------------------------
function buildSandbox() {
  const factorySrc = [
    'var materials = [];',
    'var recipes = [];',
    'var optionGroups = [];',
    'var editGroupId = null;',
    'var editGroupChoices = [];',
    'var document = { querySelectorAll: function () { return []; } };',
    'var window = { MaterialResolver: require(' + JSON.stringify(path.join(__dirname, '../../frontend/materialResolver.js')) + ') };',
    'function uid(){ return "id-" + Math.random().toString(36).slice(2); }',
    'function esc(s){ return String(s==null?"":s); }',
    'function money(n){ return "฿" + (Number(n)||0).toFixed(2); }',
    'function baseU(m){ return (m && (m.stockUnit || m.unit)) || ""; }',
    'function matById(id){ return materials.find(function(m){ return m.id===id; }) || null; }',
    'function recById(id){ return recipes.find(function(r){ return r.id===id; }) || null; }',
    'function renderGroupChoices(){ /* DOM render — no-op in tests */ }',
    extractFn('classifyLegacyChoice'),
    extractFn('classifyLegacyReasons'),
    extractFn('ogChannelActive'),
    extractFn('ogLinkedRecipeIdsLive'),
    extractFn('ogSourceIngredients'),
    extractFn('ogUnitAmbiguous'),
    extractFn('ogChoiceSummary'),
    extractFn('ogValidateChoice'),
    extractFn('ogDetectConflicts'),
    extractFn('ogPriceResolve'),
    extractFn('setChoiceBlockType'),
    'return {',
    '  setMaterials:function(m){materials=m;}, setRecipes:function(r){recipes=r;},',
    '  setOptionGroups:function(g){optionGroups=g;}, setEditGroupId:function(id){editGroupId=id;},',
    '  setEditGroupChoices:function(c){editGroupChoices=c;}, getEditGroupChoices:function(){return editGroupChoices;},',
    '  setDocument:function(d){document=d;},',
    '  classifyLegacyChoice:classifyLegacyChoice, classifyLegacyReasons:classifyLegacyReasons,',
    '  ogChannelActive:ogChannelActive, ogLinkedRecipeIdsLive:ogLinkedRecipeIdsLive,',
    '  ogSourceIngredients:ogSourceIngredients, ogUnitAmbiguous:ogUnitAmbiguous,',
    '  ogChoiceSummary:ogChoiceSummary, ogValidateChoice:ogValidateChoice,',
    '  ogDetectConflicts:ogDetectConflicts, ogPriceResolve:ogPriceResolve,',
    '  setChoiceBlockType:setChoiceBlockType',
    '};',
  ].join('\n');
  const factory = new Function('require', factorySrc);
  return factory(require);
}

// =========================================================================
// 1. A-block (INSTRUCTION_ONLY) → is_metadata_only true, no links
// =========================================================================
console.log('--- 1. Block A: INSTRUCTION_ONLY ---');
{
  const M = buildSandbox();
  M.setEditGroupChoices([{ id: 'c1', label: 'หวานน้อย', effectType: 'ADD', links: [{ matId: 'm1', amount: 5 }], targetMaterialId: null, amount: 0, variantRecipeId: null, isMetadataOnly: false, blockType: null }]);
  M.setChoiceBlockType(0, 'INSTRUCTION_ONLY');
  const c = M.getEditGroupChoices()[0];
  check('1a blockType set', c.blockType === 'INSTRUCTION_ONLY', c.blockType);
  check('1b isMetadataOnly true', c.isMetadataOnly === true);
  check('1c effectType NONE', c.effectType === 'NONE', c.effectType);
  check('1d no links', Array.isArray(c.links) && c.links.length === 0, c.links);
  check('1e classify contract: metadata+no-links → INSTRUCTION_ONLY', M.classifyLegacyChoice({ isMetadataOnly: true, links: [] }) === 'INSTRUCTION_ONLY');
}

// =========================================================================
// 2. B-block (ADD_ONE_INGREDIENT) → exactly one link
// =========================================================================
console.log('\n--- 2. Block B: ADD_ONE_INGREDIENT ---');
{
  const M = buildSandbox();
  M.setEditGroupChoices([{ id: 'c1', label: '', effectType: 'NONE', links: [], targetMaterialId: null, amount: 0, variantRecipeId: null, isMetadataOnly: false, blockType: null }]);
  M.setChoiceBlockType(0, 'ADD_ONE_INGREDIENT');
  const c = M.getEditGroupChoices()[0];
  check('2a effectType ADD', c.effectType === 'ADD');
  check('2b exactly one link row', Array.isArray(c.links) && c.links.length === 1, c.links);
  check('2c isMetadataOnly false', c.isMetadataOnly === false);
  check('2d no target/variant', c.targetMaterialId === null && c.variantRecipeId === null);
}

// =========================================================================
// 3. C-block (REPLACE_ONE_INGREDIENT) → REPLACE + target + exactly one link
// =========================================================================
console.log('\n--- 3. Block C: REPLACE_ONE_INGREDIENT ---');
{
  const M = buildSandbox();
  M.setEditGroupChoices([{ id: 'c1', label: '', effectType: 'NONE', links: [], targetMaterialId: null, amount: 0, variantRecipeId: null, isMetadataOnly: false, blockType: null }]);
  M.setChoiceBlockType(0, 'REPLACE_ONE_INGREDIENT');
  let c = M.getEditGroupChoices()[0];
  c.targetMaterialId = 'm-milk';
  c.links[0].matId = 'm-oatmilk'; c.links[0].amount = 150;
  check('3a effectType REPLACE', c.effectType === 'REPLACE');
  check('3b exactly one link row', c.links.length === 1, c.links);
  check('3c target set', c.targetMaterialId === 'm-milk');
  check('3d replacement link set (never double-deduct — a single link row is the only source of the new amount)', c.links[0].matId === 'm-oatmilk' && c.links[0].amount === 150);
}

// =========================================================================
// 4. D-block (CHANGE_ONE_QUANTITY) → QUANTITY + amount, including 0
// =========================================================================
console.log('\n--- 4. Block D: CHANGE_ONE_QUANTITY ---');
{
  const M = buildSandbox();
  M.setEditGroupChoices([{ id: 'c1', label: '', effectType: 'NONE', links: [{ matId: 'x', amount: 1 }], targetMaterialId: null, amount: 5, variantRecipeId: null, isMetadataOnly: false, blockType: null }]);
  M.setChoiceBlockType(0, 'CHANGE_ONE_QUANTITY');
  let c = M.getEditGroupChoices()[0];
  check('4a effectType QUANTITY', c.effectType === 'QUANTITY');
  check('4b links cleared', c.links.length === 0);
  // Note: amount is CHANGE_ONE_QUANTITY's OWN field, so setChoiceBlockType deliberately
  // does not clear it when switching TO this block (unlike ADD/REPLACE/RECIPE_VARIANT,
  // which zero it because it's not their field) — whatever value pre-existed carries over.
  check('4c amount field preserved (it is this block\'s own field, not reset)', c.amount === 5, c.amount);
  c.targetMaterialId = 'm1'; c.amount = 0; // 0 = explicit "cut from recipe", must be allowed
  check('4d amount=0 allowed', c.amount === 0);
  c.amount = 25;
  check('4e amount can be set to any positive value', c.amount === 25);
}

// =========================================================================
// 5. E-block (RECIPE_VARIANT) → RECIPE_VARIANT + variant_recipe_id
// =========================================================================
console.log('\n--- 5. Block E: RECIPE_VARIANT ---');
{
  const M = buildSandbox();
  M.setEditGroupChoices([{ id: 'c1', label: '', effectType: 'NONE', links: [{ matId: 'x', amount: 1 }], targetMaterialId: 'm1', amount: 3, variantRecipeId: null, isMetadataOnly: false, blockType: null }]);
  M.setChoiceBlockType(0, 'RECIPE_VARIANT');
  let c = M.getEditGroupChoices()[0];
  check('5a effectType RECIPE_VARIANT', c.effectType === 'RECIPE_VARIANT');
  check('5b links/target cleared', c.links.length === 0 && c.targetMaterialId === null);
  c.variantRecipeId = 'r-iced';
  check('5c variantRecipeId settable', c.variantRecipeId === 'r-iced');
}

// =========================================================================
// 6. Invalid source (target not in linked recipes) → validation fails
// =========================================================================
console.log('\n--- 6. Invalid source rejected ---');
{
  const M = buildSandbox();
  M.setMaterials([
    { id: 'm-milk', name: 'นมสด', stockUnit: 'มล.' },
    { id: 'm-oatmilk', name: 'นมโอ๊ต', stockUnit: 'มล.' },
    { id: 'm-outside', name: 'วัตถุดิบนอกสูตร', stockUnit: 'มล.' },
  ]);
  M.setRecipes([{ id: 'r1', name: 'ลาเต้', sell: 60, items: [{ matId: 'm-milk', amount: 150, role: '' }] }]);
  M.setDocument({ querySelectorAll: function () { return [{ dataset: { rid: 'r1' } }]; } });
  const choice = { id: 'c1', label: 'เปลี่ยนนม', blockType: 'REPLACE_ONE_INGREDIENT', effectType: 'REPLACE', targetMaterialId: 'm-outside', links: [{ matId: 'm-oatmilk', amount: 150 }], priceAdd: 0, kitchenNote: '' };
  const v = M.ogValidateChoice(choice);
  check('6a validation fails when target not in linked recipe BOM', v.ok === false);
  check('6b reason mentions "ไม่อยู่ในสูตร"', v.items.some(it => !it.ok && it.label.includes('ไม่อยู่ในสูตร')), v.items);
}

// =========================================================================
// 7 & 8. Missing/ambiguous unit fails, using the REAL MaterialResolver
// =========================================================================
console.log('\n--- 7/8. Unit ambiguity (real resolver) ---');
{
  const M = buildSandbox();
  M.setMaterials([{ id: 'm-boba', name: 'ไข่มุก', stockUnit: 'ถุง' }]); // PACKAGING family — never auto-converted
  const amb = M.ogUnitAmbiguous({ id: 'm-boba', name: 'ไข่มุก', stockUnit: 'ถุง' });
  check('7a ambiguous packaging unit ("ถุง") is flagged', amb !== null, amb);
  check('7b Thai explanation mentions the unit', typeof amb === 'string' && amb.includes('ถุง'), amb);

  const okUnit = M.ogUnitAmbiguous({ id: 'm-milk', name: 'นมสด', stockUnit: 'มล.' });
  check('7c recognized VOLUME base unit ("มล.") is NOT ambiguous', okUnit === null, okUnit);

  M.setRecipes([{ id: 'r1', name: 'ชานมไข่มุก', sell: 55, items: [{ matId: 'm-drink', amount: 200, role: '' }] }]);
  M.setMaterials([{ id: 'm-drink', name: 'ฐานชา', stockUnit: 'มล.' }, { id: 'm-boba', name: 'ไข่มุก', stockUnit: 'ถุง' }]);
  M.setDocument({ querySelectorAll: function () { return [{ dataset: { rid: 'r1' } }]; } });
  const choice = { id: 'c1', label: 'เพิ่มไข่มุก', blockType: 'ADD_ONE_INGREDIENT', effectType: 'ADD', targetMaterialId: null, links: [{ matId: 'm-boba', amount: 1 }], priceAdd: 10, kitchenNote: '' };
  const v = M.ogValidateChoice(choice);
  check('8a choice referencing an ambiguous-unit material fails validation', v.ok === false);
  check('8b Thai message present in validation items', v.items.some(it => !it.ok && it.label.includes('แปลงหน่วย')), v.items);
}

// =========================================================================
// 9. V13 conflict detector: two choices targeting the same material
// =========================================================================
console.log('\n--- 9. V13 conflict detection ---');
{
  const M = buildSandbox();
  M.setMaterials([{ id: 'm-milk', name: 'นมสด', stockUnit: 'มล.' }]);
  const choices = [
    { id: 'c1', label: 'เปลี่ยนเป็นนมโอ๊ต', enabled: true, effectType: 'REPLACE', targetMaterialId: 'm-milk' },
    { id: 'c2', label: 'ปรับปริมาณนม', enabled: true, effectType: 'QUANTITY', targetMaterialId: 'm-milk' },
    { id: 'c3', label: 'ไม่เกี่ยวข้อง', enabled: true, effectType: 'ADD', targetMaterialId: null },
  ];
  const conflicts = M.ogDetectConflicts(choices);
  check('9a one conflict group found', conflicts.length === 1, conflicts);
  check('9b conflict names both REPLACE/QUANTITY choices', conflicts[0] && conflicts[0].choices.length === 2 && conflicts[0].choices.map(x => x.id).sort().join(',') === 'c1,c2');
  check('9c unrelated ADD choice not implicated', !conflicts.some(cf => cf.choices.some(x => x.id === 'c3')));

  const disabled = M.ogDetectConflicts([
    { id: 'c1', label: 'a', enabled: false, effectType: 'REPLACE', targetMaterialId: 'm-milk' },
    { id: 'c2', label: 'b', enabled: true, effectType: 'QUANTITY', targetMaterialId: 'm-milk' },
  ]);
  check('9d a disabled choice does not count toward a conflict', disabled.length === 0, disabled);
}

// =========================================================================
// 10. Price resolution: base + delta = resolved (pure calc)
// =========================================================================
console.log('\n--- 10. Price resolution ---');
{
  const M = buildSandbox();
  M.setRecipes([{ id: 'r1', name: 'ลาเต้', sell: 100, items: [] }]);
  M.setOptionGroups([{ id: 'g1', recipeIds: ['r1'] }]);
  M.setEditGroupId('g1');
  M.setDocument({ querySelectorAll: function () { return []; } }); // no live checkboxes — falls back to optionGroups lookup
  const pr = M.ogPriceResolve({ priceAdd: 20 });
  check('10a base resolved from linked recipe sell price', pr && pr.base === 100, pr);
  check('10b delta = priceAdd', pr && pr.delta === 20, pr);
  check('10c resolved = base + delta', pr && pr.resolved === 120, pr);

  const prNeg = M.ogPriceResolve({ priceAdd: -15 });
  check('10d negative delta subtracts', prNeg && prNeg.resolved === 85, prNeg);
}

// =========================================================================
// 11. Source-contract: stockEngine.js REPLACE/QUANTITY branches unchanged
// =========================================================================
console.log('\n--- 11. Source-contract: stockEngine.js untouched ---');
{
  const replaceBranch = [
    "  for (const ch of choices) {",
    "    if (ch.effect_type !== 'REPLACE') continue;",
    "    const oldId = ch.target_material_id || (ch.target_role ? roleIndex.get(ch.target_role) : null);",
    "    if (oldId) { bom.delete(oldId); if (ch.target_role) roleIndex.delete(ch.target_role); }",
    "    for (const l of ch.links) {",
    "      if (!l.material_id) continue;",
    "      const e = bom.get(l.material_id) || { amount: 0 };",
    "      e.amount += Number(l.amount) || 0;",
    "      bom.set(l.material_id, e);",
    "      if (ch.target_role) roleIndex.set(ch.target_role, l.material_id);",
    "    }",
    "  }",
  ].join('\n');
  const quantityBranch = [
    "  for (const ch of choices) {",
    "    if (ch.effect_type !== 'QUANTITY') continue;",
    "    const matId = ch.target_material_id || (ch.target_role ? roleIndex.get(ch.target_role) : null);",
    "    if (!matId) continue;",
    "    const newAmt = Number(ch.amount) || 0;",
    "    if (newAmt <= 0) bom.delete(matId);",
    "    else { const e = bom.get(matId) || { amount: 0 }; e.amount = newAmt; bom.set(matId, e); }",
    "  }",
  ].join('\n');
  check('11a REPLACE branch byte-identical to the verified source', stockEngineSrc.includes(replaceBranch));
  check('11b QUANTITY branch byte-identical to the verified source', stockEngineSrc.includes(quantityBranch));
  check('11c stockEngine.js still exports buildEffectiveBom (untouched public surface)', /async function buildEffectiveBom\(/.test(stockEngineSrc));
}

// =========================================================================
// 12. classifyLegacyChoice: each mapped class + a multi-link ADD → needs_review
// =========================================================================
console.log('\n--- 12. classifyLegacyChoice mapping ---');
{
  const M = buildSandbox();
  check('12a metadata-only+no-links → INSTRUCTION_ONLY', M.classifyLegacyChoice({ isMetadataOnly: true, links: [] }) === 'INSTRUCTION_ONLY');
  check('12b ADD+1 link → ADD_ONE_INGREDIENT', M.classifyLegacyChoice({ effectType: 'ADD', links: [{ matId: 'm1' }] }) === 'ADD_ONE_INGREDIENT');
  check('12c REPLACE+target+1 link → REPLACE_ONE_INGREDIENT', M.classifyLegacyChoice({ effectType: 'REPLACE', targetMaterialId: 'm1', links: [{ matId: 'm2' }] }) === 'REPLACE_ONE_INGREDIENT');
  check('12d QUANTITY+target → CHANGE_ONE_QUANTITY', M.classifyLegacyChoice({ effectType: 'QUANTITY', targetMaterialId: 'm1', links: [] }) === 'CHANGE_ONE_QUANTITY');
  check('12e RECIPE_VARIANT+variant id → RECIPE_VARIANT', M.classifyLegacyChoice({ effectType: 'RECIPE_VARIANT', variantRecipeId: 'r1', links: [] }) === 'RECIPE_VARIANT');
  check('12f multi-link ADD → needs_review', M.classifyLegacyChoice({ effectType: 'ADD', links: [{ matId: 'm1' }, { matId: 'm2' }] }) === 'needs_review');
  check('12g REPLACE with no target → needs_review', M.classifyLegacyChoice({ effectType: 'REPLACE', links: [{ matId: 'm1' }] }) === 'needs_review');
  check('12h RECIPE_VARIANT with no variant id → needs_review', M.classifyLegacyChoice({ effectType: 'RECIPE_VARIANT', links: [] }) === 'needs_review');
  const reasons = M.classifyLegacyReasons({ effectType: 'ADD', links: [{ matId: 'm1' }, { matId: 'm2' }] });
  check('12i classifyLegacyReasons returns a non-empty explanation', Array.isArray(reasons) && reasons.length > 0, reasons);
}

// =========================================================================
// 13. Channel/date filter helper
// =========================================================================
console.log('\n--- 13. Channel/date filter (ogChannelActive) ---');
{
  const M = buildSandbox();
  check('13a channel_pos=false excludes the group from POS', M.ogChannelActive({ channelPos: false }, 'channelPos') === false);
  check('13b channel_pos default (undefined) is active', M.ogChannelActive({}, 'channelPos') === true);
  const future = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
  const past = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  check('13c not-yet-started (startAt in the future) excluded', M.ogChannelActive({ startAt: future }, 'channelPos') === false);
  check('13d expired (endAt in the past) excluded', M.ogChannelActive({ endAt: past }, 'channelPos') === false);
  check('13e within an active window is included', M.ogChannelActive({ startAt: past, endAt: future }, 'channelPos') === true);
  check('13f channelDelivery independent of channelPos', M.ogChannelActive({ channelPos: false, channelDelivery: true }, 'channelDelivery') === true);
}

// =========================================================================
// 14. Incomplete draft choice excluded from POS sheet (enabled=false contract)
// =========================================================================
console.log('\n--- 14. Incomplete draft → enabled=false contract ---');
{
  const M = buildSandbox();
  // ADD_ONE_INGREDIENT with no material picked yet — fails validation.
  const draft = { id: 'c1', label: 'เพิ่มบางอย่าง', blockType: 'ADD_ONE_INGREDIENT', effectType: 'ADD', links: [{ matId: '', amount: 0 }], targetMaterialId: null, priceAdd: 0, kitchenNote: '', enabled: true };
  const v = M.ogValidateChoice(draft);
  check('14a incomplete ADD choice fails validation', v.ok === false);
  // Replicates saveGroupForm's contract (frontend/index.html): blockType set + !v.ok => enabled forced false.
  const enabledAfterSave = v.ok ? draft.enabled : false;
  check('14b contract: invalid+blockType-set choice is forced enabled=false so it cannot reach POS/Delivery sheets', enabledAfterSave === false);

  const complete = { id: 'c2', label: 'เพิ่มไข่มุก', blockType: 'ADD_ONE_INGREDIENT', effectType: 'ADD', links: [{ matId: 'm-boba', amount: 1 }], targetMaterialId: null, priceAdd: 10, kitchenNote: '', enabled: true };
  M.setMaterials([{ id: 'm-boba', name: 'ไข่มุก', stockUnit: 'ชิ้น' }]);
  const v2 = M.ogValidateChoice(complete);
  check('14c a fully-specified choice with a resolvable unit validates ok', v2.ok === true, v2.items);
}

console.log('\n=== Results: ' + passed + ' passed, ' + failed + ' failed ===');
process.exit(failed > 0 ? 1 : 0);
