// Payment platform state machines — explicit transition tables, one per aggregate.
// "Confirm Bill" != "Payment Received": BILL and INTENT/TRANSACTION are separate machines,
// never merged. Every transition MUST go through assertTransition() — an invalid transition
// throws a typed, clear TransitionError (never a silent no-op, never a generic 500).
//
// STATIC_QR sub-states (QR_DISPLAYED / AWAITING_MANUAL_CONFIRMATION) are folded into the
// INTENT machine's own `status` column (payment_intents.status CHECK was widened additively
// to include them — see backend/db/schema-payment-platform.sql) rather than a parallel table,
// since a payment_intent already IS the one-attempt-context row static QR needs.

const MACHINES = {
  // Bill lifecycle (unchanged core shape from bills.js's existing DRAFT/CONFIRMED/VOIDED,
  // widened additively to allow CANCELLED — see schema chk_bills_lifecycle_status).
  BILL: {
    DRAFT: ['CONFIRMED', 'CANCELLED'],
    CONFIRMED: ['VOIDED', 'CANCELLED'],
    VOIDED: [],
    CANCELLED: [],
  },

  // One payment attempt-context. A retry after a terminal non-CONFIRMED state is always a
  // NEW intent row (this machine is never re-entered once terminal).
  INTENT: {
    CREATED: ['AWAITING_PAYMENT', 'CANCELLED'],
    // CASH confirms directly AWAITING_PAYMENT -> CONFIRMED (synchronous cashier action, no
    // intermediate verification stage); DYNAMIC_QR moves through INITIATED (webhook pending);
    // STATIC_QR moves through QR_DISPLAYED -> AWAITING_MANUAL_CONFIRMATION.
    AWAITING_PAYMENT: ['INITIATED', 'QR_DISPLAYED', 'CONFIRMED', 'CANCELLED', 'EXPIRED'],
    QR_DISPLAYED: ['AWAITING_MANUAL_CONFIRMATION', 'CANCELLED', 'EXPIRED'],
    AWAITING_MANUAL_CONFIRMATION: ['CONFIRMED', 'CANCELLED', 'EXPIRED'],
    INITIATED: ['VERIFICATION_PENDING', 'CONFIRMED', 'FAILED', 'EXPIRED', 'CANCELLED'],
    VERIFICATION_PENDING: ['CONFIRMED', 'FAILED', 'EXPIRED'],
    CONFIRMED: [],
    FAILED: [],
    EXPIRED: [],
    CANCELLED: [],
  },

  // Outcome record of an intent that reached a terminal/confirmed state.
  TRANSACTION: {
    RECEIVED: ['VERIFYING', 'CONFIRMED', 'FAILED'],
    VERIFYING: ['CONFIRMED', 'FAILED'],
    CONFIRMED: ['REVERSED', 'PARTIALLY_REFUNDED', 'REFUNDED'],
    REVERSED: [],
    FAILED: [],
    PARTIALLY_REFUNDED: ['REFUNDED'],
    REFUNDED: [],
  },

  RECEIPT: {
    DRAFT: ['ISSUED'],
    ISSUED: ['VOIDED'],
    VOIDED: [],
  },

  REFUND: {
    REQUESTED: ['APPROVED', 'REJECTED'],
    APPROVED: [],
    REJECTED: [],
  },
};

class TransitionError extends Error {
  constructor(machine, from, to) {
    super(`INVALID_TRANSITION: ${machine} cannot go ${from || '(null)'} -> ${to}`);
    this.statusCode = 409;
    this.code = 'INVALID_TRANSITION';
    this.machine = machine;
    this.from = from;
    this.to = to;
  }
}

// Throws TransitionError if `to` is not a legal next state from `from` in `machine`.
// `from` may be null/undefined only if the machine defines an entry for it (none do —
// every machine's first state must be reached via row INSERT with that value, not a transition).
function assertTransition(machine, from, to) {
  const table = MACHINES[machine];
  if (!table) throw new Error('UNKNOWN_STATE_MACHINE: ' + machine);
  const allowed = table[from] || [];
  if (!allowed.includes(to)) throw new TransitionError(machine, from, to);
  return true;
}

function isTerminal(machine, state) {
  const table = MACHINES[machine];
  if (!table) throw new Error('UNKNOWN_STATE_MACHINE: ' + machine);
  return (table[state] || []).length === 0;
}

module.exports = { MACHINES, assertTransition, isTerminal, TransitionError };
