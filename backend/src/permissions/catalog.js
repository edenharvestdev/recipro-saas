// Granular permission catalog + resolver (feat/granular-permissions-p1).
// Single source of truth for permission keys, groups (UI), legacy aliases, conservative defaults,
// and role presets. Authority ALWAYS comes from explicit permissions resolved through hasPerm();
// frontend hiding is never the security boundary.
//
// Backward compatibility is preserved: legacy keys stored in shop_settings.staff_permissions still
// grant their equivalent new keys, and legacy defaults still apply. No legacy key is removed here.

// ── Grouped catalog (labels/descriptions used by the matrix UI + to validate incoming keys) ──
const GROUPS = [
  { key: 'pos', label: 'POS & การขาย', perms: [
    { key: 'pos_view', label: 'ดูหน้าขาย' },
    { key: 'pos_sell', label: 'ขายหน้าร้าน' },
    { key: 'pos_apply_discount', label: 'ให้ส่วนลด' },
    { key: 'pos_apply_coupon', label: 'ใช้คูปอง / แลกของฟรี' },
    { key: 'pos_backdate', label: 'ลงขายย้อนหลัง', sensitive: true },
    { key: 'pos_open_delivery', label: 'เปิดบิลเดลิเวอรี' },
    { key: 'pos_close_day', label: 'ปิดยอดวัน / กระทบยอด', sensitive: true },
    { key: 'pos_view_cost', label: 'ดูต้นทุนหน้าขาย', sensitive: true },
    { key: 'pos_override_price', label: 'แก้ราคาขายเอง', sensitive: true },
    { key: 'pos_void', label: 'ยกเลิกบิล POS (เก่า)', sensitive: true },
  ] },
  { key: 'bills', label: 'บิล & การยกเลิก', perms: [
    { key: 'bill_view', label: 'ดูบิล' },
    { key: 'bill_create_draft', label: 'สร้างร่างบิล' },
    { key: 'bill_edit_draft', label: 'แก้ไขร่างบิล' },
    { key: 'bill_confirm', label: 'ยืนยันบิล (ตัดสต๊อก)' },
    { key: 'bill_print', label: 'พิมพ์บิล' },
    { key: 'bill_send_backoffice', label: 'ส่งหลังร้าน' },
    { key: 'bill_correct', label: 'แก้ไขบิล (ออกใหม่แทน)', sensitive: true },
    { key: 'void_bill', label: 'Void บิล (Lifecycle)', sensitive: true },
    { key: 'bill_view_audit', label: 'ดูประวัติ/ผู้ทำรายการ' },
  ] },
  { key: 'recipes', label: 'สูตร / เมนู', perms: [
    { key: 'recipe_view', label: 'ดูสูตร/เมนู' },
    { key: 'recipe_view_instructions', label: 'ดูวิธีทำ' },
    { key: 'recipe_create', label: 'สร้างสูตรใหม่', sensitive: true },
    { key: 'recipe_edit', label: 'แก้ไขสูตร/ปริมาณ', sensitive: true },
    { key: 'recipe_publish', label: 'เผยแพร่สูตร', sensitive: true },
    { key: 'recipe_archive', label: 'เก็บ/ปิดสูตร', sensitive: true },
    { key: 'recipe_view_cost', label: 'ดูต้นทุนสูตร', sensitive: true },
    { key: 'recipe_edit_cost', label: 'แก้ไขต้นทุนสูตร', sensitive: true },
  ] },
  { key: 'production', label: 'การผลิต', perms: [
    { key: 'production_view', label: 'ดูการผลิต' },
    { key: 'production_view_instructions', label: 'ดูวิธีผลิต' },
    { key: 'production_execute', label: 'ทำการผลิต' },
    { key: 'production_record_actual', label: 'บันทึกยอดผลิตจริง' },
    { key: 'production_edit_formula', label: 'แก้สูตรการผลิต', sensitive: true },
    { key: 'production_edit_materials', label: 'แก้วัตถุดิบการผลิต', sensitive: true },
    { key: 'production_reverse', label: 'ย้อนกลับการผลิต', sensitive: true },
    { key: 'production_void', label: 'ยกเลิกการผลิต', sensitive: true },
    { key: 'production_view_cost', label: 'ดูต้นทุนการผลิต', sensitive: true },
  ] },
  { key: 'stock', label: 'สต๊อก', perms: [
    { key: 'stock_view', label: 'ดูสต๊อก' },
    { key: 'stock_receive', label: 'รับของเข้า/นับสต๊อก' },
    { key: 'stock_adjust', label: 'ปรับ/ตัดของเสีย' },
    { key: 'stock_produce', label: 'ผลิตเข้าสต๊อก' },
    { key: 'stock_reverse', label: 'ย้อนรายการสต๊อก', sensitive: true },
    { key: 'stock_view_cost', label: 'ดูต้นทุนสต๊อก', sensitive: true },
    { key: 'stock_export', label: 'ส่งออกข้อมูลสต๊อก' },
  ] },
  { key: 'printers', label: 'เครื่องพิมพ์ & อุปกรณ์', perms: [
    { key: 'printer_view', label: 'ดูเครื่องพิมพ์' },
    { key: 'printer_add', label: 'เพิ่มเครื่องพิมพ์' },
    { key: 'printer_edit', label: 'แก้ไขเครื่องพิมพ์' },
    { key: 'printer_test', label: 'ทดสอบพิมพ์' },
    { key: 'printer_set_default', label: 'ตั้งเป็นค่าเริ่มต้น' },
    { key: 'printer_delete', label: 'ลบเครื่องพิมพ์', sensitive: true },
  ] },
  { key: 'reports', label: 'รายงาน', perms: [
    { key: 'report_view', label: 'ดูรายงาน' },
    { key: 'report_export', label: 'ส่งออกรายงาน' },
    { key: 'report_view_cost', label: 'ดูต้นทุนในรายงาน', sensitive: true },
    { key: 'report_view_financial', label: 'ดูข้อมูลการเงิน', sensitive: true },
  ] },
  { key: 'team', label: 'จัดการทีมงาน', perms: [
    { key: 'team_view', label: 'ดูทีมงาน' },
    { key: 'team_invite', label: 'เชิญพนักงาน', sensitive: true },
    { key: 'team_edit_role', label: 'เปลี่ยนบทบาท', sensitive: true },
    { key: 'team_edit_permissions', label: 'แก้ไขสิทธิ์พนักงาน', sensitive: true },
    { key: 'team_remove', label: 'เอาพนักงานออก', sensitive: true },
    { key: 'team_view_audit', label: 'ดูประวัติทีมงาน' },
  ] },
  { key: 'store', label: 'ตั้งค่าร้าน', perms: [
    { key: 'store_settings_view', label: 'ดูการตั้งค่าร้าน' },
    { key: 'store_settings_edit', label: 'แก้ไขการตั้งค่าร้าน', sensitive: true },
  ] },
  { key: 'system', label: 'ผู้ดูแลระบบ', perms: [
    { key: 'system_admin_view', label: 'ดูระบบผู้ดูแล', sensitive: true },
    { key: 'system_admin_manage', label: 'จัดการระบบผู้ดูแล', sensitive: true },
  ] },
];

