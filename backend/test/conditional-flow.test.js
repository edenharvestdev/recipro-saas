// Conditional Option Flow V1 — F0 pure unit/integration tests (no DB).
// Run: node test/conditional-flow.test.js
const assert = require('assert');
const {
  resolveFlow, validateFlow, checkChoiceCodeRename, assembleEffects, buildSnapshot,
  isValidCode, normalizeCode, isConditionalFlowEnabled,
} = require('../src/conditional-flow');

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); pass++; console.log('  ok  ' + name); } catch (e) { fail++; console.log('FAIL  ' + name + ' — ' + e.message); } }
console.log('conditional-flow.test.js');

// ---------- shared fixtures: flow CHASEN_CLEAR ----------
const step = (seq, key, req) => ({ seq, step_key: key, choice_slot: key, select_type: 'single', required: req !== false, active: true });
const STEPS = [
  step(1, 'TEMPERATURE'), step(2, 'CULTIVAR'), step(3, 'LIQUID'), step(4, 'DRINK_MODE'),
  step(5, 'SERVE_STYLE'), step(6, 'SWEETENER_MODE'), step(7, 'SYRUP_TYPE'), step(8, 'SWEETNESS'),
];
const RULES = [
  { priority: 10, rule_type: 'SHOW_IF', when_step_key: 'SWEETENER_MODE', when_op: 'EQUALS', when_value: 'SPECIAL_SYRUP', target_step_key: 'SYRUP_TYPE' },
  { priority: 10, rule_type: 'SHOW_IF', when_step_key: 'SWEETENER_MODE', when_op: 'EQUALS', when_value: 'SPECIAL_SYRUP', target_step_key: 'SWEETNESS' },
  { priority: 10, rule_type: 'HIDE_IF', when_step_key: 'SWEETENER_MODE', when_op: 'EQUALS', when_value: 'NO_SWEETENER', target_step_key: 'SYRUP_TYPE' },
  { priority: 10, rule_type: 'HIDE_IF', when_step_key: 'SWEETENER_MODE', when_op: 'EQUALS', when_value: 'NO_SWEETENER', target_step_key: 'SWEETNESS' },
  { priority: 20, rule_type: 'END_AT_CART', when_step_key: 'SWEETENER_MODE', when_op: 'EQUALS', when_value: 'NO_SWEETENER', target_step_key: null },
  { priority: 30, rule_type: 'SKIP_TO', when_step_key: 'DRINK_MODE', when_op: 'EQUALS', when_value: 'DINE_IN', target_step_key: 'SWEETENER_MODE' },
];
const cset = (code, kind, items) => ({ code, kind, items });
const ci = (code, extra) => Object.assign({ choice_code: code, label: code, price_add: 0 }, extra || {});
const CHOICE_SETS = {
  TEMPS: cset('TEMPS', 'GENERIC', [ci('HOT'), ci('COLD')]),
  CSG_MATCHA_CULTIVARS: cset('CSG_MATCHA_CULTIVARS', 'CULTIVAR', [ci('M06', { option_choice_id: 'oc_m06' }), ci('M18_HIBI_DAICHI', { option_choice_id: 'oc_m18', price_add: 0 })]),
  CLEAR_LIQUIDS: cset('CLEAR_LIQUIDS', 'LIQUID', [ci('SODA'), ci('WATER')]),
  COCONUT_LIQUIDS: cset('COCONUT_LIQUIDS', 'LIQUID', [ci('COCONUT_WATER')]),
  DRINK_MODES: cset('DRINK_MODES', 'GENERIC', [ci('DINE_IN'), ci('TAKE_AWAY')]),
  SERVE_STYLES: cset('SERVE_STYLES', 'PACKAGING_MODE', [ci('SEPARATE_PACK', { component_set_code: 'SET_CLEAR_SEPARATE' }), ci('TOGETHER')]),
  SWEETENER_MODES: cset('SWEETENER_MODES', 'GENERIC', [ci('NO_SWEETENER'), ci('SPECIAL_SYRUP')]),
  SPECIAL_SYRUPS: cset('SPECIAL_SYRUPS', 'SYRUP', [ci('ACACIA'), ci('MAPLE')]),
  SWEETNESS_LEVELS: cset('SWEETNESS_LEVELS', 'SWEETNESS', [ci('G0'), ci('G3'), ci('G5'), ci('G8')]),
};
const COMPONENT_SETS = {
  SET_CLEAR_TAKEAWAY: { code: 'SET_CLEAR_TAKEAWAY', items: [
    { seq: 1, target_type: 'PACKAGING', target_ref_id: 'cup12', action: 'ADD', amount: 1, unit: 'pcs' },
    { seq: 2, target_type: 'PACKAGING', target_ref_id: 'lid', action: 'ADD', amount: 1, unit: 'pcs' }] },
  SET_CLEAR_SEPARATE: { code: 'SET_CLEAR_SEPARATE', items: [
    { seq: 1, target_type: 'PACKAGING', target_ref_id: 'bag50', action: 'ADD', amount: 1, unit: 'pcs' },
    { seq: 2, target_type: 'PACKAGING', target_ref_id: 'bag150', action: 'ADD', amount: 1, unit: 'pcs' }] },
  SET_COCONUT_TAKEAWAY: { code: 'SET_COCONUT_TAKEAWAY', items: [
    { seq: 1, target_type: 'PACKAGING', target_ref_id: 'cup16', action: 'ADD', amount: 1, unit: 'pcs' }] },
};
const EFFECTS_BY_CHOICE = {
  oc_m06: [{ seq: 1, target_type: 'MATERIAL', target_ref_id: 'matcha_m06', action: 'ADD', amount: 3, unit: 'g' }],
  oc_m18: [{ seq: 1, target_type: 'MATERIAL', target_ref_id: 'matcha_m18', action: 'ADD', amount: 3, unit: 'g' }],
};
// menu binding factory: flow same, only referenced sets differ
const binding = (liquidSet, takeawaySet) => ({
  template_code: 'CHASEN_CLEAR', template_version: 1,
  stepBindings: { TEMPERATURE: 'TEMPS', CULTIVAR: 'CSG_MATCHA_CULTIVARS', LIQUID: liquidSet, DRINK_MODE: 'DRINK_MODES',
    SERVE_STYLE: 'SERVE_STYLES', SWEETENER_MODE: 'SWEETENER_MODES', SYRUP_TYPE: 'SPECIAL_SYRUPS', SWEETNESS: 'SWEETNESS_LEVELS' },
  componentBindings: [{ seq: 1, trigger_step_key: 'DRINK_MODE', trigger_op: 'EQUALS', trigger_value: 'TAKE_AWAY', component_set_code: takeawaySet }],
});
const CLEAR_MATCHA = binding('CLEAR_LIQUIDS', 'SET_CLEAR_TAKEAWAY');
const CLEAR_COCONUT = binding('COCONUT_LIQUIDS', 'SET_COCONUT_TAKEAWAY');
const run = (menuBindings, selections) => resolveFlow({
  template: { code: 'CHASEN_CLEAR', version: 1 }, steps: STEPS, rules: RULES,
  menuBindings, choiceSets: CHOICE_SETS, componentSets: COMPONENT_SETS,
  effectsByOptionChoiceId: EFFECTS_BY_CHOICE, selections,
});

