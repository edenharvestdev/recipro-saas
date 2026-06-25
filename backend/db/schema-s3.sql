-- S3: เพดานส่วนลดที่พนักงาน (staff) กดได้สูงสุด — กันส่วนลดรั่ว (additive)
-- 100 = ไม่จำกัด (ค่าเริ่มต้น เพื่อ back-compat กับร้านเดิม) · เจ้าของ/แอดมินไม่จำกัดเสมอ
alter table shop_settings add column if not exists staff_discount_max numeric default 100;
