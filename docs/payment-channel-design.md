# Payment Channel / Payment Destination Layer — Design (DO NOT IMPLEMENT YET)

> Founder correction 2026-07-20: single hard-coded PromptPay ≠ real store. ห้ามเริ่ม POS integration จนกว่าชั้น Payment Channel จะถูกออกแบบ/อนุมัติ
> สถานะ: **เอกสารออกแบบเท่านั้น** — ไม่มีโค้ด ไม่มี migration ไม่มีการแตะ PR #45–47 / production / Academy v1.1
>
> **REV 3 (Founder, 2026-07-20) — APPROVED WITH ONE REQUIRED CORRECTION → เริ่ม PC-1 (inert config layer) ได้:** ① `is_default` + `sort_order` ย้ายไป `payment_channel_shops` (default เป็นค่าระดับ channel–shop assignment: ช่องเดียวกันเป็น default ของนาคนิวาสแต่ไม่ใช่ของสะพานควายได้) ② ทุก channel สร้าง assignment row ให้ owner shop เสมอ ③ **ยกเลิก** กฎ implicit "สาขาเจ้าของใช้ได้โดยไม่มีแถว" — กฎเดียวทั้งระบบ: ใช้ได้เมื่อมี active assignment row `(channel_id, shop_id)` ④ **ตรึง snapshot/qr_version ตั้งแต่สร้าง payment intent** — QR เปลี่ยนระหว่าง intent ค้าง AWAITING_PAYMENT ต้องไม่สลับเงียบ ๆ, transaction ใช้ snapshot ที่ intent ตรึงไว้ ไม่อ่านค่าปัจจุบันตอน confirm · ข้อห้ามคงเดิม: no POS integration · no real provider · no state-machine change · no production change · แยกจาก Academy · no merge/deploy จนกว่ามีคำสั่งแยก
>
> **REV 2 (Founder design review, 2026-07-20) — แก้ตามคำสั่ง 4 จุด:** ① array `allowed_shop_ids[]` → ตารางความสัมพันธ์ `payment_channel_shops` ② snapshot ระบุ field ชัด 8 ตัว (ใบเสร็จปี 2026 ต้องตอบได้ตลอดไปว่าวันนั้นลูกค้าสแกนอะไร) ③ เพิ่ม `business_type` ④ เพิ่ม `is_default` — สถาปัตยกรรมหลัก (channel = config layer, ไม่แตะ state machine/allocation/intent · owner-only · legacy bridge · ไม่มีเลขบัญชีในโค้ด POS) ได้รับความเห็นชอบแล้ว

## Source of Truth vs Projection (Blueprint standard)
- **Source of truth:** `payment_channels` (นิยามช่องทาง/ปลายทางเงิน ณ ปัจจุบัน) · `payment_transactions.channel_id` + `channel_snapshot` (ความจริง ณ วินาทีที่เงินเข้า — immutable)
- **Projection:** ค่า masked ที่ส่งให้ frontend · รายการช่องทางที่ POS เห็นต่อสาขา (ผลจาก resolution rules) · ยอดต่อปลายทางในหน้า reconciliation
- แก้ channel ภายหลัง **ไม่มีผลย้อนหลัง** กับธุรกรรมเก่า (snapshot ตรึงไว้)

## 1. Data model ที่เสนอ

ตารางใหม่ 1 ตาราง `payment_channels`:

