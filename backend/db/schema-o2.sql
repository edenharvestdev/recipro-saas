-- O2: ให้ตัวเลือก REPLACE/QUANTITY เลือก "วัตถุดิบเป้าหมาย" ตรง ๆ ได้ (ไม่ต้องพึ่ง role)
-- เก็บเป็น uuid เปล่า (ไม่ใส่ FK) กัน sync ordering ทำ FK rollback; sync จะ null-guard เองด้วย subquery
alter table option_choices add column if not exists target_material_id uuid default null;
