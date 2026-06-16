// Seed ร้าน "Scent & Sip Cafe" จากเมนูกาแฟ (Menu Coffee drink.xlsx)
// รัน: DATABASE_URL=<railway public url> PGSSL=require node backend/scripts/seed-scent.js
require('dotenv').config();
const bcrypt = require('bcryptjs');
const { pool, tx } = require('../src/db');

const SHOP = 'Scent & Sip Cafe';
const EMAIL = 'scentsip@recipro.local';
const PASS = 'Scent2026';

// วัตถุดิบ (key, ชื่อ, ปริมาณบรรจุ, หน่วย, ราคา) — ราคาเมล็ด/นม/แก้ว มาจากชีตต้นทุน, ซอส/ไซรัปประมาณการ
const MATS = [
  ['beanFB', 'กาแฟ Full Body Medium dark', 1000, 'กรัม', 650],
  ['beanETH', 'กาแฟ Ethiopia Sidamo G2', 1000, 'กรัม', 990],
  ['milk', 'นม M Milk', 2000, 'มิลลิลิตร', 102],
  ['choc', 'Chocolate sauce', 1000, 'กรัม', 180],
  ['caramel', 'Caramel sauce', 1000, 'กรัม', 180],
  ['butter', 'Butter milk', 2000, 'มิลลิลิตร', 120],
  ['syrup', 'Syrup', 750, 'มิลลิลิตร', 120],
  ['maple', 'Maple Syrup', 1000, 'มิลลิลิตร', 890],
  ['cup', 'แก้ว Take away + ฝา', 1, 'ชิ้น', 6],
];

// เมนู (code, ชื่อ, ราคา Full Body, ราคา Ethiopia, ส่วนผสมเพิ่ม[นอกจากกาแฟ17g+แก้ว], วิธีทำ)
const DRINKS = [
  ['SS01', 'Espresso', 70, 80, [], 'ดึง shot espresso 17g เสิร์ฟพร้อมน้ำอุ่นข้างๆ'],
  ['SS02', 'Hot Americano', 80, 90, [], 'เตรียมน้ำร้อน 120ml ลงแก้ว แล้วราด shot espresso 17g'],
  ['SS03', 'Hot Latte', 90, 100, [['milk', 210]], 'ดึง shot 17g + สตีมนม 210ml เทลาย latte art'],
  ['SS04', 'Hot Cappuccino', 90, 100, [['milk', 210]], 'ดึง shot 17g + สตีมนม 210ml โฟมหนา'],
  ['SS05', 'Hot Flat White', 90, 100, [['milk', 210]], 'ดึง shot 17g + สตีมนม 210ml โฟมบาง'],
  ['SS06', 'Hot Mocha', 100, 110, [['milk', 210], ['choc', 20]], 'ดึง shot 17g + chocolate 20g คนเข้ากัน + สตีมนม 210ml'],
  ['SS07', 'Hot Caramel Latte', 100, 110, [['milk', 210], ['caramel', 10]], 'ดึง shot 17g + caramel 10g คนเข้ากัน + สตีมนม 210ml'],
  ['SS08', 'Ice Americano', 90, 100, [], 'แก้ว 12oz ใส่น้ำ 120ml + น้ำแข็ง + ราด shot 17g'],
  ['SS09', 'Ice Es Yen', 100, 110, [['milk', 90], ['butter', 40], ['syrup', 10]], 'นม 90 + butter milk 40 + syrup 10 + น้ำแข็ง + ราด shot 17g'],
  ['SS10', 'Ice Latte', 100, 110, [['milk', 120]], 'นม 120 + น้ำแข็ง + ราด shot 17g'],
  ['SS11', 'Ice Cappuccino', 100, 110, [['milk', 90], ['butter', 40], ['syrup', 10]], 'ปั่นนม 90 ขึ้นโฟม + butter 40 + syrup 10 + น้ำแข็ง + ราด shot 17g'],
  ['SS12', 'Ice Mocha', 110, 120, [['milk', 120], ['choc', 15]], 'นม 120 + chocolate 15 + น้ำแข็ง + ราด shot 17g'],
  ['SS13', 'Dirty', 110, 120, [['milk', 50], ['butter', 40], ['maple', 5]], 'butter 40 + นม 50 + maple 5 ในแก้ว dirty แล้วดึง shot 17g หมุนรอบ'],
];

async function seed(c) {
  let shop = (await c.query('select id from shops where name = $1 limit 1', [SHOP])).rows[0];
  if (!shop) shop = (await c.query("insert into shops (name, status) values ($1,'trial') returning id", [SHOP])).rows[0];
  const shopId = shop.id;

  let u = (await c.query('select id from users where email = $1', [EMAIL])).rows[0];
  if (!u) {
    const h = await bcrypt.hash(PASS, Number(process.env.BCRYPT_ROUNDS) || 10);
    u = (await c.query('insert into users (email, password_hash) values ($1,$2) returning id', [EMAIL, h])).rows[0];
  }
  await c.query("insert into memberships (user_id, shop_id, role) values ($1,$2,'owner') on conflict (user_id, shop_id) do nothing", [u.id, shopId]);

  // ล้างของเดิม (idempotent)
  await c.query('delete from recipes where shop_id = $1', [shopId]);
  await c.query('delete from materials where shop_id = $1', [shopId]);

  const mid = {};
  for (const [k, name, qty, unit, price] of MATS) {
    const id = crypto.randomUUID();
    mid[k] = id;
    await c.query('insert into materials (id, shop_id, name, qty, unit, price, stock, low_stock) values ($1,$2,$3,$4,$5,$6,0,0)',
      [id, shopId, name, qty, unit, price]);
  }

  let n = 0;
  for (const [code, name, fb, eth, ing, steps] of DRINKS) {
    for (const [variant, beanKey, price, suffix] of [['Full Body', 'beanFB', fb, 'F'], ['Ethiopia', 'beanETH', eth, 'E']]) {
      const rid = crypto.randomUUID();
      await c.query(
        "insert into recipes (id, shop_id, code, name, sell_price, batch_yield, yield_unit, is_raw, steps, fg_stock, fg_low) values ($1,$2,$3,$4,$5,1,'แก้ว',false,$6,0,0)",
        [rid, shopId, code + '-' + suffix, `${name} (${variant})`, price, steps]
      );
      const items = [[beanKey, 17], ['cup', 1], ...ing];
      for (const [k, amt] of items) {
        await c.query('insert into recipe_items (recipe_id, material_id, amount) values ($1,$2,$3)', [rid, mid[k], amt]);
      }
      n++;
    }
  }

  await c.query("insert into shop_settings (shop_id, theme) values ($1,'recipro') on conflict (shop_id) do nothing", [shopId]);
  return { shopId, materials: MATS.length, recipes: n };
}

(async () => {
  try {
    const s = await tx(seed);
    console.log('seeded Scent & Sip Cafe:', JSON.stringify(s));
    console.log('owner:', EMAIL, '/', PASS);
    await pool.end();
    process.exit(0);
  } catch (e) {
    console.error('failed:', e.message);
    await pool.end();
    process.exit(1);
  }
})();