| คอลัมน์ | ชนิด | หมายเหตุ |
|---|---|---|
| id | uuid PK | |
| shop_id | uuid NOT NULL → shops | สาขาเจ้าของ (ผู้สร้าง) |
| display_name | text NOT NULL | เช่น "K SHOP — HIBI Company" |
| method | text CHECK | CASH · STATIC_QR · DYNAMIC_QR · BANK_TRANSFER · CARD · OTHER |
| provider_type | text CHECK | MANUAL · PROMPTPAY_STATIC · KASIKORN_KSHOP · MOCK_PROVIDER (+ค่าอนาคต OMISE ฯลฯ — CHECK แบบขยายได้) |
| verification_mode | text CHECK | MANUAL · PROVIDER_VERIFIED (คู่กับ provider_type: MANUAL-family บังคับ MANUAL) |
| account_holder_name | text | ชื่อบัญชี/ร้านค้า |
| bank_or_provider_name | text | เช่น กสิกรไทย / Omise |
| account_ref | text | เลขพร้อมเพย์/บัญชีเต็ม — **server-only ไม่เคยออก bootstrap** |
| account_ref_masked | text GENERATED/derived | เช่น 08x-xxx-5678 — ตัวเดียวที่ frontend เห็น |
| account_type | text CHECK | INDIVIDUAL · JURISTIC |
| business_type | text CHECK **(REV 2)** | PERSONAL · COMPANY · JURISTIC · PARTNER · TEMPORARY — เพื่อ report/accounting/commission แยกได้ว่าเงินเข้าบัญชีส่วนตัว/บริษัท/พาร์ทเนอร์ |
| qr_image_ref | text NULL | อ้างอิงรูป QR ที่ธนาคารออก (กลไก upload เดิมแบบ logo_url) — ไม่มี secret ในรูปโดยนิยาม (QR คือสิ่งที่ลูกค้าเห็นอยู่แล้ว) |
| qr_version | int NOT NULL default 1 **(REV 2)** | +1 ทุกครั้งที่ account_ref หรือ qr_image_ref เปลี่ยน — snapshot อ้างเวอร์ชันนี้ |
| is_active | boolean NOT NULL default true | |
*(REV 3: `is_default` และ `sort_order` **ไม่อยู่ที่ channel แล้ว** — ย้ายไป assignment table เพราะเป็นคุณสมบัติระดับ channel–สาขา · channel เก็บเฉพาะ presentation กลาง เช่น display_name)*

**ตารางความสัมพันธ์สาขา (REV 3 — assignment คือกฎเดียวของการใช้งาน):**
```
payment_channel_shops (
  channel_id uuid NOT NULL REFERENCES payment_channels(id) ON DELETE CASCADE,
  shop_id    uuid NOT NULL REFERENCES shops(id)            ON DELETE CASCADE,
  is_default boolean NOT NULL DEFAULT false,
  sort_order int     NOT NULL DEFAULT 0,
  added_by   uuid, added_at timestamptz DEFAULT now(),
  PRIMARY KEY (channel_id, shop_id)
);
CREATE UNIQUE INDEX uq_payment_channel_shop_default
  ON payment_channel_shops (shop_id) WHERE is_default = TRUE;   -- default 1 ตัวต่อสาขา บังคับใน DB จริง
CREATE INDEX idx_pcs_shop ON payment_channel_shops (shop_id);
```
กฎเดียวทั้งระบบ (REV 3): **ช่องทางใช้ได้ในสาขา ⇔ มี active assignment row `(channel_id, shop_id)`** — ไม่มี implicit rule · **สร้าง channel เมื่อไร ระบบสร้าง assignment row ให้ owner shop เสมอ** (ถอน owner shop ออกภายหลังได้แบบมี audit) · default/sort ทำงานเหมือนกันทุกสาขา · validate ตอนเขียน: actor ต้องเป็น owner ของ shop ที่เพิ่ม
| effective_from / effective_until | date / date NULL | |
| source | text | 'MANUAL_ADMIN' · 'LEGACY_SETTINGS' (ใช้กับ migration ข้อ 8) |
| created_by / created_at / updated_at | | |

**การผูกกับธุรกรรม (additive columns):**
- `payment_intents.channel_id uuid NULL → payment_channels` + **(REV 3) `channel_qr_version int` + `channel_snapshot jsonb` ตรึง ณ เวลาสร้าง intent** — ถ้า QR/บัญชีเปลี่ยนระหว่าง intent ค้าง AWAITING_PAYMENT: intent เดิมแสดง/บันทึกตามเวอร์ชันที่ตรึงไว้เท่านั้น ไม่สลับเงียบ ๆ · transaction คัดลอก snapshot จาก intent ไม่อ่านค่าปัจจุบันตอน confirm (กันเคส "ลูกค้าสแกนเวอร์ชันเก่า แต่ระบบบันทึกเวอร์ชันใหม่")
- `payment_transactions.channel_id uuid NULL` + `channel_snapshot jsonb` — **field บังคับ 8 ตัว (REV 2, Founder-specified):** `display_name` · `provider_type` · `verification_mode` · `merchant_name` (= account_holder_name) · `masked_account` · `bank_name` · `qr_version` · `effective_at` (เวลา capture) — หลักประกันว่าอีก 3 ปี QR/ชื่อบัญชี/ธนาคารเปลี่ยนไปแล้ว ใบเสร็จปี 2026 ยังตอบได้ว่าวันนั้นลูกค้าสแกนอะไร
- `payment_allocations.channel_id uuid NULL` (denormalize ตามคำสั่ง — reconciliation ระบุ "เงินก้อนนี้เข้าบัญชีบริษัทไหน" ได้จาก allocation ตรง ๆ)
- `payment_reconciliation_records.channel_id uuid NULL` (กระทบยอดแยกปลายทาง)

