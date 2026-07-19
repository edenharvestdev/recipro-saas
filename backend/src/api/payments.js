// Payment Platform API — Phase 7. Mounted at /api/payments, gated behind
// PAYMENT_PLATFORM_ENABLED==='1' (default OFF -> 503) at the app.js mount point, exactly like
// the existing DELIVERY_ENABLED precedent (backend/src/app.js).
//
// Every write path is permission-gated server-side (fail-closed 403) — frontend hiding is never
// the security boundary (existing doctrine, catalog.js). Payment status is NEVER settable from
// client input alone: CASH/STATIC_QR require an authenticated confirming actor; DYNAMIC_QR is
// confirmed only via the mock provider's signed webhook (backend/src/payments/service.js).
const express = require('express');
const { tx, query } = require('../db');
const { requirePerm } = require('../tenant');
const svc = require('../payments/service');
const router = express.Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUUID = (s) => typeof s === 'string' && UUID_RE.test(s);

function handleError(e, res) {
  if (e && e.statusCode) return res.status(e.statusCode).json({ error: e.message, code: e.code, ...Object.fromEntries(Object.entries(e).filter(([k]) => !['statusCode', 'message', 'code', 'stack'].includes(k))) });
  console.error('[payments]', e);
  return res.status(500).json({ error: (e && e.message) || 'internal error' });
}

// ── BILL (payment-platform Bill aggregate) ──

router.post('/bills', requirePerm('bill_create_draft'), async (req, res) => {
  try {
    const b = req.body || {};
    const out = await tx((c) => svc.createBill(c, {
      shopId: req.shopId, userId: req.userId, userName: req.userName,
      amountDue: b.amount_due, currency: b.currency, items: b.items,
    }));
    res.status(201).json(out);
  } catch (e) { handleError(e, res); }
});

router.post('/bills/:id/confirm', requirePerm('bill_confirm'), async (req, res) => {
  if (!isUUID(req.params.id)) return res.status(400).json({ error: 'invalid id' });
  try {
    const out = await tx((c) => svc.confirmBill(c, { shopId: req.shopId, userId: req.userId, userName: req.userName, billId: req.params.id }));
    res.status(out.already ? 200 : 201).json(out);
  } catch (e) { handleError(e, res); }
});

router.post('/bills/:id/void', requirePerm('void_bill'), async (req, res) => {
  if (!isUUID(req.params.id)) return res.status(400).json({ error: 'invalid id' });
  try {
    const b = req.body || {};
    const out = await tx((c) => svc.voidOrCancelBill(c, {
      shopId: req.shopId, userId: req.userId, userName: req.userName, billId: req.params.id,
      target: b.target === 'CANCELLED' ? 'CANCELLED' : 'VOIDED', reason: b.reason,
    }));
    res.json(out);
  } catch (e) { handleError(e, res); }
});

router.get('/bills/:id', requirePerm('billing_view'), async (req, res) => {
  if (!isUUID(req.params.id)) return res.status(400).json({ error: 'invalid id' });
  try {
    const bill = (await query('SELECT * FROM bills WHERE id=$1 AND shop_id=$2', [req.params.id, req.shopId])).rows[0];
    if (!bill) return res.status(404).json({ error: 'not found' });
    const intents = (await query('SELECT * FROM payment_intents WHERE bill_id=$1 ORDER BY created_at', [req.params.id])).rows;
    const transactions = (await query('SELECT * FROM payment_transactions WHERE bill_id=$1 ORDER BY created_at', [req.params.id])).rows;
    const allocations = (await query('SELECT * FROM payment_allocations WHERE bill_id=$1 ORDER BY created_at', [req.params.id])).rows;
    const receipts = (await query('SELECT * FROM receipts WHERE bill_id=$1 ORDER BY created_at', [req.params.id])).rows;
    res.json({ bill, intents, transactions, allocations, receipts });
  } catch (e) { handleError(e, res); }
});

// ── PAYMENT INTENTS ──

router.post('/intents', requirePerm('bill_confirm'), async (req, res) => {
  const b = req.body || {};
  if (!isUUID(b.bill_id)) return res.status(400).json({ error: 'bill_id required' });
  if (!['CASH', 'STATIC_QR', 'DYNAMIC_QR'].includes(b.method)) return res.status(400).json({ error: 'invalid method' });
  try {
    const out = await tx((c) => svc.createIntent(c, {
      shopId: req.shopId, userId: req.userId, billId: b.bill_id, method: b.method,
      amount: b.amount, currency: b.currency, idempotencyKey: b.idempotency_key, expiresInSec: b.expires_in_sec,
    }));
    res.status(out.already ? 200 : 201).json(out);
  } catch (e) { handleError(e, res); }
});

router.post('/intents/:id/cancel', requirePerm('bill_confirm'), async (req, res) => {
  if (!isUUID(req.params.id)) return res.status(400).json({ error: 'invalid id' });
  try {
    const out = await tx((c) => svc.cancelIntent(c, {
      shopId: req.shopId, userId: req.userId, userName: req.userName, intentId: req.params.id, reason: (req.body || {}).reason,
    }));
    if (out.expired) return res.status(409).json({ error: 'INTENT_EXPIRED', code: 'INTENT_EXPIRED', intent: out.intent });
    res.json(out);
  } catch (e) { handleError(e, res); }
});

