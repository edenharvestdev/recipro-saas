// middleware: หา shop ปัจจุบัน + role จาก memberships (ใช้ต่อจาก requireAuth)
// แยกข้อมูลแต่ละร้านที่ชั้นนี้ — ทุก query ของ /api/* ใช้ req.shopId เสมอ
const { query } = require('./db');

async function tenant(req, res, next) {
  try {
    const { rows } = await query(
      'select shop_id, role from memberships where user_id = $1 order by role = $2 desc',
      [req.userId, 'superadmin']
    );
    req.memberships = rows;
    req.isSuperadmin = rows.some((m) => m.role === 'superadmin');

    // เลือกร้านปัจจุบัน: ใช้ header X-Shop-Id ถ้าผู้ใช้เป็นสมาชิกร้านนั้น ไม่งั้นใช้ร้านแรก
    const requested = req.headers['x-shop-id'];
    let current = rows.find((m) => m.shop_id === requested) || rows[0] || null;

    // superadmin เลือกร้านใดก็ได้ผ่าน X-Shop-Id (เพื่อแอดมินดูข้อมูลร้านอื่น)
    if (req.isSuperadmin && requested) current = { shop_id: requested, role: 'superadmin' };

    req.shopId = current ? current.shop_id : null;
    req.role = current ? current.role : null;
    next();
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

module.exports = { tenant };
