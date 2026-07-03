# Aggregate Delivery Draft Import — 22–30 June 2026 (Track B)

Creates 8 aggregate **Delivery DRAFTS** (one per shop × platform) from the LINE MAN and Grab
platform reports, for HB01–HB04, period **2026-06-22 → 2026-06-30**. **Draft-only** — no stock
deduction, no revenue, no COGS, no settlement, no confirm.

## Source
Google Sheet `1ormPlOZvLpnjFggfxY3KnTX2AxDSKCQIHL9TMSqpBwg`
- `LM22-30/06` (gid 0) → LINE_MAN — snapshot: `source/LM22-30-06.csv`
- `Grab22-30/06` (gid 1624500070) → GRAB — snapshot: `source/Grab22-30-06.csv`

## Target shops (verified; never cross-branch)
| Branch | Shop | Shop ID |
|---|---|---|
| HB01 | HB01-Ladprao107 สาขาลาดพร้าว107 | 581c5f9b-bc79-4270-8ad8-98a288be7933 |
| HB02 | HB02-Samyan สาขาสามย่าน | 2a91e65b-cd05-4110-8878-883482ba9228 |
| HB03 | HB03-Nawamin111 สาขานวมินทร์ 111 | 116a5eda-3b6b-4c2c-97a8-3393fa8a1115 |
| HB04 | HB04-Saphan Khwai | 3ebea0b3-f3a9-40ae-b6b4-080e4b48efcc |

`Recipro สาขาสะพานควาย` (6bf94b93…, 0 recipes) is **not** a target.

## Scripts
- `generate.js` — pure-local; reads the source CSVs + `catalog-snapshot.json` (read-only prod catalog,
  git-ignored) → emits `staged-lines.json` + `DELIVERY-IMPORT-EXCEPTIONS-22-30-JUNE-2026.csv`.
- `import.js` — per draft, one transaction: idempotency re-check → shop-ID validation → INSERT batch
  (`status='draft'`, `stock_deducted=false`) → INSERT items (`stock_mode='HOLD_FOR_REVIEW'`,
  `unit_price=0`) → in-tx post-verify → COMMIT (only with `COMMIT=1`) else ROLLBACK.
  Idempotent via unique `(shop_id, client_request_id)`.

## Run result (committed batches)
| Draft | Batch ID | Source | Staged units | Staged lines |
|---|---|--:|--:|--:|
| HB01 × LINE_MAN | 35ea8f3e-5a8f-49bb-81b2-da3b1e8806be | 228 | 172 | 33 |
| HB02 × LINE_MAN | a42667d7-7bf6-4e40-8c2a-89ecf070b067 | 274 | 209 | 40 |
| HB03 × LINE_MAN | a7184619-373b-44f3-ab74-d52eeb43eeea | 430 | 389 | 47 |
| HB04 × LINE_MAN | 89d90f8a-0c12-46d4-ab59-5e9242c8ea8e | 366 | 290 | 41 |
| HB01 × GRAB | d377ec13-38a6-4a0f-8b78-013a967c4476 | 404 | 336 | 40 |
| HB02 × GRAB | da4dc381-72b9-4ef1-b22f-9e1acfd10324 | 1058 | 816 | 59 |
| HB03 × GRAB | 235eb598-c31f-4ef8-b92e-ee95e652fa20 | 386 | 309 | 59 |
| HB04 × GRAB | 5521580f-fe7a-456a-b2d1-db0fe81e0df0 | 400 | 294 | 46 |
| **Total** | | **3546** | **2815** | 365 |

Reconciliation per draft: `staged + held = source` (Δ 0). Held total **731**:
Cool Pack 727 (`COOL_PACK_MENU_CREATION_REQUIRED`), Blush 3 (`MISSING_CODE_MANUAL_REVIEW`),
HBD11P 1 (`PACK_CONVERSION_REQUIRED`). See the exception CSV.

## Held for Founder review (do NOT resolve without approval)
- **Cool Pack** (727u) — sold as a distinct menu; **no Cool Pack menu/packaging exists** in any shop
  catalog. Needs a distinct Cool Pack menu (base recipe + verified packaging materials) before import.
- **Blush Coconut Peach Rose Matcha Velvet** (3u) — no source code, no catalog target.
- **HBD11P Mochi Butter Bun 5-pack** (1u) — pack→pieces conversion unverified.

## Resolved (per Founder directive, staged)
- `HBC01M06C` → **Classic Clear Matcha Yame Okumidori** (catalog code is truth; sheet "Uji Okumidori"
  treated as a naming error — `SOURCE_NAME_MISMATCH_RESOLVED_BY_CATALOG_CODE`).
- M21C/M23C branch variants resolved against each shop's catalog; toppings + desserts matched to
  verified same-shop IDs.

**Not confirmed. Financial totals pending. Stock mode pending Founder review.**
