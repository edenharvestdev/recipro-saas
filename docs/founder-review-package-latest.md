# Founder Review Package — updated 2026-07-19 (post-Founder-decisions)

## สถานะคิว (ตามคำตัดสิน Founder 2026-07-19)
- **APPROVED — ARCHITECTURE:** Availability Policy 3 แกน (implement หลัง P1 ผ่าน Production Acceptance เท่านั้น — แผน+เมทริกซ์: `availability-policy-implementation-plan.md`)
- **APPROVED — TECHNICAL INTEGRATION:** webhook fail-closed (`c2ca6ee`) · local PromptPay ใน index.html (`d1df845`) · bundled QR lib (`4f994c9`) · local PromptPay ใน menu.html (`4fe45c0`)
- **STILL REQUIRES FOUNDER UX REVIEW:** P1 POS Operations Manager · P2 Stock Production Search (ห้าม mark accepted จนกว่า Founder เดิน walkthrough เอง)
- **REQUIRES ENVIRONMENT ACTION BEFORE DEPLOY:** ตั้ง `OMISE_WEBHOOK_SECRET` (+ ยืนยัน `NODE_ENV=production`, ไม่มี `ALLOW_UNVERIFIED_WEBHOOKS`)
- **DEFERRED:** Availability Policy implementation · Billing implementation · K SHOP live · reconciliation · Recent/Favorites · Delivery cleanup
- **Release order ที่อนุมัติ:** A hardening (3 commits) → B menu-fix (`4fe45c0`) → C stock-search (`dac6fa9`) → D pos-ops (`12f7cff`) — integration branch: `release/recipro-pos-payment-hardening-review`

อ่านจบเองได้โดยไม่ต้องเปิด commit history · production ยังคือ `5c5319f` ไม่ถูกแตะ

---

## Section A — Decisions Required

### A1 · Zero-stock override (จาก P1)
- **พฤติกรรมปัจจุบัน (หลัง P1):** ผู้จัดการ**ปิด**เมนูที่มีของได้ ✅ · แต่**เปิดขายเมนูที่ระบบคิดว่าของหมด**ยังทำไม่ได้ — zero-stock ยัง block ตามกติกาเดิม
- **เหตุผลที่ไม่สร้างตามสเปกตรง ๆ:** คอลัมน์ default `true` แยก "ไม่เคยตั้งค่า" กับ "ตั้งใจ override" ไม่ได้ → ถ้าสร้างแบบนั้น ของหมดทั้งร้านจะขายได้ทันทีที่ deploy
- **ข้อเสนอ:** Availability Policy 3 แกน (SELLING STATE / STOCK DECISION / SAFETY BLOCK) — ดีไซน์เต็มใน `availability-policy-design.md` · แกนใหม่ default `FOLLOW_STOCK_POLICY` = พฤติกรรมเดิมเป๊ะ migration ไม่เปลี่ยนอะไร
- **ผลของการตัดสิน:** อนุมัติ → PR เล็กต่อยอด P1 (ไม่แก้ของเดิม) · ปฏิเสธ → ใช้ P1 ตามที่เป็น (ปิดได้อย่างเดียว) · เลื่อน → ไม่กระทบการ merge P1
- **เวลา:** อ่านดีไซน์ ~10 นาที

### A2 · `OMISE_WEBHOOK_SECRET`
- **ทำไม:** Fix 1 ทำ webhook เป็น fail-closed — secret ไม่ตั้ง = ปฏิเสธทุก webhook (503) โดยตั้งใจ
- **ตั้งเมื่อไหร่:** ก่อน deploy รอบที่มี Fix 1 (จังหวะอยู่ใน deploy checklist) — ค่าเอาจาก Omise dashboard; ห้ามส่งค่าผ่านแชท
- **ถ้าไม่ตั้งแล้ว deploy:** การแจ้งจ่ายเงินอัตโนมัติจาก Omise จะไม่เข้า (ปลอดภัยแต่ฟีเจอร์เงียบ) — นี่คือพฤติกรรมที่ถูกต้องของ fail-closed
- **เวลา:** 1 นาที

