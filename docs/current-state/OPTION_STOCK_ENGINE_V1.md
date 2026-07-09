# Option Stock Effect Engine V1 — audit, design, status

Branch `feat/option-stock-effect-engine-v1`. **Additive + OFF by default** (flag `OPTION_STOCK_ENGINE_V1`).
No production migration, no live behavior change, no Delivery changes. Not merged/deployed.

## Phase A — current flow audit
- **Shared engine:** `backend/src/stockEngine.js` used by POS (`/api/pos/sell` via `api/sync.js`/`api/stock.js`) and Delivery (`api/delivery.js`). All deduction is inside a pg transaction, shop-scoped, logged to `stock_movements`.
- **Current option model (single-effect):** `option_choices` has ONE `effect_type` ∈ NONE / ADD / REPLACE / QUANTITY / RECIPE_VARIANT, with `target_role` / `target_material_id` / `variant_recipe_id` / `amount`; `option_choice_links(choice_id, material_id, amount)` supports multi-material ADD/REPLACE payloads; `recipe_items.role` enables role-based targeting.
- **Existing resolver:** `buildEffectiveBom(c, recipeId, chosenOptions)` applies RECIPE_VARIANT → REPLACE → QUANTITY → ADD into a `Map(material_id → amount)` + sub-recipes. **Materials only**; no explicit PRODUCED_ITEM / FINISHED_GOOD / PACKAGING typing; no MULTIPLY / NO_STOCK; **one effect per choice**; BOM is recomputed at deduction time (no immutable snapshot on the line).
- **Validation:** `validateOptionsForLine` enforces required / min / max_select / max_qty.
- **Void/correction/reversal:** `reverseMovements` reverses a bill/batch's deduct movements idempotently (unique `reversal_of`), restoring material stock + recipe fg_stock. Bill lifecycle void/correct in `api/bills.js`, delivery in `api/delivery.js`.
- **Legacy material-only bindings:** direct-sale materials (`item_type` SALE/PACKAGING) deducted 1:1 via `deductMaterial`, gated by `item_categories.is_stock_deducted`.
- **Backward-compat risks identified:** (1) the live path must keep using `buildEffectiveBom` until the engine is enabled; (2) any new table must not alter existing option rows; (3) reversal reads `stock_movements` by id — unaffected by the new snapshot; (4) COGS (`computeRecipeCostPerUnit`) reads `recipe_items` — must also consume the effective snapshot only when the engine is on.

## Phase B — design (this PR)
- **Additive schema** `db/schema-option-effects.sql` → `option_stock_effects` (choice_id, shop_id, seq, `target_type` ∈ MATERIAL/PRODUCED_ITEM/FINISHED_GOOD/RECIPE_COMPONENT/PACKAGING/NO_STOCK, `target_ref_id`, `action` ∈ ADD/REMOVE/REPLACE/MULTIPLY/NO_STOCK, `amount`, `unit`, `replace_ref_id`, `target_role`). One choice → 0..N effect rows. Existing tables untouched.
- **Effective-BOM resolver** `src/option-engine/effective-bom.js` — a **pure, deterministic** function: base BOM (per unit) + flat effect list → one Effective BOM `{lines, trace, warnings}`. Fixed apply order NO_STOCK → REMOVE → REPLACE → MULTIPLY → ADD; ties broken by (target_type, ref_id, source). `scaleSnapshot(snapshot, lineQty)` scales for deduction. **The `lines` array IS the immutable resolved-effect snapshot** — deterministic ⇒ safe to persist on the sale/bill line.
- **Deduction/rollback (future Phase C wiring):** when the engine is ON, the resolved snapshot drives `deductMaterial` / recipe-fg / produced-item deduction inside the existing transaction; `reverseMovements` already handles reversal by movement id, so void/correction stays correct. When OFF, `buildEffectiveBom` remains the sole live path.

