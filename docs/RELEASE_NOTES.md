# RELEASE NOTES: RECIPRO SPRINT S11

## Release Version: S11.1.0
**Release Date:** 2026-06-29
**Deploy Commit:** `ea82e86`
**Deployment Status:** Live on Production ([www.recipro.love](https://www.recipro.love))

---

## What's New in S11.1.0
This release resolves the critical stock integrity issue for pre-produced finished goods and adds strong idempotency to POS transactions:

### 1. Per-Recipe Inventory Mode
* Adds `inventory_mode` configuration option on a per-recipe basis.
* Allows individual items to bypass the global store settings.
* Modes supported:
  * `inherit` (default): Follow global shop configuration (e.g., global Make to Order).
  * `finished_goods`: Deducts directly from the recipe's `fg_stock` (ready-made).
  * `make_to_order`: Expands BOM options and deducts raw materials on sale.
  * `non_stock`: Does not deduct stock.

### 2. Strong Transaction Reversals
* Introduces the `reversal_of` field in the `stock_movements` ledger with a UNIQUE index constraint.
* Restores stock atomically during bill voids and prevents double-voiding (idempotent void action).

---

## Data Corrections Applied
* **HBT02 at HB05-Nak Niwat48:**
  * Mode changed to `finished_goods`.
  * Adjusted stock by `+11` cups.
  * Target quantity restored: `24` cups.
  * Unique correction movement log created with key: `HBT02_BATCH1_CORRECTION_20260629`.

---

## Post-Release Verification Status
* Automated integration tests (19/19) passed.
* Production smoke tests (POS sale, stock check, void, double-void prevention, rollback checks) verified successful.
