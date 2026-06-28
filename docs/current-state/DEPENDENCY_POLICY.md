# Recipro SaaS — Dependency Policy

**สร้าง:** 2026-06-28
**เหตุผล:** บทเรียนจาก Incident RC-001 — production DOWN เนื่องจากเพิ่ม npm package ผิด package.json

---

## RC-001 Post-Mortem Summary

**Incident:** 2026-06-28 — Production DOWN ~2 ชั่วโมง
**Error:** `Error: Cannot find module '@sentry/node'`

**ต้นเหตุ:**
Sprint 001 เพิ่ม `@sentry/node` และ `express-rate-limit` เข้า `backend/package.json` เท่านั้น แต่ Railway Nixpacks ติดตั้ง dependencies จาก ROOT `package.json` ที่ `/` (repo root) ไม่ใช่จาก `backend/package.json`

**Timeline:**
- 18:xx น. — Deploy Sprint 001 (commit `36f3a77`)
- 18:xx น. — Production DOWN: `MODULE_NOT_FOUND @sentry/node`
- ~20:xx น. — Root cause confirmed: wrong package.json
- ~20:xx น. — Fix deployed (commit `9609458`) — production restored

---

## โครงสร้าง Package ของ Recipro

```
recipro-saas/                    ← Repo root = Railway deploy root
├── package.json                 ← ⭐ RAILWAY INSTALLS FROM HERE
├── package-lock.json            ← ⭐ RAILWAY LOCK FILE (must stay in sync)
├── node_modules/                ← /app/node_modules/ ใน production container
├── railway.json                 ← startCommand: node backend/src/...
└── backend/
    ├── package.json             ← ใช้สำหรับ local dev เท่านั้น
    └── src/
        └── app.js               ← require() ค้นหา modules จาก /app/node_modules/
```

### ทำไม backend/package.json มีอยู่?

`backend/package.json` ถูกสร้างสำหรับ local development (`cd backend && npm install && npm start`) แต่ Railway ไม่เคยอ่านไฟล์นี้ เพราะ Nixpacks ตรวจจาก root ก่อนเสมอ

---

## กฎการจัดการ Dependency

### กฎ #1 — dependency ทุกตัวต้องอยู่ใน ROOT `/package.json`

```bash
# ✅ ถูกต้อง — เพิ่มจาก repo root
cd recipro-saas/
npm install <package-name>

# ❌ ผิด — เพิ่มจาก backend subdirectory
cd recipro-saas/backend/
npm install <package-name>
```

### กฎ #2 — ROOT package-lock.json ต้อง commit ทุกครั้งที่เปลี่ยน dependency

```bash
git add package.json package-lock.json
git commit -m "add <package-name> dependency"
```

### กฎ #3 — backend/package.json ต้อง sync กับ ROOT package.json เสมอ

เมื่อเพิ่ม dependency ใหม่ใน ROOT ต้องเพิ่มใน `backend/package.json` ด้วย เพื่อให้ local dev ยังทำงานได้

```bash
# หลังจาก npm install <package> จาก root:
# 1. แก้ root/package.json (auto โดย npm)
# 2. แก้ backend/package.json ด้วยมือ (เพิ่ม entry เดียวกัน)
# 3. commit ทั้งสองไฟล์
```

### กฎ #4 — ห้ามเพิ่ม dependency โดยไม่มี Founder approval ระหว่าง Freeze

ดู [FEATURE_FREEZE_RULE.md](FEATURE_FREEZE_RULE.md)

---

## Node.js Module Resolution — ทำไมปัญหาเกิด

เมื่อ `node backend/src/app.js` รัน Railway จาก `/app/` (root), Node.js ค้นหา modules ตาม path จาก file location:

```
require('@sentry/node') จาก /app/backend/src/app.js:
  1. /app/backend/src/node_modules/   → ไม่มี
  2. /app/backend/node_modules/       → ไม่มี (Nixpacks ไม่เคย install ที่นี่)
  3. /app/node_modules/               → ค้นหา @sentry ที่นี่
     └── ถ้า ROOT package.json ไม่มี → MODULE_NOT_FOUND ❌
     └── ถ้า ROOT package.json มี    → found ✅
  4. /node_modules/                   → (ไม่เคยถึงที่นี่)
```

