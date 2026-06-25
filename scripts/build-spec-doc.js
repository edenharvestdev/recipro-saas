const fs = require('fs');
const { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  HeadingLevel, BorderStyle, WidthType, ShadingType, AlignmentType, PageBreak, LevelFormat } = require('docx');
const FONT = 'Tahoma';
const CW = 9360;
const border = { style: BorderStyle.SINGLE, size: 1, color: 'CCCCCC' };
const borders = { top: border, bottom: border, left: border, right: border };
const margins = { top: 60, bottom: 60, left: 120, right: 120 };

function h1(t){return new Paragraph({heading:HeadingLevel.HEADING_1,children:[new TextRun(t)]});}
function h2(t){return new Paragraph({heading:HeadingLevel.HEADING_2,children:[new TextRun(t)]});}
function p(t,o={}){return new Paragraph({spacing:{after:80},children:[new TextRun({text:t,...o})]});}
function bullet(t){return new Paragraph({numbering:{reference:'b',level:0},spacing:{after:40},children:[new TextRun(t)]});}
function sp(){return new Paragraph({children:[new TextRun('')]});}
function cell(t,w,head,al){return new TableCell({borders,width:{size:w,type:WidthType.DXA},margins,
  shading:head?{fill:'E8E2D5',type:ShadingType.CLEAR}:undefined,
  children:[new Paragraph({alignment:al==='r'?AlignmentType.RIGHT:AlignmentType.LEFT,children:[new TextRun({text:String(t),bold:!!head})]})]});}
function table(headers, widths, rows){
  const head=new TableRow({tableHeader:true,children:headers.map((h,i)=>cell(h,widths[i],true))});
  const body=rows.map(r=>new TableRow({children:r.map((c,i)=>cell(c,widths[i],false,i>=2&&/^[\d,–]/.test(String(c))?'r':'l'))}));
  return new Table({width:{size:CW,type:WidthType.DXA},columnWidths:widths,rows:[head,...body]});
}

const ch=[];
ch.push(new Paragraph({heading:HeadingLevel.TITLE,children:[new TextRun('สเปกฮาร์ดแวร์สำหรับร้าน (Recipro)')]}));
ch.push(p('เครื่องพิมพ์ + แท็บเล็ต Android — สำหรับจัดหา/จำหน่าย และแนะนำร้านค้า',{italics:true,color:'666666'}));
ch.push(p('สร้างเมื่อ: 25 มิ.ย. 2026',{italics:true,color:'999999'}));
ch.push(sp());

// 1
ch.push(h1('1) เครื่องพิมพ์ใบเสร็จ 80mm (Thermal)'));
ch.push(p('สเปกที่ต้องเช็คตอนหาซื้อ:',{bold:true}));
['ความกว้างพิมพ์ 80mm (กระดาษ 79.5±0.5mm) — รองรับ 58mm ด้วยยิ่งดี',
 'วิธีพิมพ์ Direct Thermal (ไม่ใช้หมึก/ตลับ)',
 'ความเร็ว ≥ 200 mm/s (ขั้นต่ำ 150)',
 'ความละเอียด 203 dpi (มาตรฐาน)',
 'คำสั่ง ESC/POS (สำคัญ — ใช้กับ POS ทั่วไป + พิมพ์ตรงอัตโนมัติในอนาคต)',
 'ตัดกระดาษอัตโนมัติ (Auto-cutter): มี',
 'พอร์ตลิ้นชักเงิน (Cash-drawer kick / RJ11-12): มี (ต่อลิ้นชักเงินสด)',
 'การเชื่อมต่อ: USB + LAN อย่างน้อย · Bluetooth/WiFi ถ้าต้องการไร้สาย',
 'อายุหัวพิมพ์ ≥ 100 กม. / 50 ล้านครั้ง',
 'รองรับไดรเวอร์ Windows / Android(Mopria) / iOS'].forEach(t=>ch.push(bullet(t)));
