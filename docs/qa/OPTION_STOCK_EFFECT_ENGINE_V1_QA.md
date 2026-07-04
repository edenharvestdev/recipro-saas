# Option Stock Effect Engine V1 — QA (manual test cases)

Prereqs: local/staging only (never production). `OPTION_STOCK_ENGINE_V1` unset/false. Owner session.
Open ตัวเลือกสินค้า & กลุ่มตัวเลือก → edit a group → a **saved** choice → "⚙️ ผลกระทบต่อสต๊อก (หลายรายการ)".

Automated coverage: `test/option-engine.test.js` (20), `test/option-normalize.test.js` (18),
`test/option-effects.test.js` (29).

## 1. Cool Pack (multi ADD)
Choice "Cool Pack" on base "Clear Matcha". Add effects:
- ADD RECIPE_COMPONENT "Clear Matcha" × 1 (or keep base) · ADD PACKAGING "Ice Cup" × 1 · ADD PACKAGING
  "Lid" × 1 · ADD PACKAGING "Bag" × 1.
Expect: preview lists each ADD with target name + code + qty; save each row → "✅ บันทึกแล้ว".

## 2. Matcha Cloud (produced + packaging)
- ADD PRODUCED_ITEM "Matcha Cloud" × 1 · ADD PACKAGING "Dome Lid" × 1. Expect both in preview.

## 3. Milk replacement (REPLACE)
- REPLACE MATERIAL: *จากเดิม* "Fresh Milk" → *เป็น* "Oat Milk", 150 ml. Expect preview: "REPLACE …
  จาก Fresh Milk → Oat Milk 150 ml". Missing "to" → ⛔ "กรุณาเลือกรายการที่จะใส่แทน".

## 4. No syrup (REMOVE)
- REMOVE MATERIAL "Syrup". Expect preview shows REMOVE Syrup; base retains other ingredients.

## 5. NO_STOCK
- Action NO_STOCK + Target Type NO_STOCK → target/qty fields hidden, note field only. Preview: "NO_STOCK
  — ไม่มีผลต่อสต๊อก".

## 6. Legacy binding
- On a choice that still has a legacy single-effect binding (`effect_type≠NONE`), the modal shows the
  amber "Legacy Binding" panel (read-only), equivalent note, no auto-convert button, and does not
  double-apply.

## 7. Thai + English + SKU search (combobox)
Type in the target combobox and confirm results:
`นม` → milk materials · `น้ำ` / `น้ำมะพร้าว` · `มัทฉะ` · `ไซรัป` · `matcha` / `MATCHA` · `Kagoshima` ·
`HBR01` / `HBM01` (recipe codes) · `MILK-01` (sku) · a middle-of-name fragment. All should match;
empty query lists the first N; a nonsense query → "ไม่พบรายการ".

## 8. Permission blocked
- As staff **without** `recipe_edit`: opening the modal loads (recipe_view) but Save → toast
  "สิทธิ์ไม่เพียงพอ" (403); create/update/disable/reorder all blocked server-side.
- As a **different shop's** owner: `/option-effects?choice_id=<other shop>` → 404 "ไม่พบตัวเลือกในร้านนี้".

## 9. Cross-shop / invalid target
- Pick nothing then save → ⛔ "กรุณาเลือกรายการที่จะตัดสต๊อก". A target from another shop (not reachable
  via search) → "รายการนี้ไม่อยู่ในร้านปัจจุบัน". A recipe that contains the parent → "สูตรซ้อนกันเป็นวงจร".

## 10. Reorder / disable
- Duplicate a row, reorder, save; disable a row → it greys out but is retained (soft-disable, history kept).

## 11. Engine OFF guarantee
- Footer shows "ยังไม่ตัดสต๊อกจริง จนกว่าจะเปิดใช้เอนจิน". Sell the base menu on POS → **no** change to
  deduction vs before (engine flag false; legacy path unchanged).

## Viewports
Modal fits + no horizontal overflow at 1366×768 / 1280×800 / 1024×768 / **1024×600** (SUNMI). No console
errors.
