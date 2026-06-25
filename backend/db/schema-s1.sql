-- S1: สำรองข้อมูลอัตโนมัติในแอป (per-shop snapshot) + กู้คืนเอง
-- เก็บภาพข้อมูลทั้งร้านเป็น jsonb เป็นช่วงๆ — กันข้อมูลหาย/ถูกทับ กู้คืนเองได้โดยไม่ต้องเรียก dev
-- additive ล้วน: ตารางใหม่ ไม่แตะตารางเดิม
create table if not exists shop_snapshots (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references shops(id) on delete cascade,
  created_at timestamptz default now(),
  kind text default 'auto',          -- auto | manual | pre_restore
  label text default '',
  counts jsonb default '{}'::jsonb,   -- สรุปจำนวนแถวแต่ละชนิด (โชว์ในรายการโดยไม่ต้องโหลด data ก้อนใหญ่)
  data jsonb not null                 -- ภาพข้อมูลทั้งร้าน (materials/recipes/recipe_items/option_*/settings ฯลฯ)
);
create index if not exists shop_snapshots_shop_idx on shop_snapshots(shop_id, created_at desc);
