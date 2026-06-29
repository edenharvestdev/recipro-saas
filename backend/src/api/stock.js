// R1: การเปลี่ยนสต๊อกแบบ atomic ฝั่งเซิร์ฟเวอร์ + บันทึก movement ลง DB (audit รายตัว, ใช้ร่วมทุกเครื่อง)
// ทุก endpoint บังคับ shop_id = req.shopId เสมอ (กันข้ามร้าน)
const express = require('express');
const { tx, query } = require('../db');
const { requirePerm } = require('../tenant');   // S4: บังคับสิทธิ์พนักงานในรายการสำคัญ
const router = express.Router();

const TBL = { material: { table: 'materials', col: 'stock' }, recipe: { table: 'recipes', col: 'fg_stock' } };

async function logMove(c, shopId, userId, m) {
  const r = await c.query(
    `insert into stock_movements (shop_id,user_id,kind,ref_type,ref_id,ref_name,unit,qty_before,qty_after,delta,note,consumption_category,actor_name,reversal_of)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) returning id`,
    [shopId, userId || null, m.kind, m.ref_type, m.ref_id, m.ref_name || null, m.unit || null,
     m.before, m.after, (m.after - m.before), m.note || null, m.consumption_category || null, m.actor_name || null, m.reversal_of || null]
  );
  return r.rows[0].id;
}

