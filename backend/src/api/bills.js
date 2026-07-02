// Front-store bill lifecycle — DRAFT / CONFIRMED / VOIDED / REPLACED (+ CORRECTION_PENDING).
// Server-side and ATOMIC: bill row + stock deduction/reversal happen in one transaction, linked
// through the strong bill_stock_movements table (NOT free-text notes). Additive — the existing
// POS /pos/sell + sync happy-path is untouched. Correction = Void original + Replacement (never
// in-place edit). Stock deduction reuses the shared stockEngine, identical to POS.
const express = require('express');
const { tx, query } = require('../db');
const { requirePerm } = require('../tenant');
const engine = require('../stockEngine');
const router = express.Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUUID = (s) => typeof s === 'string' && UUID_RE.test(s);

// ── money model — item Gross, item + bill discount, Net; actual received stays separate ──
function computeMoney(items, billDiscount) {
  let gross = 0, itemDisc = 0;
  for (const it of (items || [])) {
    gross += (Number(it.qty) || 0) * (Number(it.unit_price) || 0);
    itemDisc += Number(it.discount) || 0;
  }
  const billDisc = Number(billDiscount) || 0;
  const totalDisc = itemDisc + billDisc;
  return { gross, itemDisc, billDisc, totalDisc, net: gross - totalDisc };
}

