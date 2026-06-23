# Recipro — Handoff to Dev (Item Master / POS / Labels / Accounting)

> สำหรับเดฟที่มารับงานต่อ: pull งานทั้งหมด รีวิว เทสต์ local แล้ว **build เสร็จค่อย deploy ร่วมกับเจ้าของ**
> เอกสารแผนเต็ม: `docs/inventory-redesign.md`

## สถานะ (ณ ส่งมอบ)
| เฟส | งาน | สถานะ | อยู่ที่ |
|---|---|---|---|
| P0 | Item Master + 8 หมวด (schema additive) | ✅ **live บน prod** | `main` |
| P1 | จัดหมวดสินค้า (dropdown 8 หมวด, round-trip) | ✅ **live บน prod** | `main` |
| P2 | เมนู + ต้นทุนสด + bridge recipe_type | ✅ **live บน prod** | `main` |
| P3 | ตัดสต๊อกตามหมวด `POST /api/pos/sell` (backend) | 🧪 ทดสอบ local แล้ว · ยังไม่ deploy | `feat/p3-pos-deduction` |
| P4 | ปริ้นป้ายราคา `printPriceTags()` + ปุ่ม | 🧪 syntax ผ่าน · รอ polish layout + ทดสอบพิมพ์ | `feat/p4-label-print` |
| P5 | เตือนสั่งของ `GET /api/alerts/reorder` | 🧪 ทดสอบ local แล้ว · ยังไม่ deploy | `feat/p5-reorder-alerts` |

**ข้อจำกัดสำคัญ:** ห้ามแตะค่าสต๊อกของร้านที่ลงข้อมูลแล้ว — ทุกอย่างเป็น additive, การตัดสต๊อกตามหมวดมีผลกับการขายใหม่เท่านั้น

## ดึงงานทั้งหมดมา (pull)
```bash
git clone https://github.com/edenharvestdev/recipro-saas.git   # ถ้ายังไม่มี
cd recipro-saas
git fetch origin                  # ดึงทุก branch
git branch -a                     # ดูรายการ branch

# ดูงานแต่ละเฟส (checkout ทีละ branch)
git checkout feat/p3-pos-deduction   # P3 ตัดสต๊อกตามหมวด (backend/src/api/stock.js)
git checkout feat/p4-label-print     # P4 ปริ้นป้ายราคา (frontend/index.html)
git checkout feat/p5-reorder-alerts  # P5 เตือนสั่งของ (backend/src/api/stock.js)
git checkout main                    # โค้ดที่ live อยู่จริง

# ดู diff ของแต่ละเฟสเทียบ main
git diff main..feat/p3-pos-deduction
git diff main..feat/p4-label-print
git diff main..feat/p5-reorder-alerts
```

## รัน + เทสต์ local
```bash
cd recipro-saas
cp .env.example .env              # แก้ DATABASE_URL ให้ชี้ Postgres ของคุณ (เช่น postgres://postgres:postgres@localhost:5432/recipro)
npm install
npm run migrate                   # สร้างตาราง + 8 หมวด (idempotent)
npm run bootstrap                 # seed Merry Jane + superadmin (เฉพาะตอน DB ว่าง)
npm start                         # http://localhost:3000  (เครื่องนี้ใช้ PORT=3100 ใน .env)
```
- ทดสอบ P3: `POST /api/pos/sell` body `{ "lines":[{"ref_type":"recipe","ref_id":"<id>","qty":2}], "bill_no":"T", "make_to_order":true }`
- ทดสอบ P5: `GET /api/alerts/reorder` (ตั้ง low_stock > stock ของวัตถุดิบสักตัวก่อน)

## งานที่เหลือต่อเฟส
- **P3**: ต่อหน้า POS (`posCheckout` ใน index.html) ให้เรียก `/api/pos/sell` แทนการตัดสต๊อก client-side · เพิ่มโมเดลผูกบรรจุภัณฑ์ต่อเมนู (packaging ตัดตอนขายอัตโนมัติ) · เพิ่ม consumption types: daily/manual/waste/transfer
- **P4**: polish layout ป้าย (ขนาดกระดาษ/จำนวนต่อแถว/บาร์โค้ด) + เทสต์พิมพ์จริง · รองรับ Niimbot (ดู `docs/next-phases.md` เฟส L)
- **P5**: ผูก cost reporting จาก Item Master (แยกต้นทุน Raw/Packaging/Ops/Waste/Production) · daily auto-deduct cron · manual consumption + approval · waste log

## Deploy (ทำร่วมกับเจ้าของ — gated)
1. **backup DB ก่อนเสมอ**: Railway dashboard → service Postgres → Backups (คลิกเดียว) หรือ `railway run --service Postgres -- powershell -File backup-db.ps1` (ต้องมี pg_dump PG18)
2. merge branch ที่พร้อม → `main`
3. `gh auth switch --user edenharvestdev` (บัญชีที่ push ได้)
4. `railway up --service recipro-app --detach` (รัน migrate→bootstrap→start อัตโนมัติ)
5. verify: เปิด https://www.recipro.love + เช็กข้อมูล/สต๊อกครบ

## โครงสร้าง
- `backend/src/` — Node/Express API (`api/` · `db.js` · `migrate.js`)
- `backend/db/*.sql` — schema (รันทุกไฟล์ตอน migrate; **idempotent**) · `schema-item-master.sql` = P0
- `frontend/index.html` — SPA หลัก (มี POS, สต๊อก, สูตร, จัดหมวด, ป้ายราคา)
- live: **www.recipro.love** · Railway project `recipro` · GitHub `edenharvestdev/recipro-saas`
