// Per-user permission management API (Phase A1). Mounted under /api (requireAuth + tenant applied).
// All routes are tenant/shop-scoped via req.shopId. Editing permissions is owner/superadmin or a staff
// explicitly granted team_edit_permissions — and even then an actor can never grant a permission they
// do not themselves hold, edit an owner/superadmin, or elevate themselves. Every change is audited.
const express = require('express');
const { query } = require('../db');
const catalog = require('../permissions/catalog');
const { requirePerm } = require('../tenant');
const router = express.Router();

const KEYSET = new Set(catalog.ALL_KEYS);

// ── Conservative dry-run PROPOSAL (Founder-revised safety mapping) ──────────────────────────────
// IMPORTANT: this is the dry-run PROPOSAL only. It is deliberately separate from the runtime
// catalog.LEGACY_ALIASES (which is left untouched so existing enforcement/back-compat is unchanged).
// Only evidence-backed, non-broadening mappings auto-apply; everything else is flagged for Owner review.
const SAFE_MAP = {
  discount: ['pos_apply_discount'],
  void: ['void'],                    // legacy POS void — enforced by POST /api/pos/void via requirePerm('void'). NOT pos_void.
  void_bill: ['void_bill'],          // canonical confirmed-bill Void
  correct_bill: ['bill_correct'],
  stock_receive: ['stock_receive'],  // NOT stock_produce — production is assigned separately
  waste: ['stock_adjust'],
  edit_recipes: ['recipe_edit'],     // NOT recipe_create, NOT any cost permission
  delivery_entry: ['pos_open_delivery'],
  delivery_settlement: ['pos_close_day'],
};
const REVIEW_MAP = {
  edit_recipes: { keys: ['recipe_create'], reason: 'RECIPE_CREATE_REVIEW_REQUIRED — grant only if legacy explicitly allowed creating new recipes' },
  view_cost: { keys: ['recipe_view_cost', 'pos_view_cost', 'stock_view_cost', 'production_view_cost', 'report_view_cost'], reason: 'LEGACY_VIEW_COST_REVIEW_REQUIRED — do not auto-grant cost across modules the user never opened; recommend minimal reachable set' },
};
const UNMAPPED_LEGACY_NOTES = { petty_cash: 'kept legacy-compatible; proposed future granular key: petty_cash_manage (inventory endpoints first)' };
// Catalog keys with no enforced backend route — must NOT be emitted by any mapping.
const DEPRECATED_ORPHAN = [{ key: 'pos_void', note: 'no enforced route in the catalog; legacy POS void uses "void" (/api/pos/void), confirmed-bill void uses "void_bill"' }];

// Build a categorized, conservative proposal from a legacy shop-level permission object.
function buildProposal(legacy) {
  const p = legacy || {};
  const safe_auto_map = {}; const review_required = {}; const cost_review = [];
  const unmapped_legacy = []; const potential_access_gain = []; const potential_access_loss = [];
  for (const [k, v] of Object.entries(p)) {
    if (v !== true) continue;
    if (SAFE_MAP[k]) { for (const nk of SAFE_MAP[k]) safe_auto_map[nk] = true; }
    if (REVIEW_MAP[k]) {
      review_required[k] = { proposed_keys: REVIEW_MAP[k].keys, reason: REVIEW_MAP[k].reason };
      if (k === 'view_cost') cost_review.push(...REVIEW_MAP[k].keys);
      potential_access_loss.push(k + ' → held back for review: ' + REVIEW_MAP[k].keys.join(', '));
    }
    if (UNMAPPED_LEGACY_NOTES[k]) { unmapped_legacy.push({ key: k, note: UNMAPPED_LEGACY_NOTES[k] }); potential_access_loss.push(k + ' (unmapped)'); }
    if (!SAFE_MAP[k] && !REVIEW_MAP[k] && !UNMAPPED_LEGACY_NOTES[k]) { unmapped_legacy.push({ key: k, note: 'unknown legacy key — no granular mapping' }); }
  }
  return {
    safe_auto_map, review_required, cost_review: [...new Set(cost_review)],
    unmapped_legacy, deprecated_orphan: DEPRECATED_ORPHAN,
    potential_access_gain,                          // empty: safe maps are pure preservation, never broaden
    potential_access_loss: [...new Set(potential_access_loss)],
  };
}

