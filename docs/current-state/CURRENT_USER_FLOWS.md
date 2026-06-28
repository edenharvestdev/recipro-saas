# Recipro SaaS — Current User Flow Map

**สร้าง:** 2026-06-28  
**สถานะ:** Stabilization Mode

---

## Flow Overview

| Flow | Role | สถานะ |
|------|------|--------|
| Register / Login | Owner | ✅ Working |
| Owner Onboarding | Owner | ✅ Working |
| Store Setup | Owner | ✅ Working |
| POS / Order Creation | Owner, Staff | ✅ Working |
| Online Menu (QR) | Owner, ลูกค้า | ✅ Working |
| Product / Menu Management | Owner | ✅ Working |
| Inventory / Stock Movement | Owner, Staff (perm) | ✅ Working |
| Recipe / Cost Calculation | Owner | ✅ Working |
| Staff Roles / Permissions | Owner | ✅ Working |
| Subscription / Billing | Owner | ⚠️ Partial (payment mock) |
| Super Admin | Superadmin | ✅ Working |
| Reports | Owner | ✅ Working |
| Promotions | Owner | ✅ Working |
| Member / Loyalty | Owner, Staff | ✅ Working |
| Delivery Reconcile | Owner | ✅ Working |
| Expense / Petty Cash | Owner | ✅ Working |
| Snapshots / Backup | Owner, Superadmin | ✅ Working |
| Cross-Branch Admin | Superadmin | ✅ Working |
| Offline Mode | Owner, Staff | ✅ Working (basic) |
| Payment (Omise) | Owner, ลูกค้า | ❌ Mock Only |
| Email (register/reset) | Owner | ❌ Not Working |
| PWA / Mobile | Owner, Staff | ✅ Working |

---

## 1. Register / Login

**Path:** `/` → login form  
**Role:** ทุกคน (public)  
**Steps:**
1. เปิด https://www.recipro.love
2. กรอก email + password → POST `/auth/register` (ครั้งแรก) หรือ `/auth/login`
3. ได้รับ `accessToken` + `refreshToken`
4. Token เก็บใน `localStorage`
5. Auto-refresh ผ่าน `/auth/refresh` เมื่อ access token หมดอายุ (15 นาที)

**Dependency:** Database, JWT_SECRET, JWT_REFRESH_SECRET  
**Bug:** ไม่มี email verification — ใคร register ได้ทันที  
**Bug:** ไม่มี password reset — ถ้าลืมรหัสต้องให้ superadmin แก้ใน DB  
**Status:** ✅ Working (แต่ missing email verify + reset)

---

## 2. Owner Onboarding

**Path:** `/` → หลัง login → ตรวจ `shop` ใน bootstrap  
**Role:** Owner  
**Steps:**
1. Login → ระบบดึง `/api/bootstrap`
2. ถ้าร้านว่าง → แสดง Setup Wizard (step-by-step: ชื่อร้าน, ประเภทธุรกิจ, ตั้งค่าพื้นฐาน)
3. เสร็จ wizard → บันทึกผ่าน `/api/sync`
4. แสดง checklist onboarding (กล่อง widget ซ้าย)

**Dependency:** `/api/bootstrap`, `/api/sync`  
**Status:** ✅ Working

---

## 3. Store Setup (Settings)

**Path:** `setPage` → แท็บ "ตั้งค่า"  
**Role:** Owner  
**Steps:**
1. ตั้งประเภทธุรกิจ (fnb/service/retail/maker/factory)
2. ตั้งค่าร้าน (ชื่อ, โลโก้, ที่อยู่, แบงก์, PromptPay)
3. จัดการทีมงาน (invite staff, set permissions)
4. ตั้งค่าเครื่องพิมพ์ (mode: dialog/SUNMI/bridge)
5. ตั้งค่าส่วนลด preset + staff discount ceiling
6. เปิด/ปิด delivery, petty cash, make-to-order

**Dependency:** `/api/sync`, `/api/staff`  
**Status:** ✅ Working

---

## 4. POS / Order Creation (หน้าขาย)

**Path:** `posPage` → แท็บ "ขาย"  
**Role:** Owner, Staff  
**Steps:**
1. เลือกเมนู/สินค้าจาก grid → เพิ่มลงตะกร้า
2. ปรับ option groups (เลือก size, topping ฯลฯ)
3. ใส่เบอร์สมาชิก (ถ้ามี) → lookup แต้ม + tier discount
4. เลือกส่วนลด (preset หรือกดปุ่มใส่เอง)
5. เลือกโปรโมชั่น (ถ้ามี) → "ใช้โปรโมชั่น"
6. เลือกช่องทางชำระ (cash/transfer/card/QR)
7. กด "ชำระเงิน" → บันทึกบิล + ตัดสต๊อก + สะสมแต้ม + พิมพ์ใบเสร็จ

**Payment flow (Omise QR):**
- กด "QR Code Omise" → POST `/api/pay/charge` → สร้าง charge → แสดง QR  
- ⚠️ ปัจจุบันอยู่ใน mock mode (ไม่มี `OMISE_SECRET_KEY`)

**Dependency:** `/api/sync`, `/api/pos/sell`, `/api/pay`  
**Status:** ✅ Working (ยกเว้น Omise จริง ❌ mock)

---

## 5. Online Menu / QR Self-Order

