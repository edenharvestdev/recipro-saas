-- Conditional Option Flow V1 — F0 additive schema (navigation + reusable sets).
-- PRESENTATION/NAVIGATION + REUSE layer. Stock deduction stays in PR#21 (option_stock_effects).
-- Additive + idempotent: CREATE TABLE IF NOT EXISTS + ALTER ADD COLUMN IF NOT EXISTS. No DROP, no RENAME.
-- Feature-gated by CONDITIONAL_FLOW_V1 (default false) — empty tables are inert.
-- step_key / choice_code are STABLE VARCHAR strings (NOT enums) so shop-specific codes need no migration.

-- 1. FLOW TEMPLATE — versioned, named ordered step sequence (navigation only).
CREATE TABLE IF NOT EXISTS flow_templates (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id      uuid NOT NULL,
  code         varchar(64)  NOT NULL,      -- CHASEN_CLEAR, DAILY_CLEAR, MATCHA_LATTE, ...
  version      integer      NOT NULL DEFAULT 1,
  name         text         NOT NULL DEFAULT '',
  description  text         NOT NULL DEFAULT '',
  active       boolean      NOT NULL DEFAULT true,   -- the active version for new resolves
  is_system    boolean      NOT NULL DEFAULT false,
  created_at   timestamptz  NOT NULL DEFAULT now()
);
-- one active row per (shop, code, version); old versions retained for snapshot history
CREATE UNIQUE INDEX IF NOT EXISTS ft_shop_code_ver ON flow_templates(shop_id, code, version);
CREATE INDEX IF NOT EXISTS ft_shop_code_active ON flow_templates(shop_id, code) WHERE active;

-- 2. OPTION STEP — a step declares a logical choice_slot; the menu binds a Choice Set to it.
CREATE TABLE IF NOT EXISTS flow_steps (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id  uuid NOT NULL REFERENCES flow_templates(id) ON DELETE CASCADE,
  shop_id      uuid NOT NULL,
  seq          integer      NOT NULL DEFAULT 0,
  step_key     varchar(64)  NOT NULL,      -- stable string: TEMPERATURE, CULTIVAR, DRINK_MODE, LIQUID,
                                           --   BASE_LIQUID, SWEETENER_MODE, SYRUP_TYPE, SWEETNESS,
                                           --   TOPPING, ADDON, CLOUD, CREATIVE_STYLE, SERVING_VESSEL, ICE_STYLE...
  choice_slot  varchar(64)  NOT NULL DEFAULT '',  -- logical role a menu binds a Choice Set to
  title        text         NOT NULL DEFAULT '',
  select_type  varchar(16)  NOT NULL DEFAULT 'single', -- single | multi
  required     boolean      NOT NULL DEFAULT true,
  default_code varchar(64),                -- optional default choice_code
  active       boolean      NOT NULL DEFAULT true
);
-- no duplicate step_key inside one template version
CREATE UNIQUE INDEX IF NOT EXISTS fs_template_stepkey ON flow_steps(template_id, step_key);
CREATE INDEX IF NOT EXISTS fs_shop_idx ON flow_steps(shop_id);

