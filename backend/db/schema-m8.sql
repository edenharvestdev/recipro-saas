-- M8: เทมเพลตประเภทธุรกิจ (เลือกตอนสมัคร/ตั้งค่า) → สลับคำเรียก + เปิด/ปิดโมดูลให้ตรงธุรกิจ
-- fnb (ร้านอาหาร/คาเฟ่) · service (บริการ) · retail (ขายของ) · maker (โฮมเมด/ผลิต)
alter table shop_settings add column if not exists business_type text default 'fnb';
