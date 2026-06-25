const fs = require('fs');
const { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, HeadingLevel, BorderStyle, WidthType, ShadingType, AlignmentType, PageBreak } = require('docx');
const FONT = 'Tahoma', CW = 9360;
const bd = { style: BorderStyle.SINGLE, size: 1, color: 'CCCCCC' }, borders = { top: bd, bottom: bd, left: bd, right: bd }, mg = { top: 60, bottom: 60, left: 120, right: 120 };
const h1 = t => new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun(t)] });
const h2 = t => new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun(t)] });
const p = (t, o = {}) => new Paragraph({ spacing: { after: 80 }, children: [new TextRun({ text: t, ...o })] });
const sp = () => new Paragraph({ children: [new TextRun('')] });
function cell(t, w, head, al) { return new TableCell({ borders, width: { size: w, type: WidthType.DXA }, margins: mg, shading: head ? { fill: 'E8E2D5', type: ShadingType.CLEAR } : undefined, children: [new Paragraph({ alignment: al === 'c' ? AlignmentType.CENTER : AlignmentType.LEFT, children: [new TextRun({ text: String(t), bold: !!head })] })] }); }
function checklist(headRight, rows, wItem) {
  const wC = 620, wI = wItem || 4600, wN = CW - wC - wI;
  const head = new TableRow({ tableHeader: true, children: [cell('✔', wC, true, 'c'), cell('รายการ', wI, true), cell(headRight, wN, true)] });
  const body = rows.map(r => new TableRow({ children: [cell('', wC), cell(r[0], wI), cell(r[1] || '', wN)] }));
  return new Table({ width: { size: CW, type: WidthType.DXA }, columnWidths: [wC, wI, wN], rows: [head, ...body] });
}

const emptyDup = ['Basque Matcha Azuki Mochi', 'Black Truffle Financier', 'Citrus Noisette Financier', 'Matcha Milk Mochi Brown Sugar Azuki', 'Matcha Noisette Financier', 'Matcha Yuzu Financier', 'Noisette Financier', 'Tiramisu Matcha (Homemade)', 'Topping Caramel Comb Toffee Crispy', 'Topping Velvet Milk Foam', 'Truffle Noir Basque'];
const emptyNoDup = ['Classic Tiramisu (Homemade)', 'Ichigo Ume Refresher', 'Jasmine Thai Tea Mochi', 'Kokoro Hojicha Honey Comb Velvet', 'Matcha Tiramisu Lady', 'Matcha Velvet Whisk Latte Cold Foam'];
const zeroPrice = ['Set แก้ว Clear 16 Oz', 'Set แก้ว Clear 8 Oz', 'Set แก้ว Hibi Cold Whisk', 'Set แก้ว Latte 16 Oz', 'ดอกเก๊กฮวยแแห้ง 0.5g', 'ดอกหอมหมื่นลี้แห้ง 0.5g'];
const noCat = ['Basque Matcha Azuki Mochi', 'Black Truffle Financier', 'Citrus Noisette Financier', 'Maple Syrup Kejinou 1000ml', 'Matcha Milk Mochi Brown Sugar Azuki', 'Matcha Milk Mochi Brown Sugar Chestnut', 'Matcha Mochi Kinako Caramel', 'Matcha Yuzu Financier', 'Milk Caramel Custard Mochi', 'Mochi Butter Bun', 'Mochi Butter Bun 5ea/Pack', 'Osmantus syrup', 'Peach Caramel Custard Mochi', 'Premium Banana Cheesecake', 'Premium Matcha Banana Cheesecake', 'Tiramisu Matcha (Homemade)', 'Topping Caramel Comb Toffee Crispy', 'Topping Cream Cheese', 'Topping Mango Puree', 'Topping Matcha Cheesecake Cloud', 'Topping Matcha Cloud', 'Topping Milk Mochi', 'Topping Red Bean Puree', 'Topping Taro Puree', 'Topping Velvet Milk Foam', 'Truffle Noir Basque', 'ช้อนโมจิ สีดำ (100ชิ้น/แพ็ค)', 'ไซหรับส้มยูซุ', 'ถ้วยพุดดิ้ง 100ml.', 'แยมซากุระ 780 g.'];
const noCostNeed = ['การ์ด Review Delivery', 'ดอกเก๊กฮวยแห้ง', 'น้ำเปล่า', 'เอโร่ หลอดงอน้ำตาลฟิล์ม 11มม 50 เส้น'];
const noImg = ['Black Truffle Financier', 'Set แก้ว Clear 16 Oz', 'Set แก้ว Clear 8 Oz', 'Set แก้ว Hibi Cold Whisk', 'Set แก้ว Latte 16 Oz', 'Set แยกน้ำแข็ง Latte', 'ดอกเก๊กฮวยแแห้ง 0.5g', 'ดอกหอมหมื่นลี้แห้ง 0.5g'];

const ch = [];
ch.push(new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun('ใบตรวจแก้ข้อมูล (รอบ 2 — หลังกู้รูป)')] }));
ch.push(p('ร้าน: HB05 — Nak Niwat48   |   25 มิ.ย. 2026   |   วัตถุดิบ 108 · สูตร 74 · รูปเมนู 55 (เครื่องดื่มครบ)', { italics: true, color: '666666' }));
ch.push(p('ทำในแอป Recipro แล้วติ๊ก ✔ เมื่อแก้เสร็จ · โครงข้อมูลโดยรวมดี (ไม่มีสต๊อกติดลบ · ไม่มีสูตรซ้ำ)', {}));
ch.push(sp());

