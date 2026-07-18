# Availability Policy — Implementation Plan + Acceptance-Test Matrix

> **สถานะ: สถาปัตยกรรมอนุมัติแล้ว (Founder, 2026-07-19) — ห้ามเริ่มโค้ดจนกว่า P1 จะผ่าน Production Founder Acceptance.**
> เอกสารนี้คือแผนและเมทริกซ์เทสต์เท่านั้น · โมเดลเต็ม: `availability-policy-design.md`

## อนุมัติแล้ว (บันทึกคำตัดสิน)
- โมเดล 3 แกน: A Selling State (AVAILABLE / TEMPORARILY_UNAVAILABLE) · B Stock Decision (FOLLOW_STOCK_POLICY / MANAGER_OVERRIDE_ALLOW / MANAGER_OVERRIDE_BLOCK) · C Safety Block (NONE / ADMIN_BLOCKED)
- Precedence: ADMIN_BLOCKED → block เสมอ · TEMPORARILY_UNAVAILABLE → block · MANAGER_OVERRIDE_BLOCK → block · MANAGER_OVERRIDE_ALLOW → ขายได้ + คง stock warning ให้เห็น · FOLLOW_STOCK_POLICY → พฤติกรรมสต๊อกเดิม
- Migration: แถวเดิมคงพฤติกรรมเดิม · ไม่มีเมนูขายได้เพิ่มเพราะ migration · default = FOLLOW_STOCK_POLICY + admin_blocked=false · ห้าม mutate สต๊อก/สูตร/วัตถุดิบ
- สิทธิ์: `pos_stock_override` = Manager ขึ้นไป · `pos_admin_block` = Owner/Admin เท่านั้น · แคชเชียร์ข้าม admin block ไม่ได้

## Implementation Plan (เมื่อได้รับไฟเขียวหลัง P1 acceptance)

**Increment AV-1 — schema + plumbing (inert)**
`schema-availability-policy.sql`: `pos_stock_decision text not null default 'FOLLOW_STOCK_POLICY'` + `pos_stock_decision_reason text` + `pos_admin_blocked boolean not null default false` + `pos_admin_blocked_reason text` บน recipes+materials · ลงทะเบียน migrate.js · ผ่าน sync payload builder + sync.js whitelist (พร้อม coercion กัน NOT NULL แบบบทเรียน P1) + bootstrap mapper + clone.js ทุก INSERT · ยังไม่มี UI = พฤติกรรมไม่เปลี่ยนใด ๆ

**Increment AV-2 — คีย์สิทธิ์ + server enforcement**
เพิ่ม `pos_stock_override` (รวมใน preset manager) และ `pos_admin_block` (owner-tier, ไม่อยู่ใน preset ใด) ใน permissions catalog · ขยาย sync-guard: เปลี่ยน stock_decision โดยไม่มีสิทธิ์ → 403; เปลี่ยน admin_blocked โดยไม่ใช่ owner → 403 · audit rows `menu.stock_decision_change` / `menu.admin_block_change` (actor/old/new/reason)

**Increment AV-3 — resolution กลาง + UI**
ฟังก์ชันเดียว `posResolveSellable(item)` คืน {sellable, warning, state} ตาม precedence — ทุกจุดขาย (แตะการ์ด, addToCart, addMatToCart, barcode) เรียกตัวนี้แทน logic กระจาย · UI: 3 หน้าตาแยกชัด (ริบบิ้น TEMP_UNAVAILABLE ของ P1 เดิม / badge OVERRIDE_BLOCK / กุญแจ ADMIN_BLOCKED) + MANAGER_OVERRIDE_ALLOW แสดง warning สต๊อกค้างไว้เสมอ · sheet ตั้งค่า stock decision (มี reason)

**Increment AV-4 — เก็บงานขอบ**
delivery/QR menu paths อ่าน resolution เดียวกันเท่าที่เกี่ยว (อย่างน้อย: ไม่ขัดกัน) · เอกสาร + walkthrough

