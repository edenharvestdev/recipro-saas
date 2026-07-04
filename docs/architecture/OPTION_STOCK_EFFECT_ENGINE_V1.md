# Option Stock Effect Engine V1 — architecture (Phase C + D)

Additive, backward-compatible. **Live sale deduction stays OFF** (`OPTION_STOCK_ENGINE_V1`). This phase
adds the management layer (configure effects) + admin UI; it does not change POS/online/delivery
deduction.

## Data model
`option_stock_effects` (additive; existing option tables untouched):
`id, choice_id→option_choices, shop_id, seq, target_type, target_ref_id, action, amount, unit,
replace_ref_id, target_role, enabled, strict_stock, note`. One Option Choice → **0..N** effects.
- `target_type ∈ MATERIAL | PRODUCED_ITEM | FINISHED_GOOD | RECIPE_COMPONENT | PACKAGING | NO_STOCK`
- `action ∈ ADD | REMOVE | REPLACE | MULTIPLY | NO_STOCK`

## Backend endpoints (mounted under `/api`, `requireAuth`+`tenant`)
| Method | Path | Perm | Purpose |
|---|---|---|---|
| GET | `/option-effects?choice_id=` | `recipe_view` | list effects for a choice (with resolved names) |
| POST | `/option-effects` | `recipe_edit` | create one effect (validated) |
| PATCH | `/option-effects/:id` | `recipe_edit` | update one effect (validated) |
| PATCH | `/option-effects/:id/disable` | `recipe_edit` | soft-disable (never hard-delete) |
| POST | `/option-effects/reorder` | `recipe_edit` | deterministic `seq` reorder |
| GET | `/option-effects/targets/search?q=&target_type=&limit=` | `recipe_view` | shop-scoped combobox search |
| GET | `/option-effects/target-types` | `recipe_view` | the target_type→table map |
| GET | `/option-effects/preview?choice_id=` | `recipe_view` | effect list + net effective lines |

**Permissions:** writes require `recipe_edit`; reads `recipe_view`; owner/superadmin bypass built into
`hasPerm`. Cost preview obeys `canViewCost` (no cost fields returned to no-cost users).

**Validation (every write):** authenticated + current-shop scope; choice belongs to shop; same-shop
target (`CROSS_SHOP_TARGET` / `TARGET_NOT_FOUND`); valid `target_type` / `action`; `NO_STOCK` must pair
type+action; `REPLACE` needs from+with; `amount>0` for ADD/REPLACE/MULTIPLY; **no circular
RECIPE_COMPONENT** (BFS over `recipe_items.sub_recipe_id` vs the choice's parent recipes).

## Target type → physical table
| target_type | source table | id col | label | stock field | unit field | cost source | current limitation |
|---|---|---|---|---|---|---|---|
| MATERIAL | materials | id | วัตถุดิบ | stock | unit | materials.price | materials have no `code`; search uses `sku` |
| PACKAGING | materials | id | แพ็กเกจ/บรรจุภัณฑ์ | stock | unit | materials.price | filtered by `item_type='PACKAGING'` |
| PRODUCED_ITEM | recipes | id | ของผลิต/ของกลาง | fg_stock | yield_unit | recipes.sell_price | semantic; physically recipes (`is_raw=true`) |
| FINISHED_GOOD | recipes | id | สินค้าสำเร็จรูป | fg_stock | yield_unit | recipes.sell_price | semantic; physically recipes (`on_menu=true`) |
| RECIPE_COMPONENT | recipes | id | ส่วนประกอบสูตร | fg_stock | yield_unit | recipes.sell_price | semantic; any recipe (cycle-guarded) |
| NO_STOCK | (none) | — | ไม่มีผลต่อสต๊อก | — | — | — | no stock target |

## Target search (fixes the legacy first-letter dropdown)
`src/option-engine/normalize.js` — Unicode **NFC** normalize + trim + collapse whitespace + lowercase
(English), **substring** match (mid-name), preserves Thai vowels/tone marks. `searchTargets` fetches the
shop's candidate pool for the type and filters in JS on `name + code/sku`, so multi-character Thai
(`นม`, `น้ำมะพร้าว`, `มัทฉะ`, `ไซรัป`), English (`matcha`/`MATCHA`/`Kagoshima`), and code/SKU fragments
(`HBR01`, `HBM01`, `MILK-01`) all match. Shop-scoped (no cross-shop leakage).

## Admin UI (`frontend/index.html`)
Option group editor → each **saved** choice shows **"⚙️ ผลกระทบต่อสต๊อก (หลายรายการ)"** →
`openStockEffects(choiceId)` modal (`.bmm-shell`, viewport-bounded):
- multi **effect rows**: Action, Target Type, **searchable combobox** (custom dropdown, not native
  select), Quantity (label "ตัวคูณ" for MULTIPLY), Unit, strict-stock, active, duplicate-row, remove-row,
  per-row save + validation status.
- **REPLACE** shows *จากเดิม* (from) + *เป็น* (to) comboboxes.
- **NO_STOCK** hides target/qty and shows a note field only.
- **Preview panel** "ผลการตัดสต๊อกต่อการเลือก 1 ครั้ง" (Action · Target Type · Name · Code · Qty · Unit ·
  warning) via `/preview`.
- Thai validation messages mapped from server codes.
- **Legacy binding display:** if a choice still has the legacy single-effect binding (`effect_type≠NONE`),
  it's shown read-only as "Legacy Binding" with an equivalent note; **not** double-applied and **no
  auto-convert button** (omitted for safety — manual migration later).

## Feature flag
`OPTION_STOCK_ENGINE_V1` (default **false**). When false: POS / online / delivery / legacy deduction are
**unchanged**; this phase only saves + previews effects. The resolver (`effective-bom.js`) is not wired
into any live deduction path.

## Known limitations
- Live deduction wiring is Phase E (gated). PRODUCED_ITEM/FINISHED_GOOD deduction semantics finalize then.
- Materials have no `code` column (search uses `sku`); PACKAGING relies on `item_type='PACKAGING'`.
- Legacy auto-convert intentionally omitted.
- Recipe BOM data quality (272 unlinked `recipe_items` from the delivery review) should be cleaned
  before enabling COGS on the engine.
