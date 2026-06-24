-- M6 (เฟส A): ระบบสมาชิกลูกค้า — สะสมแต้ม/จำนวนครั้ง/ยอดสะสม (ผูกตามเบอร์โทร)
create table if not exists customers (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references shops(id) on delete cascade,
  phone text default '',
  name text default '',
  points numeric default 0,
  visits int default 0,
  total_spent numeric default 0,
  note text default '',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index if not exists customers_shop_idx on customers(shop_id);
create unique index if not exists customers_shop_phone_idx on customers(shop_id, phone) where phone <> '';
