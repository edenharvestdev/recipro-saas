# Recipro SaaS — Feature Freeze Rule

**มีผลตั้งแต่:** 2026-06-28  
**สถานะ:** 🔒 FEATURE FREEZE ACTIVE  
**เหตุผล:** ระบบเริ่มมีผู้ใช้งานจริง — ให้ Stabilize ก่อนขยายต่อ

---

## ❌ ห้ามทำโดยไม่มี Founder Approval

### Features ใหม่
- ห้ามเพิ่ม feature ใหม่ทุกชนิด
- ห้าม implement flow ใหม่ที่ยังไม่มีใน codebase
- ห้ามเพิ่ม integration ใหม่ (LINE, email provider ใหม่, payment provider อื่น)

### UI / Design
- ห้าม redesign หน้าใดๆ (layout, navigation, color scheme)
- ห้ามเปลี่ยน terminology ของ field สำคัญ (ชื่อ, เลขที่, ราคา)
- ห้ามย้าย component ที่ user ใช้ประจำ (POS cart, menu, settings)

### Refactoring
- ห้าม refactor ใหญ่ (เปลี่ยน architecture, split ไฟล์ใหม่)
- ห้ามเปลี่ยน data flow หลัก (sync/bootstrap pattern)
- ห้าม extract หรือแยก index.html ออกเป็นหลายไฟล์

### Database
- ห้าม DROP column, DROP table ทุกกรณี
- ห้าม RENAME column หรือเปลี่ยน type
- ห้าม ADD column ที่ NOT NULL ไม่มี default (breaking migration)
- ห้ามเพิ่ม migration ใหม่ถ้าไม่จำเป็นจริงๆ

### Security / Auth / Payment
- ห้ามแตะ `auth/middleware.js`, `auth/tokens.js`, `tenant.js` โดยไม่มี review
- ห้ามแตะ `billing-state.js` โดยไม่มี review
- ห้ามแตะ `pay.js` โดยไม่มีผลการทดสอบ + sign-off
- ห้ามเปลี่ยน JWT secret หรือ algorithm

---

## ✅ ทำได้ (P0/P1 fixes เท่านั้น)

- แก้ bug ที่ทำให้ขายไม่ได้หรือข้อมูลผิด (P0)
- แก้ bug ที่ทำให้ flow หลักเสีย (P1)
- ใส่ `OMISE_SECRET_KEY` เพื่อเปิด payment จริง
- เพิ่ม error monitoring (Sentry) — ถือว่า infra ไม่ใช่ feature
- Fix security issue (rate limiting, staff discount server-side check)

---

## กระบวนการ Deploy

### ก่อน deploy ทุกครั้ง
1. **Founder Approval** — แจ้ง Founder ว่าจะ deploy อะไร
2. **ตรวจ git diff** — ดูว่าแก้อะไรและไม่ได้แตะสิ่งที่ห้าม
3. **รัน integration test** (ถ้ามี DB local) — `npm run test:int`
4. **Manual QA** — ทดสอบ flow ที่แก้ด้วยมือก่อน deploy
5. **Deploy ในเวลาที่ร้านว่าง** — ไม่ deploy ตอน peak hours

### หลัง deploy ทุกครั้ง
6. **ตรวจ Railway logs** — ดูว่ามี error ใหม่ไหม (อย่างน้อย 15 นาที)
7. **ทดสอบ happy path** ใน production — login, POS ขาย 1 บิล, bootstrap
8. **บันทึก deploy log** — commit id, เวลา, ผู้ deploy, สิ่งที่เปลี่ยน

---

## เงื่อนไขเปิด Freeze

Feature Freeze จะเปิดเมื่อ:
1. ✅ P0 ทุกรายการปิดแล้ว
2. ✅ P1 ที่สำคัญ (P1-01 ถึง P1-03) ปิดแล้ว
3. ✅ มี error monitoring (Sentry หรือเทียบเท่า) ทำงานอยู่
4. ✅ มี staging environment สำหรับทดสอบ
5. ✅ Founder Approval อย่างเป็นทางการ

---

## Exception Process

ถ้าต้องการเพิ่ม feature ใหม่ก่อนเงื่อนไขครบ:

1. เขียน brief สั้นๆ: Feature คืออะไร → ทำไมต้องทำตอนนี้ → risk คืออะไร
2. ส่งให้ Founder / Product Architect อนุมัติ
3. ถ้าอนุมัติ → บันทึกเป็น exception ใน log นี้ + ระบุ scope ชัดเจน

---

## Exception Log

| วันที่ | Feature | เหตุผล | อนุมัติโดย |
|--------|---------|--------|------------|
| — | — | — | — |
