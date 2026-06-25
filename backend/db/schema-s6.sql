-- S6: หมวดเมนูสำหรับ POS (จัดการเอง แยกจากหมวดวัตถุดิบ/สต๊อก) — รายการหมวด + ลำดับ
-- jsonb array เช่น ["เครื่องดื่มเย็น","เครื่องดื่มร้อน","ขนม","ท็อปปิ้ง"]
alter table shop_settings add column if not exists pos_categories jsonb default '[]'::jsonb;
