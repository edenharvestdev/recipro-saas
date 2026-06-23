// สร้าง Express app (แยกจาก index.js เพื่อให้เทสต์ import ได้)
const path = require('path');
const express = require('express');
const { requireAuth, requireSuperadmin } = require('./auth/middleware');
const { tenant } = require('./tenant');

const app = express();

// Stripe webhook ต้องใช้ raw body เพื่อตรวจลายเซ็น — ต้องมาก่อน express.json()
app.use('/webhooks/stripe', express.raw({ type: '*/*' }));

app.use(express.json({ limit: '6mb' }));

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

// /api/* — ต้องล็อกอิน + ผูกร้าน (tenant) ก่อนเสมอ
const api = express.Router();
api.use(requireAuth, tenant);
api.use(require('./api/bootstrap'));   // GET  /api/bootstrap
api.use(require('./api/sync'));        // POST /api/sync
api.use(require('./api/stock'));       // POST /api/stock/{move,produce,sale} · GET /api/stock/movements
api.use(require('./api/resources'));   // DELETE /api/{suppliers|materials|recipes|bills}/:id
api.use(require('./api/billing'));     // GET  /api/plans · POST /api/billing/checkout
api.use(require('./api/logs'));        // GET  /api/logs
api.use('/admin', requireSuperadmin, require('./api/admin')); // /api/admin/*
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

module.exports = app;
