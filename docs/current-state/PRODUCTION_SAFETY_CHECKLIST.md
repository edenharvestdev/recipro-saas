# Recipro SaaS — Production Safety Checklist

**สร้าง:** 2026-06-28  
**ตรวจโดย:** Code analysis (static — ไม่ใช่ live pen-test)

---

## Auth & Access

| | รายการ | หมายเหตุ |
|-|--------|----------|
| ✅ | JWT access token ตรวจทุก protected request | `requireAuth` middleware — `app.js:36` |
| ✅ | Access token อายุสั้น (15 นาที default) | `JWT_EXPIRES_IN` env var |
| ✅ | Refresh token แยก secret จาก access token | `JWT_REFRESH_SECRET` คนละ key |
| ✅ | Password hash ด้วย bcrypt rounds 12 | bcryptjs |
| ✅ | Invalid/expired token → 401 | `verifyAccess()` ใน tokens.js |
| ✅ | `/api/admin/*` ต้องผ่าน `requireSuperadmin` | `app.js:62` |
| ✅ | Staff permissions ตรวจผ่าน `requirePerm()` | `tenant.js` |
| ❌ | ไม่มี email verification หลัง register | ใคร register ได้ทันที |
| ❌ | ไม่มี password reset flow | ต้องให้ superadmin แก้ใน DB |
| ❌ | ไม่มี rate limiting (brute force login) | login ไม่จำกัดความพยายาม |
| ❌ | ไม่มี 2FA | |

---

## Tenant Isolation — ร้าน A ไม่เห็นข้อมูลร้าน B

| | รายการ | หมายเหตุ |
|-|--------|----------|
| ✅ | ทุก API query บังคับใช้ `req.shopId` | `tenant` middleware กำหนดจาก memberships |
| ✅ | ร้าน A ใส่ `X-Shop-Id` ของร้าน B ไม่ได้ | tenant.js ตรวจ membership ก่อนยอม switch |
| ✅ | Superadmin เท่านั้น switch shop ข้ามได้ | `if (req.isSuperadmin && requested)` |
| ✅ | DELETE scoped ด้วย `where id=$1 AND shop_id=$2` | `resources.js:19` |
| ✅ | Stock operations scoped shop_id | `stock.js` ระบุชัดทุก query |
| ✅ | Omise secret key ไม่ส่งกลับ frontend | `delete s.omise_secret_key` ใน bootstrap.js |
| ✅ | Tested ใน integration test | `check('owner A cannot spoof X-Shop-Id to shop B')` → pass |
| ⚠️ | Security อยู่ที่ application layer เท่านั้น | ไม่มี PostgreSQL RLS — ถ้า bypass Express middleware จะเข้า data ข้ามร้านได้ |

---

## POS / Order / Stock

| | รายการ | หมายเหตุ |
|-|--------|----------|
| ✅ | POS สร้าง order ได้ | POST `/api/sync` บันทึก bills |
| ✅ | Stock ถูกตัดเมื่อขาย | `/api/pos/sell` + `/api/stock/produce` |
| ✅ | Produce เป็น atomic transaction | `tx()` wrapper ใน sync.js |
| ✅ | FK null-guard ใน recipe_items | ถ้า material ถูกลบ → insert null แทน (ไม่ rollback ทั้ง sync) |
| ✅ | Optimistic locking (version conflict) | `_base_version` check กัน multi-tab เขียนทับ |
| ⚠️ | Staff discount ceiling enforce frontend เท่านั้น | server ไม่ตรวจ — staff แก้ request ตรงได้ |
| ⚠️ | Payment Omise อยู่ใน mock mode | ไม่มี `OMISE_SECRET_KEY` |

---

## Subscription / Billing

| | รายการ | หมายเหตุ |
|-|--------|----------|
| ✅ | Billing state คำนวณ server-side | `billing-state.js` |
| ✅ | Trial → grace 5 วัน → readonly | `computeBillingState()` |
| ✅ | Readonly บล็อก write API | `isWriteBlocked()` ใน app.js middleware |
| ✅ | ร้านเก่าไม่มี `trial_ends_at` → ไม่ถูก lock | explicit check ใน billing-state.js |
| ⚠️ | Checkout/renewal ไม่ทำงาน (mock) | superadmin ต้อง extend manual ผ่าน admin panel |

---

## Superadmin

| | รายการ | หมายเหตุ |
|-|--------|----------|
| ✅ | `/api/admin/*` ปิดด้วย `requireSuperadmin` | middleware ใน app.js:62 |
| ✅ | Owner ได้รับ 403 จาก admin endpoint | ทดสอบใน integration test |
| ✅ | Superadmin role เก็บใน DB memberships | ไม่ได้ embed ใน JWT |
| ⚠️ | `SUPERADMIN_PASSWORD` ใน environment variable | ถ้า Railway env หลุด account อาจถูก brute force |

---

## Environment Separation

| | รายการ | หมายเหตุ |
|-|--------|----------|
| ❌ | ไม่มี staging environment | deploy ทุกครั้งกระทบ production ทันที |
| ✅ | Railway isolate env vars ต่อ service | production key ไม่ปนกับ local |
| ⚠️ | Integration test รันกับ DB จริงถ้าใส่ production `DATABASE_URL` | ต้องระวัง — ใช้ DB แยกเสมอ |

---

## Backup & Rollback

| | รายการ | หมายเหตุ |
|-|--------|----------|
| ✅ | Railway built-in Postgres backup | Point-in-time recovery |
| ✅ | In-app snapshots per shop | `/api/snapshots` + auto-snapshot หลัง sync |
| ❌ | ไม่มี down-migration | rollback schema ต้องเขียน SQL เอง |
| ⚠️ | Code rollback = `git revert` + `railway up` | manual — ไม่มี automated rollback |

---

## Error Monitoring

| | รายการ | หมายเหตุ |
|-|--------|----------|
| ✅ | Event logs บันทึก actions | `logEvent()` ใน sync, auth, admin |
| ✅ | `/api/logs` superadmin ดูได้ | |
| ❌ | ไม่มี Sentry / error alerting | ไม่รู้เมื่อมี 500 error ใน production |
| ❌ | ไม่มี uptime monitoring | ไม่รู้เมื่อ server down |

---

## สรุปความเสี่ยงที่ต้องแก้ก่อน

| ระดับ | รายการ |
|-------|--------|
| 🔴 P0 | Omise payment mock — ลูกค้าชำระเงินไม่ได้จริง |
| 🔴 P0 | ไม่มี error monitoring — ไม่รู้เมื่อระบบมีปัญหา |
| 🟠 P1 | Staff discount ceiling ไม่ enforce server-side |
| 🟠 P1 | ไม่มี rate limiting (brute force) |
| 🟠 P1 | ไม่มี password reset |
