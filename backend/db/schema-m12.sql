-- M12: promotions table (A2)
create table if not exists promotions (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references shops(id) on delete cascade,
  name text not null,
  type text not null default 'pct',        -- 'pct' | 'fixed' | 'bogo' | 'code'
  value numeric not null default 0,        -- % หรือ ฿
  code text default null,                  -- promo code (optional)
  min_order numeric default 0,             -- ยอดสั่งขั้นต่ำ
  applies_to text default 'all',           -- 'all' | 'category'
  applies_category text default null,
  active boolean default true,
  start_date date default null,
  end_date date default null,
  created_at timestamptz default now()
);
create index if not exists promotions_shop_idx on promotions(shop_id);
