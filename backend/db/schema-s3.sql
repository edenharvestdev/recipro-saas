-- S3: คุมส่วนลดหน้าร้าน (additive) — กันส่วนลดรั่ว/ขาดทุน
-- staff_discount_max   : เพดาน % ที่พนักงานกดได้ (100 = ไม่จำกัด · เจ้าของไม่จำกัดเสมอ)
-- staff_discount_max_baht : เพดานบาทที่พนักงานกดได้ต่อบิล (0 = ไม่จำกัด)
-- discount_presets     : ปุ่มส่วนลดสำเร็จรูป (ทุกคนกดได้) เช่น [{"type":"%","val":10},{"type":"฿","val":20}]
alter table shop_settings add column if not exists staff_discount_max numeric default 100;
alter table shop_settings add column if not exists staff_discount_max_baht numeric default 0;
alter table shop_settings add column if not exists discount_presets jsonb default '[]'::jsonb;
