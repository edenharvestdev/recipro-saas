# Recipro — Roadmap รวม (Master Plan)

> หลัก: **deploy ของที่ build เสร็จก่อน (หลัง backup DB) → แล้วค่อยเริ่มเฟสใหม่** · ทุกอย่าง additive ไม่แตะสต๊อกร้านเดิม
> เอกสารแผนย่อย: `docs/inventory-redesign.md` · `docs/accounting-plan.md` · (pos-ordering กำลังสรุป)

## 🟢 กลุ่ม 1 — แกน Inventory/POS (build แล้ว — รอ backup + deploy)
| เฟส | งาน | สถานะ |
|---|---|---|
| P0 | Item Master + 8 หมวด | ✅ **live** |
| P1 | จัดหมวดสินค้า (dropdown) | ✅ **live** |
| P2 | เมนู + ต้นทุนสด + bridge | ✅ **live** |
| P3 | ตัดสต๊อกตามหมวด `/api/pos/sell` | 🧪 branch `feat/p3-pos-deduction` (ทดสอบแล้ว) |
| P4 | ปริ้นป้ายราคา | 🧪 branch `feat/p4-label-print` |
| P5 | เตือนสั่งของ `/api/alerts/reorder` | 🧪 branch `feat/p5-reorder-alerts` |

**ก้าวถัดไปทันที (gate):** ① backup DB (Railway dashboard/`backup-db.ps1`) → ② merge P3–P5 → `railway up` → ③ verify live → ④ ต่อหน้า POS เรียก `/api/pos/sell` (ปิดงาน P3 ฝั่ง frontend)

## 🟡 กลุ่ม 2 — ระบบบัญชี (วางแผนแล้ว — `docs/accounting-plan.md`)
| เฟส | งาน |
|---|---|
| A1 | รายจ่ายประจำ (ล็อกเทมเพลต + แก้ตัวเลข + เตือนรายเดือน) |
| A2 | เงินสดย่อย (เติม/คงเหลือ/เตือน · เปิดปิดได้) |
| A3 | แนบสลิป + ส่งออกภาษี |
| A4 | บิล delivery ค้างรับ (ระบุ platform + ตัดสต๊อกตอนออกบิล) |
| A5 | reconcile รายวัน (กรอกเงินเข้าจริง → ค่าหักก้อนเดียว → กำไร) |
| A6 | เมลเตือนกรอกยอด delivery |

## 🟠 กลุ่ม 3 — POS experience + ลูกค้าสั่งเอง (ออกแบบเสร็จ — `docs/pos-ordering-plan.md`)
> หัวใจ: **options engine สร้างครบแล้ว** (price_add + ผูกวัตถุดิบ) แค่ทำงานฝั่ง client — ต้องย้ายมา server
| เฟส | งาน |
|---|---|
| M1 | เลือกสินค้าขึ้น POS ง่าย + ใส่รูปต่อเมนู (เพิ่ม `materials.img_data`) |
| M2 | Options 2 แบบ: (+เงิน ตัดสต๊อก+ต้นทุน) / (ไม่+เงิน `is_metadata_only`) — ขยาย `/api/pos/sell` ให้รู้ options |
| M3 | เมนู QR → ลูกค้าสั่งเอง → ตะกร้า → คิว/จ่ายออนไลน์ (ตาราง `orders` + reuse stripe/omise · pickup ก่อน) |
| M3.2 | (เลื่อน) เดลิเวอรี่ + แจ้งเตือน SMS/email |

## 📋 ลำดับแนะนำ (หลัง deploy กลุ่ม 1)
1. **ปิด P3** (ต่อ POS frontend → `/api/pos/sell`) — ทำให้แกนตัดสต๊อกครบ
2. **M1** เมนู+รูป → **M2** options — ทำ POS ให้สมบูรณ์/สวย
3. **A1–A3** บัญชีพื้นฐาน (quick win, อิสระ ทำแทรกได้)
4. **A4–A6** delivery (ต้องมี POS sell engine + บัญชีก่อน)
5. **M3** ลูกค้าสั่งเอง QR (ใหญ่สุด — ทำท้าย)

## 🔒 กฎประจำทุกเฟส
- backup DB ก่อน deploy ทุกครั้ง · build+test local บน branch → merge → `railway up` → verify
- additive/idempotent · ไม่แตะค่าสต๊อกร้านที่ลงข้อมูลแล้ว · เปิด/ปิดโมดูลได้ (ร้านเล็กไม่ต้องใช้ครบ)
- `gh auth switch --user edenharvestdev` ก่อน push เสมอ
