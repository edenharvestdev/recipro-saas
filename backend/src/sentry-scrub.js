// Sentry event scrubber — strips secrets/PII before any event leaves the process.
// Pure + side-effect-free (except mutating the event it is given), unit-testable without a DSN.
// Removes auth headers/cookies/tokens, redacts password/secret/api-key/db-url/payment fields, and
// drops request bodies from auth/payment/webhook endpoints (which can carry credentials/card data).

const SENSITIVE_KEY = /(pass(word)?|secret|token|api[_-]?key|apikey|authorization|auth[_-]?header|cookie|set[_-]?cookie|database_url|\bdsn\b|jwt|refresh|access[_-]?token|omise|stripe|webhook[_-]?secret|card|cvv|pin|otp|priv(ate)?[_-]?key)/i;
const SENSITIVE_HEADER = /(authorization|cookie|set-cookie|x-access|x-refresh|x-api-key|x-auth|token)/i;
const BODYLESS_URL = /\/(auth|pay|billing|webhooks)\b/i;

function redactDeep(val, depth) {
  depth = depth || 0;
  if (!val || typeof val !== 'object' || depth > 6) return val;
  if (Array.isArray(val)) return val.map((v) => redactDeep(v, depth + 1));
  const out = {};
  for (const k of Object.keys(val)) {
    out[k] = SENSITIVE_KEY.test(k) ? '[redacted]' : redactDeep(val[k], depth + 1);
  }
  return out;
}

function scrubSentryEvent(event) {
  try {
    if (!event || typeof event !== 'object') return event;
    const req = event.request;
    if (req && typeof req === 'object') {
      if (req.headers && typeof req.headers === 'object') {
        for (const h of Object.keys(req.headers)) if (SENSITIVE_HEADER.test(h)) delete req.headers[h];
      }
      delete req.cookies;
      const url = String(req.url || '');
      if (BODYLESS_URL.test(url)) delete req.data;              // never send auth/payment/webhook bodies
      else if (req.data) req.data = redactDeep(req.data);
      if (req.query_string && typeof req.query_string === 'object') req.query_string = redactDeep(req.query_string);
    }
    if (event.extra) event.extra = redactDeep(event.extra);
    if (event.contexts) event.contexts = redactDeep(event.contexts);
    if (event.tags) event.tags = redactDeep(event.tags);
    // Never attach the raw env
    if (event.contexts && event.contexts.runtime && event.contexts.runtime.env) delete event.contexts.runtime.env;
    return event;
  } catch (_) {
    return event;   // scrubbing must never throw / block the pipeline
  }
}

module.exports = { scrubSentryEvent, redactDeep, SENSITIVE_KEY };
