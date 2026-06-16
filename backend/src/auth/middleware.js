// middleware ยืนยันตัวตนจาก Bearer JWT
const { verifyAccess } = require('./tokens');

function requireAuth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing token' });
  try {
    const payload = verifyAccess(token);
    req.userId = payload.sub;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// ใช้หลัง tenant middleware (ต้องมี req.role / req.isSuperadmin แล้ว)
function requireSuperadmin(req, res, next) {
  if (!req.isSuperadmin) return res.status(403).json({ error: 'Superadmin access required' });
  next();
}

module.exports = { requireAuth, requireSuperadmin };
