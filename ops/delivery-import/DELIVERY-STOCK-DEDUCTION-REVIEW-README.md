# DELIVERY STOCK DEDUCTION REVIEW — 22–30 JUNE 2026

**⚠️ THIS IS A REVIEW REPORT ONLY. NO STOCK HAS BEEN DEDUCTED.**

Shows what **would** be deducted if each of the 8 aggregate Delivery Drafts were eventually
confirmed. Read-only: no INSERT/UPDATE/DELETE, no migration, no Draft modification, no stock
movement, no COGS/revenue, no settlement, no deployment. The 8 Drafts remain `status='draft'`,
`stock_deducted=false`, items `stock_mode='HOLD_FOR_REVIEW'`.

Data: `DELIVERY-STOCK-DEDUCTION-REVIEW-22-30-JUNE-2026.csv` (1205 rows). One row per
(draft × staged line × BOM ingredient); material lines deduct 1:1; held rows carry no deduction.
Proposed material qty = ingredient amount × line qty ÷ batch_yield (read-only snapshot of prod BOM).

## Sections (see `section` column)
1. `READY_TO_DEDUCT_LATER` — verified same-shop recipe/material mappings + their proposed ingredient
   deductions.
2. `HOLD_COOL_PACK` — 727 units (no Cool Pack menu, no packaging mapping).
3. `HOLD_BLUSH` — 3 units (no code, no target ID).
4. `HOLD_HBD11P` — 1 pack (pack/piece ambiguity; candidate `Mochi Butter Bun 5ea/Pack`).
5. Data-quality flags carried inline (`exception_status` / `review_status`).

## Summary
| Metric | Value |
|---|--:|
| Total source units | 3546 |
| Total staged (ready-for-later-review) units | 2815 |
| Total held units | 731 |
| Held — Cool Pack | 727 |
| Held — Blush | 3 |
| Held — HBD11P | 1 |
| Held by shop | HB01 124 · HB02 307 · HB03 118 · HB04 182 |
| Held by platform | LINE_MAN 238 · GRAB 493 |
| Recipes involved | 196 |
| Materials involved | 42 |
| **Unresolved ingredient links (recipe_items with no material)** | **272** — would NOT deduct |
| Name-only (material) staged lines | 76 — confirm exact material before deduct |
| Source-name/catalog mismatch lines (`HBC01M06C` Uji→Yame) | 4 |

## Data-quality warnings
- **272 ingredient links unresolved** — many recipes carry a `recipe_items` row whose material is
  null/deleted; on confirm those specific ingredients would be silently skipped (the recipe's other
  ingredients still deduct). Fix the recipe definitions before relying on delivery COGS.
- **76 name-only material mappings** — desserts/resale items matched by normalized name (materials
  have no code); confirm the exact material per shop.
- **`HBC01M06C`** — source "Uji Okumidori" resolved to catalog "Yame Okumidori" by code (4 units).
- **Unit conversion** — `HBD11P` pack↔piece unverified (held).

Nothing here is executed. Awaiting the Founder's final reviewed summary.
