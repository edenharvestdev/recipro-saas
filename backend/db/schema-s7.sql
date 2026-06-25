-- S7: ลิงก์ URL ของเมนู (พ่วงต่อในอนาคต เช่น รีวิว/รายละเอียด) — additive
alter table recipes add column if not exists link text default '';
