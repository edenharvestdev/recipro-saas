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
