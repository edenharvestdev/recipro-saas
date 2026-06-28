# Recipro SaaS — Current State Report

**สร้าง:** 2026-06-28  
**โหมด:** Stabilization / Maintenance (ห้ามเพิ่ม feature ใหม่)

---

## 1. Repository & Branch

| ข้อมูล | ค่า |
|--------|-----|
| Repo | https://github.com/edenharvestdev/recipro-saas |
| Branch ปัจจุบัน | `main` |
| Commit ล่าสุด | `2b0417e` feat: A2 promotions, C2 member tiers, C3 cross-branch admin, silent print |
| Git status | `clone.js` มีการแก้ที่ยังไม่ได้ commit, ไฟล์ untracked 2 ไฟล์ (grab-bills.js, delivery-bills.js) |

---

## 2. Environment

| | ค่า |
|-|-----|
| Production URL | https://www.recipro.love |
| Staging | **ไม่มี** — มีแค่ production เดียว |
| Platform | Railway (Node.js + PostgreSQL 17) |
| Local Dev | Node.js + PostgreSQL 17 ที่ localhost:5432 |
| Port | `3100` (local) / Railway จัดให้อัตโนมัติ |

---

## 3. Tech Stack

### Backend
| ส่วน | เทคโนโลยี |
|------|------------|
| Runtime | Node.js 24 |
| Framework | Express.js |
| Database | PostgreSQL 17 (via `pg`) |
| Auth | JWT (access token + refresh token) via `jsonwebtoken` |
| Password | bcryptjs |
| Payment | Omise API (mock mode จนกว่าจะใส่ key) + Stripe webhook (เดินสายแล้ว แต่ไม่ได้ใช้) |
| ORM | ไม่มี — raw SQL parameterized queries ทั้งหมด |
| Email | RESEND (ยังไม่ได้ใส่ key — disabled) |
| Slip verify | SlipOK API (ยังไม่ได้ใส่ key) |
| Error monitoring | **ไม่มี** |
| CI/CD | **ไม่มี** — deploy ด้วย `railway up` manual |

### Frontend
| ส่วน | เทคโนโลยี |
|------|------------|
| Architecture | Single SPA — ไฟล์เดียว `index.html` (~12,000 บรรทัด) |
| Framework | Vanilla JS — ไม่มี React/Vue/Angular |
| Styling | CSS custom properties (design tokens) ใน `styles.css` |
| Icons | `icons.js` (Lucide via custom loader) |
| PWA | manifest.json + `sw.js` (service worker) |
| Public menu | `menu.html` แยกต่างหาก (QR self-order) |
| Build step | **ไม่มี** — static files serve ตรง |

---

## 4. Package Scripts

```bash
# Backend (backend/package.json)
npm start         # node src/index.js — เริ่ม server
npm run migrate   # node src/migrate.js — รัน SQL migrations ทั้งหมด
npm run bootstrap # node src/bootstrap.js — seed superadmin (ใช้ครั้งเดียว)
npm run cron      # node src/cron.js — recurring tasks
npm run test:int  # node test/integration.js — integration tests (ต้องการ DB)

# ไม่มี: typecheck, lint, build, unit tests
```

**ผลการรัน commands ที่ขอ:**
- `npm run typecheck` — **ไม่มีคำสั่งนี้** (ไม่มี TypeScript)
- `npm run lint` — **ไม่มีคำสั่งนี้** (ไม่มี ESLint/Prettier configured)
- `npm test` — **ไม่มีคำสั่งนี้** (ต้องใช้ `npm run test:int`)
- `npm run test:int` — **FAIL** (ต้องการ `DATABASE_URL` ใน `.env` — ไม่มีในเครื่อง local หลัง compaction)
- `npm run build` — **ไม่มีคำสั่งนี้** (ไม่มี build step)

```
# ผล test:int (รันโดยไม่มี .env):
  ✗ register returns tokens
TEST ERROR TypeError: Cannot read properties of undefined (reading 'id')
0 passed, 2 failed
```

---

## 5. Database / Migration Status

