# Conditional Option Flow V1 — F0 (schema + pure resolver)

Branch: `feat/conditional-flow-v1-f0` · Status: **PR only — not merged, not deployed.**
Feature flag `CONDITIONAL_FLOW_V1` = **false** (default). Empty tables + unwired lib = fully inert.

## Layers (navigation / reuse / stock kept separate)
- **FLOW** (`resolver.js`) — navigation only: visibility, order, SKIP_TO, END_AT_CART, REQUIRE/OPTIONAL.
- **CHOICE/SET** — reusable named collections; a menu references sets by slot (no per-menu duplication).
- **STOCK** — PR #21 `option_stock_effects` + `resolveEffectiveBom` remain the terminal primitive.
  F0 only *assembles* effects into PR #21 shape (`effect-assembly.js`); it never deducts stock.

## Additive schema (`backend/db/schema-conditional-flow.sql`, idempotent, no DROP/RENAME)
`flow_templates` (versioned) · `flow_steps` · `flow_step_rules` · `choice_sets` · `choice_set_items`
· `component_sets` · `component_set_items` · `menu_flow_bindings` · `menu_step_bindings`
· `menu_component_bindings`. All `shop_id`-scoped. `step_key` / `choice_code` are stable VARCHAR
strings (NOT enums) → new shop-specific codes need no migration. `component_set_items` uses PR #21's
exact `target_type` / `action` vocabulary.

## Pure library (`backend/src/conditional-flow/`)
- `resolveFlow(input)` → `{ visibleSteps, currentStep, atCart, resolvedPath, selectedChoices, effects, warnings }`.
  No DB, no writes, no input mutation, deterministic (no Date/random).
- `validateFlow({steps,rules})` → structured errors/warnings (duplicate step, missing target/source,
  invalid op/type, self-loop, direct cycle, conflicting same-priority, END/SKIP conflict, unreachable).
- `checkChoiceCodeRename(code, refs)` → blocks renaming a referenced `choice_code` (F0 = block).
- `assembleEffects(...)` → PR #21-shaped effect rows, deterministic order, dedup (no double application).
- `buildSnapshot(result, template)` → deep-cloned + deep-frozen immutable cart/order snapshot
  (`flow_template_code`/`version`, selected_choices, visible_steps, flow_path, effects).

## Determinism / conflict resolution
Steps by ascending `seq`; rules by ascending `(priority, input-index)` (lower priority = higher
precedence). HIDE wins over SHOW. REQUIRE/OPTIONAL applied in order, last wins. SKIP_TO removes
steps strictly between source/target; earliest matching END_AT_CART truncates after its step.
END_AT_CART + SKIP_TO at the same step & priority → END wins (validator flags it).

## Backward compatibility
- Purely additive. `app.js`/routes/POS/Online-Menu/bills/payment/Delivery unchanged.
- The lib is **not imported by any route** in F0. A menu with no `menu_flow_bindings` keeps today's
  flat option-group behavior. Nothing auto-converts or auto-binds. `CONDITIONAL_FLOW_V1=false` → no
  behavior change anywhere.
- No new runtime dependency (pure JS) — root/backend package manifests untouched (heeds the helmet
  deploy-root rule).

## Tests — `backend/test/conditional-flow.test.js` (44/44)
Flow (linear/required/optional/SHOW/HIDE/SKIP/END/REQUIRE/OPTIONAL) · all 6 operators · validation
(9 cases) · choice-set reuse + immutability · component sets + cross-shop rejection · effect assembly
(choice-only/component-only/both/order/no-double) · snapshot (stable/immutable/deterministic) ·
examples Clear Matcha / Clear Matcha Coconut / Matcha Latte · flag OFF · no input mutation.

## Deferred to F1+ (per Founder)
Admin authoring UI · HIBI Option V2 data import · customer/POS wiring · live POS deduction ·
enabling `OPTION_STOCK_ENGINE_V1` · production migration · real-branch rollout. Await the Founder's
completed HIBI Option V2 spreadsheet before F1.
