# POS Operations Manager (P0) — field/code-path audit + design

Branch `feat/pos-operations-manager`, base `main@5c5319f`. Status: implemented, tested, **not
merged, not deployed**.

## 1. The field audit (what existed before this PR, and what it actually controls)

Before this PR, "should this show up / sell on POS" was split across four **unrelated** fields,
none of which was a daily-operations "close this because we're out" switch:

| Field | Table / scope | What it REALLY means | Who sets it | Daily-use? |
|---|---|---|---|---|
| `recipes.on_menu` | per-recipe | **Concept A** — is this recipe part of the menu system at all (inclusion). `null` legacy value resolves as `!isRaw` (see `recIsOnMenu` in `frontend/index.html`). | Recipe editor, one-time-ish | No — a structural/catalog decision |
| `materials.show_in_pos` + `materials.sale_type` | per-material | **Concept A for materials** — `sale_type==='SELLABLE' && show_in_pos` means "this material can be sold directly, no recipe/BOM" (`posSellableMats()`). Set automatically when item_type is set to `SALE`/`SERVICE` via the item-type map (`MATERIAL_BEHAVIOR_FIELD_MAP`). | Material form (item-type picker), one-time-ish | No — a structural decision |
| `shop_settings.pos_categories` + the archived-category list (`posCatArchivedList()`) | per-category | **Concept C** — is this whole CATEGORY visible on POS (`posCatArchive`/`posCatUnarchive`, already shipped). Coarse-grained: hides every product in the category at once. | Category Manager ("จัดการหมวด" on the POS category bar) | Occasionally |
| `recipes.fg_stock` / `materials.stock` (+ `low_stock`/`fg_low`) | per-item | **Concept D** — physical stock level. Zero stock already hard-disables the card (`out-of-stock` class, no `onclick`) as **pre-existing legacy behavior**, unrelated to any of the above. Low (non-zero) stock only ever shows a warning color, never blocks a sale. | Stock module / production / sales deduction | Automatic, not a manual decision |

**The gap**: none of the above is "the manager looked at the counter this morning and the milk
is out, so close this ONE menu item for today, with a reason, and reopen it this afternoon."
Before this PR the only way to stop selling a specific item without touching its recipe/BOM or
its category was to either falsify the stock count or remove it from the menu entirely
(`on_menu=false`), which also hides it from reporting/recipe views — the wrong tool for a
same-day, reversible, reason-tracked decision.

**No field was renamed, removed, or repurposed.** `on_menu`, `show_in_pos`, `sale_type`, and the
archived-category list keep their exact pre-existing meaning and code paths.

## 2. The additive data model (Concept B — NEW)

`backend/db/schema-pos-ops.sql` (registered in `backend/src/migrate.js`, before `seed.sql`):

```sql
alter table recipes   add column if not exists pos_available boolean not null default true;
alter table recipes   add column if not exists pos_unavailable_reason text default null;
alter table materials add column if not exists pos_available boolean not null default true;
alter table materials add column if not exists pos_unavailable_reason text default null;
-- + a light char_length(<=200) check constraint on both reason columns (defense in depth;
--   the application layer already caps at 200 chars everywhere this is written)
```

Additive, idempotent (`if not exists` / drop-then-recreate for the constraint), and every
pre-existing row reads as `pos_available = true, pos_unavailable_reason = null` — i.e. **fully
available**, identical to today's behavior, with zero backfill needed.

## 3. Menu availability workflow (Concept B)

- **Toggle surface**: every POS product card (recipe or material, all three recipe inventory
  modes — `non_stock`, `make_to_order`, `finished_goods`) gets a small circular "power" icon in
  the corner, visible only to a user with `pos_toggle_availability`. Tapping it opens a compact
  sheet (`openPosAvailabilitySheet`) with two buttons (พร้อมขาย / ปิดขาย) and, when closing, the
  six controlled reasons as chips (ของหมด · ปิดขายชั่วคราว · ไม่ขายวันนี้ · Seasonal · Kitchen
  unavailable · Other, with a short free-text box only for "Other").
- **Effect**: `posSetAvailability()` mutates `item.posAvailable` / `item.posUnavailableReason` in
  memory, pushes one audit entry, re-renders the grid immediately, and lets the existing debounced
  `saveAll()` persist it — no new/competing auto-save path.
- **Sellability gate**: `posItemAvailability(item)` is the single source of truth for "can this be
  sold" from the availability angle. Every card's click handler (`posCardTapHandler`) and both
  cart-entry functions (`addToCart`, `addMatToCart`) consult it directly, so a closed item can
  never be added to the cart through the card, the barcode scanner (`posScanEnter`), or any other
  caller of those two functions.
