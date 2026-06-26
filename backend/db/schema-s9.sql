-- s9: subscription/billing — รองรับ trial หมดอายุ + แพ็กเกจแบบ tier (idempotent, additive)
alter table shops add column if not exists trial_ends_at timestamptz;
alter table plans add column if not exists code text;
alter table plans add column if not exists sort int default 0;

-- แพ็กเกจ tier ตั้งต้น (เพิ่มเฉพาะถ้ายังไม่มี code นั้น — ไม่แตะของเดิม)
insert into plans (code, name, price_month, price_year, features_json, active, sort)
select * from (values
  ('starter', 'Starter', 299,  2990, '{}'::jsonb, true, 1),
  ('pro',     'Pro',     590,  5900, '{}'::jsonb, true, 2),
  ('premium', 'Premium', 990,  9900, '{}'::jsonb, true, 3)
) as v(code, name, price_month, price_year, features_json, active, sort)
where not exists (select 1 from plans p where p.code = v.code);

-- ฟีเจอร์ + ลิมิตการใช้งานของแต่ละ tier (ครอบคลุมค่าเก็บดาต้า) — ตั้งครั้งเดียวต่อ tier
-- เงื่อนไข not (features_json ? 'limits') = ยังไม่เคยตั้งลิมิต → ไม่ทับค่าที่แอดมินแก้เองภายหลัง
update plans set features_json =
  '{"label":"ร้านเล็ก เพิ่งเริ่ม","features":["pos","stock","members"],"limits":{"branches":1,"staff":2,"products":200,"images":200}}'::jsonb
  where code = 'starter' and not (features_json ? 'limits');
update plans set features_json =
  '{"label":"บัญชี/รายงานครบ","features":["pos","stock","members","accounting","vat","qr_menu","stock_count","purchase_order"],"limits":{"branches":1,"staff":10,"products":99999,"images":2000}}'::jsonb
  where code = 'pro' and not (features_json ? 'limits');
update plans set features_json =
  '{"label":"หลายสาขา/โคลน","features":["pos","stock","members","accounting","vat","qr_menu","stock_count","purchase_order","multi_branch","clone","granular_perms"],"limits":{"branches":99,"staff":99999,"products":99999,"images":99999}}'::jsonb
  where code = 'premium' and not (features_json ? 'limits');
