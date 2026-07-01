// Delivery Operations MVP — Release A
// All write operations require requireAuth + tenant (mounted in app.js).
// Stock deduction uses shared stockEngine — same logic as POS, no duplication.

const express = require('express');
const { tx, query } = require('../db');
const { requirePerm } = require('../tenant');
const engine = require('../stockEngine');
const { requireDeliveryAllowed } = require('../delivery-feature');
const router = express.Router();

router.use(requireDeliveryAllowed);

const legacyDeliveryWriteDisabled = (req, res) =>
  res.status(410).json({ error: 'LEGACY_DELIVERY_WRITE_DISABLED' });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUUID(s) { return typeof s === 'string' && UUID_RE.test(s); }

// ─────────────────────────────────────────────────────────────────────────
// Batch CRUD
// ─────────────────────────────────────────────────────────────────────────

// POST /api/delivery/batch — LEGACY WRITE (disabled Release A+)
router.post('/batch', requirePerm('delivery_entry'), legacyDeliveryWriteDisabled);

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

// PATCH /api/delivery/batch/:id — LEGACY WRITE (disabled Release A+)
router.patch('/batch/:id', requirePerm('delivery_entry'), legacyDeliveryWriteDisabled);

// POST /api/delivery/batch/:id/confirm — LEGACY WRITE (disabled Release A+)
router.post('/batch/:id/confirm', requirePerm('delivery_entry'), legacyDeliveryWriteDisabled);

// DELETE /api/delivery/batch/:id — LEGACY WRITE (disabled Release A+)
router.delete('/batch/:id', requirePerm('delivery_entry'), legacyDeliveryWriteDisabled);

// POST /api/delivery/batch/:id/void — LEGACY WRITE (disabled Release A+)
router.post('/batch/:id/void', requirePerm('void_bill'), legacyDeliveryWriteDisabled);

// ─────────────────────────────────────────────────────────────────────────
// Batch Items
// ─────────────────────────────────────────────────────────────────────────

// POST /api/delivery/batch/:id/items — LEGACY WRITE (disabled Release A+)
router.post('/batch/:id/items', requirePerm('delivery_entry'), legacyDeliveryWriteDisabled);

// DELETE /api/delivery/batch/:id/items/:itemId — LEGACY WRITE (disabled Release A+)
router.delete('/batch/:id/items/:itemId', requirePerm('delivery_entry'), legacyDeliveryWriteDisabled);

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

// POST /api/delivery/settlement — LEGACY WRITE (disabled Release A+)
router.post('/settlement', requirePerm('delivery_settlement'), legacyDeliveryWriteDisabled);

// POST /api/delivery/settlement/:id/confirm — LEGACY WRITE (disabled Release A+)
router.post('/settlement/:id/confirm', requirePerm('delivery_settlement'), legacyDeliveryWriteDisabled);

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

// ─────────────────────────────────────────────────────────────────────────
// DAILY BILL MODEL — Phase 3 Delivery Workflow Correction
// หนึ่งสาขา + หนึ่ง Platform + หนึ่งวัน = บิล Delivery ค้างหนึ่งใบ
// Staff adds items incrementally. Stock deducted per item, not at day-close.
// ─────────────────────────────────────────────────────────────────────────

const EDITABLE_STATUSES = ['open', 'pending_review'];
const ACTIVE_STATUSES   = ['open', 'pending_review', 'awaiting_settlement', 'discrepancy'];

// POST /api/delivery/bill/open — open or return existing active daily bill (idempotent)
router.post('/bill/open', requirePerm('delivery_entry'), async (req, res) => {
  const { platform, sales_date } = req.body || {};
  if (!platform) return res.status(400).json({ error: 'platform required' });
  const salesDate = sales_date || new Date().toISOString().slice(0, 10);
  try {
    const existing = await query(
      `SELECT * FROM delivery_sales_batches
       WHERE shop_id=$1 AND platform=$2 AND sales_date=$3
       AND status = ANY($4::text[]) LIMIT 1`,
      [req.shopId, platform, salesDate, ACTIVE_STATUSES]
    );
    if (existing.rowCount) return res.json({ bill: existing.rows[0], created: false });

    const r = await query(
      `INSERT INTO delivery_sales_batches
         (shop_id, platform, sales_date, sales_date_from, sales_date_to,
          mode, status, source_type, created_by)
       VALUES ($1,$2,$3,$3,$3,'stock_aware','open','manual',$4) RETURNING *`,
      [req.shopId, platform, salesDate, req.userId]
    );
    res.status(201).json({ bill: r.rows[0], created: true });
  } catch (e) {
    if (e.code === '23505') {
      const ex = await query(
        `SELECT * FROM delivery_sales_batches
         WHERE shop_id=$1 AND platform=$2 AND sales_date=$3
         AND status = ANY($4::text[]) LIMIT 1`,
        [req.shopId, platform, salesDate, ACTIVE_STATUSES]
      );
      if (ex.rowCount) return res.json({ bill: ex.rows[0], created: false });
    }
    res.status(500).json({ error: e.message });
  }
});

