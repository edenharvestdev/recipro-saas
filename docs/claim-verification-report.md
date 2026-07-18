# Claim Verification Report — Overnight Stream 5 (2026-07-19)

Independent re-verification of every checkable claim across the three completed branches.
All suites re-run sequentially against real code and the real local database; worktree heads
verified unchanged before/after (P1 `12f7cff` · P2 `dac6fa9` · Security `4f994c9`).

## Verdict: 23 / 24 PASS · 1 genuine FAIL (fixed on a separate branch)

### P1 — POS Operations Manager (all PASS)
| # | Claim | Evidence |
|---|---|---|
| 1 | Migration additive | `schema-pos-ops.sql` = add-column-if-not-exists only; registered migrate.js:63; migrate idempotent twice |
| 2 | Legacy rows keep sale behavior | sync.js:158,169 coercion; round-trip test "legacy row … load+re-save does not change it" |
| 3 | Availability persists reload | real-DB round-trip test (close → reload → reason survives → reopen clears) |
| 4 | Permission enforced server-side | `sync-guard.js checkSyncPermissions`; live HTTP test: staff w/o key → 403 `POS_AVAILABILITY_PERMISSION_DENIED`, row untouched |
| 5 | Barcode cannot bypass | gate lives INSIDE addToCart/addMatToCart (8613, 8637), not only at call sites |
| 6 | Archive keeps relations | posCatArchive writes only the archived-name list; zero diff vs baseline |
| 7 | No auto stock mutation | full-diff grep: no new stock writes |
| 8 | sync-guard change minimal | one 14-line helper + two ~5-line call sites, matching file's existing pattern |

### P2 — Stock Production Search (all PASS)
| # | Claim | Evidence |
|---|---|---|
| 9 | `<select>` remains ID source of truth | hidden select still read by produce()/preview/shortcut; selectProdRecipe writes id only |
| 10 | No production-calculation change | `produce()`/`pushMovement()` byte-identical to baseline (double-checked by the branch's own git-baseline test) |
| 11 | Selection survives re-render | prevId capture/restore in renderRecipeList (code-verified; no dedicated test — noted) |
| 12–14 | Thai/EN/SKU search · keyboard · empty state | test groups 1-3, 5, 6 all pass |

### Security — Payment Hardening
| # | Claim | Verdict | Evidence |
|---|---|---|---|
| 15 | Missing secret ⇒ 503, no mutation | PASS | 3 endpoint tests |
| 16–17 | Missing/malformed signature ⇒ 401 | PASS | tests at :155-159 |
| 18 | Valid signature processed | PASS | all 3 routes |
| 19 | Redelivery idempotent | PASS | :168-200 |
| 20 | Dev bypass needs explicit flag `=== '1'` | PASS | webhook-guard.js:17 + live test |
| 21 | Prod ignores bypass flag | PASS | prod-first short-circuit + live test :219-225 |
| 22 | No runtime promptpay.io request | **FAIL → FIXED** | see below |
| 23 | QR payload vectors unchanged | PASS | snapshot test |
| 24 | Payment QR works w/o CDN | PASS (source-level; real network-cut not testable here) | local-only loader, no fallback |

## The FAIL — and its fix
`frontend/menu.html:559` (public online-ordering page, `/menu/:token`) still rendered
`<img src="https://promptpay.io/<merchant-id>/<total>.png">` on **every prepaid online order** —
the same leak class fixed in index.html by `d1df845`. Root cause: menu.html is a separate static
page; the fix and its tests only covered index.html.

**Fixed on branch `fix/menu-promptpay-leak` @ `4fe45c0`** (off `4f994c9`): local EMVCo payload
(byte-identical to the index.html generator on 3 vectors) + vendored QR lib via ABSOLUTE
`/vendor/…` path (page lives at `/menu/:token`) + controlled Thai failure message. The test file
now scans menu.html too — closing the audit gap that let this survive. Suite: 49/49.

## Suite counts (sequential, real DB)
P1 27/27 (incl. 749 inline harness assertions) · P2 21/21 · Security 45/45 (→ 49/49 with menu fix)
