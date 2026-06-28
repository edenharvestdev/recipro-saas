// Rate limiting middleware — P1-05 security fix
// ป้องกัน brute force บน auth endpoints และ payment endpoints
const rateLimit = require('express-rate-limit');
const { logEvent } = require('./logs');

function makeLimit({ windowMs, max, message, action }) {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skip: () => process.env.NODE_ENV === 'test',   // ไม่ rate-limit ตอนรัน integration test
    handler: (req, res) => {
      const ip = req.ip || req.socket?.remoteAddress || 'unknown';
      console.warn(`[rate-limit] ${action} blocked ip=${ip} path=${req.path}`);
      // log เข้า DB (fire-and-forget) — ไม่มี shopId/userId เพราะยังไม่ผ่าน auth
      logEvent(null, null, `rate_limit.${action}`, { ip, path: req.path });
      res.status(429).json({ error: message });
    },
  });
}

// POST /auth/login — 20 ครั้ง / 15 นาที / IP
const loginLimiter = makeLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: 'พยายามเข้าสู่ระบบบ่อยเกินไป — โปรดลองอีกครั้งในอีก 15 นาที',
  action: 'login',
});

// POST /auth/register — 10 ครั้ง / ชั่วโมง / IP
const registerLimiter = makeLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  message: 'สมัครสมาชิกบ่อยเกินไปจาก IP นี้ — โปรดลองอีกครั้งในภายหลัง',
  action: 'register',
});

// POST /api/billing/checkout — 5 ครั้ง / ชั่วโมง / IP (กัน checkout spam)
const checkoutLimiter = makeLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: 'ส่งคำขอชำระเงินบ่อยเกินไป — โปรดรอสักครู่แล้วลองใหม่',
  action: 'checkout',
});

// POST /api/pay/charge — 10 ครั้ง / 5 นาที / IP (กัน charge spam)
const chargeLimiter = makeLimit({
  windowMs: 5 * 60 * 1000,
  max: 10,
  message: 'ส่งคำขอสร้าง charge บ่อยเกินไป — โปรดรอสักครู่แล้วลองใหม่',
  action: 'charge',
});

module.exports = { loginLimiter, registerLimiter, checkoutLimiter, chargeLimiter };
