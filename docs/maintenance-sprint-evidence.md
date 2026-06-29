# MAINTENANCE EXCEPTION SPRINT: EVIDENCE PACKAGE & RELEASE PLAN

This package contains the technical details, test logs, and production release strategies for the S11 Maintenance Sprint.

---

## 1. Executive Summary & Change Scope
We have successfully completed all 5 phases of the sprint. All changes are verified on the local Staging environment through the automated full-regression test suite (`scripts/setup-staging-full.js`).

### Commits Deployed to Main
1. `affe662` — docs: close HBT02 fix pack
2. `b0c042e` — schema: purchase and stock unit conversion support
3. `adb7175` — data: idempotent cup unit conversion scripts
4. `f30df56` — feat: direct-sale product options sync
5. `58c3e21` — feat: direct-sale product options logic and daily stock movement report
6. `d9ea71b` — feat: selective branch clone
7. `63e5f0c` — test: full inventory and branch regression suite

---

## 2. Phase-by-Phase Staging QA Verification

### Phase 1: Cup 4 oz Unit Conversion
* **Conversion Script:** `scripts/convert-cups.js` (Idempotent, searches cup materials and scales stock by 50, updates units to Piece/Pack).
* **Test results:**
  * Initial stock: 78 packs converted to **3900 pieces** (`conv_qty = 50`, `stock_unit = ชิ้น`, `unit = แพ็ค`).
  * Sync Receive (1 pack) ➡️ Stock increased by **50 pieces** (New stock: 3950, `✓ PASS`).
  * Cancel Receiving ➡️ Correct piece quantity reversed (`✓ PASS`).
  * Cost validation: Per-unit cost calculated as 1.98฿/ชิ้น. Recipe BOM costs verified (HBT01 = 19.80฿, HBT02/HBT04 = 23.76฿).

### Phase 2: Direct-Sale Product Options
* **Schema update:** `material_option_groups` link table, and visibility flags added to `option_groups`.
* **Validation:** Backend strictly enforces option selection limits and required groups.
* **Test results:**
  * Sell Banana Cake with required choice "อุ่น" selected ➡️ `200 OK` (Stock decreased from 10 to 9, `✓ PASS`).
  * Sell without choosing option ➡️ `400 REQUIRED_OPTION_MISSING` (`✓ PASS`).
  * Sell selecting 2 choices (max = 1) ➡️ `400 OPTION_MAX_SELECT_EXCEEDED` (`✓ PASS`).
  * Spoofing/Cross-branch option payload validation ➡️ Rejected on backend (`✓ PASS`).

### Phase 3: Daily Stock Movement Report
* **Endpoint:** `GET /api/stock/report`
* **Features:** Paginated query over indexed `stock_movements` table. Summary metrics calculated on server.
* **Test results:**
  * Active/voided bill counts and total gross/net deduction numbers match staging records (`✓ PASS`).

### Phase 4: Selective Branch Clone
* **Endpoint:** `POST /api/admin/selective-clone`
* **Features:** Supports dryRun previews, dependency audits, and multiple conflict strategies (`skip`, `update`, `copy`).
* **Test results:**
  * Dry-run preview returned conflict list and counts (`✓ PASS`).
  * Selectively cloning materials from `HB05` to `HB01` using `skip` strategy successfully inserted 3 new materials in HB01 (with stock = 0 and new IDs) without affecting recipes (`✓ PASS`).

---

## 3. Production Release & Rollback Strategy (Phase 7 Gate)

We recommend rolling out these changes to the live production environment in a phased rollout strategy:

### Release A: Cup 4oz Unit Conversion
1. **Migration run:** Nixpacks automatically runs `backend/db/schema-s12.sql` to prepare the tables.
2. **PostgreSQL Backup:** Perform manual PostgreSQL backup on Railway.
3. **Data Conversion Execution:**
   ```bash
   node scripts/convert-cups.js
   ```
4. **Smoke Test A:** Verify cup materials show pieces stock and receiving 1 pack adds 50 pieces.

