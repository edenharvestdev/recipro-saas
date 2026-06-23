// R1: การเปลี่ยนสต๊อกแบบ atomic ฝั่งเซิร์ฟเวอร์ + บันทึก movement ลง DB (audit รายตัว, ใช้ร่วมทุกเครื่อง)
// ทุก endpoint บังคับ shop_id = req.shopId เสมอ (กันข้ามร้าน)
const express = require('express');
const { tx, query } = require('../db');
const router = express.Router();

const TBL = { material: { table: 'materials', col: 'stock' }, recipe: { table: 'recipes', col: 'fg_stock' } };

async function logMove(c, shopId, userId, m) {
  const r = await c.query(
    `insert into stock_movements (shop_id,user_id,kind,ref_type,ref_id,ref_name,unit,qty_before,qty_after,delta,note,consumption_category)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning id`,
    [shopId, userId || null, m.kind, m.ref_type, m.ref_id, m.ref_name || null, m.unit || null,
     m.before, m.after, (m.after - m.before), m.note || null, m.consumption_category || null]
  );
  return r.rows[0].id;
}

// ปรับ/รับเข้า/เบิก รายการเดียว — mode: 'set' (กำหนดค่าใหม่) | 'delta' (บวก/ลบ)
router.post('/stock/move', async (req, res) => {
  const { ref_type, ref_id, mode, value, kind, note, unit } = req.body || {};
  const meta = TBL[ref_type];
  if (!meta || !ref_id) return res.status(400).json({ error: 'bad ref' });
  const v = Number(value) || 0;
  try {
    const out = await tx(async (c) => {
      const cur = await c.query(
        `select id, name, ${meta.col} as q from ${meta.table} where id=$1 and shop_id=$2 for update`,
        [ref_id, req.shopId]);
      if (!cur.rowCount) return null;
      const before = Number(cur.rows[0].q) || 0;
      const after = Math.max(0, mode === 'set' ? v : before + v);
      await c.query(`update ${meta.table} set ${meta.col}=$1, updated_at=now() where id=$2`, [after, ref_id]);
      const movement_id = await logMove(c, req.shopId, req.userId, { kind: kind || 'adjust', ref_type, ref_id, ref_name: cur.rows[0].name, unit, before, after, note });
      return { before, after, movement_id };
    });
    if (!out) return res.status(404).json({ error: 'not found in this shop' });
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ผลิต SOP/สินค้า: ตัดวัตถุดิบตาม lines + เพิ่ม fg_stock — atomic ในทรานแซกชันเดียว
router.post('/stock/produce', async (req, res) => {
  const { recipe_id, rounds, made, lines } = req.body || {};
  const r = Number(rounds) || 1;
  try {
    const out = await tx(async (c) => {
      const rec = await c.query('select id,name,yield_unit,fg_stock from recipes where id=$1 and shop_id=$2 for update', [recipe_id, req.shopId]);
      if (!rec.rowCount) return null;
      const updated = [];
      for (const ln of (lines || [])) {
        const m = await c.query('select id,name,unit,stock from materials where id=$1 and shop_id=$2 for update', [ln.material_id, req.shopId]);
        if (!m.rowCount) continue;
        const before = Number(m.rows[0].stock) || 0;
        const after = Math.max(0, before - (Number(ln.amount) || 0) * r);
        await c.query('update materials set stock=$1, updated_at=now() where id=$2', [after, ln.material_id]);
        await logMove(c, req.shopId, req.userId, { kind: 'produce', ref_type: 'material', ref_id: ln.material_id, ref_name: m.rows[0].name, unit: ln.unit || m.rows[0].unit, before, after, note: 'ผลิต ' + rec.rows[0].name });
        updated.push({ material_id: ln.material_id, after });
      }
      const fgBefore = Number(rec.rows[0].fg_stock) || 0;
      const fgAfter = fgBefore + (Number(made) || 0);
      await c.query('update recipes set fg_stock=$1, updated_at=now() where id=$2', [fgAfter, recipe_id]);
      await logMove(c, req.shopId, req.userId, { kind: 'produce', ref_type: 'recipe', ref_id: recipe_id, ref_name: rec.rows[0].name, unit: rec.rows[0].yield_unit, before: fgBefore, after: fgAfter, note: 'ผลิตเข้าสต๊อก' });
      return { fgAfter, materials: updated };
    });
    if (!out) return res.status(404).json({ error: 'recipe not found' });
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ขาย (POS): ตัดสต๊อกหลายรายการ atomic — items: [{ref_type, ref_id, qty, unit?}]
router.post('/stock/sale', async (req, res) => {
  const { items, bill_no } = req.body || {};
  try {
    const out = await tx(async (c) => {
      const updated = [];
      for (const it of (items || [])) {
        const meta = TBL[it.ref_type];
        if (!meta || !it.ref_id) continue;
        const cur = await c.query(`select id,name,${meta.col} as q from ${meta.table} where id=$1 and shop_id=$2 for update`, [it.ref_id, req.shopId]);
        if (!cur.rowCount) continue;
        const before = Number(cur.rows[0].q) || 0;
        const after = Math.max(0, before - (Number(it.qty) || 0));
        await c.query(`update ${meta.table} set ${meta.col}=$1, updated_at=now() where id=$2`, [after, it.ref_id]);
        await logMove(c, req.shopId, req.userId, { kind: 'sale', ref_type: it.ref_type, ref_id: it.ref_id, ref_name: cur.rows[0].name, unit: it.unit, before, after, note: bill_no ? ('ขาย ' + bill_no) : 'ขาย' });
        updated.push({ ref_id: it.ref_id, ref_type: it.ref_type, after });
      }
      return { updated };
    });
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ประวัติการเคลื่อนไหวสต๊อก (ใช้ร่วมทุกเครื่อง)
router.get('/stock/movements', async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 200, 500);
    const { rows } = await query('select * from stock_movements where shop_id=$1 order by created_at desc limit $2', [req.shopId, limit]);
    res.json({ movements: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// R2 realtime (polling): อะไรเปลี่ยนไปบ้างตั้งแต่เวลา since → ให้เครื่องอื่นอัปเดตตาม + เด้ง popup
router.get('/changes', async (req, res) => {
  try {
    const since = req.query.since || new Date(Date.now() - 60000).toISOString();
    const [mv, mats, recs] = await Promise.all([
      query('select id, user_id, kind, ref_type, ref_id, ref_name, unit, qty_before, qty_after, delta, note, created_at from stock_movements where shop_id=$1 and created_at > $2 order by created_at asc limit 100', [req.shopId, since]),
      query('select id, stock, updated_at from materials where shop_id=$1 and updated_at > $2', [req.shopId, since]),
      query('select id, fg_stock, updated_at from recipes where shop_id=$1 and updated_at > $2', [req.shopId, since]),
    ]);
    res.json({ now: new Date().toISOString(), movements: mv.rows, materials: mats.rows, recipes: recs.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============================================================
// P3: ขายแบบรู้หมวด (category-aware) — endpoint ใหม่ ไม่แตะ /stock/sale เดิม
// body: { lines:[{ ref_type:'recipe'|'material', ref_id, qty }], bill_no, make_to_order }
// กฎ: ASSET/หมวดที่ is_stock_deducted=false → ไม่ตัด · packaging → log 'on_sale'
//     recipe make_to_order → ขยาย BOM (วัตถุดิบตัด stock, สูตรซ้อนตัด fg_stock ของกลาง)
//     recipe ปกติ → ตัด fg_stock ของเมนู (ขายของที่ผลิตเก็บไว้)
// ============================================================
router.post('/pos/sell', async (req, res) => {
  const { lines, bill_no, make_to_order } = req.body || {};
  if (!Array.isArray(lines) || !lines.length) return res.status(400).json({ error: 'no lines' });
  const note = bill_no ? ('ขาย ' + bill_no) : 'ขาย';
  try {
    const out = await tx(async (c) => {
      // หมวด: code -> { deducted, event }
      const cats = {};
      for (const r of (await c.query('select code, is_stock_deducted, deduct_event from item_categories')).rows) {
        cats[r.code] = { deducted: r.is_stock_deducted, event: r.deduct_event };
      }
      const results = [];

      const deductMaterial = async (matId, amount, defaultCcat) => {
        const m = (await c.query(
          'select id,name,unit,stock,item_type from materials where id=$1 and shop_id=$2 for update',
          [matId, req.shopId])).rows[0];
        if (!m) return;
        const cat = m.item_type ? cats[m.item_type] : null;
        if (cat && cat.deducted === false) { // ASSET / SALE ฯลฯ → ไม่ตัดสต๊อกตัวเอง
          results.push({ type: 'skip', ref_id: matId, item_type: m.item_type });
          return;
        }
        const ccat = (cat && cat.event && cat.event !== 'none') ? cat.event : defaultCcat;
        const before = Number(m.stock) || 0;
        const after = Math.max(0, before - amount);
        await c.query('update materials set stock=$1, updated_at=now() where id=$2', [after, matId]);
        await logMove(c, req.shopId, req.userId, { kind: 'sale', ref_type: 'material', ref_id: matId, ref_name: m.name, unit: m.unit, before, after, note, consumption_category: ccat });
        results.push({ type: 'material', ref_id: matId, item_type: m.item_type || null, before, after });
      };

      const deductRecipeFg = async (rec, amount, ccat, tag) => {
        const before = Number(rec.fg_stock) || 0;
        const after = Math.max(0, before - amount);
        await c.query('update recipes set fg_stock=$1, updated_at=now() where id=$2', [after, rec.id]);
        await logMove(c, req.shopId, req.userId, { kind: 'sale', ref_type: 'recipe', ref_id: rec.id, ref_name: rec.name, unit: rec.yield_unit, before, after, note, consumption_category: ccat });
        results.push({ type: tag, ref_id: rec.id, before, after });
      };

      for (const ln of (lines || [])) {
        const qty = Number(ln.qty) || 0;
        if (qty <= 0) continue;

        if (ln.ref_type === 'material') {
          await deductMaterial(ln.ref_id, qty, 'on_sale');
        } else if (ln.ref_type === 'recipe') {
          const rec = (await c.query('select id,name,fg_stock,yield_unit from recipes where id=$1 and shop_id=$2 for update', [ln.ref_id, req.shopId])).rows[0];
          if (!rec) continue;
          if (make_to_order) {
            const items = (await c.query('select material_id, sub_recipe_id, amount from recipe_items where recipe_id=$1', [ln.ref_id])).rows;
            for (const it of items) {
              const amt = (Number(it.amount) || 0) * qty;
              if (amt <= 0) continue;
              if (it.sub_recipe_id) {
                const sub = (await c.query('select id,name,fg_stock,yield_unit from recipes where id=$1 and shop_id=$2 for update', [it.sub_recipe_id, req.shopId])).rows[0];
                if (sub) await deductRecipeFg(sub, amt, 'recipe_use', 'sub_recipe');
              } else if (it.material_id) {
                await deductMaterial(it.material_id, amt, 'recipe_use');
              }
            }
          } else {
            await deductRecipeFg(rec, qty, 'on_sale', 'recipe_fg');
          }
        }
      }
      return { results };
    });
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
