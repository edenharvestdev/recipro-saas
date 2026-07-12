// Conditional Option Flow V1 — PURE deterministic flow resolver.
// No DB, no writes, no bills/orders, no input mutation. Same input → same output.
//
// resolveFlow({ template, steps, rules, menuBindings, choiceSets, componentSets,
//               effectsByOptionChoiceId, selections })
//   → { visibleSteps, currentStep, atCart, resolvedPath, selectedChoices, effects, warnings }
//
// Determinism / conflict resolution (documented):
//   - steps processed in ascending `seq` (ties → input order).
//   - rules processed in ascending (priority, input-index); lower priority number = higher precedence.
//   - visibility: base=active; if any SHOW_IF targets a step it is visible only when >=1 SHOW_IF matches;
//     a matching HIDE_IF forces hidden (HIDE wins over SHOW).
//   - required: base=step.required; REQUIRE_IF→true / OPTIONAL_IF→false applied in (priority,index) order,
//     last applied wins.
//   - navigation: a matching SKIP_TO removes steps strictly between source and target; the earliest
//     matching END_AT_CART truncates the path after its step. If END_AT_CART and SKIP_TO match at the
//     same step & priority, END_AT_CART wins (safer to end); the validator flags this as a conflict.

const { assembleEffects } = require('./effect-assembly');

function selArrOf(selections, key) {
  const s = selections ? selections[key] : undefined;
  if (s == null) return [];
  return Array.isArray(s) ? s.map(String) : [String(s)];
}

// Evaluate a rule's when-condition over current selections. ANY/NONE test presence of a selection.
function evalWhen(rule, selections) {
  const op = rule.when_op;
  const sel = selArrOf(selections, rule.when_step_key);
  const val = rule.when_value == null ? [] : (Array.isArray(rule.when_value) ? rule.when_value.map(String) : [String(rule.when_value)]);
  const some = (a, b) => a.some((x) => b.indexOf(x) !== -1);
  switch (op) {
    case 'ANY': return sel.length > 0;
    case 'NONE': return sel.length === 0;
    case 'EQUALS': return sel.length === 1 && sel[0] === val[0];
    case 'NOT_EQUALS': return !(sel.length === 1 && sel[0] === val[0]);
    case 'IN': return some(sel, val);
    case 'NOT_IN': return !some(sel, val);
    default: return false;   // unknown op → no match (validator flags it)
  }
}