**Path:** `/menu/{slug}` (public) → `posPage` แท็บ "ออนไลน์"  
**Role:** Owner (manage), ลูกค้า (order)  
**Steps:**
1. Owner เปิด Public Menu ใน settings
2. ลูกค้าสแกน QR → เปิด menu.html → เลือกสินค้า → POST `/public/orders`
3. Owner เห็น popup + เสียงเตือน → กด "รับ/เริ่มทำ/พร้อม/รับแล้ว"
4. พิมพ์ใบส่งครัวอัตโนมัติ (ถ้าตั้งไว้)

**Dependency:** `/api/orders`, `/public/orders`, sound files  
**Status:** ✅ Working

---

## 6. Product / Menu Management

**Path:** `materialsPage`, `recipesPage`, `optionsPage`  
**Role:** Owner (Staff ถ้าได้ perm `edit_recipes`)  
**Steps:**

**วัตถุดิบ:**
1. เพิ่ม/แก้ไขวัตถุดิบ (ชื่อ, SKU, หน่วย, ราคา, stock alert)
2. กำหนดหมวด, supplier, unit conversion
3. รับวัตถุดิบเข้าสต๊อก → `/api/stock/move`

**สูตร/เมนู:**
1. สร้างสูตร (ชื่อ, ราคาขาย, วัตถุดิบ + ปริมาณ)
2. คำนวณ cost อัตโนมัติ
3. กำหนด option groups
4. ตั้ง SOP (Standard Operating Procedure)

**Dependency:** `/api/sync`, `/api/stock`  
**Status:** ✅ Working

---

## 7. Inventory / Stock Movement

**Path:** `stockPage` → แท็บ "สต๊อก/ผลิต"  
**Role:** Owner, Staff (perm: `stock_receive`, `waste`)  
**Operations:**
- รับวัตถุดิบเข้า → `/api/stock/move` (kind: receive)
- ผลิต → `/api/stock/produce` (ตัดวัตถุดิบ + เพิ่ม fg_stock)
- บันทึกของสูญเสีย → `/api/stock/waste`
- ดูประวัติ stock movement

**Dependency:** `/api/stock`, `/api/sync`  
**Status:** ✅ Working

---

## 8. Recipe / Cost Calculation

**Path:** `recipesPage`  
**Role:** Owner  
**Steps:**
1. สร้างสูตร → เพิ่มวัตถุดิบ + ปริมาณ
2. ระบบคำนวณ cost per unit อัตโนมัติ
3. ตั้งราคาขาย → ดู margin/gross profit

**Dependency:** materials + recipe_items  
**Status:** ✅ Working

---

## 9. Staff Roles / Permissions

**Path:** `setPage` → Staff card  
**Role:** Owner  
**Roles ในระบบ:** superadmin, owner, staff  
**Permissions ที่ควบคุมได้:**
- `discount` — ให้ส่วนลดได้
- `void` — ยกเลิกรายการได้
- `stock_receive` — รับวัตถุดิบได้
- `waste` — บันทึกของสูญเสียได้
- `edit_recipes` — แก้สูตรได้
- `view_cost` — เห็นต้นทุนได้
- `petty_cash` — จัดการเงินสดย่อยได้

**Dependency:** `/api/staff`, `/api/sync`  
**Status:** ✅ Working

---

## 10. Subscription / Billing

**Path:** `billingPage` → แท็บ "แพ็กเกจ"  
**Role:** Owner, Superadmin  
**Plans:** Starter (299฿/เดือน), Pro (590฿), Premium (990฿)  
**Billing States:** trial → active → expiring → grace → readonly → suspended  
**Steps:**
1. Trial 30 วัน → แสดงแถบเตือน
2. เลือกแพ็กเกจ → POST `/api/billing/checkout` → Omise charge
3. ⚠️ ปัจจุบัน Checkout ล้มเหลว (Omise mock) → return 503

**Dependency:** Omise key, `/api/billing`, `/api/plans`  
**Bug (P0):** Payment gateway อยู่ใน mock mode  
**Status:** ⚠️ Partial — billing state ทำงาน, checkout ไม่ได้จนกว่าจะใส่ key

---

## 11. Super Admin

**Path:** `adminPage` → แสดงเฉพาะ superadmin  
**Role:** Superadmin only  
**Features:**
- ดูร้านค้าทั้งหมด + status
- สร้างร้านใหม่ + owner account
- แก้ billing (extend, change plan)
- ดู event logs
- Cross-branch summary (ยอดรวมทุกสาขา)
- Clone ร้าน (เพื่อ onboard ร้านใหม่จาก template)

**Dependency:** `requireSuperadmin` middleware, `/api/admin/*`  
**Status:** ✅ Working

---

## 12. Reports

**Path:** `reportPage` → แท็บ "รายงาน"  
**Role:** Owner  
**Reports:**
- ยอดขายรายวัน/เดือน
- กำไร/ขาดทุน (P&L)
- ค่าใช้จ่าย
- สต๊อกคงเหลือ
- ลูกค้า/สมาชิก
- เปรียบเทียบ delivery

**Dependency:** bills, expenses, stock_movements  
**Status:** ✅ Working (คำนวณ client-side จากข้อมูลที่ sync)

---

## 13. PWA / Mobile Usage

**Path:** manifest.json + sw.js  
**Role:** ทุกคน  
**Features:**
- Add to homescreen (PWA installable)
- Offline mode: โหลดจาก cache ได้เมื่อ network ขาด
- Pending sync queue: ข้อมูลที่บันทึกขณะออฟไลน์จะ sync เมื่อกลับมาออนไลน์
- Responsive design (mobile-first)

**Status:** ✅ Working