// ---------- FLOW ----------
t('CF1 linear flow: all required steps → not at cart until all selected', () => {
  const r = run(CLEAR_MATCHA, { TEMPERATURE: 'COLD' });
  assert.strictEqual(r.atCart, false);
  assert.strictEqual(r.currentStep, 'CULTIVAR');
});
t('CF2 required step blocks cart', () => {
  const r = run(CLEAR_MATCHA, { TEMPERATURE: 'COLD', CULTIVAR: 'M06', LIQUID: 'SODA', DRINK_MODE: 'TAKE_AWAY', SERVE_STYLE: 'TOGETHER' });
  assert.strictEqual(r.currentStep, 'SWEETENER_MODE');
  assert.strictEqual(r.atCart, false);
});
t('CF3 optional step does not block cart', () => {
  const steps2 = STEPS.map((s) => s.step_key === 'SWEETNESS' ? Object.assign({}, s, { required: false }) : s);
  const r = resolveFlow({ template: { code: 'X', version: 1 }, steps: steps2, rules: [], menuBindings: CLEAR_MATCHA, choiceSets: CHOICE_SETS, componentSets: COMPONENT_SETS, effectsByOptionChoiceId: EFFECTS_BY_CHOICE,
    selections: { TEMPERATURE: 'COLD', CULTIVAR: 'M06', LIQUID: 'SODA', DRINK_MODE: 'TAKE_AWAY', SERVE_STYLE: 'TOGETHER', SWEETENER_MODE: 'SPECIAL_SYRUP', SYRUP_TYPE: 'ACACIA' } });
  assert.strictEqual(r.currentStep, null);
  assert.strictEqual(r.atCart, true);
});
t('CF4 SHOW_IF: SYRUP_TYPE/SWEETNESS shown only when SPECIAL_SYRUP', () => {
  const hidden = run(CLEAR_MATCHA, { SWEETENER_MODE: 'SPECIAL_SYRUP' });
  assert.ok(hidden.visibleSteps.includes('SYRUP_TYPE') && hidden.visibleSteps.includes('SWEETNESS'));
  const noShow = run(CLEAR_MATCHA, { SWEETENER_MODE: undefined });
  assert.ok(!noShow.visibleSteps.includes('SYRUP_TYPE'));   // SHOW_IF unmet → hidden
});
t('CF5 HIDE_IF + END_AT_CART: NO_SWEETENER hides syrup/sweetness and ends at cart', () => {
  const r = run(CLEAR_MATCHA, { TEMPERATURE: 'COLD', CULTIVAR: 'M06', LIQUID: 'SODA', DRINK_MODE: 'TAKE_AWAY', SERVE_STYLE: 'TOGETHER', SWEETENER_MODE: 'NO_SWEETENER' });
  assert.ok(!r.visibleSteps.includes('SYRUP_TYPE'));
  assert.ok(!r.visibleSteps.includes('SWEETNESS'));
  assert.strictEqual(r.atCart, true);
  assert.strictEqual(r.resolvedPath[r.resolvedPath.length - 1], 'CART');
});
t('CF6 SKIP_TO: DINE_IN skips SERVE_STYLE', () => {
  const r = run(CLEAR_MATCHA, { TEMPERATURE: 'COLD', CULTIVAR: 'M06', LIQUID: 'SODA', DRINK_MODE: 'DINE_IN' });
  assert.ok(!r.visibleSteps.includes('SERVE_STYLE'));
  assert.strictEqual(r.currentStep, 'SWEETENER_MODE');   // jumped past SERVE_STYLE
});
t('CF7 TAKE_AWAY keeps SERVE_STYLE in flow', () => {
  const r = run(CLEAR_MATCHA, { TEMPERATURE: 'COLD', CULTIVAR: 'M06', LIQUID: 'SODA', DRINK_MODE: 'TAKE_AWAY' });
  assert.ok(r.visibleSteps.includes('SERVE_STYLE'));
  assert.strictEqual(r.currentStep, 'SERVE_STYLE');
});
t('CF8 REQUIRE_IF makes an optional step required', () => {
  const steps2 = STEPS.map((s) => s.step_key === 'SWEETNESS' ? Object.assign({}, s, { required: false }) : s);
  const rules2 = [{ priority: 5, rule_type: 'REQUIRE_IF', when_step_key: 'SWEETENER_MODE', when_op: 'EQUALS', when_value: 'SPECIAL_SYRUP', target_step_key: 'SWEETNESS' }];
  const r = resolveFlow({ template: { code: 'X', version: 1 }, steps: steps2, rules: rules2, menuBindings: CLEAR_MATCHA, choiceSets: CHOICE_SETS,
    selections: { TEMPERATURE: 'COLD', CULTIVAR: 'M06', LIQUID: 'SODA', DRINK_MODE: 'TAKE_AWAY', SERVE_STYLE: 'TOGETHER', SWEETENER_MODE: 'SPECIAL_SYRUP', SYRUP_TYPE: 'ACACIA' } });
  assert.strictEqual(r.currentStep, 'SWEETNESS');   // now required
});
t('CF9 OPTIONAL_IF relaxes a required step', () => {
  const rules2 = [{ priority: 5, rule_type: 'OPTIONAL_IF', when_step_key: 'TEMPERATURE', when_op: 'EQUALS', when_value: 'HOT', target_step_key: 'SWEETNESS' }];
  const sel = { TEMPERATURE: 'HOT', CULTIVAR: 'M06', LIQUID: 'SODA', DRINK_MODE: 'TAKE_AWAY', SERVE_STYLE: 'TOGETHER', SWEETENER_MODE: 'SPECIAL_SYRUP', SYRUP_TYPE: 'ACACIA' };
  const r = resolveFlow({ template: { code: 'X', version: 1 }, steps: STEPS, rules: rules2.concat(RULES.filter((x) => x.rule_type === 'SHOW_IF')), menuBindings: CLEAR_MATCHA, choiceSets: CHOICE_SETS, selections: sel });
  assert.strictEqual(r.currentStep, null);   // SWEETNESS relaxed → cart reachable
  assert.strictEqual(r.atCart, true);
});

