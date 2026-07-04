# Online Menu / Customer Ordering UX V2

Branch: `feat/online-menu-ux-v2` · Status: **PR open, awaiting Founder review — NOT merged, NOT deployed.**

## Feature-Freeze Exception (recorded)

The active feature freeze covers **historical stock deduction / Delivery Drafts / Excel import**
(Excel remains the temporary source of truth; no historical deduction). This track is an
**approved exception** because it is:

- **Frontend-first + additive only.** No change to POS stock deduction, Option Engine,
  bill lifecycle, payment, subscription/billing, historical Delivery/stock/Drafts, void/correction.
- **Presentation-only.** The Marketing Showcase highlights existing menu items / categories /
  promotions. It performs **no discount, price, or stock calculation** of any kind.
- **No destructive data model change.** Showcase data lives inside the existing
  `shop_settings.menu_config` jsonb (`showcase_slots` array). **No new table, no migration,
  no DROP/RENAME.** Fully backward-compatible; shops with no slots see the menu directly.

## What shipped

**Customer menu (`frontend/menu.html`)**
1. Product card redesign — image on top, **name / price / badges below the image** (no text over
   the photo). Applies to both grid and flipbook views. Optional shop badges
   (แนะนำ/ขายดี/ใหม่/Limited/Seasonal/Promotion) + automatic "มีตัวเลือก".
2. Category sections keep header-above-grid; category names are never drawn on images.
3. Category navigation — sticky quick-tabs + **"☰ ดูหมวดทั้งหมด" ToC drawer** that jumps to a category.
4. **Marketing Showcase** (max 4 slots) first-load carousel: prev/next, dots, swipe, ข้าม / ดูเมนู.
   - No active slots → menu opens directly (never trapped, never an empty carousel).
   - Session-level state (`sessionStorage`): not re-forced on reopen; re-entry via ✨ ไฮไลต์เดือนนี้ chip.
   - CTA routing reuses existing flows: MENU_ITEM → product/option sheet (สั่งเมนูนี้),
     CATEGORY → jump (ดูหมวดนี้), PROMOTION → existing promo link (ดูโปรโมชั่น), NONE → ดูเมนู.
5. Cart readability — each line shows name · selected options · unit×qty · line price (not one long title).
6. Dual mode preserved — QR mobile + kiosk/counter (`?kiosk=1`, larger touch targets), same order engine.

**Admin (`frontend/index.html` → เมนูออนไลน์)**
7. Showcase manager: up to 4 slot cards — active toggle, type, title, description, hero image,
   badge, CTA label, target type + shop-scoped target picker, start/end datetime, reorder ↑/↓, delete.
   Live state badges (กำลังแสดง / ยังไม่ถึงเวลา / หมดอายุ / ปิดใช้งาน), inline validation, active x/4 counter.

**Backend (`backend/src/menu-showcase.js`, wired in `api/public.js`)**
8. Pure, deterministic model + validation (`validateForSave`) and display sanitizer
   (`sanitizeForDisplay`). The public menu endpoint sanitizes slots server-side so a customer
   NEVER sees inactive / scheduled / expired / cross-shop / deleted-target slots. Hard cap 4.

## Verification

- `backend/test/menu-showcase.test.js` — 25/25 pass (max-4, 5th rejected, title-required,
  end>start, cross-shop/missing target rejected, inactive/scheduled/expired hidden, display order,
  MENU_ITEM/CATEGORY/PROMOTION links, no-showcase→empty, lifecycle states).
- Regression (local DB): bills 55, coupons 34, permissions 50, permission-mapping 14,
  printers 22, print-routing 26, **delivery 195 (untouched)** — 421 total, 0 failures.
- Live browser (local HB05, 116 items): product name geometrically below image (no overlay),
  ToC drawer, quick tabs, Showcase carousel + per-type CTAs + session + CATEGORY routing,
  admin manager render + ghost-target warning. No console errors. `/public/menu` returns
  sanitized `showcase_slots`.
- Responsive: 0 horizontal overflow at 1440, 1024×600, 390 (grid / book / kiosk / showcase-open).

## Files touched

- `frontend/menu.html` — product cards, category ToC/quick-nav, Showcase carousel, cart readability.
- `frontend/index.html` — Online Menu admin: Showcase manager UI + CRUD/validation + promo id backfill.
- `backend/src/menu-showcase.js` — new pure model/validation/sanitizer.
- `backend/src/api/public.js` — sanitize + attach `showcase_slots` for display (only new lines).
- `backend/test/menu-showcase.test.js` — new unit tests.
- `docs/current-state/ONLINE_MENU_UX_V2.md` — this record.

**No** stock / payment / bill-lifecycle / Delivery / migration files changed.

## Deferred (not in this PR)

- Auto ranking for BEST_SELLER / PRODUCT_OF_MONTH (manual pick only, per spec item 12).
- Per-item shop badges authoring in the item editor (customer card already renders `item.badges`
  when present; the admin authoring surface is a follow-up — no data risk).
