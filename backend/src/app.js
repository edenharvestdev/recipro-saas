// สร้าง Express app (แยกจาก index.js เพื่อให้เทสต์ import ได้)
const path = require('path');
const express = require('express');
const { requireAuth, requireSuperadmin } = require('./auth/middleware');
const { tenant } = require('./tenant');

const app = express();
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
app.use('/webhooks', require('./webhooks/omise'));

// /api/* — ต้องล็อกอิน + ผูกร้าน (tenant) ก่อนเสมอ
const api = express.Router();
api.use(requireAuth, tenant);
api.use(require('./api/bootstrap'));   // GET  /api/bootstrap
api.use(require('./api/sync'));        // POST /api/sync
api.use(require('./api/resources'));   // DELETE /api/{suppliers|materials|recipes|bills}/:id
api.use(require('./api/billing'));     // GET  /api/plans · POST /api/billing/checkout
api.use('/admin', requireSuperadmin, require('./api/admin')); // /api/admin/*
app.use('/api', api);

// เสิร์ฟ frontend เป็น static + fallback
const frontendDir = path.join(__dirname, '..', '..', 'frontend');
app.use(express.static(frontendDir));
app.get('*', (req, res, next) => {
  if (/^\/(api|auth|webhooks)\b/.test(req.path)) return next();
  res.sendFile(path.join(frontendDir, 'index.html'));
});

module.exports = app;