// ---------- CONDITION OPERATORS ----------
const oneRule = (op, val) => resolveFlow({ template: {}, steps: [step(1, 'A'), step(2, 'B')],
  rules: [{ priority: 1, rule_type: 'HIDE_IF', when_step_key: 'A', when_op: op, when_value: val, target_step_key: 'B' }],
  menuBindings: { stepBindings: { A: 'TEMPS', B: 'TEMPS' } }, choiceSets: CHOICE_SETS, selections: { A: 'HOT' } });
t('CF10 EQUALS', () => { assert.ok(!oneRule('EQUALS', 'HOT').visibleSteps.includes('B')); assert.ok(oneRule('EQUALS', 'COLD').visibleSteps.includes('B')); });
t('CF11 NOT_EQUALS', () => { assert.ok(oneRule('NOT_EQUALS', 'HOT').visibleSteps.includes('B')); assert.ok(!oneRule('NOT_EQUALS', 'COLD').visibleSteps.includes('B')); });
t('CF12 IN', () => { assert.ok(!oneRule('IN', ['HOT', 'X']).visibleSteps.includes('B')); assert.ok(oneRule('IN', ['X', 'Y']).visibleSteps.includes('B')); });
t('CF13 NOT_IN', () => { assert.ok(oneRule('NOT_IN', ['HOT']).visibleSteps.includes('B')); assert.ok(!oneRule('NOT_IN', ['X']).visibleSteps.includes('B')); });
t('CF14 ANY (has selection)', () => { assert.ok(!oneRule('ANY', null).visibleSteps.includes('B')); });
t('CF15 NONE (no selection)', () => {
  const r = resolveFlow({ template: {}, steps: [step(1, 'A'), step(2, 'B')], rules: [{ priority: 1, rule_type: 'HIDE_IF', when_step_key: 'A', when_op: 'NONE', target_step_key: 'B' }], menuBindings: { stepBindings: {} }, choiceSets: CHOICE_SETS, selections: {} });
  assert.ok(!r.visibleSteps.includes('B'));   // A unset → NONE true → B hidden
});

