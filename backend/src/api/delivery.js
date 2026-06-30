// Delivery Operations MVP — Release A
// All write operations require requireAuth + tenant (mounted in app.js).
// Stock deduction uses shared stockEngine — same logic as POS, no duplication.

const express = require('express');
const { tx, query } = require('../db');
const { requirePerm } = require('../tenant');
const engine = require('../stockEngine');
const router = express.Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUUID(s) { return typeof s === 'string' && UUID_RE.test(s); }

// ─────────────────────────────────────────────────────────────────────────
// Batch CRUD
// ─────────────────────────────────────────────────────────────────────────

// POST /api/delivery/batch — create draft batch with items
router.post('/batch', requirePerm('delivery_entry'), async (req, res) => {
  const { platform, sales_date_from, sales_date_to, mode, gross_sales, order_count, items,
          client_request_id, replacement_of_batch_id } = req.body || {};

  if (!platform) return res.status(400).json({ error: 'platform required' });
  if (!sales_date_from) return res.status(400).json({ error: 'sales_date_from required' });
  if (!['stock_aware', 'financial_only'].includes(mode)) return res.status(400).json({ error: 'invalid mode' });

  const safeItems = Array.isArray(items) ? items : [];
  for (const it of safeItems) {
    if (!['recipe', 'material'].includes(it.menu_type)) return res.status(400).json({ error: 'invalid menu_type' });
    if (it.menu_type === 'recipe' && !isUUID(it.recipe_id)) return res.status(400).json({ error: 'recipe_id must be UUID' });
    if (it.menu_type === 'material' && !isUUID(it.material_id)) return res.status(400).json({ error: 'material_id must be UUID' });
    if (!(Number(it.quantity) > 0)) return res.status(400).json({ error: 'quantity must be positive' });
  }

  try {
    const out = await tx(async (c) => {
      // Idempotency: if client_request_id given and already exists, return existing batch_id
      if (client_request_id) {
        const existing = await c.query(
          'SELECT id FROM delivery_sales_batches WHERE shop_id=$1 AND client_request_id=$2',
          [req.shopId, client_request_id]
        );
        if (existing.rowCount) {
          const e = new Error('DUPLICATE_CLIENT_REQUEST_ID');
          e.statusCode = 409; e.batch_id = existing.rows[0].id; throw e;
        }
      }

      // Validate replacement_of_batch_id: must exist, be voided, belong to this shop
      if (replacement_of_batch_id) {
        if (!isUUID(replacement_of_batch_id)) {
          const e = new Error('invalid replacement_of_batch_id'); e.statusCode = 400; throw e;
        }
        const orig = await c.query(
          'SELECT status FROM delivery_sales_batches WHERE id=$1 AND shop_id=$2',
          [replacement_of_batch_id, req.shopId]
        );
        if (!orig.rowCount) { const e = new Error('REPLACEMENT_ORIGINAL_NOT_FOUND'); e.statusCode = 404; throw e; }
        if (orig.rows[0].status !== 'voided') {
          const e = new Error('REPLACEMENT_ORIGINAL_NOT_VOIDED'); e.statusCode = 409; throw e;
        }
      }

      const batchR = await c.query(
        `insert into delivery_sales_batches
           (shop_id, platform, sales_date_from, sales_date_to, mode, gross_sales, order_count, item_count,
            source_type, client_request_id, replacement_of_batch_id, created_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,'manual',$9,$10,$11) returning id`,
        [req.shopId, platform, sales_date_from, sales_date_to || sales_date_from,
         mode, Number(gross_sales) || 0, Number(order_count) || 0, safeItems.length,
         client_request_id || null, replacement_of_batch_id || null, req.userId]
      );
      const batchId = batchR.rows[0].id;

      // Validate menu refs belong to this shop before inserting items
      let grossFromItems = 0;
      for (const it of safeItems) {
        if (it.menu_type === 'recipe') {
          const check = await c.query('select 1 from recipes where id=$1 and shop_id=$2', [it.recipe_id, req.shopId]);
          if (!check.rowCount) {
            const global = (await c.query('select 1 from recipes where id=$1', [it.recipe_id])).rowCount;
            const e = new Error(global ? 'FORBIDDEN_RECIPE' : 'RECIPE_NOT_FOUND'); e.statusCode = global ? 403 : 404; throw e;
          }
        } else {
          const check = await c.query('select 1 from materials where id=$1 and shop_id=$2', [it.material_id, req.shopId]);
          if (!check.rowCount) {
            const global = (await c.query('select 1 from materials where id=$1', [it.material_id])).rowCount;
            const e = new Error(global ? 'FORBIDDEN_MATERIAL' : 'MATERIAL_NOT_FOUND'); e.statusCode = global ? 403 : 404; throw e;
          }
        }
        const gross = Number(it.gross_amount) || (Number(it.quantity) * Number(it.unit_price));
        grossFromItems += gross;
        await c.query(
          `insert into delivery_sales_items
             (batch_id, shop_id, menu_type, recipe_id, material_id, menu_code, menu_name,
              quantity, unit_price, gross_amount, discount_amount, chosen_options, refund_flag)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [batchId, req.shopId,
           it.menu_type,
           it.menu_type === 'recipe' ? it.recipe_id : null,
           it.menu_type === 'material' ? it.material_id : null,
           it.menu_code || null, it.menu_name,
           Number(it.quantity), Number(it.unit_price) || 0,
           Number(it.gross_amount) || 0, Number(it.discount_amount) || 0,
           JSON.stringify(it.chosen_options || []),
           !!it.refund_flag]
        );
      }

      return { batch_id: batchId, gross_from_items: grossFromItems, header_gross: Number(gross_sales) || 0 };
    });
    res.status(201).json(out);
  } catch (e) {
    if (e.statusCode === 409 && e.batch_id) return res.status(409).json({ error: e.message, batch_id: e.batch_id });
    if (e.statusCode) return res.status(e.statusCode).json({ error: e.message });
    res.status(500).json({ error: e.message });
  }
});

// GET /api/delivery/batches — list batches for this shop
router.get('/batches', async (req, res) => {
  const { platform, from, to, status, limit = 50, offset = 0 } = req.query;
  const params = [req.shopId];
  let where = 'WHERE shop_id=$1';
  let p = 2;
  if (platform) { where += ` AND platform=$${p++}`; params.push(platform); }
  if (from)     { where += ` AND sales_date_from>=$${p++}`; params.push(from); }
  if (to)       { where += ` AND sales_date_to<=$${p++}`; params.push(to); }
  if (status)   { where += ` AND status=$${p++}`; params.push(status); }

  try {
    const rows = (await query(
      `SELECT id, platform, sales_date_from, sales_date_to, mode, status,
              gross_sales, order_count, item_count, stock_deducted,
              variance_amount, variance_reason,
              created_at, confirmed_at
       FROM delivery_sales_batches ${where}
       ORDER BY sales_date_from DESC, created_at DESC
       LIMIT $${p} OFFSET $${p+1}`,
      [...params, Number(limit), Number(offset)]
    )).rows;

    const total = (await query(
      `SELECT SUM(gross_sales) as total_gross, SUM(item_count) as total_items
       FROM delivery_sales_batches ${where}`, params
    )).rows[0];

    res.json({ batches: rows, total_gross: Number(total.total_gross) || 0, total_items: Number(total.total_items) || 0 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/delivery/batch/:id — batch detail with items and stock movements
router.get('/batch/:id', async (req, res) => {
  if (!isUUID(req.params.id)) return res.status(400).json({ error: 'invalid id' });
  try {
    const batch = (await query(
      'SELECT * FROM delivery_sales_batches WHERE id=$1 AND shop_id=$2',
      [req.params.id, req.shopId]
    )).rows[0];
    if (!batch) return res.status(404).json({ error: 'not found' });

    const items = (await query(
      'SELECT * FROM delivery_sales_items WHERE batch_id=$1 ORDER BY created_at',
      [req.params.id]
    )).rows;

    const movements = (await query(
      `SELECT sm.* FROM stock_movements sm
       JOIN delivery_batch_stock_movements dbsm ON dbsm.stock_movement_id = sm.id
       WHERE dbsm.batch_id=$1 ORDER BY sm.created_at`,
      [req.params.id]
    )).rows;

    res.json({ batch, items, movements });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/delivery/batch/:id — update draft batch (gross, order_count, variance info)
router.patch('/batch/:id', requirePerm('delivery_entry'), async (req, res) => {
  if (!isUUID(req.params.id)) return res.status(400).json({ error: 'invalid id' });
  try {
    const out = await tx(async (c) => {
      const batch = (await c.query(
        'SELECT status FROM delivery_sales_batches WHERE id=$1 AND shop_id=$2',
        [req.params.id, req.shopId]
      )).rows[0];
      if (!batch) { const e = new Error('not found'); e.statusCode = 404; throw e; }
      if (batch.status !== 'draft') { const e = new Error('BATCH_NOT_DRAFT'); e.statusCode = 409; throw e; }

      const { gross_sales, order_count, variance_reason, variance_note, variance_amount } = req.body || {};
      const sets = ['updated_at=now()'];
      const vals = [req.params.id, req.shopId];
      let p = 3;
      if (gross_sales !== undefined) { sets.push(`gross_sales=$${p++}`); vals.push(Number(gross_sales)); }
      if (order_count !== undefined) { sets.push(`order_count=$${p++}`); vals.push(Number(order_count)); }
      if (variance_reason !== undefined) { sets.push(`variance_reason=$${p++}`); vals.push(variance_reason); }
      if (variance_note !== undefined) { sets.push(`variance_note=$${p++}`); vals.push(variance_note); }
      if (variance_amount !== undefined) { sets.push(`variance_amount=$${p++}`); vals.push(Number(variance_amount)); }

      await c.query(
        `UPDATE delivery_sales_batches SET ${sets.join(',')} WHERE id=$1 AND shop_id=$2`,
        vals
      );
      return { ok: true };
    });
    res.json(out);
  } catch (e) {
    if (e.statusCode) return res.status(e.statusCode).json({ error: e.message });
    res.status(500).json({ error: e.message });
  }
});

// POST /api/delivery/batch/:id/confirm — confirm draft, deduct stock (stock_aware only)
router.post('/batch/:id/confirm', requirePerm('delivery_entry'), async (req, res) => {
  if (!isUUID(req.params.id)) return res.status(400).json({ error: 'invalid id' });
  try {
    const out = await tx(async (c) => {
      const batch = (await c.query(
        'SELECT * FROM delivery_sales_batches WHERE id=$1 AND shop_id=$2 FOR UPDATE',
        [req.params.id, req.shopId]
      )).rows[0];
      if (!batch) { const e = new Error('not found'); e.statusCode = 404; throw e; }
      if (batch.status !== 'draft') { const e = new Error('BATCH_NOT_DRAFT'); e.statusCode = 409; throw e; }

      // Idempotency: stock_operation_ref — set atomically, unique constraint prevents double-confirm
      const opRef = `batch:${req.params.id}:confirm`;
      const refCheck = await c.query(
        'SELECT 1 FROM delivery_sales_batches WHERE stock_operation_ref=$1', [opRef]
      );
      if (refCheck.rowCount) { const e = new Error('ALREADY_CONFIRMED'); e.statusCode = 409; throw e; }

      const items = (await c.query(
        'SELECT * FROM delivery_sales_items WHERE batch_id=$1', [req.params.id]
      )).rows;

      // Gross mismatch check (stock_aware only — financial_only has no item requirement)
      const grossFromItems = items.reduce((s, it) => s + Number(it.gross_amount || 0), 0);
      const headerGross = Number(batch.gross_sales) || 0;
      const TOLERANCE = 0.01;
      if (batch.mode === 'stock_aware') {
        if (items.length === 0) {
          const e = new Error('STOCK_AWARE_REQUIRES_ITEMS'); e.statusCode = 400; throw e;
        }
        if (headerGross > 0 && Math.abs(grossFromItems - headerGross) > TOLERANCE) {
          if (!batch.variance_reason) {
            const e = new Error('GROSS_MISMATCH_UNRESOLVED'); e.statusCode = 400;
            e.gross_from_items = grossFromItems; e.header_gross = headerGross; throw e;
          }
          if (!batch.variance_approved_by) {
            await c.query(
              'UPDATE delivery_sales_batches SET variance_approved_by=$1 WHERE id=$2',
              [req.userId, req.params.id]
            );
          }
        }
      }

      const stockResults = [];
      const movementLinks = [];

      if (batch.mode === 'stock_aware') {
        const shopRow = (await c.query('SELECT make_to_order FROM shop_settings WHERE shop_id=$1', [req.shopId])).rows[0];
        const globalMTO = shopRow ? !!shopRow.make_to_order : false;
        const cats = await engine.loadCats(c);
        const note = `delivery batch:${req.params.id} ${batch.platform} ${batch.sales_date_from}`;

        for (const it of items) {
          await engine.validateOptionsForLine(c, it.menu_type, it.menu_type === 'recipe' ? it.recipe_id : it.material_id, it.chosen_options || []);

          if (it.menu_type === 'material') {
            const r = await engine.deductMaterial(c, req.shopId, req.userId, cats, it.material_id, Number(it.quantity), 'on_sale', note);
            if (r.mvId) movementLinks.push({ mvId: r.mvId, type: 'deduct' });
            stockResults.push(r);
          } else {
            const rec = (await c.query(
              'SELECT id,name,fg_stock,yield_unit,inventory_mode FROM recipes WHERE id=$1 AND shop_id=$2 FOR UPDATE',
              [it.recipe_id, req.shopId]
            )).rows[0];
            if (!rec) {
              const globalCheck = (await c.query('select 1 from recipes where id=$1', [it.recipe_id])).rowCount;
              const e = new Error(globalCheck ? 'FORBIDDEN_RECIPE' : 'RECIPE_NOT_FOUND');
              e.statusCode = globalCheck ? 403 : 404; throw e;
            }

            const invMode = rec.inventory_mode || 'inherit';
            const effectiveMode = invMode === 'inherit' ? (globalMTO ? 'make_to_order' : 'finished_goods') : invMode;

            if (effectiveMode === 'non_stock') {
              stockResults.push({ type: 'non_stock', ref_id: rec.id }); continue;
            }
            if (effectiveMode === 'finished_goods') {
              const fg = Number(rec.fg_stock) || 0;
              if (fg < Number(it.quantity)) {
                const e = new Error('FG_STOCK_INSUFFICIENT');
                e.statusCode = 409; e.recipeName = rec.name; e.have = fg; e.need = Number(it.quantity); throw e;
              }
              const r = await engine.deductRecipeFg(c, req.shopId, req.userId, rec, Number(it.quantity), 'on_sale', 'recipe_fg', note);
              if (r.mvId) movementLinks.push({ mvId: r.mvId, type: 'deduct' });
              stockResults.push(r); continue;
            }
            // make_to_order
            const { bom, subs } = await engine.buildEffectiveBom(c, it.recipe_id, it.chosen_options || []);
            for (const [matId, entry] of bom) {
              if (entry.amount * Number(it.quantity) <= 0) continue;
              const r = await engine.deductMaterial(c, req.shopId, req.userId, cats, matId, entry.amount * Number(it.quantity), 'recipe_use', note);
              if (r.mvId) movementLinks.push({ mvId: r.mvId, type: 'deduct' });
              stockResults.push(r);
            }
            for (const s of subs) {
              if (s.amount * Number(it.quantity) <= 0) continue;
              const sub = (await c.query('SELECT id,name,fg_stock,yield_unit FROM recipes WHERE id=$1 AND shop_id=$2 FOR UPDATE', [s.sub_recipe_id, req.shopId])).rows[0];
              if (!sub) {
                const gc = (await c.query('select 1 from recipes where id=$1', [s.sub_recipe_id])).rowCount;
                const e = new Error(gc ? 'FORBIDDEN_SUB_RECIPE' : 'SUB_RECIPE_NOT_FOUND');
                e.statusCode = gc ? 403 : 404; throw e;
              }
              const r = await engine.deductRecipeFg(c, req.shopId, req.userId, sub, s.amount * Number(it.quantity), 'recipe_use', 'sub_recipe', note);
              if (r.mvId) movementLinks.push({ mvId: r.mvId, type: 'deduct' });
              stockResults.push(r);
            }
          }

          // Snapshot stock_impact on item
          await c.query('UPDATE delivery_sales_items SET stock_impact=$1 WHERE id=$2',
            [JSON.stringify(stockResults.slice(-1)), it.id]);
        }

        // Link all movements via structured relation (correction 1)
        for (const lnk of movementLinks) {
          await c.query(
            'INSERT INTO delivery_batch_stock_movements (batch_id, stock_movement_id, operation_type) VALUES ($1,$2,$3)',
            [req.params.id, lnk.mvId, lnk.type]
          );
        }
      }

      // Set idempotency key + update status (single atomic update)
      await c.query(
        `UPDATE delivery_sales_batches
         SET status='confirmed', stock_deducted=$1, stock_operation_ref=$2,
             confirmed_at=now(), confirmed_by=$3, version=version+1, updated_at=now()
         WHERE id=$4 AND shop_id=$5`,
        [batch.mode === 'stock_aware', opRef, req.userId, req.params.id, req.shopId]
      );

      // Audit log
      await c.query(
        `INSERT INTO bill_audit_log (shop_id, bill_id, action, actor_id, reason, snapshot)
         SELECT $1, b.id, 'confirmed', $2, 'delivery batch confirmed', $3::jsonb
         FROM bills b WHERE b.delivery_batch_id=$4`,
        [req.shopId, req.userId, JSON.stringify({ batch_id: req.params.id, platform: batch.platform }), req.params.id]
      );

      return { batch_id: req.params.id, status: 'confirmed', mode: batch.mode, stock_results: stockResults };
    });
    res.json(out);
  } catch (e) {
    if (e.statusCode === 409) return res.status(409).json({ error: e.message, recipeName: e.recipeName, have: e.have, need: e.need });
    if (e.statusCode) return res.status(e.statusCode).json({ error: e.message });
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/delivery/batch/:id — delete draft with no movements
router.delete('/batch/:id', requirePerm('delivery_entry'), async (req, res) => {
  if (!isUUID(req.params.id)) return res.status(400).json({ error: 'invalid id' });
  try {
    const out = await tx(async (c) => {
      const batch = (await c.query(
        'SELECT status FROM delivery_sales_batches WHERE id=$1 AND shop_id=$2 FOR UPDATE',
        [req.params.id, req.shopId]
      )).rows[0];
      if (!batch) { const e = new Error('not found'); e.statusCode = 404; throw e; }
      if (batch.status !== 'draft') { const e = new Error('BATCH_NOT_DRAFT'); e.statusCode = 409; throw e; }

      const mvLinks = (await c.query(
        'SELECT 1 FROM delivery_batch_stock_movements WHERE batch_id=$1 LIMIT 1', [req.params.id]
      )).rowCount;
      if (mvLinks) { const e = new Error('BATCH_HAS_MOVEMENTS'); e.statusCode = 409; throw e; }

      await c.query('DELETE FROM delivery_sales_items WHERE batch_id=$1', [req.params.id]);
      await c.query('DELETE FROM delivery_sales_batches WHERE id=$1 AND shop_id=$2', [req.params.id, req.shopId]);
      return { deleted: true };
    });
    res.json(out);
  } catch (e) {
    if (e.statusCode) return res.status(e.statusCode).json({ error: e.message });
    res.status(500).json({ error: e.message });
  }
});

// POST /api/delivery/batch/:id/void — void confirmed batch, reverse stock
router.post('/batch/:id/void', requirePerm('void_bill'), async (req, res) => {
  if (!isUUID(req.params.id)) return res.status(400).json({ error: 'invalid id' });
  const { reason } = req.body || {};
  try {
    const out = await tx(async (c) => {
      const batch = (await c.query(
        'SELECT * FROM delivery_sales_batches WHERE id=$1 AND shop_id=$2 FOR UPDATE',
        [req.params.id, req.shopId]
      )).rows[0];
      if (!batch) { const e = new Error('not found'); e.statusCode = 404; throw e; }
      if (batch.status === 'voided') { return { voided: true, already: true }; }
      if (!['confirmed'].includes(batch.status)) {
        const e = new Error('BATCH_NOT_VOIDABLE'); e.statusCode = 409; throw e;
      }

      // Idempotency: check reversal_ref
      if (batch.reversal_ref) { return { voided: true, already: true }; }

      let reversal = { results: [], alreadyVoided: false };
      if (batch.stock_deducted) {
        // Load movement IDs via structured relation (not by note)
        const deductIds = (await c.query(
          `SELECT stock_movement_id FROM delivery_batch_stock_movements
           WHERE batch_id=$1 AND operation_type='deduct'`,
          [req.params.id]
        )).rows.map(r => r.stock_movement_id);

        if (deductIds.length) {
          const voidNote = `void delivery batch:${req.params.id}`;
          reversal = await engine.reverseMovements(c, req.shopId, req.userId, deductIds, voidNote);

          // Link reversal movements to structured relation
          for (const r of reversal.results) {
            if (r.mvId) {
              await c.query(
                'INSERT INTO delivery_batch_stock_movements (batch_id, stock_movement_id, operation_type) VALUES ($1,$2,$3)',
                [req.params.id, r.mvId, 'reverse']
              );
            }
          }
        }
      }

      const reversalRef = `batch:${req.params.id}:void`;
      await c.query(
        `UPDATE delivery_sales_batches
         SET status='voided', reversal_ref=$1, version=version+1, updated_at=now()
         WHERE id=$2 AND shop_id=$3`,
        [reversalRef, req.params.id, req.shopId]
      );

      return { voided: true, already: reversal.alreadyVoided, reversal_results: reversal.results };
    });
    res.json(out);
  } catch (e) {
    if (e.statusCode) return res.status(e.statusCode).json({ error: e.message });
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// Batch Items
// ─────────────────────────────────────────────────────────────────────────

// POST /api/delivery/batch/:id/items — add item to draft batch
router.post('/batch/:id/items', requirePerm('delivery_entry'), async (req, res) => {
  if (!isUUID(req.params.id)) return res.status(400).json({ error: 'invalid id' });
  try {
    const out = await tx(async (c) => {
      const batch = (await c.query(
        'SELECT status FROM delivery_sales_batches WHERE id=$1 AND shop_id=$2',
        [req.params.id, req.shopId]
      )).rows[0];
      if (!batch) { const e = new Error('not found'); e.statusCode = 404; throw e; }
      if (batch.status !== 'draft') { const e = new Error('BATCH_NOT_DRAFT'); e.statusCode = 409; throw e; }

      const { menu_type, recipe_id, material_id, menu_code, menu_name, quantity, unit_price, gross_amount, discount_amount, chosen_options, refund_flag } = req.body || {};
      if (!['recipe', 'material'].includes(menu_type)) { const e = new Error('invalid menu_type'); e.statusCode = 400; throw e; }

      const refId = menu_type === 'recipe' ? recipe_id : material_id;
      const table = menu_type === 'recipe' ? 'recipes' : 'materials';
      const check = await c.query(`SELECT 1 FROM ${table} WHERE id=$1 AND shop_id=$2`, [refId, req.shopId]);
      if (!check.rowCount) {
        const global = (await c.query(`SELECT 1 FROM ${table} WHERE id=$1`, [refId])).rowCount;
        const e = new Error(global ? `FORBIDDEN_${menu_type.toUpperCase()}` : `${menu_type.toUpperCase()}_NOT_FOUND`);
        e.statusCode = global ? 403 : 404; throw e;
      }

      const r = await c.query(
        `INSERT INTO delivery_sales_items
           (batch_id, shop_id, menu_type, recipe_id, material_id, menu_code, menu_name,
            quantity, unit_price, gross_amount, discount_amount, chosen_options, refund_flag)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
        [req.params.id, req.shopId, menu_type,
         menu_type === 'recipe' ? recipe_id : null, menu_type === 'material' ? material_id : null,
         menu_code || null, menu_name, Number(quantity), Number(unit_price) || 0,
         Number(gross_amount) || 0, Number(discount_amount) || 0,
         JSON.stringify(chosen_options || []), !!refund_flag]
      );

      await c.query('UPDATE delivery_sales_batches SET item_count=item_count+1, updated_at=now() WHERE id=$1', [req.params.id]);
      return { item_id: r.rows[0].id };
    });
    res.status(201).json(out);
  } catch (e) {
    if (e.statusCode) return res.status(e.statusCode).json({ error: e.message });
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/delivery/batch/:id/items/:itemId — remove item from draft batch
router.delete('/batch/:id/items/:itemId', requirePerm('delivery_entry'), async (req, res) => {
  if (!isUUID(req.params.id) || !isUUID(req.params.itemId)) return res.status(400).json({ error: 'invalid id' });
  try {
    const out = await tx(async (c) => {
      const batch = (await c.query(
        'SELECT status FROM delivery_sales_batches WHERE id=$1 AND shop_id=$2',
        [req.params.id, req.shopId]
      )).rows[0];
      if (!batch) { const e = new Error('not found'); e.statusCode = 404; throw e; }
      if (batch.status !== 'draft') { const e = new Error('BATCH_NOT_DRAFT'); e.statusCode = 409; throw e; }

      const del = await c.query('DELETE FROM delivery_sales_items WHERE id=$1 AND batch_id=$2 RETURNING id', [req.params.itemId, req.params.id]);
      if (!del.rowCount) { const e = new Error('item not found'); e.statusCode = 404; throw e; }
      await c.query('UPDATE delivery_sales_batches SET item_count=GREATEST(0, item_count-1), updated_at=now() WHERE id=$1', [req.params.id]);
      return { deleted: true };
    });
    res.json(out);
  } catch (e) {
    if (e.statusCode) return res.status(e.statusCode).json({ error: e.message });
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// Settlement
// ─────────────────────────────────────────────────────────────────────────

// Validate settlement allocations — all checks in one transaction context
async function validateAllocations(c, shopId, platform, settlementId, allocations, legacyBills) {
  // Batch allocations
  for (const alloc of (allocations || [])) {
    if (!isUUID(alloc.batch_id)) { const e = new Error('invalid batch_id'); e.statusCode = 400; throw e; }

    const batch = (await c.query(
      'SELECT shop_id, platform, status, gross_sales FROM delivery_sales_batches WHERE id=$1',
      [alloc.batch_id]
    )).rows[0];
    if (!batch || batch.shop_id !== shopId) { const e = new Error('CROSS_SHOP_BATCH'); e.statusCode = 403; throw e; }
    if (batch.platform !== platform) { const e = new Error('PLATFORM_MISMATCH'); e.statusCode = 400; throw e; }
    if (batch.status === 'voided') { const e = new Error('BATCH_VOIDED'); e.statusCode = 400; throw e; }
    if (batch.status === 'draft') { const e = new Error('BATCH_NOT_CONFIRMED'); e.statusCode = 400; throw e; }
    if (Number(alloc.allocated_gross) > Number(batch.gross_sales)) {
      const e = new Error('ALLOCATION_EXCEEDS_BATCH_GROSS'); e.statusCode = 400; throw e;
    }
    if (settlementId) {
      const dup = await c.query(
        'SELECT 1 FROM delivery_settlement_allocation WHERE settlement_id=$1 AND batch_id=$2',
        [settlementId, alloc.batch_id]
      );
      if (dup.rowCount) { const e = new Error('DUPLICATE_ALLOCATION'); e.statusCode = 409; throw e; }
    }
  }

  // Legacy bill allocations
  for (const lb of (legacyBills || [])) {
    if (!isUUID(lb.bill_id)) { const e = new Error('invalid bill_id'); e.statusCode = 400; throw e; }

    const bill = (await c.query(
      'SELECT shop_id, bill_status FROM bills WHERE id=$1', [lb.bill_id]
    )).rows[0];
    if (!bill || bill.shop_id !== shopId) { const e = new Error('CROSS_SHOP_LEGACY_BILL'); e.statusCode = 403; throw e; }
    if (bill.bill_status === 'voided') { const e = new Error('VOIDED_BILL_CANNOT_ALLOCATE'); e.statusCode = 400; throw e; }
  }
}

// POST /api/delivery/settlement — create settlement (draft)
router.post('/settlement', requirePerm('delivery_settlement'), async (req, res) => {
  const {
    platform, settlement_date,
    gross_sales, commission_rate, commission_amount,
    discount_funding_source, merchant_discount_amount, platform_discount_amount,
    promotion_fee, advertising_fee, vat_on_fee, refund_amount,
    withholding_tax, other_deduction, other_adjustment,
    actual_bank_deposit, bank_account, settlement_reference, note,
    allocations, legacy_bills
  } = req.body || {};

  if (!platform) return res.status(400).json({ error: 'platform required' });

  const funding = discount_funding_source || 'merchant';
  if (!['merchant', 'platform', 'shared'].includes(funding)) {
    return res.status(400).json({ error: 'invalid discount_funding_source' });
  }

  try {
    const out = await tx(async (c) => {
      // Validate allocations before insert
      await validateAllocations(c, req.shopId, platform, null, allocations, legacy_bills);

      const sR = await c.query(
        `INSERT INTO delivery_settlements
           (shop_id, platform, settlement_date,
            gross_sales, commission_rate, commission_amount,
            discount_funding_source, merchant_discount_amount, platform_discount_amount,
            promotion_fee, advertising_fee, vat_on_fee, refund_amount,
            withholding_tax, other_deduction, other_adjustment,
            actual_bank_deposit, bank_account, settlement_reference, note,
            created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
         RETURNING id, merchant_net, expected_bank_cash, variance`,
        [req.shopId, platform, settlement_date || null,
         Number(gross_sales) || 0, Number(commission_rate) || 0, Number(commission_amount) || 0,
         funding, Number(merchant_discount_amount) || 0, Number(platform_discount_amount) || 0,
         Number(promotion_fee) || 0, Number(advertising_fee) || 0, Number(vat_on_fee) || 0, Number(refund_amount) || 0,
         Number(withholding_tax) || 0, Number(other_deduction) || 0, Number(other_adjustment) || 0,
         Number(actual_bank_deposit) || 0, bank_account || null, settlement_reference || null, note || null,
         req.userId]
      );
      const sRow = sR.rows[0];

      // Batch allocations
      for (const alloc of (allocations || [])) {
        await c.query(
          `INSERT INTO delivery_settlement_allocation
             (settlement_id, batch_id, allocated_gross, allocated_fee, allocated_net)
           VALUES ($1,$2,$3,$4,$5)`,
          [sRow.id, alloc.batch_id, Number(alloc.allocated_gross) || 0,
           Number(alloc.allocated_fee) || 0, Number(alloc.allocated_net) || 0]
        );
        // Mark allocated batches as settled
        await c.query(
          `UPDATE delivery_sales_batches SET status='settled', updated_at=now() WHERE id=$1 AND shop_id=$2`,
          [alloc.batch_id, req.shopId]
        );
      }

      // Legacy bill allocations
      for (const lb of (legacy_bills || [])) {
        await c.query(
          `INSERT INTO delivery_settlement_legacy_bills
             (settlement_id, bill_id, allocated_gross, allocated_net)
           VALUES ($1,$2,$3,$4)`,
          [sRow.id, lb.bill_id, Number(lb.allocated_gross) || 0, Number(lb.allocated_net) || 0]
        );
      }

      return {
        settlement_id: sRow.id,
        merchant_net: Number(sRow.merchant_net),
        expected_bank_cash: Number(sRow.expected_bank_cash),
        variance: Number(sRow.variance)
      };
    });
    res.status(201).json(out);
  } catch (e) {
    if (e.statusCode) return res.status(e.statusCode).json({ error: e.message });
    res.status(500).json({ error: e.message });
  }
});

// POST /api/delivery/settlement/:id/confirm
router.post('/settlement/:id/confirm', requirePerm('delivery_settlement'), async (req, res) => {
  if (!isUUID(req.params.id)) return res.status(400).json({ error: 'invalid id' });
  try {
    const out = await tx(async (c) => {
      const s = (await c.query(
        'SELECT status FROM delivery_settlements WHERE id=$1 AND shop_id=$2 FOR UPDATE',
        [req.params.id, req.shopId]
      )).rows[0];
      if (!s) { const e = new Error('not found'); e.statusCode = 404; throw e; }
      if (s.status === 'locked') { const e = new Error('SETTLEMENT_LOCKED'); e.statusCode = 409; throw e; }
      if (s.status === 'confirmed') { return { status: 'confirmed', already: true }; }

      await c.query(
        `UPDATE delivery_settlements SET status='confirmed', confirmed_by=$1, confirmed_at=now(), updated_at=now() WHERE id=$2`,
        [req.userId, req.params.id]
      );
      return { status: 'confirmed' };
    });
    res.json(out);
  } catch (e) {
    if (e.statusCode) return res.status(e.statusCode).json({ error: e.message });
    res.status(500).json({ error: e.message });
  }
});

// GET /api/delivery/settlements
router.get('/settlements', async (req, res) => {
  const { platform, from, to, status, limit = 50, offset = 0 } = req.query;
  const params = [req.shopId];
  let where = 'WHERE shop_id=$1';
  let p = 2;
  if (platform) { where += ` AND platform=$${p++}`; params.push(platform); }
  if (from)     { where += ` AND settlement_date>=$${p++}`; params.push(from); }
  if (to)       { where += ` AND settlement_date<=$${p++}`; params.push(to); }
  if (status)   { where += ` AND status=$${p++}`; params.push(status); }
  try {
    const rows = (await query(
      `SELECT id, platform, settlement_date, status, gross_sales,
              merchant_net, expected_bank_cash, actual_bank_deposit, variance,
              commission_rate, withholding_tax, created_at, confirmed_at
       FROM delivery_settlements ${where}
       ORDER BY settlement_date DESC NULLS LAST, created_at DESC
       LIMIT $${p} OFFSET $${p+1}`,
      [...params, Number(limit), Number(offset)]
    )).rows;

    const tot = (await query(
      `SELECT SUM(gross_sales) as total_gross, SUM(actual_bank_deposit) as total_deposits, SUM(variance) as total_variance
       FROM delivery_settlements ${where}`, params
    )).rows[0];

    res.json({
      settlements: rows,
      total_gross: Number(tot.total_gross) || 0,
      total_deposits: Number(tot.total_deposits) || 0,
      total_variance: Number(tot.total_variance) || 0
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/delivery/settlement/:id
router.get('/settlement/:id', async (req, res) => {
  if (!isUUID(req.params.id)) return res.status(400).json({ error: 'invalid id' });
  try {
    const s = (await query(
      'SELECT * FROM delivery_settlements WHERE id=$1 AND shop_id=$2',
      [req.params.id, req.shopId]
    )).rows[0];
    if (!s) return res.status(404).json({ error: 'not found' });

    const allocations = (await query(
      `SELECT dsa.*, dsb.platform, dsb.sales_date_from, dsb.sales_date_to, dsb.status as batch_status
       FROM delivery_settlement_allocation dsa
       JOIN delivery_sales_batches dsb ON dsb.id = dsa.batch_id
       WHERE dsa.settlement_id=$1`,
      [req.params.id]
    )).rows;

    const legacyBills = (await query(
      `SELECT dslb.*, b.number as bill_number, b.bill_status, b.grand_total
       FROM delivery_settlement_legacy_bills dslb
       JOIN bills b ON b.id = dslb.bill_id
       WHERE dslb.settlement_id=$1`,
      [req.params.id]
    )).rows;

    res.json({ settlement: s, allocations, legacy_bills: legacyBills });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─────────────────────────────────────────────────────────────────────────
// Bill Correction (POS / Receipt only — not tax_full / tax_abbrev)
// ─────────────────────────────────────────────────────────────────────────

// POST /api/delivery/bill/:id/correct
router.post('/bill/:id/correct', requirePerm('correct_bill'), async (req, res) => {
  if (!isUUID(req.params.id)) return res.status(400).json({ error: 'invalid id' });
  const { reason } = req.body || {};
  if (!reason) return res.status(400).json({ error: 'reason required' });

  try {
    const out = await tx(async (c) => {
      const bill = (await c.query(
        'SELECT * FROM bills WHERE id=$1 AND shop_id=$2 FOR UPDATE',
        [req.params.id, req.shopId]
      )).rows[0];
      if (!bill) { const e = new Error('not found'); e.statusCode = 404; throw e; }
      if (['tax_full', 'tax_abbrev'].includes(bill.doc_kind)) {
        const e = new Error('TAX_INVOICE_CORRECTION_NOT_SUPPORTED'); e.statusCode = 400; throw e;
      }
      if (['corrected', 'voided', 'locked'].includes(bill.bill_status)) {
        const e = new Error('BILL_NOT_CORRECTABLE'); e.statusCode = 409; throw e;
      }

      // Audit snapshot original
      await c.query(
        `INSERT INTO bill_audit_log (shop_id, bill_id, action, actor_id, reason, snapshot)
         VALUES ($1,$2,'corrected',$3,$4,$5::jsonb)`,
        [req.shopId, bill.id, req.userId, reason, JSON.stringify(bill)]
      );

      // Mark original as corrected
      await c.query(
        `UPDATE bills SET bill_status='corrected', corrected_by=$1, corrected_at=now(), correction_reason=$2 WHERE id=$3`,
        [req.userId, reason, bill.id]
      );

      // Reverse stock movements for original bill (look up via note for POS bills)
      const saleNote = 'ขาย ' + bill.number;
      const deductMoves = (await c.query(
        `SELECT id FROM stock_movements WHERE shop_id=$1 AND note=$2 AND kind='sale'`,
        [req.shopId, saleNote]
      )).rows.map(r => r.id);

      let reversalResults = [];
      if (deductMoves.length) {
        const r = await engine.reverseMovements(c, req.shopId, req.userId, deductMoves, `void correction of ${bill.number}`);
        reversalResults = r.results;
      }

      // Create replacement draft bill with new number
      const year = new Date().getFullYear();
      await c.query(
        `INSERT INTO doc_counters (shop_id, year, doc_kind, last_no)
         VALUES ($1, $2, 'HB', 0)
         ON CONFLICT (shop_id, year, doc_kind) DO NOTHING`,
        [req.shopId, year]
      );
      const ctr = (await c.query(
        `UPDATE doc_counters SET last_no=last_no+1 WHERE shop_id=$1 AND year=$2 AND doc_kind='HB' RETURNING last_no`,
        [req.shopId, year]
      )).rows[0];
      const newNumber = 'HB-' + String(ctr.last_no).padStart(4, '0');

      const newBill = await c.query(
        `INSERT INTO bills
           (shop_id, number, doc_kind, items_json, discount, tax, status, bill_status,
            original_bill_id, delivery_platform, delivery_date, delivery_mode, delivery_batch_id)
         VALUES ($1,$2,$3,$4,$5,$6,'wait','draft',$7,$8,$9,$10,$11) RETURNING id`,
        [req.shopId, newNumber, bill.doc_kind, bill.items_json,
         bill.discount, bill.tax,
         bill.id, bill.delivery_platform, bill.delivery_date, bill.delivery_mode, bill.delivery_batch_id]
      );

      await c.query(
        `INSERT INTO bill_audit_log (shop_id, bill_id, action, actor_id, reason)
         VALUES ($1,$2,'created',$3,'replacement for corrected bill')`,
        [req.shopId, newBill.rows[0].id, req.userId]
      );

      return {
        original_bill_id: bill.id,
        new_bill_id: newBill.rows[0].id,
        new_bill_number: newNumber,
        reversal_results: reversalResults
      };
    });
    res.status(201).json(out);
  } catch (e) {
    if (e.statusCode) return res.status(e.statusCode).json({ error: e.message });
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// Reconciliation List
// ─────────────────────────────────────────────────────────────────────────

// GET /api/delivery/reconciliation — batches + settlement summary per period
router.get('/reconciliation', async (req, res) => {
  const { platform, from, to } = req.query;
  const params = [req.shopId];
  let where = 'WHERE shop_id=$1 AND status != \'voided\'';
  let p = 2;
  if (platform) { where += ` AND platform=$${p++}`; params.push(platform); }
  if (from) { where += ` AND sales_date_from>=$${p++}`; params.push(from); }
  if (to)   { where += ` AND sales_date_to<=$${p++}`; params.push(to); }

  try {
    const batches = (await query(
      `SELECT id, platform, sales_date_from, sales_date_to, mode, status,
              gross_sales, order_count, item_count, stock_deducted,
              variance_amount, variance_reason, confirmed_at, created_at
       FROM delivery_sales_batches ${where}
       ORDER BY sales_date_from DESC, created_at DESC`,
      params
    )).rows;

    // Settlements that touch these batches
    const settledBatchIds = batches.filter(b => b.status === 'settled').map(b => b.id);
    let settlements = [];
    if (settledBatchIds.length) {
      settlements = (await query(
        `SELECT ds.id, ds.platform, ds.settlement_date, ds.status,
                ds.gross_sales, ds.merchant_net, ds.expected_bank_cash,
                ds.actual_bank_deposit, ds.variance, ds.withholding_tax
         FROM delivery_settlements ds
         JOIN delivery_settlement_allocation dsa ON dsa.settlement_id=ds.id
         WHERE ds.shop_id=$1 AND dsa.batch_id=any($2::uuid[])
         GROUP BY ds.id ORDER BY ds.settlement_date DESC`,
        [req.shopId, settledBatchIds]
      )).rows;
    }

    res.json({ batches, settlements });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/delivery/bills — list bills linked to delivery (for legacy HB05 view)
router.get('/bills', async (req, res) => {
  const { platform, from, to, bill_status } = req.query;
  const params = [req.shopId];
  let where = 'WHERE shop_id=$1 AND delivery_platform IS NOT NULL';
  let p = 2;
  if (platform)    { where += ` AND delivery_platform=$${p++}`; params.push(platform); }
  if (from)        { where += ` AND delivery_date>=$${p++}`; params.push(from); }
  if (to)          { where += ` AND delivery_date<=$${p++}`; params.push(to); }
  if (bill_status) { where += ` AND bill_status=$${p++}`; params.push(bill_status); }
  try {
    const rows = (await query(
      `SELECT id, number, bill_status, delivery_platform, delivery_date, delivery_mode,
              grand_total, original_bill_id, created_at
       FROM bills ${where}
       ORDER BY delivery_date DESC NULLS LAST, created_at DESC LIMIT 200`,
      params
    )).rows;
    res.json({ bills: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
