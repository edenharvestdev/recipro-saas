// /api/admin/* — เฉพาะ superadmin (กรองสิทธิ์ที่ index.js ด้วย requireSuperadmin)
const express = require('express');
const bcrypt = require('bcryptjs');
const { query, tx } = require('../db');
const { logEvent } = require('../logs');
const router = express.Router();

// ดูร้านทั้งหมด
router.get('/shops', async (req, res) => {
  try {
    const { rows } = await query('select id, name, status, created_at from shops order by created_at');
    res.json({ shops: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// สร้างร้านใหม่ + บัญชีเจ้าของแรก (แทน edge function admin-tasks)
router.post('/shops', async (req, res) => {
  try {
    const shopName = String(req.body.shopName || '').trim();
    const ownerEmail = String(req.body.ownerEmail || '').trim().toLowerCase();
    const ownerPassword = String(req.body.ownerPassword || '');
    if (!shopName || !ownerEmail || !ownerPassword) {
      return res.status(400).json({ error: 'กรอกข้อมูลให้ครบถ้วน' });
    }
    if (ownerPassword.length < 8) return res.status(400).json({ error: 'รหัสผ่านอย่างน้อย 8 ตัวอักษร' });

    const dup = await query('select 1 from users where email = $1', [ownerEmail]);
    if (dup.rowCount) return res.status(409).json({ error: 'อีเมลนี้ถูกใช้แล้ว' });

    const hash = await bcrypt.hash(ownerPassword, Number(process.env.BCRYPT_ROUNDS) || 10);
    const out = await tx(async (client) => {
      const shop = (await client.query(
        "insert into shops (name, status) values ($1, 'trial') returning id", [shopName]
      )).rows[0];
      const user = (await client.query(
        'insert into users (email, password_hash) values ($1, $2) returning id', [ownerEmail, hash]
      )).rows[0];
      await client.query(
        "insert into memberships (user_id, shop_id, role) values ($1, $2, 'owner')",
        [user.id, shop.id]
      );
      await client.query("insert into shop_settings (shop_id, theme) values ($1, 'recipro')", [shop.id]);
      return { shopId: shop.id, userId: user.id };
    });
    logEvent(out.shopId, req.userId, 'admin.shop.create', { name: shopName, ownerEmail });
    res.json({ success: true, ...out });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// เปลี่ยนสถานะร้าน (trial | active | suspended)
router.patch('/shops/:id', async (req, res) => {
  try {
    const status = String(req.body.status || '');
    if (!['trial', 'active', 'suspended'].includes(status)) {
      return res.status(400).json({ error: 'สถานะไม่ถูกต้อง' });
    }
    await query('update shops set status = $1 where id = $2', [status, req.params.id]);
    logEvent(req.params.id, req.userId, 'admin.shop.status', { status });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Clone shop — คัดลอก master data จากร้านต้นทางไปปลายทาง
router.post('/clone-shop', async (req, res) => {
  try {
    const { srcShopId, dstShopId, what } = req.body;
    if (!srcShopId || !dstShopId) return res.status(400).json({ error: 'ระบุ srcShopId และ dstShopId' });
    if (srcShopId === dstShopId) return res.status(400).json({ error: 'ต้นทางและปลายทางต้องไม่ใช่ร้านเดียวกัน' });

    const doMaterials = what === 'materials' || what === 'all';
    const doRecipes   = what === 'recipes'   || what === 'all';

    // ตรวจสอบว่าร้านมีอยู่จริง
    const srcCheck = await query('select id from shops where id = $1', [srcShopId]);
    const dstCheck = await query('select id from shops where id = $1', [dstShopId]);
    if (!srcCheck.rowCount) return res.status(404).json({ error: 'ไม่พบร้านต้นทาง' });
    if (!dstCheck.rowCount) return res.status(404).json({ error: 'ไม่พบร้านปลายทาง' });

    let matCount = 0, recCount = 0;

    await tx(async (client) => {
      if (doMaterials) {
        // โหลดวัตถุดิบจากต้นทาง (ยกเว้น stock — ตั้งต้นที่ 0)
        const { rows: srcMats } = await client.query(
          'select * from materials where shop_id = $1', [srcShopId]
        );
        // ลบของเดิมในปลายทาง
        await client.query('delete from materials where shop_id = $1', [dstShopId]);
        // แทรกใหม่ด้วย shop_id ปลายทาง (stock = 0)
        for (const m of srcMats) {
          await client.query(
            `insert into materials (id, shop_id, sku, name, qty, unit, price, sell_price, supplier_id, order_url, stock, low_stock, category, conv_qty, stock_unit, is_consumable, sale_type, show_in_pos, sale_price_2)
             values ($1,$2,$3,$4,$5,$6,$7,$8,null,$9,0,$10,$11,$12,$13,$14,$15,$16,$17)`,
            [m.id, dstShopId, m.sku, m.name, m.qty, m.unit, m.price, m.sell_price, m.order_url || '', m.low_stock || 0, m.category || null, m.conv_qty || null, m.stock_unit || null, m.is_consumable ?? false, m.sale_type || 'INGREDIENT_ONLY', m.show_in_pos ?? false, m.sale_price_2 ?? null]
          );
        }
        matCount = srcMats.length;
      }

      if (doRecipes) {
        // โหลดสูตรและ recipe_items จากต้นทาง
        const { rows: srcRec } = await client.query('select * from recipes where shop_id = $1', [srcShopId]);
        const { rows: srcItems } = await client.query(
          'select ri.* from recipe_items ri join recipes r on r.id = ri.recipe_id where r.shop_id = $1', [srcShopId]
        );
        // ลบของเดิม
        await client.query(
          'delete from recipe_items where recipe_id in (select id from recipes where shop_id = $1)', [dstShopId]
        );
        await client.query('delete from recipes where shop_id = $1', [dstShopId]);
        // แทรกสูตรใหม่
        for (const r of srcRec) {
          await client.query(
            `insert into recipes (id, shop_id, code, name, sell_price, batch_yield, yield_unit, is_raw, steps, fg_stock, fg_low, category, opt_groups, img_data, is_sop)
             values ($1,$2,$3,$4,$5,$6,$7,$8,$9,0,$10,$11,$12,$13,$14)`,
            [r.id, dstShopId, r.code, r.name, r.sell_price, r.batch_yield, r.yield_unit, r.is_raw, r.steps, r.fg_low||0, r.category||null, r.opt_groups||null, r.img_data||null, r.is_sop || false]
          );
        }
        // แทรก recipe_items พร้อม role + sub_recipe_id (SOP) — id สูตรคงเดิมจึงอ้างถึงกันได้
        for (const it of srcItems) {
          await client.query(
            'insert into recipe_items (recipe_id, material_id, amount, role, sub_recipe_id) values ($1,$2,$3,$4,$5)',
            [it.recipe_id, it.material_id, it.amount, it.role || '', it.sub_recipe_id || null]
          );
        }
        recCount = srcRec.length;
      }
    });

    logEvent(dstShopId, req.userId, 'admin.clone-shop', { srcShopId, what, matCount, recCount });
    res.json({ ok: true, materials: matCount, recipes: recCount });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ข้อมูลดิบสำหรับแดชบอร์ด (frontend คิดสถิติเอง เหมือนเดิม)
router.get('/dashboard', async (req, res) => {
  try {
    const [shops, payments, subs] = await Promise.all([
      query('select id, name, status from shops'),
      query("select amount, status, paid_at from payments"),
      query('select shop_id, status, current_period_end, billing_cycle from subscriptions'),
    ]);
    res.json({ shops: shops.rows, payments: payments.rows, subscriptions: subs.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
