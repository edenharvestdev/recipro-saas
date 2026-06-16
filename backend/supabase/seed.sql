-- แพ็กเกจเริ่มต้น (ปรับราคาได้)
insert into plans (name, price_month, price_year, features_json, active) values
  ('เริ่มต้น', 199, 1990, '{"max_users":1,"label":"ร้านเล็ก/ทำคนเดียว"}', true),
  ('โปร',      390, 3900, '{"max_users":5,"label":"มีพนักงานหลายคน"}', true);
