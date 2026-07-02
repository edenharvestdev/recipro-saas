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

// Expand a legacy shop-level permission object into proposed granular per-user permissions (dry-run).
function mapLegacyToNew(legacy) {
  const p = legacy || {};
  const proposed = {}; const added = []; const unmapped = []; const risky = [];
  const RISKY = new Set(['recipe_edit', 'recipe_edit_cost', 'void_bill', 'bill_correct', 'team_edit_permissions', 'store_settings_edit', 'system_admin', 'production_reverse', 'production_void', 'printer_delete']);
  for (const [k, v] of Object.entries(p)) {
    if (v !== true) continue;
    if (catalog.LEGACY_ALIASES[k]) {
      for (const nk of catalog.LEGACY_ALIASES[k]) { proposed[nk] = true; added.push(nk); if (RISKY.has(nk)) risky.push(nk); }
    } else if (KEYSET.has(k)) {
      proposed[k] = true; added.push(k); if (RISKY.has(k)) risky.push(k);
    } else {
      unmapped.push(k);   // e.g. petty_cash — no granular equivalent yet
    }
  }
  return { proposed, added: [...new Set(added)], unmapped: [...new Set(unmapped)], risky: [...new Set(risky)] };
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
    const mapping = mapLegacyToNew(legacy || {});
    const staff = (await query("select user_id, role, permissions from memberships where shop_id=$1 and role='staff'", [req.shopId])).rows;
    const report = staff.map((m) => ({
      user_id: m.user_id, legacy_role: m.role,
      already_has_per_user: !!m.permissions,
      current_legacy_permissions: legacy || {},
      proposed_permissions: mapping.proposed,
      permissions_added: mapping.added,
      unmapped_legacy_keys: mapping.unmapped,
      risky_broad_access: mapping.risky,
    }));
    res.json({
      shop_id: req.shopId, memberships_affected: staff.length, shops_affected: 1,
      legacy_permissions: legacy || {}, mapping, dry_run: true, backfilled: false, report,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
