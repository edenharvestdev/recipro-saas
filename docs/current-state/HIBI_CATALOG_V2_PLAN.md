# HIBI Catalog V2 + POS Menu UX — planning package (no writes)

Stacked on `feat/option-stock-effect-engine-v1` (PR #21). **Planning only** — no production writes,
no Delivery changes, no historical deduction, no merge/deploy. Master base = **HB05-Nak Niwat48**.

## 1. Source shop confirmed
- **HB05-Nak Niwat48** · id `c5cbb867-c3c6-40c2-8396-b6893da09b37` · unique match (1 of 15 shops; no
  ambiguity). This is the same branch used for prior "HB05 Owner" QA.

## 2. Current audit (read-only)
- recipes **115** (on-menu 102, produced/raw 8) · materials **153** (RAW 55, uncategorised 53, SALE 18,
  PACKAGING 11, SUPPLIES 8, SEMI 8; only **1** missing SKU) · option groups **30** · option choices **84**.
- option effect distribution: **NONE 59**, REPLACE 24, ADD 1 (no QUANTITY / RECIPE_VARIANT).
- recipe_items **384**, **unresolved-material links = 0** (clean BOM — unlike HB01-04's 272).

## 3. Legacy problems found
- **59/84 choices are NONE** (info-only) — sweetness / ice / temperature don't affect stock; toppings &
  Cool Pack barely modeled (**only 1 ADD** choice) → add-ons/packaging not deducting.
- **53 uncategorised materials** (item_type none) → ambiguous stock behaviour.
- **Packaging not tied to options** — cups/lids/bags are materials but not attached to menus/options.
- Cool/Separate Pack modeled as **temporary separate menus**, not options → double-count risk (seen in
  the delivery import: base + pack both under one code).
- Single-effect-per-choice legacy model can't express multi-effect (base + produced + packaging).

## 4. Catalog V2 structure (layers)
A **Core Menu**: base drinks · bakery/dessert · ready-to-sell · seasonal · archive.
B **Variants**: hot/iced · size · milk type · sweetness · separate/Cool Pack · toppings · add-ons.
C **Option Groups**: single/multi · required/optional · max-select · price adj · stock-effect behaviour.
D **Stock Effects** (new engine): MATERIAL / PRODUCED_ITEM / FINISHED_GOOD / RECIPE_COMPONENT / PACKAGING / NO_STOCK.
E **Packaging Sets**: normal cup · latte cup · clear-drink cup · coconut set · **separate/Cool Pack set** · bakery set.

## 5. Menu code standard (proposed, not final)
`HBM`=Matcha Milk · `HBC`=Clear Matcha · `HBR`=Refresher · `HBD`=Dessert/Bakery · `HBT`=Topping ·
`HBP`=Packaging. Separate/Cool Pack suffix `-CP` (e.g. `HBC01M21C` → `HBC01M21C-CP`). Packaging sets
`HBP-<set>` (e.g. `HBP-COOL`). One code per SELLABLE; variants via options, not new codes, where possible.

## 6. Option group standard
Standard groups: Sweetness · Milk Type · Ice/Separate Pack · Toppings · Add Cream/Cloud · Packaging ·
Temperature · Size · Special Instructions. Each defines: required? · single/multi · default · max ·
display order · price adjustment · stock-effect behaviour · POS-visible · public-visible · print-to-kitchen.

## 7. Stock effect standard (maps to Option Engine V1 actions)
- Sweetness 50% → **MULTIPLY** syrup 0.5 · No syrup → **REMOVE** syrup.
- Oat milk → **REMOVE** fresh milk + **ADD** oat milk (or **REPLACE**).
- Matcha Cloud → **ADD** PRODUCED_ITEM Matcha Cloud (+ **ADD** PACKAGING dome lid if needed).
- Toppings → **ADD** MATERIAL/PRODUCED_ITEM (own qty).
- Separate/Cool Pack → **ADD** PACKAGING set (+ base beverage already counted) OR separate menu w/ full
  beverage + packaging. Temperature/size = NO_STOCK unless they change recipe/cup.

## 8. Cool Pack / Separate Pack model
Per Separate-Pack item define: base beverage recipe · packaging set · customer name · internal code
(`-CP`) · stock effects (base recipe + packaging set) · **sold as option choice (recommended)** vs
separate menu · migration path (temporary separate menu → option with PACKAGING effects, no double count).
**Recommended:** Cool Pack = an **option choice** on the base drink with `ADD PACKAGING` effects (the base
beverage is already deducted by the base menu) → no double count, one code, clean reporting.

## 9. POS UX improvement plan (approved to improve)
Current: category sub-tab bar, product cards, option-picker sheet, cart, scan/search box (Enter-to-add).
Gaps: option dropdowns jump by first char only (fixed by the new normalized search); long menu names;
Cool/Separate-Pack not visually distinct; toppings/stock-effect not signalled on the cart line.
Proposed (no bill-lifecycle / payment change): cleaner category grouping + quick filters · **normalized
menu search** (Thai vowels/multi-char/SKU) · **option summary + badges on each cart line** · clear
**"แยกแพ็ค"** label + icon · **stock-effect warning badge** on options that deduct · larger staff buttons ·
1024×600 SUNMI layout, no horizontal overflow · optional favorites/recently-used quick buttons.

## 10. HIBITEST plan (create only after explicit approval)
Clone **catalog only** from HB05-Nak Niwat48 (recipes, materials, option groups/choices, packaging) via
the existing superadmin clone (`/api/admin/clone-shop2` or export→import) with a **catalog-only filter**.
**Exclude:** bills, orders, Delivery, stock movements, **stock balances (start all at 0)**, customers,
members, payments, settlements, staff, real printers, payment keys, PromptPay/bank. Test Owner = a
dedicated throwaway email **outside** the HB HQ membership (so HIBITEST never appears in HQ/consolidated
reports). **Do not create without Founder approval.**

## 11. Migration / rollout
P1 **Catalog V2 Preview** (this doc) → P2 **HIBITEST build** (clone + configure V2 options/effects/
packaging + POS/stock/void tests) → P3 **Founder review** (names/codes/packaging/option behaviour/POS
usability) → P4 **Operational rollout** (pick branch + date, freeze legacy edits, import V2, archive/hide
old menu, preserve historical bills, staff training). **Do not execute P2+ without approval.**

## 12. Risks / limitations
Cross-branch code/packaging consistency; 53 uncategorised materials need typing before PACKAGING effects;
double-count if Cool Pack modeled as both menu AND option; staff retraining; the live Option Engine stays
OFF until the POS cutover is approved; historical Excel/Delivery mapping remains frozen until V2 approved.

## 13. Recommended next build phase
**Phase 2 — HIBITEST build** (after your approval to create HIBITEST): clone HB05 catalog → HIBITEST,
then configure Catalog V2 option groups + stock effects + packaging using the Phase C/D engine, and run
POS + stock-deduction + void/correction tests entirely inside HIBITEST (engine ON in staging only).
