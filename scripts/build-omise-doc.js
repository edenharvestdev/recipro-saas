const fs = require('fs');
const { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  HeadingLevel, BorderStyle, WidthType, ShadingType, AlignmentType, LevelFormat, PageBreak } = require('docx');
const FONT = 'Tahoma'; const CW = 9360;
const bd = { style: BorderStyle.SINGLE, size: 1, color: 'CCCCCC' };
const borders = { top: bd, bottom: bd, left: bd, right: bd };
const mg = { top: 60, bottom: 60, left: 120, right: 120 };
const h1 = t => new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun(t)] });
const h2 = t => new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun(t)] });
const p = (t, o = {}) => new Paragraph({ spacing: { after: 80 }, children: [new TextRun({ text: t, ...o })] });
const bullet = t => new Paragraph({ numbering: { reference: 'b', level: 0 }, spacing: { after: 40 }, children: [new TextRun(t)] });
const sp = () => new Paragraph({ children: [new TextRun('')] });
function cell(t, w, head) { return new TableCell({ borders, width: { size: w, type: WidthType.DXA }, margins: mg, shading: head ? { fill: 'E8E2D5', type: ShadingType.CLEAR } : undefined, children: [new Paragraph({ children: [new TextRun({ text: String(t), bold: !!head })] })] }); }
function table(headers, widths, rows) {
  const head = new TableRow({ tableHeader: true, children: headers.map((h, i) => cell(h, widths[i], true)) });
  const body = rows.map(r => new TableRow({ children: r.map((c, i) => cell(c, widths[i])) }));
  return new Table({ width: { size: CW, type: WidthType.DXA }, columnWidths: widths, rows: [head, ...body] });
}

const ch = [];
ch.push(new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun('ข้อเสนอความร่วมมือ & แนวทางเจรจา')] }));
ch.push(p('Recipro × Omise (Opn Payments) — สำหรับเสนอ/เจรจาผ่านคอนเนกชันหุ้นส่วน', { italics: true, color: '666666' }));
ch.push(p('จัดทำเพื่อ: ฝ่ายการเงิน (CFO) · เอกสารภายใน', { italics: true, color: '999999' }));
ch.push(sp());

ch.push(h1('1) สรุปสำหรับผู้บริหาร (Executive Summary)'));
ch.push(p('Recipro เป็นแพลตฟอร์ม SaaS บริหารจัดการร้าน (POS + สต๊อก + บัญชี + เมนูออนไลน์ + QR Box) สำหรับร้านอาหาร/คาเฟ่/รีเทล/โฮมเมด จำนวนมาก เราต้องการให้ระบบชำระเงินในตัว และมองหา “พันธมิตรเกตเวย์หลัก” ที่ให้เรทดี + API ดี + เงื่อนไขความร่วมมือระยะยาว.'));
ch.push(p('ข้อเสนอ: ร่วมมือกับ Omise/Opn ในฐานะ “ช่องทางพาผู้ค้าใหม่จำนวนมาก” (merchant acquisition channel) เข้าระบบ Omise — แลกกับ เรทพิเศษ/พาร์ทเนอร์ + ส่วนแบ่ง/ค่าแนะนำ (referral) + การสนับสนุนด้านเทคนิค.', { bold: true }));
ch.push(sp());

ch.push(h1('2) คุณค่าที่ Recipro มอบให้ Omise'));
['ช่องทางหาผู้ค้ารายใหม่จำนวนมาก (SME ร้านอาหาร/คาเฟ่/รีเทล) — ทุกร้านที่ใช้ Recipro = merchant ใหม่ของ Omise',
 'การกระจายในสเกล (distribution at scale) — onboarding ผ่านระบบ Recipro ลดต้นทุนการหาลูกค้าของ Omise',
 'วอลุ่มธุรกรรมต่อเนื่อง (recurring transaction volume) จากการขายหน้าร้าน + เมนูออนไลน์ + QR',
 'การ integrate แน่นกับ POS → ผู้ค้าผูกกับ Omise ระยะยาว (low churn)'].forEach(t => ch.push(bullet(t)));
ch.push(sp());

ch.push(h1('3) สิ่งที่ต้องการเจรจา (Negotiation Asks)'));
ch.push(table(['หัวข้อ', 'สิ่งที่ขอ', 'หมายเหตุ'], [2200, 4000, 3160], [
  ['เรทค่าธรรมเนียม (MDR)', 'เรทพิเศษต่ำกว่ามาตรฐาน โดยเฉพาะ PromptPay QR (ปกติ ~1.65%) และบัตร (~3.65%)', 'อิงวอลุ่มรวมของแพลตฟอร์ม ไม่ใช่ต่อร้าน'],
  ['โมเดล onboarding', 'API เปิดบัญชี merchant แบบ sub-merchant / หรือ referral ที่แต่ละร้านมีบัญชีของตัวเอง', 'เงินเข้าบัญชีร้านโดยตรง · Recipro ไม่เป็นตัวกลางรับเงิน (เลี่ยงภาระใบอนุญาต)'],
  ['ส่วนแบ่ง / ค่าแนะนำ', 'Revenue share หรือ referral fee ให้ Recipro ต่อร้าน/ต่อวอลุ่ม', 'โมเดลพาร์ทเนอร์มาตรฐานของเกตเวย์'],
  ['เทคนิค', 'Sandbox + production keys, webhook, sub-merchant onboarding API, เอกสาร, ผู้ติดต่อด้านเทคนิค', 'มีโครงต่อ Omise พร้อมแล้วฝั่ง Recipro'],
  ['Settlement / payout', 'รอบจ่ายเงินเร็ว (T+1/T+2) + รายงานกระทบยอด', '-'],
  ['การตลาดร่วม', 'Co-marketing / ตราพันธมิตร / รายชื่อในหน้า partner', 'เสริมความน่าเชื่อถือทั้งสองฝ่าย'],
]));
ch.push(new Paragraph({ children: [new PageBreak()] }));