### A3 · คิวตัดสินใจเดิม (จาก closure audit — ยังค้างครบ)
| ข้อ | เวลา |
|---|---|
| Delivery drafts 9 batch (ค้างตั้งแต่ 22–30 มิ.ย.) — post หรือทิ้ง | ~15 นาที |
| ลอง Order Sound + Display Mode บนโปรดักชัน (adoption 0) | ~5 นาที |
| นโยบายปัดเศษ PERCENT_OF_BASE (แนะนำ: ใช้ % ลงตัวไปก่อน) | ~3 นาที |
| ดู Material health badge + ลองสร้าง SERVICE item | ~5 นาที |
| Coupon gate (ก่อนแคมเปญแรก — ธุรกิจล้วน) | เมื่อพร้อม |
| ลบหมวด stray "Scent & Sip Coffee" + ร้าน SMOKE TEST | ~2 นาที |
| PR เก่า: ปิด #37/#21 (superseded) · ตัดสิน #36 receive-delta · #38 docs · #23 hold · #17 ผูก delivery | ~10 นาที |
| (ใหม่) vendor CDN ที่เหลือของ label-printing/xlsx ตาม payment path ไหม | ~2 นาที |

---

## Section B — UX Reviews

### B1 · P1 POS Operations Manager (`feat/pos-operations-manager` @ `12f7cff`) — ~10 นาที
เตรียม: `git checkout feat/pos-operations-manager && npm run migrate && npm start` (login ร้านทดสอบ `founder.test@local.test` / `FounderTest#2026`)
| # | คลิก | ผลที่ต้องเห็น |
|---|---|---|
| 1 | เปิดหน้าขาย (POS) | การ์ดเมนูปกติ มีไอคอน toggle มุมการ์ด (เห็นเฉพาะ owner/ผู้มีสิทธิ์) |
| 2 | กดไอคอน toggle บนเมนู 1 ตัว | sheet เหตุผล 6 ตัวเลือก (ของหมด/ปิดขายชั่วคราว/ไม่ขายวันนี้/Seasonal/Kitchen unavailable/Other) |
| 3 | เลือก "ปิดขายชั่วคราว" | การ์ดขึ้น**ริบบิ้นทแยง "ปิดขาย"** + จาง — คนละหน้าตากับ warning สต๊อก |
| 4 | แตะการ์ดที่ปิด | ถูกบล็อก + เห็นเหตุผล (ไม่เข้าตะกร้า) |
| 5 | ยิงบาร์โค้ดสินค้าตัวเดียวกัน | ถูกบล็อกเหมือนกัน — **ไม่มี** toast สำเร็จปลอม |
| 6 | รีเฟรชหน้า / เปิดอีกเครื่อง | สถานะปิดขายคงอยู่ (persist ผ่าน server) |
| 7 | เปิดขายกลับ | การ์ดกลับปกติ ขายได้ |
| 8 | ซ่อนหมวดจากหน้า POS (archive) แล้วเรียกคืน | เมนูในหมวดไม่หาย การจัดหมวดคงเดิม |
| 9 | (ถ้ามี staff account) ล็อกอิน staff ไม่มีสิทธิ์ | ไม่เห็น toggle / toggle ไม่ผ่าน — แต่เมนูยังขายได้ปกติ (fail closed เฉพาะสิทธิ์) |
📷 checklist: [ ] การ์ดปกติ [ ] sheet เหตุผล [ ] ริบบิ้นปิดขาย [ ] toast บล็อก [ ] หลังรีเฟรช

