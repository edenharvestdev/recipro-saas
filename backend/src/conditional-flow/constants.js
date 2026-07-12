// Conditional Option Flow V1 — shared constants + stable-code helpers. Pure, no deps.

// Navigation rule types (NO stock semantics here).
const RULE_TYPES = ['SHOW_IF', 'HIDE_IF', 'SKIP_TO', 'END_AT_CART', 'REQUIRE_IF', 'OPTIONAL_IF'];

// Condition operators over a prior step's selected choice_code(s).
const OPERATORS = ['EQUALS', 'NOT_EQUALS', 'IN', 'NOT_IN', 'ANY', 'NONE'];

// Stock vocab — IDENTICAL to PR#21 option_stock_effects. Do NOT invent a second vocabulary.
const TARGET_TYPES = ['MATERIAL', 'PRODUCED_ITEM', 'FINISHED_GOOD', 'RECIPE_COMPONENT', 'PACKAGING', 'NO_STOCK'];
const ACTIONS = ['ADD', 'REMOVE', 'REPLACE', 'MULTIPLY', 'NO_STOCK'];

// Feature flag — default OFF. F0 never turns this on; it only gates future integration (F2+).
function isConditionalFlowEnabled(env) {
  const e = env || (typeof process !== 'undefined' ? process.env : {}) || {};
  return e.CONDITIONAL_FLOW_V1 === 'true' || e.CONDITIONAL_FLOW_V1 === '1';
}

// Stable code format: A–Z, 0–9, underscore; must start with a letter; not empty. Uppercase.
const CODE_RE = /^[A-Z][A-Z0-9_]*$/;
function isValidCode(code) {
  return typeof code === 'string' && code.length > 0 && code.length <= 64 && CODE_RE.test(code);
}
// Normalize a proposed code to the canonical stable form (does not guarantee validity).
function normalizeCode(raw) {
  return String(raw == null ? '' : raw).trim().toUpperCase().replace(/[\s-]+/g, '_').replace(/[^A-Z0-9_]/g, '');
}

module.exports = {
  RULE_TYPES, OPERATORS, TARGET_TYPES, ACTIONS,
  isConditionalFlowEnabled, isValidCode, normalizeCode,
};
