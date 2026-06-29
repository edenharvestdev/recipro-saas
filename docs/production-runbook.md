# PRODUCTION RUNBOOK — S11/S12 RELEASES

This runbook outlines the deployment and verification procedures for the Recipro S11/S12 Maintenance Sprint.

---

## 1. Pre-Deployment Procedures

### 1.1 DB PITR Backup Verification
Before performing any structural schema changes or running data conversion scripts, ensure a Point-in-Time Recovery (PITR) backup is created:
1. Log in to the **Railway Console**.
2. Navigate to the **Postgres** service settings tab.
3. Verify that the **Postgres-PITR** bucket contains recent transaction logs.
4. Record the Backup Timestamp before proceeding.

### 1.2 Health Checks
Verify that the server is online and responding to health queries:
```bash
curl https://www.recipro.love/health
```
Expected output:
```json
{ "ok": true }
```

---

## 2. Structural & Data Conversion

### 2.1 Database Migrations
Migrations are applied automatically via `backend/src/migrate.js` when the Nixpacks build starts:
* Schema changes: `backend/db/schema-s12.sql` adds the `material_option_groups` table, indexes, and option group columns.

### 2.2 Cup 4 oz Conversion Script
Run the conversion script to scale the 4 oz cup stock from packs to pieces:
1. Run in dry-run mode to verify expected changes:
   ```bash
   DATABASE_URL=<PROD_DB_URL> node scripts/convert-cups.js --dry-run
   ```
2. Verify output matches the expected piece calculations:
   * **HB05 (Nak Niwat48):** 78 packs ➡️ 3,900 pieces
   * **HB04 (Saphan Khwai):** 78 packs ➡️ 3,900 pieces
3. Execute the actual conversion:
   ```bash
   DATABASE_URL=<PROD_DB_URL> node scripts/convert-cups.js
   ```
4. Verify idempotency by running the script again (it must skip all branches).

---

## 3. Post-Deployment Verification

### 3.1 Option Rules Validation Smoke Test
Verify backend options validation is working on the live production server:
1. Add a required option group to a test product.
2. Attempt a checkout without selecting the option ➡️ expect `400 REQUIRED_OPTION_MISSING`.
3. Checkout with option ➡️ expect `200 OK` and product stock deduction.

### 3.2 Daily Stock Movement Report
1. Verify the `GET /api/stock/report` endpoint returns daily transaction records and summary metrics.
2. Check that the response time is within acceptable limits.