**เมนูทดสอบที่ปลอดภัย:** ใช้ร้านทดสอบ local (`founder.test@local.test` — seed ด้วย `node scripts/seed-authoring-test.js --reset`) → ใช้ "TEST Latte" เป็นเมนูทดลองปิด/เปิด — ไม่มีทางกระทบร้านจริงเพราะเป็นคนละฐานข้อมูลกับโปรดักชันทั้งหมด
**ตรวจ audit log:** หลังปิด/เปิดเมนูครบ รัน (ในโฟลเดอร์ repo):
`node -e "require('dotenv').config();const{Pool}=require('pg');new Pool({connectionString:process.env.DATABASE_URL}).query(\"select action, detail->>'old' as old, detail->>'new' as new, detail->>'reason' as reason, created_at from logs where action='menu.availability_change' order by created_at desc limit 5\").then(r=>{console.table(r.rows);process.exit(0)})"`
ต้องเห็นแถวครบทุกการกด พร้อม old/new/reason
**Rollback/cleanup หลังรีวิว:** เปิดเมนูที่ปิดไว้กลับทั้งหมด (หรือรัน seed `--reset` รอบเดียวจบ) → `git checkout main` — เครื่องคุณกลับสถานะเดิม ไม่มีอะไรตกค้าง

### B2 · P2 Stock Production Search (`feat/stock-production-search` @ `dac6fa9`) — ~5 นาที
| # | ทำ | ผลที่ต้องเห็น |
|---|---|---|
| 1 | เปิดหน้า "สั่งผลิตเข้าร้าน" | ช่องค้นหาแทน dropdown ยาว |
| 2 | พิมพ์คำไทยบางส่วน (เช่น "ลาเต้") | รายการกรองทันที ไม่กระตุก ช่องพิมพ์ไม่หลุดโฟกัส |
| 3 | พิมพ์อังกฤษบางส่วน / SKU | เจอเหมือนกัน (ไม่สนตัวพิมพ์) |
| 4 | ↑ ↓ แล้ว Enter | เลือกได้ด้วยคีย์บอร์ดล้วน |
| 5 | พิมพ์มั่ว | empty state "ไม่พบ..." ชัดเจน |
| 6 | เลือกสูตร → ดู preview | ชื่อ/หน่วย/FG คงเหลือ/จำนวนวัตถุดิบ ก่อนยืนยันผลิต |
| 7 | สั่งผลิตจริง 1 รายการ | คำนวณ/ตัดสต๊อกเหมือนเดิมทุกประการ + สูตรที่เลือกไม่รีเซ็ตหลังผลิต (บั๊กเก่าที่แก้แถม) |
Regression เช็ค: ผลิตแล้วยอด FG และวัตถุดิบขยับเท่าเดิมกับก่อนหน้า

---

## Section C — Technical Approvals (อนุมัติแยกรายตัว)

### C1 · `c2ca6ee` — Webhook fail-closed
- **ปัญหา:** 3 endpoint (stripe/omise/omise-charge) ข้ามการตรวจลายเซ็นเมื่อไม่ตั้ง secret และ (Omise) เมื่อ header ลายเซ็นหายแม้ตั้ง secret แล้ว
- **แก้:** guard กลาง `webhook-guard.js` — prod: ไม่มี secret → 503, ลายเซ็นผิด/หาย → 401, ไม่มี mutation ก่อน verify; dev bypass ต้อง `NODE_ENV≠production` **และ** `ALLOW_UNVERIFIED_WEBHOOKS=1` (เช็ค prod ก่อน = flag เป็นหมันใน prod)
- **ไฟล์:** webhook-guard.js (ใหม่), stripe.js, omise.js, pay.js · **Tests:** 11 เคส HTTP+DB จริง · **Risk:** ต่ำ; ผลข้างเคียงเดียวคือ "ต้องตั้ง secret" (A2) · **Rollback:** `git revert c2ca6ee`
- [ ] อนุมัติ

