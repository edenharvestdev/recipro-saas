// บันทึกกิจกรรม (audit log) — fire-and-forget, ไม่ throw เพื่อไม่ให้กระทบงานหลัก
const { pool } = require('./db');

async function logEvent(shopId, userId, action, detail) {
  try {
    await pool.query(
      'insert into logs (shop_id, user_id, action, detail) values ($1, $2, $3, $4)',
      [shopId || null, userId || null, String(action), detail ? JSON.stringify(detail) : null]
    );
  } catch (e) {
    console.error('[log]', action, e.message);
  }
}

module.exports = { logEvent };
