-- S4: สิทธิ์ย่อยของพนักงาน (staff) ที่เจ้าของเปิด/ปิดเองได้ต่อร้าน (additive)
-- jsonb: { discount, void, stock_receive, waste, edit_recipes, view_cost, petty_cash }
-- ไม่กำหนด/ว่าง = ใช้ค่าเริ่มต้นปลอดภัย (ขายได้อย่างเดียว) ที่ฝั่งแอป
alter table shop_settings add column if not exists staff_permissions jsonb default '{}'::jsonb;