| ข้อมูล | ค่า |
|--------|-----|
| Migration system | Additive SQL files — `node src/migrate.js` รันตามลำดับในไฟล์ |
| จำนวนไฟล์ migration | 40+ ไฟล์ (schema.sql → schema-m12.sql) |
| Idempotent | ใช่ — `CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS` |
| Migration ล่าสุด | `schema-m12.sql` — promotions table (deploy วันนี้) |
| Auto-run on deploy | ใช่ — Railway Dockerfile รัน migrate ก่อน start |
| Rollback | **Manual** — ต้องเขียน SQL drop เอง (ไม่มี down-migration) |
| Backup | Railway built-in snapshot + `/api/snapshots` (in-app per shop) |

**ตารางหลักในระบบ:**
shops, memberships, users, shop_settings, materials, suppliers, recipes, recipe_items, bills, prod_logs, stock_receives, stock_movements, expenses, recurring_expenses, cash_topups, customers, cash_sessions, orders, option_groups, option_choices, option_choice_links, recipe_option_groups, promotions, subscriptions, plans, staff_invites, snapshots, event_logs, item_categories, branches

---

## 6. Environment Variables ที่จำเป็น (ห้ามเปิดเผย value)

| Variable | จำเป็น | สถานะ Production | หมายเหตุ |
|----------|--------|-----------------|----------|
| `DATABASE_URL` | ✅ Required | ✅ ตั้งแล้ว (Railway) | PostgreSQL connection string |
| `JWT_SECRET` | ✅ Required | ✅ ตั้งแล้ว | Access token signing key |
| `JWT_REFRESH_SECRET` | ✅ Required | ✅ ตั้งแล้ว | Refresh token signing key |
| `SUPERADMIN_EMAIL` | ✅ Required | ✅ ตั้งแล้ว | |
| `SUPERADMIN_PASSWORD` | ✅ Required | ✅ ตั้งแล้ว | |
| `APP_URL` | ✅ Required | ✅ `https://www.recipro.love` | ใช้สร้าง public URL |
| `PORT` | Optional | Railway จัดให้ | Default 3000 |
| `PGSSL` | Optional | ✅ ตั้งแล้ว | SSL สำหรับ Railway Postgres |
| `OMISE_SECRET_KEY` | ⚠️ Payment | ❌ **ยังไม่ได้ตั้ง** | ใช้ mock mode อยู่ |
| `RESEND_API_KEY` | ⚠️ Email | ❌ **ยังไม่ได้ตั้ง** | Email ถูก disable อยู่ |
| `SLIPOK_API_KEY` | Optional | ❌ ยังไม่ได้ตั้ง | ยืนยัน QR slip |
| `SLIPOK_BRANCH_ID` | Optional | ❌ ยังไม่ได้ตั้ง | |
| `STRIPE_SECRET_KEY` | Optional | ❌ ยังไม่ได้ตั้ง | Stripe เดินสายแล้วแต่ไม่ได้ใช้ |
| `STRIPE_WEBHOOK_SECRET` | Optional | ❌ ยังไม่ได้ตั้ง | |
| `RECIPRO_PROMPTPAY` | Optional | ❓ ไม่ทราบ | เลขพร้อมเพย์ร้าน |
| `PAYMENT_PROVIDER` | Optional | ❓ ไม่ทราบ | |
| `BCRYPT_ROUNDS` | Optional | Default 12 | |
| `JWT_EXPIRES_IN` | Optional | Default 15m | |
| `JWT_REFRESH_EXPIRES_IN` | Optional | Default 30d | |
| `GRACE_DAYS` | Optional | Default 5 | วัน grace หลังหมดรอบ |
| `MAIL_FROM` | Optional | ❌ ไม่ได้ตั้ง | ชื่อ/email ผู้ส่ง |
| `SENTRY_DSN` | ⚠️ Monitoring | ❌ ยังไม่ได้ตั้ง | Sentry DSN — ใส่แล้วเปิด error monitoring ทันที |
| `OMISE_WEBHOOK_SECRET` | ⚠️ Security | ❌ ยังไม่ได้ตั้ง | HMAC secret สำหรับตรวจ Omise webhook (optional แต่แนะนำ) |

---

## 7. Integrations

