-- M3: ลูกค้าสั่งเองผ่าน QR (public menu + orders)
alter table shop_settings add column if not exists public_menu_token text;
alter table shop_settings add column if not exists public_menu_enabled boolean default false;
-- ออก token สั้นให้ร้านที่ยังไม่มี (idempotent)
update shop_settings set public_menu_token = substr(replace(gen_random_uuid()::text,'-',''),1,12)
  where public_menu_token is null;

create table if not exists orders (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references shops(id) on delete cascade,
  order_no text,
  customer_name text default '',
  customer_phone text default '',
  items_json jsonb,
  total numeric default 0,
  status text default 'pending',   -- pending | ready | collected | cancelled
  queue_number int,
  channel text default 'qr',
  created_at timestamptz default now()
);
create index if not exists orders_shop_idx on orders(shop_id, created_at desc);