// ── CASH ──

router.post('/intents/:id/cash-confirm', requirePerm('payment_cash_confirm'), async (req, res) => {
  if (!isUUID(req.params.id)) return res.status(400).json({ error: 'invalid id' });
  const b = req.body || {};
  try {
    const out = await tx((c) => svc.cashConfirm(c, {
      shopId: req.shopId, userId: req.userId, userName: req.userName, intentId: req.params.id,
      amountReceived: b.amount_received, terminalId: b.terminal_id, idempotencyKey: b.idempotency_key,
    }));
    if (out.expired) return res.status(409).json({ error: 'INTENT_EXPIRED', code: 'INTENT_EXPIRED', intent: out.intent });
    res.status(out.already ? 200 : 201).json(out);
  } catch (e) { handleError(e, res); }
});

// ── STATIC QR ──

router.post('/intents/:id/static-qr/display', requirePerm('bill_confirm'), async (req, res) => {
  if (!isUUID(req.params.id)) return res.status(400).json({ error: 'invalid id' });
  try {
    const out = await tx((c) => svc.staticQrDisplay(c, { shopId: req.shopId, userId: req.userId, intentId: req.params.id }));
    res.json(out);
  } catch (e) { handleError(e, res); }
});

router.post('/intents/:id/static-qr/confirm', requirePerm('payment_static_qr_confirm'), async (req, res) => {
  if (!isUUID(req.params.id)) return res.status(400).json({ error: 'invalid id' });
  const b = req.body || {};
  try {
    const out = await tx((c) => svc.staticQrConfirm(c, {
      shopId: req.shopId, userId: req.userId, userName: req.userName, intentId: req.params.id, slipRef: b.slip_ref,
    }));
    if (out.expired) return res.status(409).json({ error: 'INTENT_EXPIRED', code: 'INTENT_EXPIRED', intent: out.intent });
    res.status(out.already ? 200 : 201).json(out);
  } catch (e) { handleError(e, res); }
});

// A "customer says I paid" ping — deliberately NEVER changes any state. It exists only so a
// customer-facing screen has somewhere to send the signal; the response makes explicit that
// nothing was confirmed. This is the concrete anti-`confirmQrReceived()` contract (no permission
// required to hit it, and no permission check would matter — it is structurally a no-op).
router.post('/intents/:id/customer-paid-signal', async (req, res) => {
  if (!isUUID(req.params.id)) return res.status(400).json({ error: 'invalid id' });
  res.json({ acknowledged: true, note: 'customer signal recorded but does NOT confirm payment — a cashier/manager must manually confirm', state_changed: false });
});

// ── MOCK DYNAMIC-QR PROVIDER WEBHOOK ──
// No permission gate by design (real provider webhooks are unauthenticated over HTTP — the mock
// mirrors that), but every event is HMAC-verified before anything is trusted (mock-adapter.js).
// The exact signed byte string travels as a JSON string field (`raw_body`) rather than relying
// on Express raw-body middleware, because `app.js` already applies `express.json()` globally
// ahead of the `/api` mount — by the time a request reaches this router the original request
// stream is already consumed, so re-parsing "raw bytes" here would not byte-match what the mock
// adapter signed. Wrapping the exact signed string as a JSON field sidesteps that entirely
// (the mock adapter's `buildWebhookDelivery` and this handler agree on the same string).
router.post('/webhooks/mock', async (req, res) => {
  const b = req.body || {};
  // Tenant safety: ignore any client-supplied shop_id — always scope to the authenticated
  // caller's own shop (same doctrine as coupons.js/printers.js), even for this mock callback.
  try {
    const out = await tx((c) => svc.processProviderWebhook(c, {
      shopId: req.shopId, provider: 'MOCK', rawBody: b.raw_body, signature: b.signature,
    }));
    res.status(200).json(out);
  } catch (e) { handleError(e, res); }
});

// ── REFUNDS (model only) ──

router.post('/refunds', requirePerm('payment_refund_request'), async (req, res) => {
  const b = req.body || {};
  if (!isUUID(b.transaction_id)) return res.status(400).json({ error: 'transaction_id required' });
  try {
    const out = await tx((c) => svc.requestRefund(c, {
      shopId: req.shopId, userId: req.userId, userName: req.userName, transactionId: b.transaction_id, amount: b.amount, reason: b.reason,
    }));
    res.status(201).json(out);
  } catch (e) { handleError(e, res); }
});

router.post('/refunds/:id/approve', requirePerm('payment_refund_approve'), async (req, res) => {
  if (!isUUID(req.params.id)) return res.status(400).json({ error: 'invalid id' });
  try {
    const out = await tx((c) => svc.decideRefund(c, {
      shopId: req.shopId, userId: req.userId, userName: req.userName, refundId: req.params.id, approve: true, reason: (req.body || {}).reason,
    }));
    res.json(out);
  } catch (e) { handleError(e, res); }
});

