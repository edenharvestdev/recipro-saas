-- Payment Channel configuration layer — PC-1 (feat/payment-channels-config).
-- Design: PAYMENT_CHANNEL_DESIGN_2026-07-20.md (REV 3, Founder-approved).
--
-- INERT in PC-1: this file only creates the configuration tables + additive NULL columns.
-- Nothing reads or writes the new columns at sale time yet (binding intents/transactions to a
-- channel is PC-2; POS integration is PC-3). Additive + idempotent ONLY — CREATE TABLE
-- IF NOT EXISTS / ADD COLUMN IF NOT EXISTS; never modifies existing tables' constraints.
-- Must survive being run any number of times (Railway runs migrate.js on every boot).
--
-- REV 3 rules encoded here:
--   * is_default / sort_order live on the ASSIGNMENT table (payment_channel_shops), not the
--     channel — the same channel can be default at branch A and not at branch B.
--   * availability rule is the assignment row and nothing else: a channel is usable in shop X
--     iff a (channel_id, shop_id=X) row exists AND the channel is active AND today is within
--     the effective window. No implicit owner-shop access — the owner shop gets its assignment
--     row created explicitly (API does this on create; the legacy bridge below does it too).
--   * at most ONE default channel per shop, enforced IN THE DB by a partial unique index.

-- ── payment_channels: the channel/destination definitions (source of truth "now") ──────────
-- account_ref (full PromptPay number / bank account) is SERVER-ONLY — API responses only ever
-- carry a masked projection computed server-side. No provider secrets live here by design.
CREATE TABLE IF NOT EXISTS payment_channels (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id               uuid NOT NULL REFERENCES shops(id) ON DELETE CASCADE,  -- owner (creator) shop
  display_name          text NOT NULL,
  method                text NOT NULL CHECK (method IN ('CASH','STATIC_QR','DYNAMIC_QR','BANK_TRANSFER','CARD','OTHER')),
  provider_type         text NOT NULL CHECK (provider_type IN ('MANUAL','PROMPTPAY_STATIC','KASIKORN_KSHOP','MOCK_PROVIDER')),
  verification_mode     text NOT NULL CHECK (verification_mode IN ('MANUAL','PROVIDER_VERIFIED')),
  account_holder_name   text,
  bank_or_provider_name text,
  account_ref           text,                                   -- server-only; never serialized to clients
  account_type          text CHECK (account_type IN ('INDIVIDUAL','JURISTIC')),
  business_type         text NOT NULL CHECK (business_type IN ('PERSONAL','COMPANY','JURISTIC','PARTNER','TEMPORARY')),
  qr_image_ref          text,                                   -- bank-issued QR image ref (upload mechanism is PC-2)
  qr_version            int NOT NULL DEFAULT 1,                 -- +1 whenever account_ref or qr_image_ref changes
  is_active             boolean NOT NULL DEFAULT true,          -- soft only — no hard delete (old transactions may reference)
  effective_from        date NULL,
  effective_until       date NULL,
  source                text NOT NULL DEFAULT 'MANUAL_ADMIN',   -- 'MANUAL_ADMIN' | 'LEGACY_SETTINGS'
  created_by            uuid,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_payment_channels_shop_active ON payment_channels (shop_id, is_active);

-- ── payment_channel_shops: THE availability rule (REV 3 — one rule for the whole system) ───
CREATE TABLE IF NOT EXISTS payment_channel_shops (
  channel_id uuid NOT NULL REFERENCES payment_channels(id) ON DELETE CASCADE,
  shop_id    uuid NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  is_default boolean NOT NULL DEFAULT false,
  sort_order int NOT NULL DEFAULT 0,
  added_by   uuid,
  added_at   timestamptz DEFAULT now(),
  PRIMARY KEY (channel_id, shop_id)
);
-- at most one default channel per shop — enforced in the DB, not just the API
CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_channel_shop_default
  ON payment_channel_shops (shop_id) WHERE is_default = TRUE;
CREATE INDEX IF NOT EXISTS idx_pcs_shop ON payment_channel_shops (shop_id);

-- ── additive channel columns on the payment-platform tables (PC-1: columns only) ───────────
-- Nothing writes these yet — binding happens in PC-2. NULL = "before the channel system".
-- payment_intents pin the snapshot/qr_version at intent-creation time (REV 3: a QR change while
-- an intent is AWAITING_PAYMENT must never silently swap what the customer scanned).
ALTER TABLE payment_intents                ADD COLUMN IF NOT EXISTS channel_id uuid NULL REFERENCES payment_channels(id);
ALTER TABLE payment_intents                ADD COLUMN IF NOT EXISTS channel_qr_version int NULL;
ALTER TABLE payment_intents                ADD COLUMN IF NOT EXISTS channel_snapshot jsonb NULL;
ALTER TABLE payment_transactions           ADD COLUMN IF NOT EXISTS channel_id uuid NULL REFERENCES payment_channels(id);
ALTER TABLE payment_transactions           ADD COLUMN IF NOT EXISTS channel_snapshot jsonb NULL;
ALTER TABLE payment_allocations            ADD COLUMN IF NOT EXISTS channel_id uuid NULL REFERENCES payment_channels(id);
ALTER TABLE payment_reconciliation_records ADD COLUMN IF NOT EXISTS channel_id uuid NULL REFERENCES payment_channels(id);

-- ── Legacy bridge (design §8) — idempotent, survives any number of runs ────────────────────
-- Every shop whose shop_settings.promptpay is non-empty and that has no LEGACY_SETTINGS channel
-- yet gets one PROMPTPAY_STATIC channel mirroring the legacy setting. showQrReceive keeps
-- reading settings.pp unchanged until PC-3 — this only makes the config layer aware of it.
INSERT INTO payment_channels
  (shop_id, display_name, method, provider_type, verification_mode, account_ref, business_type, source)
SELECT ss.shop_id, 'QR พร้อมเพย์ร้าน', 'STATIC_QR', 'PROMPTPAY_STATIC', 'MANUAL',
       ss.promptpay, 'PERSONAL', 'LEGACY_SETTINGS'
  FROM shop_settings ss
 WHERE COALESCE(ss.promptpay, '') <> ''
   AND NOT EXISTS (
         SELECT 1 FROM payment_channels c
          WHERE c.shop_id = ss.shop_id AND c.source = 'LEGACY_SETTINGS'
       );

-- Owner-shop assignment row for every bridged channel (REV 3: the row IS the access — no
-- implicit owner rule). is_default = true ONLY if the shop has no default assignment yet, so
-- this never violates uq_payment_channel_shop_default no matter how often it runs.
INSERT INTO payment_channel_shops (channel_id, shop_id, is_default, sort_order)
SELECT c.id, c.shop_id,
       NOT EXISTS (
         SELECT 1 FROM payment_channel_shops d
          WHERE d.shop_id = c.shop_id AND d.is_default = TRUE
       ),
       0
  FROM payment_channels c
 WHERE c.source = 'LEGACY_SETTINGS'
   AND NOT EXISTS (
         SELECT 1 FROM payment_channel_shops pcs
          WHERE pcs.channel_id = c.id AND pcs.shop_id = c.shop_id
       );