ch.push(h1('1) สูตรไม่มีส่วนผสม — 17 รายการ (สำคัญ: ต้นทุน=0 กำไรเพี้ยน)'));
ch.push(h2('1.1) ลงซ้ำกับ "วัตถุดิบ" ชื่อเดียวกัน — 11 รายการ'));
ch.push(p('มีทั้งใน "วัตถุดิบ" และ "สูตร(ว่าง)" → เลือก: ถ้าซื้อมาขาย/ทำเป็นของกลาง = ลบสูตรว่างทิ้ง (เก็บเป็นวัตถุดิบ/ของขาย) · ถ้าจะขายเป็นเมนูจริง = ใส่ส่วนผสม + ตั้งราคาในสูตร', { bold: true }));
ch.push(checklist('ทำ: ลบสูตรว่าง หรือ ใส่ส่วนผสม+ราคา', emptyDup.map(n => [n, ''])));
ch.push(sp());
ch.push(h2('1.2) ไม่ซ้ำวัตถุดิบ — 6 รายการ (เมนูจริงที่ยังไม่ลงส่วนผสม)'));
ch.push(p('ถ้าขายจริง → ใส่ส่วนผสม + ราคา · ถ้าไม่ขายแล้ว → ลบ', {}));
ch.push(checklist('ทำ: ใส่ส่วนผสม+ราคา หรือ ลบ', emptyNoDup.map(n => [n, ''])));
ch.push(new Paragraph({ children: [new PageBreak()] }));

ch.push(h1('2) เมนูราคา 0 — 6 รายการ'));
ch.push(p('ตั้งราคาขายให้ถูก หรือถ้าเป็นของกลาง/ชุดแก้ว (ไม่ขายตรง) ให้ปิด "นำขึ้นเมนู"', {}));
ch.push(checklist('ตั้งราคา หรือ ปิดนำขึ้นเมนู', zeroPrice.map(n => [n, ''])));
ch.push(sp());

ch.push(h1('3) วัตถุดิบยังไม่ระบุหมวด — 30 รายการ'));
ch.push(p('เปิดหน้า วัตถุดิบ → เปิดรายการ → เลือก "หมวดสินค้า" → บันทึก (มีผลต่อการตัดสต๊อก/แสดงใน POS)', {}));
ch.push(checklist('เลือกหมวดให้ถูก', noCat.map(n => [n, ''])));
ch.push(new Paragraph({ children: [new PageBreak()] }));

ch.push(h1('4) วัตถุดิบที่ควรมีราคาทุน แต่เป็น 0'));
ch.push(p('(ท็อปปิ้ง/ของกลางที่คิดทุนผ่านสูตรย่อยแล้ว ไม่ต้องแก้ — เฉพาะตัวด้านล่างที่ควรมีทุนจริง)', {}));
ch.push(checklist('ใส่ราคาทุน', noCostNeed.map(n => [n, ''])));
ch.push(sp());

ch.push(h1('5) อื่น ๆ'));
ch.push(checklist('สิ่งที่ต้องทำ', [
  ['วัตถุดิบชื่อซ้ำ: "Crispy coco แบบป่น 500g" (×2)', 'รวมเป็นอันเดียว / ลบตัวซ้ำ'],
  ['ส่วนผสมว่างในสูตร (2 จุด)', 'เปิดสูตรที่มีบรรทัดส่วนผสมไม่ได้เลือกวัตถุดิบ แล้วลบบรรทัดนั้น'],
], 5200));
ch.push(sp());

ch.push(h1('6) เมนูไม่มีรูป — 8 รายการ (ส่วนใหญ่เซ็ต/ของกลาง — ไม่บังคับ)'));
ch.push(p('เครื่องดื่มมีรูปครบแล้ว · 8 ตัวนี้เป็นชุดแก้ว/ของกลาง + Black Truffle Financier — ใส่รูปเฉพาะตัวที่ขายหน้าร้านจริง', {}));
ch.push(checklist('ใส่รูปถ้าขายจริง (ไม่บังคับ)', noImg.map(n => [n, ''])));
ch.push(sp());
ch.push(p('แก้ครบแล้วแจ้งกลับได้เลย ✅ (เปิดแอปแท็บเดียวพอ กันข้อมูลทับกัน)', { bold: true }));

const doc = new Document({
  styles: { default: { document: { run: { font: FONT, size: 22 } } }, paragraphStyles: [
    { id: 'Title', name: 'Title', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { size: 38, bold: true, font: FONT, color: '3A2A00' }, paragraph: { spacing: { after: 120 } } },
    { id: 'Heading1', name: 'Heading 1', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { size: 29, bold: true, font: FONT, color: '7A5C00' }, paragraph: { spacing: { before: 200, after: 110 }, outlineLevel: 0 } },
    { id: 'Heading2', name: 'Heading 2', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { size: 24, bold: true, font: FONT }, paragraph: { spacing: { before: 140, after: 70 }, outlineLevel: 1 } },
  ] },
  sections: [{ properties: { page: { size: { width: 12240, height: 15840 }, margin: { top: 1080, right: 1080, bottom: 1080, left: 1080 } } }, children: ch }],
});
Packer.toBuffer(doc).then(b => { fs.writeFileSync(process.env.OUT, b); console.log('WROTE', process.env.OUT, b.length); });
