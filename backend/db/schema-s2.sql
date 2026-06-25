-- S2: VAT / ใบกำกับภาษีอย่างย่อ — ตั้งค่าต่อร้าน (additive)
alter table shop_settings add column if not exists vat_enabled boolean default false;
alter table shop_settings add column if not exists vat_rate numeric default 7;
