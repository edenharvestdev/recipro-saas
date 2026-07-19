// Payment-platform business logic — Phase 7. Everything here runs ONLY when
// PAYMENT_PLATFORM_ENABLED === '1' (enforced at the router level, backend/src/api/payments.js).
// Mock-only: zero live providers, zero external network, zero real credentials.
//
// Core doctrine (binding, from the Founder brief):
//   - BILL_CONFIRMED != PAYMENT_CONFIRMED. Confirming a bill never marks it paid; payment is a
//     fully separate, server-authoritative state machine (backend/src/payments/state-machine.js).
//   - Payment is NEVER confirmable from client input alone: CASH requires an authenticated
//     cashier action; STATIC_QR requires an authenticated manual-confirm action; DYNAMIC_QR is
//     confirmed ONLY by a verified (HMAC) provider webhook or a server-to-provider status poll —
//     never by any client-supplied "I paid" signal.
//   - Stock is untouched by this module entirely — this platform's Bill is a payment/money
//     aggregate, not a stock-deduction aggregate (stock deduction is bills.js's existing,
//     untouched concern).
const { tx } = require('../db');
const { assertTransition } = require('./state-machine');
const { writeAllocation, billAmountDue, activeAllocationTotals } = require('./allocations');
const { auditLog } = require('./audit');
const { getAdapter } = require('./provider-registry');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUUID = (s) => typeof s === 'string' && UUID_RE.test(s);

class ServiceError extends Error {
  constructor(code, statusCode, message, extra) {
    super(message || code);
    this.code = code;
    this.statusCode = statusCode || 400;
    Object.assign(this, extra || {});
  }
}

function err(code, statusCode, message, extra) { throw new ServiceError(code, statusCode, message, extra); }

async function nextBillNumber(c, shopId) {
  const n = (await c.query('SELECT count(*)::int c FROM bills WHERE shop_id=$1 AND number IS NOT NULL', [shopId])).rows[0].c;
  const d = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return 'PB' + d + '-' + String(n + 1).padStart(4, '0');
}

async function lockBill(c, shopId, billId) {
  const bill = (await c.query('SELECT * FROM bills WHERE id=$1 AND shop_id=$2 FOR UPDATE', [billId, shopId])).rows[0];
  if (!bill) err('BILL_NOT_FOUND', 404);
  return bill;
}

async function lockIntent(c, shopId, intentId) {
  const intent = (await c.query('SELECT * FROM payment_intents WHERE id=$1 AND shop_id=$2 FOR UPDATE', [intentId, shopId])).rows[0];
  if (!intent) err('INTENT_NOT_FOUND', 404);
  return intent;
}

// ── BILL (payment-platform Bill aggregate: DRAFT -> CONFIRMED -> (VOIDED | CANCELLED)) ──

async function createBill(c, { shopId, userId, userName, amountDue, currency, items }) {
  const amt = Number(amountDue);
  if (!(amt > 0)) err('AMOUNT_DUE_INVALID', 400, 'amount_due must be > 0');
  const billId = (await c.query(
    `INSERT INTO bills (shop_id, doc_type, items_json, lifecycle_status, status, gross_sales, net_sales,
           discount, business_date, created_by, updated_by)
     VALUES ($1,'sale',$2,'DRAFT','wait',$3,$3,0,CURRENT_DATE,$4,$4) RETURNING id`,
    [shopId, JSON.stringify(items || []), amt, userId]
  )).rows[0].id;
  await auditLog(c, shopId, userId, userName, billId, 'BILL_CREATED', null, { amount_due: amt, currency: currency || 'THB' });
  const bill = (await c.query('SELECT * FROM bills WHERE id=$1', [billId])).rows[0];
  return { bill };
}

