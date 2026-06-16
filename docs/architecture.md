# สถาปัตยกรรม Recipro — อะไรเชื่อมตรงไหน

> **สแตกปัจจุบัน:** Railway + Node/Express + PostgreSQL + JWT + Omise
> เลิกใช้ Supabase แล้ว (ของเดิมอยู่ใต้ `backend/supabase/` ใช้เป็นอ้างอิงระหว่างย้ายระบบ — ดู `docs/migration-plan.md`)

## แผนผังการเชื่อมต่อ

```
        ┌──────────────────────────────────────────────┐
        │  FRONTEND (เว็บแอป / PWA)                       │
        │  frontend/index.html + app-config.js          │
        │  เสิร์ฟเป็นไฟล์ static โดย Node API เดียวกัน      │
        └───────────────┬───────────────┬──────────────┘
                        │               │
        (1) ล็อกอิน+ข้อมูล │               │ (2) จ่ายเงินครั้งแรก
        REST + JWT       │               │ Omise (redirect/ฟอร์มบัตร)
                        ▼               ▼
        ┌──────────────────────────┐   ┌────────────────────────┐
        │  RAILWAY                  │   │  OMISE / Opn             │
        │  ┌────────────────────┐  │   │  • หน้าจ่ายเงิน (เก็บบัตร)  │
        │  │ Node/Express API   │  │   │  • ตัดบัตรอัตโนมัติทุกรอบ   │
        │  │ • Auth (JWT)       │  │   └───────────┬────────────┘
        │  │ • REST /api/*      │  │               │
        │  │ • แยกร้านที่ชั้นแอป  │◄─┼────(3) webhook─┘
        │  │ • cron ตัด/เตือน    │  │    แจ้งผลจ่ายเงิน
        │  └─────────┬──────────┘  │
        │            ▼             │
        │  ┌────────────────────┐  │
        │  │ PostgreSQL (Railway)│  │
        │  └────────────────────┘  │
        └──────────────────────────┘
```

## จุดเชื่อมแต่ละเส้น (ใส่คีย์ที่ไหน)

| เส้น | เชื่อมอะไร | ใส่คีย์ที่ไหน |
|---|---|---|
| (1) | เบราว์เซอร์ ↔ Node API (ล็อกอิน + อ่าน/เขียนข้อมูล ผ่าน REST + Bearer JWT) | frontend: `frontend/app-config.js` → `API_BASE_URL` · server: `JWT_SECRET`, `DATABASE_URL` |
| (2) | เบราว์เซอร์ → หน้าจ่ายเงิน Omise (บัตรไม่ผ่านโค้ดเรา) | frontend: `app-config.js` → `OMISE_PUBLIC_KEY` |
| (3) | Omise → Node API endpoint `/webhooks/omise` (อัปเดตสถานะสมาชิก/ร้าน) | server (Railway Variables): `OMISE_SECRET_KEY`, `DATABASE_URL` |

> Railway ใส่ `PORT` และ (ถ้าเพิ่ม PostgreSQL plugin) `DATABASE_URL` ให้อัตโนมัติ — ที่เหลือตั้งเองใน Railway > Variables

## หลักความปลอดภัย
- **JWT** ใช้ยืนยันตัวตนทุก request ของ `/api/*`; เซิร์ฟเวอร์ถอด token → รู้ `user_id` → เช็ค membership เพื่อรู้ `shop_id` + `role`
- **การแยกข้อมูลแต่ละร้านอยู่ที่ชั้นแอป (API)** ไม่ใช่ที่ frontend — ทุก query กรองด้วย `shop_id` ที่มาจาก JWT เสมอ (superadmin เท่านั้นที่ข้ามได้)
- **รหัสผ่าน** เก็บเป็น hash (bcrypt/argon2) เท่านั้น — ห้ามเก็บ plaintext
- **`JWT_SECRET` / `OMISE_SECRET_KEY` / `DATABASE_URL`** อยู่ฝั่งเซิร์ฟเวอร์ (Railway Variables) เท่านั้น — ห้ามใส่ใน frontend
- **เลขบัตรเครดิต** อยู่กับ Omise เท่านั้น เราเก็บแค่ token/รหัสอ้างอิง (customer id / charge id)
- **webhook** ยืนยันความถูกต้องด้วยการ "ดึงข้อมูล event/charge กลับจาก Omise API" ด้วย `OMISE_SECRET_KEY` ก่อนเชื่อ payload เสมอ
