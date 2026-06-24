-- M5 (เฟส 3): จัดการออเดอร์ออนไลน์ + โหมดจ่ายเงิน
alter table orders add column if not exists paid boolean default false;
-- โหมดจ่ายเงินของร้าน: postpay = จ่ายตอนรับ (ง่ายสุด) · prepay = โอนก่อน (โชว์ PromptPay QR)
alter table shop_settings add column if not exists order_payment_mode text default 'postpay';
-- slug ลิงก์เมนูแบบอ่านง่าย (ชื่อร้าน + suffix จาก token เพื่อกันซ้ำ) — public route รับได้ทั้ง token และ slug
alter table shop_settings add column if not exists public_slug text;
-- กันตัดสต๊อกซ้ำ: true เมื่อออเดอร์ถูกตัดสต๊อก+ลงยอดขายแล้ว (ตอนกด "ลูกค้ารับแล้ว")
alter table orders add column if not exists stock_deducted boolean default false;
-- รูปแบบใบส่งงานหลังร้าน: receipt = ใบรวม 80mm · sticker = สติกเกอร์ต่อแก้ว
alter table shop_settings add column if not exists kitchen_ticket_mode text default 'receipt';
