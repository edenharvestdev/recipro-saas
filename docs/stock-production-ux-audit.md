# Stock Production UX audit — searchable recipe selector (P1 project)

Branch: `feat/stock-production-search` (base `main` @ `5c5319f`).
Scope: `frontend/index.html` only (UX layer). No backend, no schema, no
production-calculation changes. This document is the audit called for
before implementation, plus the record of what shipped.

## 1. Where the production flow actually lives

การผลิต ("สั่งผลิตเข้าร้าน") is a card on the **STOCK PAGE**
(`<section id="stockPage">`), not a separate dialog:

- Markup: `frontend/index.html` around the `<h2>...สั่งผลิตเข้าร้าน</h2>` card
  (originally lines ~438-452).
- Selector: a single `<select id="prodRecipe">`, populated by
  `renderRecipeList()` with `recipes.map(r => <option value="${r.id}">
  ${esc(r.name)}</option>)` — i.e. every recipe in the shop, in whatever order
  `recipes` happens to be sorted, as one giant native dropdown. No search, no
  grouping, no filtering.
- Quantity: `<input id="prodRounds">` — "จำนวนรอบการทำสูตร" (how many times to
  run the recipe).
- Preview: `renderProdPreview()` — reads `recById($('prodRecipe').value)`,
  computes ingredient need vs. stock for the chosen rounds, renders a table.
- Commit: `produce()` — re-validates stock is sufficient, prompts for actual
  yield, deducts each ingredient (`matStockBase`/`fgStock` for sub-recipes)
  via `pushMovement()`, credits the recipe's own `fgStock`, and appends a
  `prodLogs` entry.
- Shortcut: `produceShortcut(id)` — called from the FG stock table's "ผลิต"
  button (`renderFgList()`), sets `$('prodRecipe').value = id` and scrolls the
  form into view.

## 2. What identifies the selection

`recById(id)` (`const recById = id => recipes.find(r => r.id === id)`,
`frontend/index.html`) — the `<select>`'s `value` attribute is always
`r.id`, a stable id assigned at recipe creation (`rSaveBtn` handler,
`~line 5956`: `code` is a human label, but `id` is the real key). **Every**
downstream read (`renderProdPreview`, `produce`, `produceShortcut`) keys off
this id, never off `r.name`. This was already correct in the legacy code —
the audit's job was to make sure a new search UI could not regress it into
matching-by-name.

## 3. Problems with the original selector

1. **Unusable at scale.** A native `<select>` with dozens/hundreds of
   recipes is a single unfiltered scroll list — no way to jump to a recipe
   by typing, no visual grouping.
2. **No search at all**, Thai or English. Compare to the recipe list table
   itself (`renderRecipeList`), which already has a `#recipeSearch` text box
   filtering by name/code/category — that convenience never made it to the
   production selector.
3. **Selection resets on every re-render.** Because `renderRecipeList()`
   rebuilds `$('prodRecipe').innerHTML` from scratch on every `render()`
   (including right after a `produce()` call — `produce()` ends by calling
   `render()`), and replacing a `<select>`'s options resets `selectedIndex`
   to 0 unless the previous value is restored, **the previously-selected
   recipe silently reverted to the first item in the list** after every
   production run or unrelated data refresh. This was a latent bug in the
   existing code, not something introduced by this change — fixed as part of
   this work since the new search box needs a stable "currently selected"
   value to display anyway (see §5, "judgment calls").
4. **No item preview.** The operator sees ingredient math but not the
   selected item's current finished-goods stock or how many ingredients it
   has, before committing to produce.
5. **No keyboard-only path.** A native `<select>` does support arrow keys,
   but there is no type-ahead-then-Enter flow tuned for fast repeated use
   (e.g., producing the same handful of items every morning).

## 4. What was built (P0 + P1)

All changes are additive UI around the existing `<select id="prodRecipe">`,
which is kept in the DOM (now `display:none`) and remains the single source
of truth `produce()`/`renderProdPreview()`/`produceShortcut()` read from.
**No production-calculation function was touched** — `produce()` is
byte-identical to the `5c5319f` baseline (asserted in the test file via
`git show`).

New pieces, all in `frontend/index.html`:

- `#prodRecipeSearch` — a text input replacing the visible `<select>`.
  Placeholder: "พิมพ์ชื่อสูตร (ไทย/อังกฤษ) หรือรหัส...".
- `#prodRecipeResults` — an absolutely-positioned dropdown listing matches
  (name, `[code]` if present, `· category` if present).
- `prodRecipeMatches(query)` — pure filter function: case-folded substring
  match against `r.name` and `r.code`. `.toLowerCase()` is a no-op on Thai
  text (Thai has no case) and a real fold for English/ASCII, so one code
  path correctly handles "iced latte" vs "Iced Latte" AND Thai substrings
  like "เย็น" matching "ลาเต้เย็น". Empty query returns every recipe
  (Thai-locale sorted) so opening the box with nothing typed still lets you
  browse.