ไม่มี secret ใด ๆ ในตารางนี้ — provider secret (เช่น KBank/Omise) อยู่ env ฝั่งเซิร์ฟเวอร์เท่านั้น ตาราง channel เก็บแค่ "ชี้ไปที่ provider ไหน"

## 2. ต้องมี migration ใหม่ไหม → ต้องมี (additive ล้วน)
ไฟล์ใหม่ `schema-payment-channels.sql` ลงทะเบียน migrate.js: CREATE TABLE IF NOT EXISTS + ADD COLUMN IF NOT EXISTS 4 จุด · ไม่แตะ/ไม่ retype ของเดิม · แถวเก่า channel_id = NULL = "ก่อนมีระบบช่องทาง" (แสดงผลได้ ไม่ crash) · รันซ้ำ idempotent

## 3. ผลกระทบต่อ 9 ตารางเดิม
| ตาราง | ผลกระทบ |
|---|---|
| payment_intents | +channel_id (NULL ได้) — state machine **ไม่เปลี่ยน** |
| payment_transactions | +channel_id +channel_snapshot — invariant/uniqueness เดิมคงเดิม |
| payment_allocations | +channel_id — สูตร net = ไม่เปลี่ยน |
| payment_reconciliation_records | +channel_id (optional filter) |
| bill_items · bill_adjustments · receipts · payment_refunds · payment_provider_events | **ไม่แตะเลย** (refund สืบ channel ผ่านธุรกรรมแม่) |
สถานะ/การเปลี่ยนสถานะทั้ง 4 state machine ไม่ถูกแก้ — channel เป็น config มิติใหม่ ตั้งฉากกับ state

## 4. Admin configuration UX (หน้า "ตั้งค่า" → หัวข้อใหม่ "ช่องทางรับเงิน")
- ตารางรายการ: ชื่อ · วิธี · ผู้ให้บริการ · **ประเภทธุรกิจ (business_type)** · บัญชี(masked) · สาขาที่ใช้ · **ดาว default** · สถานะ · ลำดับ (ลาก) — แถวคลิกเปิด sheet แก้ไข · ตั้ง default ตัวใหม่ = ปลดตัวเก่าอัตโนมัติ (ยืนยันก่อน)
- Sheet เพิ่ม/แก้: ทุก field ตามข้อ 1 · เลือก provider_type แล้วฟอร์มปรับตาม (PROMPTPAY_STATIC → ช่องเลขพร้อมเพย์+validate เบอร์/ปชช./นิติบุคคล 13 หลัก · KASIKORN_KSHOP/ธนาคารอื่น → upload รูป QR + ชื่อบัญชี · MOCK/DYNAMIC → เลือก provider ที่ระบบรู้จัก ไม่มีช่อง key)
- ปุ่ม "ปิดใช้งาน" (soft) — **ไม่มี delete จริง** เพราะธุรกรรมเก่าอ้างอยู่
- ช่อง "เบอร์พร้อมเพย์" เดิมในตั้งค่า: คงไว้เป็น bridge — แก้แล้ว sync เข้า channel ที่ source='LEGACY_SETTINGS' (จนกว่า POS integration phase จะเลิกอ่าน settings.pp)

