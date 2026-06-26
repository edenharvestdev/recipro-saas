const fs = require('fs');
const { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, HeadingLevel, BorderStyle, WidthType, ShadingType, AlignmentType, PageBreak } = require('docx');
const FONT = 'Tahoma', CW = 9360;
const bd = { style: BorderStyle.SINGLE, size: 1, color: 'CCCCCC' }, borders = { top: bd, bottom: bd, left: bd, right: bd }, mg = { top: 60, bottom: 60, left: 110, right: 110 };
const title = t => new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun(t)] });
const h1 = t => new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun(t)] });
const h2 = t => new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun(t)] });
const p = (t, o = {}) => new Paragraph({ spacing: { after: 80 }, children: [new TextRun({ text: t, ...o })] });
const bullet = t => new Paragraph({ bullet: { level: 0 }, spacing: { after: 40 }, children: [new TextRun(t)] });
const sp = () => new Paragraph({ children: [new TextRun('')] });
function cell(t, w, head, al) {
  return new TableCell({ borders, width: { size: w, type: WidthType.DXA }, margins: mg, shading: head ? { fill: 'E8E2D5', type: ShadingType.CLEAR } : undefined, children: [new Paragraph({ alignment: al === 'c' ? AlignmentType.CENTER : al === 'r' ? AlignmentType.RIGHT : AlignmentType.LEFT, children: [new TextRun({ text: String(t), bold: !!head })] })] });
}
function table(headers, rows, widths) {
  const head = new TableRow({ tableHeader: true, children: headers.map((h, i) => cell(h, widths[i], true, i === 0 ? 'l' : 'c')) });
  const body = rows.map(r => new TableRow({ children: r.map((c, i) => cell(c, widths[i], false, i === 0 ? 'l' : 'r')) }));
  return new Table({ width: { size: CW, type: WidthType.DXA }, columnWidths: widths, rows: [head, ...body] });
}
const baht = n => n.toLocaleString('th-TH');

const ch = [];
ch.push(title('Recipro — โมเดลราคา & ประมาณการรายได้'));
ch.push(p('เอกสารวางแผนการตลาดและงบประมาณรายได้ล่วงหน้า  ·  ปรับสมมติฐานได้ตามจริง', { italics: true, color: '666666' }));
ch.push(p('จัดทำ 25 มิ.ย. 2026', { italics: true, color: '999999' }));
ch.push(sp());

ch.push(h1('1) แพ็กเกจ & ราคา'));
ch.push(table(
  ['แพ็กเกจ', 'ราคา/เดือน', 'ราคา/ปี', 'กลุ่มเป้าหมาย'],
  [
    ['Starter', '299 ฿', '2,990 ฿', 'ร้านเล็ก เพิ่งเริ่ม / ทำคนเดียว'],
    ['Pro', '590 ฿', '5,900 ฿', 'ร้านมีพนักงาน ต้องการบัญชี/รายงานครบ'],
    ['Premium', '990 ฿', '9,900 ฿', 'ร้านหลายสาขา / เครือ'],
  ],
  [2200, 1800, 1800, 3560]
));
ch.push(sp());
ch.push(h2('ฟีเจอร์แต่ละแพ็กเกจ'));
ch.push(table(
  ['ฟีเจอร์', 'Starter', 'Pro', 'Premium'],
  [
    ['ขายหน้าร้าน POS + ตัดสต๊อก', '✓', '✓', '✓'],
    ['สูตร/ต้นทุน + ของขายตรง', '✓', '✓', '✓'],
    ['สมาชิก/แต้มสะสม', '✓', '✓', '✓'],
    ['บัญชี/รายงานเต็ม + เงินสดย่อย', '—', '✓', '✓'],
    ['VAT / ใบกำกับภาษีอย่างย่อ', '—', '✓', '✓'],
    ['QR ลูกค้าสแกนสั่ง/ดูเมนู', '—', '✓', '✓'],
    ['ตรวจนับสต๊อก + ใบสั่งซื้อ', '—', '✓', '✓'],
    ['หลายสาขา + ภาพรวมรวม', '—', '—', '✓'],
    ['โคลนร้าน + สิทธิ์พนักงานละเอียด', '—', '—', '✓'],
  ],
  [4360, 1666, 1666, 1668]
));
ch.push(sp());
ch.push(h2('ลิมิตการใช้งาน (ครอบคลุมค่าเก็บดาต้า)'));
ch.push(table(
  ['ลิมิต', 'Starter', 'Pro', 'Premium'],
  [
    ['สาขา', '1', '1', 'ไม่จำกัด (สูงสุด 99)'],
    ['พนักงาน', '2', '10', 'ไม่จำกัด'],
    ['รายการสินค้า', '200', 'ไม่จำกัด', 'ไม่จำกัด'],
    ['รูปภาพ', '200', '2,000', 'ไม่จำกัด'],
  ],
  [3360, 2000, 2000, 2000]
));
ch.push(sp());

