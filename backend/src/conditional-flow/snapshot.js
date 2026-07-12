// Conditional Option Flow V1 — immutable resolved-cart snapshot builder. Pure, deterministic.
// Deep-clones + deep-freezes so later mutation of inputs (labels, template version, set order)
// cannot change a placed snapshot. Designed for cart/order persistence — NOT wired to bills in F0.

function deepClone(v) {
  if (v == null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(deepClone);
  const o = {};
  for (const k of Object.keys(v)) o[k] = deepClone(v[k]);
  return o;
}
function deepFreeze(v) {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.keys(v).forEach((k) => deepFreeze(v[k]));
    Object.freeze(v);
  }
  return v;
}

// resolveResult = output of resolveFlow(); template = { code, version }
function buildSnapshot(resolveResult, template) {
  resolveResult = resolveResult || {};
  template = template || {};
  const snap = {
    flow_template_code: String(template.code || ''),
    flow_template_version: template.version == null ? null : Number(template.version),
    at_cart: !!resolveResult.atCart,
    // stable selected choices (code + label + price at time of resolve — frozen)
    selected_choices: (resolveResult.selectedChoices || []).map((sc) => ({
      step_key: sc.step_key,
      choice_slot: sc.choice_slot,
      choice_code: sc.choice_code,
      label: (sc.item && sc.item.label) || '',
      price_add: Number((sc.item && sc.item.price_add) || 0),
    })),
    resolved_visible_steps: (resolveResult.visibleSteps || []).slice(),
    resolved_flow_path: (resolveResult.resolvedPath || []).slice(),
    resolved_effects: (resolveResult.effects || []).map((e) => ({
      target_type: e.target_type, target_ref_id: e.target_ref_id, action: e.action,
      amount: e.amount, unit: e.unit, replace_ref_id: e.replace_ref_id, target_role: e.target_role,
    })),
  };
  return deepFreeze(deepClone(snap));
}

module.exports = { buildSnapshot };
