// /auth — register / login / refresh / me
const express = require('express');
const bcrypt = require('bcryptjs');
const { query, tx } = require('../db');
const { signAccess, signRefresh, verifyRefresh } = require('./tokens');
const { requireAuth } = require('./middleware');

const router = express.Router();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function membershipsOf(userId) {
  const { rows } = await query(
    'select shop_id, role from memberships where user_id = $1 order by role = $2 desc',
    [userId, 'superadmin']
  );
  return rows;
}

// สมัครสมาชิกแบบ self-serve: สร้างผู้ใช้ + ร้านทดลอง (trial) + membership 'owner' ให้เลย
// → สมัครเสร็จล็อกอินเข้าใช้ร้านของตัวเองได้ทันที
router.post('/register', async (req, res) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const shopName = String(req.body.shopName || '').trim() || 'ร้านของฉัน';
    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'อีเมลไม่ถูกต้อง' });
    if (password.length < 8) return res.status(400).json({ error: 'รหัสผ่านอย่างน้อย 8 ตัวอักษร' });

    const exists = await query('select 1 from users where email = $1', [email]);
    if (exists.rowCount) return res.status(409).json({ error: 'อีเมลนี้ถูกใช้แล้ว' });

    const hash = await bcrypt.hash(password, Number(process.env.BCRYPT_ROUNDS) || 10);
    const out = await tx(async (client) => {
      const user = (await client.query(
        'insert into users (email, password_hash) values ($1, $2) returning id, email', [email, hash]
      )).rows[0];
      const shop = (await client.query(
        "insert into shops (name, status) values ($1, 'trial') returning id", [shopName]
      )).rows[0];
      await client.query(
        "insert into memberships (user_id, shop_id, role) values ($1, $2, 'owner')", [user.id, shop.id]
      );
      await client.query("insert into shop_settings (shop_id, theme) values ($1, 'recipro')", [shop.id]);
      return { user, shopId: shop.id };
    });

    res.json({
      user: out.user,
      memberships: [{ shop_id: out.shopId, role: 'owner' }],
      accessToken: signAccess(out.user.id),
      refreshToken: signRefresh(out.user.id),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/login', async (req, res) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const { rows } = await query('select id, email, password_hash from users where email = $1', [email]);
    const user = rows[0];
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ error: 'อีเมลหรือรหัสผ่านไม่ถูกต้อง' });
    }
    res.json({
      user: { id: user.id, email: user.email },
      memberships: await membershipsOf(user.id),
      accessToken: signAccess(user.id),
      refreshToken: signRefresh(user.id),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/refresh', async (req, res) => {
  try {
    const { refreshToken } = req.body || {};
    if (!refreshToken) return res.status(400).json({ error: 'Missing refreshToken' });
    const payload = verifyRefresh(refreshToken);
    res.json({ accessToken: signAccess(payload.sub) });
  } catch (e) {
    res.status(401).json({ error: 'Invalid refresh token' });
  }
});

router.get('/me', requireAuth, async (req, res) => {
  try {
    const { rows } = await query('select id, email from users where id = $1', [req.userId]);
    if (!rows[0]) return res.status(404).json({ error: 'User not found' });
    res.json({ user: rows[0], memberships: await membershipsOf(req.userId) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