ch.push(h1('4) โมเดลความร่วมมือที่เป็นไปได้'));
ch.push(table(['โมเดล', 'ลักษณะ', 'ข้อดี/ข้อควรระวัง'], [2200, 4000, 3160], [
  ['A. Referral / ISV partner (แนะนำ)', 'แต่ละร้านสมัครบัญชี Omise ของตัวเองผ่าน Recipro · Recipro ได้ค่าแนะนำ + เรทพิเศษ', 'ง่าย · ถูกกฎหมาย · เงินเข้าร้านตรง · เริ่มได้เร็ว'],
  ['B. Platform / Aggregator', 'Recipro รับเงินรวมแล้วจ่ายต่อให้ร้าน', 'คุมประสบการณ์ได้เต็ม แต่ภาระใบอนุญาต/กำกับสูง — ไม่แนะนำช่วงแรก'],
  ['C. White-label', 'ใช้เกตเวย์ Omise ใต้แบรนด์ Recipro', 'ภาพลักษณ์ดี · ต้องเจรจาเชิงลึก/วอลุ่มสูง'],
]));
ch.push(p('แนะนำเริ่มที่ A (Referral/ISV) — เริ่มเร็ว ความเสี่ยงต่ำ แล้วค่อยขยายเป็น C เมื่อวอลุ่มโต', { bold: true }));
ch.push(sp());

ch.push(h1('5) แนวทางติดต่อ/เจรจา (Outreach Plan)'));
['ใช้คอนเนกชันหุ้นส่วนที่รู้จักภายใน Omise เป็นผู้แนะนำ (warm intro) → นัดทีม Partnership/Business Development',
 'ส่งเอกสารฉบับนี้ + one-pager แนะนำ Recipro ก่อนประชุม',
 'ลงนาม NDA → แลกข้อมูลวอลุ่ม/แผน',
 'เจรจาเชิงพาณิชย์ (เรท + ส่วนแบ่ง + เงื่อนไข) → ทำสัญญาพาร์ทเนอร์',
 'เริ่ม integrate ด้วย test keys (โครงพร้อมแล้ว) → pilot กับร้านนำร่อง → ขยาย'].forEach(t => ch.push(bullet(t)));
ch.push(sp());

ch.push(h1('6) ข้อมูลที่ควรเตรียมไปคุย'));
['จำนวนร้านที่ใช้งานปัจจุบัน + คาดการณ์ 6–12 เดือน',
 'ประมาณการวอลุ่มธุรกรรม (GMV) / เดือน + ค่าเฉลี่ยต่อบิล',
 'สัดส่วน QR พร้อมเพย์ vs บัตร vs e-wallet (คาเฟ่มัก QR สูง)',
 'Timeline เปิดใช้ + จำนวนร้านนำร่อง',
 'จุดยืน: ต้องการเรท QR ที่แข่งขันได้ + ค่าแนะนำที่สมเหตุผล'].forEach(t => ch.push(bullet(t)));
ch.push(sp());

ch.push(h1('7) คำถามที่ควรถาม Omise'));
['เรทพาร์ทเนอร์/วอลุ่มดิสเคานต์ — โครงสร้างเป็นอย่างไร เริ่มที่วอลุ่มเท่าไร?',
 'มี API เปิด/จัดการ sub-merchant สำหรับแพลตฟอร์มไหม?',
 'โมเดล referral / revenue share มีหรือไม่ จ่ายอย่างไร?',
 'รอบ settlement + ค่าธรรมเนียมแฝงอื่น (ถอนเงิน/refund/chargeback)?',
 'ระยะเวลาอนุมัติ KYC ต่อร้าน + เอกสารที่ต้องใช้?',
 'การสนับสนุนด้านเทคนิค + SLA?'].forEach(t => ch.push(bullet(t)));
ch.push(sp());
ch.push(p('* ตัวเลขเรทในเอกสาร (QR ~1.65% / บัตร ~3.65% +VAT 7%) เป็นเรทมาตรฐานอ้างอิง ใช้เป็นฐานต่อรอง — ยืนยันกับ Omise อีกครั้ง', { italics: true, color: '888888' }));

const doc = new Document({
  numbering: { config: [{ reference: 'b', levels: [{ level: 0, format: LevelFormat.BULLET, text: '•', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 520, hanging: 260 } } } }] }] },
  styles: { default: { document: { run: { font: FONT, size: 22 } } }, paragraphStyles: [
    { id: 'Title', name: 'Title', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { size: 38, bold: true, font: FONT, color: '2A1A4A' }, paragraph: { spacing: { after: 120 } } },
    { id: 'Heading1', name: 'Heading 1', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { size: 28, bold: true, font: FONT, color: '5B3FA8' }, paragraph: { spacing: { before: 200, after: 110 }, outlineLevel: 0 } },
    { id: 'Heading2', name: 'Heading 2', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { size: 24, bold: true, font: FONT }, paragraph: { spacing: { before: 140, after: 70 }, outlineLevel: 1 } },
  ] },
  sections: [{ properties: { page: { size: { width: 12240, height: 15840 }, margin: { top: 1080, right: 1080, bottom: 1080, left: 1080 } } }, children: ch }],
});
Packer.toBuffer(doc).then(b => { fs.writeFileSync(process.env.OUT, b); console.log('WROTE', process.env.OUT, b.length); });
