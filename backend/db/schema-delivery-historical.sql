-- Delivery historical-entry safety patch (feat/delivery-historical-entry)
-- Additive + idempotent. Safe to run multiple times.
--
-- Purpose: when staff backfill PAST delivery sales, the stock movement must
-- record the historical business date (= bill sales_date) and the entry reason,
-- while stock_movements.created_at stays the ACTUAL entry timestamp.

-- business_date  = the historical sales date the movement economically belongs to
-- entry_reason   = 'same_day' | 'historical_backfill'
-- negative_reason= owner-supplied justification when the entry drove stock below zero
ALTER TABLE delivery_batch_stock_movements
  ADD COLUMN IF NOT EXISTS business_date   DATE,
  ADD COLUMN IF NOT EXISTS entry_reason    TEXT,
  ADD COLUMN IF NOT EXISTS negative_reason TEXT;

-- Backfill existing rows: business_date from their batch sales_date, reason same_day.
UPDATE delivery_batch_stock_movements dbsm
   SET business_date = b.sales_date
  FROM delivery_sales_batches b
 WHERE dbsm.batch_id = b.id
   AND dbsm.business_date IS NULL
   AND b.sales_date IS NOT NULL;

UPDATE delivery_batch_stock_movements
   SET entry_reason = 'same_day'
 WHERE entry_reason IS NULL;

CREATE INDEX IF NOT EXISTS dbsm_business_date_idx
  ON delivery_batch_stock_movements(business_date);
