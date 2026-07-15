-- Workstream B: Compact Option Template Blocks — additive, idempotent.
-- Adds an authoring-level "template block" classification on top of the existing
-- engine-driving columns (effect_type/target_material_id/amount/links/variant_recipe_id/
-- is_metadata_only — all unchanged, see backend/src/stockEngine.js). block_type is a
-- UI/authoring hint only; nullable = legacy choice authored before this feature existed.
alter table option_choices add column if not exists block_type text;      -- INSTRUCTION_ONLY|ADD_ONE_INGREDIENT|REPLACE_ONE_INGREDIENT|CHANGE_ONE_QUANTITY|RECIPE_VARIANT
alter table option_choices add column if not exists kitchen_note text;    -- optional kitchen instruction per choice

-- Group-level compact config: customer/kitchen labels, channel visibility, effective window.
alter table option_groups add column if not exists label_customer text;  -- customer-facing label (fallback = label)
alter table option_groups add column if not exists label_kitchen text;   -- kitchen-facing label (fallback = label)
alter table option_groups add column if not exists channel_pos boolean default true;
alter table option_groups add column if not exists channel_qr boolean default true;
alter table option_groups add column if not exists channel_delivery boolean default true;
alter table option_groups add column if not exists start_at timestamptz; -- effective window (null = always)
alter table option_groups add column if not exists end_at timestamptz;
