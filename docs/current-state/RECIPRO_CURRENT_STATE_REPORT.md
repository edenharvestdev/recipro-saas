# Recipro SaaS — Current State Report

**อัปเดต:** 2026-06-28 (หลัง Brand Asset Update + Login Polish deploy)
**โหมด:** Maintenance Freeze — แก้เฉพาะ P0/P1 bug เท่านั้น

---

## 1. Git / Version

| ข้อมูล | ค่า |
|--------|-----|
| Repository | https://github.com/edenharvestdev/recipro-saas |
| Branch | `main` |
| Commit ล่าสุด | `f38cf9b` — Login header polish round 2 — breathing room + refined typography |
| Commit ก่อนหน้า | `042130a` — Polish login card welcome header — premium brand presentation |
| Commit ก่อนหน้า | `718c05c` — Update Recipro official brand assets |
| Commit ก่อนหน้า | `73052b2` — docs: update project status report and add RC-001 post-mortem docs |
| Commit ก่อนหน้า | `9609458` — Fix Railway root dependencies for Sprint 001 |

---

## 2. Railway Deployment

| ข้อมูล | ค่า |
|--------|-----|
| Project | recipro (`59c79c80-e16c-4456-bb56-a1126696703b`) |
| Service | recipro-app (`3add2803-2dd7-40c7-bdf8-8a64fc0c2bfb`) |
| Deployment ID | `e18ebc86-e15e-436b-a2bf-da1371e8a604` |
| Status | ● Online |
| Region | sfo (San Francisco) |
| URL | https://www.recipro.love |
| Environment | production |
| Builder | NIXPACKS (auto-detect Node.js จาก root `package.json`) |
| Start Command | `node backend/src/migrate.js && node backend/src/bootstrap.js && node backend/src/index.js` |
| Restart Policy | ON_FAILURE, max 5 retries |
| Database | Postgres 17 (Railway managed, `postgres-volume`) |
| Backup | Railway PITR (Point-in-Time Recovery) bucket |

---

## 3. Runtime Stack

### Backend
| ส่วน | ค่า |
|------|-----|
| Runtime | Node.js 24.10.0 |
| Framework | Express.js 4.21.2 |
| Database | PostgreSQL 17 via `pg` 8.13.1 |
| Auth | JWT — `jsonwebtoken` 9.0.2 (access 15m + refresh 30d) |
| Password | `bcryptjs` 2.4.3 (rounds: 12) |
| Payment | Omise API (mock mode) — `stripe` package installed แต่ไม่ได้ใช้ |
| Rate Limiting | `express-rate-limit` 8.5.2 |
| Error Monitoring | `@sentry/node` 10.62.0 (gated on `SENTRY_DSN` env var) |
| Email | RESEND — disabled (ยังไม่มี key) |
| Slip Verify | SlipOK — disabled (ยังไม่มี key) |
| ORM | ไม่มี — raw SQL parameterized queries ทั้งหมด |
| Build step | ไม่มี |

### Frontend
| ส่วน | ค่า |
|------|-----|
| Architecture | Single SPA — ไฟล์เดียว `frontend/index.html` (~12,000 บรรทัด) |
| Framework | Vanilla JS — ไม่มี React/Vue/Angular |
| Styling | CSS custom properties ใน `frontend/styles.css` |
| Icons | `frontend/icons.js` |
| PWA | `frontend/manifest.json` + `frontend/sw.js` |
| Public menu | `frontend/menu.html` (QR self-order สำหรับลูกค้า) |
| Build step | ไม่มี — static files serve ตรง |

---

## 4. Deployment Flow (ปัจจุบัน)

```
1. แก้ code ในเครื่อง
2. git commit
3. gh auth switch --user edenharvestdev   ← ต้อง switch account ก่อน push
4. git push origin main
5. railway up --service recipro-app --detach
6. ตรวจ: railway logs --service recipro-app
7. ตรวจ: railway status
8. QA manual บน https://www.recipro.love
```

**ไม่มี:** CI/CD pipeline, auto-deploy, staging environment, automated tests ก่อน deploy

---

## 5. Package Structure (บทเรียนจาก RC-001)

```
recipro-saas/               ← NIXPACKS installs from HERE
├── package.json            ← Railway installs dependencies จากไฟล์นี้
├── package-lock.json       ← ROOT lock file — ต้องอัปเดตทุกครั้งที่เพิ่ม dep
├── node_modules/           ← /app/node_modules/ ใน production
├── railway.json
├── backend/
│   ├── package.json        ← ใช้สำหรับ local dev เท่านั้น — Railway ไม่อ่านไฟล์นี้
│   └── src/
│       └── app.js          ← require() ค้นหา modules จาก /app/node_modules/ ขึ้นไป
└── frontend/
```

**กฎ:** dependency ใหม่ทุกตัวต้องอยู่ใน **ROOT `package.json`** เสมอ

---

## 6. Environment Variables

