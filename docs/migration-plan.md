# แผนย้ายระบบ Recipro: Supabase → Railway + Node/Express + PostgreSQL + JWT + Omise

> ✅ **สถานะ: ย้ายระบบหลักเสร็จแล้ว (2026-06-16)** — Step 1–8 ทำเสร็จและทดสอบในเบราว์เซอร์แล้ว
> หลังบ้านอยู่ที่ `backend/` (Express+pg+JWT), frontend ต่อ API ผ่าน `frontend/api.js`,
> ทดสอบ `npm run test:int` ผ่าน 19/19. เหลือ: ใส่คีย์ Omise จริง + deploy Railway + เฟส J/K/L
>
> เอกสารนี้คือ "พิมพ์เขียว" ของการย้ายระบบ ทำตามทีละ Step
> สถานะปัจจุบัน: frontend (`frontend/index.html`) ทำงานได้ในโหมดจำลอง (mock/localStorage)
> และมีโค้ดเดิมที่ผูก Supabase อยู่ — โค้ด Supabase เก่าอยู่ใต้ `backend/supabase/` ใช้เป็นอ้างอิง

---

## 0. ภาพรวม — อะไรเปลี่ยนเป็นอะไร

| เดิม (Supabase) | ใหม่ (Railway/Node) |
|---|---|
| Supabase Auth | ทำเอง: ตาราง `users` + bcrypt + JWT (access/refresh) |
| `supabase-js` (`sb.from(...)`, `sb.auth`) | `fetch()` ไปยัง REST API ของเรา (มี `frontend/api.js` ห่อ) |
| RLS (แยกข้อมูลในฐานข้อมูล) | แยกที่ชั้น API: ทุก query กรอง `shop_id` จาก JWT membership |
| Edge Functions (Deno/TS) | route ใน Node/Express (`backend/src/`) |
| `create-checkout-session` (Stripe) | `POST /api/billing/checkout` (Omise) |
| `stripe-webhook` | `POST /webhooks/omise` |
| `admin-tasks` (สร้างร้าน/ผู้ใช้) | `POST /api/admin/shops` |
| โฮสต์ frontend: Vercel/Netlify | โฮสต์รวม: Node เสิร์ฟ static + API บน Railway |
| Stripe | Omise/Opn (PromptPay + บัตร) |

หลักการที่ห้ามพลาด: **โหมดจำลอง (mock) ต้องใช้ได้เหมือนเดิม** — ถ้า `app-config.js` ยังเป็น placeholder ให้ระบบ fallback ไป localStorage (มีอยู่แล้ว) เพื่อพัฒนา/เดโมได้โดยไม่ต้องมีหลังบ้าน

---

## 1. ฐานข้อมูล (Railway PostgreSQL)
1. Railway → New Project → Add **PostgreSQL** (ได้ `DATABASE_URL` อัตโนมัติ)
2. รัน `backend/db/schema.sql` → `backend/db/schema-extend.sql` → `backend/db/seed.sql`
3. (ภายหลัง) ตั้ง superadmin คนแรกตามคอมเมนต์ท้าย `schema.sql`

## 2. โครงเซิร์ฟเวอร์ Node/Express (`backend/src/`)
```
backend/
├─ package.json            (express, pg, bcrypt, jsonwebtoken, omise, nodemailer/resend, node-cron)
├─ src/
│  ├─ index.js             สร้าง app, เสิร์ฟ static (../frontend), mount routes, listen(PORT)
│  ├─ db.js                pg Pool จาก DATABASE_URL + helper query()
│  ├─ auth/
│  │  ├─ routes.js         /auth/register|login|refresh|logout|me
│  │  └─ middleware.js     requireAuth (ถอด JWT) + requireRole('superadmin')
│  ├─ tenant.js            middleware แนบ req.shopId + req.role จาก memberships
│  ├─ api/
│  │  ├─ bootstrap.js      GET /api/bootstrap (โหลดข้อมูลร้านทั้งก้อน)
│  │  ├─ sync.js           POST /api/sync (อัปเซิร์ตทั้งก้อนในทรานแซกชัน)
│  │  ├─ admin.js          /api/admin/shops · /api/admin/dashboard
│  │  └─ billing.js        /api/billing/checkout · /api/plans
│  ├─ webhooks/omise.js    POST /webhooks/omise
│  └─ cron.js              พักร้านค้างชำระ + เตือนก่อนตัดบัตร + ส่งใบเสร็จ
```

## 3. ระบบล็อกอินเอง (JWT) — แทน Supabase Auth
- `POST /auth/register {email,password}` → hash ด้วย bcrypt (`BCRYPT_ROUNDS`) → insert `users` → ออก access+refresh JWT
- `POST /auth/login` → ตรวจรหัส → ออก JWT
- `POST /auth/refresh {refreshToken}` → ออก access ใหม่
- `GET /auth/me` → คืน `user` + `memberships:[{shop_id, role}]`
- `requireAuth`: อ่าน `Authorization: Bearer` → verify → `req.userId`
- เก็บ token ฝั่ง frontend ใน `localStorage` (`recipro_access`, `recipro_refresh`)

## 4. การแยกข้อมูลแต่ละร้าน (แทน RLS)
- middleware `tenant`: จาก `req.userId` → query `memberships` → ตั้ง `req.shopId` (ร้านปัจจุบัน) + `req.role`
- ทุก query ใน `/api/*` ต้องมี `where shop_id = $req.shopId`
- ถ้า `role='superadmin'` → อนุญาตข้ามการกรอง (สำหรับ endpoint แอดมิน)