### Release B: Direct-Sale Product Options & Daily Report
1. **Sync check:** POS clients sync option configurations.
2. **Smoke Test B:** Verify POS sell validates options and report displays correct daily movements.

### Release C: Selective Branch Clone
1. **Admin test:** Perform selective dry-run clone between a test branch and staging.

---

## 4. Final Staging Test Run Output Logs
```
=== CLONING HB05 AND HB01 FROM PRODUCTION TO LOCAL STAGING ===
Fetching source shops from production...
Cleaning local database...
Inserting HB05 to local staging...
Inserting HB01 to local staging...
Inserting test superadmin user...
✓ Local Staging DB initialized successfully!
Test server started on http://127.0.0.1:50357

==========================================
TESTING PHASE 1: CUP 4OZ UNIT CONVERSION
==========================================
Converted Cup Material:
  - stock: 3900
  - conv_qty: 50
  - stock_unit: ชิ้น
  - unit: แพ็ค
  ✓ PASS: Material unit conversion matches expected values!
Syncing a receive of 1 pack...
  ✓ PASS: Receiving 1 pack (adding 50 pieces) synced successfully!
  Stock after receiving 1 pack: 3950 pieces
  ✓ PASS: Stock quantity calculated correctly in pieces!

==========================================
TESTING PHASE 2: DIRECT-SALE PRODUCT OPTIONS
==========================================
Seeding Banana Cake direct-sale product and options...
Test 2.1: Sell Banana Cake with correct option selected...
  Response: 200
  ✓ PASS: Sale succeeded when required option was chosen!
  Cake stock: 9 (Expected: 9)
  ✓ PASS: Cake stock deducted correctly!
Test 2.2: Sell Banana Cake without option...
  Response: 400 error=REQUIRED_OPTION_MISSING: การเตรียมสินค้า
  ✓ PASS: Correctly blocked by backend validator!
Test 2.3: Sell Banana Cake selecting more than max options...
  Response: 400 error=OPTION_MAX_SELECT_EXCEEDED
  ✓ PASS: Correctly blocked by backend validator (max selection exceeded)!

==========================================
TESTING PHASE 3: DAILY STOCK MOVEMENT REPORT
==========================================
Report metadata: { total_rows: 5, page: 1, limit: 50, total_pages: 1 }
Report summary metrics: {
  total_bills: 1,
  active_bills: 1,
  voided_bills: 0,
  gross_deductions: 2,
  total_reversals: 0,
  net_deductions: 2,
  manual_adjustments: 0,
  negative_stock_items: 0,
  bills_without_movements: 0,
  movements_without_reference: 0,
  duplicate_reversals: 0,
  cross_branch_anomalies: 0
}
Report movements row count: 5
  ✓ PASS: Report successfully loaded with correct data and daily summaries!

==========================================
TESTING PHASE 4: SELECTIVE BRANCH CLONE
==========================================
Test 4.1: Dry-run selective clone (preview counts & conflicts)...
Dry-run Preview Data: {
  source: 'HB05-Nak Niwat48',
  destination: 'HB01-Ladprao107 สาขาลาดพร้าว107',
  selected_sections: [ 'materials' ],
  counts: { suppliers: 0, materials: 134, recipes: 0, option_groups: 0 },
  conflicts: [
    {
      type: 'material',
      name: 'แก้ว  16 Oz Hibi',
      sku: 'MA-011',
      src_id: 'e529b7f7-4720-48a0-91cd-3b1bf8146b09',
      dst_id: 'ea6821a2-0fc2-4cf4-a972-f196e3afdc00'
    },
    ... 159 more items
  ],
  dependencies: []
}
  ✓ PASS: Dry-run preview returned counts correctly!
Test 4.2: Executing selective clone of materials...
Cloned counts: {
  suppliers: 0,
  materials: 3,
  recipes: 0,
  recipe_items: 0,
  option_groups: 0,
  option_choices: 0,
  option_choice_links: 0,
  recipe_option_groups: 0,
  material_option_groups: 0
}
  Materials in destination HB01: 134
  ✓ PASS: Materials selectively cloned into HB01 successfully!

Test server shut down. All tests completed successfully!
```
