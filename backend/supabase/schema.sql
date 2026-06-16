-- ============================================================
-- Recipro SaaS — Database Schema + Row Level Security (RLS)
-- รันไฟล์นี้ใน Supabase: Dashboard > SQL Editor > วางทั้งหมด > Run
-- ============================================================

-- ---------- ตารางหลัก ----------
create table if not exists shops (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  status      text not null default 'trial',   -- trial | active | suspended
  created_at  timestamptz default now()
);

create table if not exists memberships (
  id        uuid primary key default gen_random_uuid(),
  user_id   uuid not null references auth.users(id) on delete cascade,
  shop_id   uuid not null references shops(id) on delete cascade,
  role      text not null default 'owner',      -- superadmin | owner | staff
  unique(user_id, shop_id)
);

create table if not exists shop_settings (
  shop_id   uuid primary key references shops(id) on delete cascade,
  phone     text, tax_id text, address text,
  bank text, account text, holder text, promptpay text,
  logo_url  text, theme text default 'rose'
);

create table if not exists suppliers (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references shops(id) on delete cascade,
  name text not null, note text
);

create table if not exists materials (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references shops(id) on delete cascade,
  name text not null, qty numeric, unit text, price numeric,
  supplier_id uuid references suppliers(id) on delete set null,
  order_url text, stock numeric default 0, low_stock numeric default 0
);

create table if not exists recipes (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references shops(id) on delete cascade,
  code text, name text not null, sell_price numeric,
  batch_yield numeric default 1, yield_unit text default 'ชิ้น',
  is_raw boolean default false, steps text,
  fg_stock numeric default 0, fg_low numeric default 0
);

create table if not exists recipe_items (
  id uuid primary key default gen_random_uuid(),
  recipe_id uuid not null references recipes(id) on delete cascade,
  material_id uuid references materials(id) on delete set null,
  amount numeric
);

create table if not exists bills (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references shops(id) on delete cascade,
  number text, doc_type text, items_json jsonb,
  discount numeric default 0, tax numeric default 0,
  status text default 'wait', stock_deducted boolean default false,
  created_at timestamptz default now()
);

-- ---------- ตารางสมาชิก/จ่ายเงิน ----------
create table if not exists plans (
  id uuid primary key default gen_random_uuid(),
  name text not null, price_month numeric, price_year numeric,
  features_json jsonb, active boolean default true
);

create table if not exists subscriptions (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references shops(id) on delete cascade,
  plan_id uuid references plans(id),
  status text default 'trialing',         -- trialing | active | past_due | canceled | suspended
  billing_cycle text,                      -- month | year
  current_period_end timestamptz,
  cancel_at timestamptz,
  provider text,                           -- stripe | omise
  provider_customer_id text,
  provider_sub_id text
);

create table if not exists payments (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references shops(id) on delete cascade,
  amount numeric, currency text default 'THB',
  status text, paid_at timestamptz,
  provider_invoice_id text
  -- หมายเหตุ: ห้ามเก็บเลขบัตรที่นี่ — เก็บแค่ token/รหัสอ้างอิงจาก Stripe/Omise เท่านั้น
);

-- ============================================================
-- ฟังก์ชันช่วยเช็คสิทธิ์
-- ============================================================
create or replace function public.is_member(_shop uuid)
returns boolean language sql security definer stable as $$
  select exists(select 1 from memberships m
                where m.shop_id = _shop and m.user_id = auth.uid());
$$;

create or replace function public.is_superadmin()
returns boolean language sql security definer stable as $$
  select exists(select 1 from memberships m
                where m.user_id = auth.uid() and m.role = 'superadmin');
$$;

-- ============================================================
-- เปิด RLS ทุกตาราง
-- ============================================================
alter table shops          enable row level security;
alter table memberships    enable row level security;
alter table shop_settings  enable row level security;
alter table suppliers      enable row level security;
alter table materials      enable row level security;
alter table recipes        enable row level security;
alter table recipe_items   enable row level security;
alter table bills          enable row level security;
alter table plans          enable row level security;
alter table subscriptions  enable row level security;
alter table payments       enable row level security;

-- ---------- shops: สมาชิกเห็นร้านตัวเอง / superadmin เห็นทุกร้าน ----------
create policy shops_read on shops for select
  using ( is_member(id) or is_superadmin() );
create policy shops_admin_write on shops for all
  using ( is_superadmin() ) with check ( is_superadmin() );

-- ---------- memberships: เห็นของตัวเอง / superadmin จัดการได้ ----------
create policy memb_read on memberships for select
  using ( user_id = auth.uid() or is_superadmin() );
create policy memb_admin_write on memberships for all
  using ( is_superadmin() ) with check ( is_superadmin() );

-- ---------- ตารางข้อมูลร้าน: สมาชิกร้านนั้นหรือ superadmin ----------
-- ทำซ้ำรูปแบบเดียวกันให้ทุกตารางที่มี shop_id
create policy settings_rw on shop_settings for all
  using ( is_member(shop_id) or is_superadmin() )
  with check ( is_member(shop_id) or is_superadmin() );

create policy suppliers_rw on suppliers for all
  using ( is_member(shop_id) or is_superadmin() )
  with check ( is_member(shop_id) or is_superadmin() );

create policy materials_rw on materials for all
  using ( is_member(shop_id) or is_superadmin() )
  with check ( is_member(shop_id) or is_superadmin() );

create policy recipes_rw on recipes for all
  using ( is_member(shop_id) or is_superadmin() )
  with check ( is_member(shop_id) or is_superadmin() );

create policy bills_rw on bills for all
  using ( is_member(shop_id) or is_superadmin() )
  with check ( is_member(shop_id) or is_superadmin() );

create policy subs_rw on subscriptions for all
  using ( is_member(shop_id) or is_superadmin() )
  with check ( is_member(shop_id) or is_superadmin() );

create policy payments_read on payments for select
  using ( is_member(shop_id) or is_superadmin() );

-- recipe_items: เช็คผ่าน recipe -> shop
create policy recipe_items_rw on recipe_items for all
  using ( exists(select 1 from recipes r
                 where r.id = recipe_id and (is_member(r.shop_id) or is_superadmin())) )
  with check ( exists(select 1 from recipes r
                 where r.id = recipe_id and (is_member(r.shop_id) or is_superadmin())) );

-- plans: ทุกคนอ่านได้ (โชว์แพ็กเกจ) / superadmin แก้ได้
create policy plans_read on plans for select using ( true );
create policy plans_admin_write on plans for all
  using ( is_superadmin() ) with check ( is_superadmin() );

-- ============================================================
-- เริ่มต้น: ตั้งผู้ใช้คนแรกเป็น superadmin (แทน YOUR-USER-ID)
-- หา id ได้จาก Supabase > Authentication > Users
-- ============================================================
-- insert into memberships (user_id, shop_id, role)
-- values ('YOUR-USER-ID', (select id from shops limit 1), 'superadmin');