- **Closed card UX**: dimmed + grayscale (like the existing out-of-stock look) **plus** a diagonal
  ribbon reading "ปิดขาย" (own CSS rule `.ppc-closed-ribbon`, not merely a color change) — see
  §5 for why this has to be visually distinct from a stock warning. Tapping a closed card either
  reopens the manager sheet (if the tapper has `pos_toggle_availability`) or shows the reason as a
  read-only toast (if they don't) — it never adds to cart either way.

## 4. Category visibility workflow (Concept C — reused, not rebuilt)

No new code path here by design. The existing Category Manager (`openPosCatManager()`,
`posCatArchive()` / `posCatUnarchive()`, already shipped and covered by
`backend/test/category-hotfix.test.js`) is the category-visibility surface, already reachable
directly from the POS category bar ("จัดการหมวด" button, gated on the same manager-ish
permission check already in place). This PR does not add a second surface for the same concept.

## 5. Stock health separation (Concept D)

Stock never reads or writes `pos_available`, and `pos_available` never reads or writes stock —
the two axes are fully decoupled in both directions; nothing in this PR couples them. The one
**pre-existing** thing worth flagging precisely (a judgment call, see §6): zero stock already
hard-disables a card today (`out-of-stock` class, no click handler) as **legacy behavior that
predates this PR** — this PR does not touch, extend, or fix that. Low (non-zero) stock has always
been (and remains) a warning-only color/text change. The new closed-for-sale ribbon is a visually
distinct shape/label specifically so a person-driven "closed" is never confused with a
stock-driven "low"/"empty" warning at a glance (§3's ribbon vs. the pre-existing inline colored
`.ppc-stock` text).

## 6. Manual override — what this PR does and does NOT do (Founder decision needed)

The spec asked for "manager may close a stocked menu; may keep open a wrong-stock menu." This PR
implements the **safe, additive half** of that:
- **"Manager may close a stocked menu"** — fully implemented. `pos_available` is completely
  independent of stock; a manager can close/reopen any item regardless of what its stock reads.
- **"Manager may keep open a wrong-stock menu"** (i.e. override the existing zero-stock hard
  block so an item can still be sold at 0 stock) — **NOT implemented**. Doing so would mean
  `pos_available=true` (the default for every untouched item) silently unlocks selling every
  currently-out-of-stock product store-wide the moment this ships, which is a real inventory/
  correctness risk with no distinguishing signal between "never touched" and "manager explicitly
  overrode." This needs an explicit Founder call (e.g. a third tri-state, or a dedicated
  "sell anyway" action) before it should be built — flagged, not guessed at.

## 7. Permission enforcement (fails closed on the permission, never on availability itself)

New catalog key `pos_toggle_availability` (`backend/src/permissions/catalog.js`), deliberately
**not** a `recipe_edit` alias and **not** in `STAFF_DEFAULTS`/`LEGACY_DEFAULTS` — a staff member
gets nothing for free. Granted by default in the `front_store` and `manager` presets (this is
front-of-house work, not a formula-editing privilege); absent from `read_only`.

Server-side enforcement lives in `backend/src/api/sync-guard.js` (`availabilityChanged()` +
its own check in both the `recipes` and `materials` loops), fully independent from
`recipe_edit`/`recipe_edit_cost` — proven by `backend/test/pos-operations-roundtrip.test.js`
(a staff member with only `recipe_edit` is denied toggling availability; a staff member with only
`pos_toggle_availability` can toggle availability but is denied editing the recipe name). Denial
aborts the whole sync transaction (nothing partial persists) and never touches the DB row — it
only ever blocks the **write**; it can never flip an item to unavailable on its own.
Owner/superadmin bypass unconditionally, matching every other permission in this codebase.

Frontend hiding (`can('pos_toggle_availability')` gating the toggle icon and the sheet) is UX
only — the real boundary is the server check above.

## 8. Audit trail

