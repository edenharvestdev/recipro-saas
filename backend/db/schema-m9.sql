-- M9: รายละเอียด/คำอธิบายสินค้า (เมนู) — โชว์ใน POS + เมนูออนไลน์
alter table recipes add column if not exists detail text default '';
