-- R1: atomic stock + audit log รายตัว + updated_at
alter table materials add column if not exists updated_at timestamptz default now();
alter table recipes   add column if not exists updated_at timestamptz default now();

-- ประวัติการเคลื่อนไหวสต๊อก (เก็บใน DB ใช้ร่วมกันทุกเครื่อง + audit รายตัว)
create table if not exists stock_movements (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references shops(id) on delete cascade,
  user_id uuid,
  kind text not null,                 -- adjust | receive | produce | sale | cons-out | cons-in
  ref_type text not null,             -- material | recipe
  ref_id uuid not null,
  ref_name text,
  unit text,
  qty_before numeric,
  qty_after numeric,
  delta numeric,
  note text,
  created_at timestamptz default now()
);
create index if not exists sm_shop_idx on stock_movements(shop_id, created_at desc);
create index if not exists sm_ref_idx on stock_movements(ref_id);
