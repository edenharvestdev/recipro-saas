// Track B import — create 8 aggregate Delivery DRAFTS (draft-only, no stock/financial side effects).
// Reads staged-lines.json. Per draft: one transaction → idempotency recheck → shop-ID validation →
// INSERT batch(status='draft', stock_deducted=false) → INSERT items(stock_mode='HOLD_FOR_REVIEW',
// unit_price 0) → in-tx post-verify → COMMIT (only if env COMMIT=1) else ROLLBACK (dry-run).
// No stock movements, no confirm, no settlement, no COGS/revenue. Idempotent via unique
// (shop_id, client_request_id). Connects via DATABASE_PUBLIC_URL.
const fs = require('fs');
const { Pool } = require('pg');
const DIR = __dirname;
const DO_COMMIT = process.env.COMMIT === '1';
const data = JSON.parse(fs.readFileSync(DIR + '/staged-lines.json', 'utf8'));
const NOTE_BASE = 'AGGREGATE HISTORICAL DELIVERY — 22–30 JUNE 2026 | ยอดรวมสะสมช่วง 22–30 มิถุนายน 2026 จากรายงาน Platform | FINANCIAL_TOTALS_PENDING | UNRESOLVED_ITEMS_EXCLUDED_FOR_REVIEW | STOCK_MODE_PENDING_FOUNDER_REVIEW';
const pool = new Pool({ connectionString: process.env.DATABASE_PUBLIC_URL, ssl: { rejectUnauthorized: false } });

async function createDraft(c, d) {
  await c.query('BEGIN');
  try {
    // 1) idempotency / overlap recheck INSIDE the tx
    const dup = await c.query(
      `select id, status from delivery_sales_batches where shop_id=$1 and client_request_id=$2`, [d.shopId, d.client_request_id]);
    if (dup.rowCount) { await c.query('ROLLBACK'); return { shop: d.shop, platform: d.platform, result: 'EXISTING_DRAFT_FOUND', batch_id: dup.rows[0].id }; }
    const overlap = await c.query(
      `select count(*)::int n from delivery_sales_batches where shop_id=$1 and platform=$2 and status<>'voided'
         and sales_date_from<=$4::date and sales_date_to>=$3::date`, [d.shopId, d.platform, d.sales_date_from, d.sales_date_to]);
    if (overlap.rows[0].n > 0) { await c.query('ROLLBACK'); return { shop: d.shop, platform: d.platform, result: 'OVERLAP_BLOCKED', note: overlap.rows[0].n + ' overlapping non-void batch(es)' }; }

    // 2) validate every line ref_id belongs to THIS shop (never cross-branch)
    const recIds = d.lines.filter(l => l.menu_type === 'recipe').map(l => l.ref_id);
    const matIds = d.lines.filter(l => l.menu_type === 'material').map(l => l.ref_id);
    const recOk = recIds.length ? (await c.query(`select count(*)::int n from recipes where id = any($1::uuid[]) and shop_id=$2`, [recIds, d.shopId])).rows[0].n : 0;
    const matOk = matIds.length ? (await c.query(`select count(*)::int n from materials where id = any($1::uuid[]) and shop_id=$2`, [matIds, d.shopId])).rows[0].n : 0;
    if (recOk !== recIds.length || matOk !== matIds.length) {
      await c.query('ROLLBACK');
      return { shop: d.shop, platform: d.platform, result: 'BLOCKER_SHOP_ID_MISMATCH', note: `recipes ${recOk}/${recIds.length}, materials ${matOk}/${matIds.length}` };
    }

    const units = d.lines.reduce((s, l) => s + l.quantity, 0);
    // 3) INSERT batch (draft, no stock, no financials)
    const b = (await c.query(
      `insert into delivery_sales_batches
         (shop_id, platform, sales_date_from, sales_date_to, mode, status, source_type, stock_deducted,
          client_request_id, variance_note, item_count, order_count, gross_sales)
       values ($1,$2,$3,$4,'stock_aware','draft','manual',false,$5,$6,$7,0,0) returning id`,
      [d.shopId, d.platform, d.sales_date_from, d.sales_date_to, d.client_request_id, NOTE_BASE + ' | src_sheet=' + d.sheet, units])).rows[0];

    // 4) INSERT item lines (stock_mode HOLD_FOR_REVIEW, price 0)
    for (const l of d.lines) {
      await c.query(
        `insert into delivery_sales_items
           (batch_id, shop_id, menu_type, recipe_id, material_id, menu_code, menu_name, quantity,
            unit_price, gross_amount, discount_amount, stock_mode)
         values ($1,$2,$3,$4,$5,$6,$7,$8,0,0,0,'HOLD_FOR_REVIEW')`,
        [b.id, d.shopId, l.menu_type, l.menu_type === 'recipe' ? l.ref_id : null,
         l.menu_type === 'material' ? l.ref_id : null, l.menu_code || null, l.menu_name, l.quantity]);
    }

    // 5) in-tx POST-VERIFY
    const vb = (await c.query(`select status, stock_deducted, mode, item_count, gross_sales from delivery_sales_batches where id=$1`, [b.id])).rows[0];
    const vi = (await c.query(`select count(*)::int lines, coalesce(sum(quantity),0)::int units, count(*) filter (where stock_mode<>'HOLD_FOR_REVIEW')::int badmode, count(*) filter (where unit_price<>0 or gross_amount<>0)::int priced from delivery_sales_items where batch_id=$1`, [b.id])).rows[0];
    const mv = (await c.query(`select count(*)::int n from delivery_batch_stock_movements where batch_id=$1`, [b.id])).rows[0].n;
    const okState = vb.status === 'draft' && vb.stock_deducted === false && vi.lines === d.lines.length && vi.units === units && vi.badmode === 0 && vi.priced === 0 && mv === 0;
    if (!okState) { await c.query('ROLLBACK'); return { shop: d.shop, platform: d.platform, result: 'BLOCKER_VERIFY_FAILED', vb, vi, mv }; }

    if (DO_COMMIT) { await c.query('COMMIT'); return { shop: d.shop, platform: d.platform, result: 'CREATED', batch_id: b.id, lines: vi.lines, units: vi.units, status: vb.status, stock_deducted: vb.stock_deducted, stock_movements: mv }; }
    await c.query('ROLLBACK');
    return { shop: d.shop, platform: d.platform, result: 'DRY_RUN_OK', would_lines: vi.lines, would_units: vi.units, status: vb.status, stock_deducted: vb.stock_deducted, stock_movements: mv };
  } catch (e) { try { await c.query('ROLLBACK'); } catch (_) {} return { shop: d.shop, platform: d.platform, result: 'ERROR', error: e.message }; }
}

(async () => {
  const c = await pool.connect();
  const results = [];
  try {
    for (const d of data.drafts) results.push(await createDraft(c, d));
  } finally { c.release(); await pool.end(); }
  console.log(JSON.stringify({ mode: DO_COMMIT ? 'COMMIT' : 'DRY_RUN', results }, null, 1));
})();
