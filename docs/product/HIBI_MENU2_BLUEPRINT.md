# HIBI MENU2 BLUEPRINT — Founder Source Document

> **Status:** BLANK TEMPLATE — awaiting Founder source materials.
> **Owner:** Founder. This document is the business Source of Truth for MENU2.
> It is NOT generated from existing code. No section may be populated by inspecting,
> reverse-engineering, or inferring from the current POS implementation.
> Each section is FROZEN only after an explicit Founder approval is recorded in it.

**How to fill each section**
- **REQUIRED INPUT** — the business information the Founder must supply.
- **PROPOSED DEFAULT** — a default may be proposed *only after* Founder input exists; blank until then.
- **FOUNDER DECISION** — the Founder's recorded decision, in the Founder's words.
- **FROZEN AFTER APPROVAL** — `NO` until the Founder writes `YES + date`; after that the section is immutable without a new Founder Architecture Decision.

---

## 1. Business Objective

**REQUIRED INPUT:** ✅ Received — Founder Source Materials Session 1 (2026-07-13).

**PROPOSED DEFAULT:** n/a — section is Founder-authored directly.

**FOUNDER DECISION:** _(DRAFT — recorded from Founder's own words; awaiting freeze)_

**ปัญหาหลัก 3 ข้อที่ MENU-2 ต้องแก้:**
1. **ไม่มี Source of Truth เดียวของข้อมูลเมนู** — ข้อมูลกระจายใน POS / หน้าจัดการ / Delivery / QR Ordering ทำให้หมวดหมู่ ราคา ลำดับการแสดงผลไม่ตรงกัน และเปิดเมนูใหม่ต้องแก้หลายที่ → MENU-2 ต้องเป็น Source of Truth เพียงชุดเดียว
2. **การจัดการเมนูไม่ scale** — Seasonal/Campaign/Promotion/Delivery/POS/Customer App ไม่ควรต้องจัดการแยกกัน → บริหารจากที่เดียว ทุก Channel ใช้ข้อมูลเดียวกัน
3. **สถาปัตยกรรมปัจจุบันไปเป็น SaaS ไม่ได้** — Recipro ไม่ได้สร้างเพื่อ HIBI ร้านเดียว เป้าหมายคือ SaaS สำหรับร้านอาหาร คาเฟ่ ธุรกิจบริการ → ต้องรองรับ Multi-tenant / Multi-branch / Multi-channel / Large-scale catalog ตั้งแต่วันแรก

**เกณฑ์ความสำเร็จ:** ทุก Channel ใช้ข้อมูลเมนูชุดเดียวกัน · เปลี่ยน Seasonal Menu ได้ในไม่กี่วินาที · Rollback ได้ทันที · เปิดสาขาใหม่ใช้เมนูมาตรฐานได้ทันที · ไม่มีปัญหาหมวด/เมนูไม่ตรงกันระหว่างระบบอีก · Founder ไม่ต้องแก้ข้อมูลซ้ำหลายที่

**ขอบเขตธุรกิจ:** MENU-2 ออกแบบสำหรับ **Recipro SaaS**; HIBI เป็น **Design Partner** และร้านแรกที่ใช้จริง; เมื่อความต้องการเฉพาะของ HIBI ขัดกับ SaaS Architecture → **Architecture ต้องมาก่อน**; HIBI-specific แก้ผ่าน **Configuration / Extension / Policy — ห้าม Hard-code**

**ลำดับผู้ได้ประโยชน์:** Founder → Multi-branch Operations → Branch Manager → Store Staff → Customer → Accounting

**กรอบเวลา/ตำแหน่งเชิงกลยุทธ์:** MENU-2 คือ **Platform Foundation** (ไม่ใช่ feature) ของ Customer App · Promotion Engine · AI Recommendation · Marketplace · Franchise · SaaS Platform

**Platform Invariants** — ไม่ใช่ลำดับความสำคัญ แต่เป็น **ความจริงที่ต่อรองไม่ได้** ซึ่งต้องคงอยู่ในทุกช่องทาง ทุกธุรกิจ และทุก implementation ในอนาคต:
- **One Source of Truth** — ข้อมูลเมนูชุดเดียวข้ามทุกช่องทาง
- **Deterministic Pricing** — ราคาคำนวณถูกต้อง ตรวจสอบย้อนได้ ไม่มีสูตรซ่อน/ซ้ำ
- **Deterministic Stock Deduction** — ตัดสต๊อกตรงตามที่เลือกจริงเสมอ
- **Commercial Selection Integrity** — พฤติกรรม Variant/Option/Modifier ถูกต้องและแยกแนวคิดชัดเจน
- **Historical Immutability** — บิลประวัติศาสตร์ไม่ถูกเปลี่ยนโดยการแก้ข้อมูลภายหลัง
- **Operational Simplicity** — ทุก workflow เข้าใจและใช้งานได้โดยไม่ต้องรู้เรื่องเทคนิค

**หลักการเพิ่มเติม:** ต้อง **Operationally Simple** — ทุก workflow ลดขั้นตอน ลดงานซ้ำ ลด human error; ทุก Architecture Decision ต้องตอบได้ว่า: ยังใช้ได้ไหมเมื่อมี 10,000 ร้าน · ยังเข้าใจง่ายไหมเมื่อเปลี่ยนทีมพัฒนา · ทำให้ feature อนาคตง่ายขึ้นหรือซับซ้อนขึ้น — Architecture ที่ดีต้องทำให้การเปลี่ยนแปลงในอนาคตง่ายขึ้น ไม่ใช่เพียงแก้ปัญหาของวันนี้

> **"The system should adapt to the business, not force the business to adapt to the system."**
> "ระบบควรปรับตัวเข้ากับธุรกิจ ไม่ใช่บังคับให้ธุรกิจต้องปรับตัวเข้ากับข้อจำกัดของระบบ"

**FROZEN AFTER APPROVAL:** **YES** — Founder approval date: **2026-07-13** — Status: **CANONICAL SOURCE OF TRUTH**
> ⚠️ This section's wording is immutable. Do not reinterpret, shorten, or rewrite in any future session. Any change requires a new explicit Founder Architecture Decision.

---

## 2. Business Rules

**REQUIRED INPUT:** ⏳ Partially received — Founder confirmed the two-level rule model + Universal Platform Principles; per-policy classification answers still open (see Open Questions).

**Rule model (Founder-confirmed):** Business Rules are ALWAYS separated into two levels — **(1) PLATFORM RULES** (true for every business on Recipro) and **(2) BUSINESS POLICY / SHOP CONFIGURATION** (may differ by company, brand, branch, channel, product). The Blueprint must further distinguish: mandatory platform invariant · configurable policy · optional capability · business-specific extension. HIBI examples are recorded as **validation cases**, never as universal architecture rules.

**PROPOSED DEFAULT:** _(pending — per-policy defaults await Founder classification answers)_

**FOUNDER DECISION:** _(DRAFT — Universal Platform Principles recorded verbatim; awaiting freeze)_

### A. Universal Platform Rules (Founder-confirmed principles)
- **PL-1 Traceable pricing:** ราคาต้องถูกต้องทางคณิตศาสตร์และอธิบายที่มาได้เสมอ — base price / channel price / branch price / variant price / option price / modifier price / discount / tax / final selling price. ราคาสุดท้ายห้ามขึ้นกับการคำนวณที่ซ่อนอยู่หรือซ้ำซ้อนต่างหน้าจอ
- **PL-2 Stock follows the exact commercial choice:** การตัดสต๊อกต้องตรงกับตัวเลือกที่ลูกค้าเลือกจริง; ระบบต้องรู้ชัดว่า selection ใด: เปลี่ยนราคาอย่างเดียว / เปลี่ยนสต๊อกอย่างเดียว / เปลี่ยนทั้งคู่ / เปลี่ยน recipe-BOM / เป็นคำสั่งปรุงอย่างเดียว
- **PL-3 Four separate concepts:** **Variant** = เปลี่ยนรูปแบบหลักของสินค้า (ขนาด/สูตร) · **Option** = กลุ่มตัวเลือกติดกับสินค้า อาจบังคับเลือก · **Preparation Modifier** = คำสั่งปฏิบัติการ (no ice/less ice/warm/hot) — **ห้ามมี price / stock / recipe / BOM เด็ดขาด ไม่มีข้อยกเว้น**; หากกฎธุรกิจต้องการพฤติกรรมด้านราคา สต๊อก หรือสูตร object นั้นต้องถูกโมเดลเป็น Commercial Modifier แทน (การ "reclassify" หมายถึงการเปลี่ยนประเภท object — ไม่ใช่การเปลี่ยนพฤติกรรมของ Preparation Modifier) · **Commercial Modifier** = รายการเสริมมีราคา (extra shot/syrup/cheese/topping/whipping cream) เพิ่มราคาและตัดสต๊อก/BOM ได้ — ระบบห้ามปฏิบัติต่อทั้งสี่อย่างเงียบๆ เป็น object เดียวกัน
- **PL-4 One calculation model:** menu setup / POS / QR / delivery / customer app / receipt / stock deduction / COGS / reports ใช้โมเดลคำนวณเดียวกัน — ห้าม channel ใดคำนวณออเดอร์เดิมด้วยสูตรต่างกัน
- **PL-5 Order-line snapshot:** ทุกบรรทัดขายสุดท้ายเก็บ snapshot: product name · base price · selected variant · selected options · selected modifiers · each price adjustment · final unit price · quantity · tax context · stock/BOM references สำหรับ audit — การแก้สินค้าภายหลังห้ามเปลี่ยนบิลประวัติศาสตร์
- **PL-6 Business-language configuration:** ผู้ใช้เห็นแนวคิดแบบภาษาธุรกิจ (ราคาหลัก / ราคาตามช่องทาง / ขนาด / ตัวเลือกที่ต้องเลือก / รายการเสริม / คำสั่งปรุง / วัตถุดิบที่ใช้เพิ่ม / ราคาที่เพิ่ม / ตัดสต๊อกเท่าไร) — ไม่ต้องเข้าใจ database fields หรือสูตรเทคนิค
- **PL-7 Explainability:** ทุกผลลัพธ์จากการคำนวณหรือการปฏิบัติการต้องอธิบายได้เป็นภาษาธุรกิจปกติ — แพลตฟอร์มต้องอธิบายได้เสมอว่า: ทำไมคิดราคานี้ · ทำไมตัดสต๊อกจำนวนนี้ · ทำไมเลือก recipe/BOM นี้ · ทำไมใช้ภาษีนี้ · ทำไมยอดสุดท้ายเป็นเท่านี้ — โดยไม่ต้องอาศัยการสอบสวนทางเทคนิค

### B. Configurable Business Policies (must NOT be hard-coded; per business/brand/branch/channel/product)
ราคาเท่ากันทุกสาขาหรือไม่ · ราคาต่างตามช่องทางได้หรือไม่ · Delivery ใช้ % uplift หรือราคารายตัว · ใครแก้ราคาได้ · การเผยแพร่เมนูต้องอนุมัติหรือไม่ · สาขาปิดเมนูชั่วคราวเองได้หรือไม่ · ของหมดซ่อนหรือแสดงว่าไม่พร้อมขาย · ชื่อ/รูป/หมวดต่างตามช่องทางได้หรือไม่ · เปลี่ยนแปลงมีผลทันทีหรือกำหนดวันมีผล · role ใด publish/rollback ได้

### C. Commercial Selection Engine (canonical principle — Founder-confirmed)
**A customer selection must become one deterministic commercial decision.**
จาก selection state หนึ่งชุด แพลตฟอร์มต้องกำหนดได้อย่างสอดคล้องเสมอ: selling price · selected variant · recipe/BOM · ingredient quantities · stock deduction · kitchen instruction · tax context · receipt snapshot · reporting dimensions
**Commercial decision เดียวกันนี้ต้องถูกใช้โดย POS, QR, Delivery, Customer App, stock, COGS, receipt และ reporting — ห้าม channel ใด recalculate หรือตีความ selection ใหม่โดยอิสระ** — ทั้งหมดโดยไม่ต้อง duplicate สินค้าและไม่มี workaround สับสน
**Validation cases (HIBI — เป็นกรณีทดสอบ ไม่ใช่กฎ universal):** Large size +20฿ + ใช้นม/มัทฉะมากขึ้น · Oat milk +15฿ + แทนที่นมวัว · Extra shot +25฿ + ตัดสูตล espresso เพิ่ม 1 shot · No ice ฿0 = คำสั่งปรุงอย่างเดียว · Extra topping +30฿ + ตัดวัตถุดิบ topping ตามปริมาณจริง · Product variant เปลี่ยนทั้ง BOM ไม่ใช่แค่ชื่อ/ราคา

### D. Policy Decisions Q1–Q4 (Founder-confirmed, 2026-07-13)

**Q1 — Pricing across branches/channels**
- **Q1.1 [①]** One canonical base price per product; ทุกราคาอื่นเป็น explicit, traceable override จาก base; ห้ามหน้าจอ/ช่องทางใดคำนวณราคาแอบแฝง
- **Q1.2 [②③⑤]** Branch pricing = configurable business policy. **Recommended platform default (Founder-stated):** base price เดียวทุกสาขา · branch override ปิดเป็นค่าตั้งต้น · เปิดได้เมื่อจำเป็นจริง; สาขาใหม่ inherit ราคา canonical อัตโนมัติจนกว่าผู้มีสิทธิ์สร้าง override; สร้าง/แก้ override = approval-required
- **Q1.3 [②③④⑤]** Channel pricing = standard capability; ธุรกิจเลือก: same price / % uplift-discount / fixed uplift-discount / item-level override. ระบบต้องแสดง price composition ครบ ห้าม stack กฎที่ขัดกันเงียบๆ. **Precedence (Founder-stated):** (1) canonical base → (2) approved branch override → (3) approved channel rule → (4) approved product-level channel override → (5) variant/option/commercial-modifier adjustments → (6) discount → (7) tax → (8) final price
- **Q1.4 [②⑤]** การแก้ราคาไม่ใช่ store-staff-safe โดยค่าตั้งต้น; ธุรกิจ config ได้ว่า role ใด: แก้ base/branch/channel rules/schedule future price/approve+publish; เจ้าของร้านเล็กสร้าง+อนุมัติเองได้ (ไม่บังคับ self-approve ซ้ำซ้อน) แต่ต้องเก็บ audit history เสมอ
- **Q1.5 [HIBI validation policy — ไม่ใช่กฎ universal]** HIBI: ราคา canonical เดียวทุกสาขา · branch override เฉพาะมีเหตุผล operational/location จริง · Delivery/external ต่างจากหน้าร้านได้ · ตั้งค่า channel จากส่วนกลาง+traceable · พนักงานสาขาห้ามแก้ราคาขายเอง

**Q2 — Publication gate**
- **Q2.1 [① — ปิดไม่ได้]** Universal blocking conditions ขั้นต่ำ: ไม่มีชื่อ / ราคาขายไม่ถูกต้องหรือหายไปเมื่อจำเป็นต้องมีราคา / commercial selection config ไม่ถูกต้อง / required Option Group ไม่มี choice ที่เลือกได้ / tax config ไม่ถูกต้องเมื่อต้องมีภาษี / product reference หรือ recipe-BOM reference ขาด / การ publish จะทำให้เมนูไม่มี active version ที่ valid / สินค้าถูก archive หรือ block จากการขาย
- **Q2.2 [②⑤]** Approval workflow = configurable: owner publish ตรง / creator=approver / creator ส่ง-อีก role อนุมัติ / scheduled publication หลังอนุมัติ; ห้ามบังคับธุรกิจเล็ก approve งานตัวเองซ้ำ; ทุกการ publish ต้องบันทึก: ใครสร้าง/ใครอนุมัติ(ถ้ามี)/ใคร publish-activate/มีผลเมื่อไร/version-change reference
- **Q2.3 [①②⑤]** Publish/activate/rollback ทั้งเมนูหรือ Placement Version = permission-controlled เสมอ ห้าม store staff ธรรมดาเข้าถึง; role ที่ได้รับสิทธิ์ = config ได้ แต่ audit record = บังคับเสมอ

**Q3 — Branch-level permissions**
- **Q3.1 [①③⑥]** สาขา mark สินค้า "ไม่พร้อมขายชั่วคราว" ได้ (ของหมด/เครื่องเสีย/ปัญหาคุณภาพ/ข้อจำกัดหน้างาน) = standard capability สำหรับ multi-branch; HQ config ว่า role ใดใช้ได้; **ห้ามกระทบ canonical product, recipe, base price, menu architecture — เป็น temporary branch-availability override เท่านั้น**
- **Q3.2 [③⑥]** สิ่งที่สาขาทำได้ (ต้อง simple+fast): pause/resume การขายชั่วคราว · ระบุเหตุผล · ตั้งเวลาคาดว่าจะกลับมา · ดูสต๊อก/availability ของสาขา · acknowledge alerts · report ปัญหา content/ราคาไปส่วนกลาง
- **Q3.3 [①②⑤]** สิ่งที่สาขาห้ามแก้โดยค่าตั้งต้น: canonical product identity · base price · channel-pricing policy · Product Type · Behavior Type · recipe/BOM · stock deduction rules · tax/accounting classification · centralized attributes/vocabularies · menu category architecture · active Placement Version · historical sold-line snapshots — ข้อยกเว้นต้อง grant ผ่าน role permission + audited
- **Q3.4 [① — ปิดไม่ได้]** ทุก branch availability action มองเห็นจากส่วนกลาง + บันทึก: shop/branch · product · action · reason · actor · timestamp · previous state · new state · expected resume time (optional)

**Q4 — Out-of-stock behavior**
- **Q4.1 [①]** สินค้าที่ mark ไม่พร้อมขาย **ห้ามรับออเดอร์ใหม่** บน branch+channel ที่มีผลแล้ว; ทุกช่องทางต้อง consume availability decision เดียวกันหรือ authoritative projection เดียวกัน; ห้าม channel ขายต่อเพราะ cache/เมนูค้าง
- **Q4.2 [②④]** การแสดงผล = config ต่อธุรกิจ+ช่องทาง: ซ่อน / แสดงไม่พร้อมขาย / แสดง+เวลาคาดว่ากลับมา / waitlist-notification (future). **Recommended default (Founder-stated):** POS หน้าร้าน = แสดงไม่พร้อมขาย (พนักงานอธิบายลูกค้าได้) · QR/App/Delivery = ตาม business policy · external Delivery = ตามที่ integration รองรับ
- **Q4.3 [③⑥]** พนักงานที่ได้รับสิทธิ์ mark หมดได้ทันทีไม่รอส่วนกลาง; ต้อง: มีเหตุผล · มีผลเฉพาะสาขา · audit event · resume time (optional) · แจ้ง/มองเห็นจากส่วนกลาง · ไม่เปลี่ยน canonical menu/product
- **Q4.4 [②③④+①Explainability]** Auto stock-based availability = supported แต่ configurable; ระบบต้องแยกแยะสถานะ: stock-confirmed / manually paused / recipe ingredient shortage / equipment-operational pause / integration failure / scheduled window; ต้องอธิบายได้ว่าทำไมไม่พร้อมขาย; **auto detection ห้ามทับ manual business decision เงียบๆ**

### E. Summary Classification (Founder-stated)
**① Invariants:** deterministic+traceable pricing · no hidden price calc · publication blocking on invalid config · privileged+audited publish/rollback · branch overrides never alter canonical truth · every branch action centrally visible+audited · unavailable products cannot accept orders · all channels respect one authoritative availability decision · every price+availability result explainable
**② Policies:** branch pricing allowed? · channel price strategy · price approval workflow · menu approval workflow · privileged-role assignment · unavailable-display behavior · automatic stock-based availability
**③ Branch config:** temporary availability · reason+resume time · branch price override (เมื่อเปิดจากส่วนกลาง) · authorized branch roles
**④ Channel config:** channel pricing · hide vs show unavailable · channel identity differences (เมื่อเปิดชัดเจน)
**⑤ Approval-required:** pricing policy edit/publish · activate/rollback ทั้งเมนู · แก้ canonical menu structure · เปลี่ยน recipe/BOM, tax, Product Type, Behavior Type
**⑥ Staff-safe:** pause/resume availability · ระบุเหตุผล · ตั้ง resume time · ดู availability+stock · report ปัญหา

### F. Confirmed Architecture Constraints (Founder, 2026-07-13)
- **F-1 Branch Availability = separate operational overlay.** ห้าม mutate: Product · Menu · Menu Category · Placement Version · Menu Placement · Recipe · canonical price — ควบคุมได้เพียง temporary branch/channel sellability เท่านั้น
- **F-2 Availability validation at order time.** Menu-display cache ใช้เพื่อ performance ได้ แต่**ทุก order submission ต้อง revalidate availability กับ authoritative source ก่อนรับออเดอร์** — cache เมนูที่ค้างห้ามทำให้สินค้าที่ไม่พร้อมขายถูกขายได้
- **F-3 Deferred items:** role names/permission assignments → Users & Roles · สินค้าที่ไม่ต้องมีราคา → Domain Model/Price · auto stock-based availability default ON/OFF → เปิดไว้ (เว้นแต่ Q5–Q8 ตอบ) · waitlist/restock notification → future optional capability

### G. Policy Decisions Q5 — Timing / Effective Dates (Founder-confirmed, 2026-07-13)
- **Q5.1 [①]** ทุก configuration change ต้องมี explicit effective state — ระบบรู้เสมอ: ค่าที่มีผลตอนนี้ / มีผลเมื่อไร / ใครสร้าง / ใครอนุมัติ(เมื่อจำเป็น) / มีค่าอนาคต schedule ไว้หรือไม่; **"แค่ save draft ห้ามกลายเป็นมีผลโดยบังเอิญ"**
- **Q5.2 [②③④⑤⑥]** มีผลทันทีได้ (เมื่อมีสิทธิ์): product description · image · non-financial content · temporary branch availability · temporary channel availability · แก้ display error ชัดๆ; save กับ publish ยังเป็นคนละแนวคิดเมื่อธุรกิจเปิด approval workflow; staff-safe เฉพาะ temporary availability
- **Q5.3 [①②③④]** ต้องรองรับ **effective start**: base/branch/channel price · tax config · recipe/BOM · availability · Menu/Placement Version activation · Product Collection · campaign content · option+commercial-modifier pricing · stock/BOM behavior ของ commercial selection; **effective end** สำหรับของชั่วคราว: campaign price · branch/channel availability · Collection · seasonal menu · promotional comm-mod · temporary tax/accounting policy (เมื่อกฎหมายรองรับ)
- **Q5.4 [①②⑤]** Sensitive เสมอ (permission-controlled): base-price/pricing-rule/tax/recipe-BOM/stock-deduction/Product Type/Behavior Type changes + activate/rollback Placement Version; second approver บังคับหรือไม่ = config ต่อธุรกิจ; เจ้าของร้านเล็ก create+activate เองได้แต่ audit บังคับ; content-only ใช้ workflow เบากว่าได้
- **Q5.5 [①]** ออเดอร์ที่รับแล้ว preserve+ใช้ **complete commercial decision ณ เวลารับออเดอร์** — ห้ามคำนวณใหม่จาก config อนาคตตลอดกาล ครอบคลุม: price · variant · options · modifiers · recipe/BOM · ingredient quantities · stock deduction · tax · discounts · receipt snapshot · reporting dimensions
- **Q5.6 [①⑤]** Scheduled changes ชนกัน: **ห้าม "latest update wins" เงียบๆ** — ระบบต้อง: detect ก่อน publish → อธิบายว่า record/rule ไหนชน → block activation จน authorized user แก้ → ให้เลือก (cancel/เลื่อนวันที่/replace อย่างชัดเจน) → เก็บ audit link ระหว่าง superseded↔replacement; lower-scope override อยู่ร่วม higher-scope rule ได้เฉพาะเมื่อ precedence อนุญาตชัดเจน
- **Q5.7 [①②③⑤]** หนึ่งธุรกิจมี canonical business time zone; สาขาต่างภูมิภาคมี TZ ตัวเองได้; การตีความ effective time: branch change→branch TZ · business-wide→business TZ · external channel→แปลงจาก branch/business (channel ห้ามเป็น authoritative time source); UI ต้องแสดง TZ ที่ใช้ก่อน publish เสมอ; เปลี่ยน TZ = permission-controlled + ห้าม rewrite historical timestamps

### H. Policy Decisions Q6 — Cross-channel Identity (Founder-confirmed, 2026-07-13)
- **Q6.1 [①]** canonical Product มีหนึ่งเดียว; channel identity = explicit projection/override ห้าม duplicate Product; ไม่มี override → fallback canonical เสมอ
- **Q6.2 name [①②③④⑤ / ไม่ใช่⑥]** canonical name บังคับ; channel display/short name ได้ (per channel; per branch-channel เมื่อจำเป็นจริง) ผูกกับ canonical เสมอ; staff ห้าม rename canonical; **receipt+snapshot เก็บทั้ง canonical reference และ display name ที่ขายจริง**
- **Q6.3 short name [②④]** optional presentation field (POS button/kitchen ticket/delivery/compact card); fallback = canonical name; ห้ามแทน canonical ใน SoT
- **Q6.4 description [②④⑤]** canonical หนึ่งชุด; channel override ได้ (ความยาว/บริบท/แพลตฟอร์ม/ภาษา/marketing); fallback canonical; **ห้ามเปลี่ยน price/recipe/tax/stock/identity**
- **Q6.5 image [②④⑤]** canonical primary image เป็น default; channel override ได้ (ขนาด/crop/พื้นหลัง/กฎแพลตฟอร์ม); fallback canonical; override เก็บ ownership+version+approval history
- **Q6.6 category placement [①④⑤]** เป็น presentation state ไม่ใช่ identity — ต่างได้ผ่าน **Menu Placement** ต่อ Menu/channel; ห้ามเก็บเป็น channel-mutation ของ Product; fallback = placement ในเมนู bound/default ของ channel
- **Q6.7 availability [①②③④⑥]** ต่างได้ตาม business/branch/channel/effective time; เป็น operational overlay; ตรวจ authoritative state ซ้ำตอนรับออเดอร์; **fallback ≠ available — ถ้าไม่มี availability decision ที่ valid ออเดอร์ต้อง fail อย่างปลอดภัย ห้าม assume ขายได้**
- **Q6.8 price [①②③④⑤]** ไม่ใช่ identity แต่เป็น commercial projection; override ได้เฉพาะผ่าน pricing model ของ Q1; fallback ตาม precedence chain; ห้าม channel เก็บ/คำนวณ final price ที่อธิบายไม่ได้
- **Q6.9 option/modifier visibility [①②③④⑤]** นิยาม canonical คงเดิม; channel ซ่อน option/modifier ที่รองรับไม่ได้ ได้; **ห้าม reinterpret**: PrepMod→CommMod / CommMod→free instruction / Option→Variant อื่น; ถ้า config ที่เหลือ invalid → ซ่อนสินค้าจาก channel นั้นได้
- **Q6.10 receipt snapshot [①]** ทุกบรรทัดขายเก็บ: canonical product reference · canonical name ณ ขาย · channel display name ณ ขาย (เมื่อต่าง) · channel+branch context · selected commercial configuration; ใบเสร็จโชว์ชื่อ channel ได้ แต่ audit/reporting ต้องมี canonical เสมอ

### I. Policy Decisions Q8 — Tax Context per Sold Line (Founder-confirmed, 2026-07-13)
- **Q8.1 [①]** บิลประวัติศาสตร์ preserve tax decision สมบูรณ์ ณ เวลาขาย; การเปลี่ยน tax/product/branch/channel/accounting ในอนาคต **ห้าม** เปลี่ยน historical bills/receipts/tax documents/reports/reprints
- **Q8.2 [① immutable facts]** สnapshot ต่อบรรทัดขายขั้นต่ำ: tax classification code · tax rate applied · inclusive/exclusive mode · gross line amount before discount · allocated line discount · taxable amount · tax amount · net amount · exemption/zero-rate reason · branch tax context/ref · channel tax context/ref · document type context · accounting category/ref · currency+rounding context · effective tax-rule version/decision reference — แก้ได้เฉพาะผ่าน legal correction document / bill-correction workflow
- **Q8.3 [①②⑤]** tax classification ตั้งที่ Product level หรือผ่าน approved accounting/tax rule; **ห้าม infer จาก Menu Category / Product Type อย่างเดียว / Behavior Type อย่างเดียว / ชื่อ channel**; ระบบ suggest ได้แต่ห้าม auto-apply การตัดสินใจทางภาษีโดยไม่มี authorized confirmation
- **Q8.4 [①②③④⑤]** rate+mode config ตาม jurisdiction/business registration/branch registration/classification/document type/channel relationship; ห้าม hard-code rate/mode เดียวทุกธุรกิจ; ณ order time ระบบ resolve **one deterministic tax decision** แล้ว snapshot
- **Q8.5 [②③⑤]** branch มี tax-registration/document context ของตัวเองได้ (registration id, เลขเอกสาร, presentation, invoice issuer, accounting entity) — ควบคุมจากส่วนกลาง + audited
- **Q8.6 [②④⑤]** channel มี tax/document handling ต่างได้เฉพาะเมื่อความสัมพันธ์ทางกฎหมาย/การค้าต้องการ (marketplace agent vs merchant-of-record, commission treatment, ใครออกใบกำกับ); channel ห้าม recalculate tax หลังแพลตฟอร์มรับออเดอร์โดยไม่มี explicit reconciliation record
- **Q8.7 [①②⑤]** document type เป็น transaction-level decision: receipt / abbreviated tax invoice / full tax invoice / credit note / debit note / cancellation-correction; document type + buyer/tax data ที่ใช้ ต้อง snapshot กับ transaction
- **Q8.8 [①②⑤]** accounting category ตั้งชัดเจนหรือ map ผ่าน approved rule; **ห้ามแทนที่** Product Type / Behavior Type / Menu Category / tax classification; ค่าที่ใช้ ณ ขายถูก preserve เป็น snapshot/reference
- **Q8.9 [①②⑤]** tax configuration ไม่ใช่ staff-safe เด็ดขาด — เฉพาะ finance/accounting/owner/delegated admin; แยกคนสร้าง-คนอนุมัติ = config ตามขนาดธุรกิจ; ทุกการเปลี่ยนบันทึก: actor · timestamp · previous · new · effective date · reason · approval record
- **Q8.10 [①]** Recipro = **configurable tax engine + immutable tax snapshot architecture**; ห้ามแสร้งว่านโยบายภาษีเดียวใช้ได้ทุกประเทศ/ธุรกิจ/สาขา/ช่องทาง; กฎภาษีรายประเทศ/รูปแบบเอกสาร/การยื่น = jurisdiction modules/integrations ที่ผู้เชี่ยวชาญภาษีตรวจ

### J. Updated Universal Invariants (Founder-confirmed additions)
1. Draft saved ≠ published/effective · 2. ทุก effective configuration มี timing+actor+audit ชัดเจน · 3. Accepted orders ไม่ถูกคำนวณใหม่จาก config อนาคต · 4. Scheduled changes ชนกันห้าม resolve เงียบด้วย "latest wins" · 5. canonical Product มีหนึ่งเดียว channel identities = projections · 6. channel overrides fallback สู่ canonical เสมอเมื่อไม่มี · 7. availability ถูก revalidate แบบ authoritative ตอนรับออเดอร์ · 8. historical tax + commercial decisions = immutable · 9. tax classification แยกจาก Product Type / Behavior Type / Menu Category · 10. ทุกผลลัพธ์ commercial+tax อธิบายได้เป็นภาษาธุรกิจ

### K. Open Items (deferred — ไม่ขวางการ freeze §2 ตามคำ Founder)
role names/assignments → Users & Roles · HIBI attribute vocabulary → Domain Model/Attributes · zero-price products → Domain Model/Price · auto stock-based availability default ON/OFF → Operational policy · country-specific tax rules + Thai tax-document details → Tax/Accounting implementation blueprint · MENU-2 timeline/deadline → Phase Plan

**FROZEN AFTER APPROVAL:** **YES** — Founder approval date: **2026-07-13** — Status: **CANONICAL SOURCE OF TRUTH**
> ⚠️ This section's wording is immutable. Do not reinterpret, shorten, summarize, or rewrite in any future session. Any change requires a new explicit Founder Architecture Decision.

---
*Annex (NOT part of frozen §2 wording) — Founder-confirmed consequences carried forward to the next MENU-2 blueprint revision (2026-07-13):*
*(1) Sold-Line Snapshot = complete commercial decision at order acceptance: canonical product identity · channel display identity · base+final price components · variant · options · prep modifiers · commercial modifiers · recipe/BOM decision · ingredient quantities · stock-deduction references · discount context · tax context · receipt snapshot · reporting dimensions. (2) Explicit scheduling/effective-state architecture for prices/tax/recipe-BOM/availability/menu-placement activation/collections/campaign content/option+comm-mod pricing. (3) Overlapping scheduled changes detected + blocked until explicitly resolved — "latest update wins" never permitted silently. (4) Menu-display caches may fall back to legacy display; order acceptance may NOT assume sellability — must authoritatively revalidate availability, price, commercial selection, recipe/BOM, and tax before accepting. (5) No valid authoritative availability decision ⇒ order acceptance fails safely. (6) Branch Availability = temporary operational overlay; never mutates canonical Product/Menu/Placement/Recipe/Price truth.*

---

## 3. Users & Roles

**REQUIRED INPUT:** ⏳ Group 1 (Actor Map) received 2026-07-13; capability-matrix groups pending.

**PROPOSED DEFAULT:** _(pending — defaults only where Founder states them)_

**FOUNDER DECISION:** _(DRAFT — recorded from Founder's words; awaiting freeze)_

### A. Actor Taxonomy (G1.7 [①])
Actor types: human user · platform operator · business role · branch role · integration · system automation · AI agent. **ทุก actor กระทำผ่าน identity ของตัวเองเสมอ**; ห้าม impersonate โดยไม่มี explicit, audited support/delegation mechanism. ทุก state-changing action บันทึก 13 องค์ประกอบ: actor type · actor identity · tenant/business · branch/channel scope · action · target record · previous state · new state · timestamp · source device/integration · reason/comment (เมื่อจำเป็น) · approval chain · correlation/request reference. Read-only access ต่อข้อมูล sensitive ต้อง auditable เมื่อกฎหมาย/สัญญา/ปฏิบัติการต้องการ. **Audit events = append-only** — business users และ platform support แก้ไม่ได้.

### B. Platform Actors (G1.1 [①⑤])
5 ตัว: Recipro Platform Administrator · Support Operator · Security/Audit Operator · Migration/Implementation Operator · Recipro System Service. **Platform personnel ห้ามทำเสมือนเป็นลูกค้า.** ทุก platform action บันทึก: platform actor identity · tenant · branch · เหตุผล · ticket/approval ref · previous/new value · timestamp · impersonation state. หลักการ: default = ไม่เห็นข้อมูล operational ของลูกค้า · support = least-privilege + time-bounded · การดูข้อมูล financial/tax/payroll/customer/สูตรลับ ต้องมี explicit business authorization หรือ emergency/security procedure ที่นิยามไว้ · ช่วย config ได้เมื่อถูกร้องขอ/มีสัญญา · **ห้ามแก้ราคา/ภาษี/BOM/menu publication/stock/การเงินเอง** · emergency security = ระงับ access/integration ได้ แต่ห้ามแก้ business truth เงียบๆ · platform audit แยกให้เห็นชัดจาก customer actions.

### C. Business Roles (G1.2 [①②⑤])
Starter templates 9 บทบาท (ไม่ใช่ตำแหน่งบังคับ): Business Owner · Executive/GM · Central Operations Manager · Finance/Accounting · Product/Menu Manager · Pricing Manager · Marketing/Content · Inventory/Procurement Manager · Auditor/Read-only Reviewer. ธุรกิจทำได้: rename · สร้าง custom role · หนึ่ง user หลาย role · จำกัด role ต่อสาขา/domain · temporary delegated access · duplicate role เป็น template. **ธุรกิจลบ platform safety boundaries ไม่ได้:** audit logging · tenant isolation · historical immutability · การแยก canonical จาก branch overrides · การคุ้มครอง high-risk tax/security/migration actions. **Permissions = capability-based ไม่ผูกกับชื่อ role.**

### D. Branch Roles (G1.3 [①③⑤])
= **assignment scopes** ไม่ใช่ระบบ identity แยก. Templates 6: Branch Manager · Assistant/Shift Lead · Cashier/POS Staff · Bar/Kitchen Production · Stock/Receiving · Branch Read-only/Trainee. หนึ่งคน: หลายสาขา · ต่าง role ต่างสาขา · cover สาขาอื่นชั่วคราว · ถือทั้ง business-level และ branch-level ได้ (เช่น Branch Manager สาขา A + Cashier สาขา B + Central Viewer). **Permission resolution: User → assigned role → tenant/business scope → branch scope → domain capability → optional time limit.** Branch role ทำงานเฉพาะใน branch scope ของตน เว้นแต่ได้ business permission ชัดเจน.

### E. Channel/Integration Actors (G1.4 [①④⑤])
ทุก integration มี non-human identity ของตัวเอง (delivery connector, marketplace, accounting, partner API, customer app backend, kiosk, webhook consumer, import/export service). ได้เฉพาะ capability ที่ grant ชัดเจน (อ่าน published menu/availability/price projections · ส่งออเดอร์ · รับ order status). **ห้าม:** แก้ canonical Product/base price/tax/recipe-BOM · activate/rollback menus · เปลี่ยน branch permissions · เข้าถึง tenant อื่น. ต้องรองรับ: tenant+branch scoping · credential rotation · suspension/revocation · rate limiting · last-used visibility · failure monitoring · audit trail · environment separation. Integration ที่ผิดปกติ = ระงับจากส่วนกลางได้โดยไม่ดับช่องทางอื่น/ทั้งธุรกิจ.

### F. System Automation (G1.5 [①⑤])
= first-class actor ระบุตัวเป็น SYSTEM เสมอ ไม่ปลอมเป็นมนุษย์ (scheduled publication · effective-price activation · version activation ตามเวลา · auto availability evaluation · cache refresh · integrity validation · approved migration execution · integration retry). ทุก action บันทึก 9 องค์ประกอบ: automation identity · initiating config/schedule · original human creator · original human approver · execution time · result · affected records · failure reason · retry count. **Execute ได้เฉพาะ rule/schedule ที่มนุษย์ authorize ไว้ก่อน. ห้ามโดยอิสระ:** คิด/อนุมัติราคาใหม่ · tax treatment ใหม่ · recipe-BOM decision ใหม่ · fuzzy cleanup · approve migration · grant permissions · override manual hold โดยไม่มี explicit precedence policy · ลบ audit history · แก้ schedule conflict เงียบๆ.

### G. AI Agent (G1.6 [①⑤] — "AI = recommend and draft, not final authority")
AI = actor type แยก มี identity + permissions + model/version record + audit trail ของตัวเอง.
- **แนะนำได้:** category placement · Product Type/attribute suggestions · descriptions · image/copy improvements · pricing opportunities · stock-risk alerts · bestseller/low-performance analysis · seasonal menu ideas · duplicate/inconsistent-data candidates · branch/channel config improvements
- **ร่างได้ (รอมนุษย์ review):** product content · Menu/Placement Version · campaign · category structure · channel projection · cleanup mapping · price proposal · recipe/BOM proposal · report/operational action plan — draft ต้องติดป้าย AI-generated + ระบุ: model/agent · source data · confidence/uncertainty · generation time · human reviewer · final approval result
- **ห้าม execute เด็ดขาด:** menu publication/version activation · rollback active menu · base/branch/channel price changes · discount/tax publication · recipe-BOM changes · stock-deduction rule changes · Product Type/Behavior Type changes · cleanup/migration writes · deletion/archival ของ canonical records · permission/role changes · legal/accounting classification · production deployment · irreversible actions
- AI เปลี่ยน recommendation เป็น effective business decision ไม่ได้โดยไม่มี authorized human approval; ธุรกิจตั้ง AI ให้แคบลงได้ แต่รายการห้ามคงอยู่ เว้นแต่ Founder Architecture Decision ใหม่สร้าง controlled approval workflow

### H. Cross-Actor Principles (Founder-confirmed)
(1) ชื่อ role ไม่ใช่แหล่งของ permission — effective permission มาจาก explicit capabilities + scope · (2) หนึ่ง user หลาย role หลายสาขาได้ · (3) platform support/integration/automation/AI ห้ามปรากฏใน audit เป็นเจ้าของร้านหรือพนักงาน · (4) ทุก privileged action ระบุ creator / approver (เมื่อจำเป็น) / executor — เป็นคนเดียวกันได้เมื่อ governance policy อนุญาต · (5) ร้านเล็ก owner-operated ไม่ถูกบังคับ self-approve ซ้ำ — owner สร้าง+execute ได้เมื่อ policy อนุญาต แต่ audit + risk warnings บังคับ · (6) high-risk permissions = **deny-by-default** ต้อง grant ชัดเจน · (7) temporary/delegated access มี expiry · (8) tenant+branch scope บังคับ **server-side** ไม่ใช่แค่ซ่อนใน UI · (9) AI/automation/integrations ได้ permission แคบกว่ามนุษย์เจ้าของเสมอ ห้าม inherit owner power โดยปริยาย · (10) ไม่มี actor ใด bypass Historical Immutability / deterministic pricing / deterministic stock deduction / tax-snapshot invariants ได้

### I. Capability Matrix (Group 2, Founder-confirmed 2026-07-13)
**Core principle:** permission = capability+scope; role templates เป็นจุดเริ่มเท่านั้น; ไม่มี role ได้อำนาจเพราะชื่อ; resolution: Actor identity → tenant/business → assigned role → branch scope → domain capability → action level → approval requirement → optional expiry.

| Cap | Roles (ปกติ) | Scope | Action | Deny-default | 2nd approver | Solo-owner | Delegate | Audit | Staff-safe | Non-human |
|---|---|---|---|---|---|---|---|---|---|---|
| **A View menu/product** | ทุก central+branch role (Trainee เฉพาะที่ assign) | central=business, branch=assigned | view | no (ordinary) / **yes สำหรับสูตรลับ·cost·margin·tax·restricted supplier** | no | n/a | yes | sensitive access เท่านั้น | **yes** (in scope) | AI=approved non-sensitive only · integration=published projections only · SYSTEM=task-required · support=authorized access |
| **B Create drafts** | Owner·GM·CentralOps·Menu Mgr·Marketing·Pricing(pricing)·Inventory(stock)·Branch Mgr เมื่อ policy เปิด | business/assigned domain | draft | yes นอก domain | no | yes ที่ publish stage | yes | creation+author+source | staff = submit issue/suggestion เท่านั้น | AI=labelled drafts · SYSTEM=จาก approved rules · integration=เฉพาะ import ที่ออกแบบ+review · support=เมื่อ authorized |
| **C Edit canonical Product** | Owner·Menu Mgr·Marketing(content fields)·CentralOps เมื่อ granted | business-wide (canonical กลางเสมอ) | edit | yes | config (content) / **mandatory เมื่อกระทบ legal-financial-operational truth** | yes | yes (domain+expiry) | ทุก edit | **no** (report/propose ได้) | AI=recommend+draft · SYSTEM=ห้าม invent · integration=ห้าม · support=explicit request only |
| **D Pricing (base/branch/channel)** | Owner·Pricing Mgr·Finance เมื่อ assigned·GM เมื่อ granted | base=business, override=branches, channel=channels+branches | **draft/edit/approve/publish แยกเป็นคนละ capability** | yes | config; high-value/mass = 2-person ได้ | yes + warning + full audit | explicit expiry+scope+max authority | ทุก edit/approve/publish/rollback (+view unpublished sensitive เมื่อ required) | **no** | AI=recommend/draft only · SYSTEM=activate approved schedule · integration=projections only · **support=ห้าม** |
| **E Recipe/BOM/stock-deduction** | Owner·Menu Mgr(qualified)·Inventory Mgr·CentralOps·specialist role | business/products/branches | view/draft/edit/approve/publish | yes (high-risk) | config; **mandatory สำหรับ bulk migration/large-scale rule changes** | yes + risk warning | narrow (expiry+product scope) | ทุกอย่าง | no (production staff = view+report) | AI=recommend/draft · SYSTEM=approved schedules only · integration=ห้าม · support=ห้าม independent |
| **F Tax/accounting config** | Owner·Finance·delegated tax admin | business/entity/branch/channel/jurisdiction | draft/edit/approve/publish | **yes สูงสุด** | config + **platform ต้อง support mandatory separation** | ได้เฉพาะร้านเล็ก + legal warning เด่นชัด | qualified roles, short expiry | ทุก change + restricted views เมื่อ required | **never** | AI=explain/draft ห้าม apply · SYSTEM=approved schedules · integration=อ่าน tax decision ที่จำเป็นต่อ transaction · support=ห้าม |
| **G Menu Categories** | Owner·Menu Mgr·CentralOps·Marketing เมื่อ granted | business/menu (branch menus เมื่อแยกบริหาร) | create/rename/reorder/archive (draft) | edit=yes, view=no | no (draft); publication ตาม activation perms | yes | yes | structural edits ทุกครั้ง | no (suggest ได้) | AI=suggest/draft · SYSTEM=ห้าม restructure · integration=ห้าม · support=on request |
| **H Menu Placements** | เหมือน G | menu/version/branch | place/remove/reorder/feature/hide/badge/schedule **ใน DRAFT** | yes | no (draft); activation แยก | yes ที่ activation เมื่อ policy | yes (draft only) | ทุก edit | no | AI=recommend/draft · SYSTEM=approved import/duplicate cmd only · integration=ห้าม · support=authorized |
| **I Create/duplicate Versions** | Owner·Menu Mgr·CentralOps | menu/business | create/duplicate **DRAFT only** | yes | no | yes ที่ activation | yes | ทุก create/duplicate/archive | no | AI=labelled draft ได้ · SYSTEM=duplicate approved source เมื่อสั่งชัด · integration=ห้าม · support=implementation ที่ authorized |
| **J Activate/rollback Versions** | Owner·GM·CentralOps Mgr·Menu Mgr เมื่อ expressly granted | business/menu/branch | approve/activate/rollback | yes (high-risk) | config; required เมื่อธุรกิจเปิด SoD | yes + impact preview + audit | short expiry + explicit menu scope | mandatory + comment + creator/approver/executor | **never** | **AI=ห้าม execute** · SYSTEM=activate approved schedule · integration=ห้าม · support=ห้าม |
| **K Pause/resume availability** | Owner·CentralOps·Branch Mgr·Shift Lead·staff ที่ authorized | assigned branch+product(+channel) | execute พร้อม reason | เปิดผ่าน branch policy + explicit grant | no | yes | yes | ทุก action | **yes** (authorized) | SYSTEM=mark จาก approved stock rules **ห้ามทับ manual hold เงียบ** · AI=recommend · integration=ส่ง signal ได้ ห้ามแก้ canonical state โดยไม่มี approved rule · support=ห้าม routine actions |
| **L Approve cleanup/migration** | Owner·designated GM·Migration Approval role·qualified data owner | business/branch/dataset/batch | review/approve/reject | **yes สูงสุด** | **mandatory: destructive/cross-tenant/irreversible/legally sensitive** · config: low-risk reversible | เฉพาะ reversible scoped + preview+backup+warning; **ห้าม platform-wide/irreversible** | exceptional, short-lived | ทุก review/approve/reject | **never** | AI=suggest mapping · SYSTEM=ห้าม approve · integration=ห้าม · **support=ห้าม approve แทนลูกค้า** |
| **M Run cleanup/migration** | Recipro Migration Operator·approved Business Migration Operator·SYSTEM (approved plan) | exact approved tenant/branch/records/batch | execute approved artifact only — **ห้ามขยาย scope** | **yes สูงสุด** | approval ต้องมีอยู่ก่อน | เฉพาะ supported low-risk business cleanup; ห้าม infra/platform | mandatory expiry, single-purpose | full execution log+counts+before/after+failure evidence | **never** | SYSTEM=approved deterministic migration · AI=ห้าม · integration=ห้าม · support=recorded authorization only |
| **N1 Attr values on products** | Owner·Menu Mgr·Marketing(permitted attrs)·CentralOps | business/products | edit | medium risk | config | yes | yes | changes | view only | AI=suggest/draft |
| **N2 Vocabulary/definitions** | Owner·Product governance/Attribute Definition admin | business | edit definitions | **yes (high — กระทบ validation/reports/หลายสินค้า)** | config; **bulk remapping ต้อง approval** | yes | จำกัด | ทุก definition change + product remaps | view only | AI=suggest · อื่นๆ ห้าม |
| **O Roles/permissions** | Owner·delegated Business Access Administrator (strict limits) | business+assigned branches | create role/edit lower-risk perms/assign/revoke | **yes สูงสุด (security)** | **mandatory: ownership transfer + granting protected high-risk** · config: ordinary branch assignments | yes ordinary; ownership transfer = special confirmation + recovery checks | expiry + ห้ามเกิน delegator authority | ทุก role/permission/assignment change | Branch Mgr assign **predefined branch-only roles ในสาขาตัวเอง** เมื่อธุรกิจเปิด; ห้ามสร้าง high-risk perms | **AI/SYSTEM/integration = ห้าม grant** · support=เฉพาะ account-recovery/implementation ที่ authorize แยก |
| **P Integrations** | Owner·Integration Admin·Security/IT·CentralOps (operational connectors เมื่อ granted) | business | create/configure/rotate/suspend/revoke/view health | yes | config; required สำหรับ high-privilege/financial เมื่อ policy | yes + security warning | narrow+expiry | ทุก credential lifecycle + permission change; **secret values ห้ามลง log** | no (ดู status ได้เมื่อ permitted) | integration ห้ามขยายสิทธิ์ตัวเอง · SYSTEM=rotate/expire ตาม approved policy · AI=diagnose/recommend ห้ามแตะ credentials · support=authorized only |
| **Q Sensitive financial/audit data** | Owner·Finance·Auditor·Security/Audit Operator (authorized)·selected GM | legal entity/business/branches | view / export (**คนละ permission**) | yes | no (ordinary view); export highly sensitive = extra confirmation/policy | yes | short expiry + watermark/export restrictions | access + export | no | AI=minimized approved data per purpose · integration=contracted fields · SYSTEM=approved processing · support=explicit authorization/emergency |

### J. Separation of Duties (Founder-confirmed)
(1) publish price → **config** · (2) publish tax → **config** + platform ต้อง support mandatory เมื่อ governance/กฎหมายบังคับ · (3) activate/rollback version → **config** · (4) publish recipe/BOM → **config** · (5) stock-deduction behavior → config (scoped) / **mandatory (bulk/irreversible/cross-business)** · (6) approve cleanup/migration → **mandatory proposer↔approver↔executor สำหรับ high-risk/bulk/irreversible/platform-wide/cross-tenant** / config (low-risk reversible per-record) · (7) grant high-risk permissions → **mandatory หรือ protected ceremony**: ownership transfer · owner-equivalent · platform-level access · migration authority · tax/security admin · (8) **production deployment → mandatory author↔approver เมื่อมีคน >1**; single-Founder = protected ceremony: explicit approval + exact SHA guard + preflight + rollback plan + immutable audit + optional cooling period · (9) legal/accounting classification → config ต่อธุรกิจ+jurisdiction; audit+privileged บังคับเสมอ · (10) irreversible deletion/archival → **mandatory second confirmation**; แยกมนุษย์อนุมัติบังคับเมื่อ irreversible/bulk/cross-tenant/legally sensitive.
**Solo-owner protected ceremony** (เมื่อไม่มีคนที่สองจริงและกฎหมาย/policy อนุญาต): explicit risk summary · exact affected-record count · backup/snapshot · typed confirmation · cooling period (high-risk) · re-authentication · immutable audit · rollback evidence — **ไม่อนุญาตให้ bypass separation ที่กฎหมายบังคับ**

### K. Role Administration (Founder-confirmed)
สร้าง role: Owner; delegated Business Access Administrator ภายใน ceiling+scope ที่ Owner ให้; Branch Mgr ห้ามสร้าง unrestricted custom business roles · แก้ permissions: Owner+Access Admin ต่ำกว่า protected ceiling ของตน; **ห้าม grant capability ที่ตัวเองไม่มีและไม่ได้รับมอบให้บริหาร** · assign: Owner=business-wide; Access Admin=ภายใน ceiling; Branch Mgr=predefined branch-only roles ในสาขาตน (users ใน tenant เดิม, ต่ำกว่า ceiling; **ห้าม grant**: pricing publication·tax·canonical governance·migration·integrations·business-wide audit·ownership·owner-equivalent); **platform support = never ผ่าน normal access** (exceptions: verified account recovery/owner request/implementation contract/security emergency — บันทึก requestor·verifier·support actor·role·expiry·reason) · **ห้าม grant เท่ากับ/สูงกว่า effective authority ตัวเอง** เว้นมี role-administration capability แยกที่ authorize ชัด; owner-equivalent grant ผ่าน role editing ปกติไม่ได้ · **ต้องมี Owner approval เสมอ**: ownership transfer · owner-equivalent role creation · protected high-risk grant · tax/security/migration admin assignment · production/tenant migration authority · cross-business data access · platform emergency access to sensitive data · irreversible deletion of business-level records · **Escalation prevention**: authority ceiling · server-side scope · protected capabilities ห้าม bundle เงียบใน custom role · owner role ลบไม่ได้ขณะธุรกิจ active · ownership transfer = re-auth + recipient confirm + recovery validation · high-risk grant แสดง risk summary · audit ทุก grant/revoke · temporary grants expire อัตโนมัติ · permission change → invalidate/refresh sessions · support impersonation ไม่เปลี่ยน role จริงของลูกค้า

### L. Delegated Access (Founder-confirmed)
Default max: ordinary **7 วัน** · sensitive finance/pricing/integration/config **24 ชม.** · emergency platform/support **4 ชม.** (ธุรกิจตั้งสั้นกว่าได้; ยาวกว่าต้อง Owner approve + justification แต่ต้อง expire) · **expiry บังคับทุกกรณี — ไม่มี permanent delegation** (ความรับผิดชอบถาวร = role assignment ปกติ) · renewal = new approval, **ห้าม renew เงียบ** · emergency: incident/ticket ref + reason + approving authority/defined procedure + least privilege + auto expiry + post-event review · high-risk delegation: ระบุ capability+scope ชัด · duration สั้น · Owner/protected authority approve · re-authentication · audit ทุกการใช้; **owner transfer + unrestricted owner-equivalent = delegate ไม่ได้** · ทุก delegation บันทึก: reason·ticket/ref·approver·audit + delegator·delegate·capabilities·scope·start·expiry·renewal history·revocation time+actor

### M. Universal Audit Rule (Founder-confirmed)
ไม่ต้องสร้าง audit event รายครั้งสำหรับ low-risk read ปกติ — แต่**ต้อง audit เสมอ**: ทุก state-changing action · privileged action · sensitive data access+export · role/permission use ที่ security-relevant · AI draft creation+approval · automation execution · integration credential lifecycle · support access+impersonation · migration/cleanup · publication/activation/rollback · financial/tax/BOM/stock-rule changes. Audit policy ต้องรักษา explainability โดยไม่ทำให้งานหน้าร้านปกติซับซ้อนเกินใช้

**FROZEN AFTER APPROVAL:** **YES** — Founder approval date: **2026-07-13** — Status: **CANONICAL SOURCE OF TRUTH**
> ⚠️ This section's wording is immutable. Do not reinterpret, shorten, summarize, or rewrite in any future session. Any change requires a new explicit Founder Architecture Decision.

---
*Annex (NOT part of frozen §3 wording) — Founder-confirmed at freeze (2026-07-13):*
*Intentionally deferred (do not block freeze): (1) cooling-period duration — configurable by domain+risk, exact duration in the relevant implementation blueprint; (2) permission-change session handling (refresh vs force logout) — Identity/Security implementation blueprint.*
*Confirmed consequences for future implementation: (A) permission model = Actor identity → tenant/business scope → branch scope → domain capability → action level → approval requirement → authority ceiling → optional expiry; role names are templates, never the source of authority. (B) action levels view/draft/edit/approve/publish/execute/rollback/export must NOT collapse into one generic Edit. (C) high-risk = deny-by-default + configurable/mandatory SoD + solo-owner protected ceremony (where legally allowed) + exact affected scope + re-authentication + immutable audit + rollback evidence + optional cooling period. (D) every actor type acts under its own identity — support/automation/AI never appear as a customer employee. (E) delegated access: must expire · requires approval · reason/reference · ≤ delegator's ceiling · revocable · audited. (F) AI = recommend+draft only; never independently execute pricing/tax publication, recipe-BOM, stock-deduction, menu activation/rollback, cleanup/migration, role/permission, legal/accounting classification, deployment, irreversible actions. (G) branch staff may execute only authorized temporary availability pause/resume; branch actions never mutate canonical Product/Pricing/Recipe-BOM/Tax/Menu Architecture/historical records.*

---

## 4. Operational Flow

**REQUIRED INPUT:** ⏳ Group 1 (F1 Product Creation + F2 Product Edit) received 2026-07-13; Flows 3–18 pending.

**PROPOSED DEFAULT:** _(only where Founder states them)_

**FOUNDER DECISION:** _(DRAFT — recorded from Founder's words; awaiting freeze)_

### F1 — Product Creation (Founder-confirmed)
- **F1.1 Entry points [①]:** Product ใหม่เกิดได้จาก: ทีมกลาง · branch proposal · file import · duplicate · AI draft · approved integration import · recipe-development workflow — **ทุกทางเข้าบรรจบเป็น canonical Product Creation flow เดียว**; ไม่มีทางเข้าใด bypass: identity rules / validation / permissions / audit / approval / publication / historical integrity; branch proposal, AI suggestion, import **ไม่มีวันกลายเป็น effective Product อัตโนมัติ**
- **F1.2 Draft-first [①]:** ทุก Product ใหม่เริ่มเป็น **DRAFT**; การสร้าง/บันทึกไม่ทำให้: ขายได้ / publish / ขึ้นเมนู / active บน channel / available ที่สาขา — draft creation กับ commercial publication เป็นคนละ state
- **F1.3 Incomplete drafts [①②]:** บันทึก draft ไม่สมบูรณ์ได้ (จดไอเดีย); ขั้นต่ำครั้งแรก = working name + owning business + creator identity; ยังไม่ต้องมี รูป/ราคา/recipe/tax/placement — แต่ข้อมูล commercial ที่ขาด **block publication**; draft เก็บ: creator · source · created time · last editor · last edited · completeness status · validation issues; **draft ไม่หมดอายุอัตโนมัติ ห้ามถูกลบเงียบ**; ระบบเตือน stale/filter อายุ/archival ที่ authorized ได้ (archival/deletion = explicit + audited); retention policy = ②
- **F1.4 Product↔Recipe [①⑤]:** รองรับทั้ง **Product ก่อน→ผูกสูตร** และ **สูตรก่อน→สร้าง/ผูก Product** — บรรจบความสัมพันธ์ canonical เดียว; Product ที่ต้องมี recipe/BOM ห้าม publish/ขายจนกว่า: มี approved recipe/BOM ผูกแล้ว + commercial selection resolve สูตรถูก + stock-deduction behavior valid; Product ที่ไม่ต้องมีสูตร (resale/service/non-stock) **ห้ามถูกบังคับให้มี**; การผูกสูตร = permission-controlled + auditable
- **F1.5 Creation ≠ publication [①②]:** สร้างเสร็จไม่ขึ้นเมนูอัตโนมัติ — ต้องผ่าน validation → approval (เมื่อ config) → Menu Placement → effective publication/Version activation → branch+channel availability; **ร้านเล็กใช้ guided fast-track ได้ (Create→complete→place→approve/publish ในหน้าเดียว) แต่เป็นการรวมขั้นตอนที่มองเห็นเท่านั้น — ห้าม bypass: validation / audit / explicit confirmation / snapshot rules / pricing-stock integrity / publication blocking conditions**
- **F1.6 Draft visibility [①③]:** พนักงานสาขาปกติเห็นเฉพาะ: effective Products + branch-available + approved instructions — ไม่เห็น central drafts โดย default; role ที่ authorized เห็นตาม scope; **ข้อเสนอจากสาขาเข้าเป็น proposal — ไม่เป็น canonical draft จนถูก accept โดย authorized actor**
- **F1.7 HIBI validation policy (ไม่ใช่กฎ universal):** ทีมสร้าง/พัฒนา draft ได้เอง; Founder ไม่ต้อง approve การเกิด draft ทุกตัว; Founder คุมที่ **high-impact effective gates**: final canonical approval (เมื่อจำเป็น) · pricing publication · recipe/BOM publication · Menu/Version activation · launch ข้ามสาขา/ช่องทาง

**F1 Flow Summary (16 attributes):** Trigger=idea/proposal/import/duplicate/AI/recipe workflow · Actor=authorized human/AI draft actor/approved integration/SYSTEM import · Permission=product draft creation ใน scope · Draft=DRAFT เสมอ · Validation=progressive ระหว่าง draft, blocking สมบูรณ์ก่อน publish · Approval=config ตาม business+risk; high-impact ใช้ gate ของ domain นั้น · Effective=หลัง explicit publication+placement/activation เท่านั้น · Executor=authorized human/SYSTEM approved schedule · Audit=ทุก creation source/edit/approval/linkage/publication · Failure=draft คงอยู่ปลอดภัย+validation issues อธิบายได้ · Rollback=archive draft/revert approved changes; published history immutable · Notifications=review+stale-draft reminders (optional) · SoT=canonical Product record (proposals/imports/AI = drafts เท่านั้น) · Scope=ไม่มีตัวตนบน branch/channel จน config ชัด · Staff UX=guided ไม่มีภาษาเทคนิค · Founder gate=เมื่อ policy/sensitive linked decision ต้องการ

### F2 — Product Edit (Founder-confirmed)
- **F2.1 [①]** แก้ canonical กับ publish การแก้ = คนละ action; save ห้ามเปลี่ยนสิ่งที่ลูกค้า/พนักงานเห็นเงียบๆ; รองรับ: save draft · preview impact · approve เมื่อจำเป็น · publish ทันทีเมื่อได้รับอนุญาต · schedule effective time · cancel pending change
- **F2.2 Content-only [②⑤]:** description/image/สะกด/marketing copy ไม่ใช่การเงิน — publish ทันทีได้โดย role ที่ authorized เมื่อ policy อนุญาต (approval/scheduling ก็ config ได้); **content edit ห้ามแตะ**: price / tax / recipe-BOM / stock behavior / Product Type / Behavior Type / historical snapshots
- **F2.3 Impact preview [①]:** ก่อน publish canonical edit ต้องแสดง: ใช้อยู่ที่ไหน (active Menus · Placement Versions · Categories · branches · channels · channel overrides · recipe/BOM relationships · campaigns/collections · options/modifiers · scheduled changes); high-impact เพิ่ม: affected record count · branches/channels · effective time · potential conflicts · validation failures — **ภาษาธุรกิจ ไม่ต้องสอบสวนเทคนิค**
- **F2.4 Draft-on-edit by risk [①②]:** ไม่ใช้พฤติกรรมเดียวทุก field — content = direct edit + explicit publish; **sensitive/structural ใช้ controlled change draft**: price ทุกชั้น · tax · recipe/BOM · stock-deduction · Product Type · Behavior Type · canonical identity replacement · legal/accounting classification — มี validation/approval/effective-state ของตัวเอง; **หลาย draft changes บน Product เดียวห้ามทับกันเงียบ**
- **F2.5 History & rollback [①]:** เก็บ field-level/change-set history อธิบายได้: what/previous/new/actor/approver/effective time/reason/scope; rollback = **สร้าง revert change ใหม่ที่ audited — ห้ามแก้ history**; historical bills/snapshots ไม่เปลี่ยน
- **F2.6 Edit becomes new Product [①⑤]:** ห้ามแก้ Product จนเป็น "คนละตัวเชิงพาณิชย์" เพียงเพื่อรักษา ID เดิม — เมื่อเปลี่ยน material commercial identity ต้อง: **create new → publish new → archive/retire old**; ตัวอย่างเข้าเงื่อนไข: แนวคิดต่างสิ้นเชิง / BOM ที่เป็นสินค้าอื่น / tax-accounting nature ต่าง / Product Type ต่าง / เปลี่ยน SKU resale เป็นตัวอื่น / ทำ sales history เดิมให้เข้าใจผิด; ไม่เข้าเงื่อนไข: แก้สะกด/รูปใหม่/คำอธิบาย/ปรับสูตรปกติใน identity เดิม/เปลี่ยนราคา/seasonal placement; ระบบเตือน impact + ให้ผู้มีสิทธิ์เลือก (edit / new version / new Product+archive); **high-risk identity change = new Product บังคับ**
- **F2.7 Active channel behavior [①]:** เมื่อ edit มีผล: channel ไม่มี override ใช้ค่า canonical ใหม่ · override ที่ valid คงอยู่ · ระบบแสดงว่า override ต่างจาก canonical แล้วหรือไม่ · **ห้าม channel คัดลอก edit เป็น override อิสระเงียบๆ** · ออเดอร์ที่รับแล้วคง snapshot เดิม
- **F2.8 Failure state [①]:** validation fail/publish ไม่สำเร็จ → effective Product เดิมคงอยู่ · edit ค้างเป็น DRAFT/FAILED · channels ใช้ last valid effective state ต่อ · ระบบอธิบาย blocking issue ชัด · **ห้าม partial publication ข้าม channels** เว้น channel-scoped change ที่ตั้งใจ+อนุมัติชัด

**F2 Flow Summary (16 attributes):** Trigger=correction/content update/commercial change/structural proposal · Actor=authorized human/AI draft ที่มนุษย์ review · Permission=field/domain-specific · Draft=risk-based (sensitive=controlled draft เสมอ) · Validation=field + impact + conflict analysis · Approval=capability+risk+governance · Effective=immediate/scheduled หลัง explicit publication เท่านั้น · Executor=authorized human/SYSTEM approved schedule · Audit=complete change-set history · Failure=old state live, change retained w/ errors · Rollback=new audited revert change, never rewrite history · Notifications=review/approval/publication/failure/affected-scope ตาม config · SoT=canonical effective state + immutable change history · Scope=canonical propagate ผ่าน projections เว้นมี valid override · Staff UX=แสดง current effective แยกจาก pending draft · Founder gate=ตาม policy สำหรับ high-impact commercial/identity changes

### Confirmed Platform Rules from F1–F2 (12 ข้อ)
(1) ทุก Product เริ่มเป็น DRAFT · (2) save ≠ publish · (3) creation ไม่ขึ้นเมนูอัตโนมัติ · (4) fast-track ย่อขั้นตอนได้ ห้าม bypass invariants · (5) Product/Recipe สร้างลำดับใดก็ได้ แต่ขายต้อง relationships valid ครบ · (6) branch proposals/imports/AI outputs ไม่มีวัน effective อัตโนมัติ · (7) canonical edits ต้องมี impact preview · (8) sensitive edits ใช้ controlled draft + approval · (9) rollback = decision ใหม่ ไม่แก้ historical truth · (10) สินค้าที่ต่างเชิงพาณิชย์ต้องได้ identity ใหม่ · (11) ออเดอร์ที่รับแล้วไม่ถูกเปลี่ยนโดย edit อนาคต · (12) edit ที่ fail ทิ้ง prior valid state ให้ active ต่อ

**FROZEN AFTER APPROVAL:** NO — DRAFT; Flows 1–2 recorded; Flows 3–18 pending

---

## 5. Menu Management Workflow

**REQUIRED INPUT:**
_(pending Founder input)_

**PROPOSED DEFAULT:**
_(none — awaiting input)_

**FOUNDER DECISION:**
_(pending)_

**FROZEN AFTER APPROVAL:** NO

---

## 6. Channels (Store / POS / Delivery / Customer App)

**REQUIRED INPUT:**
_(pending Founder input)_

**PROPOSED DEFAULT:**
_(none — awaiting input)_

**FOUNDER DECISION:**
_(pending)_

**FROZEN AFTER APPROVAL:** NO

---

## 7. Branch-specific Availability

**REQUIRED INPUT:**
_(pending Founder input)_

**PROPOSED DEFAULT:**
_(none — awaiting input)_

**FOUNDER DECISION:**
_(pending)_

**FROZEN AFTER APPROVAL:** NO

---

## 8. Pricing Ownership

**REQUIRED INPUT:**
_(pending Founder input)_

**PROPOSED DEFAULT:**
_(none — awaiting input)_

**FOUNDER DECISION:**
_(pending)_

**FROZEN AFTER APPROVAL:** NO

---

## 9. Product Lifecycle

**REQUIRED INPUT:**
_(pending Founder input)_

**PROPOSED DEFAULT:**
_(none — awaiting input)_

**FOUNDER DECISION:**
_(pending)_

**FROZEN AFTER APPROVAL:** NO

---

## 10. Approval & Publishing Workflow

**REQUIRED INPUT:**
_(pending Founder input)_

**PROPOSED DEFAULT:**
_(none — awaiting input)_

**FOUNDER DECISION:**
_(pending)_

**FROZEN AFTER APPROVAL:** NO

---

## 11. Image & Content Ownership

**REQUIRED INPUT:**
_(pending Founder input)_

**PROPOSED DEFAULT:**
_(none — awaiting input)_

**FOUNDER DECISION:**
_(pending)_

**FROZEN AFTER APPROVAL:** NO

---

## 12. Reporting Requirements

**REQUIRED INPUT:**
_(pending Founder input)_

**PROPOSED DEFAULT:**
_(none — awaiting input)_

**FOUNDER DECISION:**
_(pending)_

**FROZEN AFTER APPROVAL:** NO

---

## 13. Integration Boundaries

**REQUIRED INPUT:**
_(pending Founder input)_

**PROPOSED DEFAULT:**
_(none — awaiting input)_

**FOUNDER DECISION:**
_(pending)_

**FROZEN AFTER APPROVAL:** NO

---

## 14. Migration Boundaries

**REQUIRED INPUT:**
_(pending Founder input)_

**PROPOSED DEFAULT:**
_(none — awaiting input)_

**FOUNDER DECISION:**
_(pending)_

**FROZEN AFTER APPROVAL:** NO

---

## 15. Scalability & SaaS Requirements

**REQUIRED INPUT:**
_(pending Founder input)_

**PROPOSED DEFAULT:**
_(none — awaiting input)_

**FOUNDER DECISION:**
_(pending)_

**FROZEN AFTER APPROVAL:** NO

---

## 16. Phase Plan

**REQUIRED INPUT:**
_(pending Founder input)_

**PROPOSED DEFAULT:**
_(none — awaiting input)_

**FOUNDER DECISION:**
_(pending)_

**FROZEN AFTER APPROVAL:** NO

---

## 17. Exclusions

**REQUIRED INPUT:**
_(pending Founder input)_

**PROPOSED DEFAULT:**
_(none — awaiting input)_

**FOUNDER DECISION:**
_(pending)_

**FROZEN AFTER APPROVAL:** NO

---

## 18. Acceptance Criteria

**REQUIRED INPUT:**
_(pending Founder input)_

**PROPOSED DEFAULT:**
_(none — awaiting input)_

**FOUNDER DECISION:**
_(pending)_

**FROZEN AFTER APPROVAL:** NO
