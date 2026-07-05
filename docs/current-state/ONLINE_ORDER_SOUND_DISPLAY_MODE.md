# Online Order Sound Presets + Customer Display Mode

Branch: `feat/online-order-sound-display-mode` · Status: **PR only — not merged, not deployed.**
Feature-Freeze Exception (focused): distinct notification sounds + customer-facing non-order display/closed modes.

## A. Notification sound presets

**Root cause of duplication:** the three old presets (`ร่าเริง / สดใส / เบิกบาน`) were near-identical
iTunes-generated cheerful melodies embedded as base64 m4a — audibly indistinguishable.

**Fix:** replaced with **4 genuinely-distinct GENERATED Web Audio patterns** (no audio files, no
copyrighted assets). Canonical source of truth: `backend/src/order-sound-presets.js`; the same 4
patterns are played in `frontend/index.html` via `AudioContext`.

| Preset | Thai label | Pattern (generated) | Duration |
|---|---|---|---|
| STANDARD | มาตรฐาน | 2-tone 660→880 Hz sine ("ดิง-ดอง") | ~0.36s |
| CUTE_BELL | กริ่งน่ารัก | ascending triad 1047→1319→1568 Hz (triangle→sine) | ~0.40s |
| URGENT_TICKS | ติ๊ดเร่งรับออเดอร์ | 4× 1200 Hz square pulses ("ติ๊ด ๆ ๆ") | ~0.38s |
| DOUBLE_BEEP | บิ๊บ บิ๊บ | 2× 740 Hz square beeps | ~0.33s |

- Settings: `ขาย & ออกบิล → ออนไลน์ (QR)` — preset selector + **ทดลองเสียง** button previews the *currently
  selected* preset (no real order needed). Legacy stored tune ('1'/'2'/'3') migrates → STANDARD.
- Alert trigger/order-state logic unchanged. Browser autoplay: AudioContext unlocks on first tap;
  a Thai hint shows if still blocked. Per-device (`localStorage`).

## B. Customer Display Mode

Adds a per-shop mode to `menu_config` (additive jsonb): `display_mode` ∈
`ONLINE_ORDER | PROMOTION_DISPLAY | MENU_CLOSED` (+ `promo_display` / `closed_display` content).

- **ONLINE_ORDER** (เปิดรับออเดอร์): normal menu + showcase + cart + ordering.
- **PROMOTION_DISPLAY** (โหมดโปรโมชั่น): full-screen campaign display (image/title/description/CTA); ordering off.
- **MENU_CLOSED** (ปิดรับออเดอร์): closed screen (image/title/description); ordering off. Defaults if no image.

**Server-side enforcement (`api/public.js` + pure `display-mode.js`):** `GET /public/menu` exposes the mode
+ content; `POST /public/order` returns **HTTP 423** with a Thai reason when mode ≠ ONLINE_ORDER — a customer
cannot order by calling the endpoint directly (not CSS-only). Missing/unknown mode → ONLINE_ORDER (backward
compatible). **POS staff sales (`/api/*`) are unaffected.**

- Customer menu (`menu.html`): renders the promo/closed screen, hides cart/showcase/menu, empties the cart.
- Admin (`index.html` → เมนูออนไลน์ → การแสดงผลเมนูออนไลน์): mode selector + promo/closed content editors;
  images use the existing `compressImage` + base64-in-`menu_config` flow (no new storage).
- Separate from Marketing Showcase (Showcase = ≤4 highlights, ordering stays open; Display Mode = ordering off).

## Verification
- `backend/test/display-sound.test.js` — **18/18** (default ONLINE_ORDER, block reasons, publicDisplay,
  4 distinct sound patterns, no duplicate, legacy migration, labels, index.html key-sync).
- Live HTTP (local HB05): ONLINE_ORDER→order 200; MENU_CLOSED→423 (MENU_CLOSED); PROMOTION_DISPLAY→423
  (PROMOTION_DISPLAY). `GET /public/menu` returns mode + content. POS `/api/*` untouched.
- Customer screens (local): promo + closed render correctly, cart hidden, no order CTA; ONLINE_ORDER
  restores the full menu (116 cards, cart shown). Responsive **0 horizontal overflow** @ 1440 / 1024×600 /
  768×1024 / 375.
- Regression: display-sound 18 · menu-showcase 25 · bills 55 · coupons 34 · permissions 50 ·
  permission-mapping 14 · printers 22 · print-routing 26 · **delivery 195** — 439 total, 0 failures.

## Files & safety
`frontend/index.html` (sounds + display-mode admin), `frontend/menu.html` (display-mode render),
`backend/src/api/public.js` (mode fields + order block), `backend/src/display-mode.js` (new),
`backend/src/order-sound-presets.js` (new), `backend/test/display-sound.test.js` (new).
**No** stock / Option-Engine / bill-lifecycle / payment / billing / Delivery / migration change.
**Zero new runtime dependency** (root/backend manifests untouched — heeds the deploy-root rule).

## Risks / limitations
Actual audio output can't be auto-verified (no audio device in CI) — distinctness is proven on the
pattern data + syntax; playback path is standard Web Audio. Sound is per-device (localStorage), not
per-shop. Promo CTA is display-only text in V1 (no linked-target navigation) to stay in safe scope.