ch.push(h1('2) นโยบายการขาย'));
ch.push(bullet('ทดลองฟรี 30 วัน — ให้เวลาตั้งระบบ (ลงสต๊อก/สูตร) จนเห็นคุณค่าก่อนตัดสินใจ'));
ch.push(bullet('รายปีจ่าย 10 เดือน ได้ใช้ 12 เดือน (≈ ลด 17%) — เพิ่มเงินสดเข้าเร็ว + ลูกค้าอยู่นานขึ้น'));
ch.push(bullet('หมดอายุแบบขั้นบันได: เลยกำหนด ≤ 5 วัน = จอจาง + เตือนต่ออายุ (ยังใช้ได้) → เกิน 5 วัน = อ่านได้อย่างเดียว ขายไม่ได้ (ข้อมูลไม่หาย)'));
ch.push(bullet('วิธีเก็บเงิน: ตอนนี้รับโอน/พร้อมเพย์ (แอดมินกดต่ออายุให้) — รองรับตัดบัตรอัตโนมัติ (Omise/Stripe) ภายหลังเมื่อพร้อม'));
ch.push(sp());

ch.push(h1('3) เหตุผลของราคา (Positioning)'));
ch.push(bullet('ตลาดไทย: Loyverse ฟรี-ถูก · Ocha/Page365 ฟรี-หลักร้อย · FoodStory/StoreHub ~1,000–2,000 ฿/เดือน'));
ch.push(bullet('Recipro อยู่กลาง-บน เพราะมากกว่า POS เปล่า: คิดต้นทุน/กำไรต่อเมนู + ตัดสต๊อกอัตโนมัติ + รองรับหลายอุตสาหกรรม + ภาษาไทยเต็ม'));
ch.push(bullet('Starter ตั้งถูก (299) เพื่อลดแรงต้านร้านที่ไม่เคยมีระบบ → ใช้ติดแล้วอัปเป็น Pro (เส้นทางรายได้โต)'));
ch.push(bullet('จุดขายซัพพอร์ตไทย + ความสัมพันธ์ตัวแทน = กำหนดราคาเหนือของฟรีได้'));
ch.push(new Paragraph({ children: [new PageBreak()] }));

ch.push(h1('4) ประมาณการรายได้ — 3 ฉากทัศน์ (ณ เดือนที่ 12)'));
ch.push(p('สมมติฐานสัดส่วนแพ็กเกจ (mix): Starter 50% · Pro 40% · Premium 10%', { bold: true }));
ch.push(p('รายได้เฉลี่ยต่อร้าน/เดือน (ARPU) = 0.5×299 + 0.4×590 + 0.1×990 ≈ 485 ฿', {}));
ch.push(sp());
ch.push(table(
  ['ฉากทัศน์', 'ร้านจ่ายเงิน', 'รายได้/เดือน (MRR)', 'รายได้/ปี (ARR)'],
  [
    ['ระมัดระวัง (Conservative)', '20 ร้าน', baht(20 * 485) + ' ฿', baht(20 * 485 * 12) + ' ฿'],
    ['ฐาน (Base)', '50 ร้าน', baht(50 * 485) + ' ฿', baht(50 * 485 * 12) + ' ฿'],
    ['ก้าวกระโดด (Aggressive)', '120 ร้าน', baht(120 * 485) + ' ฿', baht(120 * 485 * 12) + ' ฿'],
  ],
  [3360, 2000, 2000, 2000]
));
ch.push(p('* MRR = Monthly Recurring Revenue (รายได้ประจำต่อเดือน) · ARR = รายปี', { italics: true, color: '777777', size: 18 }));
ch.push(sp());

ch.push(h2('ตารางแรมป์ 12 เดือน (ฉากฐาน — โต ~50 ร้าน)'));
const ramp = [3, 6, 10, 15, 20, 26, 32, 37, 41, 45, 48, 50];
ch.push(table(
  ['เดือน', 'ร้านสะสม', 'MRR (฿)'],
  ramp.map((s, i) => ['เดือน ' + (i + 1), String(s), baht(s * 485)]),
  [2360, 3000, 4000]
));
ch.push(p('สมมติ churn ~5%/เดือน (ลูกค้าหลุดบางส่วน) — ตัวเลขจริงปรับตามการตลาด/ซัพพอร์ต', { italics: true, color: '777777', size: 18 }));
ch.push(new Paragraph({ children: [new PageBreak()] }));

