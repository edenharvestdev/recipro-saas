// ลบรายการเดี่ยว (suppliers/materials/recipes/bills) — scoped ด้วย shop_id เสมอ
const express = require('express');
const { query } = require('../db');
const { logEvent } = require('../logs');
const router = express.Router();

const TABLES = ['suppliers', 'materials', 'recipes', 'bills']; // whitelist กัน SQL injection
// คอลัมน์ที่ใช้แสดงชื่อรายการใน audit log (bills ใช้เลขที่บิล)
const NAME_COL = { suppliers: 'name', materials: 'name', recipes: 'name', bills: 'number' };
const KIND_TH = { suppliers: 'ผู้ขาย', materials: 'วัตถุดิบ', recipes: 'สูตร/เมนู', bills: 'บิล' };

for (const table of TABLES) {
  router.delete(`/${table}/:id`, async (req, res) => {
    try {
      // ดึงชื่อก่อนลบ เพื่อบันทึกว่า "ใครลบอะไร" (เวลาข้อมูลหายจะตามรอยได้)
      const before = await query(`select ${NAME_COL[table]} as name from ${table} where id = $1 and shop_id = $2`, [req.params.id, req.shopId]);
      const name = before.rows[0] ? before.rows[0].name : null;
      // recipes มี FK on delete cascade → recipe_items ถูกลบตาม
      await query(`delete from ${table} where id = $1 and shop_id = $2`, [req.params.id, req.shopId]);
      logEvent(req.shopId, req.userId, 'data.delete', { table, kind: KIND_TH[table], id: req.params.id, name });
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
}

module.exports = router;