| Integration | สถานะ | หมายเหตุ |
|-------------|--------|----------|
| **Omise Payment** | ⚠️ Mock | ใส่ key แล้วจะใช้งานได้จริง — `/api/pay/charge`, `/api/pay/status`, `/api/pay/keys` |
| **Stripe** | ❌ Disabled | เดินสาย webhook แล้ว แต่ไม่มี key → ไม่ได้ใช้ |
| **RESEND Email** | ❌ Disabled | ไม่มี key → email ไม่ถูกส่ง (register/reset) |
| **SlipOK** | ❌ Disabled | ไม่มี key → ยืนยัน slip ไม่ได้ |
| **LINE Notify** | ❌ Deferred | ยังไม่ได้ implement |
| **Railway** | ✅ Active | Hosting + Postgres + auto-deploy from `railway up` |
| **GitHub** | ✅ Active | Source code: edenharvestdev/recipro-saas |

---

## 8. Known Risks

| Risk | ระดับ | หมายเหตุ |
|------|-------|----------|
| Payment mock ใน production | 🔴 HIGH | ลูกค้าชำระเงินผ่านระบบไม่ได้จนกว่าจะใส่ Omise key |
| ไม่มี staging environment | 🔴 HIGH | ทุก deploy ไปที่ production ทันที — ไม่มีที่ทดสอบแบบ safe |
| ไม่มี error monitoring | 🔴 HIGH | ไม่รู้ว่ามี error เกิดขึ้นใน production |
| ไม่มี email verification | 🟡 MEDIUM | ใครก็ register ได้โดยไม่ยืนยัน email |
| ไม่มี password reset | 🟡 MEDIUM | ถ้าลืมรหัสผ่านต้องให้ superadmin รีเซ็ต |
| Frontend ไฟล์เดียว 12k บรรทัด | 🟡 MEDIUM | แก้ไขยาก, เกิด regression ง่าย, ไม่มี unit test |
| ไม่มี CI/CD pipeline | 🟡 MEDIUM | ไม่มีการ test อัตโนมัติก่อน deploy |
| Integration test ต้องการ DB จริง | 🟡 MEDIUM | ทดสอบในเครื่อง dev ได้เฉพาะตอนมี DATABASE_URL |
| Security อยู่ที่ application layer | 🟡 MEDIUM | ไม่มี RLS ใน PostgreSQL — ถ้า bypass middleware จะเข้าถึง data ข้ามร้านได้ |
| SUPERADMIN_PASSWORD ใน env var | 🟡 MEDIUM | ถ้า env var หลุดจะเข้าระบบ superadmin ได้ |
| clone.js มีการแก้ที่ยัง unstaged | 🟢 LOW | ไม่ได้ deploy แต่อาจทำให้สับสน |

---

## 9. Known Bugs (ที่รู้แล้ว)

| Bug | Priority | อธิบาย |
|-----|----------|---------|
| Integration test ไม่ผ่านใน local | P2 | ต้องการ DATABASE_URL — ไม่ใช่ bug ของ production |
| Payment ใช้ mock mode | P0 | ยังไม่ได้ใส่ Omise key จริง |

---

## 10. สิ่งที่ยังไม่ได้ต่อ / ยัง Mock อยู่

| Feature | สถานะ | ต้องการอะไร |
|---------|--------|------------|
| Omise payment (real) | Mock | `OMISE_SECRET_KEY` จาก Omise dashboard |
| Email (register confirm, reset) | Disabled | `RESEND_API_KEY` |
| Slip verification | Disabled | `SLIPOK_API_KEY`, `SLIPOK_BRANCH_ID` |
| LINE Notify | Not implemented | LINE Notify token + backend endpoint |
| Stripe | Disabled | `STRIPE_SECRET_KEY` + ไม่ชัดว่าจะใช้ทำอะไร |
| Password reset flow | Not implemented | ต้องการ RESEND email ก่อน |
| Email verification on register | Not implemented | ต้องการ RESEND email |
| SUNMI silent print | Ready (frontend) | Hardware SUNMI device |
| Bridge print | Ready (frontend) | Local bridge server ที่ร้าน |
| Error monitoring | Not implemented | Sentry หรือ similar |
| Staging environment | Not implemented | Railway project แยก |
