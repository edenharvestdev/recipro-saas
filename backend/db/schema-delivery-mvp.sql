-- Delivery Operations MVP — Release A
-- Idempotent: safe to run multiple times. All ADD COLUMN / ADD CONSTRAINT use IF NOT EXISTS.
-- Safe bill_status migration: nullable first → backfill → NOT NULL.
-- ROLLBACK: see schema-delivery-mvp-rollback-DEV-ONLY.sql (DO NOT run in production).

-- ─────────────────────────────────────────────────────────────────────────
-- A. Bills: status model extension (safe, non-destructive)
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE bills
  ADD COLUMN IF NOT EXISTS bill_status TEXT;

-- Backfill only rows not yet set (idempotent on reruns)
UPDATE bills
SET bill_status =
  CASE
    WHEN status = 'voided'         THEN 'voided'
    WHEN status IN ('paid','ship') THEN 'confirmed'
    ELSE                                'draft'
  END
WHERE bill_status IS NULL;

ALTER TABLE bills
  ALTER COLUMN bill_status SET DEFAULT 'draft';

ALTER TABLE bills
  ALTER COLUMN bill_status SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'bills' AND constraint_name = 'chk_bills_bill_status'
  ) THEN
    ALTER TABLE bills ADD CONSTRAINT chk_bills_bill_status
      CHECK (bill_status IN ('draft','confirmed','receipt_issued',
                             'corrected','voided','settled','locked'));
  END IF;
END $$;

