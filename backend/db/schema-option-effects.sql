-- Option Stock Effect Engine V1 — ADDITIVE + idempotent. No destructive DDL. Existing option_choices /
-- option_choice_links / recipe_items are UNCHANGED (the legacy single-effect path keeps working).
-- This adds a multi-effect table: one Option Choice may declare ZERO, ONE, or MANY stock effects.
--
-- Live wiring is OFF by default (feature flag OPTION_STOCK_ENGINE_V1). This table can exist with no
-- rows and no behavior change until the engine is enabled and Founder-approved.

CREATE TABLE IF NOT EXISTS option_stock_effects (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  choice_id        UUID NOT NULL REFERENCES option_choices(id) ON DELETE CASCADE,
  shop_id          UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,  -- denormalised for same-shop checks
  seq              INTEGER NOT NULL DEFAULT 0,                            -- stable ordering within a choice
  target_type      TEXT NOT NULL
                   CHECK (target_type IN ('MATERIAL','PRODUCED_ITEM','FINISHED_GOOD','RECIPE_COMPONENT','PACKAGING','NO_STOCK')),
  target_ref_id    UUID,                                                 -- material/recipe id (null for NO_STOCK)
  action           TEXT NOT NULL
                   CHECK (action IN ('ADD','REMOVE','REPLACE','MULTIPLY','NO_STOCK')),
  amount           NUMERIC NOT NULL DEFAULT 0,                           -- qty for ADD/REPLACE, factor for MULTIPLY
  unit             TEXT,
  replace_ref_id   UUID,                                                 -- for REPLACE: the base target removed
  target_role      TEXT,                                                 -- optional role-based targeting (legacy bridge)
  enabled          BOOLEAN NOT NULL DEFAULT true,                        -- soft-disable (never hard-delete history)
  strict_stock     BOOLEAN NOT NULL DEFAULT false,                       -- block sale if this target is short (future)
  note             TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- NO_STOCK actions carry no target; every other action needs one (ref or role).
  CONSTRAINT chk_ose_target CHECK (
    action = 'NO_STOCK'
    OR target_ref_id IS NOT NULL
    OR target_role IS NOT NULL
    OR replace_ref_id IS NOT NULL
  )
);
-- Additive columns (idempotent whether the table is new or already exists from an earlier run).
ALTER TABLE option_stock_effects ADD COLUMN IF NOT EXISTS enabled      BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE option_stock_effects ADD COLUMN IF NOT EXISTS strict_stock BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS ose_choice_idx ON option_stock_effects (choice_id, seq);
CREATE INDEX IF NOT EXISTS ose_shop_idx   ON option_stock_effects (shop_id);
