// Deterministic MOCK payment provider adapter — zero network, zero real credentials.
// Implements the provider-neutral adapter interface from BILLING_PLATFORM_BLUEPRINT.md Part F.5:
//   createPaymentIntent / generatePaymentPayload / getPaymentStatus / verifyWebhook /
//   cancelPaymentIntent / refundPayment / getSettlementStatus / reconcileTransaction
// verifyWebhook performs a REAL HMAC-SHA256 signature check over a mock secret (never a stub
// that always returns true) — this is the one piece of "real" cryptography in an otherwise
// fully simulated provider, so the signature-verification code path is genuinely exercised.
const crypto = require('crypto');

// Never a real provider secret — explicitly documented as mock-only. Overridable per-test via
// env so multiple test runs can use distinct secrets without colliding.
const MOCK_SECRET = process.env.MOCK_PAYMENT_PROVIDER_SECRET || 'mock-payment-provider-secret-DEV-ONLY';

function sign(rawBody) {
  return crypto.createHmac('sha256', MOCK_SECRET).update(rawBody, 'utf8').digest('hex');
}

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a || ''), 'utf8');
  const bufB = Buffer.from(String(b || ''), 'utf8');
  if (bufA.length !== bufB.length) return false;
  try { return crypto.timingSafeEqual(bufA, bufB); } catch (e) { return false; }
}

class MockProviderAdapter {
  constructor() {
    this.name = 'MOCK';
  }

  // {shopCredentialRef, amount, currency, merchantReference, method, expiresAt}
  // -> {providerTxnId, qrPayload, providerStatus, expiresAt}
  async createPaymentIntent({ amount, currency, merchantReference, expiresAt }) {
    const providerTxnId = 'mock_txn_' + crypto.randomBytes(12).toString('hex');
    const qrPayload = 'MOCKQR|' + merchantReference + '|' + amount + '|' + (currency || 'THB');
    return {
      providerTxnId,
      qrPayload,
      providerStatus: 'PENDING',
      expiresAt: expiresAt || new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    };
  }

  async generatePaymentPayload({ providerTxnId, amount, currency }) {
    return { qrPayload: 'MOCKQR|' + providerTxnId + '|' + amount + '|' + (currency || 'THB') };
  }

  // simulate: 'success' | 'fail' | 'expire' (deterministic, caller-controlled — this is a TEST
  // harness adapter, not a black box; real adapters would call out to the real provider here).
  async getPaymentStatus({ providerTxnId, simulate, amount, currency }) {
    if (simulate === 'fail') return { status: 'FAILED', paidAmount: 0, raw: { providerTxnId } };
    if (simulate === 'expire') return { status: 'EXPIRED', paidAmount: 0, raw: { providerTxnId } };
    return { status: 'SUCCESS', paidAmount: amount, currency: currency || 'THB', raw: { providerTxnId } };
  }

  async cancelPaymentIntent({ providerTxnId }) {
    return { cancelled: true, providerTxnId };
  }

  async refundPayment({ providerTxnId, amount, reason }) {
    return { refundId: 'mock_refund_' + crypto.randomBytes(8).toString('hex'), status: 'SUCCEEDED', providerTxnId, amount, reason };
  }

  // Test/harness helper — builds a signed webhook delivery the way the "provider" would.
  // Not part of the adapter interface itself (a real adapter's provider does this, not us),
  // but lives here because it must sign with the SAME mock secret verifyWebhook checks against.
  buildWebhookDelivery({ eventId, providerTxnId, status, amount, currency }) {
    const payload = JSON.stringify({ eventId, providerTxnId, status, amount, currency: currency || 'THB' });
    return { rawBody: payload, signature: sign(payload) };
  }

  // {rawBody, headers|signature, secretRef} -> {valid, eventId, providerTxnId, status, amount, currency}
  async verifyWebhook({ rawBody, signature }) {
    if (!rawBody || !signature) return { valid: false };
    const expected = sign(rawBody);
    if (!safeEqual(expected, signature)) return { valid: false };
    let parsed;
    try { parsed = JSON.parse(rawBody); } catch (e) { return { valid: false }; }
    return {
      valid: true,
      eventId: parsed.eventId,
      providerTxnId: parsed.providerTxnId,
      status: parsed.status,
      amount: parsed.amount,
      currency: parsed.currency,
    };
  }

  async getSettlementStatus() {
    return { batches: [] };
  }

  async reconcileTransaction({ providerTxnId }) {
    return { status: 'MATCHED', providerTxnId };
  }
}

module.exports = { MockProviderAdapter, sign, MOCK_SECRET };
