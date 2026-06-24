-- O1: เก็บค่าปริมาณของตัวเลือกแบบ QUANTITY (เช่น หวาน 0/5/8g) — ตั้งค่าสัมบูรณ์ของวัตถุดิบตาม role
-- additive + idempotent (default 0 = ไม่ทำอะไร = พฤติกรรมเดิม)
alter table option_choices add column if not exists amount numeric default 0;
