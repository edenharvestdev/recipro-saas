// R1: การเปลี่ยนสต๊อกแบบ atomic ฝั่งเซิร์ฟเวอร์ + บันทึก movement ลง DB (audit รายตัว, ใช้ร่วมทุกเครื่อง)
// ทุก endpoint บังคับ shop_id = req.shopId เสมอ (กันข้ามร้าน)
const express = require('express');
const { tx, query } = require('../db');
const { requirePerm } = require('../tenant');   // S4: บังคับสิทธิ์พนักงานในรายการสำคัญ
const engine = require('../stockEngine');
const router = express.Router();

const TBL = engine.TBL;

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
      const shopRow = (await c.query('select make_to_order from shop_settings where shop_id=$1', [req.shopId])).rows[0];
      const globalMTO = shopRow ? !!shopRow.make_to_order : false;
      const cats = await engine.loadCats(c);
      const results = [];

      for (const ln of (lines || [])) {
        const qty = Number(ln.qty) || 0;
        if (qty <= 0) continue;

        await engine.validateOptionsForLine(c, ln.ref_type, ln.ref_id, ln.chosen_options);

        if (ln.ref_type === 'material') {
          const r = await engine.deductMaterial(c, req.shopId, req.userId, cats, ln.ref_id, qty, 'on_sale', note);
          results.push(r);
          // Deduct ADD-type option linked materials for direct material sales
          const opts = Array.isArray(ln.chosen_options) ? ln.chosen_options.filter(o => o && o.choice_id) : [];
          if (opts.length) {
            const ids = opts.map(o => o.choice_id);
            const choices = (await c.query(
              `select id, effect_type from option_choices where id=any($1::uuid[])`, [ids]
            )).rows;
            for (const ch of choices) {
              if (ch.effect_type !== 'ADD') continue;
              const choiceQty = Number(opts.find(o => o.choice_id === ch.id)?.qty || 1);
              const links = (await c.query(
                `select material_id, amount from option_choice_links where choice_id=$1`, [ch.id]
              )).rows;
              for (const l of links) {
                if (l.material_id && Number(l.amount) > 0) {
                  const lr = await engine.deductMaterial(c, req.shopId, req.userId, cats, l.material_id, Number(l.amount) * choiceQty * qty, 'recipe_use', note);
                  results.push(lr);
                }
              }
            }
          }
        } else if (ln.ref_type === 'recipe') {
          const rec = (await c.query(
            'select id,name,fg_stock,yield_unit,inventory_mode from recipes where id=$1 and shop_id=$2 for update',
            [ln.ref_id, req.shopId])).rows[0];
          if (!rec) {
            const globalCheck = (await c.query('select 1 from recipes where id=$1', [ln.ref_id])).rowCount > 0;
            const err = new Error(globalCheck ? 'FORBIDDEN_RECIPE' : 'RECIPE_NOT_FOUND');
            err.statusCode = globalCheck ? 403 : 404; throw err;
          }

          const invMode = rec.inventory_mode || 'inherit';
          const effectiveMode = invMode === 'inherit' ? (globalMTO ? 'make_to_order' : 'finished_goods') : invMode;

          if (effectiveMode === 'non_stock') {
            results.push({ type: 'non_stock', ref_id: rec.id }); continue;
          }
          if (effectiveMode === 'finished_goods') {
            const fg = Number(rec.fg_stock) || 0;
            if (fg < qty) {
              const err = new Error('FG_STOCK_INSUFFICIENT');
              err.statusCode = 409; err.recipeName = rec.name; err.have = fg; err.need = qty; throw err;
            }
            const r = await engine.deductRecipeFg(c, req.shopId, req.userId, rec, qty, 'on_sale', 'recipe_fg', note);
            results.push(r); continue;
          }
          // make_to_order: expand BOM then deduct
          const { bom, subs } = await engine.buildEffectiveBom(c, ln.ref_id, ln.chosen_options);
          for (const [matId, entry] of bom) {
            if (entry.amount * qty <= 0) continue;
            const r = await engine.deductMaterial(c, req.shopId, req.userId, cats, matId, entry.amount * qty, 'recipe_use', note);
            results.push(r);
          }
          for (const s of subs) {
            if (s.amount * qty <= 0) continue;
            const sub = (await c.query('select id,name,fg_stock,yield_unit from recipes where id=$1 and shop_id=$2 for update', [s.sub_recipe_id, req.shopId])).rows[0];
            if (!sub) {
              const globalCheck = (await c.query('select 1 from recipes where id=$1', [s.sub_recipe_id])).rowCount > 0;
              const err = new Error(globalCheck ? 'FORBIDDEN_SUB_RECIPE' : 'SUB_RECIPE_NOT_FOUND');
              err.statusCode = globalCheck ? 403 : 404; throw err;
            }
            const r = await engine.deductRecipeFg(c, req.shopId, req.userId, sub, s.amount * qty, 'recipe_use', 'sub_recipe', note);
            results.push(r);
          }
        }
      }
      return { results };
    });
    res.json(out);
  } catch (e) {
    if (e.statusCode === 409) return res.status(409).json({ error: e.message, recipeName: e.recipeName, have: e.have, need: e.need });
    if (e.statusCode) return res.status(e.statusCode).json({ error: e.message });
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

// ============================================================
// Phase 3: Daily Stock Movement Report and Summary Statistics
// ============================================================
router.get('/stock/report', async (req, res) => {
  try {
    const shopId = req.shopId;
    const {
      start_date,
      end_date,
      bill_no,
      sku,
      material_id,
      recipe_id,
      kind,
      user_id,
      ref_type,
      page = 1,
      limit = 50
    } = req.query;

    const pgNum = Math.max(1, parseInt(page));
    const limNum = Math.max(1, parseInt(limit));
    const offset = (pgNum - 1) * limNum;

    // Date filters (defaults to today)
    const start = start_date ? new Date(start_date) : new Date(new Date().setHours(0,0,0,0));
    const end = end_date ? new Date(end_date) : new Date(new Date().setHours(23,59,59,999));

    // 1. Build Query
    let where = 'where sm.shop_id = $1 and sm.created_at >= $2 and sm.created_at <= $3';
    const params = [shopId, start, end];
    let paramIdx = 4;

    if (bill_no) {
      where += ` and (sm.note ILIKE $${paramIdx} or sm.note ILIKE $${paramIdx + 1})`;
      params.push(`ขาย ${bill_no}`, `ยกเลิก ${bill_no}`);
      paramIdx += 2;
    }
    if (sku) {
      where += ` and (m.sku ILIKE $${paramIdx} or r.code ILIKE $${paramIdx})`;
      params.push(`%${sku}%`);
      paramIdx++;
    }
    if (material_id) {
      where += ` and sm.ref_type = 'material' and sm.ref_id = $${paramIdx}`;
      params.push(material_id);
      paramIdx++;
    }
    if (recipe_id) {
      where += ` and sm.ref_type = 'recipe' and sm.ref_id = $${paramIdx}`;
      params.push(recipe_id);
      paramIdx++;
    }
    if (kind) {
      where += ` and sm.kind = $${paramIdx}`;
      params.push(kind);
      paramIdx++;
    }
    if (user_id) {
      where += ` and sm.user_id = $${paramIdx}`;
      params.push(user_id);
      paramIdx++;
    }
    if (ref_type) {
      where += ` and sm.ref_type = $${paramIdx}`;
      params.push(ref_type);
      paramIdx++;
    }

    // 2. Fetch Movements Rows
    const queryStr = `
      select sm.*,
             m.sku as material_sku,
             r.code as recipe_code,
             u.email as actor_email,
             sh.name as shop_name
        from stock_movements sm
        left join materials m on m.id = sm.ref_id and sm.ref_type = 'material'
        left join recipes r on r.id = sm.ref_id and sm.ref_type = 'recipe'
        left join users u on u.id = sm.user_id
        left join shops sh on sh.id = sm.shop_id
       ${where}
       order by sm.created_at desc
       limit $${paramIdx} offset $${paramIdx + 1}
    `;
    
    const countQueryStr = `
      select count(*)
        from stock_movements sm
        left join materials m on m.id = sm.ref_id and sm.ref_type = 'material'
        left join recipes r on r.id = sm.ref_id and sm.ref_type = 'recipe'
       ${where}
    `;

    const [rowsRes, countRes] = await Promise.all([
      query(queryStr, [...params, limNum, offset]),
      query(countQueryStr, params)
    ]);

    const totalRows = parseInt(countRes.rows[0].count);

    // 3. Fetch Summary Metrics
    const billsSummary = (await query(`
      select count(*) as total,
             count(*) filter (where status != 'voided') as active,
             count(*) filter (where status = 'voided') as voided
        from bills
       where shop_id = $1 and created_at >= $2 and created_at <= $3
    `, [shopId, start, end])).rows[0] || { total: 0, active: 0, voided: 0 };

    const grossRes = await query(`
      select coalesce(sum(delta), 0) as val
        from stock_movements
       where shop_id = $1 and kind = 'sale' and delta < 0 and created_at >= $2 and created_at <= $3
    `, [shopId, start, end]);

    const revsRes = await query(`
      select coalesce(sum(delta), 0) as val
        from stock_movements
       where shop_id = $1 and kind = 'void' and delta > 0 and created_at >= $2 and created_at <= $3
    `, [shopId, start, end]);

    const adjustRes = await query(`
      select coalesce(sum(delta), 0) as val
        from stock_movements
       where shop_id = $1 and kind = 'adjust' and created_at >= $2 and created_at <= $3
    `, [shopId, start, end]);

    const lowMatRes = await query(`select count(*) from materials where shop_id = $1 and stock < 0`, [shopId]);
    const lowRecRes = await query(`select count(*) from recipes where shop_id = $1 and fg_stock < 0`, [shopId]);

    const noMoveBills = await query(`
      select count(*) as count
        from bills b
       where b.shop_id = $1
         and b.created_at >= $2
         and b.created_at <= $3
         and not exists (
           select 1 from stock_movements sm
            where sm.shop_id = $1
              and (sm.note = 'ขาย ' || b.number or sm.note = 'ยกเลิก ' || b.number)
         )
    `, [shopId, start, end]);

    const noRefMoves = await query(`
      select count(*) as count
        from stock_movements
       where shop_id = $1
         and created_at >= $2
         and created_at <= $3
         and note not ilike 'ขาย %'
         and note not ilike 'ยกเลิก %'
         and note not ilike '%CONVERSION%'
         and note not ilike '%CORRECTION%'
    `, [shopId, start, end]);

    const summary = {
      total_bills: parseInt(billsSummary.total) || 0,
      active_bills: parseInt(billsSummary.active) || 0,
      voided_bills: parseInt(billsSummary.voided) || 0,
      gross_deductions: Math.abs(Number(grossRes.rows[0].val)),
      total_reversals: Number(revsRes.rows[0].val),
      net_deductions: Math.abs(Number(grossRes.rows[0].val)) - Number(revsRes.rows[0].val),
      manual_adjustments: Number(adjustRes.rows[0].val),
      negative_stock_items: parseInt(lowMatRes.rows[0].count) + parseInt(lowRecRes.rows[0].count),
      bills_without_movements: parseInt(noMoveBills.rows[0].count),
      movements_without_reference: parseInt(noRefMoves.rows[0].count),
      duplicate_reversals: 0, // Enforced at DB level, always 0
      cross_branch_anomalies: 0 // Enforced at query scope level, always 0
    };

    res.json({
      metadata: {
        total_rows: totalRows,
        page: pgNum,
        limit: limNum,
        total_pages: Math.ceil(totalRows / limNum)
      },
      summary,
      movements: rowsRes.rows
    });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
