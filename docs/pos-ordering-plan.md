# POS Menu + Options + Customer QR Order — Review & Plan

> review/plan เท่านั้น — ยังไม่แก้โค้ด · เน้น **หน้าร้านใช้ง่าย** · ต่อยอดจากของที่มี · additive
> ต่อจาก Item Master + engine ตัดสต๊อกตามหมวด `/api/pos/sell` (P3)

## สถานะปัจจุบัน (สำคัญ)
- **Options engine สร้างครบแล้ว แต่ทำงานฝั่ง client เท่านั้น**:
  - `option_groups` (single/multi, required, min/max) · `option_choices` (price_add, effect_type NONE/ADD/REPLACE/QUANTITY/RECIPE_VARIANT, max_qty, target_role, variant_recipe_id) · `option_choice_links` (choice→material+amount = ตัดสต๊อก) · `recipe_option_groups`
  - `resolveLineBOM()` ฝั่ง frontend คำนวณ effectiveBom + price_add + lineCost ถูกแล้ว
  - **ช่องโหว่:** `/api/stock/sale` (และ posCheckout) ตัดสต๊อก option ฝั่ง client เท่านั้น — server ไม่ตรวจ/ไม่ตัด option-linked materials, ไม่เก็บ COGS ของ option ในบิล
- **รูปเมนู:** `recipes.img_data` มีแล้ว · **materials ยังไม่มีรูป**
- **ลูกค้าสั่งเอง:** ยังไม่มี public menu / QR / orders / one-off payment

## M1 — เลือกสินค้าขึ้น POS + รูป
- เพิ่ม `materials.img_data text` (+ `img_updated_at`) — reuse pattern อัปรูปของ recipes
- POS grid โชว์รูป materials (เมนูที่มาจากวัตถุดิบขายตรง) · ใช้ `show_in_pos` + `sale_type='SELLABLE'` + filter หมวดเดิม
- `/api/sync` แค่เพิ่ม img_data ใน upsert ของ materials (เดิมมีแต่ recipes) — เล็ก
- ตัดสต๊อกใช้ engine `/api/pos/sell` (P3) ที่ทำไว้

## M2 — Options 2 แบบ (ตัดสต๊อก+ต้นทุนจริง)
**(ก) +เงิน (add-on)** เช่น ห่อของขวัญ, เพิ่มช็อต:
- `option_choices.price_add > 0` + `effect_type='ADD'` + `option_choice_links` (วัตถุดิบ+amount ที่ตัด)
- server ตัดสต๊อก + บวก COGS จริง

**(ข) ไม่+เงิน (แค่ระบุ)** เช่น ไม่รับซอส/รับซอส, ทานที่นี่/กลับบ้าน:
- เพิ่มคอลัมน์ `option_choices.is_metadata_only boolean default false` (NEW)
- price_add=0, ไม่มี links → server ข้ามตอนตัดสต๊อก · ใช้แค่โชว์/หมายเหตุออเดอร์

**ขนาดแก้ว (size variant):** `effect_type='REPLACE'/'QUANTITY'` + `target_role` + links (สลับแก้ว 12oz→16oz เปลี่ยนทั้งราคา+สต๊อก)

**สิ่งที่ต้องทำ (gap):** ขยาย `/api/pos/sell` ให้รับ `chosen_options:[{choice_id, qty}]` แล้ว **resolve BOM ฝั่ง server** (ย้าย logic จาก resolveLineBOM มา validate+ตัด atomic) + เก็บ COGS/options ในบิล · UI ทำป้าย "เพื่อข้อมูล" สีจางสำหรับ no-price

## M3 — อัลบั้มเมนู QR ให้ลูกค้าสั่งเอง (ใหญ่สุด — pickup ก่อน)
Flow ง่ายสุด:
1. ร้านเปิด public menu → สร้าง `shop_settings.public_menu_token` (+ `public_menu_enabled`) → **QR** ชี้ `/menu/{token}`
2. ลูกค้าเปิด (ไม่ต้อง login): `GET /api/public/menu/{token}` → เมนู+รูป+options
3. กดใส่ตะกร้า (localStorage) → checkout: ชื่อ/เบอร์/เวลา-รับ/วิธีจ่าย
4. `POST /api/public/order/{token}` → สร้าง order (validate สต๊อก) → ได้ **คิว** หรือไป**จ่ายออนไลน์**
5. จ่ายออนไลน์: reuse Stripe/Omise (one-off charge) → webhook → order paid
6. ร้านเห็นแท็บ **"คิว"** → กด "พร้อมรับ" · ลูกค้าเช็คสถานะผ่านลิงก์

**ตารางใหม่:** `orders(id, shop_id, order_no, customer_name/phone/email, items_json, total, payment_method, payment_status, order_status, queue_number, pickup_datetime, ...)`
**reuse:** เมนู/options/รูปจาก bootstrap · `/api/pos/sell` ตัดสต๊อกออเดอร์ลูกค้า · stripe/omise (ต่อ one-off)

### เลื่อนไป M3.2 (sub-phase)
ส่งเดลิเวอรี่ (ที่อยู่/ขนส่ง — reuse `shipments`/`label_templates` ที่มี) · แจ้งเตือน SMS/email · real-time queue

## ลำดับแนะนำ
**M1 (เมนู+รูป) → M2 (options server-side) → M3 (ลูกค้า QR, pickup) → M3.2 (delivery/แจ้งเตือน)**

## คำถามที่ต้องเคาะ (ตอนถึงเฟส)
1. M3 public menu: subdomain ต่อร้าน หรือ path `/menu/{token}` บนโดเมนเดียว? — แนะนำ path (ง่าย)
2. จ่ายออนไลน์ลูกค้า: เปิดทั้ง Stripe+Omise หรือ Omise/PromptPay ก่อน (ไทย)?
3. คิว: นับรีเซ็ตรายวัน · ต้องมีจอแสดงคิวหน้าร้านไหม (หรือดูในแอป)?
4. ลูกค้าต้องจ่ายก่อนรับ หรือจองคิวจ่ายทีหลังได้?
