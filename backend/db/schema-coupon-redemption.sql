-- feat/coupon-free-item-redemption — external free-item coupon redemption with REAL stock + COGS.
-- Additive + idempotent (CREATE ... IF NOT EXISTS). Does NOT drop/rename/retype anything.
--
-- A free-item coupon is NOT a generic 100% manual discount: Gross keeps the normal menu price,
-- Coupon Discount = the eligible free amount, Net may be 0, stock deducts normally, and COGS stays
-- REAL (campaign/partner-funded cost). Redemptions link to a specific bill item so the free item is
-- always traceable to a confirmed sale.

-- ── coupons: controlled local table (used when the external provider API is not yet wired) ──
-- source='LOCAL_IMPORT' rows are validated server-side exactly like external ones. EXTERNAL-provider
-- coupons are validated live by the provider adapter and may be cached here for reporting.
CREATE TABLE IF NOT EXISTS coupons (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id            UUID REFERENCES shops(id) ON DELETE CASCADE,      -- NULL = valid for any shop/branch
  code               TEXT NOT NULL,
  campaign_id        TEXT,
  member_id          TEXT,                                            -- nullable member binding
  eligible_recipe_id UUID REFERENCES recipes(id) ON DELETE SET NULL,  -- specific menu, or …
  eligible_category  TEXT,                                            -- … a whole category (NULL both = any)
  benefit_type       TEXT NOT NULL DEFAULT 'FREE_ITEM'
                     CHECK (benefit_type IN ('FREE_ITEM','AMOUNT','PERCENT')),
  benefit_value      NUMERIC DEFAULT 0,                               -- AMOUNT/PERCENT only; FREE_ITEM uses the menu price
  usage_limit        INTEGER NOT NULL DEFAULT 1,                      -- one-time by default
  per_member_limit   INTEGER,
  funding_source     TEXT NOT NULL DEFAULT 'CAMPAIGN_FUNDED'
                     CHECK (funding_source IN ('STORE_FUNDED','CAMPAIGN_FUNDED','PARTNER_FUNDED','SHARED')),
  source             TEXT NOT NULL DEFAULT 'LOCAL_IMPORT'
                     CHECK (source IN ('LOCAL_IMPORT','EXTERNAL')),
  external_reference TEXT,
  starts_at          TIMESTAMPTZ,
  expires_at         TIMESTAMPTZ,
  active             BOOLEAN NOT NULL DEFAULT true,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- A code is unique per (source, shop) — a global code (shop_id NULL) is unique per source as well.
CREATE UNIQUE INDEX IF NOT EXISTS coupons_source_code_shop_idx
  ON coupons (source, code, COALESCE(shop_id, '00000000-0000-0000-0000-000000000000'::uuid));
CREATE INDEX IF NOT EXISTS coupons_code_idx ON coupons (code);

-- ── coupon_redemptions: one row per redeemed free item, linked to a bill item ──
CREATE TABLE IF NOT EXISTS coupon_redemptions (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id                UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  branch_id              UUID REFERENCES shops(id) ON DELETE SET NULL,   -- branch == shop in this model; kept explicit
  coupon_id              UUID REFERENCES coupons(id) ON DELETE SET NULL, -- NULL for pure-external (not cached)
  external_coupon_code   TEXT NOT NULL,
  external_campaign_id   TEXT,
  external_member_id     TEXT,
  external_reference     TEXT,
  bill_id                UUID REFERENCES bills(id) ON DELETE SET NULL,
  bill_item_key          TEXT,                                          -- stable bill-item key
  eligible_recipe_id     UUID REFERENCES recipes(id) ON DELETE SET NULL,
  eligible_category      TEXT,
  normal_unit_price      NUMERIC NOT NULL DEFAULT 0,                     -- Gross keeps this
  coupon_discount_amount NUMERIC NOT NULL DEFAULT 0,                     -- eligible free amount
  net_amount             NUMERIC NOT NULL DEFAULT 0,                     -- may be 0
  unit_cogs_snapshot     NUMERIC NOT NULL DEFAULT 0,                     -- real, non-zero
  total_cogs             NUMERIC NOT NULL DEFAULT 0,
  funding_source         TEXT NOT NULL DEFAULT 'CAMPAIGN_FUNDED'
                         CHECK (funding_source IN ('STORE_FUNDED','CAMPAIGN_FUNDED','PARTNER_FUNDED','SHARED')),
  redemption_status      TEXT NOT NULL DEFAULT 'PENDING'
                         CHECK (redemption_status IN ('PENDING','VALIDATED','REDEEMED','VOIDED_REVIEW','REINSTATED','EXPIRED','REJECTED')),
  idempotency_key        TEXT,
  redeemed_at            TIMESTAMPTZ,
  redeemed_by            UUID REFERENCES users(id),
  voided_at              TIMESTAMPTZ,
  voided_by              UUID REFERENCES users(id),
  reinstated_at          TIMESTAMPTZ,
  reinstated_by          UUID REFERENCES users(id),
  reinstate_reason       TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS coupon_redemptions_shop_idx     ON coupon_redemptions (shop_id);
CREATE INDEX IF NOT EXISTS coupon_redemptions_bill_idx     ON coupon_redemptions (bill_id);
CREATE INDEX IF NOT EXISTS coupon_redemptions_campaign_idx ON coupon_redemptions (external_campaign_id);
CREATE INDEX IF NOT EXISTS coupon_redemptions_code_idx     ON coupon_redemptions (external_coupon_code);

-- Idempotent confirmation: a given idempotency_key maps to exactly one redemption row (retry-safe).
CREATE UNIQUE INDEX IF NOT EXISTS coupon_redemptions_idem_idx
  ON coupon_redemptions (idempotency_key) WHERE idempotency_key IS NOT NULL;

-- One-time use: a code can hold at most ONE active/consumed redemption per shop. REJECTED/EXPIRED
-- (failed validation, or a released Draft reservation) do NOT lock the code, so a legitimately
-- unused code can be re-issued; a VOIDED_REVIEW code stays locked (not silently reusable).
CREATE UNIQUE INDEX IF NOT EXISTS coupon_redemptions_onetime_idx
  ON coupon_redemptions (shop_id, external_coupon_code)
  WHERE redemption_status IN ('PENDING','VALIDATED','REDEEMED','VOIDED_REVIEW','REINSTATED');