// ---------- VALIDATION ----------
t('CF16 duplicate step_key', () => { assert.ok(validateFlow({ steps: [step(1, 'A'), step(2, 'A')], rules: [] }).errors.some((e) => e.code === 'DUPLICATE_STEP_KEY')); });
t('CF17 missing target step', () => { assert.ok(validateFlow({ steps: [step(1, 'A')], rules: [{ rule_type: 'SKIP_TO', when_step_key: 'A', when_op: 'ANY', target_step_key: 'GHOST' }] }).errors.some((e) => e.code === 'TARGET_STEP_NOT_FOUND')); });
t('CF18 missing source (when) step', () => { assert.ok(validateFlow({ steps: [step(1, 'A'), step(2, 'B')], rules: [{ rule_type: 'HIDE_IF', when_step_key: 'GHOST', when_op: 'EQUALS', when_value: 'x', target_step_key: 'B' }] }).errors.some((e) => e.code === 'MISSING_WHEN_STEP_TARGET')); });
t('CF19 invalid operator', () => { assert.ok(validateFlow({ steps: [step(1, 'A'), step(2, 'B')], rules: [{ rule_type: 'HIDE_IF', when_step_key: 'A', when_op: 'LIKE', when_value: 'x', target_step_key: 'B' }] }).errors.some((e) => e.code === 'INVALID_OPERATOR')); });
t('CF20 invalid rule type', () => { assert.ok(validateFlow({ steps: [step(1, 'A')], rules: [{ rule_type: 'TELEPORT', when_step_key: 'A' }] }).errors.some((e) => e.code === 'INVALID_RULE_TYPE')); });
t('CF21 SKIP self-loop', () => { assert.ok(validateFlow({ steps: [step(1, 'A'), step(2, 'B')], rules: [{ rule_type: 'SKIP_TO', when_step_key: 'A', when_op: 'ANY', target_step_key: 'A' }] }).errors.some((e) => e.code === 'SKIP_SELF_LOOP')); });
t('CF22 direct cycle', () => { assert.ok(validateFlow({ steps: [step(1, 'A'), step(2, 'B')], rules: [{ rule_type: 'SKIP_TO', when_step_key: 'A', when_op: 'ANY', target_step_key: 'B' }, { rule_type: 'SKIP_TO', when_step_key: 'B', when_op: 'ANY', target_step_key: 'A' }] }).errors.some((e) => e.code === 'DIRECT_CYCLE')); });
t('CF23 conflicting same-priority SKIP', () => { assert.ok(validateFlow({ steps: [step(1, 'A'), step(2, 'B'), step(3, 'C')], rules: [{ rule_type: 'SKIP_TO', priority: 1, when_step_key: 'A', when_op: 'ANY', target_step_key: 'B' }, { rule_type: 'SKIP_TO', priority: 1, when_step_key: 'A', when_op: 'ANY', target_step_key: 'C' }] }).errors.some((e) => e.code === 'CONFLICTING_SKIP_SAME_PRIORITY')); });
t('CF24 END_AT_CART / SKIP_TO same-priority conflict flagged', () => { assert.ok(validateFlow({ steps: [step(1, 'A'), step(2, 'B')], rules: [{ rule_type: 'END_AT_CART', priority: 1, when_step_key: 'A', when_op: 'ANY', target_step_key: null }, { rule_type: 'SKIP_TO', priority: 1, when_step_key: 'A', when_op: 'ANY', target_step_key: 'B' }] }).warnings.some((w) => w.code === 'END_SKIP_SAME_PRIORITY')); });
t('CF25 valid flow passes clean', () => { const v = validateFlow({ steps: STEPS, rules: RULES }); assert.strictEqual(v.ok, true, JSON.stringify(v.errors)); });
t('CF26 step_key format enforced', () => { assert.ok(!isValidCode('bad key')); assert.ok(isValidCode('DRINK_MODE')); assert.strictEqual(normalizeCode(' drink-mode '), 'DRINK_MODE'); });