## 5. POS payment-selection UX (เป้าหมาย — ยังไม่ทำจนกว่าจะอนุมัติ implement)
- แคชเชียร์กด "รับเงิน" → เลือกวิธี: เงินสด | QR/โอน | บัตร(อนาคต)
- กด QR/โอน → sheet รายการ**เฉพาะ channel ที่ active + ถึงช่วง effective + สาขานี้ได้รับอนุญาต** เรียงตาม sort_order เช่น: `K SHOP — HIBI Company` · `พร้อมเพย์นิติบุคคล` · `QR สำรอง` · `Dynamic QR (mock)` — แต่ละแถวโชว์ชื่อบัญชี + masked + badge "ยืนยันเอง"/"ยืนยันอัตโนมัติ"
- **(REV 2)** ระบบเด้ง channel ที่ `is_default` ขึ้นก่อนทันที (ไม่ต้องเลือกทุกครั้ง) — พนักงานกด "เปลี่ยนช่องทาง" เพื่อเลือกตัวอื่นได้เสมอ · มี channel เดียว → ข้าม chooser อัตโนมัติ
- STATIC/MANUAL → แสดงชื่อบัญชี + QR (รูปที่อัปโหลด หรือ EMVCo ที่ server generate จาก account_ref ต่อยอดบิล) → พนักงานกด "รับเงินแล้ว" → transaction: channel_id + snapshot + **provider_verified=false**
- DYNAMIC → สร้าง intent ผูก channel → pending จน webhook ที่ลายเซ็นถูกต้อง → **provider_verified=true เท่านั้น**
- payload/รูป QR ดึงผ่าน endpoint ที่ gate ด้วยสิทธิ์ ณ เวลาขาย — **ไม่มีเบอร์/เลขบัญชี/QR hard-code ในโค้ด POS**

## 6. Branch-level availability (REV 3 — กฎเดียว: assignment row)
- นิยาม: "สาขา" = แถว `shops` (โมเดลปัจจุบัน ยืนยันจาก branches.js/memberships)
- Rule เดียวทั้งระบบ ต่อสาขา X: `EXISTS (SELECT 1 FROM payment_channel_shops pcs WHERE pcs.channel_id = c.id AND pcs.shop_id = X) AND c.is_active AND วันนี้อยู่ในช่วง effective` — **ไม่มีข้อยกเว้น owner shop** (owner shop ได้ assignment row อัตโนมัติตอนสร้าง channel)
- **บังคับฝั่งเซิร์ฟเวอร์** ตอนสร้าง intent/confirm (`CHANNEL_NOT_ALLOWED_FOR_SHOP` 403) — UI filter เป็นแค่ความสะดวก
- เพิ่ม/ถอดสาขา = INSERT/DELETE แถวใน `payment_channel_shops` → audit log ต่อแถว (actor + channel + shop) — ถอดจาก owner shop ก็ทำได้แบบมี audit เช่นกัน · server ตรวจว่า actor เป็น owner ของ shop ที่เพิ่ม (กันชี้ข้าม tenant)
- **Default ต่อสาขา (REV 3):** POS ของสาขา X auto-เลือกแถว assignment ที่ `is_default=true` ของสาขา X — DB บังคับ 1 ตัวต่อสาขาด้วย `uq_payment_channel_shop_default` · ไม่มี default → ตัวแรกตาม `sort_order` ของสาขานั้น · พนักงานเปลี่ยนได้เสมอ · ช่องเดียวกันจึงเป็น default ของบางสาขาและไม่ใช่ของสาขาอื่นได้ตามที่ Founder ระบุ

## 7. Audit + permissions
- คีย์ใหม่ 2 ตัว: `payment_channel_manage` — **owner-only (เข้า MANAGER_EXCLUDE)** เพราะคือการชี้ปลายทางเงินบริษัท = ชั้นความไวเดียวกับ refund_approve · `payment_channel_view` รวมอยู่กับสิทธิ์ขายปกติ (เห็นเฉพาะ masked)
- Audit ทุกการเปลี่ยน config ผ่านตาราง `logs` เดิม (pattern เดียวกับ P1): `payment_channel.create/update/deactivate` + actor + old/new snapshot (masked ใน log) — ส่วน**ธุรกรรม**ใช้ channel_snapshot บนแถวธุรกรรมเป็นหลักฐานถาวรอยู่แล้ว
- Frontend ไม่เคยได้รับ account_ref เต็ม/secret ใด ๆ (bootstrap ส่งเฉพาะ masked)

