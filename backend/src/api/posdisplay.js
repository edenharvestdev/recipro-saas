// S5: QR Box (จอลูกค้า) — แคชเชียร์ push ยอด, จอลูกค้า poll มาแสดง QR
// mount ใต้ /api (requireAuth + tenant → req.shopId); ทั้งสองเครื่อง login ร้านเดียวกัน
const express = require('express');
const { query } = require('../db');
const router = express.Router();

// GET /api/pos-display — จอลูกค้าดึงสถานะล่าสุด
router.get('/pos-display', async (req, res) => {
  if (!req.shopId) return res.status(400).json({ error: 'no shop' });
  try {
    const r = await query('select amount, status, bill_no, updated_at from pos_display where shop_id=$1', [req.shopId]);
    res.json(r.rows[0] || { amount: 0, status: 'idle', bill_no: '', updated_at: null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/pos-display { amount, status, bill_no } — แคชเชียร์ push ยอดไปจอ
router.post('/pos-display', async (req, res) => {
  if (!req.shopId) return res.status(400).json({ error: 'no shop' });
  const amount = Number(req.body.amount) || 0;
  const status = ['idle', 'await', 'paid'].includes(req.body.status) ? req.body.status : 'idle';
  const billNo = String(req.body.bill_no || '').slice(0, 40);
  try {
    await query(
      `insert into pos_display (shop_id, amount, status, bill_no, updated_at) values ($1,$2,$3,$4, now())
       on conflict (shop_id) do update set amount=$2, status=$3, bill_no=$4, updated_at=now()`,
      [req.shopId, amount, status, billNo]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
