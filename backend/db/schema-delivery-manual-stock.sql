-- Delivery manual stock-mode (feat/delivery-manual-stock-mode)
-- Additive + idempotent. Owner-controlled per-item stock treatment for
-- historical backfill where POS may already have deducted some/all stock.
--
-- NOT an auto-matching engine: the Owner explicitly chooses the mode + reason.
--   DEDUCT_FULL                      deduct full delivery quantity (default)
--   DEDUCT_REMAINDER                 deduct only (delivery_qty - covered_qty)
--   ACCOUNTING_ONLY_ALREADY_DEDUCTED record revenue/COGS-side only, no stock movement
--   HOLD_FOR_REVIEW                  post no stock, keep pending
--
-- Invariant: deduction_quantity = delivery_quantity - covered_quantity,
--            0 <= deduction_quantity <= delivery_quantity.

ALTER TABLE delivery_sales_items
  ADD COLUMN IF NOT EXISTS stock_mode         TEXT NOT NULL DEFAULT 'DEDUCT_FULL',
  ADD COLUMN IF NOT EXISTS delivery_quantity  NUMERIC,
  ADD COLUMN IF NOT EXISTS covered_quantity   NUMERIC DEFAULT 0,
  ADD COLUMN IF NOT EXISTS deduction_quantity NUMERIC,
  ADD COLUMN IF NOT EXISTS coverage_reason    TEXT,
  ADD COLUMN IF NOT EXISTS source_pos_bill_no TEXT,
  ADD COLUMN IF NOT EXISTS stock_approved_by  UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS stock_approved_at  TIMESTAMPTZ;

-- Constrain to the four supported modes (idempotent add).
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.constraint_column_usage
    WHERE table_name = 'delivery_sales_items' AND constraint_name = 'chk_dsi_stock_mode'
  ) THEN
    ALTER TABLE delivery_sales_items ADD CONSTRAINT chk_dsi_stock_mode
      CHECK (stock_mode IN ('DEDUCT_FULL','DEDUCT_REMAINDER','ACCOUNTING_ONLY_ALREADY_DEDUCTED','HOLD_FOR_REVIEW'));
  END IF;
END $$;

-- Backfill existing rows: they were all full deductions.
UPDATE delivery_sales_items
   SET delivery_quantity = quantity,
       deduction_quantity = quantity,
       covered_quantity = 0
 WHERE delivery_quantity IS NULL;
