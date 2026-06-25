// เฟส 3: หลายสาขา — รายชื่อสาขาของผู้ใช้ + ภาพรวมรวมสาขา (HQ)
// mount ใต้ /api (requireAuth + tenant)
const express = require('express');
const { query } = require('../db');
const router = express.Router();

// GET /api/my-shops — สาขาทั้งหมดที่ผู้ใช้คนนี้เป็นสมาชิก (ใช้ทำตัวสลับสาขา)
router.get('/my-shops', async (req, res) => {
  try {
    const { rows } = await query(
      `select s.id, s.name, m.role
         from memberships m join shops s on s.id = m.shop_id
        where m.user_id = $1 order by s.name`, [req.userId]);
    res.json({ shops: rows, current: req.shopId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/hq-summary?from=YYYY-MM-DD&to=YYYY-MM-DD — ยอดขาย/กำไรรวมทุกสาขาของผู้ใช้ (เจ้าของหลายสาขา)
// คิดจากบิลที่ paid ในช่วงเวลา; กำไร = ขาย - ต้นทุนวัตถุดิบ(จากสูตร) แบบประมาณ (เหมือนหน้ารายงาน)
router.get('/hq-summary', async (req, res) => {
  try {
    const from = String(req.query.from || '').slice(0, 10) || '1900-01-01';
    const to = String(req.query.to || '').slice(0, 10) || '2999-12-31';
    // เฉพาะสาขาที่ผู้ใช้เป็นสมาชิก
    const shopRows = (await query('select shop_id from memberships where user_id=$1', [req.userId])).rows;
    const shopIds = shopRows.map(r => r.shop_id);
    if (!shopIds.length) return res.json({ branches: [], totals: { sales: 0, bills: 0 } });

    // ยอดขายต่อสาขา (paid, ในช่วง) — total อ่านจาก items_json (sub - disc + tax) แบบเดียวกับ billTotal
    const { rows } = await query(
      `select s.id as shop_id, s.name,
              count(b.id)::int bills,
              coalesce(sum(
                greatest(0,
                  (select coalesce(sum((it->>'qty')::numeric * (it->>'price')::numeric),0)
                     from jsonb_array_elements(coalesce(b.items_json->'items','[]'::jsonb)) it)
                  - case when (b.items_json->>'discT')='%'
                         then (select coalesce(sum((it->>'qty')::numeric * (it->>'price')::numeric),0)
                                 from jsonb_array_elements(coalesce(b.items_json->'items','[]'::jsonb)) it) * coalesce((b.items_json->>'discV')::numeric,0)/100
                         else coalesce((b.items_json->>'discV')::numeric,0) end
                )
              ),0) as sales
         from shops s
         left join bills b on b.shop_id = s.id and b.status='paid'
              and coalesce(b.items_json->>'date','') >= $2 and coalesce(b.items_json->>'date','') <= $3
        where s.id = any($1::uuid[])
        group by s.id, s.name order by sales desc`,
      [shopIds, from, to]);

    const branches = rows.map(r => ({ shop_id: r.shop_id, name: r.name, bills: Number(r.bills) || 0, sales: Number(r.sales) || 0 }));
    const totals = branches.reduce((a, b) => ({ sales: a.sales + b.sales, bills: a.bills + b.bills }), { sales: 0, bills: 0 });
    res.json({ from, to, branches, totals });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