-- 3. CONDITIONAL RULE — navigation predicates ONLY (no stock). Deterministic by (priority, id).
CREATE TABLE IF NOT EXISTS flow_step_rules (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id    uuid NOT NULL REFERENCES flow_templates(id) ON DELETE CASCADE,
  shop_id        uuid NOT NULL,
  priority       integer     NOT NULL DEFAULT 100,   -- lower = higher precedence
  rule_type      varchar(24) NOT NULL,   -- SHOW_IF|HIDE_IF|SKIP_TO|END_AT_CART|REQUIRE_IF|OPTIONAL_IF
  when_step_key  varchar(64),            -- prior step whose selection is tested
  when_op        varchar(16),            -- EQUALS|NOT_EQUALS|IN|NOT_IN|ANY|NONE
  when_value     jsonb,                  -- choice_code or array of choice_codes
  target_step_key varchar(64),           -- affected/jumped step (null for END_AT_CART)
  note           text        NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS fsr_template_idx ON flow_step_rules(template_id, priority);
CREATE INDEX IF NOT EXISTS fsr_shop_idx ON flow_step_rules(shop_id);

-- 4. CHOICE SET — reusable named choice collection referenced per menu-step slot.
CREATE TABLE IF NOT EXISTS choice_sets (
  id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id  uuid NOT NULL,
  code     varchar(64) NOT NULL,          -- CSG_MATCHA_CULTIVARS, CLEAR_LIQUIDS, SPECIAL_SYRUPS, ...
  name     text        NOT NULL DEFAULT '',
  kind     varchar(32) NOT NULL DEFAULT 'GENERIC', -- CULTIVAR|LIQUID|SYRUP|SWEETNESS|PACKAGING_MODE|ADDON|GENERIC
  active   boolean     NOT NULL DEFAULT true
);
CREATE UNIQUE INDEX IF NOT EXISTS cs_shop_code ON choice_sets(shop_id, code);

CREATE TABLE IF NOT EXISTS choice_set_items (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  set_id            uuid NOT NULL REFERENCES choice_sets(id) ON DELETE CASCADE,
  shop_id           uuid NOT NULL,
  seq               integer     NOT NULL DEFAULT 0,
  choice_code       varchar(64) NOT NULL, -- STABLE key referenced by rules/bindings/stock (M18_HIBI_DAICHI, TAKE_AWAY...)
  label             text        NOT NULL DEFAULT '',
  price_add         numeric     NOT NULL DEFAULT 0,
  is_default        boolean     NOT NULL DEFAULT false,
  option_choice_id  uuid,                 -- OPTIONAL bridge → existing option_choices (PR#21 stock binds by this)
  component_set_code varchar(64)          -- OPTIONAL → applies a Component Set when this choice is picked
);
CREATE UNIQUE INDEX IF NOT EXISTS csi_set_code ON choice_set_items(set_id, choice_code);
CREATE INDEX IF NOT EXISTS csi_shop_idx ON choice_set_items(shop_id);

-- 5. COMPONENT SET (aka STOCK_SET — NOT "SOP Set") — reusable bundle of PR#21-shaped effect rows.
CREATE TABLE IF NOT EXISTS component_sets (
  id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id  uuid NOT NULL,
  code     varchar(64) NOT NULL,          -- SET_CLEAR_TAKEAWAY, SET_CLEAR_SEPARATE, SET_LATTE_TAKEAWAY, ...
  name     text        NOT NULL DEFAULT '',
  active   boolean     NOT NULL DEFAULT true
);
CREATE UNIQUE INDEX IF NOT EXISTS cmps_shop_code ON component_sets(shop_id, code);

CREATE TABLE IF NOT EXISTS component_set_items (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  set_id         uuid NOT NULL REFERENCES component_sets(id) ON DELETE CASCADE,
  shop_id        uuid NOT NULL,
  seq            integer     NOT NULL DEFAULT 0,
  -- vocab IDENTICAL to PR#21 option_stock_effects — do NOT invent a second stock vocabulary
  target_type    varchar(24) NOT NULL,    -- MATERIAL|PRODUCED_ITEM|FINISHED_GOOD|RECIPE_COMPONENT|PACKAGING|NO_STOCK
  target_ref_id  uuid,
  action         varchar(16) NOT NULL DEFAULT 'ADD', -- ADD|REMOVE|REPLACE|MULTIPLY|NO_STOCK
  amount         numeric,
  unit           varchar(32),
  replace_ref_id uuid,
  target_role    varchar(64)
);
CREATE INDEX IF NOT EXISTS cmpsi_set_idx ON component_set_items(set_id, seq);
CREATE INDEX IF NOT EXISTS cmpsi_shop_idx ON component_set_items(shop_id);

-- 6. MENU ASSIGNMENT — a menu references Template + per-slot Choice Set + conditional Component Sets.
CREATE TABLE IF NOT EXISTS menu_flow_bindings (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id               uuid NOT NULL,
  recipe_id             uuid NOT NULL,     -- the menu (existing recipes row)
  template_code         varchar(64) NOT NULL,
  template_version      integer,           -- null = follow active version
  active                boolean     NOT NULL DEFAULT true
);
CREATE UNIQUE INDEX IF NOT EXISTS mfb_shop_recipe_active ON menu_flow_bindings(shop_id, recipe_id) WHERE active;

CREATE TABLE IF NOT EXISTS menu_step_bindings (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  menu_binding_id uuid NOT NULL REFERENCES menu_flow_bindings(id) ON DELETE CASCADE,
  shop_id         uuid NOT NULL,
  choice_slot     varchar(64) NOT NULL,    -- matches flow_steps.choice_slot
  choice_set_code varchar(64) NOT NULL     -- which Choice Set fills this slot for THIS menu
);
CREATE UNIQUE INDEX IF NOT EXISTS msb_binding_slot ON menu_step_bindings(menu_binding_id, choice_slot);
CREATE INDEX IF NOT EXISTS msb_shop_idx ON menu_step_bindings(shop_id);

CREATE TABLE IF NOT EXISTS menu_component_bindings (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  menu_binding_id   uuid NOT NULL REFERENCES menu_flow_bindings(id) ON DELETE CASCADE,
  shop_id           uuid NOT NULL,
  trigger_step_key  varchar(64),           -- null = always apply
  trigger_op        varchar(16),           -- EQUALS|IN|... (same operators as rules)
  trigger_value     jsonb,
  component_set_code varchar(64) NOT NULL,
  seq               integer NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS mcb_binding_idx ON menu_component_bindings(menu_binding_id, seq);
CREATE INDEX IF NOT EXISTS mcb_shop_idx ON menu_component_bindings(shop_id);
