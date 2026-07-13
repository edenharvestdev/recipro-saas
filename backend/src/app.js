// สร้าง Express app (แยกจาก index.js เพื่อให้เทสต์ import ได้)
// Sentry ต้อง init ก่อน require อื่นๆ เพื่อ auto-instrument ได้ครบ
const Sentry = require('@sentry/node');
const { scrubSentryEvent } = require('./sentry-scrub');
// Sentry stays fully OFF unless SENTRY_DSN is supplied: no network calls, no warnings, app starts normally.
// When a DSN is present, sendDefaultPii is off and beforeSend scrubs secrets/PII from every event.
if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    tracesSampleRate: 0.1,
    environment: process.env.NODE_ENV || 'production',
    release: process.env.RAILWAY_GIT_COMMIT_SHA || process.env.GIT_COMMIT_SHA || undefined,
    sendDefaultPii: false,          // do not auto-attach IP / headers / cookies / request bodies
    beforeSend: scrubSentryEvent,   // strip auth headers/cookies/tokens + redact secrets/payment/db fields
    beforeSendTransaction: scrubSentryEvent,
  });
}

const path = require('path');
const express = require('express');
const helmet = require('helmet');
const { requireAuth, requireSuperadmin } = require('./auth/middleware');
const { tenant } = require('./tenant');
const { computeBillingState, isWriteBlocked } = require('./billing-state');
const { query: dbq } = require('./db');
const { checkoutLimiter, chargeLimiter } = require('./rate-limit');

const app = express();

// trust Railway/proxy X-Forwarded-For เพื่อให้ rate-limit ใช้ IP จริงของผู้ใช้ ไม่ใช่ IP ของ proxy
app.set('trust proxy', 1);

// Safe security headers (helmet). CONSERVATIVE by design for the inline-script Vanilla SPA + PWA:
//  - CSP DISABLED here (index.html uses inline <script>/<style>, blob:/data: images, print windows,
//    sw.js + manifest) — a strict CSP would break the app; a Report-Only CSP is a separate future track.
//  - COOP/COEP/CORP disabled so window.open print/QR popups and cross-origin asset loads keep working.
//  - HSTS is safe because Railway terminates HTTPS and trust proxy=1 is set above.
// Adds: X-Content-Type-Options=nosniff, X-Frame-Options=SAMEORIGIN, Referrer-Policy, DNS-Prefetch-Control,
// hides X-Powered-By.
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginOpenerPolicy: false,
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: false,
  originAgentCluster: false,
  frameguard: { action: 'sameorigin' },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  hsts: { maxAge: 15552000, includeSubDomains: true },
}));

// Stripe webhook ต้องใช้ raw body เพื่อตรวจลายเซ็น — ต้องมาก่อน express.json()
app.use('/webhooks/stripe', express.raw({ type: '*/*' }));
// Omise webhooks — raw body เพื่อตรวจ HMAC signature (ถ้าตั้ง OMISE_WEBHOOK_SECRET)
app.use('/webhooks/omise-charge', express.raw({ type: 'application/json' }));
app.use('/webhooks/omise', express.raw({ type: 'application/json' }));

app.use(express.json({ limit: '64mb' }));   // รองรับ sync ที่มีรูปเมนู/วัตถุดิบจำนวนมาก (base64) — กัน 413 ทำ sync ล้มเงียบ/รูปหาย

// CORS — ใช้ Bearer token (ไม่ใช้ cookie) จึงเปิดกว้างได้ เผื่อ frontend คนละโดเมนกับ API
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Shop-Id');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.get('/health', (req, res) => res.json({ ok: true }));

// public
app.use('/auth', require('./auth/routes'));
app.use('/webhooks', require('./webhooks/stripe'));   // POST /webhooks/stripe (raw body)
app.use('/webhooks', require('./webhooks/omise'));
app.use('/public', require('./api/public'));          // M3: เมนู/ออเดอร์สาธารณะ (ไม่ต้อง login)
app.post('/webhooks/omise-charge', require('./api/pay').omiseWebhook);  // S8: Omise charge webhook (POS) → mark paid + เด้งจอ

