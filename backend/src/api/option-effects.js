// Option Stock Effect Engine V1 — management API (Phase C). Mounted under /api (requireAuth + tenant).
// Configures option_stock_effects. Does NOT change live sale deduction (engine gated by
// OPTION_STOCK_ENGINE_V1). Writes require recipe_edit; reads recipe_view; cost preview obeys canViewCost.
const express = require('express');
const { query, tx } = require('../db');
const { requirePerm } = require('../tenant');
const { resolveEffectiveBom } = require('../option-engine/effective-bom');
const { targetTypeTable, searchTargets, validateTarget, hasRecipeCycle, TARGET_MAP } = require('../option-engine/target-resolver');
const router = express.Router();

const ACTIONS = ['ADD', 'REMOVE', 'REPLACE', 'MULTIPLY', 'NO_STOCK'];
const TARGET_TYPES = Object.keys(TARGET_MAP);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const err = (res, code, status) => res.status(status || 400).json({ error: code, code });

// Load a choice + its owning group + parent recipes, enforcing shop scope. Returns null if not this shop.
async function loadChoice(shopId, choiceId) {
  const ch = (await query(
    `select oc.id, og.id group_id, og.shop_id from option_choices oc join option_groups og on og.id=oc.group_id
      where oc.id=$1`, [choiceId])).rows[0];
  if (!ch || ch.shop_id !== shopId) return null;
  const recs = (await query('select recipe_id from recipe_option_groups where group_id=$1', [ch.group_id])).rows.map(r => r.recipe_id);
  return { ...ch, parentRecipeIds: recs };
}

// Validate an effect payload against shop + type + action rules. Returns { ok } or { ok:false, code }.
async function validateEffect(c, shopId, body, choice) {
  const action = String(body.action || '');
  const tt = String(body.target_type || '');
  if (!ACTIONS.includes(action)) return { ok: false, code: 'INVALID_ACTION' };
  if (!TARGET_TYPES.includes(tt)) return { ok: false, code: 'INVALID_TARGET_TYPE' };
  if (action === 'NO_STOCK' || tt === 'NO_STOCK') {
    if (!(action === 'NO_STOCK' && tt === 'NO_STOCK')) return { ok: false, code: 'NO_STOCK_MISMATCH' };
    return { ok: true };
  }
  const amount = Number(body.amount);
  if (['ADD', 'REPLACE', 'MULTIPLY'].includes(action) && !(amount > 0)) return { ok: false, code: 'AMOUNT_MUST_BE_POSITIVE' };
  // resolve which id must exist for this action
  const ref = body.target_ref_id || null;
  const role = body.target_role || null;
  if (action === 'REPLACE') {
    if (!ref) return { ok: false, code: 'REPLACE_WITH_REQUIRED' };
    if (!body.replace_ref_id && !role) return { ok: false, code: 'REPLACE_FROM_REQUIRED' };
    if (body.replace_ref_id) { const vf = await validateTarget(c, shopId, tt, body.replace_ref_id); if (!vf.ok) return vf; }
    const vt = await validateTarget(c, shopId, tt, ref); if (!vt.ok) return vt;
  } else {
    if (!ref && !role) return { ok: false, code: 'TARGET_REQUIRED' };
    if (ref) { const v = await validateTarget(c, shopId, tt, ref); if (!v.ok) return v; }
  }
  // circular recipe guard for recipe-typed targets
  if (['PRODUCED_ITEM', 'FINISHED_GOOD', 'RECIPE_COMPONENT'].includes(tt) && ref) {
    const cyc = await hasRecipeCycle(c, shopId, ref, choice.parentRecipeIds);
    if (cyc) return { ok: false, code: 'CIRCULAR_RECIPE' };
  }
  return { ok: true };
}

// GET /option-effects/target-types — the documented target_type → table mapping.
router.get('/option-effects/target-types', requirePerm('recipe_view'), (req, res) => res.json({ target_types: targetTypeTable() }));

