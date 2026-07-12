// Conditional Option Flow V1 — effect assembly bridge to PR#21 shape. Pure, deterministic.
// Produces an array of effect rows in EXACTLY PR#21 option_stock_effects shape:
//   { source, target_type, target_ref_id, action, amount, unit, replace_ref_id, target_role }
// Does NOT deduct stock, does NOT call resolveEffectiveBom, does NOT mutate inputs.
// Dedup rule: an option_choice_id's effects apply once; a component_set applies once per
// distinct (source_kind, source_ref) — a set referenced by both a choice and a menu binding
// is applied a single time (no double application).

const { TARGET_TYPES, ACTIONS } = require('./constants');

function normEffect(raw, source) {
  return {
    source,                                            // provenance for trace/dedup (not sent to stock engine)
    target_type: TARGET_TYPES.includes(raw.target_type) ? raw.target_type : 'NO_STOCK',
    target_ref_id: raw.target_ref_id != null ? String(raw.target_ref_id) : null,
    action: ACTIONS.includes(raw.action) ? raw.action : 'ADD',
    amount: raw.amount == null ? null : Number(raw.amount),
    unit: raw.unit == null ? null : String(raw.unit),
    replace_ref_id: raw.replace_ref_id != null ? String(raw.replace_ref_id) : null,
    target_role: raw.target_role == null ? null : String(raw.target_role),
  };
}

// Evaluate a component-binding trigger against selections (same operators as flow rules).
function triggerMatches(binding, selections) {
  const op = binding.trigger_op;
  if (!op || !binding.trigger_step_key) return true;    // no trigger → always apply
  const sel = selections[binding.trigger_step_key];
  const selArr = sel == null ? [] : (Array.isArray(sel) ? sel.map(String) : [String(sel)]);
  const val = binding.trigger_value;
  const valArr = val == null ? [] : (Array.isArray(val) ? val.map(String) : [String(val)]);
  const some = (a, b) => a.some((x) => b.indexOf(x) !== -1);
  switch (op) {
    case 'ANY': return selArr.length > 0;
    case 'NONE': return selArr.length === 0;
    case 'EQUALS': return selArr.length === 1 && selArr[0] === valArr[0];
    case 'NOT_EQUALS': return !(selArr.length === 1 && selArr[0] === valArr[0]);
    case 'IN': return some(selArr, valArr);
    case 'NOT_IN': return !some(selArr, valArr);
    default: return false;
  }
}

// ctx: { choiceSets, componentSets, effectsByOptionChoiceId }
// selectedChoices: [{ step_key, choice_slot, choice_code, item }] in visible-step order
// componentBindings: menu-level [{ trigger_step_key, trigger_op, trigger_value, component_set_code, seq }]
function assembleEffects(selectedChoices, componentBindings, ctx, selections) {
  ctx = ctx || {};
  const componentSets = ctx.componentSets || {};
  const effectsByChoice = ctx.effectsByOptionChoiceId || {};
  const out = [];
  const appliedChoiceIds = new Set();      // dedup option_choice_id
  const appliedSetKeys = new Set();         // dedup component_set code (choice-applied or binding-applied)

  const pushSet = (code, source) => {
    if (!code || appliedSetKeys.has(code)) return;      // no double application
    const set = componentSets[code];
    if (!set || !Array.isArray(set.items)) return;
    appliedSetKeys.add(code);
    set.items.slice().sort((a, b) => (a.seq || 0) - (b.seq || 0))
      .forEach((it) => out.push(normEffect(it, source + ':' + code)));
  };

  // (a) per selected choice, in visible-step order: its option_choice effects, then its choice-level component set
  (selectedChoices || []).forEach((sc) => {
    const item = sc.item || {};
    const ocid = item.option_choice_id;
    if (ocid && !appliedChoiceIds.has(ocid)) {
      appliedChoiceIds.add(ocid);
      const rows = effectsByChoice[ocid] || [];
      rows.slice().sort((a, b) => (a.seq || 0) - (b.seq || 0))
        .forEach((r) => out.push(normEffect(r, 'choice:' + sc.choice_code)));
    }
    if (item.component_set_code) pushSet(item.component_set_code, 'choice:' + sc.choice_code);
  });

  // (b) menu-level component bindings whose trigger matches, in binding order
  (componentBindings || []).slice().sort((a, b) => (a.seq || 0) - (b.seq || 0)).forEach((b) => {
    if (triggerMatches(b, selections || {})) pushSet(b.component_set_code, 'menu-binding');
  });

  return out;
}

module.exports = { assembleEffects, triggerMatches, normEffect };
