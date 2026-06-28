# Recipro SaaS — Feature Freeze Rule

**บังคับใช้:** 2026-06-28
**สถานะ:** 🔴 ACTIVE — Maintenance Freeze ยังไม่ lift
**อัปเดต:** 2026-06-28 — เพิ่มบทเรียนจาก Incident RC-001

---

## กฎหลัก

> **ห้ามเพิ่ม feature ใหม่ทุกชนิดจนกว่า Maintenance Freeze จะถูก lift อย่างเป็นทางการโดย Founder**

> **Any feature request must wait until Maintenance Freeze is officially lifted.**

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

### Dependencies
- ห้ามเพิ่ม npm package ใหม่โดยไม่มี Founder approval
- ห้ามเพิ่ม package ใน `backend/package.json` เท่านั้น — ต้องเพิ่มใน ROOT `package.json` ด้วยเสมอ
- ดู [DEPENDENCY_POLICY.md](DEPENDENCY_POLICY.md) สำหรับรายละเอียด

### Security / Auth / Payment
- ห้ามแตะ `auth/middleware.js`, `auth/tokens.js`, `tenant.js` โดยไม่มี review
- ห้ามแตะ `billing-state.js` โดยไม่มี review
- ห้ามแตะ `pay.js` โดยไม่มีผลการทดสอบ + sign-off
- ห้ามเปลี่ยน JWT secret หรือ algorithm

---

## ✅ ทำได้ระหว่าง Freeze

| อนุญาต | เงื่อนไข |
|--------|---------|
| แก้ P0 bug | ต้องมี Founder approve ก่อน deploy |
| แก้ P1 bug | ต้องมี Founder approve ก่อน deploy |
| อัปเดต documentation | ไม่กระทบ code |
| ตั้ง env var ใน Railway (SENTRY_DSN, OMISE_SECRET_KEY) | Founder ทำเอง |
| ดู logs / monitor | read-only |
| เพิ่ม migration แบบ additive เท่านั้น | ถ้าจำเป็นสำหรับ P0/P1 fix |

---

## กระบวนการ Bug Fix ระหว่าง Freeze

```
1. ระบุ bug พร้อม Priority (P0 หรือ P1)
2. ส่ง RCA และ proposed fix ให้ Founder review
3. รอ Founder approve อย่างชัดเจน ("Approved — fix เลย")
4. แก้ code (minimal change เท่านั้น)
5. ส่ง git diff ให้ Founder review ก่อน deploy
6. รอ Founder approve deploy
7. Deploy + Production QA
8. ส่งผล QA กลับ
```

**ห้าม deploy โดยที่ Founder ยังไม่ได้พูดว่า "deploy เลย" หรือ "Approved"**

---

## กระบวนการขอ Feature ระหว่าง Freeze

Feature request ทุกชิ้นต้องรอ — ไม่มีข้อยกเว้น

```
1. บันทึก feature request ใน OPEN_ISSUES.md ส่วน "Future Improvements"
2. ระบุเหตุผลว่าทำไมต้องรอ
3. Feature จะถูก prioritize เมื่อ Maintenance Freeze lift
```

---

## Exception Process

ถ้าต้องการเพิ่ม feature ใหม่ก่อนเงื่อนไขครบ:

1. เขียน brief สั้นๆ: Feature คืออะไร → ทำไมต้องทำตอนนี้ → risk คืออะไร
2. ส่งให้ Founder / Product Architect อนุมัติ
3. ถ้าอนุมัติ → บันทึกเป็น exception ใน log นี้ + ระบุ scope ชัดเจน

### Exception Log

| วันที่ | Feature | เหตุผล | อนุมัติโดย |
|--------|---------|--------|------------|
| — | — | — | — |

---

## เงื่อนไขการ Lift Freeze

Freeze จะ lift ได้เมื่อ Founder ประกาศอย่างชัดเจน หลังจากเงื่อนไขต่อไปนี้ผ่านครบ:

- [ ] P0-01: Omise payment ทำงานได้จริง (มี `OMISE_SECRET_KEY`)
- [ ] P0-02: Sentry active ใน production (มี `SENTRY_DSN`)
- [ ] P1-01: Password reset ทำงานได้ (มี `RESEND_API_KEY`)
- [ ] P1-02: Billing checkout ทำงานได้
- [ ] Production stable ≥ 7 วัน ไม่มี P0/P1 incident ใหม่
- [ ] มี staging environment (Railway project แยก)
- [ ] Founder ประกาศ lift อย่างชัดเจน

---

## Incident RC-001 — เหตุผลที่ Freeze ยังคงอยู่

วันที่ 2026-06-28 Sprint 001 ทำให้ production DOWN นาน ~2 ชั่วโมง เนื่องจาก:
- เพิ่ม dependency ผิด `package.json` (backend แทน root)
- ไม่มี staging ให้ทดสอบก่อน
- ไม่มี automated test ที่ catch ปัญหานี้ได้

จนกว่าโครงสร้าง deploy จะปลอดภัยกว่านี้ Feature Freeze ยังคงบังคับใช้

---

*ไฟล์นี้อัปเดตโดย Founder/Product Architect เท่านั้น*
