-- S5: QR Box (จอลูกค้า) — สถานะที่แคชเชียร์ push แล้วจอลูกค้า poll มาแสดง (1 แถวต่อร้าน)
create table if not exists pos_display (
  shop_id uuid primary key references shops(id) on delete cascade,
  amount numeric default 0,
  status text default 'idle',   -- idle | await (รอชำระ) | paid (ขอบคุณ)
  bill_no text default '',
  updated_at timestamptz default now()
);
