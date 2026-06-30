-- =============================================================
-- RECIPRO — Clone Option QA Fixture
-- File: backend/scripts/fixtures/clone-option-qa.sql
-- Purpose: Idempotent test data for T1–T13 clone option tests
-- MUST NOT RUN ON PRODUCTION
-- =============================================================
--
-- Safety guard: caller must set session variable 'qa.confirmed' = 'yes'
-- before executing this file. The test runner does this automatically.
-- Running directly without the guard will abort.

DO $$
BEGIN
  IF current_setting('qa.confirmed', true) IS DISTINCT FROM 'yes' THEN
    RAISE EXCEPTION 'SAFETY ABORT: Set session variable qa.confirmed=yes before running this fixture. Do NOT run on production.';
  END IF;
END $$;

-- =============================================================
-- CONSTANTS (stable UUIDs for idempotent re-runs)
-- =============================================================
-- Source shop:   aaaaaaaa-0001-0001-0001-000000000001  (CLONE-TEST-SOURCE)
-- Dest shop:     aaaaaaaa-0002-0002-0002-000000000002  (CLONE-TEST-DEST)
-- Mat A (Banana):     bb000001-0000-0000-0000-000000000001
-- Mat B (Flour):      bb000001-0000-0000-0000-000000000002
-- Mat Direct-sale:    bb000001-0000-0000-0000-000000000003
-- Recipe:             cc000001-0000-0000-0000-000000000001
-- Group1 (เตรียม):   dd000001-0000-0000-0000-000000000001
-- Group2 (Topping):   dd000001-0000-0000-0000-000000000002
-- Choice อุ่น:       ee000001-0000-0000-0000-000000000001
-- Choice ไม่อุ่น:    ee000001-0000-0000-0000-000000000002
-- Choice Cream Cheese:ee000001-0000-0000-0000-000000000003
-- Choice Matcha Cloud:ee000001-0000-0000-0000-000000000004

BEGIN;

-- =============================================================
-- TEARDOWN: Remove previous test data (prefix-safe, no wildcards)
-- =============================================================

-- Destination shop — remove all test data
DELETE FROM material_option_groups
  WHERE group_id IN (
    SELECT id FROM option_groups WHERE shop_id = 'aaaaaaaa-0002-0002-0002-000000000002'
  );
DELETE FROM recipe_option_groups
  WHERE group_id IN (
    SELECT id FROM option_groups WHERE shop_id = 'aaaaaaaa-0002-0002-0002-000000000002'
  );
DELETE FROM option_choice_links
  WHERE choice_id IN (
    SELECT oc.id FROM option_choices oc
    JOIN option_groups og ON og.id = oc.group_id
    WHERE og.shop_id = 'aaaaaaaa-0002-0002-0002-000000000002'
  );
DELETE FROM option_choices
  WHERE group_id IN (
    SELECT id FROM option_groups WHERE shop_id = 'aaaaaaaa-0002-0002-0002-000000000002'
  );
DELETE FROM option_groups WHERE shop_id = 'aaaaaaaa-0002-0002-0002-000000000002';
DELETE FROM recipe_items
  WHERE recipe_id IN (
    SELECT id FROM recipes WHERE shop_id = 'aaaaaaaa-0002-0002-0002-000000000002'
  );
DELETE FROM recipes WHERE shop_id = 'aaaaaaaa-0002-0002-0002-000000000002';
DELETE FROM materials WHERE shop_id = 'aaaaaaaa-0002-0002-0002-000000000002';

-- Source shop — remove previous run of test data only
DELETE FROM material_option_groups
  WHERE material_id IN (
    SELECT id FROM materials
    WHERE shop_id = 'aaaaaaaa-0001-0001-0001-000000000001'
      AND id IN (
        'bb000001-0000-0000-0000-000000000001',
        'bb000001-0000-0000-0000-000000000002',
        'bb000001-0000-0000-0000-000000000003'
      )
  );
