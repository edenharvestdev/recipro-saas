-- !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
-- DO NOT RUN IN PRODUCTION
-- Local development cleanup only.
-- Production schema removal requires separate Founder Approval
-- and proof that no Delivery data exists.
-- !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!

ALTER TABLE bills DROP CONSTRAINT IF EXISTS fk_bills_delivery_batch;
ALTER TABLE bills DROP COLUMN IF EXISTS delivery_batch_id;
ALTER TABLE bills DROP COLUMN IF EXISTS delivery_mode;
ALTER TABLE bills DROP COLUMN IF EXISTS delivery_date;
ALTER TABLE bills DROP COLUMN IF EXISTS delivery_platform;
ALTER TABLE bills DROP COLUMN IF EXISTS corrected_at;
ALTER TABLE bills DROP COLUMN IF EXISTS corrected_by;
ALTER TABLE bills DROP COLUMN IF EXISTS correction_reason;
ALTER TABLE bills DROP COLUMN IF EXISTS original_bill_id;
ALTER TABLE bills DROP CONSTRAINT IF EXISTS chk_bills_delivery_mode;
ALTER TABLE bills DROP CONSTRAINT IF EXISTS chk_bills_bill_status;
ALTER TABLE bills ALTER COLUMN bill_status DROP NOT NULL;
ALTER TABLE bills ALTER COLUMN bill_status DROP DEFAULT;
ALTER TABLE bills DROP COLUMN IF EXISTS bill_status;

DROP TABLE IF EXISTS bill_audit_log;
DROP TABLE IF EXISTS delivery_settlement_legacy_bills;
DROP TABLE IF EXISTS delivery_settlement_allocation;
DROP TABLE IF EXISTS delivery_settlements;
DROP TABLE IF EXISTS delivery_batch_stock_movements;
DROP TABLE IF EXISTS delivery_sales_items;
DROP TABLE IF EXISTS delivery_sales_batches;
