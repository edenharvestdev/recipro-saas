// ออก/ตรวจ JWT (access + refresh)
const jwt = require('jsonwebtoken');

function signAccess(userId) {
  return jwt.sign({ sub: userId, typ: 'access' }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '15m',
  });
}

function signRefresh(userId) {
  return jwt.sign({ sub: userId, typ: 'refresh' }, process.env.JWT_REFRESH_SECRET, {
    expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '30d',
  });
}

function verifyAccess(token) {
  const p = jwt.verify(token, process.env.JWT_SECRET);
  if (p.typ !== 'access') throw new Error('wrong token type');
  return p;
}

function verifyRefresh(token) {
  const p = jwt.verify(token, process.env.JWT_REFRESH_SECRET);
  if (p.typ !== 'refresh') throw new Error('wrong token type');
  return p;
}

module.exports = { signAccess, signRefresh, verifyAccess, verifyRefresh };
