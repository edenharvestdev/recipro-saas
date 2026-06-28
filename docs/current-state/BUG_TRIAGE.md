# Recipro SaaS — Bug Triage Board

**สร้าง:** 2026-06-28  
**โหมด:** Stabilization — แก้เฉพาะ P0/P1 ก่อนเท่านั้น

```
P0 = ระบบใช้ไม่ได้ / ขายไม่ได้ / ข้อมูลรั่ว / เงินผิด
P1 = flow หลักเสีย เช่น stock, order, login, subscription
P2 = ใช้งานลำบากแต่ยังทำงานได้
P3 = UI / wording / improvement / nice-to-have
```

---

## 🔴 P0 — ระบบพัง / ขายไม่ได้ / ข้อมูลอาจผิด

| ID | Bug | ผลกระทบ | หมายเหตุ | สถานะ |
|----|-----|---------|----------|-------|
| P0-01 | **Omise payment ใช้ mock mode** | ลูกค้าชำระเงินผ่าน QR PromptPay ใน POS ไม่ได้จริง | ต้องการ `OMISE_SECRET_KEY` จาก Omise dashboard | ⏳ รอ key |
| P0-02 | **ไม่มี error monitoring ใน production** | ถ้าระบบมี 500 error หรือ crash — ไม่มีใครรู้ทันที | ต้องการ Sentry หรือ uptime monitor | ✅ Sentry integrated (ใส่ `SENTRY_DSN` ใน Railway แล้วเปิดทันที) |

---

## 🟠 P1 — Flow หลักเสีย

| ID | Bug | ผลกระทบ | หมายเหตุ | สถานะ |
|----|-----|---------|----------|-------|
| P1-01 | **ไม่มี password reset** | Owner ลืมรหัสผ่านต้องให้ superadmin แก้ใน DB | ต้องการ RESEND email | ⏳ รอ RESEND key |
| P1-02 | **Integration test ไม่ผ่านใน local** | ไม่สามารถทดสอบ regression ก่อน deploy | ต้องมี `DATABASE_URL` ในเครื่อง dev | ⏳ config issue |
| P1-03 | **Staff discount ceiling ไม่ enforce server-side** | Staff สามารถแก้ request ให้ discount เกิน ceiling ได้ | Frontend บล็อกแต่ server ไม่ตรวจ | ✅ Fixed — sync.js ตรวจ perm + ceiling + audit log |
| P1-04 | **Billing checkout ไม่ทำงาน (503)** | Owner ต่ออายุ / upgrade แพ็กเกจเองไม่ได้ | ผูกกับ P0-01 (Omise mock) | ⏳ รอ key |
| P1-05 | **ไม่มี rate limiting บน /auth/login** | Brute force password ได้ไม่จำกัด | ความเสี่ยงด้าน security | ✅ Fixed — express-rate-limit บน login/register/checkout/charge |

---

## 🟡 P2 — ใช้งานลำบากแต่ยังไม่พัง

| ID | Bug | ผลกระทบ | หมายเหตุ |
|----|-----|---------|----------|
| P2-01 | ไม่มี email verification หลัง register | ใครก็ register ได้ — อาจมีบัญชี spam | ต้องการ RESEND email |
| P2-02 | `backend/src/api/clone.js` มีการแก้ unstaged | อาจทำให้สับสนเมื่อ deploy | ต้องตรวจว่าแก้อะไร แล้ว stage หรือ revert |
| P2-03 | Integration test ต้องการ DB จริง (no mock) | Dev environment setup ยาก | ต้องการ script setup .env |
| P2-04 | ไม่มี staging environment | Deploy ทุกครั้งกระทบ production ทันที | ควรมี Railway project แยกสำหรับ test |
| P2-05 | `backend/grab-bills.js` + `scripts/delivery-bills.js` untracked | ไฟล์ one-off ลอยอยู่ใน repo | ควร gitignore หรือ commit เข้า scripts/ |
| P2-06 | ไม่มี CORS policy ชัดเจน | API อาจถูกเรียกจาก origin อื่นได้ | |
| P2-07 | ไม่มี Helmet.js | ขาด security headers (XSS, clickjacking) | |
| P2-08 | `npm run lint` และ `npm test` ไม่มี | ไม่มี standard quality gate | |

---

## 🔵 P3 — UI / Wording / Nice-to-have

| ID | Bug | หมายเหตุ |
|----|-----|----------|
| P3-01 | Silent print SUNMI/Bridge ยังไม่ได้ทดสอบกับ hardware จริง | ต้องการ SUNMI device ทดสอบ |
| P3-02 | Cross-branch summary ยังไม่รู้ว่า query SQL ช้าหรือไม่ | ถ้ามีหลายสาขามาก อาจต้องเพิ่ม index |
| P3-03 | Member tier: ถ้าไม่มี tiers ใดตั้งไว้ `getMemberTier()` return null | ไม่ crash แต่ tier badge ไม่แสดง — expected behavior |
| P3-04 | Promo picker: ถ้าไม่มีโปรโมชั่นที่ active แสดงข้อความว่าง | ควรแสดง hint ว่าไปสร้างที่ไหน |

---

## Log การแก้ไข

| วันที่ | ID | Action | ผู้ทำ |
|--------|-----|--------|-------|
| 2026-06-28 | — | เปิด triage board, Stabilization mode เริ่มต้น | — |
| 2026-06-28 | P0-02 | Sentry integrated (`@sentry/node`) — ใส่ `SENTRY_DSN` ใน Railway | Sprint 001 |
| 2026-06-28 | P1-03 | Staff discount server-side enforcement + audit log ใน sync.js | Sprint 001 |
| 2026-06-28 | P1-05 | Rate limiting: login(20/15m), register(10/h), checkout(5/h), charge(10/5m) | Sprint 001 |

---

## กฎ: P2/P3 ห้ามแก้จนกว่า P0/P1 จะ clear ทั้งหมด
