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

## ขึ้น Railway (production) — repo: `github.com/edenharvestdev/recipro-saas`
deploy ทั้ง repo (root มี `package.json` + `railway.json` ให้แล้ว — **ไม่ต้องตั้ง Root Directory**)
1. Railway → New Project → **Deploy from GitHub repo** → เลือก `recipro-saas`
2. กด **+ New → Database → PostgreSQL** → ที่ service ของแอป: Variables → Add **Reference** → `DATABASE_URL` (จาก Postgres)
3. ตั้ง Variables (ดู `.env.example`):
   - `JWT_SECRET`, `JWT_REFRESH_SECRET` — สุ่มยาว ๆ อย่างละชุด
   - `APP_URL` — โดเมนที่ Railway ออกให้
   - `SUPERADMIN_EMAIL`, `SUPERADMIN_PASSWORD` (≥8 ตัว) — สร้างแอดมินหลักอัตโนมัติตอน deploy แรก
   - (ออปชัน) `OMISE_SECRET_KEY`, `GRACE_DAYS=3`, `RESEND_API_KEY`
4. **Deploy** — ตอนสตาร์ทจะทำให้อัตโนมัติ: `migrate` (สร้างตาราง+แพ็กเกจ) → `bootstrap` (ถ้า DB ว่าง: seed ข้อมูล Merry Jane + สร้าง superadmin) → เปิดเซิร์ฟเวอร์
   เปิดโดเมน Railway แล้วล็อกอินได้ทันที:
   - superadmin: `SUPERADMIN_EMAIL` / `SUPERADMIN_PASSWORD`
   - เจ้าของร้าน Merry Jane: `merryjane@recipro.local` / `merryjane2026` (เปลี่ยนรหัสภายหลัง)
5. (ออปชัน) Omise: ตั้ง webhook → `https://<โดเมน>/webhooks/omise` และใส่ `OMISE_PUBLIC_KEY` ใน `frontend/app-config.js`
6. (ออปชัน) Railway **Cron** → รัน `npm run cron` วันละครั้ง (พักร้านค้างชำระ + เตือนก่อนตัดบัตร)

> `frontend/app-config.js` ตั้ง `API_BASE_URL: ""` ไว้แล้ว (Node เสิร์ฟ frontend โดเมนเดียวกัน) — ไม่ต้องแก้

> โหมดจำลอง (offline/mock): ตั้ง `API_BASE_URL: "MOCK"` ใน `app-config.js` แล้วเปิด `frontend/index.html`
> ได้เลยโดยไม่ต้องมีหลังบ้าน (เก็บข้อมูลใน localStorage) — เหมาะกับเดโม/พัฒนา UI

## รายละเอียดเชิงลึก
- ภาพการเชื่อมต่อ + ใส่คีย์ที่ไหน: `docs/architecture.md`
- แผนย้ายระบบทีละขั้น: `docs/migration-plan.md`
- เฟสเสริม J–L: `docs/next-phases.md`
- ราคา + การตลาด + โมเดลเก็บเงิน/ที่เก็บข้อมูล: `docs/marketing-pricing.md`
- เหตุผล/ทางเลือกเทคโนโลยีช่วงแรก (ประวัติ): `bakery-saas-project-brief.md`