// ---------- CHOICE SETS ----------
t('CF27 choice set reusable by two menus (same cultivar set)', () => {
  const a = run(CLEAR_MATCHA, { CULTIVAR: 'M18_HIBI_DAICHI' });
  const b = run(CLEAR_COCONUT, { CULTIVAR: 'M18_HIBI_DAICHI' });
  assert.strictEqual(a.selectedChoices.find((s) => s.step_key === 'CULTIVAR').item.option_choice_id, 'oc_m18');
  assert.strictEqual(b.selectedChoices.find((s) => s.step_key === 'CULTIVAR').item.option_choice_id, 'oc_m18');
});
t('CF28 different liquid set on same flow', () => {
  const a = run(CLEAR_MATCHA, { LIQUID: 'SODA' });          // CLEAR_LIQUIDS has SODA
  const b = run(CLEAR_COCONUT, { LIQUID: 'COCONUT_WATER' }); // COCONUT_LIQUIDS
  assert.ok(!a.warnings.some((w) => w.code === 'CHOICE_NOT_IN_SET'));
  assert.ok(!b.warnings.some((w) => w.code === 'CHOICE_NOT_IN_SET'));
  const bad = run(CLEAR_COCONUT, { LIQUID: 'SODA' });        // SODA not in COCONUT_LIQUIDS
  assert.ok(bad.warnings.some((w) => w.code === 'CHOICE_NOT_IN_SET'));
});
t('CF29 immutable referenced choice_code blocked from rename', () => {
  const refs = { rules: RULES, componentBindings: CLEAR_MATCHA.componentBindings };
  assert.strictEqual(checkChoiceCodeRename('NO_SWEETENER', refs).allowed, false);   // referenced by rule
  assert.strictEqual(checkChoiceCodeRename('TAKE_AWAY', refs).allowed, false);       // referenced by component trigger
  assert.strictEqual(checkChoiceCodeRename('UNREFERENCED_CODE', refs).allowed, true);
});

