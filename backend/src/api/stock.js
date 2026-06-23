// R1: การเปลี่ยนสต๊อกแบบ atomic ฝั่งเซิร์ฟเวอร์ + บันทึก movement ลง DB (audit รายตัว, ใช้ร่วมทุกเครื่อง)
// ทุก endpoint บังคับ shop_id = req.shopId เสมอ (กันข้ามร้าน)
const express = require('express');
const { tx, query } = require('../db');
const router = express.Router();

const TBL = { material: { table: 'materials', col: 'stock' }, recipe: { table: 'recipes', col: 'fg_stock' } };

async function logMove(c, shopId, userId, m) {
  const r = await c.query(
    `insert into stock_movements (shop_id,user_id,kind,ref_type,ref_id,ref_name,unit,qty_before,qty_after,delta,note,consumption_category,actor_name)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning id`,
    [shopId, userId || null, m.kind, m.ref_type, m.ref_id, m.ref_name || null, m.unit || null,
     m.before, m.after, (m.after - m.before), m.note || null, m.consumption_category || null, m.actor_name || null]
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

// ตัดของเสีย — หักสต๊อก (วัตถุดิบ/สินค้าพร้อมขาย) + บันทึก movement kind='waste'
// ของเสียได้ทุกหมวด (รวม ASSET/SALE) เพราะของชำรุด/เสียต้องหักได้จริง — ไม่ปรึกษา item_categories
router.post('/stock/waste', async (req, res) => {
  const { ref_type, ref_id, qty, reason, note, unit, actor_name } = req.body || {};
  const meta = TBL[ref_type];
  const amt = Number(qty) || 0;
  if (!meta || !ref_id || !(amt > 0)) return res.status(400).json({ error: 'bad waste input' });
  try {
    const out = await tx(async (c) => {
      const cur = await c.query(
        `select id, name, ${meta.col} as q from ${meta.table} where id=$1 and shop_id=$2 for update`,
        [ref_id, req.shopId]);
      if (!cur.rowCount) return null;
      const before = Number(cur.rows[0].q) || 0;
      const after = Math.max(0, before - amt);
      await c.query(`update ${meta.table} set ${meta.col}=$1, updated_at=now() where id=$2`, [after, ref_id]);
      const movement_id = await logMove(c, req.shopId, req.userId, {
        kind: 'waste', ref_type, ref_id, ref_name: cur.rows[0].name, unit,
        before, after, note: note || null, consumption_category: reason || 'other', actor_name: actor_name || null,
      });
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
        // ASSET: ไม่หักตัวเองเสมอ · SALE: ข้ามเมื่อใช้เป็นส่วนผสมในสูตร (recipe_use) แต่ถ้า "ขายตรง" (on_sale) ให้หักสต๊อกตัวเอง
        const isDirectSale = defaultCcat === 'on_sale';
        if (cat && cat.deducted === false && !(m.item_type === 'SALE' && isDirectSale)) {
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

      // M2: effective BOM ฝั่ง server จากสูตร + options (mirror resolveLineBOM: RECIPE_VARIANT/REPLACE/ADD, ข้าม is_metadata_only)
      const buildEffectiveBom = async (recipeId, chosenOptions) => {
        const opts = Array.isArray(chosenOptions) ? chosenOptions.filter((o) => o && o.choice_id) : [];
        let choices = [];
        if (opts.length) {
          const ids = opts.map((o) => o.choice_id);
          const qById = {}; opts.forEach((o) => { qById[o.choice_id] = Number(o.qty) || 1; });
          const cr = (await c.query('select id, effect_type, target_role, variant_recipe_id, is_metadata_only from option_choices where id = any($1::uuid[])', [ids])).rows;
          const lr = (await c.query('select choice_id, material_id, amount from option_choice_links where choice_id = any($1::uuid[])', [ids])).rows;
          const byChoice = {}; lr.forEach((l) => { (byChoice[l.choice_id] = byChoice[l.choice_id] || []).push(l); });
          choices = cr.map((x) => ({ ...x, qty: qById[x.id] || 1, links: byChoice[x.id] || [] })).filter((x) => !x.is_metadata_only);
        }
        const variant = choices.find((x) => x.effect_type === 'RECIPE_VARIANT' && x.variant_recipe_id);
        const baseId = variant ? variant.variant_recipe_id : recipeId;
        const items = (await c.query('select material_id, sub_recipe_id, amount, role from recipe_items where recipe_id=$1', [baseId])).rows;
        const bom = new Map(); const subs = []; const roleIndex = new Map();
        for (const it of items) {
          if (it.sub_recipe_id) { subs.push({ sub_recipe_id: it.sub_recipe_id, amount: Number(it.amount) || 0 }); continue; }
          if (!it.material_id) continue;
          const e = bom.get(it.material_id) || { amount: 0 };
          e.amount += Number(it.amount) || 0; bom.set(it.material_id, e);
          if (it.role) roleIndex.set(it.role, it.material_id);
        }
        for (const ch of choices) { // REPLACE
          if (ch.effect_type !== 'REPLACE' || !ch.target_role) continue;
          const oldId = roleIndex.get(ch.target_role);
          if (oldId) { bom.delete(oldId); roleIndex.delete(ch.target_role); }
          for (const l of ch.links) { if (!l.material_id) continue; const e = bom.get(l.material_id) || { amount: 0 }; e.amount += Number(l.amount) || 0; bom.set(l.material_id, e); roleIndex.set(ch.target_role, l.material_id); }
        }
        for (const ch of choices) { // ADD
          if (ch.effect_type !== 'ADD') continue;
          for (const l of ch.links) { if (!l.material_id) continue; const e = bom.get(l.material_id) || { amount: 0 }; e.amount += (Number(l.amount) || 0) * (ch.qty || 1); bom.set(l.material_id, e); }
        }
        for (const [k, v] of bom) { if (v.amount <= 0) bom.delete(k); }
        return { bom, subs };
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
            // M2: ขยาย BOM ตาม options (ถ้าไม่มี chosen_options = สูตรปกติ) แล้วตัดสต๊อก
            const { bom, subs } = await buildEffectiveBom(ln.ref_id, ln.chosen_options);
            for (const [matId, entry] of bom) {
              if (entry.amount * qty <= 0) continue;
              await deductMaterial(matId, entry.amount * qty, 'recipe_use');
            }
            for (const s of subs) {
              if (s.amount * qty <= 0) continue;
              const sub = (await c.query('select id,name,fg_stock,yield_unit from recipes where id=$1 and shop_id=$2 for update', [s.sub_recipe_id, req.shopId])).rows[0];
              if (sub) await deductRecipeFg(sub, s.amount * qty, 'recipe_use', 'sub_recipe');
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

// ============================================================
// P5: เตือนสั่งของ — รายการวัตถุดิบที่ stock ถึง/ต่ำกว่าจุดสั่งซื้อ (low_stock)
// คืน supplier + ลิงก์สั่งซื้อ เพื่อสั่งต่อได้ทันที (ข้าม ASSET ที่ไม่ตัดสต๊อก)
// ============================================================
router.get('/alerts/reorder', async (req, res) => {
  try {
    const { rows } = await query(
      `select m.id, m.name, m.unit, m.stock, m.low_stock, m.item_type, m.order_url, m.sku,
              s.name as supplier_name
         from materials m
         left join suppliers s on s.id = m.supplier_id
         left join item_categories ic on ic.code = m.item_type
        where m.shop_id = $1
          and (coalesce(ic.is_stock_deducted, true) = true or m.item_type = 'SALE')
          and coalesce(m.low_stock, 0) > 0
          and coalesce(m.stock, 0) <= m.low_stock
        order by (coalesce(m.stock,0) - m.low_stock) asc`,
      [req.shopId]);
    res.json({ count: rows.length, reorder: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
