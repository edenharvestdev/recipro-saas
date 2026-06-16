-- ============================================================
-- Recipro — ส่วนขยาย: ออกบิลมาตรฐาน + POS + ฉลาก/จัดส่ง (เฟส J–L)
-- รันต่อจาก schema.sql (plain PostgreSQL — แยกข้อมูลร้านที่ชั้น API ด้วย shop_id)
-- ============================================================

-- เลขรันเอกสารต่อเนื่อง กันซ้ำ (ต่อร้าน/ต่อปี/ต่อชนิดเอกสาร)
-- ออกเลขแบบ atomic ในทรานแซกชัน:
--   update doc_counters set last_no = last_no + 1
--   where shop_id=$1 and year=$2 and doc_kind=$3 returning last_no;
create table if not exists doc_counters (
  shop_id uuid references shops(id) on delete cascade,
  year int, doc_kind text, last_no int default 0,
  primary key (shop_id, year, doc_kind)
);

-- เพิ่มฟิลด์เอกสารภาษี/การชำระให้ bills
alter table bills add column if not exists doc_kind text;        -- receipt | tax_full | tax_abbrev | pos
alter table bills add column if not exists buyer_name text;
alter table bills add column if not exists buyer_taxid text;     -- เลขผู้เสียภาษี 13 หลัก
alter table bills add column if not exists buyer_address text;
alter table bills add column if not exists vat_rate numeric default 0;
alter table bills add column if not exists vat_amount numeric default 0;
alter table bills add column if not exists wht_amount numeric default 0;  -- หัก ณ ที่จ่าย
alter table bills add column if not exists sub_total numeric default 0;
alter table bills add column if not exists grand_total numeric default 0;
alter table bills add column if not exists payment_method text;  -- cash | promptpay | card | transfer
alter table bills add column if not exists paid_amount numeric;
alter table bills add column if not exists change_amount numeric;

-- POS: รอบขาย/กะ แคชเชียร์
create table if not exists pos_sessions (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references shops(id) on delete cascade,
  cashier_id uuid references users(id),
  opened_at timestamptz default now(), closed_at timestamptz,
  opening_cash numeric default 0, closing_cash numeric, total_sales numeric default 0
);
create index if not exists idx_pos_sessions_shop on pos_sessions(shop_id);

-- ฉลาก / จัดส่งพัสดุ
create table if not exists shipments (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references shops(id) on delete cascade,
  bill_id uuid references bills(id) on delete set null,
  recipient_name text, recipient_phone text, recipient_address text,
  courier text,            -- thailandpost | flash | kerry | jt | ...
  tracking_no text, cod_amount numeric default 0,
  label_size text, status text default 'new', created_at timestamptz default now()
);
create index if not exists idx_shipments_shop on shipments(shop_id);

create table if not exists label_templates (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references shops(id) on delete cascade,
  kind text,               -- product | address
  size text,               -- 40x30 | 50x30 | 100x150 (mm)
  layout_json jsonb
);
create index if not exists idx_label_templates_shop on label_templates(shop_id);

-- หมายเหตุ: ไม่มี RLS — ทุก endpoint ต้องกรองด้วย shop_id จาก JWT ที่ชั้น API
