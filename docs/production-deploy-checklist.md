# Production Deploy Checklist — Portfolio Release (hardening + stock-search + pos-ops)

> เอกสารอย่างเดียว — ยังไม่มีการ merge/deploy ใด ๆ · ใช้เมื่อ Founder อนุมัติครบแล้วเท่านั้น
> ห้ามพิมพ์/เปิดเผยค่า secret ในทุกขั้นตอน (ตรวจแค่ "ตั้งแล้ว/ยังไม่ตั้ง")

## PRE-MERGE
- [ ] Founder approval บันทึกเป็นลายลักษณ์: P1 UX ✅ · P2 UX ✅ · Hardening 3 commits ✅ (อนุมัติแยกได้)
- [ ] เตรียมค่า `OMISE_WEBHOOK_SECRET` (จาก Omise dashboard) — **ยังไม่ต้องตั้ง** แต่ต้องพร้อมก่อน deploy Fix 1 ไม่งั้น webhook Omise จะโดน 503 โดยตั้งใจ (fail-closed)
- [ ] ยืนยัน Railway `NODE_ENV=production` (ตรวจแล้ว 2026-07-18: ✅ ตั้งอยู่)
- [ ] ยืนยัน `ALLOW_UNVERIFIED_WEBHOOKS` **ไม่ถูกตั้ง** ใน Railway (flag นี้เป็นหมันใน prod โดยดีไซน์ แต่ไม่ควรมีอยู่เลย)
- [ ] Postgres backup/checkpoint (Railway snapshot หรือ `pg_dump` ก่อน merge วันจริง)
- [ ] ตรวจ migration ที่จะเข้า: **`schema-pos-ops.sql` ไฟล์เดียว** — additive ล้วน + ลงทะเบียนใน migrate.js แล้ว (hardening/stock-search ไม่มี schema)
- [ ] จด rollback refs: production ปัจจุบัน = `5c5319f` · branch heads = `4f994c9` / `dac6fa9` / `12f7cff`

## MERGE (ลำดับตายตัว)
1. [ ] `fix/payment-path-hardening` → main (3 commits คง revert แยกได้)
2. [ ] `feat/stock-production-search` → main
3. [ ] `feat/pos-operations-manager` → main
- [ ] Conflict rule: ชนกันได้เฉพาะ `frontend/index.html` (และอาจ `sync.js`) — ใช้ resolution ที่ validate แล้วใน `integration-readiness-report.md`; ห้าม "เลือกฝั่งใดฝั่งหนึ่งทั้งไฟล์"
- [ ] Full `npm test` บน integrated main (คาด ~25 test files — เทียบเลขจริงกับ integration report), 0 fail
- [ ] `npm run release:preflight` = PASS (Migration inventory: DETECTED = ถูกต้อง)

## PRE-DEPLOY
- [ ] ตั้ง `OMISE_WEBHOOK_SECRET` ใน Railway (ไม่ echo ค่า)
- [ ] ตรวจ env: `railway variables | grep -c OMISE_WEBHOOK_SECRET` = 1 (ดูแค่ว่ามี key)
- [ ] ยืนยัน migration additive (อ่าน `schema-pos-ops.sql` รอบสุดท้าย: มีแต่ `add column if not exists` / index)
- [ ] ยืนยัน `frontend/vendor/qrcode-generator-1.4.4.js` อยู่ในทรี + อยู่ใน `VERSIONED_ASSETS`
- [ ] `grep -c "promptpay.io" frontend/index.html` = 1 (เหลือเฉพาะคอมเมนต์) · `grep jsdelivr` บนเส้นทางจ่ายเงิน = 0
- [ ] Deploy: `railway up --service recipro-app --ci` จาก main ที่ merge ครบ
- [ ] ดู boot log: `schema-pos-ops.sql ... ok` → `migrate: done` → boot เดียว ไม่วน

## POST-DEPLOY SMOKE (ร้าน SMOKE TEST เดิม — ห้ามใช้ร้านจริง)
- [ ] ขาย POS ปกติ 1 บิล (cash) — ราคา/สต๊อก/ใบเสร็จปกติ
- [ ] ปิดเมนู 1 ตัว (เลือกเหตุผล) → การ์ดขึ้นริบบิ้น "ปิดขาย" → แตะแล้วถูกบล็อกพร้อมเหตุผล → เปิดกลับ
- [ ] ยิงบาร์โค้ดสินค้าที่ปิดขาย → ถูกบล็อก (ไม่มี toast สำเร็จปลอม)
- [ ] Stock warning เดิมยังแสดงตามปกติ (แยกจากปิดขายชัดเจน)
- [ ] หน้าผลิต: ค้นหาไทย / อังกฤษ / SKU + คีย์บอร์ด ↑↓ Enter + เลือกแล้วไม่รีเซ็ตหลัง re-render
- [ ] Static QR (พร้อมเพย์) แสดงได้ — และ **network ภายนอกถูกตัดก็ยังแสดง** (ทดสอบ: DevTools offline หรือ block jsdelivr/promptpay.io — QR ต้องยังเรนเดอร์)
- [ ] Webhook: POST ปลอมไป `/webhooks/omise` โดยไม่มีลายเซ็น → 401 · ลายเซ็นมั่ว → 401 · (ก่อนตั้ง secret: → 503)
- [ ] Webhook จริงซ้ำ 2 ครั้ง → idempotent (ไม่เกิดรายการซ้ำ)

## ROLLBACK
- [ ] App: `git checkout 5c5319f && railway up --service recipro-app --ci` (คอลัมน์ใหม่เป็น inert ต่อโค้ดเก่า — ไม่ต้อง migrate ย้อน)
- [ ] Migration: **ไม่ต้อง drop** (additive; โค้ดเก่าไม่อ่าน) — drop เฉพาะเมื่อจงใจถอนถาวร
- [ ] Env: `OMISE_WEBHOOK_SECRET` **คงไว้ได้** แม้ rollback (โค้ดเก่าใช้ตรวจแบบเดิม ไม่พัง)
- [ ] Smoke หลัง rollback: ขาย 1 บิล + bootstrap ร้าน smoke ปกติ
- [ ] บันทึก incident log: อะไรพัง เวลาไหน rollback เมื่อไหร่ อาการหลัง rollback
