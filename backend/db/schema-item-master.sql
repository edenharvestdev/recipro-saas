-- ============================================================
-- Phase 0: Item Master + หมวดมาตรฐาน 8 หมวด (additive · idempotent · ไม่สูญข้อมูล)
-- - ไม่ลบ/ไม่เปลี่ยนชื่อคอลัมน์เดิม (category, sale_type, is_consumable, is_sop คงอยู่ครบ)
-- - เพิ่ม taxonomy 8 หมวดมาตรฐานกลางที่ใช้ขับการตัดสต๊อก
-- - backfill เฉพาะจาก "สัญญาณที่ร้านตั้งไว้แล้ว" (faithful) — ที่เหลือเว้น NULL ให้ร้านเลือกเอง
-- ============================================================

-- 1) ตารางหมวดมาตรฐานกลาง (global reference, ใช้ร่วมทุกร้าน)
create table if not exists item_categories (
  code text primary key,
  name_th text not null,
  name_en text not null,
  is_stock_deducted boolean not null default true,  -- สต๊อกของตัวมันเองลดเมื่อถูกใช้/ขายไหม
  deduct_event text,                                -- recipe_use | on_sale | daily_or_manual | none
  can_be_recipe_output boolean not null default false,
  sort_order int not null default 0,
  note text
);

-- 2) seed 8 หมวด (idempotent — refresh ชื่อ/พฤติกรรมทุก deploy ผ่าน ON CONFLICT)
insert into item_categories (code,name_th,name_en,is_stock_deducted,deduct_event,can_be_recipe_output,sort_order,note) values
 ('RAW',       'วัตถุดิบ',          'Raw Material',          true,  'recipe_use',      false, 1, 'ของที่ซื้อมาตรง ๆ'),
 ('COMPOUND',  'ของผสมเอง',         'Compound Ingredient',   true,  'recipe_use',      true,  2, 'ผสม/เบลนด์เอง'),
 ('PREP',      'ของเตรียมไว้',      'Prep Item',             true,  'recipe_use',      true,  3, 'เตรียมล่วงหน้า เช่น ไซรัป'),
 ('SEMI',      'ของกึ่งสำเร็จ',     'Semi-Finished Product', true,  'recipe_use',      true,  4, 'ทำเป็นล็อต เช่น แป้งโด'),
 ('SALE',      'ของขาย/เมนู',       'Sale Product',          false, 'none',            true,  5, 'ขายให้ลูกค้า (ตัดวัตถุดิบในสูตรแทน)'),
 ('PACKAGING', 'บรรจุภัณฑ์',        'Packaging Material',    true,  'on_sale',         false, 6, 'แก้ว ฝา หลอด ถุง'),
 ('SUPPLIES',  'ของใช้สิ้นเปลือง',  'Operational Supplies',  true,  'daily_or_manual', false, 7, 'ทิชชู่ ถุงมือ น้ำยา'),
 ('ASSET',     'ของใช้ถาวร',        'Asset',                 false, 'none',            false, 8, 'เครื่องมือ/ทรัพย์สิน ไม่ตัดสต๊อก')
on conflict (code) do update set
  name_th=excluded.name_th, name_en=excluded.name_en,
  is_stock_deducted=excluded.is_stock_deducted, deduct_event=excluded.deduct_event,
  can_be_recipe_output=excluded.can_be_recipe_output, sort_order=excluded.sort_order, note=excluded.note;

-- 3) คอลัมน์ใหม่ (เพิ่มอย่างเดียว — ของเดิมอยู่ครบ)
alter table materials       add column if not exists item_type text references item_categories(code);
alter table recipes         add column if not exists recipe_type text;            -- PRODUCTION | MENU
alter table recipes         add column if not exists output_item_type text references item_categories(code);
alter table stock_movements add column if not exists consumption_category text;   -- recipe_use | on_sale | daily | manual | waste | transfer | production

create index if not exists materials_item_type_idx on materials(shop_id, item_type);
create index if not exists recipes_recipe_type_idx  on recipes(shop_id, recipe_type);

-- 4) backfill เฉพาะจากสัญญาณที่ร้านตั้งไว้แล้ว (faithful, ไม่เดามั่ว) — เฉพาะแถวที่ยังว่าง (idempotent)
update materials set item_type='SUPPLIES' where item_type is null and is_consumable = true;
update materials set item_type='SALE'     where item_type is null and sale_type = 'SELLABLE';
-- materials อื่นเว้น item_type = NULL ให้ร้านเลือกเอง (UI auto-suggest = วัตถุดิบ)

update recipes set recipe_type='PRODUCTION', output_item_type=coalesce(output_item_type,'PREP')
  where recipe_type is null and is_sop = true;
update recipes set recipe_type='MENU', output_item_type=coalesce(output_item_type,'SALE')
  where recipe_type is null and (is_sop = false or is_sop is null);
