// จัดการทีมงานของร้าน (เจ้าของ/แอดมินเท่านั้น) — เพิ่ม/แก้ role/เอาออก
// mount ใต้ /api (requireAuth + tenant ตั้ง req.shopId/req.role/req.userId/req.isSuperadmin)
const express = require('express');
const bcrypt = require('bcryptjs');
const { query } = require('../db');
const router = express.Router();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function canManage(req) { return req.isSuperadmin || req.role === 'owner'; }

// GET /api/staff — รายชื่อทีมงานของร้านนี้
router.get('/staff', async (req, res) => {
  if (!req.shopId) return res.status(400).json({ error: 'no shop' });
  if (!canManage(req)) return res.status(403).json({ error: 'forbidden' });
  try {
    const r = await query(
      `select m.user_id, u.email, m.role from memberships m join users u on u.id = m.user_id
        where m.shop_id = $1 order by m.role = 'owner' desc, u.email`, [req.shopId]);
    res.json({ staff: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/staff — เพิ่มพนักงาน (สร้าง user ใหม่ถ้ายังไม่มี) แล้วผูกกับร้านนี้
router.post('/staff', async (req, res) => {
  if (!req.shopId) return res.status(400).json({ error: 'no shop' });
  if (!canManage(req)) return res.status(403).json({ error: 'forbidden' });
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  let role = String(req.body.role || 'staff');
  if (!['staff', 'owner'].includes(role)) role = 'staff';   // กันตั้ง superadmin ผ่าน endpoint นี้
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'อีเมลไม่ถูกต้อง' });
  try {
    let u = (await query('select id from users where email = $1', [email])).rows[0];
    if (!u) {
      if (password.length < 6) return res.status(400).json({ error: 'รหัสผ่านอย่างน้อย 6 ตัวอักษร' });
      const hash = await bcrypt.hash(password, Number(process.env.BCRYPT_ROUNDS) || 10);
      u = (await query('insert into users (email, password_hash) values ($1,$2) returning id', [email, hash])).rows[0];
    }
    const ex = (await query('select 1 from memberships where user_id=$1 and shop_id=$2', [u.id, req.shopId])).rowCount;
    if (ex) return res.status(409).json({ error: 'ผู้ใช้นี้อยู่ในร้านนี้แล้ว' });
    await query('insert into memberships (user_id, shop_id, role) values ($1,$2,$3)', [u.id, req.shopId, role]);
    res.json({ ok: true, user_id: u.id, email, role });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/staff/:userId — เปลี่ยน role
router.patch('/staff/:userId', async (req, res) => {
  if (!req.shopId || !canManage(req)) return res.status(403).json({ error: 'forbidden' });
  const role = String(req.body.role || '');
  if (!['staff', 'owner'].includes(role)) return res.status(400).json({ error: 'role ไม่ถูกต้อง' });
  if (req.params.userId === req.userId && role !== 'owner') return res.status(400).json({ error: 'เปลี่ยนสิทธิ์ตัวเองไม่ได้' });
  try {
    const r = await query('update memberships set role=$1 where user_id=$2 and shop_id=$3 returning user_id', [role, req.params.userId, req.shopId]);
    if (!r.rowCount) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/staff/:userId — เอาออกจากร้านนี้
router.delete('/staff/:userId', async (req, res) => {
  if (!req.shopId || !canManage(req)) return res.status(403).json({ error: 'forbidden' });
  if (req.params.userId === req.userId) return res.status(400).json({ error: 'ลบตัวเองไม่ได้' });
  try {
    const owners = (await query("select count(*)::int n from memberships where shop_id=$1 and role='owner'", [req.shopId])).rows[0].n;
    const target = (await query('select role from memberships where user_id=$1 and shop_id=$2', [req.params.userId, req.shopId])).rows[0];
    if (!target) return res.status(404).json({ error: 'not found' });
    if (target.role === 'owner' && owners <= 1) return res.status(400).json({ error: 'ลบเจ้าของคนสุดท้ายไม่ได้' });
    await query('delete from memberships where user_id=$1 and shop_id=$2', [req.params.userId, req.shopId]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