---

## Pre-Deploy Dependency Checklist

ก่อน deploy ทุกครั้งที่มีการเปลี่ยน dependency:

```
[ ] 1. package ใหม่อยู่ใน ROOT /package.json  (ไม่ใช่แค่ backend/package.json)
[ ] 2. ROOT /package-lock.json อัปเดตแล้ว  (npm install รันจาก root)
[ ] 3. backend/package.json sync กับ ROOT แล้ว
[ ] 4. `npm install` รันสำเร็จจาก root โดยไม่มี error
[ ] 5. `node backend/src/index.js` start ได้ใน local โดยไม่มี MODULE_NOT_FOUND
[ ] 6. git diff ยืนยันว่า package.json + package-lock.json เปลี่ยนทั้งคู่
[ ] 7. Founder review และ approve
```

---

## Build Validation Checklist

ก่อน push / railway up ทุกครั้ง:

```
[ ] 1. git status — ไม่มีไฟล์ที่ไม่ได้ตั้งใจ stage
[ ] 2. git diff --stat — ยืนยัน scope ของการเปลี่ยนแปลง
[ ] 3. railway logs (หลัง deploy) — ตรวจ "Starting Container" สำเร็จ
[ ] 4. GET /health → {"ok":true}
[ ] 5. Railway status → ● Online (ไม่ใช่ ● Crashed)
[ ] 6. ดู logs ≥ 15 นาทีหลัง deploy
```

---

## Monorepo / Package Structure Policy

Recipro ใช้ **pseudo-monorepo** (ไม่ได้ใช้ npm workspaces หรือ Turborepo):

| | ROOT `package.json` | `backend/package.json` |
|--|--|--|
| Railway ใช้ | ✅ ใช่ | ❌ ไม่ใช่ |
| Local dev `cd backend && npm start` | ✅ ใช้ด้วย (via node_modules resolution) | ✅ ใช่ |
| ต้องมี package ทุกตัว | ✅ บังคับ | ⚠️ ควร sync |
| Lock file ที่ Railway ใช้ | ROOT `/package-lock.json` | ไม่ใช้ |

**ห้าม** migrate ไปใช้ npm workspaces หรือเปลี่ยน package structure ระหว่าง Maintenance Freeze

---

## Current Dependency List (post RC-001 fix)

ROOT `/package.json` dependencies ที่ถูกต้อง:

```json
{
  "@sentry/node": "^10.62.0",
  "bcryptjs": "^2.4.3",
  "dotenv": "^16.4.7",
  "express": "^4.21.2",
  "express-rate-limit": "^8.5.2",
  "jsonwebtoken": "^9.0.2",
  "pg": "^8.13.1",
  "stripe": "^17.5.0"
}
```

`backend/package.json` dependencies (mirror ของ ROOT):

```json
{
  "@sentry/node": "^10.62.0",
  "bcryptjs": "^2.4.3",
  "dotenv": "^16.4.7",
  "express": "^4.21.2",
  "express-rate-limit": "^8.5.2",
  "jsonwebtoken": "^9.0.2",
  "pg": "^8.13.1",
  "stripe": "^17.5.0"
}
```

ทั้งสองไฟล์ **sync กันแล้ว** หลังการ fix RC-001

---

## Packages ที่ Deploy แต่ Disabled (รอ key)

| Package | สถานะ | เปิดใช้ด้วย |
|---------|--------|------------|
| `@sentry/node` | Installed, disabled | ตั้ง `SENTRY_DSN` ใน Railway |
| `stripe` | Installed, disabled | — (ยังไม่มี plan ใช้ Stripe) |

---

*ดู [OPEN_ISSUES.md](OPEN_ISSUES.md) สำหรับ TD-01 — ROOT + backend package.json sync policy*