ch.push(sp());
ch.push(p('รุ่นแนะนำ (ตลาดไทย):',{bold:true}));
ch.push(table(['รุ่น','เชื่อมต่อ','ราคาโดยประมาณ (฿)','เหมาะกับ'],[2600,2000,1900,2860],[
 ['Xprinter XP-80 / N160II','USB/LAN/BT','1,200–1,800','ร้านเล็ก-กลาง คุ้มสุด'],
 ['Rongta RP80 / Gprinter GP-U80','USB/LAN','1,300–2,000','สำรอง/คุ้ม'],
 ['Epson TM-T82III','USB/LAN','4,500–6,500','ทนระดับร้านใหญ่'],
 ['Star TSP143III','USB/LAN/BT','5,000–7,000','ใช้กับ iPad/แท็บเล็ต'],
]));
ch.push(new Paragraph({children:[new PageBreak()]}));

// 2
ch.push(h1('2) เครื่องพิมพ์สติกเกอร์ / ฉลาก (Label)'));
ch.push(p('สเปกที่ต้องเช็ค:',{bold:true}));
['สื่อ: ม้วนสติกเกอร์ความร้อน กว้าง 20–80mm (นิยม 40×30, 50×40, 100×150 mm)',
 'ความละเอียด 203 dpi (300 dpi ถ้างานละเอียด/บาร์โค้ดเล็ก)',
 'ความเร็ว ≥ 100–150 mm/s',
 'เซ็นเซอร์ gap/black-mark (จับช่องสติกเกอร์อัตโนมัติ)',
 'คำสั่ง TSPL / ESC-label (เทียบเท่า)',
 'เชื่อมต่อ USB + (Bluetooth/LAN ถ้าต้องการ)'].forEach(t=>ch.push(bullet(t)));
ch.push(sp());
ch.push(p('รุ่นแนะนำ:',{bold:true}));
ch.push(table(['รุ่น','สติกเกอร์ที่รองรับ','ราคาโดยประมาณ (฿)'],[3000,3360,3000],[
 ['Xprinter XP-365B / 420B','40×30 ถึง 100×150','1,500–2,500'],
 ['Munbyn ITPP941','กว้างสูงสุด 104mm','2,500–3,500'],
 ['Brother QL-820NWB','ม้วนต่อเนื่อง คุณภาพสูง','6,000–8,000'],
]));
ch.push(new Paragraph({children:[new PageBreak()]}));

// 3
ch.push(h1('3) แท็บเล็ต Android (รับออเดอร์ / POS)'));
ch.push(p('Recipro เป็นเว็บแอป รันบนเบราว์เซอร์ — แท็บเล็ต Android รุ่นใหม่ที่มี Chrome ใช้ได้หมด เน้นจอ/แรม/WiFi ให้ลื่น',{bold:true}));
ch.push(p('สเปก (ขั้นต่ำ → แนะนำ):',{bold:true}));
['จอ 10–11" IPS, 1920×1200, ความสว่าง ≥ 350 nit (สู้แสงเคาน์เตอร์)',
 'OS: Android 12 ขึ้นไป (13/14 ดีกว่า อัปเดตนานกว่า)',
 'RAM ≥ 4GB (แนะนำ 6–8GB) · ความจุ ≥ 64GB',
 'ชิป octa-core ระดับกลาง (Snapdragon 6xx / MediaTek Helio G99 / Dimensity)',
 'WiFi dual-band, Bluetooth 5 · (4G LTE ถ้าออกบูธ/เดลิเวอรี)',
 'USB-C รองรับ OTG (ต่อเครื่องพิมพ์/สแกนเนอร์ตรงได้)',
 'แบต ≥ 7,000mAh (ใช้ทั้งวัน) · เสริม NFC (แตะบัตรสมาชิก/จ่ายเงิน), ขาตั้ง/VESA'].forEach(t=>ch.push(bullet(t)));
