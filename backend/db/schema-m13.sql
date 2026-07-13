-- schema-m13.sql — Material Engine V2 PR-2 (additive only, idempotent, no backfill)
ALTER TABLE materials     ADD COLUMN IF NOT EXISTS behavior_type text;                               -- nullable, no CHECK
ALTER TABLE materials     ADD COLUMN IF NOT EXISTS behavior_version integer;                          -- NULL=legacy/derived, 2=V2-saved
ALTER TABLE shop_settings ADD COLUMN IF NOT EXISTS material_engine_v2_enabled boolean DEFAULT false;  -- per-shop flag, default OFF
