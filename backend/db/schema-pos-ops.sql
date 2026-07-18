-- POS Operations Manager (P0) — เพิ่ม "ความพร้อมขายหน้า POS" ที่แยกขาดจาก
-- recipes.on_menu (สูตร/เมนูนี้อยู่ในระบบเมนูไหม — inclusion) และ
-- materials.show_in_pos/sale_type (วัตถุดิบนี้ขายตรงได้ไหม — inclusion เช่นกัน)
-- ทั้งสองฟิลด์เดิม "ไม่เคย" ถูกออกแบบมาเป็นสวิตช์เปิด/ปิดขายรายวันของผู้จัดการ —
-- ฟิลด์ใหม่นี้คือสวิตช์นั้นโดยเฉพาะ (concept B: menu availability)
--
-- additive + idempotent — ไม่แตะ/ไม่เปลี่ยนความหมายคอลัมน์เดิมใดๆ
-- backfill: default true = ทุกแถวเดิม (ก่อนมีฟีเจอร์นี้) ยังคง "พร้อมขายเหมือนเดิมทุกประการ"
alter table recipes   add column if not exists pos_available boolean not null default true;
alter table recipes   add column if not exists pos_unavailable_reason text default null;
alter table materials add column if not exists pos_available boolean not null default true;
alter table materials add column if not exists pos_unavailable_reason text default null;

-- ป้องกันค่า reason ยาวผิดปกติหลุดเข้ามาทาง path อื่นนอกจาก /api/sync (ซึ่ง cap ไว้ที่ชั้น
-- application อยู่แล้ว) — กันชั้นข้อมูลไว้อีกชั้นแบบเบาๆ ไม่บล็อก NULL/สั้นกว่า
alter table recipes   drop constraint if exists recipes_pos_unavailable_reason_len;
alter table recipes   add constraint recipes_pos_unavailable_reason_len check (char_length(pos_unavailable_reason) <= 200);
alter table materials drop constraint if exists materials_pos_unavailable_reason_len;
alter table materials add constraint materials_pos_unavailable_reason_len check (char_length(pos_unavailable_reason) <= 200);