const ALL_KEYS = GROUPS.flatMap((g) => g.perms.map((p) => p.key));

// Legacy key → new keys it grants (backward compatibility; granting legacy implies these new perms).
const LEGACY_ALIASES = {
  discount: ['pos_apply_discount'],
  void: ['pos_void'],                 // legacy POS void — NOT unified with void_bill
  void_bill: ['void_bill'],
  correct_bill: ['bill_correct'],
  stock_receive: ['stock_receive', 'stock_produce'],
  waste: ['stock_adjust'],
  edit_recipes: ['recipe_create', 'recipe_edit'],
  view_cost: ['recipe_view_cost', 'pos_view_cost', 'stock_view_cost', 'production_view_cost', 'report_view_cost'],
  delivery_entry: ['pos_open_delivery'],
  delivery_settlement: ['pos_close_day'],
};

// Legacy defaults (must exactly preserve pre-existing staff behavior for legacy keys).
const LEGACY_DEFAULTS = {
  discount: true, void: false, stock_receive: false, waste: false,
  edit_recipes: false, view_cost: false, petty_cash: false,
  delivery_entry: false, delivery_settlement: false, correct_bill: false, void_bill: false,
};

// Conservative NEW-key defaults for a staff member with no explicit permission anywhere.
// Only NEW keys that have no legacy equivalent (so legacy deny/default semantics are never overridden).
// Enough to sell; NOT recipe/production visibility (Founder: preset-only, not global), NOT cost/edit/
// delete/team/settings/system. pos_apply_discount is intentionally NOT here — it derives from the
// legacy `discount` default so a shop that set discount:false stays denied.
const STAFF_DEFAULTS = {
  pos_view: true, pos_sell: true,
  bill_view: true, bill_create_draft: true, bill_edit_draft: true, bill_confirm: true, bill_print: true,
  stock_view: true,
};

