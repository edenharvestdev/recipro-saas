// payment_allocations — the AUTHORITATIVE Bill <-> confirmed-transaction link (Founder
// data-model correction; see backend/db/schema-payment-platform.sql header for the full
// disposition of the one-confirmed-per-bill index this replaces).
//
// THE INVARIANT (enforced HERE, in the application layer, inside the caller's transaction):
//   SUM(amount WHERE kind='PAYMENT' AND status='ACTIVE')
//     - SUM(amount WHERE kind='REFUND' AND status='ACTIVE')  <=  bill.amount_due
// A bill is FULLY PAID exactly when that net sum == amount_due (within floating-point epsilon).
//
// Callers MUST lock the bill row FOR UPDATE (`SELECT ... FROM bills WHERE id=$1 FOR UPDATE`)
// in the SAME transaction `c` before calling writeAllocation — identical discipline to
// bills.js's existing bill-row locking before stock deduction. That row lock is what makes the
// read-then-check-then-insert sequence below safe under concurrent allocation writes for the
// same bill (Postgres cannot use FOR UPDATE directly on an aggregate query, so the lock is
// taken on the bill row itself, not on payment_allocations).

const EPSILON = 0.005; // half a satang/cent — float-safe equality for money comparisons

class AllocationError extends Error {
  constructor(code, message, extra) {
    super(message || code);
    this.statusCode = 409;
    this.code = code;
    Object.assign(this, extra || {});
  }
}

// Canonical amount_due for a payment-platform bill. bills.net_sales is used as the canonical
// amount for bills created/confirmed through the new payment-platform path (see
// backend/src/payments/service.js) — legacy bills never reach this code (payment_state stays
// NULL for them and the /api/payments router never touches them).
function billAmountDue(bill) {
  return Number(bill.net_sales) || 0;
}

async function activeAllocationTotals(c, shopId, billId) {
  const row = (await c.query(
    `SELECT
       COALESCE(SUM(amount) FILTER (WHERE kind = 'PAYMENT' AND status = 'ACTIVE'), 0)::numeric AS paid,
       COALESCE(SUM(amount) FILTER (WHERE kind = 'REFUND'  AND status = 'ACTIVE'), 0)::numeric AS refunded
     FROM payment_allocations WHERE shop_id = $1 AND bill_id = $2`,
    [shopId, billId]
  )).rows[0];
  const paid = Number(row.paid) || 0;
  const refunded = Number(row.refunded) || 0;
  return { paid, refunded, net: paid - refunded };
}

function derivePaidState(net, amountDue) {
  if (net <= EPSILON) return 'UNPAID';
  if (net >= amountDue - EPSILON) return 'PAID';
  return 'PARTIALLY_PAID';
}

// Writes one allocation row (PAYMENT or REFUND) and atomically updates bills.paid_state +
// kitchen_release_eligible in the same transaction. Throws AllocationError('OVER_ALLOCATION')
// if a PAYMENT allocation would push net paid beyond amount_due, or
// AllocationError('REFUND_EXCEEDS_NET_PAID') if a REFUND allocation would push net paid below 0.
// Precondition: the bill row for `billId` is already locked FOR UPDATE in transaction `c`.
async function writeAllocation(c, { shopId, billId, transactionId, kind, amount, actorId, amountDue }) {
  const amt = Number(amount);
  if (!(amt > 0)) throw new AllocationError('ALLOCATION_AMOUNT_INVALID', 'allocation amount must be > 0');
  if (kind !== 'PAYMENT' && kind !== 'REFUND') throw new AllocationError('ALLOCATION_KIND_INVALID', 'kind must be PAYMENT or REFUND');

  const { net } = await activeAllocationTotals(c, shopId, billId);

  if (kind === 'PAYMENT' && net + amt > amountDue + EPSILON) {
    throw new AllocationError('OVER_ALLOCATION',
      `payment would exceed amount_due (due=${amountDue}, already_paid=${net}, attempted=${amt})`,
      { amountDue, alreadyPaid: net, attempted: amt });
  }
  if (kind === 'REFUND' && amt > net + EPSILON) {
    throw new AllocationError('REFUND_EXCEEDS_NET_PAID',
      `refund (${amt}) exceeds net paid (${net})`,
      { netPaid: net, attempted: amt });
  }

  const allocation = (await c.query(
    `INSERT INTO payment_allocations (shop_id, bill_id, transaction_id, kind, amount, status, created_by)
     VALUES ($1,$2,$3,$4,$5,'ACTIVE',$6) RETURNING *`,
    [shopId, billId, transactionId, kind, amt, actorId || null]
  )).rows[0];

  const newNet = kind === 'PAYMENT' ? net + amt : net - amt;
  const paidState = derivePaidState(newNet, amountDue);
  await c.query(
    `UPDATE bills SET paid_state = $1, kitchen_release_eligible = $2 WHERE id = $3`,
    [paidState, paidState === 'PAID', billId]
  );

  return { allocation, net: newNet, paidState };
}

module.exports = { EPSILON, AllocationError, billAmountDue, activeAllocationTotals, derivePaidState, writeAllocation };
