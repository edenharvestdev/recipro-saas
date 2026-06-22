-- #3/#4: ประเภทวัตถุดิบ (ขายได้เลย vs ส่วนผสมเท่านั้น) + แสดงใน POS
alter table materials add column if not exists sale_type text default 'INGREDIENT_ONLY'; -- INGREDIENT_ONLY | SELLABLE
alter table materials add column if not exists show_in_pos boolean default false;
alter table materials add column if not exists sale_price_2 numeric; -- ราคาขายรอง (เช่น ราคาส่ง) — ไม่บังคับ
