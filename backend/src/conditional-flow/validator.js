// Conditional Option Flow V1 — design-time flow validator. Pure, no deps beyond constants.
// Never silently accepts an invalid flow. Returns { ok, errors:[{code,...}], warnings:[{code,...}] }.

const { RULE_TYPES, OPERATORS, isValidCode } = require('./constants');

const NEEDS_TARGET = ['SHOW_IF', 'HIDE_IF', 'SKIP_TO', 'REQUIRE_IF', 'OPTIONAL_IF'];
const NEEDS_WHEN = RULE_TYPES;   // every rule has a when-condition (ANY/NONE still key off a step)

function validateFlow(input) {
  input = input || {};
  const steps = input.steps || [];
  const rules = input.rules || [];
  const errors = [], warnings = [];
  const keys = new Set();

  // --- steps ---
  steps.forEach((s, i) => {
    if (!s.step_key || !String(s.step_key).trim()) errors.push({ code: 'EMPTY_STEP_KEY', index: i });
    else {
      if (!isValidCode(s.step_key)) errors.push({ code: 'INVALID_STEP_KEY', step: s.step_key });
      if (keys.has(s.step_key)) errors.push({ code: 'DUPLICATE_STEP_KEY', step: s.step_key });
      keys.add(s.step_key);
    }
  });

  // --- rules ---
  rules.forEach((r, i) => {
    if (!RULE_TYPES.includes(r.rule_type)) { errors.push({ code: 'INVALID_RULE_TYPE', index: i, rule_type: r.rule_type }); return; }
    if (NEEDS_WHEN.includes(r.rule_type)) {
      if (!r.when_step_key) errors.push({ code: 'MISSING_WHEN_STEP', index: i, rule_type: r.rule_type });
      else if (!keys.has(r.when_step_key)) errors.push({ code: 'MISSING_WHEN_STEP_TARGET', index: i, when_step_key: r.when_step_key });
      if (!OPERATORS.includes(r.when_op)) errors.push({ code: 'INVALID_OPERATOR', index: i, when_op: r.when_op });
    }
    if (NEEDS_TARGET.includes(r.rule_type)) {
      if (!r.target_step_key) errors.push({ code: 'MISSING_TARGET_STEP', index: i, rule_type: r.rule_type });
      else if (!keys.has(r.target_step_key)) errors.push({ code: 'TARGET_STEP_NOT_FOUND', index: i, target_step_key: r.target_step_key });
    }
    if (r.rule_type === 'SKIP_TO' && r.target_step_key && (r.target_step_key === r.when_step_key)) {
      errors.push({ code: 'SKIP_SELF_LOOP', index: i, step: r.when_step_key });
    }
  });

  // --- direct SKIP_TO cycles (A→B and B→A) ---
  const skips = rules.filter((r) => r.rule_type === 'SKIP_TO' && r.when_step_key && r.target_step_key);
  skips.forEach((a) => {
    if (skips.some((b) => b.when_step_key === a.target_step_key && b.target_step_key === a.when_step_key)) {
      errors.push({ code: 'DIRECT_CYCLE', a: a.when_step_key, b: a.target_step_key });
    }
  });

  // --- conflicting same-priority navigation rules ---
  const bySrcPri = {};
  rules.forEach((r) => {
    if (r.rule_type !== 'SKIP_TO' && r.rule_type !== 'END_AT_CART') return;
    const k = (r.when_step_key || '') + '@' + (r.priority == null ? 100 : r.priority);
    (bySrcPri[k] = bySrcPri[k] || []).push(r);
  });
  Object.keys(bySrcPri).forEach((k) => {
    const group = bySrcPri[k];
    const skipTargets = new Set(group.filter((r) => r.rule_type === 'SKIP_TO').map((r) => r.target_step_key));
    const hasEnd = group.some((r) => r.rule_type === 'END_AT_CART');
    const hasSkip = group.some((r) => r.rule_type === 'SKIP_TO');
    if (hasEnd && hasSkip) warnings.push({ code: 'END_SKIP_SAME_PRIORITY', at: k });
    if (skipTargets.size > 1) errors.push({ code: 'CONFLICTING_SKIP_SAME_PRIORITY', at: k, targets: Array.from(skipTargets) });
  });

  // --- unreachable step (determinable subset): strictly between an unconditional (ANY) SKIP_TO's
  //     source and target, and never itself a SKIP_TO target ---
  const ordered = steps.slice().sort((a, b) => (a.seq || 0) - (b.seq || 0));
  const idx = {}; ordered.forEach((s, i) => { idx[s.step_key] = i; });
  const skipTargetsAll = new Set(skips.map((r) => r.target_step_key));
  skips.filter((r) => r.when_op === 'ANY').forEach((r) => {
    const from = idx[r.when_step_key], to = idx[r.target_step_key];
    if (from != null && to != null && to > from) {
      for (let k = from + 1; k < to; k++) {
        const sk = ordered[k].step_key;
        if (!skipTargetsAll.has(sk)) warnings.push({ code: 'UNREACHABLE_STEP', step: sk });
      }
    }
  });

  return { ok: errors.length === 0, errors, warnings };
}

// choice_code immutability: a referenced code may not be silently renamed. For F0, block if referenced.
// refs: { rules, menuStepBindings, componentBindings, otherChoiceSetItems } — any structure carrying choice_code use.
function checkChoiceCodeRename(code, refs) {
  refs = refs || {};
  const references = [];
  (refs.rules || []).forEach((r, i) => {
    const vals = r.when_value == null ? [] : (Array.isArray(r.when_value) ? r.when_value : [r.when_value]);
    if (vals.map(String).indexOf(String(code)) !== -1) references.push({ kind: 'flow_rule', index: i });
  });
  (refs.componentBindings || []).forEach((b, i) => {
    const vals = b.trigger_value == null ? [] : (Array.isArray(b.trigger_value) ? b.trigger_value : [b.trigger_value]);
    if (vals.map(String).indexOf(String(code)) !== -1) references.push({ kind: 'component_trigger', index: i });
  });
  (refs.menuStepBindings || []).forEach((b, i) => { if (b.default_code === code) references.push({ kind: 'menu_binding', index: i }); });
  (refs.stockBridge || []).forEach((s, i) => { if (s.choice_code === code) references.push({ kind: 'stock_bridge', index: i }); });
  return { allowed: references.length === 0, references };
}

module.exports = { validateFlow, checkChoiceCodeRename };
