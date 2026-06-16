// นำเข้าข้อมูลจริงของ Merry Jane จากแอปเดิม (แปลง id สั้น -> UUID + remap ความเชื่อมโยง)
// รัน: node scripts/import-merryjane.js
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { pool, tx } = require('../src/db');

const OWNER_EMAIL = 'merryjane@recipro.local';
const OWNER_PASSWORD = 'merryjane2026'; // ชั่วคราว — แนะนำให้เปลี่ยนภายหลัง

(async () => {
  const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'merryjane-data.json'), 'utf8'));
  const s = data.settings || {};
  const shopName = s.shopName || 'Merry Jane Bakery';

  try {
    const summary = await tx(async (c) => {
      // 1) หา/สร้างร้าน Merry Jane
      let shop = (await c.query(
        "select id from shops where name in ('Merry Jane','Merry Jane Bakery') order by created_at limit 1"
      )).rows[0];
      if (!shop) {
        shop = (await c.query("insert into shops (name, status) values ($1,'trial') returning id", [shopName])).rows[0];
      } else {
        await c.query('update shops set name = $1 where id = $2', [shopName, shop.id]);
      }
      const shopId = shop.id;

      // 2) บัญชี owner สำหรับล็อกอิน
      let owner = (await c.query('select id from users where email = $1', [OWNER_EMAIL])).rows[0];
      if (!owner) {
        const hash = await bcrypt.hash(OWNER_PASSWORD, Number(process.env.BCRYPT_ROUNDS) || 10);
        owner = (await c.query('insert into users (email, password_hash) values ($1,$2) returning id', [OWNER_EMAIL, hash])).rows[0];
      }
      await c.query(
        "insert into memberships (user_id, shop_id, role) values ($1,$2,'owner') on conflict (user_id, shop_id) do nothing",
        [owner.id, shopId]
      );

      // 3) ล้างข้อมูลเดิมของร้านนี้ก่อน (idempotent) — recipe_items ลบตาม cascade
      await c.query('delete from recipes  where shop_id = $1', [shopId]);
      await c.query('delete from materials where shop_id = $1', [shopId]);
      await c.query('delete from suppliers where shop_id = $1', [shopId]);

      // 4) suppliers (map old->new uuid)
      const supMap = {};
      for (const sup of data.suppliers || []) {
        const nid = crypto.randomUUID();
        supMap[sup.id] = nid;
        await c.query('insert into suppliers (id, shop_id, name, note) values ($1,$2,$3,$4)',
          [nid, shopId, sup.name, sup.note || null]);
      }

      // 5) materials (map old->new uuid, supplier_id จาก supMap)
      const matMap = {};
      for (const m of data.materials || []) {
        const nid = crypto.randomUUID();
        matMap[m.id] = nid;
        await c.query(
          `insert into materials (id, shop_id, name, qty, unit, price, supplier_id, order_url, stock, low_stock)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [nid, shopId, m.name, m.qty ?? null, m.unit || null, m.price ?? null,
           m.supId ? (supMap[m.supId] || null) : null, m.orderUrl || null,
           m.stock ?? 0, m.lowStock ?? 0]
        );
      }

      // 6) recipes + recipe_items
      let itemCount = 0;
      for (const r of data.recipes || []) {
        const rid = crypto.randomUUID();
        await c.query(
          `insert into recipes (id, shop_id, code, name, sell_price, batch_yield, yield_unit, is_raw, steps, fg_stock, fg_low)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [rid, shopId, r.code || null, r.name, r.sell ?? 0, r.batchYield ?? 1,
           r.yieldUnit || 'ชิ้น', r.isRaw || false, r.steps || null, r.fgStock ?? 0, r.fgLow ?? 0]
        );
        for (const it of r.items || []) {
          const matId = matMap[it.matId] || null;
          if (!matId) { console.warn(`  ! recipe "${r.name}" item matId ${it.matId} ไม่พบในวัตถุดิบ — ข้าม`); continue; }
          await c.query('insert into recipe_items (recipe_id, material_id, amount) values ($1,$2,$3)',
            [rid, matId, it.amount]);
          itemCount++;
        }
      }

      // 7) shop_settings
      await c.query(
        `insert into shop_settings (shop_id, phone, tax_id, address, bank, account, holder, promptpay, theme)
         values ($1,$2,$3,$4,$5,$6,$7,$8,'rose')
         on conflict (shop_id) do update set
           phone=excluded.phone, tax_id=excluded.tax_id, address=excluded.address,
           bank=excluded.bank, account=excluded.account, holder=excluded.holder, promptpay=excluded.promptpay`,
        [shopId, s.phone || null, s.tax || null, s.addr || null, s.bank || null, s.acc || null, s.holder || null, s.pp || null]
      );

      return {
        shopId, shopName,
        suppliers: (data.suppliers || []).length,
        materials: (data.materials || []).length,
        recipes: (data.recipes || []).length,
        recipeItems: itemCount,
      };
    });

    console.log('นำเข้าเสร็จ:', JSON.stringify(summary, null, 2));
    console.log(`บัญชีเจ้าของร้าน: ${OWNER_EMAIL} / ${OWNER_PASSWORD}`);
    await pool.end();
    process.exit(0);
  } catch (e) {
    console.error('นำเข้าล้มเหลว:', e.message);
    await pool.end();
    process.exit(1);
  }
})();