- `prodRecipeSearchInput(el)` — debounced (150ms) via
  `setTimeout`/`clearTimeout`. Mirrors the `ogNumInput()` contract documented
  a few hundred lines above it in the same file: it **never rewrites the
  element being typed in** — it only ever re-renders the sibling
  `#prodRecipeResults` div. The search `<input>`'s own value is left alone by
  every keystroke handler.
- `prodRecipeSearchKeydown(e)` — ArrowDown/ArrowUp move `prodSearchActiveIdx`
  (clamped to the current match list), Enter commits the active match via
  `selectProdRecipe`, Escape closes the dropdown. All four calls
  `preventDefault()`.
- `renderProdRecipeResults()` — renders the match list, or the empty state
  `"ไม่พบสูตรที่ตรงกัน ลองคำอื่น"` when nothing matches.
- `selectProdRecipe(id)` — the only function that writes the selection: sets
  `$('prodRecipe').value = id` (the real recipe id), updates the visible text
  box to `r.name` for display only, closes the dropdown, calls
  `renderProdPreview()`. Never stores or compares by name.
- `syncProdRecipeSearchDisplay()` — keeps the visible text box showing the
  name of whatever `$('prodRecipe').value` currently is, guarded on
  `document.activeElement` so a data-driven re-render never clobbers text the
  owner is mid-typing.
- `renderProdPreview()` (extended, P1) — prepends a small summary block above
  the existing ingredient-need table: recipe name + code, current unit,
  current FG stock (`r.fgStock`), and ingredient count (`r.items.length`).
  Pure read of existing fields; the existing need/have table logic is
  unchanged.

### Selection-preservation fix (called out separately)

`renderRecipeList()`'s `<option>` rebuild now captures `$('prodRecipe').value`
before replacing the options and restores it afterward if the recipe still
exists (falls back to the previous default — index 0 — if it doesn't). This
directly serves the search feature (the box needs a stable value to reflect)
and fixes the pre-existing reset-to-first-item bug from §3.3.

## 5. Judgment calls

1. **Kept the native `<select>` as the value holder** rather than
   re-plumbing `produce()`/`renderProdPreview()`/`produceShortcut()` to read
   a plain variable. This was the smallest-blast-radius option: those three
   functions — the ones actually touching stock — are untouched, byte for
   byte, which the test file asserts directly against the `5c5319f` baseline.
2. **Fixed the selection-reset-on-rerender bug** (§3.3) rather than working
   around it, since the new search box has nowhere sane to point without a
   stable selected value across re-renders. Flagged here rather than buried
   silently since it's a behavior change beyond pure UI, even though it
   only affects the (hidden) `<select>`'s bookkeeping.
3. **Did not add a stylesheet block** — all new markup uses the same
   inline-style/CSS-variable convention already used throughout this file
   (`var(--surface-1)`, `var(--border-soft)`, etc.), consistent with the
   Option Builder code nearby rather than introducing a new class-based
   system.
4. **Empty-query browsing** (show all recipes, Thai-sorted, when the box is
   focused with nothing typed) was added so the widget also works as a
   browsable list, not only a search box — useful for operators who don't
   remember the exact name of the sourdough starter as it's called in
   the system.

## 6. Explicitly NOT built — Recent/Favorites

The brief calls for Recent/Favorites only "if it needs NO new persistence."
It does: "recent" requires remembering the last N produced recipe ids
per-shop (or per-device) across sessions, and "favorites" requires an
explicit pin list — both are user preferences that must survive a reload,
which means a new field on `settings` (or a new local-storage key synced the
same way other shop prefs are), i.e. new persisted state. That crosses the
line this project was scoped to stay behind (UX-only, no schema, shared DB
with another concurrent agent).

**Next small increment (not built, for a future ticket):**

- Add `settings.prodRecentIds` (array, capped at ~8) and/or
  `settings.prodFavoriteIds` (array) — small, additive, JSON-serializable
  fields on the existing `settings` row (same shape as `posCategories`,
  `menuConfig`, etc. — no new table, no migration).
- On a successful `produce()`, push `r.id` to the front of
  `prodRecentIds` (dedupe, cap length) — a one-line addition at the very end
  of `produce()`, after the existing `prodLogs.unshift(...)` line, so it
  doesn't touch the deduction/movement logic above it.
- Favorites: a small star toggle in `renderProdRecipeResults()`'s row markup
  calling a new `toggleProdFavorite(id)` that pushes/removes from
  `prodFavoriteIds` and calls `saveAll()` (existing debounce/sync path —
  same mechanism every other settings field already uses).
- Surface both as pinned sections at the top of `renderProdRecipeResults()`
  when the search query is empty (favorites first, then recents, then the
  full Thai-sorted list) — a display-only change to a function that already
  exists after this PR.
- Needs explicit Founder sign-off before implementing (per this project's
  brief) since it changes `settings`' persisted shape, and per the memory
  note on `productivity` there's another agent sharing the local DB right
  now with a schema freeze in effect.
