// GET /api/logs — บันทึกกิจกรรม (เจ้าของร้านเห็นของร้านตัวเอง · superadmin เห็นทั้งระบบ)
const express = require('express');
const { query } = require('../db');
const router = express.Router();

router.get('/logs', async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 200, 500);
    let rows;
    if (req.role === 'superadmin') {
      rows = (await query(
        `select l.id, l.action, l.detail, l.created_at, u.email, s.name as shop_name
           from logs l
           left join users u on u.id = l.user_id
           left join shops s on s.id = l.shop_id
          order by l.created_at desc limit $1`, [limit]
      )).rows;
    } else {
      if (!req.shopId) return res.json({ logs: [] });
      rows = (await query(
        `select l.id, l.action, l.detail, l.created_at, u.email
           from logs l left join users u on u.id = l.user_id
          where l.shop_id = $1 order by l.created_at desc limit $2`, [req.shopId, limit]
      )).rows;
    }
    res.json({ logs: rows, scope: req.role === 'superadmin' ? 'all' : 'shop' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
