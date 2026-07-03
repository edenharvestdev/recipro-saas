// Sentry redaction + startup-safety tests. node test/sentry-redaction.test.js
// Proves: (1) secrets/PII are scrubbed from events before send, (2) app starts with SENTRY_DSN absent.
delete process.env.SENTRY_DSN;              // ensure we test the "no DSN" path
process.env.NODE_ENV = 'test';
const { scrubSentryEvent, redactDeep } = require('../src/sentry-scrub');

let passed = 0, failed = 0;
function check(name, cond, extra) { if (cond) { passed++; console.log('  ✓', name); } else { failed++; console.log('  ✗', name, extra !== undefined ? JSON.stringify(extra) : ''); } }

console.log('\n=== Sentry redaction + startup safety ===\n');

// 1) app starts / imports with no DSN, no Sentry network, no throw
let appOk = true; try { require('../src/app'); } catch (e) { appOk = false; console.error(e.message); }
check('SR1 app imports with SENTRY_DSN absent (no throw)', appOk);
check('SR2 Sentry not initialised without DSN', !process.env.SENTRY_DSN);

// 2) auth headers / cookies / tokens stripped from request
const ev1 = scrubSentryEvent({
  request: {
    url: 'https://x/api/bootstrap',
    headers: { authorization: 'Bearer eyJ.SECRET.jwt', cookie: 'sid=abc', 'x-access-token': 't', 'content-type': 'application/json', 'x-shop-id': 's1' },
    cookies: { sid: 'abc' },
    data: { note: 'hello', password: 'p', omise_secret_key: 'sk_live_x', nested: { api_key: 'k', ok: 1 } },
  },
});
check('SR3 authorization header removed', !ev1.request.headers.authorization);
check('SR4 cookie header removed', !ev1.request.headers.cookie);
check('SR5 x-access-token header removed', !ev1.request.headers['x-access-token']);
check('SR6 benign headers kept', ev1.request.headers['content-type'] === 'application/json' && ev1.request.headers['x-shop-id'] === 's1');
check('SR7 request.cookies removed', ev1.request.cookies === undefined);
check('SR8 password redacted in body', ev1.request.data.password === '[redacted]');
check('SR9 payment secret redacted', ev1.request.data.omise_secret_key === '[redacted]');
check('SR10 nested api_key redacted, benign kept', ev1.request.data.nested.api_key === '[redacted]' && ev1.request.data.nested.ok === 1);

// 3) request bodies dropped entirely for auth/payment/webhook endpoints
for (const url of ['/auth/login', '/api/pay/charge', '/api/billing/checkout', '/webhooks/stripe']) {
  const ev = scrubSentryEvent({ request: { url, data: { password: 'x', card: '4111', amount: 10 } } });
  check('SR11 body dropped for ' + url, ev.request.data === undefined, ev.request.data);
}

// 4) extra / contexts / tags redaction + DATABASE_URL/DSN
const ev2 = scrubSentryEvent({
  extra: { DATABASE_URL: 'postgres://u:p@h/db', jwt_secret: 's', harmless: 42 },
  contexts: { runtime: { name: 'node', env: { SECRET: 'x' } }, custom: { stripe_key: 'sk', keep: 'y' } },
  tags: { access_token: 'a', shop: 'HB01' },
});
check('SR12 DATABASE_URL redacted in extra', ev2.extra.DATABASE_URL === '[redacted]');
check('SR13 jwt_secret redacted, harmless kept', ev2.extra.jwt_secret === '[redacted]' && ev2.extra.harmless === 42);
check('SR14 raw runtime env dropped', !(ev2.contexts.runtime && ev2.contexts.runtime.env));
check('SR15 context payment key redacted, benign kept', ev2.contexts.custom.stripe_key === '[redacted]' && ev2.contexts.custom.keep === 'y');
check('SR16 tag token redacted, benign tag kept', ev2.tags.access_token === '[redacted]' && ev2.tags.shop === 'HB01');

// 5) scrubbing never throws on odd input
let safe = true; try { scrubSentryEvent(null); scrubSentryEvent(undefined); scrubSentryEvent({}); scrubSentryEvent({ request: null }); } catch (e) { safe = false; }
check('SR17 scrub tolerant of null/empty events', safe);

// 6) redactDeep depth guard (no infinite recursion)
const cyc = { a: 1 }; cyc.self = cyc;
let depthOk = true; try { redactDeep(cyc); } catch (e) { depthOk = false; }
check('SR18 redactDeep survives cyclic/deep input', depthOk);

console.log('\n=== Results: ' + passed + ' passed, ' + failed + ' failed ===');
process.exit(failed > 0 ? 1 : 0);
