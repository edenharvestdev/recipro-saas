-- A2: เงินสดย่อย (petty cash) — เติมเงินก้อน, ยอดคงเหลือ = เติม − จ่ายเงินสด
create table if not exists cash_topups (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references shops(id) on delete cascade,
  topup_date date not null default current_date,
  amount numeric not null default 0,
  note text default '',
  created_at timestamptz default now()
);
create index if not exists cash_topups_shop_idx on cash_topups(shop_id);
alter table shop_settings add column if not exists use_petty_cash boolean default false;
