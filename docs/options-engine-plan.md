# Recipro — BOM-aware POS Options/Modifier Engine (implementation spec)

Designed via multi-agent workflow + adversarial review (2026-06-18). User chose: **build all phases**, **add COGS/margin report column**, **per-add-on quantity**.

## Core decisions
- Option groups are **per-shop**. Each choice's material links store the **LOCAL material UUID** (no SKU cross-branch join — SKUs are empty/unreliable in prod). Cross-branch reuse = Phase 4 "copy to branch + manual re-bind".
- Add **`role`** (text) to recipe items (e.g. `milk`, `sweetener`). REPLACE/QUANTITY target a **role**, never a name/sku.
- Hot/Cold/Size = **packaging groups** (ADD/QUANTITY on cup/lid/straw/bag), NOT RECIPE_VARIANT. RECIPE_VARIANT only for genuinely different whole BOMs.
- Everything gated behind a per-shop **feature flag** (`shop_settings.options_engine` bool). Legacy `recipes.opt_groups` kept as fallback (do not drop).

## Data model (frontend in-memory, camelCase)
```
optionGroups = [{ id, label, selectType:'single'|'multi', required, minSelect, maxSelect, sort, enabled, recipeIds:[id], choices:[Choice] }]
Choice = { id, label, priceAdd:number(neg ok), enabled, isDefault, sort, maxQty:int(>=1, for add-ons), effect:Effect }
Effect:
  { type:'NONE' }
  { type:'ADD',     links:[{matId, amount}] }            // extra deduct
  { type:'REPLACE', targetRole, links:[{matId, amount}] } // swap a role's ingredient
  { type:'QUANTITY', targetRole, amount }                 // set amount of role's ingredient (0=remove)
  { type:'RECIPE_VARIANT', variantRecipeId }              // swap whole BOM
recipe.items = [{ matId, amount, role }]   // role default ''
recipe applicable groups = optionGroups.filter(g => g.recipeIds.includes(recipe.id))  (+ legacy r.optGroups fallback)
```
Amounts are in the material's **base unit** (`baseU(mat)` / `perBase(mat)`).

## Bill item (items_json, no schema change)
```
{ recipeId, qty, price(=sell+sum priceAdd*choiceQty, set at confirm),
  choices:[{groupId,groupLabel,choiceId,choiceLabel,priceAdd,qty}],
  options:{[groupLabel]: '/'-joined labels}   // derived back-compat for legacy report/receipt
  effectiveBom:[{matId,name,amount,costPerBase,lineCost}], lineCost }
```

## resolveLineBOM(recipe, chosenChoicesWithQty) -> { bom:Map<matId,{amount,source}>, priceAdd, lineCost, problems[] }
1. priceAdd = Σ choice.priceAdd * choiceQty.
2. base = clone(RECIPE_VARIANT ? variant.items : recipe.items). Map by matId (merge dup). Build role->matId index. (variant must restate touched roles; else REPLACE→ADD+warn.)
3. REPLACE (before QUANTITY): find base entry with item.role===targetRole → delete (not deducted/costed). Add links (sum). Update role index → new matId. No role match → degrade to ADD+warn. Unresolved matId → BLOCK.
4. QUANTITY: role index → matId. amount<=0 → delete. else SET amount. unresolved → BLOCK.
5. ADD: add links * choiceQty (sum).
6. drop amount<=0. lineCost = Σ perBase(mat)*amount.

## Checkout (two-phase atomic, replaces posCheckout deduct block)
- A: resolveLineBOM each line; BLOCK → abort naming line. Aggregate need: matId→Σ amount*qty.
- B: any matStockBase(mat) < need → abort with shortage alert (existing format), zero partial deduct.
- C: commit mat.stock -= need. Snapshot it.price/choices/options/effectiveBom/lineCost.
- FG mode (makeToOrder=false): still deduct option-introduced material deltas (source!=='base') + r.fgStock -= qty.

## POS sheet (showPosOptSheet/selectPosOpt/confirmPosOpt)
- groups via optionGroups.filter(recipeIds includes r.id) + legacy fallback.
- single=radio, multi=checkbox(Set, min/max), per-add-on qty stepper (maxQty).
- chip shows +฿; DISABLED (grey, toast) when !enabled OR insufficient branch stock (net of other selected). data-attributes + delegation (NO interpolated-label onclick — esc doesn't escape ').
- live total = sell + Σ priceAdd*qty on confirm button. Required enforced.

## Money paths to patch (use it.price not r.sell)
renderPosCart line total; posCheckout subtotal; bill-item builder. Set it.price at confirm.

## Report
Aggregate option ranking from structured it.choices (each its own row). COGS/margin column from frozen it.lineCost.

## Postgres (additive; new file backend/db/schema-options.sql after schema-extend.sql)
- option_groups(id,shop_id,label,select_type,required,min_select,max_select,sort,enabled)
- option_choices(id,group_id,label,price_add,effect_type,enabled,is_default,sort,max_qty,target_role,variant_recipe_id)
- option_choice_links(id,choice_id,material_id,amount)
- recipe_option_groups(recipe_id,group_id,sort, pk(recipe_id,group_id))
- alter recipe_items add column role text
- alter shop_settings add column options_engine boolean default false
- DO NOT add materials sku unique index. DO NOT drop recipes.opt_groups.

## Sync/bootstrap
sync.js: upsert option_groups/option_choices (by id); delete+reinsert option_choice_links/recipe_option_groups (like recipe_items); add role to recipe_items insert. bootstrap.js: 4 new queries + ri.role passthrough. applyBootstrapData maps → optionGroups[], recipe.items[].role, group.recipeIds. Migration script lifts legacy opt_groups → NONE-effect groups (idempotent, lossless).

## Phases
0. Schema + round-trip plumbing (no behavior change).
1. Options manager page + POS engine (ADD/REPLACE/QUANTITY/NONE) + per-add-on qty + it.price + stock check/disable + report rows + COGS column + migration. Behind flag.
2. RECIPE_VARIANT + FG-mode material deltas.
3. Reporting hardening (COGS/margin verified, structured choices).
4. Cross-branch copy-to-branch (superadmin, manual re-bind).

## Worked example (must hold)
Classic Matcha Latte + Cold + Cool Pack + Oat Milk + Maple Syrup + หวาน 10g →
deduct: Matcha 5g, Oat Milk 150ml, Maple Syrup 10g, green lid 1, 400ml cup 1, straw 1, single-cup bag 1, ice-pack bag 1. NOT fresh milk / plain syrup.
(Cold=packaging group; Oat Milk=REPLACE role 'milk'; Maple Syrup=REPLACE role 'sweetener'; หวาน 10g=QUANTITY role 'sweetener' amount 10.)
