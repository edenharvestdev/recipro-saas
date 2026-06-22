-- ของใช้สิ้นเปลืองในร้าน: แยกหมวดออกจากวัตถุดิบสูตร (ตัดสต๊อกเป็นแพ็ค/ขวด รายวัน ไม่ผูกในสูตร)
alter table materials add column if not exists is_consumable boolean default false;
