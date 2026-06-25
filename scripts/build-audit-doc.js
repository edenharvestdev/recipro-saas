const fs = require('fs');
const { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  HeadingLevel, BorderStyle, WidthType, ShadingType, AlignmentType } = require('docx');

const FONT = 'Tahoma';
const CW = 9360; // content width US Letter 1" margins

const border = { style: BorderStyle.SINGLE, size: 1, color: 'CCCCCC' };
const borders = { top: border, bottom: border, left: border, right: border };
const cellMargins = { top: 60, bottom: 60, left: 120, right: 120 };

function h1(t) { return new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun(t)] }); }
function h2(t) { return new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun(t)] }); }
function p(t, opts = {}) { return new Paragraph({ spacing: { after: 80 }, children: [new TextRun({ text: t, ...opts })] }); }
function spacer() { return new Paragraph({ children: [new TextRun('')] }); }

// ตารางเช็คลิสต์: คอลัมน์ [✔ | รายการ | หมายเหตุ/วิธีแก้]
function checklistTable(headRight, rows, wItem = 5400) {
  const wCheck = 720, wNote = CW - wCheck - wItem;
  const head = new TableRow({
    tableHeader: true,
    children: [
      cell('✔', wCheck, true, 'center'),
      cell('รายการ', wItem, true),
      cell(headRight, wNote, true),
    ],
  });
  const body = rows.map(r => new TableRow({
    children: [
      cell('', wCheck),
      cell(r[0], wItem),
      cell(r[1] || '', wNote),
    ],
  }));
  return new Table({ width: { size: CW, type: WidthType.DXA }, columnWidths: [wCheck, wItem, wNote], rows: [head, ...body] });
}
function cell(text, w, headerStyle, align) {
  return new TableCell({
    borders, width: { size: w, type: WidthType.DXA }, margins: cellMargins,
    shading: headerStyle ? { fill: 'E8E2D5', type: ShadingType.CLEAR } : undefined,
    children: [new Paragraph({ alignment: align === 'center' ? AlignmentType.CENTER : AlignmentType.LEFT,
      children: [new TextRun({ text: String(text), bold: !!headerStyle })] })],
  });
}

