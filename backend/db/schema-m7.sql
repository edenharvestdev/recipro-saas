-- M7: ตั้งค่าสิทธิประโยชน์สมาชิก (เก็บรวมใน JSON เดียว กันเพิ่มคอลัมน์บ่อย)
-- โครง: { discountPct, stampEvery, stampItem, rewards:[{id,name,points}] }
alter table shop_settings add column if not exists member_config jsonb default '{}'::jsonb;