DELETE FROM recipe_option_groups
  WHERE recipe_id = 'cc000001-0000-0000-0000-000000000001'
     OR group_id IN (
       'dd000001-0000-0000-0000-000000000001',
       'dd000001-0000-0000-0000-000000000002'
     );
DELETE FROM option_choice_links
  WHERE choice_id IN (
    'ee000001-0000-0000-0000-000000000001',
    'ee000001-0000-0000-0000-000000000002',
    'ee000001-0000-0000-0000-000000000003',
    'ee000001-0000-0000-0000-000000000004'
  );
DELETE FROM option_choices
  WHERE id IN (
    'ee000001-0000-0000-0000-000000000001',
    'ee000001-0000-0000-0000-000000000002',
    'ee000001-0000-0000-0000-000000000003',
    'ee000001-0000-0000-0000-000000000004'
  );
DELETE FROM option_groups
  WHERE id IN (
    'dd000001-0000-0000-0000-000000000001',
    'dd000001-0000-0000-0000-000000000002'
  );
DELETE FROM recipe_items
  WHERE recipe_id = 'cc000001-0000-0000-0000-000000000001';
DELETE FROM recipes WHERE id = 'cc000001-0000-0000-0000-000000000001';
DELETE FROM materials
  WHERE id IN (
    'bb000001-0000-0000-0000-000000000001',
    'bb000001-0000-0000-0000-000000000002',
    'bb000001-0000-0000-0000-000000000003'
  );

-- =============================================================
-- SEED: Source shop test data
-- =============================================================

-- Shops and settings (idempotent)
INSERT INTO shops (id, name, status, trial_ends_at)
VALUES (
  'aaaaaaaa-0001-0001-0001-000000000001',
  'CLONE-TEST-SOURCE',
  'trial',
  now() + interval '90 days'
)
ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name;

INSERT INTO shops (id, name, status, trial_ends_at)
VALUES (
  'aaaaaaaa-0002-0002-0002-000000000002',
  'CLONE-TEST-DEST',
  'trial',
  now() + interval '90 days'
)
ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name;

INSERT INTO shop_settings (shop_id)
VALUES ('aaaaaaaa-0001-0001-0001-000000000001')
ON CONFLICT (shop_id) DO NOTHING;

INSERT INTO shop_settings (shop_id)
VALUES ('aaaaaaaa-0002-0002-0002-000000000002')
ON CONFLICT (shop_id) DO NOTHING;

-- QA test user — uses QA-specific password (NOT the production admin password)
-- Password: recipro-qa-clone-2026 (QA-only, never used in production)
INSERT INTO users (id, email, password_hash)
VALUES (
  'ffffffff-0000-0000-0000-000000000001',
  'qa-clone-test@local.test',
  '$2a$12$CvtQVOP0rIoTGiPdJ8YLKuORFSPuNG2hz9lJUgjhGY/6xSoK3PMJG'
)
ON CONFLICT (id) DO UPDATE SET password_hash = EXCLUDED.password_hash;

-- Superadmin on source shop
INSERT INTO memberships (user_id, shop_id, role)
VALUES ('ffffffff-0000-0000-0000-000000000001', 'aaaaaaaa-0001-0001-0001-000000000001', 'superadmin')
ON CONFLICT (user_id, shop_id) DO UPDATE SET role = 'superadmin';

-- Superadmin on destination shop (needed for T13 bootstrap test)
INSERT INTO memberships (user_id, shop_id, role)
VALUES ('ffffffff-0000-0000-0000-000000000001', 'aaaaaaaa-0002-0002-0002-000000000002', 'superadmin')
ON CONFLICT (user_id, shop_id) DO UPDATE SET role = 'superadmin';

-- Permission test users (owner + staff — separate from QA superadmin)
INSERT INTO users (id, email, password_hash)
VALUES (
  'ffffffff-0000-0000-0000-000000000002',
  'qa-owner@local.test',
  '$2a$12$CvtQVOP0rIoTGiPdJ8YLKuORFSPuNG2hz9lJUgjhGY/6xSoK3PMJG'
)
ON CONFLICT (id) DO UPDATE SET password_hash = EXCLUDED.password_hash;