// ---------- COMPONENT SETS + EFFECT ASSEMBLY ----------
t('CF30 component set → two packaging effects', () => {
  const eff = assembleEffects([], [{ seq: 1, component_set_code: 'SET_CLEAR_TAKEAWAY' }], { componentSets: COMPONENT_SETS }, {});
  assert.strictEqual(eff.length, 2);
  assert.deepStrictEqual(eff.map((e) => e.target_ref_id), ['cup12', 'lid']);
  assert.ok(eff.every((e) => e.action === 'ADD' && e.target_type === 'PACKAGING'));
});
t('CF31 effect assembly: option_stock_effects only', () => {
  const sc = [{ step_key: 'CULTIVAR', choice_code: 'M06', item: { option_choice_id: 'oc_m06' } }];
  const eff = assembleEffects(sc, [], { effectsByOptionChoiceId: EFFECTS_BY_CHOICE }, {});
  assert.strictEqual(eff.length, 1); assert.strictEqual(eff[0].target_ref_id, 'matcha_m06');
});
t('CF32 effect assembly: component only', () => {
  const eff = assembleEffects([], [{ component_set_code: 'SET_CLEAR_SEPARATE' }], { componentSets: COMPONENT_SETS }, {});
  assert.deepStrictEqual(eff.map((e) => e.target_ref_id), ['bag50', 'bag150']);
});
t('CF33 effect assembly: both combined, deterministic order (choice effects then component)', () => {
  const sc = [{ step_key: 'CULTIVAR', choice_code: 'M06', item: { option_choice_id: 'oc_m06' } },
              { step_key: 'SERVE_STYLE', choice_code: 'SEPARATE_PACK', item: { component_set_code: 'SET_CLEAR_SEPARATE' } }];
  const eff = assembleEffects(sc, [{ component_set_code: 'SET_CLEAR_TAKEAWAY' }], { componentSets: COMPONENT_SETS, effectsByOptionChoiceId: EFFECTS_BY_CHOICE }, {});
  assert.deepStrictEqual(eff.map((e) => e.target_ref_id), ['matcha_m06', 'bag50', 'bag150', 'cup12', 'lid']);
});
t('CF34 no double application (same set via choice AND menu binding applied once)', () => {
  const sc = [{ step_key: 'SERVE_STYLE', choice_code: 'SEPARATE_PACK', item: { component_set_code: 'SET_CLEAR_TAKEAWAY' } }];
  const eff = assembleEffects(sc, [{ component_set_code: 'SET_CLEAR_TAKEAWAY' }], { componentSets: COMPONENT_SETS }, {});
  assert.strictEqual(eff.length, 2);   // not 4
});
t('CF35 cross-shop / unknown component set → not applied (rejected at assembly)', () => {
  const eff = assembleEffects([], [{ component_set_code: 'SET_FROM_OTHER_SHOP' }], { componentSets: COMPONENT_SETS }, {});
  assert.strictEqual(eff.length, 0);
});
t('CF36 menu component binding trigger honored (TAKE_AWAY applies, DINE_IN does not)', () => {
  const away = run(CLEAR_MATCHA, { CULTIVAR: 'M06', DRINK_MODE: 'TAKE_AWAY' });
  assert.ok(away.effects.some((e) => e.target_ref_id === 'cup12'));
  const dinein = run(CLEAR_MATCHA, { CULTIVAR: 'M06', DRINK_MODE: 'DINE_IN' });
  assert.ok(!dinein.effects.some((e) => e.target_ref_id === 'cup12'));
});