| Variable | จำเป็น | สถานะ Production | หมายเหตุ |
|----------|--------|-----------------|----------|
| `DATABASE_URL` | ✅ Required | ✅ ตั้งแล้ว | PostgreSQL connection string |
| `JWT_SECRET` | ✅ Required | ✅ ตั้งแล้ว | Access token signing key |
| `JWT_REFRESH_SECRET` | ✅ Required | ✅ ตั้งแล้ว | Refresh token signing key |
| `SUPERADMIN_EMAIL` | ✅ Required | ✅ ตั้งแล้ว | |
| `SUPERADMIN_PASSWORD` | ✅ Required | ✅ ตั้งแล้ว | |
| `APP_URL` | ✅ Required | ✅ `https://www.recipro.love` | |
| `PGSSL` | Optional | ✅ ตั้งแล้ว | SSL สำหรับ Railway Postgres |
| `PORT` | Optional | Railway จัดให้ | Default 8080 |
| `SENTRY_DSN` | ⚠️ Monitoring | ❌ ยังไม่ตั้ง | ใส่แล้วเปิด error monitoring ทันที |
| `OMISE_SECRET_KEY` | ⚠️ Payment | ❌ ยังไม่ตั้ง | ใช้ mock mode อยู่ |
| `OMISE_WEBHOOK_SECRET` | ⚠️ Security | ❌ ยังไม่ตั้ง | HMAC ยืนยัน Omise webhook |
| `RESEND_API_KEY` | ⚠️ Email | ❌ ยังไม่ตั้ง | Email ถูก disable |
| `SLIPOK_API_KEY` | Optional | ❌ ยังไม่ตั้ง | ตรวจสลิปอัตโนมัติ |
| `SLIPOK_BRANCH_ID` | Optional | ❌ ยังไม่ตั้ง | |

---

## 7. Database / Migration Status

| ข้อมูล | ค่า |
|--------|-----|
| Engine | PostgreSQL 17 |
| Migration system | Additive SQL files — รัน `node backend/src/migrate.js` |
| Migration approach | `CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS` — idempotent |
| Migration ล่าสุด | `schema-s10.sql` |
| Auto-run on deploy | ✅ ใช่ — startCommand รัน migrate ก่อนเสมอ |
| Rollback | Manual SQL เท่านั้น — ไม่มี down-migration |
| Shops ใน production | 14 ร้าน (ยืนยันจาก bootstrap log หลัง Brand deploy) |

---

## 8. Security Status

| Feature | สถานะ |
|---------|--------|
| JWT auth (access + refresh) | ✅ Active |
| Tenant isolation (`req.shopId`) | ✅ Active — middleware level |
| Rate limiting — login | ✅ 20 req/15min |
| Rate limiting — register | ✅ 10 req/hour |
| Rate limiting — checkout | ✅ 5 req/hour |
| Rate limiting — charge | ✅ 10 req/5min |
| Staff discount server-side enforcement | ✅ Active — ตรวจใน sync.js |
| Omise webhook HMAC | ✅ Code ready — ต้องการ `OMISE_WEBHOOK_SECRET` |
| `trust proxy` (Railway reverse proxy) | ✅ Active |
| Helmet.js | ❌ ไม่มี (P2) |
| CORS | ✅ Basic (open) — Bearer token auth ไม่ใช้ cookie |
| Password reset | ❌ ไม่มี — รอ RESEND key |
| Email verification on register | ❌ ไม่มี — รอ RESEND key |

---

## 9. Payment Status

| ข้อมูล | ค่า |
|--------|-----|
| Provider | Omise (configured) |
| Mode | **Mock** — `OMISE_SECRET_KEY` ยังไม่ได้ตั้งใน Railway |
| Mock behavior | สร้าง charge จำลอง `mock_xxx` → ใช้ `/pay/charge/:id/mock-paid` เพื่อ simulate |
| Production payment | ❌ ยังไม่พร้อม — รอ `OMISE_SECRET_KEY` จาก Omise dashboard |
| Billing checkout | ❌ 503 — ผูกกับ payment gateway |
| Stripe | Installed แต่ไม่ได้ใช้งาน |

---

## 10. Authentication Status

| Feature | สถานะ |
|---------|--------|
| Login / JWT | ✅ Active |
| Refresh token | ✅ Active |
| Register | ✅ Active |
| Password reset | ❌ ไม่มี (รอ RESEND) |
| Email verification | ❌ ไม่มี (รอ RESEND) |
| Superadmin login | ✅ Active |
| Staff invite system | ✅ Active |

---

## 11. Monitoring Status

| Feature | สถานะ |
|---------|--------|
| Sentry error monitoring | ⚠️ Code deployed — ต้องการ `SENTRY_DSN` ใน Railway |
| Uptime monitoring | ❌ ไม่มี |
| Railway logs | ✅ ดูได้ด้วย `railway logs --service recipro-app` |
| Health endpoint | ✅ `GET /health` → `{"ok":true}` |
| Cron job | ✅ รันทุก startup — suspend overdue shops, send reminders |

---

## 12. Known Issues Summary

ดูรายละเอียดเพิ่มเติมใน [OPEN_ISSUES.md](OPEN_ISSUES.md)

| Priority | Issue | สถานะ |
|----------|-------|--------|
| P0 | Omise payment ใช้ mock mode | ⏳ รอ key |
| P0 | ไม่มี Sentry DSN ใน Railway | ⏳ รอ Founder ตั้ง |
| P1 | ไม่มี password reset | ⏳ รอ RESEND key |
| P1 | Integration test ไม่ผ่าน local | ⏳ config issue |
| P2 | ไม่มี staging environment | — |
| P2 | ไม่มี Helmet.js | — |
| Tech Debt | ROOT + backend package.json ต้อง sync manual | — |

---

## 13. Incident Log

| วันที่ | Incident | ต้นเหตุ | Resolution |
|--------|----------|---------|------------|
| 2026-06-28 | RC-001: Production DOWN 502 หลัง Sprint 001 | `@sentry/node` อยู่ใน `backend/package.json` แต่ Railway ติดตั้งจาก ROOT `package.json` | เพิ่ม 2 packages ใน ROOT `package.json`, อัปเดต ROOT lock file, redeploy commit `9609458` |
| 2026-06-29 | HBT02 Stock Mismatch & Mode Mismatch | HBT02 was set to inherit (MTO) and had a Production Batch #1 undercount of 11 cups | Changed HBT02 mode to finished_goods, adjusted stock (+11), added per-recipe modes and reversal_of link to DB, verified by QA | ✅ ea82e86 |
