-- Delivery COGS model correction (feat/delivery-manual-stock-mode)
-- Additive + idempotent. Separates CHANNEL attribution from ACCOUNTING recognition.
--
--   unit_cogs_snapshot     cost per single unit at entry time
--   delivery_channel_cogs  unit_cogs_snapshot × delivery_quantity  (ALWAYS full qty; channel P&L)
--   cogs_source            delivery_deduction | mixed_pos_and_delivery | existing_pos_coverage | pending
--   cogs_already_recognized  true when this item's cost is already recognised in POS
--                            (consolidated P&L must exclude it to avoid double counting)
--
-- Consolidated (newly-recognised) COGS is derivable, NOT double counted:
--   unit_cogs_snapshot × deduction_quantity   (0 for ACCOUNTING_ONLY / HOLD)
--
-- cogs_amount (existing) now holds the FINALISED channel COGS that posts to the
-- bill: delivery_channel_cogs for FULL/REMAINDER/ACCOUNTING_ONLY, 0 for HOLD (pending).

ALTER TABLE delivery_sales_items
  ADD COLUMN IF NOT EXISTS unit_cogs_snapshot      NUMERIC,
  ADD COLUMN IF NOT EXISTS delivery_channel_cogs   NUMERIC,
  ADD COLUMN IF NOT EXISTS cogs_source             TEXT,
  ADD COLUMN IF NOT EXISTS cogs_already_recognized BOOLEAN NOT NULL DEFAULT false;

-- Backfill existing rows (all were full deductions → channel == consolidated).
UPDATE delivery_sales_items
   SET delivery_channel_cogs = cogs_amount,
       unit_cogs_snapshot = CASE WHEN quantity > 0 THEN cogs_amount / quantity ELSE 0 END,
       cogs_source = 'delivery_deduction'
 WHERE delivery_channel_cogs IS NULL;
