# Recipro — ระบบคิดต้นทุนจากสูตร สำหรับร้านเล็ก (SaaS)

ระบบหลายร้าน + ล็อกอิน + สมาชิกรายเดือน/ปี + ตัดบัตรอัตโนมัติ + แอดมินหลักคุมทุกร้าน
(ร้าน Merry Jane เป็นร้านแรกในระบบ)

> **สแตก:** Railway + Node/Express + PostgreSQL + JWT + Omise (ไม่ใช้ Supabase แล้ว)
> กำลังย้ายจาก Supabase → ดูแผนใน `docs/migration-plan.md`

## โครงสร้างโปรเจกต์ (เป้าหมาย)
```
recipro-saas/
├─ frontend/              เว็บแอป / PWA (เสิร์ฟเป็น static โดย Node API)
│  ├─ index.html          หน้า login + แอปหลัก (คิดต้นทุน/สต๊อก/บิล/แอดมิน/สมาชิก)
│  ├─ app-config.js       ★ ใส่ API_BASE_URL + OMISE_PUBLIC_KEY ที่นี่
│  ├─ pos/                โมดูล POS หน้าร้าน (เฟส K)
│  └─ labels/             โมดูลฉลาก/แพ็กเกจ/จัดส่ง รองรับ Niimbot (เฟส L)
├─ backend/               ★ Node/Express API (เฟสย้ายระบบ)
│  ├─ src/                เซิร์ฟเวอร์ (auth · api · webhooks · cron)
│  └─ db/
│     ├─ schema.sql       ตารางหลัก (plain PostgreSQL)
│     ├─ schema-extend.sql ตารางเฟส J–L (บิลมาตรฐาน · POS · ฉลาก/จัดส่ง)
│     └─ seed.sql         แพ็กเกจเริ่มต้น
├─ backend/supabase/      (เดิม) อ้างอิงระหว่างย้ายระบบ — จะลบหลังย้ายเสร็จ
├─ assets/                โลโก้ Recipro (icon + lockup)
├─ docs/architecture.md   ★ อธิบายว่าอะไรเชื่อมตรงไหน
├─ docs/next-phases.md    สเปก + prompt เฟส J (บิลมาตรฐาน), K (POS), L (ฉลาก/Niimbot)
├─ docs/migration-plan.md ★ แผนย้าย Supabase → Railway/Node/Postgres/JWT/Omise
├─ prompts.md             ชุด prompt สำหรับ Claude Code ทีละเฟส
└─ .env.example           รายการตัวแปรสภาพแวดล้อมทั้งหมด
```

## รันบนเครื่องตัวเอง (local dev)
```bash
cd recipro-saas/backend
cp .env  # มีตัวอย่างให้แล้ว — แก้ DATABASE_URL ให้ชี้ Postgres ของคุณ
npm install
npm run migrate     # สร้างตาราง + seed (รันซ้ำได้)
npm start           # เสิร์ฟ API + frontend ที่ http://localhost:3000
npm run test:int    # (ออปชัน) รันชุดทดสอบ end-to-end ของ API
```
ตั้ง superadmin คนแรก: สมัครผู้ใช้ผ่านหน้าเว็บ/`/auth/register` แล้วผูก membership เป็น `superadmin`
(ดูคอมเมนต์ท้าย `backend/db/schema.sql`)

## ขึ้น Railway (production)
repo: `github.com/edenharvestdev/recipro-saas`
1. Railway → New Project → **Deploy from GitHub repo** → เลือก `recipro-saas`
2. ตั้ง **Root Directory = `backend`** (มี `railway.json` กำหนด build/start ให้แล้ว — รัน migrate อัตโนมัติตอน deploy)
3. เพิ่ม **PostgreSQL plugin** → ผูกตัวแปร `DATABASE_URL` ของ Postgres เข้ากับ service `backend`
4. ตั้ง Variables ตาม `.env.example` (`JWT_SECRET`, `JWT_REFRESH_SECRET`, `OMISE_SECRET_KEY`, `APP_URL`, `GRACE_DAYS`, `RESEND_API_KEY` ฯลฯ)
5. deploy → ตาราง+seed จะถูกสร้างอัตโนมัติ (`node src/migrate.js`); ตั้ง superadmin คนแรกตามคอมเมนต์ท้าย `backend/db/schema.sql`
6. ตั้ง Omise webhook → `https://<โดเมน>/webhooks/omise`
7. ตั้ง Railway **Cron** ให้รัน `node src/cron.js` วันละครั้ง (พักร้านค้างชำระ + เตือนก่อนตัดบัตร)
8. ใส่ค่าใน `frontend/app-config.js`: `API_BASE_URL: ""` (โดเมนเดียวกัน) + `OMISE_PUBLIC_KEY`

> โหมดจำลอง (offline/mock): ตั้ง `API_BASE_URL: "MOCK"` ใน `app-config.js` แล้วเปิด `frontend/index.html`
> ได้เลยโดยไม่ต้องมีหลังบ้าน (เก็บข้อมูลใน localStorage) — เหมาะกับเดโม/พัฒนา UI

## รายละเอียดเชิงลึก
- ภาพการเชื่อมต่อ + ใส่คีย์ที่ไหน: `docs/architecture.md`
- แผนย้ายระบบทีละขั้น: `docs/migration-plan.md`
- เฟสเสริม J–L: `docs/next-phases.md`
- ราคา + การตลาด + โมเดลเก็บเงิน/ที่เก็บข้อมูล: `docs/marketing-pricing.md`
- เหตุผล/ทางเลือกเทคโนโลยีช่วงแรก (ประวัติ): `bakery-saas-project-brief.md`
