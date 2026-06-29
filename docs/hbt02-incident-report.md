# INCIDENT & FIX REPORT: HBT02 INVENTORY INTEGRITY

## Executive Summary
This document summarizes the investigation, fix implementation, staging QA validation, and production deployment of the HBT02 Cream Cheese Topping Inventory Mode and Stock Correction fix.

* **Incident Time:** 2026-06-29
* **Severity:** P0 Stock/Financial Integrity
* **Impacted Branch:** HB05-Nak Niwat48
* **Impacted Product/Recipe:** Topping Cream Cheese (HBT02)

---

## Root Cause Analysis
During Production Batch #1, the actual production yielded **12 units**, but the system registered only **1 unit** of finished goods, creating a discrepancy of **11 units**.
At the same time, the recipe's `inventory_mode` was set to `inherit` (defaulting to Make to Order), causing raw materials to be deducted on sales instead of using the pre-produced Finished Goods (`fg_stock`).

---

## Implementation Summary (Sprint S11)
To address this and prevent future occurrences, we implemented:
1. **Per-Recipe Inventory Mode:** Added `inventory_mode` column (`inherit`, `make_to_order`, `finished_goods`, `non_stock`) to the `recipes` table, allowing each recipe to control its deduction behavior independently of the global store setting.
2. **Strong Reversal Idempotency:** Added a `reversal_of` field with a UNIQUE constraint to `stock_movements` to link reversals directly to sales, ensuring that a bill can only be voided once.
3. **Atomic Sales & Voids:** Unified status updates and stock adjustments in singular database transactions to prevent partial state updates.
4. **Staging QA Automation:** Built a local staging replication test suite to simulate and guarantee the atomic sales, voids, double-void blocks, and transaction rollbacks.

---

## Final Stock Reconciliation (HB05 HBT02)
* **Opening Stock:** 13 cups
* **Founder-Approved Adjustments:** +11 cups
* **Expected Current Stock:** 24 cups
* **Live Production Stock Post-Correction:** 24 cups (Verified!)
* **Production Correction Movement ID:** `932e5b85-5c1c-4092-b8f0-ead27dad5618`
* **Production Correction Reference:** `HBT02_BATCH1_CORRECTION_20260629`

---

## Production Smoke Test Results
A production smoke test (`SMOKE-TEST-HBT02-01`) was executed using superadmin credentials:
1. **POS Sale (HBT02 1 Cup):** Stock decreased from 24 to 23 cups. Ingredients (ผงครีมชีส, น้ำเปล่า, ถ้วย 4 oz) remained unchanged. (`✓ PASS`)
2. **Sale Movement ID:** `c3091c21-7fa4-4d01-8476-799c1bf8811a`
3. **Void POS Bill:** Stock returned from 23 back to 24 cups. (`✓ PASS`)
4. **Void Movement ID:** `84d6b93b-9650-4105-8545-efbee340f8c6`
5. **Reversal Link:** `reversal_of` correctly references `c3091c21-7fa4-4d01-8476-799c1bf8811a` (`✓ PASS`)
6. **Double Void Attempt:** Rejected with `already: true`, stock remained at 24. (`✓ PASS`)
7. **Final HBT02 Stock:** 24 cups.

---

## Known Limitations
* **Cup Unit Mismatch:** The 4 oz cup material is currently configured in "packs" but used in recipes as "pieces". The Cup Unit Conversion Sprint is planned separately (Phase 1) to address this across all branches without affecting HBT02 Fix Pack.
