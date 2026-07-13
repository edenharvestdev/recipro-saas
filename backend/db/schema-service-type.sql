-- schema-service-type.sql — ARCH-2: first-class SERVICE item type (additive, idempotent)
insert into item_categories (code, name_th, name_en, is_stock_deducted, deduct_event, can_be_recipe_output, sort_order, note) values
 ('SERVICE', 'บริการ', 'Service', false, 'none', false, 9, 'ค่าบริการ/ค่าจัดส่ง/ค่าแรง ขายได้ ไม่ตัดสต๊อก')
on conflict (code) do update set
  name_th=excluded.name_th, name_en=excluded.name_en,
  is_stock_deducted=excluded.is_stock_deducted, deduct_event=excluded.deduct_event,
  can_be_recipe_output=excluded.can_be_recipe_output, sort_order=excluded.sort_order, note=excluded.note;

-- Narrow, idempotent remap: ONLY V2-saved Type-G service rows that were written under the old
-- ASSET proxy. Genuine equipment/assets have behavior_type IS NULL and are never touched.
update materials set item_type='SERVICE' where behavior_type='G' and item_type='ASSET';
