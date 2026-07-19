// payment_allocations — the AUTHORITATIVE Bill <-> confirmed-transaction link (Founder
// data-model correction; see backend/db/schema-payment-platform.sql header for the full
// disposition of the one-confirmed-per-bill index this replaces).
//
// THE INVARIANT (enforced HERE, in the application layer, inside the caller's transaction),
// ALL IN INTEGER SATANG — NO EPSILON, EVER:
//   net_paid_satang =
//     SUM(allocated_amount_satang WHERE kind='PAYMENT' AND status='ACTIVE')
//       - SUM(allocated_amount_satang WHERE kind='REFUND' AND status='ACTIVE')
//   net_paid_satang MUST NEVER exceed bill.amount_due_satang.
//   UNPAID          <=> net_paid_satang === 0
//   PARTIALLY_PAID  <=> 0 < net_paid_satang < amount_due_satang
//   PAID            <=> net_paid_satang === amount_due_satang   (STRICT ===, integer satang)
//
// Callers MUST lock the bill row FOR UPDATE (`SELECT ... FROM bills WHERE id=$1 FOR UPDATE`)
// in the SAME transaction `c` before calling writeAllocation — identical discipline to
// bills.js's existing bill-row locking before stock deduction. That row lock is what makes the
// read-then-check-then-insert sequence below safe under concurrent allocation writes for the
// same bill (Postgres cannot use FOR UPDATE directly on an aggregate query, so the lock is
// taken on the bill row itself, not on payment_allocations) — two concurrent allocation attempts
// that together would exceed amount_due_satang serialize on that row lock, and exactly one of
// them observes the up-to-date net and gets rejected with OVER_ALLOCATION.
const { assertSatangInteger } = require('./money');

class AllocationError extends Error {
  constructor(code, message, extra) {
    super(message || code);
    this.statusCode = 409;
    this.code = code;
    Object.assign(this, extra || {});
  }
}

// Canonical amount_due (satang) for a payment-platform bill. bills.amount_due_satang is the
// satang-authoritative column for bills created/confirmed through the new payment-platform path
// (see backend/src/payments/service.js) — legacy bills never reach this code (payment_state
// stays NULL for them and the /api/payments router never touches them). bills.net_sales/
// gross_sales (legacy, float, untouched) are NOT read here.
function billAmountDue(bill) {
  const v = bill.amount_due_satang;
  if (v === null || v === undefined) {
    throw new AllocationError('BILL_AMOUNT_DUE_SATANG_MISSING', 'bill has no amount_due_satang — not a payment-platform bill');
  }
  return Number(v);
}

async function activeAllocationTotals(c, shopId, billId) {
  const row = (await c.query(
    `SELECT
       COALESCE(SUM(allocated_amount_satang) FILTER (WHERE kind = 'PAYMENT' AND status = 'ACTIVE'), 0)::bigint AS paid,
       COALESCE(SUM(allocated_amount_satang) FILTER (WHERE kind = 'REFUND'  AND status = 'ACTIVE'), 0)::bigint AS refunded
     FROM payment_allocations WHERE shop_id = $1 AND bill_id = $2`,
    [shopId, billId]
  )).rows[0];
  const paid = Number(row.paid) || 0;
  const refunded = Number(row.refunded) || 0;
  return { paid, refunded, net: paid - refunded };
}

// STRICT integer satang comparison — no epsilon, ever (Founder mandate).
function derivePaidState(netSatang, amountDueSatang) {
  assertSatangInteger(netSatang, 'netSatang');
  assertSatangInteger(amountDueSatang, 'amountDueSatang');
  if (netSatang === 0) return 'UNPAID';
  if (netSatang === amountDueSatang) return 'PAID';
  return 'PARTIALLY_PAID';
}

// Writes one allocation row (PAYMENT or REFUND) and atomically updates bills.paid_state +
// kitchen_release_eligible in the same transaction. Throws AllocationError('OVER_ALLOCATION')
// if a PAYMENT allocation would push net paid beyond amount_due_satang (by even ONE satang —
// no epsilon), or AllocationError('REFUND_EXCEEDS_NET_PAID') if a REFUND allocation would push
// net paid below 0. Precondition: the bill row for `billId` is already locked FOR UPDATE in
// transaction `c`.
async function writeAllocation(c, { shopId, billId, transactionId, kind, amountSatang, actorId, amountDueSatang }) {
  const amt = Number(amountSatang);
  if (!Number.isInteger(amt) || !(amt > 0)) {
    throw new AllocationError('ALLOCATION_AMOUNT_INVALID', 'allocation amount_satang must be a positive integer');
  }
  if (kind !== 'PAYMENT' && kind !== 'REFUND') throw new AllocationError('ALLOCATION_KIND_INVALID', 'kind must be PAYMENT or REFUND');
  assertSatangInteger(amountDueSatang, 'amountDueSatang');

  const { net } = await activeAllocationTotals(c, shopId, billId);

  if (kind === 'PAYMENT' && net + amt > amountDueSatang) {
    throw new AllocationError('OVER_ALLOCATION',
      `payment would exceed amount_due_satang (due=${amountDueSatang}, already_paid=${net}, attempted=${amt})`,
      { amountDueSatang, alreadyPaidSatang: net, attemptedSatang: amt });
  }
  if (kind === 'REFUND' && amt > net) {
    throw new AllocationError('REFUND_EXCEEDS_NET_PAID',
      `refund (${amt}) exceeds net paid (${net})`,
      { netPaidSatang: net, attemptedSatang: amt });
  }

  const allocation = (await c.query(
    `INSERT INTO payment_allocations (shop_id, bill_id, transaction_id, kind, allocated_amount_satang, status, created_by)
     VALUES ($1,$2,$3,$4,$5,'ACTIVE',$6) RETURNING *`,
    [shopId, billId, transactionId, kind, amt, actorId || null]
  )).rows[0];

  const newNet = kind === 'PAYMENT' ? net + amt : net - amt;
  const paidState = derivePaidState(newNet, amountDueSatang);
  await c.query(
    `UPDATE bills SET paid_state = $1, kitchen_release_eligible = $2 WHERE id = $3`,
    [paidState, paidState === 'PAID', billId]
  );

  return { allocation, netSatang: newNet, paidState };
}

module.exports = { AllocationError, billAmountDue, activeAllocationTotals, derivePaidState, writeAllocation };
