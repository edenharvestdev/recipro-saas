// delivery-bills.js — บันทึกบิลรายได้ delivery ของ HB05-NakNiwat48 (22–26 มิ.ย. 2026)
// ช่องทาง: Grab (รายวัน) · Shopee (1 ออเดอร์ 22 มิ.ย.) · LINE MAN (รวม 5 วัน จากรายงานสรุป)
// บิล = รายรับเท่านั้น (ไม่ตัดสต๊อก). ยอดรวมแต่ละบิล = net จริง (หลังโปร/หลังหักของแถม)
//
// รัน (ดูอย่างเดียว ไม่เขียน): PROD_DB_URL="<public-url>" node scripts/delivery-bills.js
// รันจริง (เขียนลง DB):       PROD_DB_URL="<public-url>" COMMIT=1 node scripts/delivery-bills.js
require('dotenv').config();
const { Client } = require('pg');

const URL = process.env.PROD_DB_URL || process.env.DATABASE_URL;
const COMMIT = process.env.COMMIT === '1';
const SHOP_HINT = process.env.SHOP || '%นาคนิวาส%';

function uid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

// ---- ข้อมูลบิล ----------------------------------------------------------
// price = ราคาต่อหน่วยที่ใช้ตั้งต้น (list/ราคาหน้าแอป); net = ยอดที่ลูกค้าจ่ายจริงทั้งบิล
// addons = ตัวเลือกที่บวกเงิน (ของแถม/นมเปลี่ยน) — รวมเป็นบรรทัดรายได้
// ส่วนต่าง (sub - net) จะลงเป็น discV (ส่วนลดโปร) ถ้าบวก, หรือเพิ่มบรรทัด add-on ถ้าติดลบ

const GRAB = [
  { date: '2026-06-22', net: 970, orders: 6, menu: [
    ['C21-Pink Coconut Cloud', 1, 109], ['HBD06M-Tiramisu', 2, 79], ['HBM01-Matcha Latte', 4, 89],
    ['HBR01M21C-Clear Matcha', 1, 79], ['HBR07M21C-Clear Matcha Coconut', 1, 89], ['M15L-Matcha Velvet', 1, 149],
  ], addons: [['Oat Milk นมโอ๊ต', 1, 40]] },

  { date: '2026-06-23', net: 1411, orders: 7, menu: [
    ['HBD04E-Noisette Financier', 2, 40], ['HBD06M-Tiramisu', 1, 79], ['HBM01-Matcha Latte', 5, 89],
    ['HBM08-Hojicha Latte', 2, 89], ['HBN02-Orange Yuzu Soda', 1, 79], ['HBR01M21C-Clear Matcha', 2, 79],
    ['HBR02M21C-Matcha Honey Lemon', 1, 99], ['HBR07M21C-Clear Matcha Coconut', 1, 89],
    ['HBT02-Topping Cream Cheese', 1, 30], ['M15L-Matcha Velvet', 1, 149],
  ], addons: [['Oat Milk นมโอ๊ต', 1, 40]] },

  { date: '2026-06-24', net: 1267, orders: 7, menu: [
    ['HBD04B-Citrus Noisette Financier', 1, 40], ['HBD06M-Tiramisu', 1, 79], ['HBD11-Mochi Butter Bun', 1, 49],
    ['HBM01-Matcha Latte', 6, 89], ['HBR02M21C-Matcha Honey Lemon', 1, 99], ['HBR07M21C-Clear Matcha Coconut', 1, 89],
    ['HBT05-Topping Crispy Coco', 2, 5], ['M18L-Matcha Strawberry Latte', 1, 109],
    ['M18T01L-Jasmine Thai Tea x Matcha', 1, 119], ['M21-Clear Matcha Pink Coconut', 1, 109],
  ], addons: [['Oat Milk นมโอ๊ต', 1, 20], ['Cool Pack (แยกน้ำแข็ง)', 2, 5]] },

  { date: '2026-06-25', net: 2182, orders: 10, menu: [
    ['HBD06M-Tiramisu', 3, 79], ['HBD11-Mochi Butter Bun', 1, 49], ['HBD13-Banana Cheese Cake', 2, 59],
    ['HBM01-Matcha Latte', 7, 89], ['HBR01M21C-Clear Matcha', 3, 79], ['HBR02M21C-Matcha Honey Lemon', 1, 99],
    ['HBR07M21C-Clear Matcha Coconut', 2, 89], ['M15L-Latte Hojun', 1, 139], ['M15L-Matcha Velvet', 2, 149],
    ['M18L-Coconut Milk Whisk Latte', 1, 99], ['M18L-Matcha Latte Milk Mochi', 7, 129],
  ], addons: [['Cool Pack (แยกน้ำแข็ง)', 5, 5]] },

  { date: '2026-06-26', net: 1628, orders: 9, menu: [
    ['HBD04B-Citrus Noisette Financier', 1, 40], ['HBD06M-Tiramisu', 1, 79], ['HBD12-Matcha Mochi Kinako', 1, 79],
    ['HBM01-Matcha Latte', 3, 89], ['HBN04-Jasmine Thai Tea', 1, 79], ['HBR01M21C-Clear Matcha', 1, 79],
    ['HBR07M21C-Clear Matcha Coconut', 2, 89], ['HBT02-Topping Cream Cheese', 1, 30], ['M10L-Yame Saemidori', 1, 159],
    ['M18L-Matcha Latte Milk Mochi', 2, 129], ['M18L-Matcha Strawberry Latte', 1, 109],
    ['M18T01L-Jasmine Thai Tea x Matcha', 1, 119],
  ], addons: [['Oat Milk นมโอ๊ต', 1, 20], ['Almond Milk นมอัลมอนด์', 1, 25], ['Cool Pack (แยกน้ำแข็ง)', 3, 5], ['อัปเกรด Yame Hojun', 1, 50]] },
];