// Effective permission map for a membership (what hasPerm would resolve to for each catalog key).
function effectiveFor(perms, role, isSuper) {
  const out = {};
  for (const k of catalog.ALL_KEYS) out[k] = catalog.hasPerm(perms, role, isSuper, k);
  return out;
}

// GET /permissions/catalog — groups + presets (for the matrix UI). Any authenticated shop member.
router.get('/permissions/catalog', (req, res) => {
  res.json({ groups: catalog.GROUPS, presets: catalog.PRESETS, preset_labels: catalog.PRESET_LABELS });
});

// GET /permissions/me — the caller's own effective permissions.
router.get('/permissions/me', (req, res) => {
  res.json({ role: req.role, is_superadmin: req.isSuperadmin === true, effective: effectiveFor(req.staffPerms, req.role, req.isSuperadmin) });
});

// GET /permissions/members — team list with stored + effective permissions (needs team_view).
router.get('/permissions/members', requirePerm('team_view'), async (req, res) => {
  try {
    const rows = (await query(
      `select m.user_id, u.email, m.role, m.permissions, m.permission_preset
         from memberships m join users u on u.id = m.user_id
        where m.shop_id = $1 order by (m.role='owner') desc, u.email`, [req.shopId]
    )).rows;
    const members = rows.map((m) => ({
      user_id: m.user_id, email: m.email, role: m.role, preset: m.permission_preset,
      permissions: m.permissions || null,
      effective: effectiveFor(m.permissions || {}, m.role, m.role === 'superadmin'),
    }));
    // What the caller is allowed to grant (their own held keys; owner/superadmin → all).
    const grantable = catalog.ALL_KEYS.filter((k) => req.hasPerm(k));
    res.json({ members, grantable_keys: grantable, can_edit: req.hasPerm('team_edit_permissions') });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /permissions/member/:userId/audit — permission change history (needs team_view_audit).
router.get('/permissions/member/:userId/audit', requirePerm('team_view_audit'), async (req, res) => {
  try {
    const rows = (await query(
      `select pal.actor_user_id, au.email as actor_email, pal.previous_permissions, pal.new_permissions,
              pal.preset, pal.reason, pal.source, pal.created_at
         from permission_audit_log pal left join users au on au.id = pal.actor_user_id
        where pal.shop_id=$1 and pal.membership_user_id=$2 order by pal.created_at desc limit 200`,
      [req.shopId, req.params.userId]
    )).rows;
    res.json({ audit: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /permissions/member/:userId — set a staff member's permissions. Full escalation protection.
router.put('/permissions/member/:userId', requirePerm('team_edit_permissions'), async (req, res) => {
  const targetId = req.params.userId;
  const body = req.body || {};
  const incoming = (body.permissions && typeof body.permissions === 'object') ? body.permissions : {};
  const preset = typeof body.preset === 'string' ? body.preset : null;
  try {
    // Self-elevation: an actor may not edit their own permissions.
    if (targetId === req.userId) return res.status(403).json({ error: 'SELF_ELEVATION_DENIED', code: 'SELF_ELEVATION_DENIED' });
    // Target must belong to THIS shop.
    const tgt = (await query('select role, permissions from memberships where user_id=$1 and shop_id=$2', [targetId, req.shopId])).rows[0];
    if (!tgt) return res.status(404).json({ error: 'SHOP_SCOPE_MISMATCH', code: 'SHOP_SCOPE_MISMATCH' });
    // Cannot edit owner/superadmin permissions via this endpoint (they bypass by role anyway).
    if (tgt.role === 'owner' || tgt.role === 'superadmin') return res.status(403).json({ error: 'ROLE_ESCALATION_DENIED', code: 'ROLE_ESCALATION_DENIED' });

    // Sanitize to known keys (booleans only) and enforce "cannot grant beyond own authority".
    const clean = {};
    for (const [k, v] of Object.entries(incoming)) {
      if (!KEYSET.has(k)) continue;                 // drop unknown keys
      const grant = v === true;
      const already = tgt.permissions && tgt.permissions[k] === true;
      if (grant && !already && !req.hasPerm(k)) {
        return res.status(403).json({ error: 'PERMISSION_GRANT_EXCEEDS_ACTOR', code: 'PERMISSION_GRANT_EXCEEDS_ACTOR', permission: k });
      }
      clean[k] = grant;
    }

    const prev = tgt.permissions || null;
    await query('update memberships set permissions=$1, permission_preset=$2 where user_id=$3 and shop_id=$4',
      [JSON.stringify(clean), preset, targetId, req.shopId]);
    await query(
      `insert into permission_audit_log (shop_id, membership_user_id, actor_user_id, previous_permissions, new_permissions, preset, reason, source)
       values ($1,$2,$3,$4,$5,$6,$7,'api')`,
      [req.shopId, targetId, req.userId, prev ? JSON.stringify(prev) : null, JSON.stringify(clean), preset, (body.reason || null)]
    );
    res.json({ ok: true, permissions: clean, effective: effectiveFor(clean, tgt.role, false) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /permissions/dry-run — legacy→granular mapping report for THIS shop. Owner/superadmin only.
// READ-ONLY: computes the proposed per-user permissions from the legacy shop-level object and reports
// what WOULD be applied. Never writes memberships.permissions (no automatic backfill).
router.get('/permissions/dry-run', async (req, res) => {
  if (!(req.role === 'owner' || req.isSuperadmin === true)) return res.status(403).json({ error: 'PERMISSION_DENIED', code: 'PERMISSION_DENIED' });
  try {
    let legacy = (await query('select staff_permissions from shop_settings where shop_id=$1', [req.shopId])).rows[0];
    legacy = legacy ? legacy.staff_permissions : {};
    if (typeof legacy === 'string') { try { legacy = JSON.parse(legacy); } catch (e) { legacy = {}; } }
    const proposal = buildProposal(legacy || {});
    const staff = (await query("select user_id, role, permissions from memberships where shop_id=$1 and role='staff'", [req.shopId])).rows;
    const roleBreakdown = (await query('select role, count(*)::int c from memberships where shop_id=$1 group by role', [req.shopId])).rows;
    const report = staff.map((m) => ({
      user_id: m.user_id, legacy_role: m.role,
      already_has_per_user: !!m.permissions,
      current_legacy_permissions: legacy || {},
      SAFE_AUTO_MAP: proposal.safe_auto_map,
      REVIEW_REQUIRED: proposal.review_required,
      COST_REVIEW: proposal.cost_review,
      UNMAPPED_LEGACY: proposal.unmapped_legacy,
      DEPRECATED_ORPHAN: proposal.deprecated_orphan,
      POTENTIAL_ACCESS_GAIN: proposal.potential_access_gain,
      POTENTIAL_ACCESS_LOSS: proposal.potential_access_loss,
      // conservative view-only proposals (granted via preset, NOT auto from legacy)
      proposed_recipe_view_only: false,
      proposed_production_view_only: false,
      proposed_printer_permissions: [],   // never auto-granted; assign explicitly per staff
    }));
    res.json({
      shop_id: req.shopId, memberships_affected: staff.length, shops_affected: 1,
      role_breakdown: roleBreakdown, legacy_permissions: legacy || {},
      proposal, dry_run: true, backfilled: false, report,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
