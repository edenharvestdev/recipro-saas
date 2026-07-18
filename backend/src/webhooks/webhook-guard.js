// Fail-closed guard for payment webhook signature verification (Stripe + Omise).
//
// Rule: in production, a webhook is NEVER processed before its signature is verified.
//   - webhook secret not configured  -> reject (caller responds 503, no mutation)
//   - signature missing/malformed/mismatched -> reject (caller responds 401, no mutation)
//
// Local/test bypass is explicit-only: it requires BOTH NODE_ENV!=='production' AND
// ALLOW_UNVERIFIED_WEBHOOKS==='1'. Production is checked first, so the flag has zero
// effect there even if it were accidentally set in a prod environment.
'use strict';

function isProduction() {
  return process.env.NODE_ENV === 'production';
}

function devBypassEnabled() {
  return !isProduction() && process.env.ALLOW_UNVERIFIED_WEBHOOKS === '1';
}

class WebhookConfigError extends Error {}

// Call once per request, before touching the signature or the payload.
// Returns 'bypass' (skip verification — dev/test only) or 'verify' (must verify below).
// Throws WebhookConfigError when no secret is configured and no explicit dev bypass applies.
function guardSecret(secretConfigured) {
  if (devBypassEnabled()) return 'bypass';
  if (!secretConfigured) throw new WebhookConfigError('webhook secret not configured');
  return 'verify';
}

module.exports = { isProduction, devBypassEnabled, guardSecret, WebhookConfigError };