// Shopee — จากภาพ Shopee Partner: 22 มิ.ย. 1 ออเดอร์
//   HBF01-Coconut on Cloud ×1 = ฿99, เงินอุดหนุนจากร้านค้า -16, ยอดเงินสุทธิ ฿83
const SHOPEE = [
  { date: '2026-06-22', net: 83, orders: 1, menu: [['HBF01-Coconut on Cloud', 1, 99]], addons: [] },
];

// LINE MAN — รวม 5 วัน (จากรายงานสรุป nakniwat48_summary_report.docx)
//   ราคาต่อหน่วย = ยอดขายรายเมนู / จำนวน (ราคา deal สะท้อนแล้ว) → ยอดรวมเมนู 7,622
//   + Topping/ตัวเลือกบวกเงิน 190 → net รวม 7,812 (discV = 0)
const LINEMAN = [
  { date: '2026-06-26', label: 'LINE MAN รวม 22–26 มิ.ย.', net: 7812, orders: 96,
    menu: [
      ['HBM01-Matcha Latte', 17, 1152 / 17],   // ดีลเดือด LINE MAN
      ['HBM01-Matcha Latte', 15, 1420 / 15],   // ราคาปกติ
      ['HBD11-Mochi Butter Bun', 14, 686 / 14],
      ['HBD12-Matcha Mochi Kinako', 6, 474 / 6],
      ['HBF01-Coconut on Cloud', 6, 604 / 6],
      ['HBD06M-Tiramisu', 6, 474 / 6],
      ['M15L-Latte Hojun', 4, 515 / 4],
      ['HBD13-Banana Cheese Cake', 4, 236 / 4],
      ['HBD04B-Citrus Noisette Financier', 3, 120 / 3],
      ['HBD04E-Noisette Financier', 3, 105 / 3],
      ['HBM08-Hojicha Latte', 3, 277 / 3],
      ['Chiran Asanoka ข้าวโพดหวาน ดอกไม้', 2, 242 / 2],   // ดีลเดือด
      ['Peach Caramel Custard Mochi', 1, 89],
      ['HBR02M21C-Matcha Honey Lemon', 1, 99],
      ['HBR07M21C-Clear Matcha Coconut', 1, 89],
      ['M10L-Yame Saemidori', 1, 169],
      ['HBR01M21C-Clear Matcha', 1, 84],
      ['Chiran Asanoka ข้าวโพดหวาน ดอกไม้', 1, 135],   // ราคาปกติ
      ['Matcha Milk Moji Taro Latte', 1, 149],
      ['Hojicha Kaori', 1, 89],
      ['Matcha Mango Latte', 1, 109],
      ['HBN04-Jasmine Thai Tea', 1, 79],
      ['M18L-Matcha Latte Milk Mochi', 1, 129],
      ['M15L-Matcha Velvet', 1, 154],
      ['Hojicha Kokoro', 1, 104],
      ['Classic Clear Genmaicha', 1, 89],
    ],
    addons: [
      ['Cool Pack (แยกน้ำแข็ง)', 13, 5],
      ['Almond Milk นมอัลมอนด์', 2, 25],
      ['Oat Milk นมโอ๊ต', 2, 20],
      ['Lactose Free Milk นมปราศจากแลคโตส', 2, 10],
      ['Maple Syrup', 1, 15],
    ] },
];