ch.push(h1('5) ค่าเก็บดาต้า & แผนรองรับ 500 ร้าน (เป้า 1 ปี)'));
ch.push(p('เป้าหมาย: 500 ร้านภายใน 1 ปี (≈ ปิดการขายเฉลี่ย 42 ร้าน/เดือน)', { bold: true }));
ch.push(h2('ต้นทุนค่าเก็บดาต้า (ตัวขับหลัก = รูปภาพ)'));
ch.push(bullet('รูปบีบอัดแล้ว ~60 KB/รูป (ระบบย่อให้อัตโนมัติ)'));
ch.push(bullet('พื้นที่เฉลี่ย/ร้าน (mix 50/40/10): Starter ~12MB · Pro ~120MB · Premium ~300MB → เฉลี่ย ~84 MB/ร้าน'));
ch.push(bullet('500 ร้าน ≈ 42 GB → ค่าเก็บข้อมูล ~400–470 ฿/เดือน (< 0.2% ของรายได้ 500 ร้าน)'));
ch.push(p('สรุป: ลิมิตรูป/สินค้าตามแพ็กเกจ ทำให้ต้นทุนเก็บดาต้าคุมได้และเล็กมากเทียบรายได้', { bold: true }));
ch.push(h2('สิ่งที่ควรทำก่อนโตถึง ~100 ร้าน (เชิงเทคนิค)'));
ch.push(bullet('ย้ายรูปออกจากฐานข้อมูล → ที่เก็บไฟล์แยก (object storage) — ลดขนาด DB, โหลดเร็วขึ้น, สำรองเบาลง'));
ch.push(bullet('ตั้ง Cron จริง (Railway) สำหรับพักร้านค้างชำระ + อีเมลเตือนอัตโนมัติ'));
ch.push(bullet('เปิดจ่ายบัตรอัตโนมัติ (Omise/Stripe) — ลดงานต่ออายุ manual เมื่อมีร้านจำนวนมาก'));
ch.push(p('รายได้ที่ 500 ร้าน (mix 50/40/10): MRR ≈ 242,500 ฿ · ARR ≈ 2.9 ล้านบาท', { bold: true, color: '7A5C00' }));
ch.push(sp());

ch.push(h1('6) งบประมาณ/ต้นทุน (คร่าว ๆ ต่อเดือน)'));
ch.push(table(
  ['รายการ', 'ประมาณการ', 'หมายเหตุ'],
  [
    ['โฮสติ้ง (Railway + DB)', '500–1,500 ฿', 'โตตามจำนวนร้าน/ข้อมูล'],
    ['โดเมน/อีเมล', '~100 ฿', 'รายปีเฉลี่ย'],
    ['ค่าธรรมเนียมบัตร', '~3.65%/รายการ', 'เฉพาะจ่ายผ่านบัตร — โอน/พร้อมเพย์ = 0'],
    ['ซัพพอร์ต/ทีม', 'ตามจริง', 'เวลาตั้งระบบให้ลูกค้า + ดูแล'],
  ],
  [3360, 2400, 3600]
));
ch.push(p('SaaS มี gross margin สูง (ต้นทุนผันแปรต่อร้านต่ำ) — กำไรขั้นต้นเพิ่มเร็วเมื่อจำนวนร้านโต', { bold: true }));
ch.push(sp());

ch.push(h1('7) มุมการตลาด / จุดขาย'));
ch.push(bullet('"รู้ต้นทุน-กำไรทุกแก้ว" — ขายด้วยการคุมต้นทุน ไม่ใช่แค่ออกบิล'));
ch.push(bullet('"ตั้งระบบใน 10 นาที" — Wizard + เช็คลิสต์เริ่มต้น ลดความกลัวของร้านที่ไม่เคยมีระบบ'));
ch.push(bullet('"ย้ายข้อมูลให้ฟรี" — บริการ import/โคลน ช่วยร้านที่มีข้อมูลเดิม (ปิดการขายง่าย)'));
ch.push(bullet('โปรเปิดตัว: ทดลอง 30 วัน + ส่วนลดรายปี + แนะนำเพื่อนได้เครดิต'));
ch.push(bullet('ขยายเป็น tier: เริ่ม Starter ราคาเข้าถึงง่าย → อัปเป็น Pro/Premium เมื่อร้านโต (เพิ่ม ARPU)'));
ch.push(sp());
ch.push(p('หมายเหตุ: ราคา/ฟีเจอร์ปรับได้ในระบบหลังบ้าน (Super Admin → จัดการแพ็กเกจ) — เอกสารนี้เป็นจุดตั้งต้นสำหรับวางแผน', { italics: true, color: '777777' }));

const doc = new Document({
  styles: {
    default: { document: { run: { font: FONT, size: 22 } } },
    paragraphStyles: [
      { id: 'Title', name: 'Title', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { size: 40, bold: true, font: FONT, color: '3A2A00' }, paragraph: { spacing: { after: 120 } } },
      { id: 'Heading1', name: 'Heading 1', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { size: 30, bold: true, font: FONT, color: '7A5C00' }, paragraph: { spacing: { before: 220, after: 120 }, outlineLevel: 0 } },
      { id: 'Heading2', name: 'Heading 2', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { size: 24, bold: true, font: FONT }, paragraph: { spacing: { before: 140, after: 70 }, outlineLevel: 1 } },
    ],
  },
  sections: [{ properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 1080, right: 1080, bottom: 1080, left: 1080 } } }, children: ch }],
});
Packer.toBuffer(doc).then(b => { fs.writeFileSync(process.env.OUT, b); console.log('WROTE', process.env.OUT, b.length); });