### C2 · `d1df845` — PromptPay QR ในเครื่อง
- **ปัญหา:** ทุกครั้งที่เรนเดอร์บิล ส่งเบอร์พร้อมเพย์ร้าน + ยอดเงิน ไป `promptpay.io`
- **แก้:** ใช้ EMVCo generator ในไฟล์เดิม + lib ที่ vendor แล้ว — zero external call; mask เบอร์ใน log (โชว์เต็มบนใบเสร็จลูกค้าตามเดิม); snapshot vectors พิสูจน์ payload ตรงเดิม byte-for-byte
- **Tests:** 7 เคส · **Risk:** ต่ำมาก · **Rollback:** `git revert d1df845`
- [ ] อนุมัติ

### C3 · `4f994c9` — Vendor QR library
- **ปัญหา:** โหลด `qrcode-generator@1.4.4` จาก CDN ทุกครั้งบนหน้าจ่ายเงิน
- **แก้:** vendor ไฟล์จริงเข้าโปรเจกต์ (hash ตรวจกับ npm ต้นทางแล้วตรง `18ae399f…`) + เข้า `VERSIONED_ASSETS` + error ควบคุมภาษาไทยเมื่อโหลดพลาด ไม่มี remote fallback + `docs/vendored-dependencies.md`
- **Tests:** 7 เคส · **Risk:** ต่ำ · **Rollback:** `git revert 4f994c9`
- [ ] อนุมัติ

### C4 · `4fe45c0` — Menu.html PromptPay leak (พบโดย overnight verification) — branch `fix/menu-promptpay-leak`
- **ปัญหา:** หน้าเมนูออนไลน์ลูกค้า (`/menu/:token`) ยังยิง PromptPay ID + ยอด ไป promptpay.io **ทุกออเดอร์ prepay** — fix C2 ครอบเฉพาะ index.html เพราะ menu.html เป็นเพจแยก และเทสต์เดิมสแกนแค่ index.html (ช่องโหว่ของ audit เอง — อุดแล้ว: เทสต์สแกน menu.html ด้วย)
- **แก้:** mirror เทคนิคเดิม — EMVCo payload ในเครื่อง (พิสูจน์ byte-identical กับ generator ของ index.html 3 vectors) + vendored lib ผ่าน path สัมบูรณ์ + error ควบคุมภาษาไทย
- **Branch แยกตามกติกา** ต่อยอดจาก `4f994c9` (ใช้ vendored lib ร่วม) — merge หลัง/พร้อม hardening · **Tests:** 11/11, full suite 49/49 · **Rollback:** revert commit เดียว
- [ ] อนุมัติ

---

## Overnight results (S2 + S5)
- **Integration sim:** merge สามลำดับ **ไม่มี conflict เลย** · integrated 25 ไฟล์เทสต์ผ่านหมด + preflight PASS (WARN เดียว = fixture key ปลอมในเทสต์ webhook) · commits hardening revert สะอาดจาก integrated head
- **Claim verification:** 23/24 PASS ด้วยหลักฐาน test/บรรทัดโค้ด — ตัวที่ FAIL คือ menu.html (→ C4 ด้านบน)

## Section D — Architecture Only (ยังไม่ implement)

**Billing + Payment Platform Blueprint** (Parts A–F, 1,003 บรรทัด)
- **Accepted:** สถาปัตยกรรมทั้งหมด รวม Payment addendum (state machine แยก Confirm ≠ Paid, Static ≠ Dynamic QR, K SHOP adapter boundary, provider-neutral interface, PaymentIntent/Transaction/Refund/Receipt model, 10 กติกา security, reconciliation contracts)
- **ไม่ได้ implement แม้แต่บรรทัดเดียว** — เฟส 0–12 รอคำสั่ง
- **ห้ามเริ่มก่อนอนุมัติ:** Phase 6+ (payment schema), การ refactor Omise เข้า adapter, การถอน `status='paid'` ออกจาก confirm — ทั้งหมดคือ Founder gate