## 5. REST API ที่ต้องมี (แทน `sb.from(...)`)
| Method · Path | แทนของเดิม | หมายเหตุ |
|---|---|---|
| `GET /api/bootstrap` | boot(): Promise.all โหลดทุกตาราง | คืน `{shop, settings, suppliers, materials, recipes(+items), bills, subscription}` |
| `POST /api/sync` | syncToSupabase(): upsert ทุกตาราง | รับทั้งก้อน ทำในทรานแซกชันเดียว กรอง shop_id |
| `GET /api/plans` | loadPlans() | คืนแพ็กเกจ active |
| `GET /api/admin/shops` | adminLoadShops() | superadmin |
| `POST /api/admin/shops` | adminCreateShop() (admin-tasks) | สร้าง shop + user(owner) + membership + shop_settings ในทรานแซกชัน |
| `PATCH /api/admin/shops/:id` | adminUpdateShopStatus() | superadmin |
| `GET /api/admin/dashboard` | adminLoadDashboard() | คืนสรุปร้าน/รายได้/ใกล้หมดอายุ (คิดฝั่ง server) |
| `POST /api/billing/checkout` | checkoutPlan() (create-checkout-session) | สร้าง Omise customer+charge → คืน URL/authorize |
| `POST /webhooks/omise` | stripe-webhook | ตรวจ event โดยดึงกลับจาก Omise API |

## 6. แก้ฝั่ง frontend (`frontend/index.html`)
ทำ adapter ใหม่ `frontend/api.js`: `api.get/post/put/del(path, body)` แนบ Bearer + auto-refresh เมื่อ 401
จุดที่ต้องแก้ (อ้างอิงฟังก์ชันปัจจุบัน):
- ตัวตรวจโหมด: เดิมเช็ค `SUPABASE_URL` → เปลี่ยนเป็นเช็ค `cfg.API_BASE_URL` (placeholder = mock)
- ลบ `supabase.createClient` + `<script src="@supabase/supabase-js">`
- `handleSignIn/handleSignOut` → เรียก `/auth/login` `/auth/logout` (เก็บ/ลบ token)
- `boot()` สาขา cloud → `await api.get('/api/bootstrap')` แล้ว map ลงตัวแปรในหน่วยความจำ (โครงข้อมูลในแอปคงเดิม)
- `syncToSupabase()` สาขา cloud → `await api.post('/api/sync', {...})`
- `loadPlans / adminLoadShops / adminUpdateShopStatus / adminCreateShop / adminLoadDashboard / checkoutPlan` → ชี้ไป endpoint ใหม่
- **คงสาขา mock (localStorage) ไว้ทั้งหมด** — แตะเฉพาะสาขา cloud

## 7. Billing ด้วย Omise (แทน Stripe)
- `POST /api/billing/checkout`: สร้าง/หา Omise customer ของร้าน → สร้าง charge ครั้งแรก (หรือ schedule รายเดือน/ปี) → บันทึก `subscriptions.provider_customer_id`
- `POST /webhooks/omise`: เมื่อได้ event → **ดึง charge/event กลับจาก Omise API ด้วย `OMISE_SECRET_KEY` เพื่อยืนยัน** → แล้วอัปเดต:
  - charge สำเร็จ → `subscriptions.status='active'`, `shops.status='active'`, insert `payments`
  - charge ล้มเหลว → `subscriptions.status='past_due'`
  - ยกเลิก → `subscriptions.status='canceled'`, `shops.status='suspended'`

## 8. งาน cron (`backend/src/cron.js`) — เฟส C #4 + D #2
- **พักร้านค้างชำระ:** subscription `past_due` ที่ `current_period_end + GRACE_DAYS < now()` → `shops.status='suspended'`
- **เตือนก่อนตัดบัตร:** `current_period_end` เหลือ ≤ 3 วัน → ส่งอีเมลเตือน
- **ใบเสร็จ:** เมื่อ webhook บันทึก payment สำเร็จ → ส่งอีเมลใบเสร็จ
- รันด้วย Railway Cron (แนะนำ) หรือ `node-cron` ในเซิร์ฟเวอร์

## 9. Deploy ขึ้น Railway
1. เชื่อม repo → Railway ตรวจ `package.json` แล้ว build/run (`npm start` → `node backend/src/index.js`)
2. ตั้ง Variables ตาม `.env.example`
3. ตั้งโดเมน → ใส่ค่าเดียวกันใน `frontend/app-config.js` (`API_BASE_URL`)
4. ตั้ง Omise webhook ให้ชี้มาที่ `https://<โดเมน>/webhooks/omise`

## 10. ทดสอบ E2E + เก็บกวาด
- ทดสอบทุกบทบาท: **superadmin** (สร้าง/พักร้าน, ดูแดชบอร์ด) · **owner** (ใช้แอป + ซื้อแพ็กเกจ) · **staff** (ใช้แอปแต่จัดการบิล/สมาชิกตามสิทธิ์)
- ทดสอบ webhook ด้วย Omise test keys → เช็คสถานะร้านเปลี่ยนถูกต้อง
- เมื่อผ่านหมด → ลบโฟลเดอร์ `backend/supabase/` และลบ `<script supabase-js>` ออกจาก frontend

---

## ลำดับแนะนำ (commit ทีละก้อน)
1. DB + schema (Step 1) → 2. Express + db.js + เสิร์ฟ static (Step 2) → 3. Auth/JWT (Step 3–4)
→ 4. /api/bootstrap + /api/sync + repoint frontend (Step 5–6) → 5. Admin endpoints
→ 6. Omise checkout + webhook (Step 7) → 7. cron + email (Step 8) → 8. deploy + E2E (Step 9–10)

> เริ่มลงมือจริงเมื่อพร้อม — สั่ง "เริ่มเฟสย้ายระบบ Step 1" ได้เลย