// /api/* — ต้องล็อกอิน + ผูกร้าน (tenant) ก่อนเสมอ
const api = express.Router();
api.use(requireAuth, tenant);
// billing guard: ร้านหมดอายุ (readonly/suspended) → เขียนข้อมูล/ขายไม่ได้ (อ่าน+บูต+จ่ายเงินได้)
api.use(async (req, res, next) => {
  try {
    if (req.method === 'GET' || req.isSuperadmin || !req.shopId) return next();
    if (/^\/(billing|pay)\b/.test(req.path)) return next();   // ให้จ่าย/ต่ออายุได้เสมอ
    const sh = (await dbq('select status, trial_ends_at from shops where id=$1', [req.shopId])).rows[0];
    if (!sh) return next();
    const sub = (await dbq('select status, current_period_end from subscriptions where shop_id=$1 limit 1', [req.shopId])).rows[0];
    const bs = computeBillingState(sh.status, sub, sh.trial_ends_at);
    if (isWriteBlocked(bs.state)) return res.status(423).json({ error: 'แพ็กเกจหมดอายุ — กรุณาต่ออายุเพื่อบันทึก/ขายต่อ', billing_state: bs.state });
    next();
  } catch (e) { next(); }   // เช็คพลาด = ไม่บล็อก (กันระบบล่ม)
});
api.use(require('./api/bootstrap'));   // GET  /api/bootstrap
api.use(require('./api/sync'));        // POST /api/sync
api.use(require('./api/stock'));       // POST /api/stock/{move,produce,sale} · GET /api/stock/movements
api.use(require('./api/orders'));      // GET /api/orders · PATCH /api/orders/:id (เฟส 3)
api.use(require('./api/snapshots'));   // S1: GET/POST /api/snapshots · POST /api/snapshots/:id/restore (สำรอง+กู้คืน)
api.use(require('./api/branches'));     // เฟส 3: GET /api/my-shops · GET /api/hq-summary (หลายสาขา)
api.use(require('./api/posdisplay'));    // S5: QR Box จอลูกค้า — GET/POST /api/pos-display
api.post('/pay/charge', chargeLimiter);           // rate-limit เฉพาะ POST /pay/charge (ก่อน router)
api.use(require('./api/pay'));           // S8: Payment Gateway (Omise) — /api/pay/{status,keys,charge}
api.use(require('./api/staff'));       // GET/POST/PATCH/DELETE /api/staff (จัดการทีมงาน)
api.use(require('./api/resources'));   // DELETE /api/{suppliers|materials|recipes|bills}/:id
api.post('/billing/checkout', checkoutLimiter);   // rate-limit เฉพาะ POST /billing/checkout
api.use(require('./api/billing'));     // GET  /api/plans · POST /api/billing/checkout
api.use(require('./api/logs'));        // GET  /api/logs
api.use(require('./api/bills'));       // front-store bill lifecycle: /api/bills/{draft,drafts,:id,:id/confirm,:id/void,:id/correct}
api.use(require('./api/preview'));     // GET /api/preview/verify/:token — admin online-menu preview gate
api.use(require('./api/coupons'));     // free-item coupon redemption: /api/coupons/{validate,apply,redemptions,import}
api.use(require('./api/permissions')); // A1: per-user permissions /api/permissions/{catalog,me,members,member/:id,dry-run}
api.use(require('./api/printers'));    // Track B: printer registry /api/printers/{,:id,:id/test,:id/set-default,capabilities}
// Delivery MVP Release A — default OFF. Set DELIVERY_ENABLED=1 to activate globally.
// Per-shop allowlist enforcement is inside the delivery router (delivery-feature.js).
const deliveryRouter = require('./api/delivery');
api.use('/delivery', (req, res, next) => {
  if (process.env.DELIVERY_ENABLED !== '1') {
    return res.status(503).json({ error: 'DELIVERY_FEATURE_DISABLED' });
  }
  return deliveryRouter(req, res, next);
});
api.use('/admin', requireSuperadmin, require('./api/admin')); // /api/admin/*
api.use('/admin', requireSuperadmin, require('./api/clone')); // /api/admin/{export-shop,import-shop,clone-shop2}
app.use('/api', api);

// เสิร์ฟ frontend เป็น static + fallback
const fs = require('fs');
const crypto = require('crypto');
const frontendDir = path.join(__dirname, '..', '..', 'frontend');

// Cache-busting: version the SPA's static assets so a new deploy is picked up WITHOUT Ctrl+Shift+R.
// Deterministic per build — prefer the Railway/git commit SHA; else a hash of the actual asset files
// (size+mtime). The <link>/<script> URLs get ?v=<ASSET_VERSION>; the shell (index.html) is served
// no-cache so returning browsers always revalidate and discover the new asset URLs. express.static
// serves files by path and ignores the query string, so styles.css?v=xxx still resolves to styles.css.
const VERSIONED_ASSETS = ['styles.css', 'icons.js', 'app-config.js', 'api.js', 'materialResolver.js'];
const ASSET_VERSION = (() => {
  const envSha = process.env.RAILWAY_GIT_COMMIT_SHA || process.env.GIT_COMMIT_SHA;
  if (envSha) return String(envSha).slice(0, 12);
  try {
    const sig = VERSIONED_ASSETS.concat('index.html').map((f) => {
      const st = fs.statSync(path.join(frontendDir, f)); return f + ':' + st.size + ':' + Math.round(st.mtimeMs);
    }).join('|');
    return crypto.createHash('sha1').update(sig).digest('hex').slice(0, 12);
  } catch (e) { return 'v' + process.pid; }   // last-resort: stable for this process
})();
// Build the shell once at boot with versioned asset URLs (regex-free targeted replace).
const INDEX_SHELL = (() => {
  let html = fs.readFileSync(path.join(frontendDir, 'index.html'), 'utf8');
  VERSIONED_ASSETS.forEach((f) => { html = html.split('./' + f + '"').join('./' + f + '?v=' + ASSET_VERSION + '"'); });
  return html;
})();
function sendShell(res) {
  res.set('Cache-Control', 'no-cache');   // always revalidate the shell → new asset URLs discovered on next visit
  res.type('html').send(INDEX_SHELL);
}

app.use(express.static(frontendDir, { index: false }));   // index:false so '/' goes through the versioned shell
// M3: หน้าเมนูสาธารณะสำหรับลูกค้า (เปิดจาก QR) — เสิร์ฟไฟล์แยก ไม่ใช่แอปหลัก
app.get('/menu/:token', (req, res) => res.sendFile(path.join(frontendDir, 'menu.html')));
app.get('*', (req, res, next) => {
  if (/^\/(api|auth|webhooks|public)\b/.test(req.path)) return next();
  sendShell(res);
});

// Sentry error handler — ต้องอยู่หลัง routes ทั้งหมด จับ unhandled error ส่ง Sentry
if (process.env.SENTRY_DSN) Sentry.setupExpressErrorHandler(app);

module.exports = app;
