// เฟส 3: จัดการออเดอร์ออนไลน์ฝั่งร้าน — ดูคิวล่าสุด + อัปเดตสถานะ/จ่ายแล้ว
// mount ใต้ /api (requireAuth + tenant ตั้ง req.shopId ให้แล้ว)
const express = require('express');
const { query } = require('../db');
const router = express.Router();

const STATUSES = ['pending', 'preparing', 'ready', 'collected', 'cancelled'];

// GET /api/orders — ดึงออเดอร์ล่าสุดของร้านนี้ (ใช้รีเฟรชคิว เห็นออเดอร์ใหม่ของลูกค้า)
router.get('/orders', async (req, res) => {
  if (!req.shopId) return res.status(400).json({ error: 'no shop' });
  try {
    const r = await query('select * from orders where shop_id = $1 order by created_at desc limit 200', [req.shopId]);
    res.json({ orders: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/orders/:id — อัปเดตสถานะ และ/หรือ จ่ายแล้ว (บังคับ shop_id เสมอ กันข้ามร้าน)
router.patch('/orders/:id', async (req, res) => {
  if (!req.shopId) return res.status(400).json({ error: 'no shop' });
  const { status, paid } = req.body || {};
  const assign = [], params = [];
  if (status != null) {
    if (!STATUSES.includes(status)) return res.status(400).json({ error: 'bad status' });
    params.push(status); assign.push('status = $' + params.length);
  }
  if (paid != null) { params.push(!!paid); assign.push('paid = $' + params.length); }
  if (!assign.length) return res.status(400).json({ error: 'nothing to update' });
  params.push(req.params.id); const idPos = params.length;
  params.push(req.shopId); const shopPos = params.length;
  try {
    const r = await query(
      `update orders set ${assign.join(', ')} where id = $${idPos} and shop_id = $${shopPos} returning *`,
      params);
    if (!r.rows[0]) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true, order: r.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