ALTER TABLE bills
  ADD COLUMN IF NOT EXISTS original_bill_id UUID REFERENCES bills(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS correction_reason TEXT,
  ADD COLUMN IF NOT EXISTS corrected_by UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS corrected_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS delivery_platform TEXT,
  ADD COLUMN IF NOT EXISTS delivery_date DATE,
  ADD COLUMN IF NOT EXISTS delivery_mode TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'bills' AND constraint_name = 'chk_bills_delivery_mode'
  ) THEN
    ALTER TABLE bills ADD CONSTRAINT chk_bills_delivery_mode
      CHECK (delivery_mode IN ('stock_aware','financial_only'));
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- B. Delivery Sales Batches
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS delivery_sales_batches (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id              UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  platform             TEXT NOT NULL,
  sales_date_from      DATE NOT NULL,
  sales_date_to        DATE NOT NULL,
  gross_sales          NUMERIC DEFAULT 0,
  order_count          INT DEFAULT 0,
  item_count           INT DEFAULT 0,
  mode                 TEXT NOT NULL DEFAULT 'stock_aware'
                       CHECK (mode IN ('stock_aware','financial_only')),
  status               TEXT NOT NULL DEFAULT 'draft'
                       CHECK (status IN ('draft','confirmed','settled','locked','voided')),
  source_type          TEXT NOT NULL DEFAULT 'manual'
                       CHECK (source_type IN ('manual')),
  stock_deducted       BOOLEAN NOT NULL DEFAULT false,
  -- Gross mismatch approval
  variance_amount      NUMERIC,
  variance_reason      TEXT
                       CHECK (variance_reason IN (
                         'platform_level_discount','rounding',
                         'missing_item_detail','legacy_aggregate_entry'
                       )),
  variance_note        TEXT,
  variance_approved_by UUID REFERENCES users(id),
  -- Idempotency key for client-side dedup (optional; unique per shop)
  client_request_id    TEXT,
  -- Replacement reference: links a replacement draft back to the voided batch it replaces
  replacement_of_batch_id UUID REFERENCES delivery_sales_batches(id) ON DELETE SET NULL,
  -- Internal idempotency keys
  stock_operation_ref  TEXT UNIQUE,   -- 'batch:{id}:confirm' — set atomically, blocks double-confirm
  reversal_ref         TEXT,          -- 'batch:{id}:void'
  version              INT NOT NULL DEFAULT 1,
  confirmed_at         TIMESTAMPTZ,
  confirmed_by         UUID REFERENCES users(id),
  created_by           UUID REFERENCES users(id),
  created_at           TIMESTAMPTZ DEFAULT now(),
  updated_at           TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS dsb_shop_date_idx
  ON delivery_sales_batches(shop_id, sales_date_from DESC);
CREATE INDEX IF NOT EXISTS dsb_status_idx
  ON delivery_sales_batches(shop_id, status);

-- Additive: add columns if table was created before this migration revision (idempotent on reruns)
ALTER TABLE delivery_sales_batches
  ADD COLUMN IF NOT EXISTS client_request_id TEXT,
  ADD COLUMN IF NOT EXISTS replacement_of_batch_id UUID REFERENCES delivery_sales_batches(id) ON DELETE SET NULL;

-- Idempotency key index: one client_request_id per shop (NULL excluded — multiple batches same date allowed)
CREATE UNIQUE INDEX IF NOT EXISTS dsb_idempotency_key
  ON delivery_sales_batches(shop_id, client_request_id)
  WHERE client_request_id IS NOT NULL;

-- Item-based sales fields (Founder UX redesign — Release A revision)
-- batch_item_gross/net = derived from item lines; gross_sales = platform-reported reconciliation field
ALTER TABLE delivery_sales_batches
  ADD COLUMN IF NOT EXISTS batch_item_gross NUMERIC DEFAULT 0,
  ADD COLUMN IF NOT EXISTS batch_item_net   NUMERIC DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cogs_total       NUMERIC DEFAULT 0,
  ADD COLUMN IF NOT EXISTS gross_profit     NUMERIC DEFAULT 0,
  ADD COLUMN IF NOT EXISTS financial_only_reason TEXT,
  ADD COLUMN IF NOT EXISTS financial_only_note   TEXT;

-- ─────────────────────────────────────────────────────────────────────────
-- C. Delivery Sales Items
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS delivery_sales_items (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id        UUID NOT NULL
                  REFERENCES delivery_sales_batches(id) ON DELETE CASCADE,
  shop_id         UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  menu_type       TEXT NOT NULL CHECK (menu_type IN ('recipe','material')),
  recipe_id       UUID REFERENCES recipes(id) ON DELETE SET NULL,
  material_id     UUID REFERENCES materials(id) ON DELETE SET NULL,
  menu_code       TEXT,
  menu_name       TEXT NOT NULL,
  quantity        NUMERIC NOT NULL CHECK (quantity > 0),
  unit_price      NUMERIC DEFAULT 0,
  gross_amount    NUMERIC DEFAULT 0,
  discount_amount NUMERIC DEFAULT 0,
  net_item_amount NUMERIC GENERATED ALWAYS AS (gross_amount - discount_amount) STORED,
  chosen_options  JSONB DEFAULT '[]',
  stock_impact    JSONB DEFAULT '[]',
  refund_flag     BOOLEAN DEFAULT false,
  created_at      TIMESTAMPTZ DEFAULT now(),
  -- Exactly one menu reference (correction 4)
  CONSTRAINT chk_dsi_menu_ref CHECK (
    (menu_type = 'recipe'   AND recipe_id   IS NOT NULL AND material_id IS NULL)
    OR
    (menu_type = 'material' AND material_id IS NOT NULL AND recipe_id   IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS dsi_batch_idx ON delivery_sales_items(batch_id);
CREATE INDEX IF NOT EXISTS dsi_shop_idx  ON delivery_sales_items(shop_id);

-- COGS per item (populated at confirm time)
ALTER TABLE delivery_sales_items
  ADD COLUMN IF NOT EXISTS cogs_amount NUMERIC DEFAULT 0;

-- ─────────────────────────────────────────────────────────────────────────
-- D. Structured Stock Movement Links (correction 1)
-- Movements are located via this table, not via note pattern matching.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS delivery_batch_stock_movements (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id          UUID NOT NULL
                    REFERENCES delivery_sales_batches(id) ON DELETE RESTRICT,
  stock_movement_id UUID NOT NULL
                    REFERENCES stock_movements(id) ON DELETE RESTRICT,
  operation_type    TEXT NOT NULL CHECK (operation_type IN ('deduct','reverse')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (batch_id, stock_movement_id)
);

CREATE INDEX IF NOT EXISTS dbsm_batch_idx
  ON delivery_batch_stock_movements(batch_id);
CREATE INDEX IF NOT EXISTS dbsm_movement_idx
  ON delivery_batch_stock_movements(stock_movement_id);

-- ─────────────────────────────────────────────────────────────────────────
-- E. Delivery Settlements
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS delivery_settlements (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id                 UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  platform                TEXT NOT NULL,
  settlement_date         DATE,

  -- Gross Revenue
  gross_sales             NUMERIC NOT NULL DEFAULT 0,

  -- Platform Expenses (correction 3: separated from WHT)
  commission_rate         NUMERIC DEFAULT 0,
  commission_amount       NUMERIC DEFAULT 0,
  promotion_fee           NUMERIC DEFAULT 0,
  advertising_fee         NUMERIC DEFAULT 0,
  vat_on_fee              NUMERIC DEFAULT 0,
  refund_amount           NUMERIC DEFAULT 0,
  other_deduction         NUMERIC DEFAULT 0,
  other_adjustment        NUMERIC DEFAULT 0,

  -- Discount funding (correction 4)
  discount_funding_source TEXT NOT NULL DEFAULT 'merchant'
                          CHECK (discount_funding_source IN ('merchant','platform','shared')),
  merchant_discount_amount NUMERIC DEFAULT 0,
  platform_discount_amount NUMERIC DEFAULT 0,

  -- Tax withheld (correction 3: NOT a platform expense)
  withholding_tax         NUMERIC DEFAULT 0,

  -- Computed: merchant_net (Layer 1: gross - platform expenses, no WHT)
  merchant_net            NUMERIC GENERATED ALWAYS AS (
    gross_sales
    - commission_amount
    - merchant_discount_amount
    - promotion_fee
    - advertising_fee
    - vat_on_fee
    - refund_amount
    - other_deduction
    + other_adjustment
  ) STORED,

  -- Computed: expected_bank_cash (Layer 2: merchant_net - WHT)
  expected_bank_cash      NUMERIC GENERATED ALWAYS AS (
    gross_sales
    - commission_amount
    - merchant_discount_amount
    - promotion_fee
    - advertising_fee
    - vat_on_fee
    - refund_amount
    - other_deduction
    + other_adjustment
    - withholding_tax
  ) STORED,

  -- Computed: variance (Layer 3)
  variance                NUMERIC GENERATED ALWAYS AS (
    actual_bank_deposit - (
      gross_sales
      - commission_amount
      - merchant_discount_amount
      - promotion_fee
      - advertising_fee
      - vat_on_fee
      - refund_amount
      - other_deduction
      + other_adjustment
      - withholding_tax
    )
  ) STORED,

  actual_bank_deposit     NUMERIC DEFAULT 0,
  bank_account            TEXT,
  settlement_reference    TEXT,
  note                    TEXT,
  status                  TEXT NOT NULL DEFAULT 'draft'
                          CHECK (status IN ('draft','confirmed','locked')),
  confirmed_by            UUID REFERENCES users(id),
  confirmed_at            TIMESTAMPTZ,
  created_by              UUID REFERENCES users(id),
  created_at              TIMESTAMPTZ DEFAULT now(),
  updated_at              TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ds_shop_platform_idx
  ON delivery_settlements(shop_id, platform);
CREATE INDEX IF NOT EXISTS ds_shop_date_idx
  ON delivery_settlements(shop_id, settlement_date DESC);

-- ─────────────────────────────────────────────────────────────────────────
-- F. Settlement ↔ Batch Allocation
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS delivery_settlement_allocation (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  settlement_id   UUID NOT NULL
                  REFERENCES delivery_settlements(id) ON DELETE CASCADE,
  batch_id        UUID NOT NULL
                  REFERENCES delivery_sales_batches(id) ON DELETE RESTRICT,
  allocated_gross NUMERIC NOT NULL DEFAULT 0,
  allocated_fee   NUMERIC NOT NULL DEFAULT 0,
  allocated_net   NUMERIC NOT NULL DEFAULT 0,
  note            TEXT,
  created_at      TIMESTAMPTZ DEFAULT now(),
  UNIQUE (settlement_id, batch_id)
);

CREATE INDEX IF NOT EXISTS dsa_settlement_idx
  ON delivery_settlement_allocation(settlement_id);
CREATE INDEX IF NOT EXISTS dsa_batch_idx
  ON delivery_settlement_allocation(batch_id);

-- ─────────────────────────────────────────────────────────────────────────
-- G. Settlement ↔ Legacy Bills (HB05 linking — correction 2)
-- Uses bill UUID (bills.id), displays bills.number for UI.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS delivery_settlement_legacy_bills (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  settlement_id   UUID NOT NULL
                  REFERENCES delivery_settlements(id) ON DELETE CASCADE,
  bill_id         UUID NOT NULL
                  REFERENCES bills(id) ON DELETE RESTRICT,
  allocated_gross NUMERIC NOT NULL DEFAULT 0,
  allocated_net   NUMERIC NOT NULL DEFAULT 0,
  note            TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (settlement_id, bill_id)
);

CREATE INDEX IF NOT EXISTS dslb_settlement_idx
  ON delivery_settlement_legacy_bills(settlement_id);
CREATE INDEX IF NOT EXISTS dslb_bill_idx
  ON delivery_settlement_legacy_bills(bill_id);

-- ─────────────────────────────────────────────────────────────────────────
-- H. Bill Audit Log (correction 5: ON DELETE RESTRICT to preserve history)
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bill_audit_log (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id     UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  bill_id     UUID NOT NULL REFERENCES bills(id) ON DELETE RESTRICT,
  action      TEXT NOT NULL
              CHECK (action IN ('created','confirmed','voided','corrected',
                                'settled','locked','receipt_issued')),
  actor_id    UUID REFERENCES users(id),
  actor_name  TEXT,
  reason      TEXT,
  snapshot    JSONB,
  created_at  TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS bal_bill_idx
  ON bill_audit_log(bill_id, created_at DESC);
CREATE INDEX IF NOT EXISTS bal_shop_idx
  ON bill_audit_log(shop_id, created_at DESC);

-- ─────────────────────────────────────────────────────────────────────────
-- FK: bills → delivery_sales_batches (added after batch table exists)
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE bills
  ADD COLUMN IF NOT EXISTS delivery_batch_id UUID;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'bills' AND constraint_name = 'fk_bills_delivery_batch'
  ) THEN
    ALTER TABLE bills ADD CONSTRAINT fk_bills_delivery_batch
      FOREIGN KEY (delivery_batch_id)
      REFERENCES delivery_sales_batches(id) ON DELETE SET NULL;
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- REVISION: Daily Bill Model (Founder Workflow Correction)
-- หนึ่งสาขา + หนึ่ง Platform + หนึ่งวัน = บิล Delivery ค้างหนึ่งใบ
-- ─────────────────────────────────────────────────────────────────────────

-- Expand status constraint to include daily-bill statuses
DO $$
BEGIN
  BEGIN
    ALTER TABLE delivery_sales_batches DROP CONSTRAINT delivery_sales_batches_status_check;
  EXCEPTION WHEN undefined_object THEN NULL;
  END;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name='delivery_sales_batches' AND constraint_name='chk_dsb_status_v2'
  ) THEN
    ALTER TABLE delivery_sales_batches ADD CONSTRAINT chk_dsb_status_v2
      CHECK (status IN (
        'open','pending_review','awaiting_settlement','discrepancy','reconciled',
        'draft','confirmed','settled','locked','voided'
      ));
  END IF;
END $$;

-- Canonical sales_date (used for daily-bill uniqueness index)
ALTER TABLE delivery_sales_batches
  ADD COLUMN IF NOT EXISTS sales_date DATE;
UPDATE delivery_sales_batches
  SET sales_date = sales_date_from::date
  WHERE sales_date IS NULL;

-- ONE active bill per shop + platform + date
-- Active = open/pending_review/awaiting_settlement/discrepancy
CREATE UNIQUE INDEX IF NOT EXISTS dsb_active_daily_bill
  ON delivery_sales_batches(shop_id, platform, sales_date)
  WHERE status IN ('open','pending_review','awaiting_settlement','discrepancy');

-- Settlement fields stored inline on the bill (next-day reconciliation)
ALTER TABLE delivery_sales_batches
  ADD COLUMN IF NOT EXISTS commission_amount        NUMERIC DEFAULT 0,
  ADD COLUMN IF NOT EXISTS promotion_fee            NUMERIC DEFAULT 0,
  ADD COLUMN IF NOT EXISTS advertising_fee          NUMERIC DEFAULT 0,
  ADD COLUMN IF NOT EXISTS vat_on_fee               NUMERIC DEFAULT 0,
  ADD COLUMN IF NOT EXISTS refund_amount            NUMERIC DEFAULT 0,
  ADD COLUMN IF NOT EXISTS withholding_tax          NUMERIC DEFAULT 0,
  ADD COLUMN IF NOT EXISTS merchant_discount_amount NUMERIC DEFAULT 0,
  ADD COLUMN IF NOT EXISTS platform_discount_amount NUMERIC DEFAULT 0,
  ADD COLUMN IF NOT EXISTS other_deduction          NUMERIC DEFAULT 0,
  ADD COLUMN IF NOT EXISTS other_adjustment         NUMERIC DEFAULT 0,
  ADD COLUMN IF NOT EXISTS actual_bank_deposit      NUMERIC,
  ADD COLUMN IF NOT EXISTS bank_account             TEXT,
  ADD COLUMN IF NOT EXISTS settlement_reference     TEXT,
  ADD COLUMN IF NOT EXISTS settlement_date          DATE,
  ADD COLUMN IF NOT EXISTS settlement_note          TEXT,
  ADD COLUMN IF NOT EXISTS merchant_net             NUMERIC,
  ADD COLUMN IF NOT EXISTS expected_bank_cash       NUMERIC,
  ADD COLUMN IF NOT EXISTS settlement_variance      NUMERIC,
  ADD COLUMN IF NOT EXISTS closed_at               TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS closed_by               UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS settled_at              TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS settled_by              UUID REFERENCES users(id);

-- Item: platform order_no for dedup + staff attribution
ALTER TABLE delivery_sales_items
  ADD COLUMN IF NOT EXISTS order_no         TEXT,
  ADD COLUMN IF NOT EXISTS staff_added_by   UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS staff_added_name TEXT;

-- Prevent duplicate order_no within same bill
CREATE UNIQUE INDEX IF NOT EXISTS dsi_order_no_unique
  ON delivery_sales_items(batch_id, order_no)
  WHERE order_no IS NOT NULL;

-- Link movements to specific items (for per-item reversal)
ALTER TABLE delivery_batch_stock_movements
  ADD COLUMN IF NOT EXISTS item_id UUID REFERENCES delivery_sales_items(id) ON DELETE SET NULL;

-- Audit trail: track which deduct records have been reversed and by which reverse record
-- Never delete movement relation rows — mark reversed_at instead
ALTER TABLE delivery_batch_stock_movements
  ADD COLUMN IF NOT EXISTS reversed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reversal_of UUID REFERENCES delivery_batch_stock_movements(id);

CREATE INDEX IF NOT EXISTS dbsm_reversal_of_idx
  ON delivery_batch_stock_movements(reversal_of) WHERE reversal_of IS NOT NULL;

-- Platform gross comparison fields (settlement review)
ALTER TABLE delivery_sales_batches
  ADD COLUMN IF NOT EXISTS platform_gross          NUMERIC DEFAULT 0,
  ADD COLUMN IF NOT EXISTS platform_gross_variance NUMERIC,
  ADD COLUMN IF NOT EXISTS platform_gross_reason   TEXT;
