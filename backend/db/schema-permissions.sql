-- Granular per-user permissions (feat/granular-permissions-p1, Phase A1). Additive + idempotent.
-- Does NOT drop/rename legacy fields, does NOT backfill, does NOT broaden access. Resolution order at
-- runtime: memberships.permissions (per-user) → shop_settings.staff_permissions (legacy shop-level) →
-- conservative defaults. Owner/superadmin bypass unchanged.

ALTER TABLE memberships
  ADD COLUMN IF NOT EXISTS permissions       JSONB,   -- per-user explicit permission map (NULL = fall back to legacy)
  ADD COLUMN IF NOT EXISTS permission_preset TEXT;    -- UI metadata only ('front_store' | 'manager' | ...); authority is in `permissions`

-- Every permission change is audited (who changed whose permissions, before/after, why).
CREATE TABLE IF NOT EXISTS permission_audit_log (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id              UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  membership_user_id   UUID,          -- target user whose permissions changed
  actor_user_id        UUID,          -- who made the change
  previous_permissions JSONB,
  new_permissions      JSONB,
  preset               TEXT,
  reason               TEXT,
  source               TEXT,          -- 'ui' | 'api' | 'preset' | 'migration_dry_run' (never a real backfill)
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS permission_audit_shop_idx   ON permission_audit_log (shop_id);
CREATE INDEX IF NOT EXISTS permission_audit_target_idx ON permission_audit_log (shop_id, membership_user_id);
