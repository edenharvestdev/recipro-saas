// Option Stock Effect Engine V1 — pure, deterministic Effective-BOM resolver.
// No DB, no I/O: given a base BOM (per one menu unit) + a flat list of stock effects from selected
// options / toppings / packaging, produce ONE deterministic Effective BOM — the immutable
// "resolved-effect snapshot" to be stored on the sale/bill line and used for atomic deduction.
//
// An Option Choice may declare ZERO, ONE, or MANY stock effects. Each effect:
//   { target_type, ref_id, action, amount, unit?, replace_ref_id?, role?, source? }
// target_type ∈ MATERIAL | PRODUCED_ITEM | FINISHED_GOOD | RECIPE_COMPONENT | PACKAGING | NO_STOCK
// action      ∈ ADD | REMOVE | REPLACE | MULTIPLY | NO_STOCK
//
// Determinism: effects apply in a fixed order (NO_STOCK → REMOVE → REPLACE → MULTIPLY → ADD), ties
// broken by (target_type, ref_id, source). Same inputs ⇒ byte-identical output.

const TARGET_TYPES = ['MATERIAL', 'PRODUCED_ITEM', 'FINISHED_GOOD', 'RECIPE_COMPONENT', 'PACKAGING', 'NO_STOCK'];
const ACTIONS = ['ADD', 'REMOVE', 'REPLACE', 'MULTIPLY', 'NO_STOCK'];
const ACTION_RANK = { NO_STOCK: 0, REMOVE: 1, REPLACE: 2, MULTIPLY: 3, ADD: 4 };

const key = (t, id) => String(t) + '::' + String(id);
const num = (n) => (Number.isFinite(Number(n)) ? Number(n) : 0);
const round6 = (n) => Math.round(num(n) * 1e6) / 1e6;

function resolveEffectiveBom(input) {
  const base = (input && Array.isArray(input.base)) ? input.base : [];
  const effects = (input && Array.isArray(input.effects)) ? input.effects : [];
  const trace = [];
  const warnings = [];
  const map = new Map();          // key -> { target_type, ref_id, qty, unit, sources:Set }
  const roleIndex = new Map();    // role -> { target_type, ref_id }

  const put = (t, id, qty, unit, source) => {
    if (t === 'NO_STOCK' || !id) return;
    const k = key(t, id);
    const e = map.get(k) || { target_type: t, ref_id: id, qty: 0, unit: unit || null, sources: new Set() };
    e.qty += num(qty);
    if (unit && !e.unit) e.unit = unit;
    if (source) e.sources.add(source);
    map.set(k, e);
  };

  for (const b of base) {
    put(b.target_type, b.ref_id, b.qty, b.unit, b.source || 'base');
    if (b.role) roleIndex.set(b.role, { target_type: b.target_type, ref_id: b.ref_id });
  }

  const resolveTarget = (t, id, role) => {
    if (id) return { target_type: t, ref_id: id };
    if (role && roleIndex.has(role)) return roleIndex.get(role);
    return null;
  };

  const ordered = effects.slice().sort((a, b) =>
    ((ACTION_RANK[a.action] ?? 99) - (ACTION_RANK[b.action] ?? 99)) ||
    String(a.target_type).localeCompare(String(b.target_type)) ||
    String(a.ref_id).localeCompare(String(b.ref_id)) ||
    String(a.source || '').localeCompare(String(b.source || '')));

  for (const ef of ordered) {
    const act = ef.action;
    if (act === 'NO_STOCK') { trace.push({ action: 'NO_STOCK', source: ef.source || null }); continue; }
    if (act === 'REMOVE') {
      const tgt = resolveTarget(ef.target_type, ef.ref_id, ef.role);
      if (!tgt) { warnings.push({ action: 'REMOVE', reason: 'target_not_found', source: ef.source || null }); continue; }
      const existed = map.delete(key(tgt.target_type, tgt.ref_id));
      if (ef.role) roleIndex.delete(ef.role);
      if (existed) trace.push({ action: 'REMOVE', ...tgt, source: ef.source || null });
      else warnings.push({ action: 'REMOVE', reason: 'target_not_in_bom', ...tgt, source: ef.source || null });
      continue;
    }
    if (act === 'REPLACE') {
      const oldT = resolveTarget(ef.target_type, ef.replace_ref_id, ef.role);
      if (oldT) map.delete(key(oldT.target_type, oldT.ref_id));
      put(ef.target_type, ef.ref_id, ef.amount, ef.unit, ef.source);
      if (ef.role && ef.ref_id) roleIndex.set(ef.role, { target_type: ef.target_type, ref_id: ef.ref_id });
      trace.push({ action: 'REPLACE', from: oldT || null, to: { target_type: ef.target_type, ref_id: ef.ref_id }, amount: num(ef.amount), source: ef.source || null });
      continue;
    }
    if (act === 'MULTIPLY') {
      const tgt = resolveTarget(ef.target_type, ef.ref_id, ef.role);
      const e = tgt && map.get(key(tgt.target_type, tgt.ref_id));
      if (e) { e.qty *= num(ef.amount); trace.push({ action: 'MULTIPLY', ...tgt, factor: num(ef.amount), source: ef.source || null }); }
      else warnings.push({ action: 'MULTIPLY', reason: 'target_not_found', source: ef.source || null });
      continue;
    }
    if (act === 'ADD') {
      if (ef.target_type === 'NO_STOCK' || !ef.ref_id) { warnings.push({ action: 'ADD', reason: 'no_target', source: ef.source || null }); continue; }
      put(ef.target_type, ef.ref_id, ef.amount, ef.unit, ef.source);
      trace.push({ action: 'ADD', target_type: ef.target_type, ref_id: ef.ref_id, amount: num(ef.amount), source: ef.source || null });
      continue;
    }
    warnings.push({ action: 'UNKNOWN', value: act, source: ef.source || null });
  }

  const lines = [...map.values()]
    .filter((e) => e.qty > 0)
    .map((e) => ({ target_type: e.target_type, ref_id: e.ref_id, qty: round6(e.qty), unit: e.unit || null, sources: [...e.sources].sort() }))
    .sort((a, b) => String(a.target_type).localeCompare(b.target_type) || String(a.ref_id).localeCompare(b.ref_id));

  return { lines, trace, warnings };
}

// Scale a resolved per-unit snapshot by the number of menu units sold (for deduction).
function scaleSnapshot(snapshot, lineQty) {
  const q = num(lineQty) || 1;
  return (snapshot && Array.isArray(snapshot.lines) ? snapshot.lines : []).map((l) => ({ ...l, qty: round6(l.qty * q) }));
}

module.exports = { resolveEffectiveBom, scaleSnapshot, TARGET_TYPES, ACTIONS };
