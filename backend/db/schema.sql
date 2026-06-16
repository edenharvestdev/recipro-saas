-- ============================================================
-- Recipro — Database Schema (plain PostgreSQL สำหรับ Railway)
-- รันไฟล์นี้ก่อน แล้วตามด้วย schema-extend.sql และ seed.sql
-- ต่างจากเวอร์ชัน Supabase: มีตาราง users ของเราเอง + ไม่มี RLS
-- การแยกข้อมูลแต่ละร้านทำที่ "ชั้นแอป (API)" โดยกรองด้วย shop_id จาก JWT เสมอ
-- ============================================================

create extension if not exists "pgcrypto";   -- ให้ gen_random_uuid() ใช้งานได้

-- ---------- ผู้ใช้ + ตัวตน (แทน Supabase Auth) ----------
create table if not exists users (
  id            uuid primary key default gen_random_uuid(),
  email         text unique not null,
  password_hash text not null,                 -- bcrypt/argon2 เท่านั้น ห้ามเก็บ plaintext
  created_at    timestamptz default now()
);

-- ---------- ตารางหลัก ----------
create table if not exists shops (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  status      text not null default 'trial',   -- trial | active | suspended
  created_at  timestamptz default now()
);

create table if not exists memberships (
  id        uuid primary key default gen_random_uuid(),
  user_id   uuid not null references users(id) on delete cascade,
  shop_id   uuid not null references shops(id) on delete cascade,
  role      text not null default 'owner',      -- superadmin | owner | staff
  unique(user_id, shop_id)
);
create index if not exists idx_memberships_user on memberships(user_id);
create index if not exists idx_memberships_shop on memberships(shop_id);

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
  provider text default 'omise',           -- omise
  provider_customer_id text,               -- Omise customer id (cust_...)
  provider_sub_id text                     -- Omise schedule/charge อ้างอิง
);
create index if not exists idx_subscriptions_shop on subscriptions(shop_id);

create table if not exists payments (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references shops(id) on delete cascade,
  amount numeric, currency text default 'THB',
  status text, paid_at timestamptz,
  provider_invoice_id text                 -- Omise charge id (chrg_...)
  -- หมายเหตุ: ห้ามเก็บเลขบัตรที่นี่ — เก็บแค่ token/รหัสอ้างอิงจาก Omise เท่านั้น
);

-- ============================================================
-- การแยกข้อมูลแต่ละร้าน (Tenant isolation) — ทำที่ชั้น API ไม่ใช่ RLS
-- ทุก query ของ /api/* ต้องกรองด้วย shop_id ที่ได้จาก JWT + ตาราง memberships
-- ตัวอย่าง middleware (pseudo):
--   const shopId = req.shopId           // มาจาก membership ของ user ใน JWT
--   db.query('select * from materials where shop_id = $1', [shopId])
-- superadmin (memberships.role='superadmin') เท่านั้นที่ข้ามการกรองได้
-- ============================================================

-- ============================================================
-- เริ่มต้น: ตั้งผู้ใช้คนแรกเป็น superadmin
-- 1) สมัครผู้ใช้ปกติผ่านหน้าเว็บ (ได้แถวใน users)
-- 2) สร้างร้านแรก แล้วผูก membership เป็น superadmin:
-- ============================================================
-- insert into shops (name) values ('Merry Jane');
-- insert into memberships (user_id, shop_id, role)
-- values ((select id from users where email='YOU@EXAMPLE.COM'),
--         (select id from shops limit 1), 'superadmin');
