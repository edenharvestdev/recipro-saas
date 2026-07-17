-- Additive authoring + quantity-resolution capability for option_choices
-- (Founder-approved). Additive only: every column defaults to a value that
-- reproduces the pre-existing behaviour exactly, so existing rows are
-- unaffected by this migration.
--
-- ── quantity resolution (engine-visible) ──────────────────────────────────
-- REPLACE gains an alternative to a fixed link amount ('MATCH_SOURCE': use the
-- source material's resolved amount in THIS recipe's BOM). QUANTITY gains
-- 'PERCENT_OF_BASE' (quantity_value % of the base amount) and 'USE_BASE'
-- (explicit no-op, base amount unchanged).
--
-- null / 'FIXED' ⇒ unchanged legacy behavior (fixed link amount / fixed
-- absolute amount respectively) — existing rows are unaffected.
alter table option_choices add column if not exists quantity_mode text default null;
alter table option_choices add column if not exists quantity_value numeric default null;

-- ── guided-authoring metadata (authoring-visible, engine-inert) ───────────
-- Required by the customer-intent Option Builder UX. These are NOT read by
-- stockEngine.js — they persist the owner's EXPLICIT authoring decisions so
-- that a reload cannot silently discard them and thereby fail validation on
-- the next unrelated save (which would force enabled=false and pull a
-- working option off POS — the exact silent-data-loss class this track
-- exists to prevent).
--
--   kitchen_note   — optional free-text note to the kitchen for a REPLACE
--                    item (§8). Distinct from `label` (the customer-facing
--                    name); option_groups has no separate customer/kitchen
--                    label columns, so this is the only kitchen-directed
--                    field available.
--   add_menu_mode  — the owner's EXPLICIT eligible-menu choice for an ADD
--                    item (§4): 'ALL' | 'CONTAINING' | 'MANUAL'.
--                    null ⇒ legacy row authored before the guided flow; see
--                    the legacy-exemption rule in frontend/index.html's
--                    ogValidateChoice. Never silently assumed.
--   mismatch_ack   — the owner's EXPLICIT acknowledgement that a FIXED
--                    REPLACE quantity should be forced onto menus whose own
--                    source amount differs (§3 option B). false ⇒ not yet
--                    acknowledged; publication stays blocked for choices
--                    authored in the new flow.
alter table option_choices add column if not exists kitchen_note text default null;
alter table option_choices add column if not exists add_menu_mode text default null;
alter table option_choices add column if not exists mismatch_ack boolean default false;
