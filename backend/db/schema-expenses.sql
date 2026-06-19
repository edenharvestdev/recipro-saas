-- รายจ่าย/เงินสดย่อย
alter table recipes add column if not exists img_data text;

create table if not exists expenses (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references shops(id) on delete cascade,
  expense_date date not null default current_date,
  category text default '',
  description text not null default '',
  amount numeric not null default 0,
  payment_type text default 'cash',  -- 'cash' | 'transfer' | 'card' | 'other'
  note text default '',
  created_at timestamptz default now()
);
create index if not exists expenses_shop_idx on expenses(shop_id);
create index if not exists expenses_date_idx on expenses(shop_id, expense_date);
