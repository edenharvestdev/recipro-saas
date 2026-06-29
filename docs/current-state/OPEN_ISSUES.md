# Recipro SaaS — Open Issues

**อัปเดต:** 2026-06-28
**โหมด:** Maintenance Freeze — แก้เฉพาะ P0/P1

```
P0 = ระบบใช้ไม่ได้ / ขายไม่ได้ / ข้อมูลรั่ว / เงินผิด
P1 = flow หลักเสีย — stock, order, login, subscription, security
P2 = ใช้งานลำบากแต่ยังทำงานได้
Tech Debt = ปัญหาด้านโครงสร้างที่ไม่กระทบ user ทันที
Future = feature ที่รอ Maintenance Freeze lift
```

---

## P0 — ระบบพัง / ขายไม่ได้ / ข้อมูลอาจผิด

| ID | Issue | ผลกระทบ | ต้องการ | สถานะ |
|----|-------|---------|---------|--------|
| P0-01 | **Omise payment ใช้ mock mode** | ลูกค้าชำระเงินผ่าน QR/บัตรใน POS ไม่ได้จริง | `OMISE_SECRET_KEY` จาก Omise dashboard | ⏳ รอ key |
| P0-02 | **ไม่มี Sentry DSN ใน Railway** | Sentry code deploy แล้ว แต่ยังไม่ active — ไม่รู้ว่ามี 500 error | `SENTRY_DSN` ตั้งใน Railway Variables | ⏳ รอ Founder |

---

## P1 — Flow หลักเสีย

| ID | Issue | ผลกระทบ | ต้องการ | สถานะ |
|----|-------|---------|---------|--------|
| P1-01 | **ไม่มี password reset** | Owner/staff ลืมรหัสผ่านต้องให้ superadmin แก้ใน DB | `RESEND_API_KEY` | ⏳ รอ key |
| P1-02 | **Billing checkout 503** | Owner ต่ออายุ/upgrade เองไม่ได้ | ผูกกับ P0-01 (Omise) | ⏳ รอ key |
| P1-03 | **Integration test ไม่ผ่าน local** | ไม่มี automated regression check ก่อน deploy | `DATABASE_URL` ในเครื่อง dev | ⏳ config |

---

## P2 — ใช้งานลำบากแต่ยังไม่พัง

| ID | Issue | ผลกระทบ | หมายเหตุ |
|----|-------|---------|----------|
| P2-01 | ไม่มี email verification หลัง register | ใครก็ register ได้ — อาจมีบัญชี spam | รอ RESEND |
| P2-02 | ไม่มี staging environment | ทุก deploy กระทบ production ทันที — RC-001 เกิดจากนี้ | |
| P2-03 | ไม่มี Helmet.js | ขาด security headers (XSS, clickjacking, HSTS) | |
| P2-04 | ไม่มี uptime monitor | ไม่รู้ว่า production down จนกว่าลูกค้าแจ้ง | |
| P2-05 | ไม่มี CORS policy ชัดเจน | เปิด `*` อยู่ — ยอมรับได้กับ Bearer token แต่ควร document | |
| P2-06 | `backend/grab-bills.js` + `scripts/delivery-bills.js` untracked | ไฟล์ one-off ลอยอยู่ — ควร gitignore หรือ commit เข้า scripts/ | |
| P2-07 | `backend/src/api/clone.js` มีการแก้ unstaged | อาจทำให้สับสนเมื่อ deploy | ตรวจว่าแก้อะไร แล้ว stage หรือ revert |
| P2-08 | ไม่มี npm test / lint | ไม่มี quality gate มาตรฐาน | |

---

## Technical Debt

| ID | Issue | ความเสี่ยง | หมายเหตุ |
|----|-------|-----------|----------|
| TD-01 | **ROOT + backend package.json ต้อง sync manual** | ถ้าเพิ่ม dep ใน backend/package.json แต่ลืม root → RC-001 ซ้ำ | ดู DEPENDENCY_POLICY.md |
| TD-02 | Frontend ไฟล์เดียว 12,000+ บรรทัด | แก้ไขยาก, regression ง่าย, merge conflict บ่อย | |
| TD-03 | ไม่มี down-migration | ถ้า schema ผิดต้องเขียน SQL drop เอง | |
| TD-04 | ไม่มี CI/CD pipeline | deploy ด้วย manual command ทุกครั้ง — human error สูง | |
| TD-05 | Security อยู่ที่ application layer เท่านั้น | ไม่มี Row Level Security ใน PostgreSQL | |
| TD-06 | `backend/package-lock.json` ไม่มีประโยชน์ (ถูกลบแล้ว) | Railway ไม่เคยใช้ไฟล์นี้ — ลบออกใน `9cf314b` | |
| TD-07 | ไม่มี request logging middleware | debug production issue ยาก | |

---

## Future Improvements (รอ Maintenance Freeze lift)

| ID | Feature | เหตุผลที่รอ |
|----|---------|------------|
| F-01 | Omise production keys + test checkout flow | รอ P0-01 |
| F-02 | RESEND email — password reset + verification | รอ P1-01 key |
| F-03 | SlipOK slip verification | รอ key |
| F-04 | LINE Notify | ยังไม่ได้ implement |
| F-05 | Staging environment (Railway project แยก) | ควรทำก่อน feature ใหม่ใดๆ |
| F-06 | CI/CD — auto test ก่อน deploy | |
| F-07 | Frontend split / component structure | |
| F-08 | SUNMI silent print ทดสอบกับ hardware จริง | ต้องการ device |
| F-09 | HQ cross-branch advanced reporting | Deferred จาก Sprint backlog |
| F-10 | Promotions / Member tiers enhancements | Deferred |

---

## Resolved Issues Log

| วันที่ | ID | Issue | Resolution | Commit |
|--------|-----|-------|------------|--------|
| 2026-06-28 | — | Staff discount ceiling ไม่ enforce server-side | Fixed ใน `sync.js` | `36f3a77` |
| 2026-06-28 | — | Rate limiting ไม่มี | Added `express-rate-limit` บน auth/payment | `36f3a77` |
| 2026-06-28 | — | ไม่มี Sentry integration | `@sentry/node` integrated (รอ DSN) | `36f3a77` |
| 2026-06-28 | RC-001 | Production DOWN — MODULE_NOT_FOUND `@sentry/node` | เพิ่ม packages ใน ROOT `package.json` | `9609458` |
| 2026-06-29 | S11 | HBT02 Stock Correction & Finished Goods Mode | Added per-recipe modes and reversal_of link to DB, adjusted stock (+11), verified by QA | `ea82e86` |