function resolveFlow(input) {
  input = input || {};
  const warnings = [];
  const selections = input.selections || {};
  const choiceSets = input.choiceSets || {};
  const menuBindings = input.menuBindings || {};
  const stepBindings = menuBindings.stepBindings || {};

  const steps = (input.steps || []).slice()
    .map((s, i) => ({ s, i }))
    .sort((a, b) => ((a.s.seq || 0) - (b.s.seq || 0)) || (a.i - b.i))
    .map((x) => x.s)
    .filter((s) => s.active !== false);

  const rules = (input.rules || []).map((r, i) => ({ r, i }))
    .sort((a, b) => ((a.r.priority == null ? 100 : a.r.priority) - (b.r.priority == null ? 100 : b.r.priority)) || (a.i - b.i))
    .map((x) => x.r);

  const rulesByTarget = (type, key) => rules.filter((r) => r.rule_type === type && r.target_step_key === key);
  const stepIndex = {}; steps.forEach((s, i) => { stepIndex[s.step_key] = i; });

  // --- visibility + required per step ---
  const visible = {}, required = {};
  steps.forEach((step) => {
    let vis = true;
    const showRules = rulesByTarget('SHOW_IF', step.step_key);
    if (showRules.length) vis = showRules.some((r) => evalWhen(r, selections));
    const hideRules = rulesByTarget('HIDE_IF', step.step_key);
    if (hideRules.some((r) => evalWhen(r, selections))) vis = false;   // HIDE wins
    visible[step.step_key] = vis;

    let req = step.required !== false;
    rules.forEach((r) => {
      if (r.target_step_key !== step.step_key) return;
      if (r.rule_type === 'REQUIRE_IF' && evalWhen(r, selections)) req = true;
      if (r.rule_type === 'OPTIONAL_IF' && evalWhen(r, selections)) req = false;
    });
    required[step.step_key] = req;
  });

  // --- resolve the selected choice item for each visible step via its bound Choice Set ---
  const itemOf = (step, code) => {
    const setCode = stepBindings[step.choice_slot];
    if (!setCode) { warnings.push({ code: 'NO_SET_BOUND', step: step.step_key, slot: step.choice_slot }); return null; }
    const set = choiceSets[setCode];
    if (!set) { warnings.push({ code: 'CHOICE_SET_NOT_FOUND', step: step.step_key, set: setCode }); return null; }
    const it = (set.items || []).find((x) => x.choice_code === code);
    if (!it) { warnings.push({ code: 'CHOICE_NOT_IN_SET', step: step.step_key, choice: code, set: setCode }); return null; }
    return it;
  };

  // --- traversal: apply SKIP_TO + END_AT_CART over the ordered visible steps ---
  const visOrdered = steps.filter((s) => visible[s.step_key]);
  const skipped = new Set();
  let endAfterKey = null;

  for (let i = 0; i < visOrdered.length; i++) {
    const step = visOrdered[i];
    if (skipped.has(step.step_key)) continue;
    const hasSel = selArrOf(selections, step.step_key).length > 0;
    if (!hasSel) continue;   // navigation rules fire once a selection exists at that step

    // END_AT_CART (rules keyed by when_step_key === this step, or generic when-condition true)
    const endRule = rules.find((r) => r.rule_type === 'END_AT_CART' && r.when_step_key === step.step_key && evalWhen(r, selections));
    // SKIP_TO originating at this step
    const skipRule = rules.find((r) => r.rule_type === 'SKIP_TO' && r.when_step_key === step.step_key && evalWhen(r, selections));

    if (endRule && skipRule && (endRule.priority == null ? 100 : endRule.priority) === (skipRule.priority == null ? 100 : skipRule.priority)) {
      endAfterKey = step.step_key; break;   // conflict → END wins (validator flags)
    }
    if (endRule && (!skipRule || (endRule.priority == null ? 100 : endRule.priority) <= (skipRule.priority == null ? 100 : skipRule.priority))) {
      endAfterKey = step.step_key; break;
    }
    if (skipRule) {
      const from = stepIndex[step.step_key], to = stepIndex[skipRule.target_step_key];
      if (to == null) warnings.push({ code: 'SKIP_TARGET_MISSING', step: step.step_key, target: skipRule.target_step_key });
      else if (to > from) for (let k = from + 1; k < to; k++) if (steps[k]) skipped.add(steps[k].step_key);
      else warnings.push({ code: 'SKIP_NOT_FORWARD', step: step.step_key, target: skipRule.target_step_key });
    }
  }

  // --- effective steps = visible, not skipped, up to (and including) endAfterKey ---
  const effective = [];
  for (const s of visOrdered) {
    if (skipped.has(s.step_key)) continue;
    effective.push(s);
    if (endAfterKey && s.step_key === endAfterKey) break;
  }

  const selectedChoices = [];
  effective.forEach((step) => {
    const codes = selArrOf(selections, step.step_key);
    if (!codes.length) return;
    codes.forEach((code) => {
      const it = itemOf(step, code);
      selectedChoices.push({ step_key: step.step_key, choice_slot: step.choice_slot, choice_code: code, item: it || { choice_code: code } });
    });
  });

  // currentStep = first effective required step lacking a selection
  let currentStep = null;
  for (const step of effective) {
    if (required[step.step_key] && selArrOf(selections, step.step_key).length === 0) { currentStep = step.step_key; break; }
  }
  const forcedEnd = !!endAfterKey && (endAfterKey === (effective[effective.length - 1] || {}).step_key);
  const atCart = currentStep == null && (forcedEnd || effective.every((s) => !required[s.step_key] || selArrOf(selections, s.step_key).length > 0));

  const resolvedPath = selectedChoices.map((sc) => sc.step_key + '=' + sc.choice_code).concat(atCart ? ['CART'] : []);

  const ctx = { choiceSets, componentSets: input.componentSets || {}, effectsByOptionChoiceId: input.effectsByOptionChoiceId || {} };
  const effects = assembleEffects(selectedChoices, menuBindings.componentBindings || [], ctx, selections);

  return {
    visibleSteps: visOrdered.filter((s) => !skipped.has(s.step_key)).map((s) => s.step_key),
    currentStep,
    atCart,
    resolvedPath,
    selectedChoices,
    effects,
    warnings,
  };
}

module.exports = { resolveFlow, evalWhen };