// GET /option-effects/targets/search?q=&target_type=&limit= — shop-scoped combobox search.
router.get('/option-effects/targets/search', requirePerm('recipe_view'), async (req, res) => {
  try {
    const results = await tx(async (c) => searchTargets(c, req.shopId, { q: req.query.q, target_type: req.query.target_type, limit: req.query.limit }));
    res.json({ results });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /option-effects?choice_id= — list effects for a choice (with resolved target names).
router.get('/option-effects', requirePerm('recipe_view'), async (req, res) => {
  const choiceId = req.query.choice_id;
  if (!UUID_RE.test(choiceId || '')) return err(res, 'invalid choice_id');
  try {
    const choice = await loadChoice(req.shopId, choiceId);
    if (!choice) return err(res, 'CHOICE_NOT_FOUND', 404);
    const rows = (await query(
      `select id, choice_id, seq, target_type, target_ref_id, action, amount, unit, replace_ref_id, target_role, enabled, strict_stock, note
         from option_stock_effects where choice_id=$1 and shop_id=$2 order by seq, created_at`, [choiceId, req.shopId])).rows;
    res.json({ effects: await withNames(req.shopId, rows) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// resolve display names for a set of effect rows (for list/preview)
async function withNames(shopId, rows) {
  const out = [];
  for (const r of rows) {
    let target_name = null, target_code = null, replace_name = null;
    const m = TARGET_MAP[r.target_type];
    if (m && m.table && r.target_ref_id) {
      const t = (await query(`select ${m.name} as name, ${m.code} as code from ${m.table} where id=$1 and shop_id=$2`, [r.target_ref_id, shopId])).rows[0];
      if (t) { target_name = t.name; target_code = t.code || null; }
    }
    if (m && m.table && r.replace_ref_id) {
      const t = (await query(`select ${m.name} as name from ${m.table} where id=$1 and shop_id=$2`, [r.replace_ref_id, shopId])).rows[0];
      if (t) replace_name = t.name;
    }
    out.push({ ...r, target_name, target_code, replace_name });
  }
  return out;
}

// POST /option-effects — create one effect.
router.post('/option-effects', requirePerm('recipe_edit'), async (req, res) => {
  const b = req.body || {};
  if (!UUID_RE.test(b.choice_id || '')) return err(res, 'invalid choice_id');
  try {
    const out = await tx(async (c) => {
      const choice = await loadChoice(req.shopId, b.choice_id);
      if (!choice) { const e = new Error('CHOICE_NOT_FOUND'); e.statusCode = 404; throw e; }
      const v = await validateEffect(c, req.shopId, b, choice);
      if (!v.ok) { const e = new Error(v.code); e.statusCode = 400; throw e; }
      const seq = b.seq != null ? Number(b.seq) : (await c.query('select coalesce(max(seq),-1)+1 n from option_stock_effects where choice_id=$1', [b.choice_id])).rows[0].n;
      return (await c.query(
        `insert into option_stock_effects (choice_id, shop_id, seq, target_type, target_ref_id, action, amount, unit, replace_ref_id, target_role, strict_stock, note)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning *`,
        [b.choice_id, req.shopId, seq, b.target_type, b.target_ref_id || null, b.action,
         Number(b.amount) || 0, b.unit || null, b.replace_ref_id || null, b.target_role || null, !!b.strict_stock, b.note || null])).rows[0];
    });
    res.status(201).json({ effect: out });
  } catch (e) { res.status(e.statusCode || 500).json({ error: e.message, code: e.message }); }
});

// PATCH /option-effects/:id — update one effect.
router.patch('/option-effects/:id', requirePerm('recipe_edit'), async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return err(res, 'invalid id');
  const b = req.body || {};
  try {
    const out = await tx(async (c) => {
      const cur = (await c.query('select * from option_stock_effects where id=$1 and shop_id=$2', [req.params.id, req.shopId])).rows[0];
      if (!cur) { const e = new Error('EFFECT_NOT_FOUND'); e.statusCode = 404; throw e; }
      const choice = await loadChoice(req.shopId, cur.choice_id);
      if (!choice) { const e = new Error('CHOICE_NOT_FOUND'); e.statusCode = 404; throw e; }
      const merged = { ...cur, ...b, target_type: b.target_type || cur.target_type, action: b.action || cur.action };
      const v = await validateEffect(c, req.shopId, merged, choice);
      if (!v.ok) { const e = new Error(v.code); e.statusCode = 400; throw e; }
      return (await c.query(
        `update option_stock_effects set target_type=$1, target_ref_id=$2, action=$3, amount=$4, unit=$5,
           replace_ref_id=$6, target_role=$7, strict_stock=$8, note=$9, enabled=$10, updated_at=now()
         where id=$11 and shop_id=$12 returning *`,
        [merged.target_type, merged.target_ref_id || null, merged.action, Number(merged.amount) || 0, merged.unit || null,
         merged.replace_ref_id || null, merged.target_role || null, !!merged.strict_stock, merged.note || null,
         merged.enabled === false ? false : true, req.params.id, req.shopId])).rows[0];
    });
    res.json({ effect: out });
  } catch (e) { res.status(e.statusCode || 500).json({ error: e.message, code: e.message }); }
});

// PATCH /option-effects/:id/disable — soft-disable (never hard-delete history).
router.patch('/option-effects/:id/disable', requirePerm('recipe_edit'), async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return err(res, 'invalid id');
  try {
    const r = (await query('update option_stock_effects set enabled=false, updated_at=now() where id=$1 and shop_id=$2 returning id', [req.params.id, req.shopId])).rows[0];
    if (!r) return err(res, 'EFFECT_NOT_FOUND', 404);
    res.json({ ok: true, id: r.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /option-effects/reorder — deterministic seq reorder for a choice.
router.post('/option-effects/reorder', requirePerm('recipe_edit'), async (req, res) => {
  const { choice_id, order } = req.body || {};
  if (!UUID_RE.test(choice_id || '') || !Array.isArray(order)) return err(res, 'choice_id + order[] required');
  try {
    const out = await tx(async (c) => {
      const choice = await loadChoice(req.shopId, choice_id);
      if (!choice) { const e = new Error('CHOICE_NOT_FOUND'); e.statusCode = 404; throw e; }
      let seq = 0;
      for (const id of order) {
        if (!UUID_RE.test(id)) continue;
        await c.query('update option_stock_effects set seq=$1, updated_at=now() where id=$2 and choice_id=$3 and shop_id=$4', [seq++, id, choice_id, req.shopId]);
      }
      return (await c.query('select id, seq from option_stock_effects where choice_id=$1 and shop_id=$2 order by seq', [choice_id, req.shopId])).rows;
    });
    res.json({ order: out });
  } catch (e) { res.status(e.statusCode || 500).json({ error: e.message, code: e.message }); }
});

// GET /option-effects/preview?choice_id= — effect list + net effective impact for ONE selection.
router.get('/option-effects/preview', requirePerm('recipe_view'), async (req, res) => {
  const choiceId = req.query.choice_id;
  if (!UUID_RE.test(choiceId || '')) return err(res, 'invalid choice_id');
  try {
    const choice = await loadChoice(req.shopId, choiceId);
    if (!choice) return err(res, 'CHOICE_NOT_FOUND', 404);
    const rows = (await query(
      `select * from option_stock_effects where choice_id=$1 and shop_id=$2 and enabled=true order by seq, created_at`, [choiceId, req.shopId])).rows;
    const named = await withNames(req.shopId, rows);
    // net add/replace impact (base empty → REMOVE/REPLACE-from will just warn; ADD/REPLACE-to show)
    const effects = rows.map(r => ({ target_type: r.target_type, ref_id: r.target_ref_id, action: r.action, amount: Number(r.amount) || 0, unit: r.unit, replace_ref_id: r.replace_ref_id, role: r.target_role, source: 'choice' }));
    const resolved = resolveEffectiveBom({ base: [], effects });
    res.json({
      engine_enabled: process.env.OPTION_STOCK_ENGINE_V1 === '1',
      effects: named.map(e => ({ action: e.action, target_type: e.target_type, target_name: e.target_name, target_code: e.target_code, replace_name: e.replace_name, amount: Number(e.amount) || 0, unit: e.unit, enabled: e.enabled })),
      net_lines: resolved.lines, warnings: resolved.warnings,
      note: rows.length === 0 ? 'OPTION_HAS_NO_STOCK_EFFECT' : null,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
