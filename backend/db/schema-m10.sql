-- M10: ลิ้นชักเงินสด / กะเงิน (cash drawer / till session)
-- เปิดกะ (เงินทอนตั้งต้น) → เติม/เบิกระหว่างกะ → ปิดกะ (นับเงินจริง เทียบยอดที่ควรมี = ขาด/เกิน)
create table if not exists cash_sessions (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references shops(id) on delete cascade,
  biz_date date,
  opening_float numeric default 0,
  cash_in numeric default 0,
  cash_out numeric default 0,
  expected_sales numeric default 0,   -- ยอดขายเงินสดที่คำนวณได้ตอนปิด
  counted numeric default 0,          -- เงินที่นับได้จริง
  status text default 'open',         -- open | closed
  note text default '',
  opened_at timestamptz default now(),
  closed_at timestamptz,
  updated_at timestamptz default now()
);
create index if not exists cash_sessions_shop_idx on cash_sessions(shop_id, opened_at desc);