INSERT INTO memberships (user_id, shop_id, role)
VALUES ('ffffffff-0000-0000-0000-000000000002', 'aaaaaaaa-0001-0001-0001-000000000001', 'owner')
ON CONFLICT (user_id, shop_id) DO UPDATE SET role = 'owner';

INSERT INTO users (id, email, password_hash)
VALUES (
  'ffffffff-0000-0000-0000-000000000003',
  'qa-staff@local.test',
  '$2a$12$CvtQVOP0rIoTGiPdJ8YLKuORFSPuNG2hz9lJUgjhGY/6xSoK3PMJG'
)
ON CONFLICT (id) DO UPDATE SET password_hash = EXCLUDED.password_hash;

INSERT INTO memberships (user_id, shop_id, role)
VALUES ('ffffffff-0000-0000-0000-000000000003', 'aaaaaaaa-0001-0001-0001-000000000001', 'staff')
ON CONFLICT (user_id, shop_id) DO UPDATE SET role = 'staff';

-- Materials
INSERT INTO materials (
  id, shop_id, sku, name, qty, unit, price, stock, low_stock, sale_type, show_in_pos, item_type
) VALUES (
  'bb000001-0000-0000-0000-000000000001',
  'aaaaaaaa-0001-0001-0001-000000000001',
  'TEST-ING-001', 'TEST Banana (QA)', 100, 'g', 0, 500, 0, 'INGREDIENT_ONLY', false, null
);

INSERT INTO materials (
  id, shop_id, sku, name, qty, unit, price, stock, low_stock, sale_type, show_in_pos, item_type
) VALUES (
  'bb000001-0000-0000-0000-000000000002',
  'aaaaaaaa-0001-0001-0001-000000000001',
  'TEST-ING-002', 'TEST Flour (QA)', 100, 'g', 0, 1000, 0, 'INGREDIENT_ONLY', false, null
);

INSERT INTO materials (
  id, shop_id, sku, name, qty, unit, price, sell_price, stock, low_stock, sale_type, show_in_pos
) VALUES (
  'bb000001-0000-0000-0000-000000000003',
  'aaaaaaaa-0001-0001-0001-000000000001',
  'TEST-DIRECT-CAKE-01', 'Direct Sale Cake Clone Test', 1, 'ชิ้น', 0, 150, 10, 0, 'DIRECT_SALE', true
);

-- Recipe
INSERT INTO recipes (
  id, shop_id, code, name, sell_price, batch_yield, yield_unit,
  is_raw, on_menu, fg_stock, fg_low, inventory_mode
) VALUES (
  'cc000001-0000-0000-0000-000000000001',
  'aaaaaaaa-0001-0001-0001-000000000001',
  'TEST-CLONE-MENU-01',
  'Banana Cake Clone Test',
  120, 1, 'ชิ้น',
  false, true, 0, 0, 'inherit'
);

-- Recipe items
INSERT INTO recipe_items (recipe_id, material_id, amount, role)
VALUES ('cc000001-0000-0000-0000-000000000001', 'bb000001-0000-0000-0000-000000000001', 200, 'main');

INSERT INTO recipe_items (recipe_id, material_id, amount, role)
VALUES ('cc000001-0000-0000-0000-000000000001', 'bb000001-0000-0000-0000-000000000002', 50, 'secondary');

-- Option Group 1: การเตรียมสินค้า (required, all visibility true)
INSERT INTO option_groups (
  id, shop_id, label, select_type,
  required, min_select, max_select, sort, enabled,
  visible_on_pos, visible_on_receipt, visible_on_kitchen, visible_on_online
) VALUES (
  'dd000001-0000-0000-0000-000000000001',
  'aaaaaaaa-0001-0001-0001-000000000001',
  'การเตรียมสินค้า', 'single',
  true, 1, 1, 1, true,
  true, true, true, true
);

