-- M4: ชั้นเมนู (เบา) — on_menu คุมว่า "สูตร" ขึ้นหน้าขาย/เมนูหรือไม่
-- ราคาเมนู = recipes.sell_price เดิม (ไม่ย้าย ไม่ลบ) · วัตถุดิบใช้ show_in_pos เดิมเป็น on_menu อยู่แล้ว
-- additive + idempotent + ไม่ทำข้อมูลหาย
alter table recipes add column if not exists on_menu boolean;
-- backfill เฉพาะที่ยังไม่ตั้ง: Main(ไม่ใช่ raw)=ขึ้นเมนู, RAW=ไม่ขึ้น → รักษาพฤติกรรมเดิมเป๊ะ
update recipes set on_menu = (case when coalesce(is_raw, false) then false else true end) where on_menu is null;
