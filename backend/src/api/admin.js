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
        "insert into shops (name, status, trial_ends_at) values ($1, 'trial', now() + interval '30 days') returning id", [shopName]
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
            `insert into recipes (id, shop_id, code, name, sell_price, batch_yield, yield_unit, is_raw, steps, fg_stock, fg_low, category, opt_groups, img_data, is_sop, on_menu)
             values ($1,$2,$3,$4,$5,$6,$7,$8,$9,0,$10,$11,$12,$13,$14,$15)`,
            [r.id, dstShopId, r.code, r.name, r.sell_price, r.batch_yield, r.yield_unit, r.is_raw, r.steps, r.fg_low||0, r.category||null, r.opt_groups||null, r.img_data||null, r.is_sop || false, r.on_menu]
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

// ===== Billing admin (เฟส 1): ดูทุกร้าน + ต่ออายุ manual + จัดการแพ็กเกจ =====
const { computeBillingState, GRACE_DAYS } = require('../billing-state');

// ภาพรวมบิลลิ่งทุกร้าน (เรียงร้านที่ต้องสนใจขึ้นก่อน)
router.get('/billing', async (req, res) => {
  try {
    const [shops, subs, plans, pays] = await Promise.all([
      query('select id, name, status, created_at, trial_ends_at from shops order by created_at'),
      query('select shop_id, plan_id, status, billing_cycle, current_period_end from subscriptions'),
      query('select id, name, code, price_month, price_year from plans'),
      query("select shop_id, amount, paid_at from payments where status='paid' order by paid_at desc"),
    ]);
    const subBy = {}; subs.rows.forEach(s => { subBy[s.shop_id] = s; });
    const planBy = {}; plans.rows.forEach(p => { planBy[p.id] = p; });
    const lastPay = {}; pays.rows.forEach(p => { if (!lastPay[p.shop_id]) lastPay[p.shop_id] = p; });
    const order = { readonly: 0, grace: 1, expiring: 2, suspended: 3, trial: 4, active: 5 };
    const list = shops.rows.map(sh => {
      const sub = subBy[sh.id];
      const bs = computeBillingState(sh.status, sub, sh.trial_ends_at);
      const plan = sub && sub.plan_id ? planBy[sub.plan_id] : null;
      return {
        shop_id: sh.id, name: sh.name, shop_status: sh.status,
        plan_name: plan ? plan.name : null, plan_code: plan ? plan.code : null,
        billing_cycle: sub ? sub.billing_cycle : null,
        current_period_end: sub ? sub.current_period_end : null,
        trial_ends_at: sh.trial_ends_at,
        state: bs.state, days_left: bs.daysLeft,
        last_payment: lastPay[sh.id] || null,
      };
    }).sort((a, b) => (order[a.state] ?? 9) - (order[b.state] ?? 9) || ((a.days_left ?? 1e9) - (b.days_left ?? 1e9)));
    res.json({ shops: list, grace_days: GRACE_DAYS });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ต่ออายุ manual (โอน/พร้อมเพย์) — ยืนยันรับเงิน + ต่อ N เดือน + บันทึก payment
router.post('/billing/:shopId/extend', async (req, res) => {
  try {
    const shopId = req.params.shopId;
    const months = Math.max(1, Math.min(36, Number(req.body.months) || 1));
    const amount = Number(req.body.amount) || 0;
    const planId = req.body.planId || null;
    const out = await tx(async (c) => {
      const sh = (await c.query('select id from shops where id=$1', [shopId])).rows[0];
      if (!sh) return null;
      const cur = (await c.query('select id, plan_id, current_period_end from subscriptions where shop_id=$1 limit 1', [shopId])).rows[0];
      const base = cur && cur.current_period_end && new Date(cur.current_period_end) > new Date() ? new Date(cur.current_period_end) : new Date();
      base.setMonth(base.getMonth() + months);
      const newEnd = base.toISOString();
      const usePlan = planId || (cur && cur.plan_id) || null;
      const cycle = months >= 12 ? 'year' : 'month';
      if (cur) {
        await c.query("update subscriptions set status='active', plan_id=coalesce($2,plan_id), billing_cycle=$3, current_period_end=$4, provider='manual' where id=$1", [cur.id, usePlan, cycle, newEnd]);
      } else {
        await c.query("insert into subscriptions (shop_id, plan_id, status, billing_cycle, current_period_end, provider) values ($1,$2,'active',$3,$4,'manual')", [shopId, usePlan, cycle, newEnd]);
      }
      await c.query("update shops set status='active' where id=$1", [shopId]);
      if (amount > 0) await c.query("insert into payments (shop_id, amount, currency, status, paid_at, provider_invoice_id) values ($1,$2,'THB','paid',now(),$3)", [shopId, amount, 'manual']);
      return { current_period_end: newEnd, months, amount };
    });
    if (!out) return res.status(404).json({ error: 'ไม่พบร้าน' });
    logEvent(shopId, req.userId, 'billing.manual_extend', out);
    res.json({ ok: true, ...out });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// เปลี่ยนแพ็กเกจของร้าน (ไม่คิดเงิน — แค่ตั้ง plan)
router.post('/billing/:shopId/plan', async (req, res) => {
  try {
    const { shopId } = req.params; const { planId } = req.body || {};
    const cur = (await query('select id from subscriptions where shop_id=$1 limit 1', [shopId])).rows[0];
    if (cur) await query('update subscriptions set plan_id=$2 where id=$1', [cur.id, planId]);
    else await query("insert into subscriptions (shop_id, plan_id, status) values ($1,$2,'trialing')", [shopId, planId]);
    logEvent(shopId, req.userId, 'billing.set_plan', { planId });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// จัดการแพ็กเกจ (CRUD) — superadmin
router.get('/plans-admin', async (req, res) => {
  try { const { rows } = await query('select * from plans order by sort, price_month'); res.json({ plans: rows }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/plans-admin', async (req, res) => {
  try {
    const { id, name, price_month, price_year, active, features_json, code, sort } = req.body || {};
    if (id) {
      await query('update plans set name=$2, price_month=$3, price_year=$4, active=$5, features_json=coalesce($6,features_json), sort=coalesce($7,sort) where id=$1',
        [id, name, Number(price_month) || 0, Number(price_year) || 0, active !== false, features_json || null, sort != null ? Number(sort) : null]);
      res.json({ ok: true, id });
    } else {
      const r = await query('insert into plans (name, price_month, price_year, active, features_json, code, sort) values ($1,$2,$3,$4,$5,$6,$7) returning id',
        [name, Number(price_month) || 0, Number(price_year) || 0, active !== false, features_json || '{}', code || null, Number(sort) || 0]);
      res.json({ ok: true, id: r.rows[0].id });
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
