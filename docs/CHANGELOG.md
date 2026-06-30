# CHANGELOG: RECIPRO

## [S11.2.0] - 2026-06-30 — Clone Option Fix

### Fixed
* Fix `POST /api/admin/selective-clone` — `option_groups`, `option_choices`, `recipe_option_groups`, `material_option_groups` now correctly isolated to destination shop (Fix A: new UUIDs; Fix B: strategy-aware choice insertion; Fix C: `reusedGroupIds`/`updatedGroupIds` Sets; Fix D: `autoIncludedGroupIds` scope guard; Fix E: `findUniqueName` idempotent copy labels).
* Fix duplicate `option_choice_links` and `recipe_option_groups` inserts on rerun (idempotency guard).
* Fix `copy` conflict strategy generating non-unique labels when run multiple times — now uses `(Copy)`, `(Copy 2)`, `(Copy N)` scheme guaranteed unique per execution.
* Fix auto-include logic for `option_groups` not respecting link scope — groups are auto-added only when linked to a recipe being cloned.

### Added
* Add T14 dependency warning: `choice_target_material_missing` / `choice_variant_recipe_missing` in `dependencies[]` when an option choice references a `target_material_id` or `variant_recipe_id` not present in the clone scope — prevents silent NULL FK after clone.
* Add T10 double-guard for test error injection: requires both `NODE_ENV=test` AND `CLONE_TEST_INJECT_FAILURE=1` — production server can never satisfy both, production requests cannot trigger injection.
* Add QA fixture `backend/scripts/fixtures/clone-option-qa.sql` (idempotent, safety-guarded, separate QA credentials).
* Add comprehensive QA test suite `backend/scripts/test-clone-option-fix.js` — 160 assertions (T1–T14, T10-PROD-GUARD, T-PERM) covering dry-run, all conflict strategies, rollback, POS API contract, permission regression, and nested dependency warnings.

### Business Rule (documented)
* `copy` strategy: each execution creates a new uniquely-named group (not idempotent). Caller is responsible for not calling copy repeatedly if deduplication is desired.
* POS required-option enforcement is client-side only; server deducts BOM from provided `chosen_options` without blocking absent required selections.

## [S11.1.0] - 2026-06-29

### Added
* Add `inventory_mode` configuration option to `recipes` table schema.
* Add `reversal_of` UNIQUE link to `stock_movements` to enable strong void idempotency.
* Add automated staging QA test suite (`scripts/setup-staging.js`) for verifying transactions, rollbacks, and isolation.
* Add dry-run capabilities to production correction script (`scripts/apply-correction.js`).

### Fixed
* Fix transaction rollback on POST `/api/pos/sell` to abort entire cart if any recipe/material is missing or cross-branch spoofed (Gate 3).
* Fix `receiveMat()` in `frontend/index.html` to support `convQty` multiplier and log stock movement (Gate 4).
* Fix void endpoint `updated_at` query failure by removing non-existent column updates from `bills` table (S11 bugfix).
* Fix encoding issues in `backup-db.ps1` for Windows PowerShell environment.