-- Option Group 2: Topping (optional, mixed visibility — receipt=false, online=false)
INSERT INTO option_groups (
  id, shop_id, label, select_type,
  required, min_select, max_select, sort, enabled,
  visible_on_pos, visible_on_receipt, visible_on_kitchen, visible_on_online
) VALUES (
  'dd000001-0000-0000-0000-000000000002',
  'aaaaaaaa-0001-0001-0001-000000000001',
  'Topping', 'multi',
  false, 0, 2, 2, true,
  true, false, true, false
);

-- Choices: Group 1
INSERT INTO option_choices (
  id, group_id, label, price_add, effect_type, enabled, is_default, sort, max_qty, target_role, is_metadata_only, amount
) VALUES
  ('ee000001-0000-0000-0000-000000000001', 'dd000001-0000-0000-0000-000000000001', 'อุ่น',   0, 'NONE', true, false, 1, 1, '', false, 0),
  ('ee000001-0000-0000-0000-000000000002', 'dd000001-0000-0000-0000-000000000001', 'ไม่อุ่น', 0, 'NONE', true, false, 2, 1, '', false, 0);

-- Choices: Group 2
INSERT INTO option_choices (
  id, group_id, label, price_add, effect_type, enabled, is_default, sort, max_qty, target_role, is_metadata_only, amount
) VALUES
  ('ee000001-0000-0000-0000-000000000003', 'dd000001-0000-0000-0000-000000000002', 'Cream Cheese', 30, 'NONE', true, false, 1, 1, '', false, 0),
  ('ee000001-0000-0000-0000-000000000004', 'dd000001-0000-0000-0000-000000000002', 'Matcha Cloud',  35, 'NONE', true, false, 2, 1, '', false, 0);

-- Link recipe → option groups
INSERT INTO recipe_option_groups (recipe_id, group_id, sort)
VALUES ('cc000001-0000-0000-0000-000000000001', 'dd000001-0000-0000-0000-000000000001', 1);

INSERT INTO recipe_option_groups (recipe_id, group_id, sort)
VALUES ('cc000001-0000-0000-0000-000000000001', 'dd000001-0000-0000-0000-000000000002', 2);

-- Link direct-sale material → Group 1
INSERT INTO material_option_groups (material_id, group_id, sort)
VALUES ('bb000001-0000-0000-0000-000000000003', 'dd000001-0000-0000-0000-000000000001', 1);

COMMIT;

-- =============================================================
-- Verification summary (no SELECT *)
-- =============================================================
SELECT
  'SOURCE' AS shop,
  (SELECT count(id) FROM materials WHERE shop_id = 'aaaaaaaa-0001-0001-0001-000000000001') AS materials,
  (SELECT count(id) FROM recipes WHERE shop_id = 'aaaaaaaa-0001-0001-0001-000000000001') AS recipes,
  (SELECT count(recipe_id) FROM recipe_items ri JOIN recipes r ON r.id = ri.recipe_id WHERE r.shop_id = 'aaaaaaaa-0001-0001-0001-000000000001') AS recipe_items,
  (SELECT count(id) FROM option_groups WHERE shop_id = 'aaaaaaaa-0001-0001-0001-000000000001') AS option_groups,
  (SELECT count(oc.id) FROM option_choices oc JOIN option_groups og ON og.id = oc.group_id WHERE og.shop_id = 'aaaaaaaa-0001-0001-0001-000000000001') AS option_choices,
  (SELECT count(rog.recipe_id) FROM recipe_option_groups rog JOIN option_groups og ON og.id = rog.group_id WHERE og.shop_id = 'aaaaaaaa-0001-0001-0001-000000000001') AS recipe_opt_groups,
  (SELECT count(mog.material_id) FROM material_option_groups mog JOIN option_groups og ON og.id = mog.group_id WHERE og.shop_id = 'aaaaaaaa-0001-0001-0001-000000000001') AS mat_opt_groups;