// ---------- SNAPSHOT ----------
t('CF37 snapshot: stable choices/path/effects', () => {
  const r = run(CLEAR_MATCHA, { TEMPERATURE: 'COLD', CULTIVAR: 'M06', LIQUID: 'SODA', DRINK_MODE: 'TAKE_AWAY', SERVE_STYLE: 'TOGETHER', SWEETENER_MODE: 'NO_SWEETENER' });
  const snap = buildSnapshot(r, { code: 'CHASEN_CLEAR', version: 1 });
  assert.strictEqual(snap.flow_template_code, 'CHASEN_CLEAR');
  assert.strictEqual(snap.flow_template_version, 1);
  assert.ok(snap.resolved_flow_path.includes('SWEETENER_MODE=NO_SWEETENER'));
  assert.strictEqual(snap.resolved_flow_path[snap.resolved_flow_path.length - 1], 'CART');
});
t('CF38 snapshot immutable — later input mutation does not change it', () => {
  const sel = { TEMPERATURE: 'COLD', CULTIVAR: 'M06', LIQUID: 'SODA', DRINK_MODE: 'DINE_IN', SWEETENER_MODE: 'NO_SWEETENER' };
  const r = run(CLEAR_MATCHA, sel);
  const snap = buildSnapshot(r, { code: 'CHASEN_CLEAR', version: 1 });
  const before = JSON.stringify(snap);
  // mutate everything downstream
  sel.CULTIVAR = 'M18_HIBI_DAICHI';
  CHOICE_SETS.CSG_MATCHA_CULTIVARS.items[0].label = 'RENAMED';
  r.selectedChoices.push({ step_key: 'HACK' });
  try { snap.resolved_flow_path.push('HACK'); } catch (e) {}   // frozen → throws or no-op
  assert.strictEqual(JSON.stringify(snap), before);
  CHOICE_SETS.CSG_MATCHA_CULTIVARS.items[0].label = 'M06';   // restore fixture
});
t('CF39 snapshot deterministic (same input → identical)', () => {
  const sel = { TEMPERATURE: 'COLD', CULTIVAR: 'M06', LIQUID: 'SODA', DRINK_MODE: 'DINE_IN', SWEETENER_MODE: 'NO_SWEETENER' };
  const s1 = JSON.stringify(buildSnapshot(run(CLEAR_MATCHA, sel), { code: 'CHASEN_CLEAR', version: 1 }));
  const s2 = JSON.stringify(buildSnapshot(run(CLEAR_MATCHA, sel), { code: 'CHASEN_CLEAR', version: 1 }));
  assert.strictEqual(s1, s2);
});

