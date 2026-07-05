# Production Deploy — Online Menu UX V2 + Hardening (2026-07-04)

Status: **PRODUCTION_DEPLOY_STABLE**

Live commit: `1ffd24f` · Service: `recipro-app` (Railway) · Domain: www.recipro.love
15-minute post-deploy monitor: 10/10 samples clean, 0 anomalies, logs clean.

## Live production baseline (locked)

| Item | State |
|---|---|
| Live commit | `1ffd24f` (contains merged PR #22 + PR #20 + deploy hotfix) |
| Health | 200 (stable across 15-min window) |
| Online Menu UX V2 | **ACTIVE** (product cards / category ToC / max-4 Showcase / cart readability) |
| Helmet security headers | **ACTIVE** (nosniff, X-Frame SAMEORIGIN, HSTS, Referrer-Policy, DNS-prefetch off, X-Powered-By hidden; CSP + COOP/COEP/CORP intentionally disabled) |
| Sentry readiness/scrubber code | **DEPLOYED** |
| Sentry monitoring | **INACTIVE — no SENTRY_DSN** (dormant) |
| Option Stock Effect Engine V1 (PR #21) | **NOT DEPLOYED** (branch open, engine OFF) |
| Historical Delivery | **FROZEN** |
| Delivery Drafts | **8** |
| Historical Delivery `stock_deducted` | **0** |
| Delivery item HOLD_FOR_REVIEW | 366 (DEDUCT_FULL 1) |
| Historical stock deduction | **NOT RUN** |
| POS stock deduction / Option Engine | unchanged |
| Payment / billing | unchanged |

## Frozen — do not touch (no Founder approval)
8 historical Delivery Drafts · Cool Pack / Blush / HBD11P held rows · Excel historical import ·
historical stock deduction. No new Drafts, no Confirm, no stock movement from historical sales.

## Deploy incident (resolved, recorded)

**Symptom:** first production deploy of the reviewed tree (`2580dea`) crash-looped —
`Error: Cannot find module 'helmet'` — health 502 for ~10 min. `migrate: done` ran fine;
purely a dependency-resolution failure.

**Root cause:** Railway installs runtime dependencies from the **repository-root**
`package.json` / `package-lock.json` (see `railway.json` → `startCommand: node backend/src/index.js`,
NIXPACKS builder). PR #20 added `helmet` only to `backend/package.json`. Production `npm ci`
from the root never installed helmet, so `require('helmet')` in `backend/src/app.js` resolved to
root `/app/node_modules` where it was absent. (`backend/node_modules` is gitignored and not in the
prod image.) A first hotfix that regenerated only the *backend* lockfile (`9e3140e`) did not help.

**Resolution:** add `helmet ^8.2.0` to **root** `package.json` + regenerate root `package-lock.json`
(`1ffd24f`); redeploy → health 200; 15-min monitor clean.

## PERMANENT ENGINEERING RULE — new runtime backend dependency

The production dependency manifest is the **repo-root** `package.json`, NOT `backend/package.json`.
Before merging/deploying any new runtime backend dependency, verify all six:

1. **Deployment root** — `railway.json` builder + startCommand (currently repo root, `node backend/src/index.js`).
2. **Install command** — production `npm ci` (with `--omit=dev` / NODE_ENV=production).
3. **package.json used by production** — repo-root `package.json` → the new dep MUST be listed there.
4. **package-lock.json used by production** — repo-root `package-lock.json` → regenerate so `npm ci` installs it.
5. **Clean-room `npm ci --omit=dev`** — in a temp copy of the root manifests; confirm the module installs.
6. **Runtime resolution** — from the production entrypoint (`backend/src/…`), confirm `require()` resolves
   the module from root `node_modules` (test with `backend/node_modules` removed).

Do not assume `backend/package.json` is the production manifest.

## Follow-ups (separate tracks, not in this one)

- **SENTRY_FOLLOW_UP_REQUIRED** — do not invent/create a DSN. When the Founder provides a real
  Sentry project/DSN, add it as a Railway secret in a separate infra track. Error monitoring is NOT
  claimed active until a real event is received and confirmed scrubbed.
- **Next active product track:** HIBI Option V2 + Catalog V2 + Option Stock Effect Engine (PR #21),
  QA'd on the isolated HIBITEST shop. Wait for the Founder's Option V2 structure before configuring
  Stock Effects, Phase E POS-deduction wiring, enabling `OPTION_STOCK_ENGINE_V1`, any production
  migration, or real-branch rollout.
