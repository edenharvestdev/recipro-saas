-- แพ็กเกจเริ่มต้น (ปรับราคาได้) — รันหลัง schema.sql, รันซ้ำได้ (idempotent)
insert into plans (name, price_month, price_year, features_json, active)
select * from (values
  ('เริ่มต้น', 199, 1990, '{"max_users":1,"label":"ร้านเล็ก/ทำคนเดียว"}'::jsonb, true),
  ('โปร',      390, 3900, '{"max_users":5,"label":"มีพนักงานหลายคน"}'::jsonb, true)
) as v(name, price_month, price_year, features_json, active)
where not exists (select 1 from plans);
