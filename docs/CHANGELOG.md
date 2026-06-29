# CHANGELOG: RECIPRO

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