async function confirmBill(c, { shopId, userId, userName, billId }) {
  const bill = await lockBill(c, shopId, billId);
  if (bill.lifecycle_status === 'CONFIRMED') return { bill, already: true };
  assertTransition('BILL', bill.lifecycle_status, 'CONFIRMED');
  const number = await nextBillNumber(c, shopId);
  await c.query(
    `UPDATE bills SET lifecycle_status='CONFIRMED', number=$1, payment_state='AWAITING_PAYMENT',
           paid_state='UNPAID', confirmed_at=now(), updated_by=$2 WHERE id=$3`,
    [number, userId, billId]
  );
  // NOTE: this deliberately does NOT set status='paid' — that welding is exactly what the
  // Founder brief requires removing. Payment confirmation is a fully separate event below.
  await auditLog(c, shopId, userId, userName, billId, 'BILL_CONFIRMED', null, { number, amount_due: billAmountDue(bill) });
  const out = (await c.query('SELECT * FROM bills WHERE id=$1', [billId])).rows[0];
  return { bill: out, already: false };
}

async function voidOrCancelBill(c, { shopId, userId, userName, billId, target, reason }) {
  const bill = await lockBill(c, shopId, billId);
  const dest = target === 'CANCELLED' ? 'CANCELLED' : 'VOIDED';
  if (bill.lifecycle_status === dest) return { bill, already: true };
  assertTransition('BILL', bill.lifecycle_status, dest);
  await c.query(`UPDATE bills SET lifecycle_status=$1, voided_by=$2, voided_at=now() WHERE id=$3`, [dest, userId, billId]);
  await auditLog(c, shopId, userId, userName, billId, dest === 'CANCELLED' ? 'BILL_CANCELLED' : 'BILL_VOIDED', reason || null, {});
  const out = (await c.query('SELECT * FROM bills WHERE id=$1', [billId])).rows[0];
  return { bill: out, already: false };
}

// ── PAYMENT INTENT ──