async function main() {
  const c = new Client({ connectionString: URL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  try {
    // หา shop
    const sr = await c.query(
      `select id, name from shops where name ilike $1 or name ilike '%HB05%' or name ilike '%NakNiwat%' order by name limit 5`,
      [SHOP_HINT]);
    if (!sr.rows.length) { console.log('❌ ไม่เจอร้าน'); return; }
    sr.rows.forEach(r => console.log('shop candidate:', r.name, r.id));
    const shop = sr.rows[0];
    console.log(`\n✓ ใช้ร้าน: ${shop.name} (${shop.id})  [COMMIT=${COMMIT}]\n`);

    // โหลด recipes
    const recs = (await c.query('select id, name from recipes where shop_id=$1', [shop.id])).rows;
    const norm = s => (s || '').toLowerCase().replace(/[\s\-_()]/g, '');
    function match(name) {
      const k = norm(name);
      let r = recs.find(x => norm(x.name) === k);
      if (r) return r;
      r = recs.find(x => norm(x.name).startsWith(k) || k.startsWith(norm(x.name)));
      if (r) return r;
      // คำสำคัญตัวแรกที่ยาวพอ
      const sku = (name.split('-')[0] || '').toLowerCase();
      if (sku.length >= 3) { r = recs.find(x => x.name.toLowerCase().startsWith(sku)); if (r) return r; }
      const words = k.match(/[a-z]+/g) || [];
      for (const w of words) { if (w.length >= 5) { r = recs.find(x => norm(x.name).includes(w)); if (r) return r; } }
      return null;
    }

    const channels = [['grab', GRAB], ['shopee', SHOPEE], ['lineman', LINEMAN]];
    const misses = [];
    let grand = 0;

    for (const [pay, days] of channels) {
      console.log(`\n========== ${pay.toUpperCase()} ==========`);
      for (const d of days) {
        const items = [];
        // เมนู
        for (const [name, qty, price] of d.menu) {
          const rec = match(name);
          if (rec) items.push({ recipeId: rec.id, qty, price: Math.round(price * 100) / 100, options: {} });
          else { items.push({ recipeId: null, qty, price: Math.round(price * 100) / 100, options: {}, rewardName: name }); misses.push(`${pay} ${d.date}: ${name}`); }
        }
        // add-on (บรรทัดรายได้ ไม่ผูก recipe)
        for (const [name, qty, price] of (d.addons || []))
          items.push({ recipeId: null, qty, price, options: {}, rewardName: name });

        const sub = items.reduce((s, it) => s + it.qty * it.price, 0);
        let discV = 0;
        if (sub > d.net + 0.01) discV = Math.round((sub - d.net) * 100) / 100;        // โปร/ส่วนลดแพลตฟอร์ม
        else if (sub < d.net - 0.01) items.push({ recipeId: null, qty: 1, price: Math.round((d.net - sub) * 100) / 100, options: {}, rewardName: 'ตัวเลือกเพิ่ม/Add-on' });

        const total = Math.round((items.reduce((s, it) => s + it.qty * it.price, 0) - discV) * 100) / 100;
        const billNo = (pay === 'grab' ? 'GRAB-' : pay === 'shopee' ? 'SHP-' : 'LNM-') + d.date.slice(2).replace(/-/g, '');
        const matched = items.filter(i => i.recipeId).length;
        console.log(`  ${d.date} ${billNo} | ${d.orders} ord | net ฿${d.net} | sub ฿${sub.toFixed(0)} | disc ฿${discV.toFixed(0)} | total ฿${total.toFixed(0)} | match ${matched}/${d.menu.length}${Math.abs(total - d.net) > 0.5 ? '  ⚠️TOTAL≠NET' : ''}`);
        grand += d.net;

        if (COMMIT) {
          const dup = await c.query(
            `select id from bills where shop_id=$1 and items_json->>'date'=$2 and items_json->>'payMethod'=$3 limit 1`,
            [shop.id, d.date, pay]);
          if (dup.rows.length) { console.log('     ⏭ มีบิลช่องทางนี้วันนี้แล้ว — ข้าม'); continue; }
          const itemsJson = {
            date: d.date, payMethod: pay, items, discV, discT: '฿', taxV: 0, taxT: '%',
            cust: d.label || '', sender: shop.name, tableNo: '', memberPhone: '',
          };
          await c.query(`insert into bills (id, shop_id, number, status, items_json) values ($1,$2,$3,'paid',$4)`,
            [uid(), shop.id, billNo, JSON.stringify(itemsJson)]);
          console.log('     ✓ บันทึกแล้ว');
        }
      }
    }

    if (misses.length) {
      console.log(`\n⚠️ เมนูที่ไม่ match recipe (ลงเป็นบรรทัดป้ายชื่อ รายได้ครบ แต่ไม่ผูกสูตร):`);
      misses.forEach(m => console.log('   - ' + m));
    }
    console.log(`\n📊 รายรับ delivery รวม (22–26 มิ.ย.): ฿${grand.toLocaleString()}`);
    console.log(`   Grab ฿${GRAB.reduce((s, d) => s + d.net, 0).toLocaleString()} · Shopee ฿${SHOPEE.reduce((s, d) => s + d.net, 0)} · LINE MAN ฿${LINEMAN.reduce((s, d) => s + d.net, 0).toLocaleString()}`);

    if (COMMIT) {
      await c.query('update shop_settings set data_version = coalesce(data_version,0)+1 where shop_id=$1', [shop.id]);
      console.log('\n✅ COMMIT เสร็จ + bump data_version (แท็บที่เปิดอยู่จะรีโหลด)');
    } else {
      console.log('\n(DRY RUN — ยังไม่เขียน. ใส่ COMMIT=1 เพื่อบันทึกจริง)');
    }
  } finally {
    await c.end();
  }
}

main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
