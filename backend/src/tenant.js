// middleware: หา shop ปัจจุบัน + role จาก memberships (ใช้ต่อจาก requireAuth)
// แยกข้อมูลแต่ละร้านที่ชั้นนี้ — ทุก query ของ /api/* ใช้ req.shopId เสมอ
const { query } = require('./db');
const catalog = require('./permissions/catalog');

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

    // S4: โหลดสิทธิ์ย่อยของพนักงานสำหรับร้านปัจจุบัน (ใช้บังคับสิทธิ์ใน endpoint สำคัญ)
    req.staffPerms = {};
    if (req.shopId) {
      try {
        const sp = await query('select staff_permissions from shop_settings where shop_id = $1', [req.shopId]);
        let p = sp.rows[0] && sp.rows[0].staff_permissions;
        if (typeof p === 'string') { try { p = JSON.parse(p); } catch (e) { p = {}; } }
        req.staffPerms = p || {};
      } catch (e) { req.staffPerms = {}; }
    }
    // Single authority helper for all downstream code (routers, sync-guard, redaction).
    req.hasPerm = (key) => catalog.hasPerm(req.staffPerms, req.role, req.isSuperadmin, key);
    next();
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

// ค่าเริ่มต้นสิทธิ์พนักงาน (ปลอดภัย: ขาย+ลดได้ ที่เหลือปิด) — ต้องตรงกับ DEFAULT_STAFF_PERMS ฝั่ง frontend
const STAFF_PERM_DEFAULTS = {
  discount: true, void: false, stock_receive: false, waste: false,
  edit_recipes: false, view_cost: false, petty_cash: false,
  // Delivery Release A permissions (default: owner-only)
  delivery_entry: false, delivery_settlement: false,
  correct_bill: false, void_bill: false,
};

// middleware กันชั้น API: owner/superadmin ผ่านเสมอ · staff ต้องได้รับสิทธิ์ key นั้น (ผ่าน catalog resolver:
// รองรับทั้ง legacy key + new key + alias + default โดยรักษาพฤติกรรมเดิมของ key เก่าไว้ครบ)
function requirePerm(key) {
  return (req, res, next) => {
    if (catalog.hasPerm(req.staffPerms, req.role, req.isSuperadmin, key)) return next();
    if (req.role === 'staff') return res.status(403).json({ error: 'พนักงานไม่มีสิทธิ์ทำรายการนี้ (ให้เจ้าของเปิดสิทธิ์ก่อน)', code: 'PERMISSION_DENIED' });
    return res.status(403).json({ error: 'ไม่มีสิทธิ์', code: 'PERMISSION_DENIED' });
  };
}

module.exports = { tenant, requirePerm, STAFF_PERM_DEFAULTS };
