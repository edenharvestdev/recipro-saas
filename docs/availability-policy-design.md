# Zero-Stock Availability Policy — Design Document

Status: **DESIGN ONLY — no code changed.** Audit performed read-only against
`wt-pos-ops` (branch `feat/pos-operations-manager` @ `12f7cff`, the completed and
merged-nowhere P1) and baseline `main@5c5319f` via `git show`. `git status` was
verified clean in `wt-pos-ops`, `wt-payment-hardening`, and `wt-stock-ux` before
and after this work; nothing in any worktree was modified.

---

## PART 1 — Audit of the current system (file:line cited)

### 1. Current stock warning logic (POS card stock display)

`frontend/index.html`, function `renderPosGrid()` (~8480–8605), three card builders:

- **Materials** (`matCardHtml`, 8503–8518): `stock = Number(m.stock)||0`; `oos = stock<=0`
  (8504–8505). Color tiers only, never a block by themselves: `stockColor = stock>5 ? green
  : stock>0 ? amber : red` (8507); text is `"หมดสต๊อก"` at 0, else `"{stock} {unit}"` (8516).
- **Recipes, `finished_goods` mode** (8570–8583): identical pattern on `r.fgStock`
  (`oos = stock<=0`, 8571–8572).
- **Recipes, `make_to_order` mode** (8539–8568): no `fgStock` concept — instead walks
  `r.items` (the recipe's BOM) and computes `canMake` by checking each sub-recipe's
  `fgStock` or each material's `stock` against the required `amount` (8541–8552). Renders
  `"⚠ วัตถุดิบไม่พอ"` (can't make) / `"⚠ วัตถุดิบใกล้หมด"` (low) / `"พร้อมขาย"` (ok) (8553–8557).
- **Recipes, `non_stock` mode** (8527–8538): no stock concept at all — always sellable from
  the stock angle.

Low/non-zero stock is **always** warning-only color/text in all three modes — this has never
changed. Zero stock is where behavior diverges (next section).

### 2. Current hard-block conditions — where zero-stock actually blocks a sale

There are **two independent layers**, and they are inconsistent across item type/mode. This
inconsistency is the crux of why a single policy needs to be designed carefully.

**Client-side (frontend/index.html) — the card's own onclick wiring:**
- Materials (8510): `clickJs = posCardTapHandler('material', m.id, m, oos ? '' : addMatToCart(...))`
  — when `oos`, the tap expression passed in is the empty string, so tapping does nothing.
- Recipes `finished_goods` (8576): same pattern, `oos ? '' : addToCart(...)`.
- Recipes `make_to_order` (8560): same pattern but keyed on `canMake` instead of `oos`:
  `!canMake ? '' : addToCart(...)`.
- Recipes `non_stock` (8530): never gated by stock — always `addToCart(...)`.

  This confirms baseline `5c5319f` (`git show 5c5319f:frontend/index.html`, lines ~8327,
  8371, 8384) already had exactly this `oos ? '' : addXToCart(...)` pattern — it is **legacy,
  pre-existing behavior**, not something P1 introduced. P1 only added the `posItemAvailability`
  check as a *first* gate ahead of it (see §4/§6) — it never touched the oos/canMake gate.

**Belt-and-suspenders inside the add-to-cart functions themselves** (catches barcode scan /
any other caller that bypasses the card's onclick):
- `addMatToCart(matId)` (8608–8621): `const maxQty = Number(m.stock)||0; if (maxQty <= 0)
  return;` (8615–8616) — silent no-op, no toast, no error, for materials at 0 stock.
- `_addToCartDirect(recipeId, ...)` (8646–8665): `const maxQty = settings.makeToOrder ? 99 :
  (Number(r.fgStock)||0);` (8650) then guards every push with `if (settings.makeToOrder ||
  maxQty > 0)` (8653, 8660) — i.e. for `finished_goods`-effective recipes at 0 `fgStock`,
  nothing is pushed; for `make_to_order`-effective recipes, this guard never fires (always
  `maxQty=99`), so the *only* client-side block for make-to-order is the `canMake` card-tap
  gate above, not this function.

**Server-side (backend/src/api/stock.js, bills.js, delivery.js) — the only real enforcement,
and it is NOT uniform across item types:**
- `stock.js` `/pos/sell` (218–226) and `bills.js` `deductBillLines` (64–68) and
  `delivery.js` item-add (709–718): for **`finished_goods`-mode recipes only**, before
  calling `deductRecipeFg`, each does `if (fg < qty) { throw FG_STOCK_INSUFFICIENT (409),
  e.have=fg, e.need=qty }`. This is the **only actual server-side stock hard-block** in the
  system.
- `stockEngine.js` `deductMaterial()` (201–225) **never throws** on insufficient stock — it
  clamps: `after = Math.max(0, before - amount)` (218). So a material sale, called directly
  (e.g. a modified client bypassing the card UI, or a future integration), **always succeeds
  server-side regardless of stock**, going negative-safe to 0, no error.
- `stockEngine.js` `deductRecipeFg()` (228–237) also never throws by itself — it too clamps
  to `Math.max(0, before-amount)` (230). The throw lives in the *caller* (stock.js/bills.js/
  delivery.js), only for the `finished_goods` branch, never called for `make_to_order`'s
  BOM-expansion path (227–233 in stock.js: `buildEffectiveBom` → `deductMaterial` per
  ingredient, no fg-style check at all).
- **Net effect**: `make_to_order` recipes and direct-sale materials have **zero server-side
  stock enforcement** today — the only thing stopping a sale at 0 stock for those is the
  client-side gates in §2 above. Only `finished_goods` recipes are hard-blocked server-side.

**A relevant existing precedent already in the codebase** — `delivery.js` (663–718, historical
backfill entry only): a narrowly-scoped override already exists there. `overridden =
shortfalls.length>0 && isOwner && allowNegative && negativeReason.length>0` (668); the
`FG_STOCK_INSUFFICIENT` throw is skipped only if `overridden` (715: `if (fg < deductQty &&
!overridden)`), and only for **historical** (`sales_date < CURRENT_DATE`) entries — same-day
Delivery/POS keeps the hard block unchanged (comment at 651–654 says so explicitly). Override
is Owner-only, requires a non-empty free-text reason, and is stamped into the movement `note`
(678: `[neg-override: ${negativeReason}]`) — no dedicated boolean column, no reusable general
mechanism. This is useful precedent for permission-tiering an override, but it is scoped to
one narrow feature (historical Delivery import) and is not wired into POS/bills at all.

### 3. Current POS availability fields

- `recipes.pos_available boolean not null default true`, `recipes.pos_unavailable_reason text
  default null`; identical pair on `materials` — `backend/db/schema-pos-ops.sql:9-12`, plus a
  `char_length<=200` check constraint (16-19), additive/idempotent, registered before
  `seed.sql` in `backend/src/migrate.js`.
- `recipes.on_menu` — pre-existing, unrelated field: "is this recipe part of the menu system at
  all" (inclusion, Concept A). `null` legacy resolves as `!isRaw`
  (`frontend/index.html` — `r.onMenu != null ? !!r.onMenu : !r.isRaw`, used at 8484, 7515,
  7525). Never touched by P1.
- `materials.show_in_pos` + `materials.sale_type` — pre-existing: whether a material is directly
  sellable without a recipe/BOM (`posSellableMats()`). Never touched by P1.
- These four fields (`on_menu`, `show_in_pos`/`sale_type`, the archived-category list, and stock
  itself) are the four **pre-existing, unrelated** concepts documented in
  `docs/pos-operations-architecture.md` §1 as "none of which was a daily-operations close
  switch" — P1's `pos_available`/`pos_unavailable_reason` is the new, fifth, purpose-built axis.

### 4. Manual close/open behavior as implemented in P1

- `posItemAvailability(item)` (8330–8332): pure function, single source of truth —
  `{ available: !item || item.posAvailable !== false, reason: item.posUnavailableReason||null }`.
  Legacy/undefined `posAvailable` reads as available (note the `!== false` test, not `=== true`
  — this is exactly the tri-state problem discussed in §9).
- `openPosAvailabilitySheet()` / `renderPosAvailabilitySheet()` (8377–8449): compact sheet, two
  buttons (พร้อมขาย / ปิดขาย) + six controlled reason chips (`POS_AVAILABILITY_REASONS`, 8327:
  ของหมด, ปิดขายชั่วคราว, ไม่ขายวันนี้, Seasonal, Kitchen unavailable, Other) with free-text only
  for Other, capped 200 chars (8444).
- `posSetAvailability(kind, id, available, reason)` (8358–8373): permission-checks
  `pos_toggle_availability` client-side (8361, UX only — not the real boundary), mutates
  `item.posAvailable`/`item.posUnavailableReason` in memory, pushes one audit entry
  (`posAvailAuditPush`, 8337–8351), re-renders, and lets the existing debounced `saveAll()`
  persist it (no separate/competing auto-save call — comment at 8355–8357 flags this
  deliberately, and flags `syncToSupabase` has no in-flight guard as the reason not to add a
  second save path here).
- Card visuals: `posMgrToggleBtnHtml` (8467–8470, only rendered if `can('pos_toggle_availability')`),
  `posAvailBadgeHtml` (8460–8465, the diagonal `.ppc-closed-ribbon` — CSS at
  `frontend/styles.css:2091-2108`, visually distinct by design from the plain-color
  `.ppc-stock`/`.out-of-stock` treatment at `styles.css:2065-2074`/`2185+`, per the comment at
  `styles.css:2076-2081`), and `.pos-mgr-closed` dimming (`styles.css:2082-2090`, grayscale
  0.85 vs `.out-of-stock`'s grayscale 0.5).
- `posCardTapHandler(kind, id, item, sellableExpr)` (8473–8478): if closed, returns
  `openPosAvailabilitySheet(...)` (for a permitted user) or `posShowUnavailableReason(...)`
  (read-only toast) — **never** falls through to `sellableExpr`. If available, returns
  `sellableExpr` verbatim, i.e. control passes to the pre-existing oos/canMake gate from §2.
  This is the exact precedence already implemented for axis A vs. axis D: **availability is
  checked first and short-circuits; only if available does stock get a say** — which is
  structurally identical to the precedence table this document specifies in Part 2.

### 5. Barcode scan behavior

`posScanEnter(inp)` (`frontend/index.html:7512-7535`): resolves a scanned code/name to a
recipe or material, then calls `addToCart`/`addMatToCart` directly (7521-7522, 7529-7530) — it
does **not** duplicate the availability or stock check; it relies entirely on those two
functions' own internal `posItemAvailability` gate (§4, 8613/8637) and stock clamp (§2,
8616/8650-8660). The only scan-specific logic is toast suppression: it checks
`posItemAvailability(...).available` merely to decide whether to show the "เพิ่ม: x" success
toast or stay silent (since `addToCart`/`addMatToCart` already show their own refusal toast via
`posShowUnavailableReason` — comment at 7518-7520 explains this is to avoid a contradicting
double-toast, not a second security gate).

### 6. Legacy/default row behavior

- Schema: `not null default true` on both tables (`schema-pos-ops.sql:9,11`).
- `sync.js` coercion (151-171, specifically 158-159 for materials and 169-170 for recipes):
  `pos_available: m.pos_available === false ? false : true` / same for recipes — any payload
  that omits the field, sends `null`/`undefined`, or sends anything other than the literal
  `false` is coerced to `true` before the upsert. This was an actual bug fix during P1
  (comment at 154-157): the column went `NOT NULL` but the whitelist-without-coercion would
  have 500'd every sync from four pre-existing unrelated test files the moment the column
  existed. `frontend/index.html:4248-4250`/`4260-4261` (in `syncToSupabase`) mirrors the same
  `m.posAvailable !== false` / `r.posAvailable !== false` logic client-side before the field
  ever leaves the browser.
- `clone.js` (270-323, 586-603): all 6 write sites (materials update/insert, recipes
  update/insert, ×2 call sites) carry `m.pos_available ?? true` / `r.pos_available ?? true` and
  `?? null` for the reason — cloning a shop/payload that predates the column still lands fully
  available.

### 7. Permission checks

- Catalog key `pos_toggle_availability` (`backend/src/permissions/catalog.js:25`), its own group
  entry, deliberately **not** a `recipe_edit` alias, **not** in `LEGACY_ALIASES`, **not** in
  `STAFF_DEFAULTS` (128-132) — a bare staff membership with no preset gets nothing for this key.
  Granted `true` in `front_store` preset (159) and folded into `manager` preset automatically
  (179, `PRESETS.manager` = every key not in `MANAGER_EXCLUDE`, and
  `pos_toggle_availability` is not excluded). Absent from `read_only` (170-173) and
  `production_staff` (165-169).
- **Important role-model note for Part 2's permission matrix**: this codebase has **no `cashier`
  role**. Identity is `owner` (or `isSuperadmin`) vs. a `staff` membership, and a `staff`
  membership is shaped by whichever **preset** it's assigned (`front_store`, `manager`,
  `production_staff`, `read_only`, or `custom` — `catalog.js:156-179`) plus any per-key
  overrides in `shop_settings.staff_permissions`. There is no role literally named "cashier";
  the closest mapping is a staff member on the `front_store` preset (which already carries
  `pos_toggle_availability: true`).
- Resolver `hasPerm()` (137-153): owner/superadmin unconditional bypass (138) → explicit grant on
  the key or any legacy alias wins (146) → explicit `false` (turned off) denies even over a
  default (147, 149) → new-key conservative default (150) → preserved legacy default (151) →
  deny.
- Server enforcement: `backend/src/api/sync-guard.js`. `availabilityChanged(incoming, dbRow)`
  (28-36) is deliberately **change-detection**, not presence-detection — comment at 28-33
  explains why: every brand-new row already carries `pos_available:true` (the frontend's
  default), so treating "row exists in payload" as a change would force every plain
  recipe/material creation by `recipe_edit`-only staff to also need
  `pos_toggle_availability`. It returns true if a **new** row is created in the non-default
  (closed) state (34: `availIn === false || (reasonIn!=null && reasonIn!=='')`), or if an
  **existing** row's tracked fields actually differ from the DB row (`rowChanged`, 39-49,
  which only compares fields the incoming payload actually contains — 46: `if
  (!Object.prototype.hasOwnProperty...) continue`, avoiding false positives from partial
  payloads). The gate itself: `if (availabilityChanged(r, dbById[r.id]) && !has
  ('pos_toggle_availability')) throw deny('POS_AVAILABILITY_PERMISSION_DENIED',
  'recipes.pos_available')` (106-107) and the materials mirror (137-138). `deny()` (8) sets
  `statusCode=403`; thrown inside the same transaction as the rest of `/api/sync`'s writes, so
  denial **aborts the whole sync** (nothing partial persists) — confirmed by
  `sync.js:389-391` mapping any `statusCode===403` to a 403 JSON response with the offending
  `field`. Owner/superadmin bypass this file entirely (its own top check, mirroring
  `checkSyncPermissions`'s early return for `req.isSuperadmin===true || req.role==='owner'`).
- Frontend gating (`can('pos_toggle_availability')` at 8361, 8378, 8468) is **UX-only** — hides
  the toggle icon/sheet and blocks the client function early with a toast, but the actual
  boundary is `sync-guard.js` server-side.

### 8. Audit-log behavior

Client-reported intent (same pattern as the pre-existing `_category_audit`), not a server-side
diff — rationale given at `sync.js:79-83`: the client knows the true "did I mean to close this"
intent, which a before/after diff on the DB row can't always recover (e.g., two concurrent
changes landing in the same sync).

- `posAvailAuditPush(ev)` (`frontend/index.html:8337-8351`): builds one queued entry per toggle
  — `{action:'menu.availability_change', target_type, target_id, target_name, old, new, reason,
  correlation, at}`, caps the in-memory queue at 50 (8349).
- Sent as `_availability_audit` in the `/api/sync` payload (`frontend/index.html:4363`), cleared
  only after a successful sync (comment at 4359-4362).
- `sync.js` `normalizeAvailabilityAudit(list)` (90-118): whitelists `action` to the single value
  `'menu.availability_change'` (84, 95), `target_type` to `recipe`/`material` (85, 96), caps
  every string at 200 chars (89, 97), coerces `old`/`new` to the literal strings
  `'available'`/`'unavailable'` only (105-106), and computes `reason_controlled` (110) by
  checking the reason against the six controlled values **without ever dropping** a
  free-text/legacy-client reason (comment 107-109) — evidentiary completeness over strict
  validation.
- Each normalized entry becomes one `logs` row via `logEvent()` (372-374), fire-and-forget
  (comment 369-371: "audit พัง ต้องไม่ทำให้การบันทึกพัง" — an audit failure must never fail the
  sync), written **after** the transaction commits (after line 357's `client.query('update
  shop_settings set data_version...')`).
- Round-trip proven in `backend/test/pos-operations-roundtrip.test.js` (example row reproduced
  in `docs/pos-operations-architecture.md:136-152`).

### 9. Why a nullable/default boolean cannot distinguish three states

`pos_available` is `boolean not null default true` (§3, §6). A boolean has exactly two values.
The system needs to distinguish **three** meaningfully different states for any override
semantics to be safe:

1. **Never configured** — the row predates or was never touched by any operations-manager
   decision (the overwhelming majority of rows, forever, for any shop that doesn't actively use
   the feature).
2. **Explicitly allowed to keep selling despite stock** — a manager looked at this exact item
   and made an affirmative "sell it anyway, the stock count is wrong" decision.
3. **Explicitly blocked from selling regardless of stock** — a manager (or an owner-level
   safety control) decided this item must never sell right now, independent of what stock says.

`pos_available=true` today is used for **both** "never configured" and (implicitly) "would be
explicitly allowed if that concept existed" — there is no way to write state 2 without also
being indistinguishable from state 1, and every existing row already sits at `true` by
default (§6). If `true` were reinterpreted as "override stock, sell anyway," **every
currently-out-of-stock item, store-wide, in every shop, the instant the code shipped**, would
become sellable — exactly the hazard flagged in `docs/pos-operations-architecture.md` §6 as the
reason the override half of the spec was deliberately left unbuilt. `pos_available=false` (state
3, "closed") is already unambiguous today because it required an explicit action to reach
(`posSetAvailability`) — but conflating "closed because temporarily unavailable" (a selling-state
decision) with "closed because a safety/admin control fired" (a different actor, different
reversibility, different permission tier) inside the *same* single boolean would create the
same two-states-in-one-field problem one level up. Three independent, small-domain fields (one
per axis, see Part 2) is the only representation where "never touched" is structurally
distinguishable from "explicitly decided," for both the selling-state axis and the new
stock-override axis.

---

## PART 2 — Design: minimal central Availability Policy

### Recommended data model

Extend, don't replace, P1's columns. Three axes, three columns, each independently defaulted
so that "the migration ran" is never itself a behavior change:

| Axis | Column | Type | Default | Maps to |
|---|---|---|---|---|
| A. Selling state | `pos_available` (existing) | `boolean not null` | `true` (existing, unchanged) | AVAILABLE / TEMPORARILY_UNAVAILABLE (`pos_available=false` ⇒ TEMPORARILY_UNAVAILABLE, reuses `pos_unavailable_reason` verbatim) |
| B. Stock decision | `pos_stock_decision` (NEW) | `text not null` | `'FOLLOW_STOCK_POLICY'` | `FOLLOW_STOCK_POLICY` \| `MANAGER_OVERRIDE_ALLOW` \| `MANAGER_OVERRIDE_BLOCK` |
| C. Safety block | `pos_admin_blocked` (NEW) | `boolean not null` | `false` | NONE (`false`) / ADMIN_BLOCKED (`true`) |

Plus, for override accountability (mirroring `pos_unavailable_reason`'s pattern and the
Delivery-override precedent in §2 that already requires a reason):
`pos_stock_decision_reason text default null` (same 200-char check-constraint pattern as
`pos_unavailable_reason`, `schema-pos-ops.sql:17-19`), and `pos_admin_blocked_reason text
default null` for the same reason on axis C.

A `check (pos_stock_decision in ('FOLLOW_STOCK_POLICY','MANAGER_OVERRIDE_ALLOW',
'MANAGER_OVERRIDE_BLOCK'))` constraint enforces the enum at the data layer, matching the
existing char_length-check pattern for defense in depth beyond application validation.

This is additive to both `recipes` and `materials`, exactly like P1's two original columns —
same `alter table ... add column if not exists`, same idempotent migration file
(`schema-pos-ops.sql` gets a follow-up `schema-pos-ops-2.sql`, or a new versioned file per this
codebase's existing migration convention in `backend/src/migrate.js`).

### Alternative models considered (and rejected)

1. **Tri-state nullable boolean** (`pos_stock_override boolean default null`, with `null`=never
   touched, `true`=allow, `false`=block). Rejected: doesn't extend to a *third* meaningfully
   different value if a future need arises (e.g. a distinct "temporarily paused override"
   state), reads awkwardly in SQL (`is not distinct from`/`is null` everywhere instead of plain
   equality), and — more importantly — conflates "stock override" and "admin safety block" into
   one column when the spec explicitly requires ADMIN_BLOCKED to be non-bypassable by a
   cashier-tier permission while MANAGER_OVERRIDE_ALLOW/BLOCK should be settable by a
   manager-tier permission; one column can't carry two different permission tiers cleanly.
2. **Single combined enum** (one `pos_state` column: `AVAILABLE | UNAVAILABLE |
   OVERRIDE_ALLOW | OVERRIDE_BLOCK | ADMIN_BLOCKED`, five mutually-exclusive values instead of
   three independent axes). Rejected: the spec's own precedence table requires composing
   states that a single enum cannot express independently — e.g. an item can be
   TEMPORARILY_UNAVAILABLE (a manager closed it for the day) **and separately** carry a stale
   MANAGER_OVERRIDE_ALLOW from last week that should still show a stock warning once reopened,
   without the manager having to re-pick the override. A single enum forces re-deriving/
   re-entering the other axis every time one axis changes, which is exactly the kind of
   accidental-reset bug class P1's own architecture doc worried about for the NOT-NULL
   coercion (§6/§9). It also can't cleanly represent "closed AND admin-blocked simultaneously"
   for audit/history purposes (which one caused it?).
3. **Separate policy table** (`pos_availability_policy(item_type, item_id, ...)` joined to
   `recipes`/`materials`). Rejected: P1 deliberately chose plain columns on the two existing
   tables specifically because `bootstrap.js`'s `select * from materials/recipes` and
   `clone.js`'s per-row upserts need zero additional joins/write-sites to carry the fields
   (`docs/pos-operations-architecture.md` §9-10). A separate table reintroduces exactly the
   join/write-site multiplication P1 avoided — every one of the 6 `clone.js` write sites, the
   `sync.js` upserts, and `bootstrap.js`'s select would all need a second table kept in lockstep
   with row lifecycle (create/delete), including handling of the case where the policy row
   exists but the parent row was deleted out from under it. Given only 5 small, independently-
   defaulted columns are needed, the join overhead buys no benefit for the payoff being solved
   here.
4. **Rename/repurpose `pos_available` into the enum directly** (fold axis A and B together as
   `pos_available in ('AVAILABLE','UNAVAILABLE','OVERRIDE_ALLOW', ...)`). Rejected: breaks the
   NOT-NULL-boolean backward-compatibility guarantee P1 already shipped and tested
   (`pos-operations-roundtrip.test.js:93-95` asserts `is_nullable='NO'` and default matches
   `/true/`) — every existing caller (`sync.js` coercion, `clone.js` `?? true` fallbacks,
   `posItemAvailability()`'s `!== false` check) is boolean-typed. Widening the column's meaning
   would require touching every one of those call sites simultaneously with the new feature,
   raising blast radius for no benefit over adding two new columns.

### Migration defaults table

| Row state before migration | `pos_available` | `pos_stock_decision` | `pos_admin_blocked` | Sellable after migration? | Changed vs. today? |
|---|---|---|---|---|---|
| Any pre-existing row (recipe or material) | `true` (unchanged) | `'FOLLOW_STOCK_POLICY'` (new default) | `false` (new default) | Exactly what it was pre-migration (stock-gated as today) | **No** — this is the core guarantee |
| Row already closed via P1 (`pos_available=false`) | `false` (unchanged) | `'FOLLOW_STOCK_POLICY'` (new default) | `false` (new default) | Still closed, same as before | No |
| A brand-new row created post-migration, client omits the new fields | `true` (existing NOT NULL coercion in `sync.js`, unchanged) | `'FOLLOW_STOCK_POLICY'` (column default, same coercion pattern to add to `sync.js`) | `false` (column default) | Stock-gated, same as any other new row today | No |

No backfill script is needed beyond the column defaults themselves — every guarantee falls out
of `DEFAULT` + a `sync.js` coercion mirroring the existing `pos_available === false ? false :
true` pattern for the two new fields (coerce any non-enum-member string to
`'FOLLOW_STOCK_POLICY'`, any non-boolean to `false`), exactly like P1's own NOT-NULL safety fix
(`docs/pos-operations-architecture.md` §14, `sync.js:154-157`).

### Permission matrix

Recall from §7: this codebase has no `cashier` role; mapping the requested tiers onto what
actually exists —

| Action | staff / `front_store` preset ("cashier"-equivalent) | staff / `manager` preset | `owner` | `isSuperadmin` |
|---|---|---|---|---|
| Set A: toggle AVAILABLE ⇄ TEMPORARILY_UNAVAILABLE | Allow (`pos_toggle_availability`, already granted in preset) | Allow (`pos_toggle_availability`, folded into all-non-excluded manager grant) | Allow (bypass) | Allow (bypass) |
| Set B: FOLLOW_STOCK_POLICY ⇄ MANAGER_OVERRIDE_ALLOW | **Deny** (new key, not in `front_store` preset by default — see risk note) | Allow (new key `pos_stock_override`, granted in `manager` preset) | Allow (bypass) | Allow (bypass) |
| Set B: FOLLOW_STOCK_POLICY ⇄ MANAGER_OVERRIDE_BLOCK | Deny | Allow (same key as above — this is still a "manager decided" action) | Allow (bypass) | Allow (bypass) |
| Set C: NONE ⇄ ADMIN_BLOCKED | Deny | **Deny** (separate, higher tier — never folded into the blanket `manager` "all non-excluded keys" grant; add to `MANAGER_EXCLUDE`) | Allow (new key `pos_admin_block`, or simply owner-only since owner already bypasses) | Allow (bypass) |
| Clear an ADMIN_BLOCKED set by someone else | Deny | Deny | Allow | Allow |

Rationale for `front_store`/cashier being denied Set B by default: the whole reason P1 didn't
ship the override is that a wrongly-flipped override is a store-wide correctness hazard (§9);
gating it one tier above the existing "close for the day" action (which is genuinely a
front-of-house daily task) keeps the blast radius of a mis-tap contained to someone who is
already trusted with broader operational judgment. This mirrors the existing Delivery-override
precedent (§2) which is Owner-only for its narrower historical-backfill case — Manager-tier
here is deliberately looser than that precedent because this is a same-day, reversible,
per-item decision rather than a backfill of historical financial records, but it is still one
tier above plain availability-toggling.

New catalog keys needed (`backend/src/permissions/catalog.js`, same `pos` group as
`pos_toggle_availability`):
- `pos_stock_override` — controls Set B (both ALLOW and BLOCK directions use the same key,
  since both are "a manager overrode the stock policy," differing only in which direction).
  Add to `manager` preset implicitly (don't add to `MANAGER_EXCLUDE`); leave out of
  `front_store`/`STAFF_DEFAULTS`/`LEGACY_ALIASES` exactly like `pos_toggle_availability` was
  left out (`catalog.js:128-132`).
  This preserves the requirement "MANAGER_OVERRIDE_ALLOW is a manager tier action," so a
  Founder who wants a `front_store` cashier to have it can still opt in per-shop via
  `staff_permissions` — this is only the *default*, not a hard wall.
- `pos_admin_block` — controls Set C. Add to `MANAGER_EXCLUDE` alongside
  `team_edit_role`/`system_admin_manage` (`catalog.js:178`), so even the broad "all
  non-excluded keys" manager preset does **not** get it automatically — it must be an
  explicit owner/superadmin action or a deliberately-elevated custom grant. This directly
  satisfies "ADMIN_BLOCKED not bypassable by cashier-level permission (separate permission
  tier)" — it is in fact not bypassable by manager-tier either, by default.

Server enforcement follows the exact `sync-guard.js` `availabilityChanged`-style
change-detection pattern (§7): a `stockDecisionChanged(incoming, dbRow)` and
`adminBlockedChanged(incoming, dbRow)`, each gated on their respective new permission key, each
throwing a typed 403 that aborts the whole `/api/sync` transaction — no partial writes, same as
today.

### State precedence table (full truth table)

Per the mandated precedence (verbatim, reproduced from the task): ADMIN_BLOCKED always wins,
then TEMPORARILY_UNAVAILABLE, then MANAGER_OVERRIDE_BLOCK, then MANAGER_OVERRIDE_ALLOW, then
FOLLOW_STOCK_POLICY defers to today's stock logic (§1/§2 of this audit).

| C (safety) | A (selling state) | B (stock decision) | Underlying stock | Sellable? | Stock warning shown? | Which rule fired |
|---|---|---|---|---|---|---|
| ADMIN_BLOCKED | (any) | (any) | (any) | **No** | No (ribbon/block message, not a stock warning) | C wins unconditionally |
| NONE | TEMPORARILY_UNAVAILABLE | (any) | (any) | **No** | No (ribbon, same as P1 today) | A wins (existing P1 behavior, unchanged) |
| NONE | AVAILABLE | MANAGER_OVERRIDE_BLOCK | (any) | **No** | No (this is a deliberate "don't sell" decision, distinct from A) | B (block) wins over stock |
| NONE | AVAILABLE | MANAGER_OVERRIDE_ALLOW | Zero/insufficient | **Yes** | **Yes** — stock warning still renders (color/text), sale still proceeds | B (allow) overrides the stock hard-block, warning stays |
| NONE | AVAILABLE | MANAGER_OVERRIDE_ALLOW | Sufficient | Yes | No (normal — nothing to warn about) | B is moot; stock was fine anyway |
| NONE | AVAILABLE | FOLLOW_STOCK_POLICY | Sufficient / low-but-nonzero | Yes | Warning only if low (today's color logic, §1) | Today's behavior, unchanged |
| NONE | AVAILABLE | FOLLOW_STOCK_POLICY | Zero (`finished_goods` recipe) | **No** (409 `FG_STOCK_INSUFFICIENT` server-side; client-side empty onclick) | N/A — blocked, not warned | Today's behavior, unchanged (§2) |
| NONE | AVAILABLE | FOLLOW_STOCK_POLICY | Zero (material, or `make_to_order` BOM shortfall) | **No client-side** (empty onclick / `canMake=false`), but **not enforced server-side** today (§2) | N/A | Today's *inconsistent* behavior, unchanged by this policy — flagged as a pre-existing gap, not something this design is scoped to fix |

The table's key invariant: **axis C and A are pure blockers that never need to consult stock;
axis B only ever matters when A=AVAILABLE and C=NONE, and even then only changes the
sellable/blocked outcome — it never changes whether the warning text renders** (the warning is
purely a function of the real stock number, never of which axis allowed the sale).

### UI behavior

- **Card ribbon** (existing P1 `.ppc-closed-ribbon`, `styles.css:2091-2108`) continues to mean
  exactly "TEMPORARILY_UNAVAILABLE" (axis A) — unchanged shape/color/behavior.
- **New, visually distinct treatment for ADMIN_BLOCKED** (axis C): must not reuse the same
  ribbon shape/color as axis A (a cashier seeing a red admin-blocked item needs to immediately
  know this isn't something they can reopen from the card — the existing
  `posMgrToggleBtnHtml`/`openPosAvailabilitySheet` power-button affordance must not even render
  for a `pos_admin_block`-only user on an ADMIN_BLOCKED item). Recommend a distinct color (e.g.
  a solid dark-red banner rather than the existing near-black ribbon) and distinct copy ("ปิดโดย
  ผู้ดูแลระบบ" vs. the existing "ปิดขาย").
- **MANAGER_OVERRIDE_ALLOW indicator**: needs its own small badge distinct from both the ribbon
  and the stock-color text — e.g. a small "ยืนยันขายทั้งที่สต๊อกไม่ตรง" pill next to the existing
  `.ppc-stock` line, so a cashier ringing up the sale still sees the real stock number/warning
  color (per the precedence table: warning always still renders) but also sees *why* the tap
  worked despite red stock text.
- **MANAGER_OVERRIDE_BLOCK indicator**: visually should look like axis-A's ribbon in weight
  (it blocks the sale identically) but with distinct copy so a manager knows to look at "stock
  decision" rather than "toggle availability" to reopen it — e.g. reuse the ribbon shape/color
  but with the label "หยุดขาย (สต๊อก)" instead of "ปิดขาย", to keep the existing single visual
  language ("diagonal ribbon = you cannot buy this right now") while the exact wording tells the
  manager which sheet to open to undo it.
- **Interaction with `posCardTapHandler`**: extend it to check C then A then B, using the exact
  same short-circuit structure it already has for A vs. stock (§4) — this is a small, additive
  change to one function, not a rewrite.
- **Toggle surface**: extend the existing `openPosAvailabilitySheet` compact sheet with a
  second section (below the existing available/unavailable buttons) for the stock-decision
  axis, gated on `pos_stock_override`/`pos_admin_block` respectively — reuses the sheet's
  existing modal/permission-check scaffolding rather than adding a new UI surface.

### API contract (sync / bootstrap)

- `bootstrap.js` needs **no changes** — it already does `select * from materials/recipes`
  (per P1's own note, `docs/pos-operations-architecture.md` §9), so the three new columns ride
  along automatically, exactly like P1's two columns did.
- `sync.js` `upsertRows` field lists (151, 163) gain three more field names:
  `pos_stock_decision`, `pos_stock_decision_reason`, `pos_admin_blocked`,
  `pos_admin_blocked_reason` — same coercion pattern as the existing two (154-159, 168-171).
- `clone.js`'s 6 write sites gain the same `?? 'FOLLOW_STOCK_POLICY'` / `?? false` / `?? null`
  fallbacks as the existing `pos_available ?? true` / `pos_unavailable_reason ?? null` pattern
  (270-323, 586-603).
- `frontend/index.html`'s `syncToSupabase()` payload builders (materials ~4236-4251, recipes
  ~4252-4262) gain the three fields with the same "undefined reads as the safe default" pattern
  already used for `pos_available` (4248-4250, 4260-4261).

### Audit events

Extend the existing `_availability_audit`/`menu.availability_change` machinery rather than
inventing a parallel path:
- New action `menu.stock_decision_change` (mirrors `menu.availability_change` exactly:
  target_type, target_id, target_name, old/new — values `'follow_stock_policy'` /
  `'override_allow'` / `'override_block'`, reason, correlation, at). Requires
  `pos_stock_override`.
- New action `menu.admin_block_change` (same shape, old/new = `'none'`/`'admin_blocked'`,
  reason). Requires `pos_admin_block`. Given the higher sensitivity, this one should **not**
  be capped alongside the other 50-entry queue silently truncating — recommend its own
  uncapped-until-sync queue or at minimum a distinct, larger cap, since an ADMIN_BLOCKED event
  is rarer and more consequential per-event than a routine daily open/close.
- Both follow the exact `sync.js` `normalize*Audit()` whitelist/cap/coerce pattern (84-118) and
  the exact fire-and-forget `logEvent()` call after transaction commit (358-374).

### Barcode behavior

`posScanEnter` (§5) needs **no changes** — it already delegates entirely to
`addToCart`/`addMatToCart`, which will pick up the new precedence automatically once
`posItemAvailability`-equivalent logic (extended for axes B/C) is consulted inside those two
functions, exactly the same "belt-and-suspenders single source of truth" property P1 already
established (comment at 8635-8636/8612-8613 explicitly calls out barcode scan as a caller that
must go through the same gate as the card).

### Offline / sync behavior

- **Two devices disagree** (e.g. Device 1 sets MANAGER_OVERRIDE_ALLOW while Device 2, with a
  stale in-memory copy, is mid-edit on an unrelated field for the same item): `syncToSupabase()`
  pushes the **entire** in-memory dataset every save (§ "API contract" background —
  `frontend/index.html:4234 onward`), guarded by `_base_version`/`dataVersion`
  (`sync.js:130-140`, `frontend/index.html:4372`/`4378`). Whichever device's `saveAll()` fires
  second with a stale `dataVersion` gets a 409 (`sync.js:133-135`), triggers
  `handleSyncConflict()` (`frontend/index.html:4401-…`), which backs up that device's pending
  payload to `localStorage` and reloads from server — **the losing device's stock-decision
  change is silently dropped from the server's perspective until the user notices the "พบการ
  แก้ไขจากที่อื่น" banner and manually reconciles.** This is not new — it is the exact same
  last-writer-wins-at-the-row-level behavior the whole app already has for every other field
  (name, price, stock count, etc.) — the new axes inherit it unchanged, they don't make it worse
  or better.
- **`syncToSupabase` has no in-flight guard** (flagged in the task, confirmed at
  `frontend/index.html:8357`'s own comment: "guardrail: syncToSupabase ไม่มี in-flight guard").
  This means if `saveAll()`'s debounce fires twice in quick succession on the **same** device
  (e.g. a manager taps MANAGER_OVERRIDE_ALLOW and then immediately taps something unrelated
  before the first POST resolves), two overlapping `/api/sync` calls race with the same
  `dataVersion` baseline; whichever response arrives second will 409 (since the first response
  already advanced `data_version` server-side) and trigger the same conflict-reload path above.
  Net effect for this feature specifically: a rapid double-toggle of the stock-decision axis
  on one device can trigger a spurious "reload from server" even though nothing external
  changed — annoying but not unsafe (no partial write, no silent wrong-state persistence,
  because the whole transaction is atomic per `sync.js`'s `tx()` wrapper). Recommend, as a
  **follow-up, not blocking this feature**: a simple boolean in-flight lock around
  `syncToSupabase()` (queue-and-coalesce rather than fire concurrent requests) — this is a
  pre-existing gap unrelated to the availability policy and shouldn't be scoped into this
  change, but is worth flagging since the new axes make manual toggle-heavy workflows (a
  manager rapidly reopening several wrong-stock items in a row) somewhat more likely to hit it
  than the lower-frequency category-archive toggles that share the same save path today.

### Rollback

Identical shape to P1's own rollback plan (`docs/pos-operations-architecture.md` §11), since
this is purely additive on top of an already-additive design:
- **Frontend rollback**: revert `frontend/index.html`/`styles.css` to the pre-this-feature
  commit. The three new columns stay in the DB, unread/unwritten, completely inert.
- **Backend rollback**: revert `sync.js`/`sync-guard.js`/`clone.js`/`catalog.js` to the
  pre-this-feature commit. Old code doesn't select/whitelist the new columns; a shop that had
  items overridden pre-rollback keeps that data dormant in the DB but every card reverts to
  "stock policy is the only signal" (i.e. today's exact behavior) until the code ships again.
- **Schema rollback** (only if truly necessary): `alter table recipes/materials drop column
  pos_stock_decision, drop column pos_stock_decision_reason, drop column pos_admin_blocked,
  drop column pos_admin_blocked_reason` — safe any time, nothing outside this feature reads
  them.
- No reverse migration needed; re-running the new schema file is a no-op (`if not exists`
  everywhere, matching P1's pattern).

### Acceptance tests (list, to guide a future implementation PR — not written here)

1. Legacy row (all three new columns at their defaults) behaves byte-identical to pre-feature
   behavior for both zero-stock and low-stock cases, both item types, all three inventory modes.
2. A load→re-save cycle that touches an unrelated field never flips `pos_stock_decision` or
   `pos_admin_blocked` away from their current values (mirrors the existing P1 regression test
   at `pos-operations-roundtrip.test.js:130-131` for `pos_available`).
3. `MANAGER_OVERRIDE_ALLOW` on a zero-stock `finished_goods` recipe allows the sale server-side
   (no `FG_STOCK_INSUFFICIENT`) and still displays the red stock-count warning on the card.
4. `MANAGER_OVERRIDE_ALLOW` on a zero-stock material allows `addMatToCart` to push past its
   `maxQty<=0` early return.
5. `MANAGER_OVERRIDE_BLOCK` on a fully-in-stock item still blocks the sale (both client tap and
   server-side), distinct from `TEMPORARILY_UNAVAILABLE`'s ribbon/copy.
6. `ADMIN_BLOCKED` blocks the sale even when `pos_stock_decision='MANAGER_OVERRIDE_ALLOW'` and
   `pos_available=true` (precedence: C beats B and A).
7. A `manager`-preset staff member can set/clear `MANAGER_OVERRIDE_ALLOW`/`_BLOCK` but is denied
   (403, whole-sync-abort, DB row unchanged) setting `ADMIN_BLOCKED`.
8. A `front_store`-preset staff member is denied both B and C by default (but can still toggle
   axis A, unchanged from P1).
9. Barcode scan (`posScanEnter`) respects the same precedence as the card tap for all 8 rows of
   the truth table.
10. Audit rows land for both new axes with the correct action name, are capped/whitelisted
    correctly, and an audit-log failure never fails the underlying sync (mirrors
    `pos-operations-roundtrip.test.js`'s existing audit assertions).
11. `clone.js` round-trip (selective clone + full shop import) preserves all three new
    columns with the same `?? default` fallback safety already proven for `pos_available`.
12. Two-device conflict: Device 2's stale-`dataVersion` save attempting to clear an override
    that Device 1 just set gets a 409, not a silent overwrite (existing version-conflict guard,
    unchanged — just confirm the new columns don't bypass it).

### Risks

- **Permission-default risk**: if a Founder later asks to grant `pos_stock_override` to
  `front_store`/cashier-tier by default (contrary to this design's recommendation), the same
  "instantly sellable store-wide" hazard P1 flagged for `pos_available` does **not** recur here,
  because the new column's default (`FOLLOW_STOCK_POLICY`) is the safe no-op state, not the
  override state — this is the entire point of the three-column design. The risk that remains
  is purely about *who* can flip it, not about *what flipping it by accident does on day one*.
- **UI confusability risk**: axis A's ribbon and axis C's block and axis B's block are three
  different "you can't buy this" visuals; without careful, distinct copy/color this could
  become as confusable as the very stock-vs-availability conflation P1's ribbon was designed to
  avoid (`docs/pos-operations-architecture.md` §5). This is a design/copy risk, not a data risk.
- **Cross-mode enforcement gap risk** (pre-existing, not introduced by this design, but this
  design does not close it either): materials and `make_to_order` recipes still have no
  server-side stock hard-block today (§2) — `MANAGER_OVERRIDE_ALLOW`'s main practical effect for
  those two cases is therefore purely at the **client** gate (bypassing the empty-onclick/
  `maxQty<=0` short-circuit), since there's no server-side block to override in the first place.
  Only `finished_goods` recipes get a genuine server-side override effect (bypassing
  `FG_STOCK_INSUFFICIENT`). This asymmetry should be called out explicitly to the Founder so
  expectations match reality — "override" means different things depending on item type/mode
  under the *current* enforcement architecture, through no fault of this design.
- **Audit volume risk**: if a manager toggles override on/off repeatedly while troubleshooting a
  stock discrepancy, the audit queue could rapidly consume its cap in a single session
  (mitigated by the per-axis queue recommendation above, but worth monitoring in practice).

### Founder decision required

1. **Permission tier for MANAGER_OVERRIDE_ALLOW/BLOCK**: this design defaults it to `manager`
   preset only (one tier above `pos_toggle_availability`, which is a `front_store` action
   today). Is manager-tier the right default, or should it be granted to `front_store`/cashier
   by default too (accepting that the safety now lives entirely in the explicit-opt-in default
   rather than in who can flip it)?
2. **Who can set ADMIN_BLOCKED**: this design proposes owner/superadmin-only (excluded even from
   the broad `manager` preset, alongside `team_edit_role`/`system_admin_manage`). Confirm this
   is the intended "separate permission tier" from the spec, or if a distinct manager-eligible
   sub-tier is wanted for ADMIN_BLOCKED specifically (e.g. a senior-manager concept that doesn't
   exist in the system today).
3. **Scope of "override" given the enforcement asymmetry** (Risk 3 above): given materials and
   make_to_order recipes have no server-side stock block today, should this project also close
   that gap (add server-side enforcement parity for materials/make_to_order, mirroring the
   `finished_goods` 409 pattern) as a prerequisite, or is client-side-only enforcement acceptable
   for those two cases for now, with the understanding that a modified/future client could
   bypass it entirely for those item types regardless of the override policy?
4. **UI copy/visual for ADMIN_BLOCKED vs MANAGER_OVERRIDE_BLOCK vs TEMPORARILY_UNAVAILABLE**:
   confirm the three distinct ribbon treatments proposed above (or supply preferred copy/color)
   before any implementation PR touches `styles.css`.
