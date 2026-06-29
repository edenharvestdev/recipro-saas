-- S11: Per-Recipe Inventory Mode + Strong Void Idempotency — additive only
-- ไม่แตะ column เดิม · DEFAULT 'inherit' = ทุก recipe เดิมไม่เปลี่ยนพฤติกรรม

-- 1. inventory_mode ต่อ recipe: inherit | make_to_order | finished_goods | non_stock
ALTER TABLE recipes
  ADD COLUMN IF NOT EXISTS inventory_mode TEXT
  NOT NULL DEFAULT 'inherit'
  CHECK (inventory_mode IN ('inherit','make_to_order','finished_goods','non_stock'));

COMMENT ON COLUMN recipes.inventory_mode IS
  'inherit=ตามร้าน, make_to_order=ตัดวัตถุดิบ, finished_goods=ตัด fg_stock, non_stock=ไม่ตัด';

-- 2. reversal_of: FK ชี้ sale movement ที่ถูก reverse — unique ต่อ 1 movement = void ได้ครั้งเดียว
ALTER TABLE stock_movements
  ADD COLUMN IF NOT EXISTS reversal_of UUID REFERENCES stock_movements(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uidx_sm_reversal
  ON stock_movements(shop_id, reversal_of)
  WHERE reversal_of IS NOT NULL;