async function auditLog(c, shopId, userId, userName, billId, action, reason, snapshot) {
  await c.query(
    `INSERT INTO bill_audit_log (shop_id, bill_id, action, actor_id, actor_name, reason, snapshot)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [shopId, billId, action, userId || null, userName || null, reason || null, snapshot ? JSON.stringify(snapshot) : null]
  );
}

// Sequential per-shop bill number (posting-date prefixed). Non-unique-constrained in base schema;
// count-based sequence is monotonic so a replacement always differs from the original.
async function nextBillNumber(c, shopId) {
  const n = (await c.query('SELECT count(*)::int c FROM bills WHERE shop_id=$1 AND number IS NOT NULL', [shopId])).rows[0].c;
  const d = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return 'B' + d + '-' + String(n + 1).padStart(4, '0');
}

// Deduct stock for a bill's lines (same rules as /pos/sell) and return the movement links + COGS.
// Each returned link → one bill_stock_movements row. Throws (rolls back) on insufficient FG stock.
async function deductBillLines(c, shopId, userId, lines, note, globalMTO, cats) {
  const links = []; let cogsTotal = 0;
  for (const ln of (lines || [])) {
    const qty = Number(ln.qty) || 0; if (qty <= 0) continue;
    const key = ln.key || ln.ref_id;
    await engine.validateOptionsForLine(c, ln.ref_type, ln.ref_id, ln.chosen_options || []);
    if (ln.ref_type === 'material') {
      const mat = (await c.query('SELECT price, qty, conv_qty FROM materials WHERE id=$1 AND shop_id=$2', [ln.ref_id, shopId])).rows[0];
      const unitCogs = mat && Number(mat.qty) > 0 ? Number(mat.price) / ((Number(mat.qty) || 1) * (Number(mat.conv_qty) || 1)) : 0;
      const r = await engine.deductMaterial(c, shopId, userId, cats, ln.ref_id, qty, 'on_sale', note);
      if (r.mvId) links.push({ stock_movement_id: r.mvId, bill_item_key: key, quantity: qty, unit_cogs: unitCogs });
      cogsTotal += unitCogs * qty;
    } else if (ln.ref_type === 'recipe') {
      const rec = (await c.query('SELECT id,name,fg_stock,yield_unit,inventory_mode FROM recipes WHERE id=$1 AND shop_id=$2 FOR UPDATE', [ln.ref_id, shopId])).rows[0];
      if (!rec) { const e = new Error('RECIPE_NOT_FOUND'); e.statusCode = 404; throw e; }
      const invMode = rec.inventory_mode || 'inherit';
      const eff = invMode === 'inherit' ? (globalMTO ? 'make_to_order' : 'finished_goods') : invMode;
      if (eff === 'non_stock') continue;
      if (eff === 'finished_goods') {
        const unitCogs = await engine.computeRecipeCostPerUnit(c, shopId, ln.ref_id);
        const fg = Number(rec.fg_stock) || 0;
        if (fg < qty) { const e = new Error('FG_STOCK_INSUFFICIENT'); e.statusCode = 409; e.recipeName = rec.name; e.have = fg; e.need = qty; throw e; }
        const r = await engine.deductRecipeFg(c, shopId, userId, rec, qty, 'on_sale', 'recipe_fg', note);
        if (r.mvId) links.push({ stock_movement_id: r.mvId, bill_item_key: key, quantity: qty, unit_cogs: unitCogs });
        cogsTotal += unitCogs * qty;
      } else {
        const { bom, subs } = await engine.buildEffectiveBom(c, ln.ref_id, ln.chosen_options || []);
        const matIds = [...bom.keys()];
        const prices = matIds.length ? (await c.query('SELECT id,price,qty,conv_qty FROM materials WHERE id=ANY($1::uuid[]) AND shop_id=$2', [matIds, shopId])).rows : [];
        const priceMap = Object.fromEntries(prices.map(p => [p.id, Number(p.qty) > 0 ? Number(p.price) / ((Number(p.qty) || 1) * (Number(p.conv_qty) || 1)) : 0]));
        for (const [matId, entry] of bom) {
          const amt = entry.amount * qty; if (amt <= 0) continue;
          const r = await engine.deductMaterial(c, shopId, userId, cats, matId, amt, 'recipe_use', note);
          if (r.mvId) links.push({ stock_movement_id: r.mvId, bill_item_key: key, quantity: amt, unit_cogs: priceMap[matId] || 0 });
          cogsTotal += (priceMap[matId] || 0) * amt;
        }
        for (const s of subs) {
          const amt = s.amount * qty; if (amt <= 0) continue;
          const sub = (await c.query('SELECT id,name,fg_stock,yield_unit FROM recipes WHERE id=$1 AND shop_id=$2 FOR UPDATE', [s.sub_recipe_id, shopId])).rows[0];
          if (!sub) continue;
          const subCost = await engine.computeRecipeCostPerUnit(c, shopId, s.sub_recipe_id);
          const r = await engine.deductRecipeFg(c, shopId, userId, sub, amt, 'recipe_use', 'sub_recipe', note);
          if (r.mvId) links.push({ stock_movement_id: r.mvId, bill_item_key: key, quantity: amt, unit_cogs: subCost });
          cogsTotal += subCost * amt;
        }
      }
    }
  }
  return { links, cogsTotal };
}

// Insert the strong linkage rows for a set of deduction movements.
async function insertLinks(c, shopId, billId, links, role) {
  for (const l of links) {
    await c.query(
      `INSERT INTO bill_stock_movements (shop_id, bill_id, bill_item_key, stock_movement_id, movement_role, quantity, unit_cogs_snapshot)
       VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (bill_id, stock_movement_id) DO NOTHING`,
      [shopId, billId, l.bill_item_key || null, l.stock_movement_id, role, l.quantity, l.unit_cogs]
    );
  }
}

// Reverse a bill's active deductions EXACTLY ONCE. Uses the stockEngine reversal (which restores
// stock + stamps reversal_of on stock_movements for idempotency) and records REVERSAL linkage rows
// pointing back to the deduction they reverse. The partial unique index bsm_reversal_once_idx is a
// second guard so a link can never be reversed twice.
async function reverseBillLinks(c, shopId, userId, billId, note) {
  const links = (await c.query(
    `SELECT bsm.id, bsm.stock_movement_id FROM bill_stock_movements bsm
      WHERE bsm.bill_id=$1 AND bsm.movement_role IN ('ORIGINAL_DEDUCTION','REPLACEMENT_DEDUCTION')
        AND NOT EXISTS (SELECT 1 FROM bill_stock_movements r WHERE r.reversal_of_link_id = bsm.id)`,
    [billId]
  )).rows;
  if (!links.length) return { reversed: 0, alreadyReversed: true };
  const smIds = links.map(l => l.stock_movement_id);
  const rev = await engine.reverseMovements(c, shopId, userId, smIds, note);
  if (rev.alreadyVoided) return { reversed: 0, alreadyReversed: true };
  const revRows = (await c.query(
    'SELECT id, reversal_of FROM stock_movements WHERE shop_id=$1 AND reversal_of=ANY($2::uuid[])', [shopId, smIds]
  )).rows;
  const linkBySm = Object.fromEntries(links.map(l => [l.stock_movement_id, l.id]));
  for (const rr of revRows) {
    await c.query(
      `INSERT INTO bill_stock_movements (shop_id, bill_id, stock_movement_id, movement_role, reversal_of_link_id)
       VALUES ($1,$2,$3,'REVERSAL',$4) ON CONFLICT (bill_id, stock_movement_id) DO NOTHING`,
      [shopId, billId, rr.id, linkBySm[rr.reversal_of]]
    );
  }
  return { reversed: revRows.length, alreadyReversed: false };
}

// ── DRAFT: create or update. No stock, no final number. ──────────────────────
router.post('/bills/draft', async (req, res) => {
  const b = req.body || {};
  const items = Array.isArray(b.items) ? b.items : [];
  const m = computeMoney(items, b.bill_discount);
  try {
    const out = await tx(async (c) => {
      let billId = b.id;
      if (billId && isUUID(billId)) {
        const cur = (await c.query('SELECT lifecycle_status FROM bills WHERE id=$1 AND shop_id=$2 FOR UPDATE', [billId, req.shopId])).rows[0];
        if (!cur) { const e = new Error('not found'); e.statusCode = 404; throw e; }
        if (cur.lifecycle_status && cur.lifecycle_status !== 'DRAFT') { const e = new Error('BILL_NOT_DRAFT'); e.statusCode = 409; throw e; }
        await c.query(
          `UPDATE bills SET items_json=$1, bill_discount=$2, gross_sales=$3, net_sales=$4, discount=$5,
                 payment_method=$6, actual_received_amount=$7, payment_adjustment=$8,
                 business_date=COALESCE($9,business_date), updated_by=$10, draft_saved_at=now()
           WHERE id=$11`,
          [JSON.stringify(items), m.billDisc, m.gross, m.net, m.totalDisc, b.payment_method || null,
           b.actual_received_amount ?? null, Number(b.payment_adjustment) || 0, b.business_date || null, req.userId, billId]
        );
      } else {
        billId = (await c.query(
          `INSERT INTO bills (shop_id, doc_type, items_json, lifecycle_status, status, bill_discount,
                 gross_sales, net_sales, discount, payment_method, actual_received_amount, payment_adjustment,
                 business_date, created_by, updated_by, draft_saved_at)
           VALUES ($1,'sale',$2,'DRAFT','wait',$3,$4,$5,$6,$7,$8,$9,COALESCE($10,CURRENT_DATE),$11,$11,now()) RETURNING id`,
          [req.shopId, JSON.stringify(items), m.billDisc, m.gross, m.net, m.totalDisc, b.payment_method || null,
           b.actual_received_amount ?? null, Number(b.payment_adjustment) || 0, b.business_date || null, req.userId]
        )).rows[0].id;
        await auditLog(c, req.shopId, req.userId, req.userName, billId, 'created', null, { money: m });
      }
      return { bill: (await c.query('SELECT * FROM bills WHERE id=$1', [billId])).rows[0] };
    });
    res.status(201).json(out);
  } catch (e) {
    if (e.statusCode) return res.status(e.statusCode).json({ error: e.message });
    res.status(500).json({ error: e.message });
  }
});

// ── GET drafts / one bill ────────────────────────────────────────────────────
router.get('/bills/drafts', async (req, res) => {
  try {
    const rows = (await query(
      `SELECT id, number, lifecycle_status, gross_sales, net_sales, business_date, draft_saved_at,
              created_by, updated_by, items_json
         FROM bills WHERE shop_id=$1 AND lifecycle_status='DRAFT' ORDER BY draft_saved_at DESC LIMIT 200`,
      [req.shopId]
    )).rows;
    res.json({ drafts: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Recent lifecycle bills (drafts + confirmed + replaced + voided) for the bill manager UI.
router.get('/bills/recent', async (req, res) => {
  try {
    const rows = (await query(
      `SELECT id, number, lifecycle_status, gross_sales, net_sales, cogs_total, actual_received_amount,
              bill_discount, payment_method, business_date, confirmed_at, draft_saved_at, corrected_at, voided_at,
              original_bill_id, replacement_bill_id, correction_reason, items_json
         FROM bills WHERE shop_id=$1 AND lifecycle_status IS NOT NULL
         ORDER BY COALESCE(confirmed_at, draft_saved_at, created_at) DESC LIMIT 100`,
      [req.shopId]
    )).rows;
    res.json({ bills: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/bills/:id', async (req, res) => {
  if (!isUUID(req.params.id)) return res.status(400).json({ error: 'invalid id' });
  try {
    const bill = (await query('SELECT * FROM bills WHERE id=$1 AND shop_id=$2', [req.params.id, req.shopId])).rows[0];
    if (!bill) return res.status(404).json({ error: 'not found' });
    const links = (await query('SELECT * FROM bill_stock_movements WHERE bill_id=$1 ORDER BY created_at', [req.params.id])).rows;
    const audit = (await query('SELECT action, actor_name, reason, created_at FROM bill_audit_log WHERE bill_id=$1 ORDER BY created_at', [req.params.id])).rows;
    res.json({ bill, stock_links: links, audit });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── CONFIRM: assign number, deduct stock ONCE, snapshot COGS, strong linkage. Idempotent. ──
router.post('/bills/:id/confirm', async (req, res) => {
  if (!isUUID(req.params.id)) return res.status(400).json({ error: 'invalid id' });
  try {
    const out = await tx(async (c) => {
      const bill = (await c.query('SELECT * FROM bills WHERE id=$1 AND shop_id=$2 FOR UPDATE', [req.params.id, req.shopId])).rows[0];
      if (!bill) { const e = new Error('not found'); e.statusCode = 404; throw e; }
      if (bill.lifecycle_status === 'CONFIRMED') return { bill, already: true };            // idempotent, no double-deduct
      if (bill.lifecycle_status && bill.lifecycle_status !== 'DRAFT') { const e = new Error('BILL_NOT_DRAFT'); e.statusCode = 409; throw e; }

      const items = Array.isArray(bill.items_json) ? bill.items_json : [];
      const lines = items.map(it => ({ ref_type: it.menu_type === 'material' ? 'material' : 'recipe', ref_id: it.ref_id, qty: it.qty, chosen_options: it.chosen_options || [], key: it.key || it.ref_id }));
      const shopRow = (await c.query('SELECT make_to_order FROM shop_settings WHERE shop_id=$1', [req.shopId])).rows[0];
      const globalMTO = shopRow ? !!shopRow.make_to_order : false;
      const cats = await engine.loadCats(c);
      const number = await nextBillNumber(c, req.shopId);
      const note = 'ขาย ' + number;
      const { links, cogsTotal } = await deductBillLines(c, req.shopId, req.userId, lines, note, globalMTO, cats);
      await insertLinks(c, req.shopId, req.params.id, links, 'ORIGINAL_DEDUCTION');

      const m = computeMoney(items, bill.bill_discount);
      await c.query(
        `UPDATE bills SET lifecycle_status='CONFIRMED', status='paid', number=$1, stock_deducted=true,
               gross_sales=$2, net_sales=$3, cogs_total=$4, confirmed_at=now(), updated_by=$5 WHERE id=$6`,
        [number, m.gross, m.net, cogsTotal, req.userId, req.params.id]
      );
      await auditLog(c, req.shopId, req.userId, req.userName, req.params.id, 'confirmed', null, { number, cogs_total: cogsTotal, money: m });
      return { bill: (await c.query('SELECT * FROM bills WHERE id=$1', [req.params.id])).rows[0], number, cogs_total: cogsTotal, movement_count: links.length };
    });
    res.status(out.already ? 200 : 201).json(out);
  } catch (e) {
    if (e.statusCode === 409) return res.status(409).json({ error: e.message, recipeName: e.recipeName, have: e.have, need: e.need });
    if (e.statusCode) return res.status(e.statusCode).json({ error: e.message });
    res.status(500).json({ error: e.message });
  }
});

// ── VOID: reverse linked stock ONCE, keep the bill (marked VOIDED). Owner permission. ──
router.post('/bills/:id/void', requirePerm('void_bill'), async (req, res) => {
  if (!isUUID(req.params.id)) return res.status(400).json({ error: 'invalid id' });
  const reason = String((req.body && req.body.reason) || '').trim();
  try {
    const out = await tx(async (c) => {
      const bill = (await c.query('SELECT * FROM bills WHERE id=$1 AND shop_id=$2 FOR UPDATE', [req.params.id, req.shopId])).rows[0];
      if (!bill) { const e = new Error('not found'); e.statusCode = 404; throw e; }
      if (bill.lifecycle_status === 'VOIDED' || bill.lifecycle_status === 'REPLACED') return { bill, already: true };
      if (bill.lifecycle_status !== 'CONFIRMED') { const e = new Error('BILL_NOT_CONFIRMED'); e.statusCode = 409; throw e; }
      const rev = await reverseBillLinks(c, req.shopId, req.userId, req.params.id, 'ยกเลิก ' + (bill.number || req.params.id));
      await c.query('UPDATE bills SET lifecycle_status=\'VOIDED\', status=\'voided\', voided_by=$1, voided_at=now() WHERE id=$2', [req.userId, req.params.id]);
      await auditLog(c, req.shopId, req.userId, req.userName, req.params.id, 'voided', reason || null, { reversed: rev.reversed });
      return { bill: (await c.query('SELECT * FROM bills WHERE id=$1', [req.params.id])).rows[0], reversed: rev.reversed };
    });
    res.json(out);
  } catch (e) {
    if (e.statusCode) return res.status(e.statusCode).json({ error: e.message });
    res.status(500).json({ error: e.message });
  }
});

// ── CORRECT: atomic Void-original + Replacement. Owner permission. ────────────
// Body: { reason, items:[...], bill_discount, payment_method, actual_received_amount, payment_adjustment }
router.post('/bills/:id/correct', requirePerm('correct_bill'), async (req, res) => {
  if (!isUUID(req.params.id)) return res.status(400).json({ error: 'invalid id' });
  const b = req.body || {};
  const reason = String(b.reason || '').trim();
  if (!reason) return res.status(400).json({ error: 'CORRECTION_REASON_REQUIRED' });
  const newItems = Array.isArray(b.items) ? b.items : [];
  if (!newItems.length) return res.status(400).json({ error: 'no replacement items' });
  try {
    const out = await tx(async (c) => {
      const orig = (await c.query('SELECT * FROM bills WHERE id=$1 AND shop_id=$2 FOR UPDATE', [req.params.id, req.shopId])).rows[0];
      if (!orig) { const e = new Error('not found'); e.statusCode = 404; throw e; }
      if (orig.lifecycle_status !== 'CONFIRMED') { const e = new Error('ORIGINAL_NOT_CORRECTABLE'); e.statusCode = 409; throw e; }
      if (orig.replacement_bill_id) { const e = new Error('ALREADY_REPLACED'); e.statusCode = 409; throw e; }

      // 1) reverse the original's stock exactly once
      const rev = await reverseBillLinks(c, req.shopId, req.userId, req.params.id, 'แก้ไข-คืน ' + (orig.number || req.params.id));

      // 2) build the replacement bill + deduct its stock once
      const shopRow = (await c.query('SELECT make_to_order FROM shop_settings WHERE shop_id=$1', [req.shopId])).rows[0];
      const globalMTO = shopRow ? !!shopRow.make_to_order : false;
      const cats = await engine.loadCats(c);
      const number = await nextBillNumber(c, req.shopId);
      const m = computeMoney(newItems, b.bill_discount);
      const repId = (await c.query(
        `INSERT INTO bills (shop_id, doc_type, items_json, lifecycle_status, status, number,
               original_bill_id, bill_discount, gross_sales, net_sales, discount, payment_method,
               actual_received_amount, payment_adjustment, business_date, created_by, updated_by,
               confirmed_at, stock_deducted)
         VALUES ($1,'sale',$2,'CONFIRMED','paid',$3,$4,$5,$6,$7,$8,$9,$10,$11,
                 COALESCE($12::date,$13::date),$14,$14,now(),true) RETURNING id`,
        [req.shopId, JSON.stringify(newItems), number, req.params.id, m.billDisc, m.gross, m.net, m.totalDisc,
         b.payment_method || orig.payment_method || null, b.actual_received_amount ?? null,
         Number(b.payment_adjustment) || 0, b.business_date || null, orig.business_date, req.userId]
      )).rows[0].id;

      const lines = newItems.map(it => ({ ref_type: it.menu_type === 'material' ? 'material' : 'recipe', ref_id: it.ref_id, qty: it.qty, chosen_options: it.chosen_options || [], key: it.key || it.ref_id }));
      const note = 'ขาย ' + number;
      const { links, cogsTotal } = await deductBillLines(c, req.shopId, req.userId, lines, note, globalMTO, cats);
      await insertLinks(c, req.shopId, repId, links, 'REPLACEMENT_DEDUCTION');
      await c.query('UPDATE bills SET cogs_total=$1 WHERE id=$2', [cogsTotal, repId]);

      // 3) mark original REPLACED + cross-link + audit
      await c.query(
        `UPDATE bills SET lifecycle_status='REPLACED', status='voided', replacement_bill_id=$1,
               correction_reason=$2, corrected_by=$3, corrected_at=now(), voided_by=$3, voided_at=now() WHERE id=$4`,
        [repId, reason, req.userId, req.params.id]
      );
      await auditLog(c, req.shopId, req.userId, req.userName, req.params.id, 'corrected', reason, { replacement_bill_id: repId, reversed: rev.reversed });
      await auditLog(c, req.shopId, req.userId, req.userName, repId, 'confirmed', 'replacement of ' + (orig.number || req.params.id), { original_bill_id: req.params.id, number, cogs_total: cogsTotal });

      return {
        original: (await c.query('SELECT * FROM bills WHERE id=$1', [req.params.id])).rows[0],
        replacement: (await c.query('SELECT * FROM bills WHERE id=$1', [repId])).rows[0],
        replacement_number: number, reversed: rev.reversed, replacement_movements: links.length
      };
    });
    res.status(201).json(out);
  } catch (e) {
    if (e.statusCode === 409) return res.status(409).json({ error: e.message, recipeName: e.recipeName, have: e.have, need: e.need });
    if (e.statusCode) return res.status(e.statusCode).json({ error: e.message });
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
