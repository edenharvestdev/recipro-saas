-- A1: รายจ่ายประจำ (เทมเพลตยอดเดิม — โพสต์เข้า expenses รายเดือน แก้ตัวเลขได้)
create table if not exists recurring_expenses (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references shops(id) on delete cascade,
  name text not null default '',
  category text default '',
  default_amount numeric not null default 0,
  day_of_month int default 1,
  active boolean default true,
  created_at timestamptz default now()
);
create index if not exists rcr_shop_idx on recurring_expenses(shop_id);
