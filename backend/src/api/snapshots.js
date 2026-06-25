// S1: สำรองข้อมูลอัตโนมัติในแอป + กู้คืนเอง (per-shop snapshot)
// mount ใต้ /api (requireAuth + tenant → req.shopId)
// ปรัชญา: กู้คืน = "เพิ่มเฉพาะแถวที่หาย" (ON CONFLICT DO NOTHING) — ไม่ลบ/ไม่ทับของปัจจุบันเด็ดขาด
const express = require('express');
const { query, tx } = require('../db');
const router = express.Router();

// ตารางข้อมูลหลัก (master data) ที่เก็บใน snapshot — เรียงตามลำดับ FK สำหรับตอน insert กลับ
const TABLES = [
  { t: 'suppliers',            sql: 'select * from suppliers where shop_id=$1' },
  { t: 'materials',            sql: 'select * from materials where shop_id=$1' },
  { t: 'recipes',              sql: 'select * from recipes where shop_id=$1' },
  { t: 'recipe_items',         sql: 'select ri.* from recipe_items ri join recipes r on r.id=ri.recipe_id where r.shop_id=$1' },
  { t: 'option_groups',        sql: 'select * from option_groups where shop_id=$1' },
  { t: 'option_choices',       sql: 'select oc.* from option_choices oc join option_groups og on og.id=oc.group_id where og.shop_id=$1' },
  { t: 'option_choice_links',  sql: 'select ocl.* from option_choice_links ocl join option_choices oc on oc.id=ocl.choice_id join option_groups og on og.id=oc.group_id where og.shop_id=$1' },
  { t: 'customers',            sql: 'select * from customers where shop_id=$1' },
];

// รวบรวมข้อมูลทั้งร้านเป็นก้อนเดียว (ใช้ทั้งตอนสร้าง snapshot และตอน pre-restore)
async function gatherShopData(shopId) {
  const data = {};
  const counts = {};
  for (const { t, sql } of TABLES) {
    const r = await query(sql, [shopId]);
    data[t] = r.rows;
    counts[t] = r.rows.length;
  }
  return { data, counts };
}

// แปลงค่า object/array → JSON string สำหรับ insert (ตรงกับวิธีใน restore-hb05.js ที่ใช้จริงแล้ว)
function toParam(v) {
  return (v !== null && typeof v === 'object' && !(v instanceof Date)) ? JSON.stringify(v) : v;
}

// insert เฉพาะแถวที่ "ยังไม่มี" — ON CONFLICT (id) DO NOTHING ไม่แตะของเดิม
async function insertMissing(client, table, rows) {
  let inserted = 0;
  for (const row of rows) {
    const keys = Object.keys(row);
    if (!keys.length) continue;
    const vals = keys.map(k => toParam(row[k]));
    const ph = keys.map((_, i) => '$' + (i + 1)).join(',');
    const r = await client.query(
      `insert into ${table} (${keys.join(',')}) values (${ph}) on conflict (id) do nothing`, vals);
    inserted += r.rowCount;
  }
  return inserted;
}

// สร้าง snapshot ใหม่ + ตัดเก่าให้เหลือ N ล่าสุด
async function createSnapshot(shopId, kind, label, keep = 20) {
  const { data, counts } = await gatherShopData(shopId);
  const ins = await query(
    `insert into shop_snapshots (shop_id, kind, label, counts, data)
     values ($1,$2,$3,$4,$5) returning id, created_at`,
    [shopId, kind || 'auto', label || '', JSON.stringify(counts), JSON.stringify(data)]);
  // prune: เก็บ N ล่าสุดต่อร้าน
  await query(
    `delete from shop_snapshots where shop_id=$1 and id not in (
       select id from shop_snapshots where shop_id=$1 order by created_at desc limit $2)`,
    [shopId, keep]);
  return { id: ins.rows[0].id, created_at: ins.rows[0].created_at, counts };
}

// auto-snapshot: เรียกหลัง /api/sync สำเร็จ — สร้างก็ต่อเมื่อ snapshot ล่าสุดเก่ากว่า minHours (ประหยัด)
// fire-and-forget: ถ้าพังต้องไม่กระทบ sync
async function maybeAutoSnapshot(shopId, minHours = 6) {
  try {
    const last = await query(
      'select created_at from shop_snapshots where shop_id=$1 order by created_at desc limit 1', [shopId]);
    if (last.rows[0]) {
      const ageMs = Date.now() - new Date(last.rows[0].created_at).getTime();
      if (ageMs < minHours * 3600 * 1000) return null;
    }
    return await createSnapshot(shopId, 'auto', 'สำรองอัตโนมัติ');
  } catch (e) { return null; }
}

// GET /api/snapshots — รายการ (ไม่ส่ง data ก้อนใหญ่)
router.get('/snapshots', async (req, res) => {
  if (!req.shopId) return res.status(400).json({ error: 'no shop' });
  try {
    const r = await query(
      'select id, created_at, kind, label, counts from shop_snapshots where shop_id=$1 order by created_at desc limit 50',
      [req.shopId]);
    res.json({ snapshots: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/snapshots/:id — ดึง data เต็ม (สำหรับดาวน์โหลด)
router.get('/snapshots/:id', async (req, res) => {
  if (!req.shopId) return res.status(400).json({ error: 'no shop' });
  try {
    const r = await query('select * from shop_snapshots where id=$1 and shop_id=$2', [req.params.id, req.shopId]);
    if (!r.rows[0]) return res.status(404).json({ error: 'not found' });
    res.json({ snapshot: r.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/snapshots — สำรองตอนนี้ (manual)
router.post('/snapshots', async (req, res) => {
  if (!req.shopId) return res.status(400).json({ error: 'no shop' });
  try {
    const out = await createSnapshot(req.shopId, 'manual', (req.body && req.body.label) || 'สำรองด้วยตนเอง');
    res.json({ ok: true, ...out });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/snapshots/:id/restore — กู้คืน "เพิ่มเฉพาะที่หาย" (ไม่ลบ/ไม่ทับ) + สำรองสถานะปัจจุบันก่อนเสมอ
router.post('/snapshots/:id/restore', async (req, res) => {
  if (!req.shopId) return res.status(400).json({ error: 'no shop' });
  try {
    const snap = await query('select data from shop_snapshots where id=$1 and shop_id=$2', [req.params.id, req.shopId]);
    if (!snap.rows[0]) return res.status(404).json({ error: 'not found' });
    const data = snap.rows[0].data || {};
    // กันพลาด: สำรองสถานะปัจจุบันไว้ก่อน (กดผิดก็ย้อนได้)
    await createSnapshot(req.shopId, 'pre_restore', 'ก่อนกู้คืน (อัตโนมัติ)');
    const restored = {};
    await tx(async (client) => {
      for (const { t } of TABLES) {
        const rows = (data[t] || []).filter(r => !r.shop_id || r.shop_id === req.shopId);
        restored[t] = await insertMissing(client, t, rows);
      }
    });
    res.json({ ok: true, restored });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
module.exports.maybeAutoSnapshot = maybeAutoSnapshot;
