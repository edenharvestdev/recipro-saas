# Vendored frontend dependencies

Third-party libraries the frontend needs at runtime that we ship ourselves
instead of loading from a third-party CDN. This avoids: (a) a live network
call to an external host on the payment screen, (b) a silent failure mode if
that CDN is slow/blocked/down, and (c) an unpinned/undetected upstream change
landing in production without review.

## qrcode-generator

- **Library:** [`qrcode-generator`](https://www.npmjs.com/package/qrcode-generator) by Kazuhiko Arase
- **Version:** `1.4.4`
- **Vendored file:** `frontend/vendor/qrcode-generator-1.4.4.js`
- **Source:** `https://registry.npmjs.org/qrcode-generator/-/qrcode-generator-1.4.4.tgz`
  (the same file previously loaded at runtime from
  `https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.js` — jsDelivr
  serves the npm package's `qrcode.js` unmodified, so this is byte-identical
  to what was already running in production)
- **License:** MIT — (c) 2009 Kazuhiko Arase (full license header kept at the
  top of the vendored file, below our provenance header)
- **SHA-256 of the upstream `qrcode.js` body** (i.e. everything in the
  vendored file *after* our provenance header comment):
  `18ae399f81182bc9de916e9c77b195df20cc58d6f2d55a62b085a299f1bf1780`

### Where it's used

`frontend/index.html`'s `ensureQrLib()` (payment QR loader) lazily injects
`<script src="./vendor/qrcode-generator-1.4.4.js">` the first time a payment
QR is needed (POS "receive payment" sheet, the customer-facing QR Box, and
the bill/receipt PromptPay QR). There is **no remote fallback**: if the local
asset fails to load, `ensureQrLib()` rejects and every caller shows the
controlled Thai error `สร้าง QR ไม่ได้ — โหลดไลบรารีไม่สำเร็จ กรุณารีเฟรช`
instead of silently doing nothing or ever implying a payment succeeded.

`backend/src/app.js`'s `VERSIONED_ASSETS` list includes
`vendor/qrcode-generator-1.4.4.js` so it gets the same cache-busting
`?v=<build-hash>` query string as the app's other static assets
(`materialResolver.js`, `styles.css`, etc.) — a new deploy is picked up
without requiring a hard refresh.

Note: `frontend/index.html`'s unrelated product/price **label printing**
feature (`printLabel()`, ~line 4963) still loads `qrcode-generator@1.4.4`
(and `jsbarcode`) from `cdn.jsdelivr.net` for its own print-preview popup.
That code path is not on the payment path and carries no merchant/payment
data, so it was left out of scope for this fix — see the payment-path
hardening PR description for the explicit judgment call. If it's ever put in
scope, point it at this same vendored file (JsBarcode is separate and not
vendored here).

### Update procedure

1. Decide the target version and read its changelog/diff against the current
   pinned version — this is a QR-rendering library used on the payment
   screen; treat any change as security-relevant.
2. Fetch the exact version's package tarball from the npm registry, e.g.:
   `https://registry.npmjs.org/qrcode-generator/-/qrcode-generator-<version>.tgz`
   (or `npm pack qrcode-generator@<version>` in a scratch directory — do not
   run `npm install` inside this repo for a frontend-only vendored asset).
3. Extract `qrcode.js` from the tarball and compute its SHA-256.
4. Replace `frontend/vendor/qrcode-generator-<old>.js` with a new file named
   `frontend/vendor/qrcode-generator-<new-version>.js`, keeping the same
   provenance header format (name, version, source URL, license, SHA-256 of
   the upstream body, vendored date/reason) followed by the unmodified
   library source.
5. Update every reference to the old filename:
   - `frontend/index.html`'s `ensureQrLib()` — the `s.src = "./vendor/...";`
     line.
   - `backend/src/app.js`'s `VERSIONED_ASSETS` array.
   - This document (version, file path, SHA-256).
6. Re-run `backend/test/promptpay-local-qr.test.js` (checks the loader has no
   remote fallback) and manually smoke-test a payment QR renders in the
   browser.
7. Delete the old versioned file once the new one is confirmed working (keep
   only one vendored copy live at a time — don't accumulate old versions).
