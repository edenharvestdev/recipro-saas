-- W1: ชื่อผู้ทำรายการ movement (ใช้กับ "ตัดของเสีย" — เก็บว่าใครเป็นคนทำของเสีย)
-- additive + idempotent
alter table stock_movements add column if not exists actor_name text;