// GET /api/delivery/bill/queue — grouped queue list (today + awaiting + reconciled)
router.get('/bill/queue', async (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  try {
    // Today's active bills (all statuses except voided, on today's date)
    const todayBills = (await query(
      `SELECT id, platform, sales_date, status, batch_item_gross, batch_item_net,
              cogs_total, gross_profit, item_count, order_count, created_at, closed_at
       FROM delivery_sales_batches
       WHERE shop_id=$1 AND sales_date=$2 AND status != 'voided'
       ORDER BY platform ASC`,
      [req.shopId, today]
    )).rows;

    // Pending review (any date)
    const pendingReview = (await query(
      `SELECT id, platform, sales_date, status, batch_item_gross, batch_item_net,
              cogs_total, gross_profit, item_count, updated_at
       FROM delivery_sales_batches
       WHERE shop_id=$1 AND status='pending_review'
       ORDER BY sales_date DESC`,
      [req.shopId]
    )).rows;

    // Awaiting settlement (past dates only)
    const awaitingSettlement = (await query(
      `SELECT id, platform, sales_date, status, batch_item_gross, batch_item_net,
              cogs_total, gross_profit, item_count, actual_bank_deposit, settlement_variance, closed_at
       FROM delivery_sales_batches
       WHERE shop_id=$1 AND status='awaiting_settlement'
         AND (sales_date IS NULL OR sales_date < $2)
       ORDER BY sales_date ASC`,
      [req.shopId, today]
    )).rows;

    // Discrepancy (needs resolution)
    const discrepancy = (await query(
      `SELECT id, platform, sales_date, status, batch_item_net, settlement_variance,
              actual_bank_deposit, expected_bank_cash, updated_at
       FROM delivery_sales_batches
       WHERE shop_id=$1 AND status='discrepancy'
       ORDER BY sales_date ASC`,
      [req.shopId]
    )).rows;

    // Recent reconciled
    const recentReconciled = (await query(
      `SELECT id, platform, sales_date, status, batch_item_net, settlement_variance, settled_at
       FROM delivery_sales_batches
       WHERE shop_id=$1 AND status='reconciled'
       ORDER BY settled_at DESC NULLS LAST LIMIT 5`,
      [req.shopId]
    )).rows;

    res.json({
      today: todayBills,
      pending_review: pendingReview,
      awaiting_settlement: awaitingSettlement,
      discrepancy,
      recent_reconciled: recentReconciled
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/delivery/bill/:id — full detail with items and movements
router.get('/bill/:id', async (req, res) => {
  if (!isUUID(req.params.id)) return res.status(400).json({ error: 'invalid id' });
  try {
    const bill = (await query(
      'SELECT * FROM delivery_sales_batches WHERE id=$1 AND shop_id=$2',
      [req.params.id, req.shopId]
    )).rows[0];
    if (!bill) return res.status(404).json({ error: 'not found' });

    // Items ordered by creation time; include staff name for audit history
    const items = (await query(
      `SELECT dsi.*,
              u.email AS staff_added_name
       FROM delivery_sales_items dsi
       LEFT JOIN users u ON u.id = dsi.staff_added_by
       WHERE dsi.batch_id=$1
       ORDER BY dsi.created_at ASC`,
      [req.params.id]
    )).rows;

    // Full movement audit: deduct + reverse, with reversed_at and reversal_of
    const movements = (await query(
      `SELECT dbsm.id, dbsm.operation_type, dbsm.item_id, dbsm.reversed_at,
              dbsm.reversal_of, dbsm.created_at,
              sm.ref_name, sm.kind, sm.delta, sm.created_at as moved_at
       FROM delivery_batch_stock_movements dbsm
       JOIN stock_movements sm ON sm.id = dbsm.stock_movement_id
       WHERE dbsm.batch_id=$1
       ORDER BY sm.created_at ASC`,
      [req.params.id]
    )).rows;

    res.json({ bill, items, movements });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/delivery/bill/:id/item — add item (deducts stock immediately in atomic tx)
router.post('/bill/:id/item', requirePerm('delivery_entry'), async (req, res) => {
  if (!isUUID(req.params.id)) return res.status(400).json({ error: 'invalid id' });
  const {
    menu_type, recipe_id, material_id, menu_name, quantity,
    unit_price = 0, discount_amount = 0, chosen_options = [],
    order_no, menu_code
  } = req.body || {};

  if (!['recipe','material'].includes(menu_type)) return res.status(400).json({ error: 'invalid menu_type' });
  if (menu_type === 'recipe'   && !isUUID(recipe_id))   return res.status(400).json({ error: 'recipe_id required' });
  if (menu_type === 'material' && !isUUID(material_id)) return res.status(400).json({ error: 'material_id required' });
  if (!(Number(quantity) > 0)) return res.status(400).json({ error: 'quantity must be positive' });
  if (!menu_name) return res.status(400).json({ error: 'menu_name required' });

  try {
    const out = await tx(async (c) => {
      const bill = (await c.query(
        'SELECT * FROM delivery_sales_batches WHERE id=$1 AND shop_id=$2 FOR UPDATE',
        [req.params.id, req.shopId]
      )).rows[0];
      if (!bill) { const e = new Error('not found'); e.statusCode = 404; throw e; }
      if (!EDITABLE_STATUSES.includes(bill.status)) {
        const e = new Error('BILL_NOT_EDITABLE'); e.statusCode = 409; throw e;
      }

      if (order_no) {
        const dup = (await c.query(
          'SELECT 1 FROM delivery_sales_items WHERE batch_id=$1 AND order_no=$2',
          [req.params.id, order_no]
        )).rowCount;
        if (dup) { const e = new Error('DUPLICATE_ORDER_NO'); e.statusCode = 409; throw e; }
      }

      const menuRef = menu_type === 'recipe' ? recipe_id : material_id;
      await engine.validateOptionsForLine(c, menu_type, menuRef, chosen_options);

      const qty  = Number(quantity);
      const price = Number(unit_price) || 0;
      const disc  = Number(discount_amount) || 0;
      const itemGross = qty * price;
      const itemNet   = itemGross - disc;

      const shopRow = (await c.query('SELECT make_to_order FROM shop_settings WHERE shop_id=$1', [req.shopId])).rows[0];
      const globalMTO = shopRow ? !!shopRow.make_to_order : false;
      const cats = await engine.loadCats(c);
      const note = `delivery bill:${req.params.id} item-add ${bill.platform} ${bill.sales_date || bill.sales_date_from}`;

      const movementLinks = [];
      let itemCogs = 0;

      if (menu_type === 'material') {
        const matRow = (await c.query('SELECT price, qty, conv_qty FROM materials WHERE id=$1 AND shop_id=$2', [material_id, req.shopId])).rows[0];
        const r = await engine.deductMaterial(c, req.shopId, req.userId, cats, material_id, qty, 'on_sale', note);
        if (r.mvId) movementLinks.push(r.mvId);
        if (matRow) {
          const pQty = Number(matRow.qty) || 1;
          const cQty = Number(matRow.conv_qty) || 1;
          itemCogs = pQty > 0 ? (Number(matRow.price) / (pQty * cQty)) * qty : 0;
        }
      } else {
        const rec = (await c.query(
          'SELECT id,name,fg_stock,yield_unit,inventory_mode FROM recipes WHERE id=$1 AND shop_id=$2 FOR UPDATE',
          [recipe_id, req.shopId]
        )).rows[0];
        if (!rec) {
          const gc = (await c.query('SELECT 1 FROM recipes WHERE id=$1', [recipe_id])).rowCount;
          const e = new Error(gc ? 'FORBIDDEN_RECIPE' : 'RECIPE_NOT_FOUND');
          e.statusCode = gc ? 403 : 404; throw e;
        }
        const invMode = rec.inventory_mode || 'inherit';
        const effectiveMode = invMode === 'inherit' ? (globalMTO ? 'make_to_order' : 'finished_goods') : invMode;

        if (effectiveMode !== 'non_stock') {
          if (effectiveMode === 'finished_goods') {
            const fg = Number(rec.fg_stock) || 0;
            if (fg < qty) {
              const e = new Error('FG_STOCK_INSUFFICIENT');
              e.statusCode = 409; e.recipeName = rec.name; e.have = fg; e.need = qty; throw e;
            }
            const r = await engine.deductRecipeFg(c, req.shopId, req.userId, rec, qty, 'on_sale', 'recipe_fg', note);
            if (r.mvId) movementLinks.push(r.mvId);
            const fgCostPerUnit = await engine.computeRecipeCostPerUnit(c, req.shopId, recipe_id);
            itemCogs = fgCostPerUnit * qty;
          } else {
            // make_to_order — deduct BOM, accumulate COGS
            const { bom, subs } = await engine.buildEffectiveBom(c, recipe_id, chosen_options);
            const matIds = [...bom.keys()];
            const matPrices = matIds.length
              ? (await c.query('SELECT id, price, qty, conv_qty FROM materials WHERE id=ANY($1::uuid[]) AND shop_id=$2', [matIds, req.shopId])).rows
              : [];
            // cost per base stock unit = purchase_price / (purchase_qty × conv_qty)
            const priceMap = Object.fromEntries(matPrices.map(p => {
              const purchaseQty = Number(p.qty)      || 1;
              const convQty     = Number(p.conv_qty) || 1;
              return [p.id, purchaseQty > 0 ? Number(p.price) / (purchaseQty * convQty) : 0];
            }));

            for (const [matId, entry] of bom) {
              const amt = entry.amount * qty;
              if (amt <= 0) continue;
              const r = await engine.deductMaterial(c, req.shopId, req.userId, cats, matId, amt, 'recipe_use', note);
              if (r.mvId) movementLinks.push(r.mvId);
              itemCogs += (priceMap[matId] || 0) * amt;
            }
            for (const s of subs) {
              const amt = s.amount * qty;
              if (amt <= 0) continue;
              const sub = (await c.query(
                'SELECT id,name,fg_stock,yield_unit FROM recipes WHERE id=$1 AND shop_id=$2 FOR UPDATE',
                [s.sub_recipe_id, req.shopId]
              )).rows[0];
              if (!sub) continue;
              const r = await engine.deductRecipeFg(c, req.shopId, req.userId, sub, amt, 'recipe_use', 'sub_recipe', note);
              if (r.mvId) movementLinks.push(r.mvId);
              const subCostPerUnit = await engine.computeRecipeCostPerUnit(c, req.shopId, s.sub_recipe_id);
              itemCogs += subCostPerUnit * amt;
            }
          }
        }
      }

      const costBreakdown = { type: menu_type, cogs: itemCogs };
      const itemRow = (await c.query(
        `INSERT INTO delivery_sales_items
           (batch_id, shop_id, menu_type, recipe_id, material_id, menu_code,
            menu_name, quantity, unit_price, gross_amount, discount_amount,
            chosen_options, cogs_amount, cost_breakdown, cost_calculated_at,
            order_no, staff_added_by, staff_added_name)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,now(),$15,$16,$17) RETURNING *`,
        [
          req.params.id, req.shopId, menu_type,
          menu_type === 'recipe'   ? recipe_id   : null,
          menu_type === 'material' ? material_id : null,
          menu_code || null, menu_name, qty, price, itemGross, disc,
          JSON.stringify(chosen_options), itemCogs, JSON.stringify(costBreakdown),
          order_no || null, req.userId, req.userName || null
        ]
      )).rows[0];

      for (const mvId of movementLinks) {
        await c.query(
          `INSERT INTO delivery_batch_stock_movements
             (batch_id, stock_movement_id, operation_type, item_id)
           VALUES ($1,$2,'deduct',$3) ON CONFLICT (batch_id, stock_movement_id) DO NOTHING`,
          [req.params.id, mvId, itemRow.id]
        );
      }

      const newGross = Number(bill.batch_item_gross) + itemGross;
      const newNet   = Number(bill.batch_item_net)   + itemNet;
      const newCogs  = Number(bill.cogs_total)        + itemCogs;
      await c.query(
        `UPDATE delivery_sales_batches
         SET batch_item_gross=$1, batch_item_net=$2, cogs_total=$3, gross_profit=$4,
             item_count=item_count+1, updated_at=now()
         WHERE id=$5`,
        [newGross, newNet, newCogs, newNet - newCogs, req.params.id]
      );

      return { item: itemRow, movement_count: movementLinks.length, bill_id: req.params.id };
    });
    res.status(201).json(out);
  } catch (e) {
    if (e.statusCode === 409) return res.status(409).json({ error: e.message, recipeName: e.recipeName, have: e.have, need: e.need });
    if (e.statusCode) return res.status(e.statusCode).json({ error: e.message });
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/delivery/bill/:id/item/:itemId — remove item, reverse its movements
router.delete('/bill/:id/item/:itemId', requirePerm('delivery_entry'), async (req, res) => {
  if (!isUUID(req.params.id) || !isUUID(req.params.itemId)) return res.status(400).json({ error: 'invalid id' });
  try {
    const out = await tx(async (c) => {
      const bill = (await c.query(
        'SELECT * FROM delivery_sales_batches WHERE id=$1 AND shop_id=$2 FOR UPDATE',
        [req.params.id, req.shopId]
      )).rows[0];
      if (!bill) { const e = new Error('not found'); e.statusCode = 404; throw e; }
      if (!EDITABLE_STATUSES.includes(bill.status)) {
        const e = new Error('BILL_NOT_EDITABLE'); e.statusCode = 409; throw e;
      }

      const item = (await c.query(
        'SELECT * FROM delivery_sales_items WHERE id=$1 AND batch_id=$2',
        [req.params.itemId, req.params.id]
      )).rows[0];
      if (!item) { const e = new Error('item not found'); e.statusCode = 404; throw e; }

      const deductLinks = (await c.query(
        `SELECT id, stock_movement_id FROM delivery_batch_stock_movements
         WHERE batch_id=$1 AND item_id=$2 AND operation_type='deduct' AND reversed_at IS NULL`,
        [req.params.id, req.params.itemId]
      )).rows;
      const deductIds = deductLinks.map(r => r.stock_movement_id);

      let reversal = { results: [] };
      if (deductIds.length) {
        const removeNote = `delivery item-remove bill:${req.params.id} item:${req.params.itemId}`;
        reversal = await engine.reverseMovements(c, req.shopId, req.userId, deductIds, removeNote);
        for (const r of reversal.results) {
          if (!r.mvId) continue;
          // Find which original stock_movement this reversal undoes (stock_movements.reversal_of)
          const revMvRow = (await c.query('SELECT reversal_of FROM stock_movements WHERE id=$1', [r.mvId])).rows[0];
          let origDbsmId = null;
          if (revMvRow?.reversal_of) {
            const origDbsm = deductLinks.find(d => d.stock_movement_id === revMvRow.reversal_of);
            origDbsmId = origDbsm?.id || null;
          }
          // Insert 'reverse' relation row with reversal_of pointing to original deduct row
          await c.query(
            `INSERT INTO delivery_batch_stock_movements
               (batch_id, stock_movement_id, operation_type, item_id, reversal_of)
             VALUES ($1,$2,'reverse',$3,$4)`,
            [req.params.id, r.mvId, req.params.itemId, origDbsmId]
          );
          // Mark original deduct as reversed — never delete it
          if (origDbsmId) {
            await c.query(
              'UPDATE delivery_batch_stock_movements SET reversed_at=now() WHERE id=$1',
              [origDbsmId]
            );
          }
        }
      }

      await c.query('DELETE FROM delivery_sales_items WHERE id=$1', [req.params.itemId]);

      const itemGross = Number(item.gross_amount) || 0;
      const itemNet   = itemGross - (Number(item.discount_amount) || 0);
      const itemCogs  = Number(item.cogs_amount) || 0;
      const newGross  = Math.max(0, Number(bill.batch_item_gross) - itemGross);
      const newNet    = Math.max(0, Number(bill.batch_item_net)   - itemNet);
      const newCogs   = Math.max(0, Number(bill.cogs_total)       - itemCogs);
      await c.query(
        `UPDATE delivery_sales_batches
         SET batch_item_gross=$1, batch_item_net=$2, cogs_total=$3, gross_profit=$4,
             item_count=GREATEST(0,item_count-1), updated_at=now()
         WHERE id=$5`,
        [newGross, newNet, newCogs, newNet - newCogs, req.params.id]
      );
      return { removed: true, reversed_movements: reversal.results.length };
    });
    res.json(out);
  } catch (e) {
    if (e.statusCode) return res.status(e.statusCode).json({ error: e.message });
    res.status(500).json({ error: e.message });
  }
});

// POST /api/delivery/bill/:id/close — OPEN/PENDING_REVIEW → AWAITING_SETTLEMENT
router.post('/bill/:id/close', requirePerm('delivery_settlement'), async (req, res) => {
  if (!isUUID(req.params.id)) return res.status(400).json({ error: 'invalid id' });
  const { to_pending } = req.body || {};
  try {
    const out = await tx(async (c) => {
      const bill = (await c.query(
        'SELECT status FROM delivery_sales_batches WHERE id=$1 AND shop_id=$2 FOR UPDATE',
        [req.params.id, req.shopId]
      )).rows[0];
      if (!bill) { const e = new Error('not found'); e.statusCode = 404; throw e; }
      if (to_pending) {
        if (bill.status !== 'open') { const e = new Error('BILL_NOT_OPEN'); e.statusCode = 409; throw e; }
        await c.query(
          `UPDATE delivery_sales_batches SET status='pending_review', updated_at=now() WHERE id=$1`,
          [req.params.id]
        );
        return { bill_id: req.params.id, status: 'pending_review' };
      }
      if (!['open','pending_review'].includes(bill.status)) {
        const e = new Error('BILL_NOT_CLOSEABLE'); e.statusCode = 409; throw e;
      }
      await c.query(
        `UPDATE delivery_sales_batches
         SET status='awaiting_settlement', closed_at=now(), closed_by=$1, updated_at=now()
         WHERE id=$2`,
        [req.userId, req.params.id]
      );
      return { bill_id: req.params.id, status: 'awaiting_settlement' };
    });
    res.json(out);
  } catch (e) {
    if (e.statusCode) return res.status(e.statusCode).json({ error: e.message });
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/delivery/bill/:id/settle — save settlement fees + bank deposit
router.patch('/bill/:id/settle', requirePerm('delivery_settlement'), async (req, res) => {
  if (!isUUID(req.params.id)) return res.status(400).json({ error: 'invalid id' });
  const {
    commission_amount = 0, promotion_fee = 0, advertising_fee = 0,
    vat_on_fee = 0, refund_amount = 0, withholding_tax = 0,
    merchant_discount_amount = 0, platform_discount_amount = 0,
    other_deduction = 0, other_adjustment = 0,
    actual_bank_deposit, bank_account, settlement_reference,
    settlement_date, settlement_note,
    platform_gross, platform_gross_reason
  } = req.body || {};

  try {
    const out = await tx(async (c) => {
      const bill = (await c.query(
        'SELECT * FROM delivery_sales_batches WHERE id=$1 AND shop_id=$2 FOR UPDATE',
        [req.params.id, req.shopId]
      )).rows[0];
      if (!bill) { const e = new Error('not found'); e.statusCode = 404; throw e; }
      if (!['awaiting_settlement','discrepancy','reconciled'].includes(bill.status)) {
        const e = new Error('BILL_NOT_SETTLEABLE'); e.statusCode = 409; throw e;
      }

      const baseNet  = Number(bill.batch_item_net) || 0;
      const comm     = Number(commission_amount) || 0;
      const promFee  = Number(promotion_fee) || 0;
      const advFee   = Number(advertising_fee) || 0;
      const vatFee   = Number(vat_on_fee) || 0;
      const refund   = Number(refund_amount) || 0;
      const wht      = Number(withholding_tax) || 0;
      const merDisc  = Number(merchant_discount_amount) || 0;
      const platDisc = Number(platform_discount_amount) || 0;
      const otherDed = Number(other_deduction) || 0;
      const otherAdj = Number(other_adjustment) || 0;

      const merchantNet  = baseNet - comm - merDisc - promFee - advFee - vatFee - refund - otherDed + otherAdj;
      const expectedCash = merchantNet - wht;
      const deposit  = actual_bank_deposit != null ? Number(actual_bank_deposit) : null;
      const variance = deposit != null ? deposit - expectedCash : null;

      let newStatus = bill.status;
      if (deposit != null) {
        newStatus = Math.abs(variance) <= 1 ? 'reconciled' : 'discrepancy';
      }

      const settleNow = deposit != null;
      const platGross = platform_gross != null ? Number(platform_gross) : null;
      const platVariance = platGross != null ? platGross - (Number(bill.batch_item_gross) || 0) : null;
      await c.query(
        `UPDATE delivery_sales_batches SET
           commission_amount=$1, promotion_fee=$2, advertising_fee=$3,
           vat_on_fee=$4, refund_amount=$5, withholding_tax=$6,
           merchant_discount_amount=$7, platform_discount_amount=$8,
           other_deduction=$9, other_adjustment=$10,
           actual_bank_deposit=$11, bank_account=$12, settlement_reference=$13,
           settlement_date=$14, settlement_note=$15,
           merchant_net=$16, expected_bank_cash=$17, settlement_variance=$18,
           status=$19, settled_by=$20,
           platform_gross=$22, platform_gross_variance=$23, platform_gross_reason=$24,
           ${settleNow ? 'settled_at=now(),' : ''}
           updated_at=now()
         WHERE id=$21`,
        [
          comm, promFee, advFee, vatFee, refund, wht, merDisc, platDisc,
          otherDed, otherAdj,
          deposit, bank_account || null, settlement_reference || null,
          settlement_date || null, settlement_note || null,
          merchantNet, expectedCash, variance,
          newStatus, settleNow ? req.userId : bill.settled_by,
          req.params.id,
          platGross, platVariance, platform_gross_reason || null
        ]
      );
      return { bill_id: req.params.id, status: newStatus, merchant_net: merchantNet, expected_bank_cash: expectedCash, settlement_variance: variance };
    });
    res.json(out);
  } catch (e) {
    if (e.statusCode) return res.status(e.statusCode).json({ error: e.message });
    res.status(500).json({ error: e.message });
  }
});

// POST /api/delivery/bill/:id/void — void daily bill + reverse all stock
router.post('/bill/:id/void', requirePerm('void_bill'), async (req, res) => {
  if (!isUUID(req.params.id)) return res.status(400).json({ error: 'invalid id' });
  const { reason } = req.body || {};
  try {
    const out = await tx(async (c) => {
      const bill = (await c.query(
        'SELECT * FROM delivery_sales_batches WHERE id=$1 AND shop_id=$2 FOR UPDATE',
        [req.params.id, req.shopId]
      )).rows[0];
      if (!bill) { const e = new Error('not found'); e.statusCode = 404; throw e; }
      if (bill.status === 'voided') return { voided: true, already: true };
      if (!ACTIVE_STATUSES.includes(bill.status)) {
        const e = new Error('BILL_NOT_VOIDABLE'); e.statusCode = 409; throw e;
      }

      // Only reverse movements not already reversed by item-delete (reversed_at IS NULL)
      const activeDeducts = (await c.query(
        `SELECT id, stock_movement_id FROM delivery_batch_stock_movements
         WHERE batch_id=$1 AND operation_type='deduct' AND reversed_at IS NULL`,
        [req.params.id]
      )).rows;
      const deductIds = activeDeducts.map(r => r.stock_movement_id);

      let reversal = { results: [] };
      if (deductIds.length) {
        const voidNote = `void delivery bill:${req.params.id} ${reason || ''}`.trim();
        reversal = await engine.reverseMovements(c, req.shopId, req.userId, deductIds, voidNote);
        for (const r of reversal.results) {
          if (!r.mvId) continue;
          // Find which original deduct link corresponds to this reversal
          const revMvRow = (await c.query('SELECT reversal_of FROM stock_movements WHERE id=$1', [r.mvId])).rows[0];
          let origDbsmId = null;
          if (revMvRow?.reversal_of) {
            const origDbsm = activeDeducts.find(d => d.stock_movement_id === revMvRow.reversal_of);
            origDbsmId = origDbsm?.id || null;
          }
          await c.query(
            `INSERT INTO delivery_batch_stock_movements
               (batch_id, stock_movement_id, operation_type, reversal_of)
             VALUES ($1,$2,'reverse',$3)`,
            [req.params.id, r.mvId, origDbsmId]
          );
          if (origDbsmId) {
            await c.query(
              'UPDATE delivery_batch_stock_movements SET reversed_at=now() WHERE id=$1',
              [origDbsmId]
            );
          }
        }
      }
      await c.query(
        `UPDATE delivery_sales_batches SET status='voided', updated_at=now() WHERE id=$1`,
        [req.params.id]
      );
      return { voided: true, already: false, reversed: reversal.results.length };
    });
    res.json(out);
  } catch (e) {
    if (e.statusCode) return res.status(e.statusCode).json({ error: e.message });
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
