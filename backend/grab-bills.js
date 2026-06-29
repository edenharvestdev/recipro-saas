// grab-bills.js — สร้างบิลรายได้ Grab สำหรับ HB05-NakNiwat48 วันที่ 22-26 มิ.ย. 2026
// bills = รายรับเท่านั้น (NO stock deduction)
// ใช้: node grab-bills.js  (อ่าน DATABASE_URL จาก .env ใน backend/)
// หรือ: DATABASE_URL="..." node grab-bills.js
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, 'recipro-saas/backend/.env') });
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('railway') ? { rejectUnauthorized: false } : false,
});

function uid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

async function main() {
  const client = await pool.connect();
  try {
    // 1. หา shop_id ของ HB05 NakNiwat48
    const shopRes = await client.query(`
      SELECT id, name FROM shops
      WHERE name ILIKE '%HB05%' OR name ILIKE '%นาคนิวาส%' OR name ILIKE '%NakNiwat%' OR name ILIKE '%Nak Niwat%'
      ORDER BY name LIMIT 5
    `);
    console.log('Shops found:');
    shopRes.rows.forEach(r => console.log(`  ${r.name} → ${r.id}`));

    if (!shopRes.rows.length) { console.log('❌ ไม่เจอร้าน HB05'); return; }
    const shop = shopRes.rows[0];
    const shopId = shop.id;
    console.log(`\n✓ ใช้ shop: ${shop.name} (${shopId})\n`);

    // 2. โหลด recipes ทั้งหมดของร้าน
    const recRes = await client.query('SELECT id, name FROM recipes WHERE shop_id=$1 ORDER BY name', [shopId]);
    console.log(`Found ${recRes.rows.length} recipes`);

    // fuzzy match — ตาม SKU prefix (ชื่อเมนู Grab มี SKU นำหน้า)
    function findRecipe(key) {
      const k = key.toLowerCase();
      // exact
      const exact = recRes.rows.find(r => r.name.toLowerCase() === k);
      if (exact) return exact;
      // starts with key
      const sw = recRes.rows.find(r => r.name.toLowerCase().startsWith(k));
      if (sw) return sw;
      // key starts with recipe name
      const ks = recRes.rows.find(r => k.startsWith(r.name.toLowerCase()));
      if (ks) return ks;
      // contains key (any word)
      const parts = k.split(/[-\s]+/).filter(p => p.length > 3);
      for (const p of parts) {
        const hit = recRes.rows.find(r => r.name.toLowerCase().includes(p));
        if (hit) return hit;
      }
      return null;
    }

    // 3. กำหนดบิลรายวัน
    // amount = ยอดรวม net จาก PDF receipts (หลังหัก Grab campaign discount แล้ว)
    // items = qty จาก Grab CSV; ราคาต่อชิ้น = ราคาหน้า Grab ก่อน discount
    // Grab campaign discounts: -10% Matcha Velvet, -20% Matcha Latte Milk Mochi
    // Cool Pack / Oat Milk / add-ons → รวมใน discV (gross - net)
    const dailyBills = [
      {
        date: '2026-06-22',
        net: 970,     // PDF total: GF-850(89)+865(213)+461(218)+297(109)+196(168)+054(173)
        orders: 6,
        items: [
          { name: 'C21-Pink Coconut Cloud', qty: 1, price: 109 },
          { name: 'HBD06M-Tiramisu', qty: 2, price: 79 },
          { name: 'HBM01-Matcha Latte', qty: 4, price: 89 },
          { name: 'HBR01M21C-Clear Matcha', qty: 1, price: 79 },
          { name: 'HBR07M21C-Clear Matcha Coconut', qty: 1, price: 89 },
          { name: 'M15L-Matcha Velvet', qty: 1, price: 149 },
        ],
      },
      {
        date: '2026-06-23',
        net: 1411,    // PDF: GF-315(218)+683(89)+748(198)+226(89)+101(139)+552(386)+528(292)
        orders: 7,
        items: [
          { name: 'HBD04E-Noisette Financier', qty: 2, price: 40 },
          { name: 'HBD06M-Tiramisu', qty: 1, price: 79 },
          { name: 'HBM01-Matcha Latte', qty: 5, price: 89 },
          { name: 'HBM08-Hojicha Latte', qty: 2, price: 89 },
          { name: 'HBN02-Orange Yuzu Soda', qty: 1, price: 79 },
          { name: 'HBR01M21C-Clear Matcha', qty: 2, price: 79 },
          { name: 'HBR02M21C-Matcha Honey Lemon', qty: 1, price: 99 },
          { name: 'HBR07M21C-Clear Matcha Coconut', qty: 1, price: 89 },
          { name: 'HBT02-Topping Cream Cheese', qty: 1, price: 30 },
          { name: 'M15L-Matcha Velvet', qty: 1, price: 149 },
        ],
      },
      {
        date: '2026-06-24',
        net: 1267,    // PDF: GF-258(168)+169(124)+026(198)+366(277)+267(89)+435(134)+353(277)
        orders: 7,
        items: [
          { name: 'HBD04B-Citrus Noisette Financier', qty: 1, price: 40 },
          { name: 'HBD06M-Tiramisu', qty: 1, price: 79 },
          { name: 'HBD11-Mochi Butter Bun', qty: 1, price: 49 },
          { name: 'HBM01-Matcha Latte', qty: 6, price: 89 },
          { name: 'HBR02M21C-Matcha Honey Lemon', qty: 1, price: 99 },
          { name: 'HBR07M21C-Clear Matcha Coconut', qty: 1, price: 89 },
          { name: 'HBT05-Topping Crispy Coco', qty: 2, price: 5 },
          { name: 'M18L-Matcha Strawberry Latte', qty: 1, price: 109 },
          { name: 'M18T01L-Jasmine Thai Tea x Matcha', qty: 1, price: 119 },
          { name: 'M21-Clear Matcha Pink Coconut', qty: 1, price: 109 },
        ],
      },
      {
        date: '2026-06-25',
        net: 2182,    // PDF: 10 orders confirmed (CSV shows 3x Matcha Velvet but PDF 2x; use PDF net)
        orders: 10,
        items: [
          { name: 'HBD06M-Tiramisu', qty: 3, price: 79 },
          { name: 'HBD11-Mochi Butter Bun', qty: 1, price: 49 },
          { name: 'HBD13-Banana Cheese Cake', qty: 2, price: 59 },
          { name: 'HBM01-Matcha Latte', qty: 7, price: 89 },
          { name: 'HBR01M21C-Clear Matcha', qty: 3, price: 79 },
          { name: 'HBR02M21C-Matcha Honey Lemon', qty: 1, price: 99 },
          { name: 'HBR07M21C-Clear Matcha Coconut', qty: 2, price: 89 },
          { name: 'M15L-Latte Hojun', qty: 1, price: 139 },
          { name: 'M15L-Matcha Velvet', qty: 2, price: 149 },
          { name: 'M18L-Coconut Milk Whisk Latte', qty: 1, price: 99 },
          { name: 'M18L-Matcha Latte Milk Mochi', qty: 7, price: 129 },
        ],
      },
      {
        date: '2026-06-26',
        net: 1628,    // PDF only: GF-473(119)+280(216)+573(456)+468(114)+342(169)+431(89)+920(203)+161(168)+212(94)
        orders: 9,
        items: [
          { name: 'HBD04B-Citrus Noisette Financier', qty: 1, price: 40 },
          { name: 'HBD06M-Tiramisu', qty: 1, price: 79 },
          { name: 'HBD12-Matcha Mochi Kinako', qty: 1, price: 79 },
          { name: 'HBM01-Matcha Latte', qty: 3, price: 89 },
          { name: 'HBN04-Jasmine Thai Tea', qty: 1, price: 79 },
          { name: 'HBR01M21C-Clear Matcha', qty: 1, price: 79 },
          { name: 'HBR07M21C-Clear Matcha Coconut', qty: 2, price: 89 },
          { name: 'HBT02-Topping Cream Cheese', qty: 1, price: 30 },
          { name: 'M10L-Yame Saemidori', qty: 1, price: 159 },
          { name: 'M18L-Matcha Latte Milk Mochi', qty: 2, price: 129 },
          { name: 'M18L-Matcha Strawberry Latte', qty: 1, price: 109 },
          { name: 'M18T01L-Jasmine Thai Tea x Matcha', qty: 1, price: 119 },
        ],
      },
    ];

    // 4. สร้าง bills
    console.log('\n=== Recipe matching ===');
    let created = 0;

    for (const day of dailyBills) {
      // map items → recipe IDs
      const billItems = [];
      let anyMissing = false;
      for (const item of day.items) {
        const rec = findRecipe(item.name);
        if (!rec) {
          console.log(`  ⚠️  ${day.date}: ❌ ไม่เจอ "${item.name}"`);
          anyMissing = true;
        } else {
          billItems.push({ recipeId: rec.id, qty: item.qty, price: item.price, options: {} });
        }
      }

      const gross = billItems.reduce((s, i) => s + i.qty * i.price, 0);
      const disc = Math.max(0, gross - day.net);

      // เช็คบิลซ้ำ
      const existing = await client.query(
        `SELECT id FROM bills WHERE shop_id=$1 AND items_json->>'date'=$2 AND items_json->>'payMethod'='grab' LIMIT 1`,
        [shopId, day.date]
      );
      if (existing.rows.length) {
        console.log(`  ⏭  ${day.date}: มีบิล Grab อยู่แล้ว — ข้าม`);
        continue;
      }

      const billId = uid();
      const billNo = 'GRAB-' + day.date.slice(2).replace(/-/g, '');  // GRAB-260622

      const itemsJson = {
        date: day.date,
        payMethod: 'grab',
        items: billItems,
        discV: disc,
        discT: '฿',
        taxV: 0,
        taxT: '%',
        cust: '',
        sender: shop.name,
        tableNo: '',
        memberPhone: '',
      };

      await client.query(
        `INSERT INTO bills (id, shop_id, number, status, items_json)
         VALUES ($1, $2, $3, 'paid', $4)`,
        [billId, shopId, billNo, JSON.stringify(itemsJson)]
      );

      console.log(`  ✓ ${day.date}: ${billNo} | ${day.orders} orders | net ฿${day.net} | gross ฿${gross} | disc ฿${disc} | ${billItems.length}/${day.items.length} เมนู${anyMissing ? ' ⚠️missing' : ''}`);
      created++;
    }

    // bump data_version เพื่อให้ client reload
    await client.query(
      `UPDATE shop_settings SET data_version = COALESCE(data_version,0) + 1 WHERE shop_id = $1`,
      [shopId]
    );

    console.log(`\n✅ สร้างบิลเสร็จ ${created}/${dailyBills.length} วัน`);

    // สรุปรายรับ
    const totalNet = dailyBills.reduce((s, d) => s + d.net, 0);
    const totalOrders = dailyBills.reduce((s, d) => s + d.orders, 0);
    console.log(`\n📊 สรุปรายรับ Grab HB05 NakNiwat48 (22-26 มิ.ย. 2026)`);
    console.log(`   ${totalOrders} orders / 5 วัน`);
    console.log(`   รายรับรวม ฿${totalNet.toLocaleString()}`);
    console.log(`   เฉลี่ย ฿${Math.round(totalNet / totalOrders)}/order`);

  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