Client-reported intent, same pattern as the pre-existing `_category_audit` (one event per actual
toggle, not a server-side diff — the client knows the true "did I mean to close this" intent that
a before/after diff can't always recover). `frontend/index.html`'s `posAvailAuditPush()` builds
one entry per toggle; `backend/src/api/sync.js`'s `normalizeAvailabilityAudit()` whitelists the
action (`menu.availability_change` only), target type (`recipe`/`material` only), caps the array
at 50 entries and every string at 200 chars, coerces `old`/`new` to the literal strings
`'available'`/`'unavailable'` only, and flags whether the reason was one of the six controlled
values (`reason_controlled`) without ever dropping a free-text/legacy-client reason. Each
normalized entry becomes one `logs` row via the existing `logEvent()` helper (fire-and-forget,
matching every other audit path in this file — an audit failure must never fail the sync).

Example row (from `backend/test/pos-operations-roundtrip.test.js`):

```json
{
  "shop_id": "<shop uuid>",
  "user_id": "<actor uuid>",
  "action": "menu.availability_change",
  "detail": {
    "target_type": "material",
    "target_id": "<material uuid>",
    "target_name": "Audited Material",
    "old": "available",
    "new": "unavailable",
    "reason": "Kitchen unavailable",
    "reason_controlled": true,
    "correlation": "test_corr_1752831600000",
    "at": "2026-07-18T10:00:00.000Z"
  },
  "created_at": "2026-07-18T10:00:00.123Z"
}
```

## 9. Reload + cross-device persistence

Proven with a real HTTP + real local-Postgres round trip (no stubs), not an in-memory simulation:
`backend/test/pos-operations-roundtrip.test.js` — register → `POST /api/sync` (close with a
reason) → `GET /api/bootstrap` (fresh reload, as if from a second device) → assert both fields
survived verbatim → reopen → reload again → assert cleared. `bootstrap.js` needed no changes: it
already does `select * from materials/recipes`, so the two new columns ride along automatically.

## 10. Backward compatibility

A pre-existing row has `pos_available=true, pos_unavailable_reason=null` (the column defaults) —
identical to "fully available" today. Proven two ways:
- A client (or test harness) that omits the fields entirely on `/api/sync` never reaches the
  INSERT as `NULL` (which would violate the `NOT NULL` constraint and 500 the *entire* sync,
  including unrelated fields in the same payload) — `sync.js` coerces
  `pos_available: x.pos_available === false ? false : true` before the upsert, for both
  `materials` and `recipes`. This was an actual bug caught while writing this PR (see §14) — the
  inherited code had the column whitelisted for sync but not this coercion, and four *pre-existing,
  unrelated* test files started 500ing the moment the column went `NOT NULL`.
- A load → re-save cycle (edit something unrelated, save, don't touch availability) does not
  flip a legacy row — proven in `pos-operations-roundtrip.test.js`.
- `clone.js` (selective clone + full shop import) carries both columns in all 6 write sites with
  `?? true` / `?? null` fallbacks, so cloning a shop that predates this column, or a payload that
  omits it, still lands as fully available rather than crashing or nulling out.

## 11. Rollback plan

Purely additive columns; rollback is "stop deploying the new code," full stop:
- **Frontend rollback**: revert `frontend/index.html`/`styles.css` to `5c5319f`. The columns stay
  in the DB, unread and unwritten — completely inert. No data loss, nothing to clean up.
- **Backend rollback**: revert `sync.js`/`sync-guard.js`/`clone.js`/`catalog.js` to `5c5319f`.
  Old code never selects/whitelists the two new columns, so it simply ignores them — a shop that
  had items closed pre-rollback keeps that data in the DB (dormant) but every card reverts to
  "always available" until this code ships again (no crash, no partial state).
  `checkSyncPermissions`/`upsertRows` on old code paths don't know these columns exist and won't
  reference them.
- **Schema rollback (only if truly necessary)**: `alter table recipes/materials drop column
  pos_available, drop column pos_unavailable_reason` — safe any time because nothing outside this
  feature ever reads them. Not required for a code-only rollback.
- No migration needs to run in reverse; `schema-pos-ops.sql` re-running is a no-op (`if not
  exists` everywhere).

## 12. Automated tests

`npm test` in this worktree: **21 test files, 0 failed** (19 pre-existing + 2 new:
`backend/test/pos-operations.test.js` — 72 extraction-style assertions against the real shipped
source, no DB/browser — and `backend/test/pos-operations-roundtrip.test.js` — 6 real HTTP + real
local-Postgres round-trip / permission-enforcement / audit-trail tests). Base `5c5319f` has 19
test files; this branch adds exactly 2.

## 13. Founder walkthrough

See the message accompanying this PR summary (also reproducible locally: `npm run migrate` then
start the app on `PORT=3300`, restart after any `index.html` edit since `INDEX_SHELL` is read once
at boot).

## 14. Branch / commit summary

Branch `feat/pos-operations-manager`, base `main@5c5319f`. Commits are grouped by logical unit:
schema+migration, backend sync/guard/clone wiring (including the NOT-NULL safety fix), permission
catalog key, frontend card integration, tests, and this doc. Not pushed, not merged, not deployed.
