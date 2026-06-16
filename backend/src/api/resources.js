// ลบรายการเดี่ยว (suppliers/materials/recipes/bills) — scoped ด้วย shop_id เสมอ
const express = require('express');
const { query } = require('../db');
const router = express.Router();

const TABLES = ['suppliers', 'materials', 'recipes', 'bills']; // whitelist กัน SQL injection

for (const table of TABLES) {
  router.delete(`/${table}/:id`, async (req, res) => {
    try {
      // recipes มี FK on delete cascade → recipe_items ถูกลบตาม
      await query(`delete from ${table} where id = $1 and shop_id = $2`, [req.params.id, req.shopId]);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
}

module.exports = router;