// ปรับ/รับเข้า/เบิก รายการเดียว — mode: 'set' (กำหนดค่าใหม่) | 'delta' (บวก/ลบ)
router.post('/stock/move', requirePerm('stock_receive'), async (req, res) => {
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
router.post('/stock/waste', requirePerm('waste'), async (req, res) => {
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
router.post('/stock/produce', requirePerm('stock_receive'), async (req, res) => {
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
  const { lines, bill_no } = req.body || {};
  if (!Array.isArray(lines) || !lines.length) return res.status(400).json({ error: 'no lines' });

  // Gate 3: Validate UUID format for all ref_ids before executing transaction
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  for (const ln of lines) {
    if (ln.ref_id && !UUID_RE.test(ln.ref_id)) {
      return res.status(400).json({ error: 'INVALID_UUID_FORMAT' });
    }
  }

  const note = bill_no ? ('ขาย ' + bill_no) : 'ขาย';
  try {
    const out = await tx(async (c) => {
      // อ่าน make_to_order จาก DB เสมอ — ห้ามเชื่อ client body
      const shopRow = (await c.query('select make_to_order from shop_settings where shop_id=$1', [req.shopId])).rows[0];
      const globalMTO = shopRow ? !!shopRow.make_to_order : false;

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
        if (!m) {
          // Gate 3: check if it exists in another branch
          const globalCheck = (await c.query('select 1 from materials where id=$1', [matId])).rowCount > 0;
          const err = new Error(globalCheck ? 'FORBIDDEN_MATERIAL' : 'MATERIAL_NOT_FOUND');
          err.statusCode = globalCheck ? 403 : 404;
          throw err;
        }
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
          const cr = (await c.query('select id, effect_type, target_role, target_material_id, variant_recipe_id, is_metadata_only, amount from option_choices where id = any($1::uuid[])', [ids])).rows;
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
        for (const ch of choices) { // REPLACE: เอาวัตถุดิบเป้าหมายออก (เลือกตรง target_material_id หรือผ่าน role) แล้วใส่ตัวใหม่จาก links
          if (ch.effect_type !== 'REPLACE') continue;
          const oldId = ch.target_material_id || (ch.target_role ? roleIndex.get(ch.target_role) : null);
          if (oldId) { bom.delete(oldId); if (ch.target_role) roleIndex.delete(ch.target_role); }
          for (const l of ch.links) { if (!l.material_id) continue; const e = bom.get(l.material_id) || { amount: 0 }; e.amount += Number(l.amount) || 0; bom.set(l.material_id, e); if (ch.target_role) roleIndex.set(ch.target_role, l.material_id); }
        }
        for (const ch of choices) { // QUANTITY: ตั้งปริมาณวัตถุดิบเป้าหมายเป็นค่าสัมบูรณ์ (0 = ตัดออก) — มิเรอร์ resolveLineBOM
          if (ch.effect_type !== 'QUANTITY') continue;
          const matId = ch.target_material_id || (ch.target_role ? roleIndex.get(ch.target_role) : null);
          if (!matId) continue;
          const newAmt = Number(ch.amount) || 0;
          if (newAmt <= 0) { bom.delete(matId); }
          else { const e = bom.get(matId) || { amount: 0 }; e.amount = newAmt; bom.set(matId, e); }
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
          const rec = (await c.query(
            'select id,name,fg_stock,yield_unit,inventory_mode from recipes where id=$1 and shop_id=$2 for update',
            [ln.ref_id, req.shopId])).rows[0];
          if (!rec) {
            // Gate 3: check if it exists in another branch
            const globalCheck = (await c.query('select 1 from recipes where id=$1', [ln.ref_id])).rowCount > 0;
            const err = new Error(globalCheck ? 'FORBIDDEN_RECIPE' : 'RECIPE_NOT_FOUND');
            err.statusCode = globalCheck ? 403 : 404;
            throw err;
          }

          // S11: per-recipe mode — อ่านจาก DB เสมอ ไม่เชื่อ client
          const invMode = rec.inventory_mode || 'inherit';
          const effectiveMode = invMode === 'inherit'
            ? (globalMTO ? 'make_to_order' : 'finished_goods')
            : invMode;

          if (effectiveMode === 'non_stock') {
            results.push({ type: 'non_stock', ref_id: rec.id });
            continue;
          }
          if (effectiveMode === 'finished_goods') {
            const fg = Number(rec.fg_stock) || 0;
            if (fg < qty) {
              const err = new Error('FG_STOCK_INSUFFICIENT');
              err.statusCode = 409; err.recipeName = rec.name; err.have = fg; err.need = qty;
              throw err;
            }
            await deductRecipeFg(rec, qty, 'on_sale', 'recipe_fg');
            continue;
          }
          // make_to_order: ขยาย BOM ตาม options แล้วตัดสต๊อก
          const { bom, subs } = await buildEffectiveBom(ln.ref_id, ln.chosen_options);
          for (const [matId, entry] of bom) {
            if (entry.amount * qty <= 0) continue;
            await deductMaterial(matId, entry.amount * qty, 'recipe_use');
          }
          for (const s of subs) {
            if (s.amount * qty <= 0) continue;
            const sub = (await c.query('select id,name,fg_stock,yield_unit from recipes where id=$1 and shop_id=$2 for update', [s.sub_recipe_id, req.shopId])).rows[0];
            if (!sub) {
              const globalCheck = (await c.query('select 1 from recipes where id=$1', [s.sub_recipe_id])).rowCount > 0;
              const err = new Error(globalCheck ? 'FORBIDDEN_SUB_RECIPE' : 'SUB_RECIPE_NOT_FOUND');
              err.statusCode = globalCheck ? 403 : 404;
              throw err;
            }
            await deductRecipeFg(sub, s.amount * qty, 'recipe_use', 'sub_recipe');
          }
        }
      }
      return { results };
    });
    res.json(out);
  } catch (e) {
    if (e.statusCode === 409) {
      return res.status(409).json({ error: e.message, recipeName: e.recipeName, have: e.have, need: e.need });
    }
    if (e.statusCode === 403 || e.statusCode === 404) {
      return res.status(e.statusCode).json({ error: e.message });
    }
    res.status(500).json({ error: e.message });
  }
});

// ยกเลิก/คืนบิล — S11: strong idempotency ผ่าน reversal_of FK (ไม่ใช่แค่ text note)
// + อัปเดต bill status ใน transaction เดียวกับ stock reversal
router.post('/pos/void', requirePerm('void'), async (req, res) => {
  const { bill_no } = req.body || {};
  if (!bill_no) return res.status(400).json({ error: 'no bill_no' });
  const saleNote = 'ขาย ' + bill_no;
  const voidNote = 'ยกเลิก ' + bill_no;
  try {
    const out = await tx(async (c) => {
      // หา sale movements ของบิลนี้
      const moves = (await c.query(
        "select id, ref_type, ref_id, ref_name, unit, delta from stock_movements where shop_id=$1 and note=$2 and kind='sale'",
        [req.shopId, saleNote])).rows;
      if (!moves.length) return { already: false, notFound: true, results: [] };

      // S11: ตรวจ idempotency ด้วย reversal_of FK — แต่ละ sale movement ถูก reverse ได้ครั้งเดียว
      const saleIds = moves.map(m => m.id);
      const alreadyVoided = await c.query(
        'select 1 from stock_movements where shop_id=$1 and reversal_of = any($2::uuid[]) limit 1',
        [req.shopId, saleIds]);
      if (alreadyVoided.rowCount) return { already: true, results: [] };

      const results = [];
      for (const mv of moves) {
        const restore = -Number(mv.delta);
        if (!(restore > 0)) continue;
        const meta = TBL[mv.ref_type]; if (!meta) continue;
        const cur = (await c.query(
          `select ${meta.col} as q, name from ${meta.table} where id=$1 and shop_id=$2 for update`, [mv.ref_id, req.shopId])).rows[0];
        if (!cur) continue;
        const before = Number(cur.q) || 0;
        const after = before + restore;
        await c.query(`update ${meta.table} set ${meta.col}=$1, updated_at=now() where id=$2`, [after, mv.ref_id]);
        // S11: referencing original sale movement ID — unique index ป้องกัน double-void ระดับ DB
        await logMove(c, req.shopId, req.userId, {
          kind: 'void', ref_type: mv.ref_type, ref_id: mv.ref_id, ref_name: mv.ref_name || cur.name,
          unit: mv.unit, before, after, note: voidNote, consumption_category: 'void',
          reversal_of: mv.id });
        results.push({ type: mv.ref_type, ref_id: mv.ref_id, before, after });
      }

      // S11: อัปเดต bill status ใน transaction เดียวกัน (atomic กับ stock reversal)
      await c.query(
        "update bills set status='voided' where number=$1 and shop_id=$2",
        [bill_no, req.shopId]);

      return { results, restored: results.length };
    });
    if (out.already) return res.json({ ok: true, already: true, results: [] });
    if (out.notFound) return res.json({ ok: true, notFound: true, results: [] });
    res.json({ ok: true, ...out });
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
