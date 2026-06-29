-- S12: Direct-sale product options support

-- 1. Table linking materials to option groups
CREATE TABLE IF NOT EXISTS material_option_groups (
  material_id UUID NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
  group_id UUID NOT NULL REFERENCES option_groups(id) ON DELETE CASCADE,
  sort INT DEFAULT 0,
  PRIMARY KEY (material_id, group_id)
);

-- 2. Add visibility fields to option_groups
ALTER TABLE option_groups ADD COLUMN IF NOT EXISTS visible_on_pos BOOLEAN DEFAULT TRUE;
ALTER TABLE option_groups ADD COLUMN IF NOT EXISTS visible_on_receipt BOOLEAN DEFAULT TRUE;
ALTER TABLE option_groups ADD COLUMN IF NOT EXISTS visible_on_kitchen BOOLEAN DEFAULT TRUE;
ALTER TABLE option_groups ADD COLUMN IF NOT EXISTS visible_on_online BOOLEAN DEFAULT TRUE;

-- 3. Indexes for Daily Stock Movement Report
CREATE INDEX IF NOT EXISTS sm_shop_created_idx ON stock_movements (shop_id, created_at DESC);
CREATE INDEX IF NOT EXISTS sm_ref_idx ON stock_movements (ref_type, ref_id);
