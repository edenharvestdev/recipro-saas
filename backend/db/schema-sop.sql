-- #5 SOP / สูตรซ้อนสูตร (multi-level BOM): ส่วนผสมอ้างถึงสูตรอื่น (ของกลาง) ได้
alter table recipe_items add column if not exists sub_recipe_id uuid references recipes(id) on delete set null;
alter table recipes add column if not exists is_sop boolean default false; -- true = ของกลาง ใช้เป็นส่วนผสมในสูตรอื่นได้