## 8. Migration ของ Static QR เดิม (hard-coded demo)
1. Migration script สร้าง channel อัตโนมัติให้ทุก shop ที่ `shop_settings.promptpay` ไม่ว่าง: `display_name='QR พร้อมเพย์ร้าน'` · method=STATIC_QR · provider=PROMPTPAY_STATIC · verification=MANUAL · account_ref=ค่าที่มี · source='LEGACY_SETTINGS' · active · sort 0 — **idempotent** (มีอยู่แล้ว → ข้าม)
2. ธุรกรรม demo เก่า (channel_id NULL) คงไว้ตามจริง — dashboard โชว์ "—(ก่อนมีระบบช่องทาง)"
3. seeder/demo console อัปเดตให้สร้าง channel demo (ชื่อปลอม ไม่มีเลขบัญชีจริง — ตามข้อห้าม)
4. `showQrReceive` legacy ยังอ่าน `settings.pp` ต่อไป **ไม่เปลี่ยนพฤติกรรมใด ๆ** จนกว่า PC-3 (POS integration) จะได้ไฟเขียวแยก

## 9. Test scenarios (ชุดบังคับเมื่อได้ implement)
1. สร้าง/แก้/ปิด channel → audit log ครบ actor/old/new
2. staff/manager เรียก manage API → 403 · owner → สำเร็จ
3. bootstrap ไม่มี account_ref เต็มแม้เป็น owner (source-scan + runtime)
4. สาขาที่ไม่อยู่ใน allowed_shop_ids สร้าง intent ด้วย channel นั้น → 403 + ไม่มีแถวเกิด
5. channel inactive/หมด effective → intent ถูกปฏิเสธ
6. static confirm → transaction มี channel_id + snapshot ครบ + provider_verified=false
7. dynamic + webhook ลายเซ็นถูก → provider_verified=true + channel_id เดิมคงอยู่
8. allocation row มี channel_id ตรงกับ transaction เสมอ (รวม refund allocation)
9. แก้ display_name หลังจ่าย → snapshot ธุรกรรมเก่าไม่เปลี่ยน
10. reconciliation query รวมยอดต่อ channel ถูกต้อง (หลายช่องทางในบิลเดียว = mixed)
11. migration LEGACY_SETTINGS รัน 2 รอบ = แถวเดียว
12. ร้านไม่มี channel เลย → POS ตกกลับพฤติกรรม legacy เดิม (ไม่ block การขาย)
13. sort_order/single-channel auto-select ทำงานตามสเปก
14. flag OFF → ทุก endpoint channel 503 + G2 menu byte-identical คงเดิม
15. concurrency: ปิด channel พร้อมกับ confirm ที่ค้างอยู่ → confirm สำเร็จด้วย snapshot (ไม่ crash), intent ใหม่ถูกปฏิเสธ
16. **(REV 3)** default ระดับ assignment: ตั้ง default ตัวที่สองในสาขาเดียว → DB ปฏิเสธ (partial unique) เว้นแต่ API ปลดตัวเก่าใน tx เดียว · ช่องเดียวกัน default ที่สาขา A แต่ไม่ใช่ที่สาขา B ได้
17. **(REV 2)** snapshot มีครบ 8 field ตามสเปกทุกธุรกรรม (test ตรวจ shape ตรง ๆ)
18. **(REV 3)** ตรึงที่ intent: สร้าง intent (qr_version=1) → แก้บัญชี/QR (version 2 + audit ก่อน–หลัง) → confirm intent เดิม → transaction snapshot = **เวอร์ชัน 1 ที่ตรึงไว้** ไม่ใช่ 2 · intent ใหม่หลังแก้ = เวอร์ชัน 2
19. **(REV 2)** เพิ่ม/ถอดสาขาใน payment_channel_shops → audit row ต่อการเปลี่ยน + สาขาที่ถูกถอดสร้าง intent ต่อไม่ได้ทันที (รวมกรณีถอด owner shop เอง)
20. **(REV 2)** business_type บังคับเลือกตอนสร้าง + report รวมยอดแยก business_type ถูกต้อง
21. **(REV 3)** สร้าง channel → assignment row ของ owner shop เกิดอัตโนมัติเสมอ (และไม่มี code path ไหนอนุญาตใช้ channel โดยไม่มีแถว)

