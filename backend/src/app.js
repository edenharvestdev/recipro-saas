// สร้าง Express app (แยกจาก index.js เพื่อให้เทสต์ import ได้)
// Sentry ต้อง init ก่อน require อื่นๆ เพื่อ auto-instrument ได้ครบ
const Sentry = require('@sentry/node');
if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    tracesSampleRate: 0.1,
    environment: process.env.NODE_ENV || 'production',
  });
}

const path = require('path');
const express = require('express');
const { requireAuth, requireSuperadmin } = require('./auth/middleware');
const { tenant } = require('./tenant');
const { computeBillingState, isWriteBlocked } = require('./billing-state');
const { query: dbq } = require('./db');
const { checkoutLimiter, chargeLimiter } = require('./rate-limit');

const app = express();

// trust Railway/proxy X-Forwarded-For เพื่อให้ rate-limit ใช้ IP จริงของผู้ใช้ ไม่ใช่ IP ของ proxy
app.set('trust proxy', 1);

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
const frontendDir = path.join(__dirname, '..', '..', 'frontend');
app.use(express.static(frontendDir));
// M3: หน้าเมนูสาธารณะสำหรับลูกค้า (เปิดจาก QR) — เสิร์ฟไฟล์แยก ไม่ใช่แอปหลัก
app.get('/menu/:token', (req, res) => res.sendFile(path.join(frontendDir, 'menu.html')));
app.get('*', (req, res, next) => {
  if (/^\/(api|auth|webhooks|public)\b/.test(req.path)) return next();
  res.sendFile(path.join(frontendDir, 'index.html'));
});

// Sentry error handler — ต้องอยู่หลัง routes ทั้งหมด จับ unhandled error ส่ง Sentry
if (process.env.SENTRY_DSN) Sentry.setupExpressErrorHandler(app);

module.exports = app;
