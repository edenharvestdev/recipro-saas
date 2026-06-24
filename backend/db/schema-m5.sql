-- M5 (เฟส 3): จัดการออเดอร์ออนไลน์ + โหมดจ่ายเงิน
alter table orders add column if not exists paid boolean default false;
-- โหมดจ่ายเงินของร้าน: postpay = จ่ายตอนรับ (ง่ายสุด) · prepay = โอนก่อน (โชว์ PromptPay QR)
alter table shop_settings add column if not exists order_payment_mode text default 'postpay';
-- slug ลิงก์เมนูแบบอ่านง่าย (ชื่อร้าน + suffix จาก token เพื่อกันซ้ำ) — public route รับได้ทั้ง token และ slug
alter table shop_settings add column if not exists public_slug text;
