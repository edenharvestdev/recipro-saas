# Security Hardening — Sentry readiness + Helmet headers

Track `fix/production-hardening-sentry-helmet-p1` (2026-07-03). Backend-only. No env changes, no
Delivery changes. Not merged/deployed at time of writing.

## Sentry (error monitoring)
- **Code status:** integrated in `backend/src/app.js`. `Sentry.init()` runs **only when `SENTRY_DSN`
  is set**; `Sentry.setupExpressErrorHandler(app)` is registered after all routes. Init happens before
  other `require`s for full auto-instrumentation.
- **External dependency (required to go live):** a real `SENTRY_DSN` env var (create a Sentry project).
  Code does **not** ship a DSN. **Do not mark Sentry operational until a real DSN is configured and a
  captured test event is verified.**
- **Safe when DSN absent:** app starts normally, no Sentry network calls, no warning loop, no crash
  (verified: `test/sentry-redaction.test.js` SR1/SR2).
- **Redaction (`backend/src/sentry-scrub.js`, `beforeSend`/`beforeSendTransaction`):**
  - `sendDefaultPii: false` (no auto IP / headers / cookies / bodies).
  - strips `authorization`, `cookie`, `x-access/refresh/token` request headers + `request.cookies`.
  - **drops request bodies entirely** for `/auth`, `/pay`, `/billing`, `/webhooks` endpoints.
  - deep-redacts keys matching password / secret / api-key / token / `DATABASE_URL` / dsn / jwt /
    omise / stripe / card / cvv / private-key in body, extra, contexts, tags.
  - drops the raw runtime env; scrubbing never throws.
  - No DSN value is logged anywhere.
- **Release/commit:** `release` set from `RAILWAY_GIT_COMMIT_SHA` / `GIT_COMMIT_SHA` when present (SHA is
  not a secret); omitted otherwise.
- **Dev/test mechanism:** `test/sentry-redaction.test.js` (21 checks) proves redaction + startup safety
  without a DSN and without any public throw endpoint. To validate live capture, set a real DSN in a
  **non-production** environment and call `Sentry.captureException(new Error('test'))`.

## Helmet (security headers) — SAFE MODE
Added `app.use(helmet({...}))` right after `app.set('trust proxy', 1)`. Conservative config for the
inline-script Vanilla SPA + PWA. Verified live headers on `/`, `/index.html`, `/styles.css`, `/icons.js`,
`/manifest.json`, `/sw.js`, `/menu.html`, and a protected API 401:
- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: SAMEORIGIN`
- `Referrer-Policy: strict-origin-when-cross-origin`
- `X-DNS-Prefetch-Control: off`
- `Strict-Transport-Security: max-age=15552000; includeSubDomains` (safe: Railway terminates HTTPS +
  `trust proxy=1`)
- `X-Powered-By` **removed**

### CSP status — DISABLED (intentional)
CSP is **off** in this PR. The SPA relies on inline `<script>`/`<style>`, `blob:`/`data:` images, print
windows (`window.open`), `sw.js` + `manifest.json`. A strict CSP would break it. A **Report-Only** CSP,
proven compatible first, is a **separate future track**. COOP/COEP/CORP and Origin-Agent-Cluster are
disabled so print/QR popups and cross-origin asset loads keep working.

## CORS — AUDIT ONLY (unchanged this PR)
`backend/src/app.js` sets, for all responses:
- `Access-Control-Allow-Origin: *`
- `Access-Control-Allow-Headers: Authorization, Content-Type, X-Shop-Id`
- `Access-Control-Allow-Methods: GET, POST, PATCH, DELETE, OPTIONS`
- **Credentials NOT enabled** (no `Access-Control-Allow-Credentials`) — auth is **Bearer token**, not
  cookies, so the wildcard does not expose credentialed cross-site requests.
- `Authorization` header is accepted. Frontend + public menu are served **same-origin** with the API.
- **Recommendation (future Founder-approved track):** move to an explicit allowlist (e.g.
  `https://www.recipro.love` + app origins) if/when cookie-based auth is introduced. **No change here.**

## Proxy / HTTPS safety
- `app.set('trust proxy', 1)` already present → HSTS + real client IP for rate-limits are correct behind
  Railway's HTTPS termination.
- No redirects added → no redirect-loop risk. No secure-cookie behavior (token auth). `/health`
  unaffected (200).

## Deployment / rollback notes
- Deploy: standard `railway up` from clean main (after Founder approval). Adds one dependency (`helmet`).
- Enabling Sentry post-deploy = set `SENTRY_DSN` env + restart; no code change needed.
- Rollback: revert the merge commit and `railway up`, or redeploy the previous image. No schema/data
  migration involved (headers + error-handler only).

## Not changed
No password reset, email verification, payment/Stripe/Omise, CORS policy, 2FA, or Delivery changes.
JWT auth, tenant isolation, staff permissions, and the discount ceiling are untouched (regression
suites green: sentry 21, integration 19, printers 22, print-routing 26, permissions 50, mapping 14,
bills 55, coupons 34, delivery 195).
