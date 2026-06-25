-- S8: Payment Gateway (Omise/Opn) ต่อร้าน — เก็บคีย์ + สถานะเปิดใช้ (additive)
-- secret key เก็บฝั่ง server เท่านั้น (ไม่ส่งไป bootstrap/frontend) · public key ส่งได้
alter table shop_settings add column if not exists pay_gateway text default '';        -- '' | 'omise'
alter table shop_settings add column if not exists omise_public_key text default '';
alter table shop_settings add column if not exists omise_secret_key text default '';
-- log การจ่ายผ่าน gateway (charge) เพื่อ map webhook → ออเดอร์/บิล + กันยืนยันซ้ำ
create table if not exists pay_charges (
  id text primary key,                       -- charge id จาก gateway (เช่น chrg_xxx) หรือ mock_xxx
  shop_id uuid not null references shops(id) on delete cascade,
  amount numeric default 0,
  status text default 'pending',             -- pending | paid | failed
  source_type text default '',               -- promptpay | card
  bill_no text default '',
  order_id uuid,
  created_at timestamptz default now(),
  paid_at timestamptz
);
create index if not exists pay_charges_shop_idx on pay_charges(shop_id, created_at desc);