ch.push(sp());
ch.push(p('รุ่นตัวอย่าง (ตลาดไทย):',{bold:true}));
ch.push(table(['รุ่น','สเปกเด่น','ราคาโดยประมาณ (฿)'],[3000,3360,3000],[
 ['Samsung Galaxy Tab A9+','11", 4–8GB, อัปเดตนาน','6,000–8,000'],
 ['Lenovo Tab M11 / P11','จอใหญ่ คุ้ม','6,000–9,000'],
 ['Xiaomi Redmi Pad SE/Pro','สเปกคุ้ม','6,000–9,000'],
 ['Sunmi (POS เฉพาะทาง)','มีเครื่องพิมพ์ในตัว (all-in-one)','ขายเป็นชุด'],
]));
ch.push(new Paragraph({children:[new PageBreak()]}));

// 4
ch.push(h1('4) ชุดแนะนำขายพ่วง (Bundle)'));
ch.push(table(['ชุด','ประกอบด้วย','ราคารวมโดยประมาณ (฿)'],[2400,4560,2400],[
 ['ประหยัด','แท็บเล็ต Tab A9+ + Xprinter XP-80 (LAN) + ลิ้นชักเงินสด','9,000–12,000'],
 ['มาตรฐาน','ชุดประหยัด + เครื่องพิมพ์สติกเกอร์ XP-365B','+1,500–2,500'],
 ['All-in-one','Sunmi POS (จอ+เครื่องพิมพ์ในตัว) — ลดสายพ่วง','ตามรุ่น'],
]));
ch.push(sp());

// 5
ch.push(h1('5) การเชื่อมต่อกับ Recipro (สำคัญก่อนแนะนำลูกค้า)'));
['ตอนนี้ Recipro พิมพ์ผ่าน "กล่องพิมพ์ของเบราว์เซอร์" (ตั้งขนาด @page 80mm / สติกเกอร์ 50×40 ฯลฯ) → ใช้เครื่องที่ลงไดรเวอร์/บริการพิมพ์ใน Windows/Mac/Android(Mopria) ได้ทุกรุ่น',
 'บน Android: ใช้บริการพิมพ์ Mopria หรือแอปของผู้ผลิตเครื่องพิมพ์ (ส่วนใหญ่มีให้)',
 'แนะนำเครื่องที่มี LAN/WiFi เพื่อแชร์พิมพ์หลายอุปกรณ์ในร้าน',
 'พิมพ์ตรงแบบ ESC/POS (สั่งจากครัว/คลาวด์อัตโนมัติ ไม่ผ่านหน้าต่างพิมพ์) = งานพัฒนาเพิ่มในเฟสระบบชำระเงิน/ฮาร์ดแวร์ (ทำได้)'].forEach(t=>ch.push(bullet(t)));
ch.push(sp());
ch.push(p('* ราคาเป็นค่าประมาณตลาดไทย ใช้เป็นแนวทางจัดหา/ตั้งราคาขาย ควรเช็คกับซัพพลายเออร์อีกครั้ง',{italics:true,color:'888888'}));

const doc=new Document({
  numbering:{config:[{reference:'b',levels:[{level:0,format:LevelFormat.BULLET,text:'•',alignment:AlignmentType.LEFT,style:{paragraph:{indent:{left:520,hanging:260}}}}]}]},
  styles:{default:{document:{run:{font:FONT,size:22}}},paragraphStyles:[
    {id:'Title',name:'Title',basedOn:'Normal',next:'Normal',quickFormat:true,run:{size:40,bold:true,font:FONT,color:'3A2A00'},paragraph:{spacing:{after:120}}},
    {id:'Heading1',name:'Heading 1',basedOn:'Normal',next:'Normal',quickFormat:true,run:{size:30,bold:true,font:FONT,color:'7A5C00'},paragraph:{spacing:{before:200,after:120},outlineLevel:0}},
    {id:'Heading2',name:'Heading 2',basedOn:'Normal',next:'Normal',quickFormat:true,run:{size:25,bold:true,font:FONT},paragraph:{spacing:{before:140,after:70},outlineLevel:1}},
  ]},
  sections:[{properties:{page:{size:{width:12240,height:15840},margin:{top:1080,right:1080,bottom:1080,left:1080}}},children:ch}],
});
Packer.toBuffer(doc).then(buf=>{fs.writeFileSync(process.env.OUT,buf);console.log('WROTE',process.env.OUT,buf.length);});