// ---------- EXAMPLES ----------
t('CF40 Example — Clear Matcha (TAKE_AWAY, SPECIAL_SYRUP) full path + takeaway packaging', () => {
  const r = run(CLEAR_MATCHA, { TEMPERATURE: 'COLD', CULTIVAR: 'M06', LIQUID: 'SODA', DRINK_MODE: 'TAKE_AWAY', SERVE_STYLE: 'TOGETHER', SWEETENER_MODE: 'SPECIAL_SYRUP', SYRUP_TYPE: 'ACACIA', SWEETNESS: 'G5' });
  assert.strictEqual(r.atCart, true);
  assert.ok(r.effects.some((e) => e.target_ref_id === 'cup12'));       // takeaway set applied
  assert.ok(r.effects.some((e) => e.target_ref_id === 'matcha_m06'));  // cultivar stock
});
t('CF41 Example — Clear Matcha Coconut: same flow, coconut liquid + coconut takeaway set', () => {
  const r = run(CLEAR_COCONUT, { TEMPERATURE: 'COLD', CULTIVAR: 'M06', LIQUID: 'COCONUT_WATER', DRINK_MODE: 'TAKE_AWAY', SERVE_STYLE: 'TOGETHER', SWEETENER_MODE: 'NO_SWEETENER' });
  assert.strictEqual(r.atCart, true);
  assert.ok(r.effects.some((e) => e.target_ref_id === 'cup16'));       // coconut takeaway set
  assert.ok(!r.effects.some((e) => e.target_ref_id === 'cup12'));      // NOT the clear set
  assert.ok(!r.visibleSteps.includes('SYRUP_TYPE'));                   // NO_SWEETENER hid syrup
});
t('CF42 Example — Matcha Latte (separate template) reuses cultivar set', () => {
  const LATTE_STEPS = [step(1, 'TEMPERATURE'), step(2, 'CULTIVAR'), step(3, 'DRINK_MODE'), step(4, 'SWEETENER_MODE')];
  const LATTE_BIND = { template_code: 'MATCHA_LATTE', template_version: 1,
    stepBindings: { TEMPERATURE: 'TEMPS', CULTIVAR: 'CSG_MATCHA_CULTIVARS', DRINK_MODE: 'DRINK_MODES', SWEETENER_MODE: 'SWEETENER_MODES' },
    componentBindings: [{ trigger_step_key: 'DRINK_MODE', trigger_op: 'EQUALS', trigger_value: 'TAKE_AWAY', component_set_code: 'SET_CLEAR_TAKEAWAY' }] };
  const r = resolveFlow({ template: { code: 'MATCHA_LATTE', version: 1 }, steps: LATTE_STEPS, rules: [], menuBindings: LATTE_BIND, choiceSets: CHOICE_SETS, componentSets: COMPONENT_SETS, effectsByOptionChoiceId: EFFECTS_BY_CHOICE,
    selections: { TEMPERATURE: 'HOT', CULTIVAR: 'M18_HIBI_DAICHI', DRINK_MODE: 'TAKE_AWAY', SWEETENER_MODE: 'NO_SWEETENER' } });
  assert.strictEqual(r.atCart, true);
  assert.ok(r.effects.some((e) => e.target_ref_id === 'matcha_m18'));  // same cultivar set, different flow
});

// ---------- flag + purity ----------
t('CF43 feature flag default OFF', () => {
  assert.strictEqual(isConditionalFlowEnabled({}), false);
  assert.strictEqual(isConditionalFlowEnabled({ CONDITIONAL_FLOW_V1: 'false' }), false);
  assert.strictEqual(isConditionalFlowEnabled({ CONDITIONAL_FLOW_V1: 'true' }), true);
});
t('CF44 resolver does not mutate inputs', () => {
  const sel = { TEMPERATURE: 'COLD' }; const selCopy = JSON.stringify(sel);
  const stepsCopy = JSON.stringify(STEPS); const rulesCopy = JSON.stringify(RULES);
  run(CLEAR_MATCHA, sel);
  assert.strictEqual(JSON.stringify(sel), selCopy);
  assert.strictEqual(JSON.stringify(STEPS), stepsCopy);
  assert.strictEqual(JSON.stringify(RULES), rulesCopy);
});

console.log(`\nconditional-flow: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