// ---------- ข้อมูล ----------
const dupKeep = [
  'Aged Honey Lime & Plum', 'Clear Hojicha', 'Coconut Milk Whisk Latte',
  'Honey Lemon Soda', 'Honey Lime Soda', 'Jasmine Thai Tea x Matcha Latte',
];
const dupDecide = [
  ['Jasmine Thai Tea Mochi', 'ทั้งคู่ไม่สมบูรณ์ — รวมเป็นอันเดียว ใส่ส่วนผสม + ตั้งราคา (ตอนนี้ราคา 0)'],
  ['Orange Yuzu Soda', 'มี 2 อัน: อันหนึ่ง 4 ส่วนผสมไม่มีรูป / อีกอัน 2 ส่วนผสมมีรูป — เลือกเก็บอันที่ถูก ลบอีกอัน'],
];
const drinksNoImg = [
  'Aged Honey Lime & Plum','Clear Hojicha','Clear Matcha','Clear Matcha Chrysanthemum','Clear Matcha Coconut',
  'Clear Matcha Coconut Jasmine Tea','Coconut Milk Whisk Latte','Coconut on Cloud','Hibi Cold Whisk Latte',
  'Hojicha Latte (Milk Whisk)','Honey Lemon Soda','Honey Lime Soda','Ichigo Ume Refresher','Jasmine Thai Tea',
  'Jasmine Thai Tea Mochi','Jasmine Thai Tea x Matcha Latte','Kirei Yuzu Matcha','Kokoro Hojicha Honey Comb Velvet',
  'Matcha Cheesecake Cloud','Matcha Cloud Latte','Matcha Cream Cheese Latte','Matcha Honey Lemon (Home Made)',
  'Matcha Honey Lime (Home Made)','Matcha Latte Milk Mochi','Matcha Latte (Milk Whisk)','Matcha Mango Latte',
  'Matcha Milk Mochi Red Bean Latte','Matcha Milk Mochi Taro Latte','Matcha Strawberry Latte',
  'Matcha Velvet Whisk Latte Cold Foam','Orange Yuzu Soda','Osmanthus Honey Coconut','Osmanthus Matcha Latte',
];
const optNoImg = [
  'Set แก้ว Clear 16 Oz','Set แก้ว Clear 8 Oz','Set แก้ว Hibi Cold Whisk','Set แก้ว Latte 16 Oz','Set แยกน้ำแข็ง Latte',
  'Topping Caramel Comb Toffee Crispy','Topping Cream Cheese','Topping Crispy Coco','Topping Fresh Strawberry Honey',
  'Topping Mango Puree','Topping Matcha Cheesecake Cloud','Topping Matcha Cloud','Topping Milk Mochi',
  'Topping Red Bean Puree','Topping Taro Puree','Topping Velvet Milk Foam','ดอกเก๊กฮวยแแห้ง 0.5g','ดอกหอมหมื่นลี้แห้ง 0.5g',
];
const noCat = [
  'Basque Matcha Azuki Mochi','Black Truffle Financier','Citrus Noisette Financier','Maple Syrup Kejinou 1000ml',
  'Matcha Milk Mochi Brown Sugar Azuki','Matcha Milk Mochi Brown Sugar Chestnut','Matcha Mochi Kinako Caramel',
  'Matcha Yuzu Financier','Milk Caramel Custard Mochi','Mochi Butter Bun','Mochi Butter Bun 5ea/Pack','Osmantus syrup',
  'Peach Caramel Custard Mochi','Premium Banana Cheesecake','Premium Matcha Banana Cheesecake','Tiramisu Matcha (Homemade)',
  'Topping Caramel Comb Toffee Crispy','Topping Cream Cheese','Topping Mango Puree','Topping Matcha Cheesecake Cloud',
  'Topping Matcha Cloud','Topping Milk Mochi','Topping Red Bean Puree','Topping Taro Puree','Topping Velvet Milk Foam',
  'Truffle Noir Basque','ช้อนโมจิ สีดำ (100ชิ้น/แพ็ค)','ไซหรับส้มยูซุ','ถ้วยพุดดิ้ง 100ml.','แยมซากุระ 780 g.',
];
const noPrice = ['Jasmine Thai Tea Mochi','Set แก้ว Clear 16 Oz','Set แก้ว Clear 8 Oz','Set แก้ว Hibi Cold Whisk','Set แก้ว Latte 16 Oz','ดอกเก๊กฮวยแแห้ง 0.5g','ดอกหอมหมื่นลี้แห้ง 0.5g'];
const noCost = ['Milk Caramel Custard Mochi','O-Matcha Sou','Peach Caramel Custard Mochi','Topping Caramel Comb Toffee Crispy','Topping Cream Cheese','Topping Mango Puree','Topping Matcha Cheesecake Cloud','Topping Matcha Cloud','Topping Milk Mochi','Topping Red Bean Puree','Topping Taro Puree','Topping Velvet Milk Foam','การ์ด Review Delivery','ดอกเก๊กฮวยแห้ง','น้ำเปล่า','เอโร่ หลอดงอน้ำตาลฟิล์ม 11มม 50 เส้น'];

const children = [];
children.push(new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun('ใบตรวจ & แก้ข้อมูลก่อนโคลนสาขา')] }));
children.push(p('ร้าน: HB05 — Nak Niwat48     |     สร้างเมื่อ: 25 มิ.ย. 2026', { italics: true, color: '666666' }));
children.push(p('คำแนะนำ: ทำตามทีละหัวข้อในแอป Recipro แล้วติ๊ก ✔ ในช่องซ้ายเมื่อแก้เสร็จ ทำให้ครบก่อนกดโคลนไปสาขาอื่น (ไม่งั้นข้อมูลที่ผิดจะถูกคัดลอกไปทุกสาขา)'));
children.push(spacer());

children.push(h1('1) ลบสูตรที่สร้างซ้ำ (สำคัญสุด — ทำก่อน)'));
children.push(p('มีเมนูที่ถูกสร้างซ้อนกัน 2 อันชื่อเดียวกัน อันที่ "ไม่มีส่วนผสม" คือของซ้ำที่ต้องลบ (ทั้งหมดยังไม่เคยขาย ลบได้ปลอดภัย).'));
children.push(p('วิธีทำ: เปิดหน้า "สูตร" ค้นชื่อด้านล่าง จะเจอ 2 อัน → เปิดดูทั้งคู่ → เก็บอันที่มีส่วนผสมครบ + ราคาถูกต้อง → ลบอันที่ส่วนผสมว่าง', { bold: true }));
children.push(checklistTable('สิ่งที่ต้องทำ', dupKeep.map(n => [n, 'ลบอันที่ไม่มีส่วนผสม (เก็บอันที่มีส่วนผสม)']), 4200));
children.push(spacer());
children.push(h2('1.1) 2 เมนูที่ต้องตัดสินใจเอง (ไม่ใช่อันว่างชัด ๆ)'));
children.push(checklistTable('รายละเอียด', dupDecide, 3000));
children.push(new Paragraph({ children: [new (require('docx').PageBreak)()] }));