// Core resolver — the single authority check. Precedence: owner/superadmin bypass →
// explicit grant (on the key OR a legacy alias) → explicit deny (preserves "turned OFF" intent) →
// conservative default. Considers the key itself plus any legacy key that aliases to it.
function hasPerm(perms, role, isSuperadmin, key) {
  if (isSuperadmin === true || role === 'owner') return true;
  const p = perms || {};
  const candidates = [key];
  for (const legacy of Object.keys(LEGACY_ALIASES)) {
    if (LEGACY_ALIASES[legacy].includes(key)) candidates.push(legacy);
  }
  let sawExplicitFalse = false;
  for (const c of candidates) {
    if (p[c] === true) return true;                 // any explicit grant (new or legacy) wins
    if (p[c] === false) sawExplicitFalse = true;    // remember a "turned OFF" candidate
  }
  if (sawExplicitFalse) return false;               // explicit deny (with no grant) → deny
  if (STAFF_DEFAULTS[key] === true) return true;    // new conservative default (new keys only)
  for (const c of candidates) if (LEGACY_DEFAULTS[c] === true) return true;   // preserved legacy default
  return false;
}

// Role presets (applied to a `staff` membership — no new DB role). Values are explicit permission maps.
const PRESETS = {
  front_store: {
    pos_view: true, pos_sell: true, pos_apply_discount: true, pos_apply_coupon: true, pos_open_delivery: true,
    bill_view: true, bill_create_draft: true, bill_edit_draft: true, bill_confirm: true, bill_print: true, bill_send_backoffice: true, bill_view_audit: true,
    recipe_view: true, recipe_view_instructions: true,
    production_view: true, production_view_instructions: true,
    stock_view: true, printer_view: true, printer_test: true, report_view: true,
  },
  production_staff: {
    production_view: true, production_view_instructions: true, production_execute: true, production_record_actual: true,
    recipe_view: true, recipe_view_instructions: true,
    stock_view: true, stock_produce: true, printer_view: true,
  },
  read_only: {
    pos_view: true, bill_view: true, recipe_view: true, recipe_view_instructions: true,
    production_view: true, stock_view: true, report_view: true,
  },
  custom: {},
};

// May the caller see cost/COGS data anywhere? Any cost-view permission (or owner/superadmin) qualifies.
const COST_VIEW_KEYS = ['recipe_view_cost', 'stock_view_cost', 'pos_view_cost', 'report_view_cost', 'production_view_cost'];
function canViewCost(perms, role, isSuperadmin) {
  if (isSuperadmin === true || role === 'owner') return true;
  return COST_VIEW_KEYS.some((k) => hasPerm(perms, role, isSuperadmin, k));
}

module.exports = { GROUPS, ALL_KEYS, LEGACY_ALIASES, LEGACY_DEFAULTS, STAFF_DEFAULTS, PRESETS, COST_VIEW_KEYS, hasPerm, canViewCost };