แต่ละ increment: PR แยก, additive, ทดสอบเต็ม, preflight, revert เดี่ยวได้ · จุดเสี่ยงที่ต้องจำจาก P1: NOT NULL + client เก่า ⇒ ต้อง coerce ฝั่ง server ตั้งแต่ AV-1

## Acceptance-Test Matrix

Legend: FG = finished_goods recipe (มี server hard-block เดิม) · MTO = make_to_order/material (block ฝั่ง client เท่านั้น — ข้อค้นพบ audit)

| # | A Selling | B Stock decision | C Admin | สต๊อกจริง | คาดหวัง: ขายได้? | Warning? | หมายเหตุ |
|---|---|---|---|---|---|---|---|
| 1 | AVAILABLE | FOLLOW | NONE | มีของ | ✅ | – | พฤติกรรมเดิม |
| 2 | AVAILABLE | FOLLOW | NONE | FG หมด | ❌ (409 เดิม) | แสดงหมด | พฤติกรรมเดิมเป๊ะ |
| 3 | AVAILABLE | FOLLOW | NONE | MTO หมด | ตาม client เดิม | แสดงหมด | ไม่เปลี่ยนจากปัจจุบัน |
| 4 | AVAILABLE | OVERRIDE_ALLOW | NONE | FG หมด | ✅ | **ต้องยังแสดง warning** | หัวใจของฟีเจอร์ |
| 5 | AVAILABLE | OVERRIDE_ALLOW | NONE | มีของ | ✅ | – | override ไม่มีผลลบ |
| 6 | AVAILABLE | OVERRIDE_BLOCK | NONE | มีของ | ❌ | – | ปิดทั้งที่มีของ |
| 7 | TEMP_UNAVAILABLE | OVERRIDE_ALLOW | NONE | มีของ | ❌ | – | A ชนะ B ตาม precedence |
| 8 | AVAILABLE | OVERRIDE_ALLOW | **ADMIN_BLOCKED** | มีของ | ❌ | – | C ชนะทุกอย่าง |
| 9 | TEMP_UNAVAILABLE | FOLLOW | ADMIN_BLOCKED | หมด | ❌ | – | ซ้อนกันก็ยัง block |
| 10 | — migration — | default ทุกแถวเดิม | default | ใด ๆ | เท่าเดิมทุกตัว | เท่าเดิม | diff พฤติกรรม ก่อน/หลัง migrate = ว่าง |
| 11 | — barcode — | ตาม 4,6,7,8 | | | ผลเท่าการแตะการ์ดทุกกรณี | | ห้ามมีทางลัด |
| 12 | — permission — | cashier ตั้ง OVERRIDE_* | | | 403 + แถวไม่เปลี่ยน | | server-side |
| 13 | — permission — | manager ตั้ง ADMIN_BLOCKED | | | 403 | | owner-only |
| 14 | — permission — | manager แก้ item ที่ ADMIN_BLOCKED เป็น allow | | | 403 / ไม่มีผล | | ข้ามไม่ได้ทุกทาง |
| 15 | — audit — | ทุกการเปลี่ยน B/C | | | logs row ครบ actor/old/new/reason | | |
| 16 | — persistence — | ตั้ง 4,6,8 → reload + เครื่องที่สอง | | | สถานะคงเดิม | | round-trip จริง |
| 17 | — legacy resave — | แถว default โหลด+เซฟซ้ำ | | | ไม่ flip, ไม่ถูก disable | | บทเรียน P1 |
| 18 | — no stock mutation — | ทุก action ข้างบน | | | stock/qty ไม่ขยับแม้แต่หน่วยเดียว | | movement log ว่าง |
| 19 | — rollback — | revert AV-3..1 ตามลำดับ | | | ระบบกลับพฤติกรรมเดิม, คอลัมน์ inert | | |
| 20 | — clone — | clone ร้านที่มี override/block | | | ค่าตามไปครบ ไม่ silently reset | | บทเรียน clone.js |