children.push(h1('2) ใส่รูปเมนู (เครื่องดื่ม)'));
children.push(p('เปิดหน้า "สูตร" → เปิดเมนู → อัปโหลดรูป → บันทึก  (เมนูเหล่านี้ยังไม่มีรูป).'));
children.push(checklistTable('หมายเหตุ', drinksNoImg.map(n => [n, '']), 6000));
children.push(spacer());
children.push(h2('2.1) ของกลาง / ท็อปปิ้ง / เซ็ตแก้ว (ใส่รูปเฉพาะถ้าขายหน้าร้านจริง — ไม่บังคับ)'));
children.push(checklistTable('หมายเหตุ', optNoImg.map(n => [n, '']), 6000));
children.push(new Paragraph({ children: [new (require('docx').PageBreak)()] }));

children.push(h1('3) ระบุหมวดวัตถุดิบ (30 รายการ)'));
children.push(p('วัตถุดิบที่ยังไม่เลือก "หมวดสินค้า" — มีผลต่อการตัดสต๊อก/แสดงใน POS. เปิดหน้า "วัตถุดิบ" → เปิดรายการ → เลือกหมวด (วัตถุดิบ/ของขาย/บรรจุภัณฑ์/ของใช้ ฯลฯ) → บันทึก.'));
children.push(checklistTable('เลือกหมวดให้ถูก', noCat.map(n => [n, '']), 6000));
children.push(new Paragraph({ children: [new (require('docx').PageBreak)()] }));

children.push(h1('4) ตรวจราคา & ต้นทุน'));
children.push(h2('4.1) เมนูที่ราคาขาย = 0'));
children.push(p('ตั้งราคาขายให้ถูก หรือถ้าเป็น "ของกลาง" (ไม่ขายหน้าร้าน) ให้ปิด "นำขึ้นเมนู".'));
children.push(checklistTable('ตั้งราคา หรือ ปิดนำขึ้นเมนู', noPrice.map(n => [n, '']), 6000));
children.push(spacer());
children.push(h2('4.2) วัตถุดิบที่ราคาทุน = 0'));
children.push(p('ส่วนใหญ่เป็นท็อปปิ้ง/ของกลางที่คิดทุนผ่านสูตรย่อยอยู่แล้ว (ปกติ) — ตรวจเฉพาะตัวที่ควรมีทุนจริง เช่น น้ำเปล่า/หลอด/การ์ด.'));
children.push(checklistTable('ใส่ราคาทุนถ้าควรมี', noCost.map(n => [n, '']), 6000));
children.push(spacer());

children.push(h1('5) อื่น ๆ'));
children.push(checklistTable('สิ่งที่ต้องทำ', [
  ['วัตถุดิบชื่อซ้ำ: "Crispy coco แบบป่น 500g"', 'มี 2 รายการชื่อเดียวกัน — รวมเป็นอันเดียว/ลบตัวซ้ำ'],
  ['ส่วนผสมว่างในสูตร (2 จุด)', 'เปิดสูตรที่มีบรรทัดส่วนผสมว่าง (ไม่ได้เลือกวัตถุดิบ) แล้วลบบรรทัดนั้น'],
], 5000));
children.push(spacer());
children.push(p('เมื่อแก้ครบทุกข้อแล้ว แจ้งกลับเพื่อเริ่ม "โคลนไปสาขาอื่น" ได้เลย ✅', { bold: true }));

const doc = new Document({
  styles: {
    default: { document: { run: { font: FONT, size: 22 } } },
    paragraphStyles: [
      { id: 'Title', name: 'Title', basedOn: 'Normal', next: 'Normal', quickFormat: true,
        run: { size: 40, bold: true, font: FONT, color: '3A2A00' }, paragraph: { spacing: { after: 120 } } },
      { id: 'Heading1', name: 'Heading 1', basedOn: 'Normal', next: 'Normal', quickFormat: true,
        run: { size: 30, bold: true, font: FONT, color: '7A5C00' }, paragraph: { spacing: { before: 240, after: 120 }, outlineLevel: 0 } },
      { id: 'Heading2', name: 'Heading 2', basedOn: 'Normal', next: 'Normal', quickFormat: true,
        run: { size: 25, bold: true, font: FONT }, paragraph: { spacing: { before: 160, after: 80 }, outlineLevel: 1 } },
    ],
  },
  sections: [{
    properties: { page: { size: { width: 12240, height: 15840 }, margin: { top: 1080, right: 1080, bottom: 1080, left: 1080 } } },
    children,
  }],
});
Packer.toBuffer(doc).then(buf => { fs.writeFileSync(process.env.OUT, buf); console.log('WROTE', process.env.OUT, buf.length, 'bytes'); });