router.post('/refunds/:id/reject', requirePerm('payment_refund_approve'), async (req, res) => {
  if (!isUUID(req.params.id)) return res.status(400).json({ error: 'invalid id' });
  try {
    const out = await tx((c) => svc.decideRefund(c, {
      shopId: req.shopId, userId: req.userId, userName: req.userName, refundId: req.params.id, approve: false, reason: (req.body || {}).reason,
    }));
    res.json(out);
  } catch (e) { handleError(e, res); }
});

router.post('/transactions/:id/reverse', requirePerm('payment_refund_approve'), async (req, res) => {
  if (!isUUID(req.params.id)) return res.status(400).json({ error: 'invalid id' });
  try {
    const out = await tx((c) => svc.reverseTransaction(c, {
      shopId: req.shopId, userId: req.userId, userName: req.userName, transactionId: req.params.id, reason: (req.body || {}).reason,
    }));
    res.json(out);
  } catch (e) { handleError(e, res); }
});

// ── RECONCILIATION (data-contract-only per F.13; manual flag/resolve) ──

router.post('/reconciliation/:transactionId/flag', requirePerm('reconciliation_view'), async (req, res) => {
  if (!isUUID(req.params.transactionId)) return res.status(400).json({ error: 'invalid id' });
  const b = req.body || {};
  try {
    const out = await tx((c) => svc.flagReconciliation(c, {
      shopId: req.shopId, userId: req.userId, userName: req.userName, transactionId: req.params.transactionId,
      status: b.status || 'AMOUNT_MISMATCH', notes: b.notes,
      expectedAmount: b.expected_amount, providerAmount: b.provider_amount, settlementAmount: b.settlement_amount,
    }));
    res.status(201).json(out);
  } catch (e) { handleError(e, res); }
});

router.post('/reconciliation/:recordId/resolve', requirePerm('reconciliation_resolve'), async (req, res) => {
  if (!isUUID(req.params.recordId)) return res.status(400).json({ error: 'invalid id' });
  try {
    const out = await tx((c) => svc.resolveReconciliation(c, {
      shopId: req.shopId, userId: req.userId, userName: req.userName, recordId: req.params.recordId, notes: (req.body || {}).notes,
    }));
    res.json(out);
  } catch (e) { handleError(e, res); }
});

// ── ONLINE ORDER MOCK FLOW (test/demo harness — touches nothing real) ──

router.post('/online-orders/mock-submit', requirePerm('bill_create_draft'), async (req, res) => {
  const b = req.body || {};
  try {
    const out = await tx((c) => svc.runOnlineOrderMockFlow(c, {
      shopId: req.shopId, userId: req.userId, userName: req.userName,
      amountDue: b.amount_due, currency: b.currency, simulate: b.simulate,
    }));
    res.status(201).json(out);
  } catch (e) { handleError(e, res); }
});

// ── DASHBOARD READ API (permission-gated; NOT the dashboard UI — that is a separate branch) ──

router.get('/dashboard', requirePerm('billing_view'), async (req, res) => {
  try {
    const f = req.query || {};
    const clauses = ['b.shop_id = $1'];
    const params = [req.shopId];
    let n = 1;
    if (f.status) { n++; clauses.push(`t.status = $${n}`); params.push(f.status); }
    if (f.method) { n++; clauses.push(`t.method = $${n}`); params.push(f.method); }
    if (f.bill_id && isUUID(f.bill_id)) { n++; clauses.push(`b.id = $${n}`); params.push(f.bill_id); }
    if (f.order_id && isUUID(f.order_id)) { n++; clauses.push(`b.order_id = $${n}`); params.push(f.order_id); }
    if (f.date_from) { n++; clauses.push(`t.created_at >= $${n}`); params.push(f.date_from); }
    if (f.date_to) { n++; clauses.push(`t.created_at <= $${n}`); params.push(f.date_to); }
    if (f.manual_review === '1') { clauses.push(`t.reconciliation_status IS NOT NULL AND t.reconciliation_status <> 'MATCHED'`); }

    const rows = (await query(
      `SELECT b.id AS bill_id, b.number AS bill_no, b.amount_due_satang AS amount_satang, b.paid_state, b.payment_state,
              t.id AS transaction_id, t.method, t.provider, t.status AS transaction_status,
              i.status AS intent_status, t.reconciliation_status,
              b.created_at AS bill_created_at, t.confirmed_at, i.expires_at,
              t.confirmed_by, t.provider_txn_id,
              (t.paid_amount_satang IS NOT NULL AND t.expected_amount_satang IS NOT NULL AND
               t.paid_amount_satang = t.expected_amount_satang) AS amount_matches,
              (t.reconciliation_status IS NOT NULL AND t.reconciliation_status <> 'MATCHED') AS manual_review_flag
         FROM bills b
         LEFT JOIN payment_transactions t ON t.bill_id = b.id
         LEFT JOIN payment_intents i ON i.id = t.intent_id
        WHERE ${clauses.join(' AND ')}
        ORDER BY b.created_at DESC LIMIT 200`,
      params
    )).rows;
    res.json({ rows });
  } catch (e) { handleError(e, res); }
});

module.exports = router;