## Backward-compatibility plan
- Flag `OPTION_STOCK_ENGINE_V1` (default OFF). While OFF: schema table may exist empty; POS / online / delivery deduction use the **unchanged** legacy path; zero behavior change.
- When ON (future, Founder-approved): choices with `option_stock_effects` rows use the new resolver; choices without rows fall back to legacy `effect_type`. Migration is additive/idempotent → rollback = disable the flag (no data migration to undo); table can remain.

## Implementation status (this PR)
| Area | Status |
|---|---|
| Additive schema (`option_stock_effects`) | ✅ done (registered in migrate.js; local-only) |
| Effective-BOM resolver (multi-effect, deterministic, snapshot) | ✅ done + unit-tested (20 cases incl. A–E) |
| Feature flag `OPTION_STOCK_ENGINE_V1` (default OFF) | ✅ defined; **no live wiring** |
| Backend CRUD / same-shop validation / atomic deduction wiring | ⏭ Phase C — deferred (gated) |
| Admin UI (multi-effect rows, target selector, **searchable combobox**, preview) | ⏭ Phase D — deferred |
| POS integration | ⏭ Phase E-1 — deferred, gated OFF (POS deduction unchanged now) |
| Online-order integration | ⏭ Phase E-2 — deferred, gated OFF |
| Delivery confirmation | ⏭ behind disabled compatibility gate; **8 historical Drafts untouched** |
| Void / correction / reversal | ✅ unchanged (reversal by movement id already correct); no new path yet |

## Representative test coverage (`test/option-engine.test.js`, 20/20)
A Cool Pack (base beverage + 4 packaging ADDs) · B Matcha Cloud (produced item + packaging) · C milk REPLACE (ref + role) · D no-syrup REMOVE · E one option → 3 effects (material + produced + packaging) · MULTIPLY · NO_STOCK ignored · order-independent determinism · snapshot scaling · empty/invalid-target safety.

## Risks / limitations
- Live deduction is **not** wired yet — this PR is the tested foundation, not a live cutover.
- The resolver assumes the caller expands `recipe_items` → base lines and `option_stock_effects` → effects (Phase C adapter).
- Recipe BOM data quality: **272 `recipe_items` rows have no linked material** (from the delivery review) — these would still be skipped; recommend cleanup before enabling COGS on the new engine.
- PRODUCED_ITEM / FINISHED_GOOD deduction semantics (deduct produced-stock vs re-expand its recipe) to be finalized in Phase C.

## HIBITEST (isolated QA shop) — info only, NOT created
- **Nak Niwas 48 source candidate:** no shop named "Nak Niwas 48 / นาคนิวาส48" appeared in the earlier authorized shop list (HB01 Ladprao107, HB02 Samyan, HB03 Nawamin111, HB04 Saphan Khwai, + empty "Recipro สาขาสะพานควาย"). **Verify read-only** (`shops.name ILIKE '%นาคนิวาส%'`) before any clone. If absent, the safe clone SOURCE = the branch sharing Nak Niwas 48's code variant (M21C) with the closest menu — **HB03-Nawamin111** or **HB02-Samyan**.
- **Safe clone plan:** use the existing superadmin clone (`/api/admin/clone-shop2` / export-shop → import-shop) to copy **catalog only** (recipes / materials / options), **no bills / stock movements / sales**, into a new `HIBITEST` shop.
- **Test Owner email requirement:** a dedicated throwaway address (e.g. `hibitest-owner@…`), **not** a real staff/owner email, so HIBITEST auth/permissions are isolated.
- **Report-isolation risk:** a separate `shop_id` isolates per-shop reports, but multi-branch **HQ summary** (`/api/hq-summary`, `/api/my-shops`) includes any shop the Owner is a member of → keep the HIBITEST Test Owner **outside** the HB HQ membership so HIBITEST never appears in consolidated reporting.
- **Do not create HIBITEST without separate Founder approval.**