async function createIntent(c, { shopId, userId, billId, method, amount, currency, idempotencyKey, expiresInSec }) {
  const bill = await lockBill(c, shopId, billId);
  if (bill.lifecycle_status !== 'CONFIRMED') err('BILL_NOT_CONFIRMED', 409, 'a payment intent requires a CONFIRMED bill');

  // Idempotent create: same (shop, provider, idempotency_key) returns the existing intent.
  const provider = method === 'CASH' ? 'NONE' : 'MOCK';
  if (idempotencyKey) {
    const existing = (await c.query(
      `SELECT * FROM payment_intents WHERE shop_id=$1 AND provider=$2 AND idempotency_key=$3`,
      [shopId, provider, idempotencyKey]
    )).rows[0];
    if (existing) return { intent: existing, already: true };
  }

  const amountDue = billAmountDue(bill);
  const { net } = await activeAllocationTotals(c, shopId, billId);
  const remaining = amountDue - net;
  if (remaining <= 0.005) err('BILL_ALREADY_FULLY_PAID', 409, 'bill has no remaining balance to pay');
  const intentAmount = amount != null ? Number(amount) : remaining;
  if (!(intentAmount > 0)) err('INTENT_AMOUNT_INVALID', 400);
  if (intentAmount > remaining + 0.005) err('INTENT_AMOUNT_EXCEEDS_REMAINING', 409, null, { remaining, requested: intentAmount });

  const merchantReference = 'MREF-' + billId.slice(0, 8) + '-' + Date.now();
  let providerRef = null;
  let status = 'AWAITING_PAYMENT';
  let expiresAt = expiresInSec ? new Date(Date.now() + expiresInSec * 1000).toISOString() : null;

  if (method === 'DYNAMIC_QR') {
    const adapter = getAdapter('MOCK');
    const created = await adapter.createPaymentIntent({
      amount: intentAmount, currency: currency || 'THB', merchantReference,
      expiresAt: expiresAt || new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    });
    providerRef = created.providerTxnId;
    status = 'INITIATED';
    expiresAt = created.expiresAt;
  }

  const intent = (await c.query(
    `INSERT INTO payment_intents (shop_id, bill_id, method, provider, status, amount_due, currency,
           merchant_reference, provider_ref, idempotency_key, expires_at, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
    [shopId, billId, method, provider, status, intentAmount, currency || 'THB',
     merchantReference, providerRef, idempotencyKey || null, expiresAt, userId]
  )).rows[0];

  await auditLog(c, shopId, userId, null, billId, 'PAYMENT_INTENT_CREATED', null,
    { intent_id: intent.id, method, amount: intentAmount });
  return { intent, already: false };
}

async function lazyExpireIfDue(c, shopId, userId, intent) {
  if (!intent.expires_at) return intent;
  const isTerminalState = ['CONFIRMED', 'FAILED', 'EXPIRED', 'CANCELLED'].includes(intent.status);
  if (isTerminalState) return intent;
  if (new Date(intent.expires_at).getTime() > Date.now()) return intent;
  assertTransition('INTENT', intent.status, 'EXPIRED');
  await c.query(`UPDATE payment_intents SET status='EXPIRED', updated_at=now() WHERE id=$1`, [intent.id]);
  await auditLog(c, shopId, userId || null, null, intent.bill_id, 'PAYMENT_EXPIRED', null, { intent_id: intent.id });
  return { ...intent, status: 'EXPIRED' };
}

async function cancelIntent(c, { shopId, userId, userName, intentId, reason }) {
  let intent = await lockIntent(c, shopId, intentId);
  intent = await lazyExpireIfDue(c, shopId, userId, intent);
  if (intent.status === 'CANCELLED') return { intent, already: true };
  assertTransition('INTENT', intent.status, 'CANCELLED');
  await c.query(`UPDATE payment_intents SET status='CANCELLED', cancelled_at=now(), cancel_reason=$1, updated_at=now() WHERE id=$2`,
    [reason || null, intentId]);
  await auditLog(c, shopId, userId, userName, intent.bill_id, 'PAYMENT_CANCELLED', reason || null, { intent_id: intentId });
  const out = (await c.query('SELECT * FROM payment_intents WHERE id=$1', [intentId])).rows[0];
  return { intent: out, already: false };
}

// ── CASH ──

async function cashConfirm(c, { shopId, userId, userName, intentId, amountReceived, terminalId, idempotencyKey }) {
  let intent = await lockIntent(c, shopId, intentId);
  intent = await lazyExpireIfDue(c, shopId, userId, intent);
  if (intent.method !== 'CASH') err('INTENT_METHOD_MISMATCH', 400);

  // Idempotent duplicate: same (shop, provider=NONE, idempotency_key) already confirmed.
  if (idempotencyKey) {
    const existingTxn = (await c.query(
      `SELECT * FROM payment_transactions WHERE shop_id=$1 AND provider='NONE' AND idempotency_key=$2`,
      [shopId, idempotencyKey]
    )).rows[0];
    if (existingTxn) return { transaction: existingTxn, already: true };
  }

  if (intent.status === 'AWAITING_PAYMENT') assertTransition('INTENT', 'AWAITING_PAYMENT', 'CONFIRMED');
  else assertTransition('INTENT', intent.status, 'CONFIRMED');

  const bill = await lockBill(c, shopId, intent.bill_id);
  const amountDue = billAmountDue(bill);
  const allocationAmount = Number(intent.amount_due);
  const received = Number(amountReceived);
  if (!(received >= allocationAmount - 0.005)) {
    err('CASH_RECEIVED_INSUFFICIENT', 400, 'amount received is less than the amount due for this intent',
      { due: allocationAmount, received });
  }
  const changeAmount = Math.max(0, received - allocationAmount);

  const txn = (await c.query(
    `INSERT INTO payment_transactions (shop_id, bill_id, intent_id, method, provider, expected_amount,
           paid_amount, currency, status, merchant_ref, idempotency_key, confirmed_at, confirmed_by,
           cashier_id, terminal_id, amount_received, change_amount, provider_verified)
     VALUES ($1,$2,$3,'CASH','NONE',$4,$4,$5,'CONFIRMED',$6,$7,now(),$8,$9,$10,$11,$12,false)
     RETURNING *`,
    [shopId, intent.bill_id, intentId, allocationAmount, intent.currency, intent.merchant_reference,
     idempotencyKey || null, String(userId), userId, terminalId || null, received, changeAmount]
  )).rows[0];

  const { paidState } = await writeAllocation(c, {
    shopId, billId: intent.bill_id, transactionId: txn.id, kind: 'PAYMENT',
    amount: allocationAmount, actorId: userId, amountDue,
  });

  await c.query(`UPDATE payment_intents SET status='CONFIRMED', updated_at=now() WHERE id=$1`, [intentId]);
  await auditLog(c, shopId, userId, userName, intent.bill_id, 'CASH_PAYMENT_CONFIRMED', null,
    { transaction_id: txn.id, amount: allocationAmount, received, change: changeAmount, paid_state: paidState });

  const receipt = await issueReceipt(c, { shopId, userId, userName, billId: intent.bill_id, transactionId: txn.id });

  return { transaction: txn, paid_state: paidState, change_amount: changeAmount, receipt, already: false };
}

// ── STATIC QR ──

async function staticQrDisplay(c, { shopId, userId, intentId }) {
  let intent = await lockIntent(c, shopId, intentId);
  if (intent.method !== 'STATIC_QR') err('INTENT_METHOD_MISMATCH', 400);
  if (intent.status === 'QR_DISPLAYED' || intent.status === 'AWAITING_MANUAL_CONFIRMATION') return { intent, already: true };
  assertTransition('INTENT', intent.status, 'QR_DISPLAYED');
  await c.query(`UPDATE payment_intents SET status='QR_DISPLAYED', updated_at=now() WHERE id=$1`, [intentId]);
  await auditLog(c, shopId, userId, null, intent.bill_id, 'STATIC_QR_DISPLAYED', null, { intent_id: intentId });
  const out = (await c.query('SELECT * FROM payment_intents WHERE id=$1', [intentId])).rows[0];
  return { intent: out, already: false };
}

// Displaying a QR NEVER auto-confirms. A "customer says paid" signal is explicitly NOT a valid
// confirming actor — the only path into CONFIRMED for STATIC_QR is this function, gated at the
// router level behind the `payment_static_qr_confirm` permission (a customer holds no permission
// at all, so they structurally cannot reach this code path).
async function staticQrConfirm(c, { shopId, userId, userName, intentId, slipRef }) {
  let intent = await lockIntent(c, shopId, intentId);
  intent = await lazyExpireIfDue(c, shopId, userId, intent);
  if (intent.method !== 'STATIC_QR') err('INTENT_METHOD_MISMATCH', 400);

  // Move display -> awaiting-manual-confirmation -> confirmed if needed (auto-advance the
  // intermediate step for a cashier who confirms directly from AWAITING_PAYMENT/QR_DISPLAYED).
  if (intent.status === 'AWAITING_PAYMENT' || intent.status === 'QR_DISPLAYED') {
    assertTransition('INTENT', intent.status, intent.status === 'AWAITING_PAYMENT' ? 'QR_DISPLAYED' : 'AWAITING_MANUAL_CONFIRMATION');
    intent = { ...intent, status: intent.status === 'AWAITING_PAYMENT' ? 'QR_DISPLAYED' : 'AWAITING_MANUAL_CONFIRMATION' };
  }
  if (intent.status === 'QR_DISPLAYED') {
    assertTransition('INTENT', 'QR_DISPLAYED', 'AWAITING_MANUAL_CONFIRMATION');
    intent = { ...intent, status: 'AWAITING_MANUAL_CONFIRMATION' };
  }
  assertTransition('INTENT', intent.status, 'CONFIRMED');

  const bill = await lockBill(c, shopId, intent.bill_id);
  const amountDue = billAmountDue(bill);
  const allocationAmount = Number(intent.amount_due);

  const txn = (await c.query(
    `INSERT INTO payment_transactions (shop_id, bill_id, intent_id, method, provider, expected_amount,
           paid_amount, currency, status, merchant_ref, confirmed_at, confirmed_by, slip_ref, provider_verified)
     VALUES ($1,$2,$3,'STATIC_QR','NONE',$4,$4,$5,'CONFIRMED',$6,now(),$7,$8,false)
     RETURNING *`,
    [shopId, intent.bill_id, intentId, allocationAmount, intent.currency, intent.merchant_reference, String(userId), slipRef || null]
  )).rows[0];

  const { paidState } = await writeAllocation(c, {
    shopId, billId: intent.bill_id, transactionId: txn.id, kind: 'PAYMENT',
    amount: allocationAmount, actorId: userId, amountDue,
  });

  await c.query(`UPDATE payment_intents SET status='CONFIRMED', updated_at=now() WHERE id=$1`, [intentId]);
  await auditLog(c, shopId, userId, userName, intent.bill_id, 'STATIC_QR_MANUALLY_CONFIRMED', null,
    { transaction_id: txn.id, amount: allocationAmount, confirmed_by: userId, paid_state: paidState });

  const receipt = await issueReceipt(c, { shopId, userId, userName, billId: intent.bill_id, transactionId: txn.id });

  return { transaction: txn, paid_state: paidState, receipt, already: false };
}

// ── DYNAMIC QR / MOCK PROVIDER WEBHOOK ──

// Processes one inbound (mock) provider webhook delivery. Fully idempotent via the
// (provider, event_id) unique index on payment_provider_events — a replay is a DB-level no-op.
async function processProviderWebhook(c, { shopId, provider, rawBody, signature }) {
  const adapter = getAdapter(provider);
  const verified = await adapter.verifyWebhook({ rawBody, signature });

  if (!verified.valid) {
    err('WEBHOOK_SIGNATURE_INVALID', 401);
  }

  // Dedupe at the DB layer FIRST — a duplicate delivery must never re-run handler logic.
  const eventInsert = await c.query(
    `INSERT INTO payment_provider_events (shop_id, provider, event_id, signature_valid, payload, processed_at)
     VALUES ($1,$2,$3,true,$4,now())
     ON CONFLICT (provider, event_id) DO NOTHING RETURNING id`,
    [shopId, provider, verified.eventId, JSON.stringify(verified)]
  );
  if (eventInsert.rows.length === 0) {
    return { duplicate: true };
  }
  const eventRow = eventInsert.rows[0];

  const intent = (await c.query(
    `SELECT * FROM payment_intents WHERE shop_id=$1 AND provider=$2 AND provider_ref=$3 FOR UPDATE`,
    [shopId, provider, verified.providerTxnId]
  )).rows[0];
  if (!intent) {
    // Ownership/ referential-integrity failure: a callback for a txn this shop never created.
    return { duplicate: false, matched: false };
  }

  const bill = await lockBill(c, shopId, intent.bill_id);
  const amountDue = billAmountDue(bill);

  if (verified.status !== 'SUCCESS') {
    if (intent.status !== 'FAILED' && intent.status !== 'EXPIRED' && intent.status !== 'CANCELLED') {
      assertTransition('INTENT', intent.status, 'FAILED');
      await c.query(`UPDATE payment_intents SET status='FAILED', updated_at=now() WHERE id=$1`, [intent.id]);
    }
    return { duplicate: false, matched: true, outcome: 'FAILED' };
  }

  const amountMatches = Math.abs(Number(verified.amount) - Number(intent.amount_due)) <= 0.005;
  const currencyMatches = (verified.currency || 'THB') === intent.currency;

  if (!amountMatches || !currencyMatches) {
    const dest = 'VERIFICATION_PENDING';
    if (intent.status !== dest) {
      assertTransition('INTENT', intent.status, dest);
      await c.query(`UPDATE payment_intents SET status=$1, updated_at=now() WHERE id=$2`, [dest, intent.id]);
    }
    await auditLog(c, shopId, null, null, intent.bill_id, 'PAYMENT_CONFIRMATION_REJECTED',
      amountMatches ? 'CURRENCY_MISMATCH' : 'AMOUNT_MISMATCH',
      { intent_id: intent.id, expected_amount: intent.amount_due, got_amount: verified.amount, expected_currency: intent.currency, got_currency: verified.currency });
    return { duplicate: false, matched: true, outcome: 'VERIFICATION_PENDING' };
  }

  assertTransition('INTENT', intent.status, 'CONFIRMED');
  const txn = (await c.query(
    `INSERT INTO payment_transactions (shop_id, bill_id, intent_id, method, provider, expected_amount,
           paid_amount, currency, status, provider_txn_id, merchant_ref, confirmed_at, confirmed_by,
           raw_event_ref, provider_verified)
     VALUES ($1,$2,$3,'DYNAMIC_QR',$4,$5,$5,$6,'CONFIRMED',$7,$8,now(),$9,$10,true)
     RETURNING *`,
    [shopId, intent.bill_id, intent.id, provider, intent.amount_due, intent.currency,
     verified.providerTxnId, intent.merchant_reference, 'webhook:' + provider, eventRow.id]
  )).rows[0];

  const { paidState } = await writeAllocation(c, {
    shopId, billId: intent.bill_id, transactionId: txn.id, kind: 'PAYMENT',
    amount: Number(intent.amount_due), actorId: null, amountDue,
  });

  await c.query(`UPDATE payment_intents SET status='CONFIRMED', updated_at=now() WHERE id=$1`, [intent.id]);
  await issueReceipt(c, { shopId, userId: null, userName: 'webhook:' + provider, billId: intent.bill_id, transactionId: txn.id });

  return { duplicate: false, matched: true, outcome: 'CONFIRMED', transaction: txn, paid_state: paidState };
}

// ── RECEIPTS ──

async function issueReceipt(c, { shopId, userId, userName, billId, transactionId, receiptType }) {
  const receiptNo = 'RC' + Date.now().toString(36).toUpperCase();
  const receipt = (await c.query(
    `INSERT INTO receipts (shop_id, bill_id, payment_transaction_id, receipt_no, receipt_type, status, issued_at, issued_by)
     VALUES ($1,$2,$3,$4,$5,'ISSUED',now(),$6) RETURNING *`,
    [shopId, billId, transactionId, receiptNo, receiptType || 'ABBREVIATED', userId || null]
  )).rows[0];
  await auditLog(c, shopId, userId, userName, billId, 'RECEIPT_ISSUED', null, { receipt_id: receipt.id, transaction_id: transactionId });
  return receipt;
}

// ── REFUNDS (model only — never moves money or stock) ──

async function requestRefund(c, { shopId, userId, userName, transactionId, amount, reason }) {
  const txn = (await c.query('SELECT * FROM payment_transactions WHERE id=$1 AND shop_id=$2 FOR UPDATE', [transactionId, shopId])).rows[0];
  if (!txn) err('TRANSACTION_NOT_FOUND', 404);
  if (txn.status !== 'CONFIRMED' && txn.status !== 'PARTIALLY_REFUNDED') err('TRANSACTION_NOT_REFUNDABLE', 409);
  const refund = (await c.query(
    `INSERT INTO payment_refunds (shop_id, payment_transaction_id, status, amount, reason, requested_by)
     VALUES ($1,$2,'REQUESTED',$3,$4,$5) RETURNING *`,
    [shopId, transactionId, Number(amount), reason || null, userId]
  )).rows[0];
  await auditLog(c, shopId, userId, userName, txn.bill_id, 'REFUND_REQUESTED', reason || null, { refund_id: refund.id, amount: Number(amount), transaction_id: transactionId });
  return { refund };
}

async function decideRefund(c, { shopId, userId, userName, refundId, approve, reason }) {
  const refund = (await c.query('SELECT * FROM payment_refunds WHERE id=$1 AND shop_id=$2 FOR UPDATE', [refundId, shopId])).rows[0];
  if (!refund) err('REFUND_NOT_FOUND', 404);
  assertTransition('REFUND', refund.status, approve ? 'APPROVED' : 'REJECTED');

  const txn = (await c.query('SELECT * FROM payment_transactions WHERE id=$1 AND shop_id=$2 FOR UPDATE', [refund.payment_transaction_id, shopId])).rows[0];
  if (!txn) err('TRANSACTION_NOT_FOUND', 404);

  if (!approve) {
    await c.query(`UPDATE payment_refunds SET status='REJECTED', decided_at=now(), approved_by=$1 WHERE id=$2`, [userId, refundId]);
    await auditLog(c, shopId, userId, userName, txn.bill_id, 'REFUND_REJECTED', reason || null, { refund_id: refundId });
    const out = (await c.query('SELECT * FROM payment_refunds WHERE id=$1', [refundId])).rows[0];
    return { refund: out };
  }

  const bill = await lockBill(c, shopId, txn.bill_id);
  const amountDue = billAmountDue(bill);
  const { paidState, allocation } = await writeAllocation(c, {
    shopId, billId: txn.bill_id, transactionId: txn.id, kind: 'REFUND',
    amount: Number(refund.amount), actorId: userId, amountDue,
  });

  const newRefundTotal = Number(txn.refund_total) + Number(refund.amount);
  const newTxnStatus = newRefundTotal >= Number(txn.paid_amount) - 0.005 ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
  assertTransition('TRANSACTION', txn.status, newTxnStatus);
  await c.query(`UPDATE payment_transactions SET status=$1, refund_total=$2 WHERE id=$3`, [newTxnStatus, newRefundTotal, txn.id]);
  await c.query(`UPDATE payment_refunds SET status='APPROVED', decided_at=now(), approved_by=$1, allocation_id=$2 WHERE id=$3`,
    [userId, allocation.id, refundId]);

  await auditLog(c, shopId, userId, userName, txn.bill_id, 'REFUND_APPROVED', reason || null,
    { refund_id: refundId, amount: Number(refund.amount), paid_state: paidState, transaction_status: newTxnStatus });

  const out = (await c.query('SELECT * FROM payment_refunds WHERE id=$1', [refundId])).rows[0];
  return { refund: out, paid_state: paidState };
}

// ── REVERSAL (CONFIRMED transaction -> REVERSED; money-only, no stock; a fresh replacement
//    payment can follow immediately since payment_allocations has no 1:1 cardinality lock) ──

async function reverseTransaction(c, { shopId, userId, userName, transactionId, reason }) {
  const txn = (await c.query('SELECT * FROM payment_transactions WHERE id=$1 AND shop_id=$2 FOR UPDATE', [transactionId, shopId])).rows[0];
  if (!txn) err('TRANSACTION_NOT_FOUND', 404);
  assertTransition('TRANSACTION', txn.status, 'REVERSED');

  const bill = await lockBill(c, shopId, txn.bill_id);
  const amountDue = billAmountDue(bill);
  const { paidState } = await writeAllocation(c, {
    shopId, billId: txn.bill_id, transactionId: txn.id, kind: 'REFUND',
    amount: Number(txn.paid_amount) - Number(txn.refund_total), actorId: userId, amountDue,
  });
  await c.query(`UPDATE payment_transactions SET status='REVERSED' WHERE id=$1`, [transactionId]);
  await auditLog(c, shopId, userId, userName, txn.bill_id, 'PAYMENT_CANCELLED', reason || 'reversal', { transaction_id: transactionId, paid_state: paidState });
  return { paid_state: paidState };
}

// ── RECONCILIATION (data-model only — manual flag/resolve) ──

async function flagReconciliation(c, { shopId, userId, userName, transactionId, status, notes }) {
  const txn = (await c.query('SELECT * FROM payment_transactions WHERE id=$1 AND shop_id=$2', [transactionId, shopId])).rows[0];
  if (!txn) err('TRANSACTION_NOT_FOUND', 404);
  const rec = (await c.query(
    `INSERT INTO payment_reconciliation_records (shop_id, payment_transaction_id, status, notes)
     VALUES ($1,$2,$3,$4) RETURNING *`,
    [shopId, transactionId, status, notes || null]
  )).rows[0];
  await c.query(`UPDATE payment_transactions SET reconciliation_status=$1 WHERE id=$2`, [status, transactionId]);
  await auditLog(c, shopId, userId, userName, txn.bill_id, 'RECONCILIATION_FLAGGED', notes || null, { record_id: rec.id, status });
  return { record: rec };
}

async function resolveReconciliation(c, { shopId, userId, userName, recordId, notes }) {
  const rec = (await c.query('SELECT * FROM payment_reconciliation_records WHERE id=$1 AND shop_id=$2 FOR UPDATE', [recordId, shopId])).rows[0];
  if (!rec) err('RECONCILIATION_RECORD_NOT_FOUND', 404);
  await c.query(`UPDATE payment_reconciliation_records SET status='RECONCILED', resolved_at=now(), resolved_by=$1, notes=COALESCE($2,notes) WHERE id=$3`,
    [userId, notes || null, recordId]);
  if (rec.payment_transaction_id) {
    await c.query(`UPDATE payment_transactions SET reconciliation_status='RECONCILED' WHERE id=$1`, [rec.payment_transaction_id]);
  }
  const txnBill = rec.payment_transaction_id
    ? (await c.query('SELECT bill_id FROM payment_transactions WHERE id=$1', [rec.payment_transaction_id])).rows[0]
    : null;
  await auditLog(c, shopId, userId, userName, txnBill ? txnBill.bill_id : null, 'RECONCILIATION_RESOLVED', notes || null, { record_id: recordId });
  const out = (await c.query('SELECT * FROM payment_reconciliation_records WHERE id=$1', [recordId])).rows[0];
  return { record: out };
}

// ── ONLINE ORDER MOCK FLOW (SUBMITTED -> BILL_CREATED -> INTENT -> AWAITING -> mock confirm ->
//    PAYMENT_CONFIRMED -> ORDER_ACCEPTED -> kitchen_release_eligible=true). Touches nothing real —
//    reuses createBill/confirmBill/createIntent/processProviderWebhook end to end. ──

async function runOnlineOrderMockFlow(c, { shopId, userId, userName, amountDue, currency, simulate }) {
  const { bill } = await createBill(c, { shopId, userId, userName, amountDue, currency });
  const { bill: confirmed } = await confirmBill(c, { shopId, userId, userName, billId: bill.id });
  const { intent } = await createIntent(c, { shopId, userId, billId: confirmed.id, method: 'DYNAMIC_QR', currency, idempotencyKey: 'online-' + bill.id });

  const adapter = getAdapter('MOCK');
  const outcome = simulate === 'fail' ? 'FAILED' : 'SUCCESS';
  const delivery = adapter.buildWebhookDelivery({
    eventId: 'evt_' + bill.id, providerTxnId: intent.provider_ref,
    status: outcome, amount: Number(intent.amount_due), currency: intent.currency,
  });
  const result = await processProviderWebhook(c, { shopId, provider: 'MOCK', rawBody: delivery.rawBody, signature: delivery.signature });

  const finalBill = (await c.query('SELECT * FROM bills WHERE id=$1', [bill.id])).rows[0];
  return {
    bill: finalBill,
    intent,
    webhook_outcome: result.outcome,
    order_accepted: result.outcome === 'CONFIRMED',
    kitchen_release_eligible: !!finalBill.kitchen_release_eligible,
  };
}

module.exports = {
  ServiceError, isUUID,
  createBill, confirmBill, voidOrCancelBill,
  createIntent, cancelIntent, lazyExpireIfDue,
  cashConfirm, staticQrDisplay, staticQrConfirm,
  processProviderWebhook,
  issueReceipt,
  requestRefund, decideRefund, reverseTransaction,
  flagReconciliation, resolveReconciliation,
  runOnlineOrderMockFlow,
};