## 10. Phased implementation plan
- **PC-1** schema + channel CRUD API + admin UI + migration ข้อ 8 (inert — ยังไม่มีใครอ่าน channel ตอนขาย) → PR แยก, flag เดิม
- **PC-2** ผูก platform: intents/transactions/allocations รับ channel_id + demo console เลือก channel + dashboard เพิ่มคอลัมน์ "ปลายทางเงิน"
- **PC-3** POS integration จริง (แทน showQrReceive ด้วย chooser ข้อ 5) — **Founder browser test เป็น gate ของเฟสนี้โดยเฉพาะ**
- **PC-4** reconciliation-by-destination + KASIKORN_KSHOP dynamic adapter (หลังได้คำตอบจาก KBank) + provider จริง (หลัง 2 Founder decisions: rounding + provider)
- ทุกเฟส: PR เดี่ยว additive · tests + preflight · revert ได้เดี่ยว ๆ · ตำแหน่ง stack: ต่อจาก PR #47 (เป็น PR D) หรือหลัง merge A–C — แนะนำหลัง merge เพื่อไม่ให้ stack ลึกเกิน

## 11. Effective-Window Policy (Founder-required clarification, PR D)
- `effective_from` / `effective_until` ถูกตรวจ ณ **จุดที่ payment intent ใหม่เลือก channel** (และที่ GET รายการช่องทางสำหรับ POS/admin) เท่านั้น
- เมื่อ intent ที่ถูกต้องได้ **ตรึง channel version + snapshot ไปแล้ว**: การหมดอายุ / ปิดใช้งาน / ถอด assignment / แก้ config ของ channel ที่เกิด**ภายหลัง** ต้อง**ไม่**ทำให้การยืนยัน (confirmation) โดยชอบของ intent ที่สร้างไว้แล้วเป็นโมฆะ
- การยืนยันใช้ **snapshot ที่ตรึงบน intent** เสมอ — ไม่อ่านสถานะปัจจุบันของ channel ตอน confirm
- ⚠️ ตัว logic การผูก intent + พฤติกรรม confirm ตาม policy นี้ = **ขอบเขต PC-2** — PR D (PC-1) มีเพียง schema columns รองรับ (`channel_id`, `channel_qr_version`, `channel_snapshot` ยัง NULL ทั้งหมด) และห้าม implement ใน PR D

## 12. Soft-Delete & Historical-Integrity Policy (Founder-required clarification, PR D)
- "ลบ" channel = ตั้ง `is_active = false` (soft) เท่านั้น → หายจากตัวเลือก POS/การชำระใหม่ทันที
- อ้างอิงประวัติศาสตร์ทั้งหมด — snapshots, transactions, allocations, reconciliation records — ต้อง**ยัง query ได้ตลอดไป**
- **ไม่มี runtime API ใด hard-delete `payment_channels` ได้** (PC-1 ไม่มี DELETE endpoint — ตรวจแล้ว) · ห้าม physical delete ตราบใดที่มี historical reference (เครื่องมือ dev local-only เช่น cleanup-payment-demo.js อยู่นอก runtime API และลบทั้งร้าน demo เท่านั้น)

## Scalability & SaaS Readiness (ย่อตามมาตรฐาน blueprint)
per-tenant rows ล้วน (ไม่มี config global) · index `(shop_id, is_active, sort_order)` + `payment_channel_shops` PK สองคอลัมน์ + index (shop_id) — join ตรง ไม่มี array scan · ไม่มี secret ในตาราง → ไม่มี re-encryption story · masked เป็น projection คำนวณได้เสมอ · channel soft-delete รักษา referential integrity ระยะยาว · เพิ่ม provider ใหม่ = เพิ่มค่า enum + adapter ฝั่ง registry เดิม (ไม่แตะ schema) · รองรับอนาคต company-layer: ถ้าวันหนึ่งมีตาราง company เหนือ shops ค่อยย้าย ownership โดย allowed_shop_ids ยังใช้ได้เดิม
