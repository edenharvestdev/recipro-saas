-- s9: subscription/billing — รองรับ trial หมดอายุ + แพ็กเกจแบบ tier (idempotent, additive)
alter table shops add column if not exists trial_ends_at timestamptz;
alter table plans add column if not exists code text;
alter table plans add column if not exists sort int default 0;

-- แพ็กเกจ tier ตั้งต้น (เพิ่มเฉพาะถ้ายังไม่มี code นั้น — ไม่แตะของเดิม)
insert into plans (code, name, price_month, price_year, features_json, active, sort)
select * from (values
  ('starter', 'Starter', 299,  2990, '{"label":"ร้านเล็ก เพิ่งเริ่ม","features":["pos","stock","members"],"max_branches":1}'::jsonb, true, 1),
  ('pro',     'Pro',     590,  5900, '{"label":"บัญชี/รายงานครบ","features":["pos","stock","members","accounting","vat","qr_menu","stock_count","purchase_order"],"max_branches":1}'::jsonb, true, 2),
  ('premium', 'Premium', 990,  9900, '{"label":"หลายสาขา/โคลน","features":["pos","stock","members","accounting","vat","qr_menu","stock_count","purchase_order","multi_branch","clone","granular_perms"],"max_branches":99}'::jsonb, true, 3)
) as v(code, name, price_month, price_year, features_json, active, sort)
where not exists (select 1 from plans p where p.code = v.code);
