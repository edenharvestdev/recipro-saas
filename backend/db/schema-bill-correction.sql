-- Front-store bill lifecycle: DRAFT / CONFIRMED / CORRECTION_PENDING / VOIDED / REPLACED
-- (feat/bill-correction-v1). Additive + idempotent. Does NOT drop/rename/retype anything.
-- The existing POS /pos/sell + sync happy-path is untouched; this powers a NEW server-side
-- /api/bills lifecycle with STRONG stock linkage (no reliance on free-text notes).

-- ── bills: lifecycle + money-model + audit columns (reuse existing where present) ──
-- Already present from delivery-mvp: bill_status, original_bill_id, correction_reason,
-- corrected_by, corrected_at. We add a SEPARATE lifecycle_status so the existing
-- bill_status CHECK constraint is not modified.
ALTER TABLE bills
  ADD COLUMN IF NOT EXISTS lifecycle_status       TEXT,
  ADD COLUMN IF NOT EXISTS replacement_bill_id    UUID REFERENCES bills(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS voided_by              UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS voided_at              TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS actual_received_amount NUMERIC,
  ADD COLUMN IF NOT EXISTS payment_adjustment     NUMERIC DEFAULT 0,
  ADD COLUMN IF NOT EXISTS payment_method         TEXT,
  ADD COLUMN IF NOT EXISTS bill_discount          NUMERIC DEFAULT 0,
  ADD COLUMN IF NOT EXISTS gross_sales            NUMERIC,
  ADD COLUMN IF NOT EXISTS net_sales              NUMERIC,
  ADD COLUMN IF NOT EXISTS cogs_total             NUMERIC,
  ADD COLUMN IF NOT EXISTS business_date          DATE,
  ADD COLUMN IF NOT EXISTS draft_saved_at         TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS confirmed_at           TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS created_by             UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS updated_by             UUID REFERENCES users(id);

-- Constrain lifecycle_status to the supported states (nullable: legacy rows keep NULL).
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.constraint_column_usage
    WHERE table_name = 'bills' AND constraint_name = 'chk_bills_lifecycle_status'
  ) THEN
    ALTER TABLE bills ADD CONSTRAINT chk_bills_lifecycle_status
      CHECK (lifecycle_status IS NULL OR lifecycle_status IN
        ('DRAFT','CONFIRMED','CORRECTION_PENDING','VOIDED','REPLACED'));
  END IF;
END $$;

-- ── strong stock linkage for NEW confirmed bills ──
-- One row per (bill, stock_movement). movement_role distinguishes the original deduction,
-- its reversal (on void/correct), and the replacement deduction. reversal_of_link_id points
-- a REVERSAL row back to the ORIGINAL_DEDUCTION row it reverses (idempotency: a link can be
-- reversed at most once — enforced by a partial unique index below).
CREATE TABLE IF NOT EXISTS bill_stock_movements (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id             UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  bill_id             UUID NOT NULL REFERENCES bills(id) ON DELETE RESTRICT,
  bill_item_key       TEXT,
  stock_movement_id   UUID NOT NULL REFERENCES stock_movements(id) ON DELETE RESTRICT,
  movement_role       TEXT NOT NULL
                      CHECK (movement_role IN ('ORIGINAL_DEDUCTION','REVERSAL','REPLACEMENT_DEDUCTION')),
  quantity            NUMERIC,
  unit_cogs_snapshot  NUMERIC,
  reversal_of_link_id UUID REFERENCES bill_stock_movements(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (bill_id, stock_movement_id)
);

CREATE INDEX IF NOT EXISTS bsm_bill_idx ON bill_stock_movements(bill_id);
CREATE INDEX IF NOT EXISTS bsm_shop_idx ON bill_stock_movements(shop_id);
-- Idempotency guard: each ORIGINAL_DEDUCTION link may be reversed at most once.
CREATE UNIQUE INDEX IF NOT EXISTS bsm_reversal_once_idx
  ON bill_stock_movements(reversal_of_link_id)
  WHERE reversal_of_link_id IS NOT NULL;
