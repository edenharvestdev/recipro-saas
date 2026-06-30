# CHANGELOG: RECIPRO

## [S11.2.0] - 2026-06-30 — Clone Option Fix

### Fixed
* Fix `POST /api/admin/selective-clone` — `option_groups`, `option_choices`, `recipe_option_groups`, `material_option_groups` now correctly isolated to destination shop (Fix A: new UUIDs; Fix B: strategy-aware choice insertion; Fix C: `reusedGroupIds`/`updatedGroupIds` Sets; Fix D: `autoIncludedGroupIds` scope guard; Fix E: `findUniqueName` idempotent copy labels).
* Fix duplicate `option_choice_links` and `recipe_option_groups` inserts on rerun (idempotency guard).
* Fix `copy` conflict strategy generating non-unique labels when run multiple times — now uses `(Copy)`, `(Copy 2)`, `(Copy N)` scheme guaranteed unique per execution.
* Fix auto-include logic for `option_groups` not respecting link scope — groups are auto-added only when linked to a recipe being cloned.

### Added
* Add T14 dependency warning: `choice_target_material_missing` / `choice_variant_recipe_missing` in `dependencies[]` when an option choice references a `target_material_id` or `variant_recipe_id` not present in the clone scope — prevents silent NULL FK after clone.
* Add T10 injection via module-level `_injectAt` flag — never reads from HTTP request body. Injection state set by `POST /api/admin/selective-clone/_test/inject` (registered only when `NODE_ENV=test`, unreachable in production). T10-PROD-GUARD confirms production server ignores all injection attempts.
* Add T14 execute gate: `dryRun=false` with unresolved `choice_target_material_missing` / `choice_variant_recipe_missing` deps returns `409 UNRESOLVED_CLONE_DEPENDENCIES` with `dependencies[]` in response body. No rows written on 409.
* Add T13-A through T13-F: server-side `validateOptionsForLine()` verified for cloned recipes and materials — missing required → 400 `REQUIRED_OPTION_MISSING`; exceed max_select → 400 `OPTION_MAX_SELECT_EXCEEDED`; cross-shop choice → 400 `INVALID_OPTION_CHOICE`; unlinked choice → 400. No bill, no movement, no stock change on any rejection.
* Add QA fixture `backend/scripts/fixtures/clone-option-qa.sql` (idempotent, safety-guarded, QA credentials via `LOCAL_QA_PASSWORD` env var only — never hardcoded).
* Add comprehensive QA test suite `backend/scripts/test-clone-option-fix.js` — 200+ assertions (T1–T14, T13-A/F, T10-PROD-GUARD, T-PERM, T14-EXECUTE).

### Security
* Remove `req.body.__testInjectErrorAt` from production code path entirely (B3). No HTTP field from any request can now trigger test injection. Production servers have zero code path to `_injectAt`.
* Remove hardcoded `recipro-qa-clone-2026` password from source (B5). Test runner aborts if `LOCAL_QA_PASSWORD` env var is not set.

### Rollback Plan (B4 — corrected)
To revert all clone fix commits after production deploy (do NOT `git reset --hard` or force-push main):
```bash
# Record pre-deploy SHA before pushing:
PRE_DEPLOY=$(git rev-parse origin/main)

# After deploy, if rollback needed:
git revert --no-commit ${PRE_DEPLOY}..HEAD
git commit -m "revert: roll back clone option fix release"
git push origin main
```

### Business Rule (documented)
* `copy` strategy: each execution creates a new uniquely-named group (not idempotent). Caller is responsible for not calling copy repeatedly if deduplication is desired.
* POS required-option enforcement is **server-side** (`validateOptionsForLine()` in `/api/pos/sell`). Missing required option → `400 REQUIRED_OPTION_MISSING`. Frontend validation is an additional UX layer, not the only guard.

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
