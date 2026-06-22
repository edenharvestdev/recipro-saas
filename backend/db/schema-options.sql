-- BOM-aware options engine schema
alter table recipe_items add column if not exists role text default '';
alter table shop_settings add column if not exists options_engine boolean default false;

create table if not exists option_groups (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references shops(id) on delete cascade,
  label text not null default '',
  select_type text not null default 'single',
  required boolean default false,
  min_select int default 0,
  max_select int default 1,
  sort int default 0,
  enabled boolean default true
);
create index if not exists og_shop_idx on option_groups(shop_id);

create table if not exists option_choices (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references option_groups(id) on delete cascade,
  label text not null default '',
  price_add numeric default 0,
  effect_type text default 'NONE',
  enabled boolean default true,
  is_default boolean default false,
  sort int default 0,
  max_qty int default 1,
  target_role text default '',
  variant_recipe_id uuid references recipes(id) on delete set null
);
create index if not exists oc_group_idx on option_choices(group_id);

create table if not exists option_choice_links (
  id uuid primary key default gen_random_uuid(),
  choice_id uuid not null references option_choices(id) on delete cascade,
  material_id uuid not null references materials(id) on delete cascade,
  amount numeric not null default 0
);
create index if not exists ocl_choice_idx on option_choice_links(choice_id);

create table if not exists recipe_option_groups (
  recipe_id uuid not null references recipes(id) on delete cascade,
  group_id uuid not null references option_groups(id) on delete cascade,
  sort int default 0,
  primary key (recipe_id, group_id)
);
