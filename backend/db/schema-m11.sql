-- M11: ตั้งค่าหน้าร้านออนไลน์ (ธีม/กรอบเมนู, รูปโปรโมชั่น/สื่อ, โหมด kiosk)
-- เก็บเป็น jsonb ก้อนเดียว — additive, ค่าเริ่มต้น {} = ใช้ธีมเดิม
alter table shop_settings add column if not exists menu_config jsonb default '{}'::jsonb;
