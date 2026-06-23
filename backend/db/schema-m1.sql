-- M1: รูปต่อสินค้า/วัตถุดิบที่ขายใน POS (เหมือน recipes.img_data) — additive
alter table materials add column if not exists img_data text;
