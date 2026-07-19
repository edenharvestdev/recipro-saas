// Payment-platform audit trail — reuses the EXISTING bill_audit_log table/pattern
// (backend/src/api/bills.js's auditLog helper) rather than inventing a parallel audit table.
// Every payment-platform lifecycle event is bill-scoped (payment_intents/payment_transactions/
// receipts/refunds all carry bill_id), so bill_audit_log's shape (shop_id, bill_id, action,
// actor_id, actor_name, reason, snapshot jsonb) fits without any schema change.
//
// The 15 required audit kinds (action values used verbatim):
//   BILL_CREATED, BILL_CONFIRMED, PAYMENT_INTENT_CREATED, CASH_PAYMENT_CONFIRMED,
//   STATIC_QR_DISPLAYED, STATIC_QR_MANUALLY_CONFIRMED, PAYMENT_CONFIRMATION_REJECTED,
//   PAYMENT_EXPIRED, PAYMENT_CANCELLED, RECEIPT_ISSUED, REFUND_REQUESTED, REFUND_APPROVED,
//   REFUND_REJECTED, RECONCILIATION_FLAGGED, RECONCILIATION_RESOLVED.
async function auditLog(c, shopId, userId, userName, billId, action, reason, snapshot) {
  await c.query(
    `INSERT INTO bill_audit_log (shop_id, bill_id, action, actor_id, actor_name, reason, snapshot)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [shopId, billId, action, userId || null, userName || null, reason || null, snapshot ? JSON.stringify(snapshot) : null]
  );
}

module.exports = { auditLog };
