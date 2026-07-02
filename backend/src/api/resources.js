// ลบรายการเดี่ยว (suppliers/materials/recipes/bills) — scoped ด้วย shop_id เสมอ
const express = require('express');
const { query, tx } = require('../db');
const { logEvent } = require('../logs');
const router = express.Router();

const TABLES = ['suppliers', 'materials', 'recipes', 'bills']; // whitelist กัน SQL injection
// คอลัมน์ที่ใช้แสดงชื่อรายการใน audit log (bills ใช้เลขที่บิล)
const NAME_COL = { suppliers: 'name', materials: 'name', recipes: 'name', bills: 'number' };
const KIND_TH = { suppliers: 'ผู้ขาย', materials: 'วัตถุดิบ', recipes: 'สูตร/เมนู', bills: 'บิล' };
// A0: destructive deletes require the matching permission (was previously ungated → any staff).
const PERM_BY_TABLE = { suppliers: 'recipe_edit', materials: 'recipe_edit', recipes: 'recipe_edit', bills: 'bill_edit_draft' };

for (const table of TABLES) {
  router.delete(`/${table}/:id`, async (req, res) => {
    try {
      if (!req.hasPerm(PERM_BY_TABLE[table])) {
        return res.status(403).json({ error: 'PERMISSION_DENIED', code: 'PERMISSION_DENIED', resource: table });
      }
      // Safety: a lifecycle-managed bill (CONFIRMED / VOIDED / REPLACED) must NEVER be
      // destructively deleted — those are voided via /bills/:id/void so stock reverses
      // atomically and audit is retained. Only a DRAFT (or a legacy pre-lifecycle bill
      // with NULL status) may be removed here. Confirmed sales are never trashed.
      if (table === 'bills') {
        const cur = (await query('select lifecycle_status from bills where id = $1 and shop_id = $2', [req.params.id, req.shopId])).rows[0];
        if (cur && ['CONFIRMED', 'VOIDED', 'REPLACED'].includes(cur.lifecycle_status)) {
          return res.status(409).json({ error: 'CONFIRMED_BILL_NOT_DELETABLE', lifecycle_status: cur.lifecycle_status });
        }
        // Only a DRAFT (or legacy NULL) reaches here. It has no stock links; its audit is just the
        // 'created' entry. Clear the FK children then the bill, atomically, so the delete succeeds.
        const name = cur ? ((await query('select number from bills where id=$1 and shop_id=$2', [req.params.id, req.shopId])).rows[0] || {}).number : null;
        await tx(async (c) => {
          // Release any un-confirmed coupon reservation so the code frees up (draft never redeemed it).
          await require('../coupons/redemption').releaseDraft(c, req.shopId, req.params.id);
          await c.query('delete from bill_stock_movements where bill_id = $1 and shop_id = $2', [req.params.id, req.shopId]);
          await c.query('delete from bill_audit_log where bill_id = $1 and shop_id = $2', [req.params.id, req.shopId]);
          await c.query('delete from bills where id = $1 and shop_id = $2', [req.params.id, req.shopId]);
        });
        logEvent(req.shopId, req.userId, 'data.delete', { table, kind: KIND_TH[table], id: req.params.id, name });
        return res.json({ ok: true });
      }
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
