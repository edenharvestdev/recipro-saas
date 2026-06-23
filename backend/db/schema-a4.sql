-- A4+: toggle เปิด/ปิดโมดูล Delivery (บางร้านไม่ใช้)
alter table shop_settings add column if not exists use_delivery boolean default false;
