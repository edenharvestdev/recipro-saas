// Customer Display Mode — pure logic (no DB). Controls the CUSTOMER Online Menu only.
// Modes: ONLINE_ORDER (normal), PROMOTION_DISPLAY (campaign screen, ordering off),
// MENU_CLOSED (closed screen, ordering off). Server-side enforcement of the order block.
// Does NOT affect POS staff sales, stock, payment, billing, or Delivery.

const DISPLAY_MODES = ['ONLINE_ORDER', 'PROMOTION_DISPLAY', 'MENU_CLOSED'];

// Read the mode out of menu_config, defaulting safely. Missing/unknown → ONLINE_ORDER
// (never unexpectedly close an existing shop's menu).
function normalizeMode(menuConfig) {
  const m = menuConfig && menuConfig.display_mode;
  return DISPLAY_MODES.indexOf(m) !== -1 ? m : 'ONLINE_ORDER';
}

// Is customer ordering blocked in this mode? (anything other than ONLINE_ORDER)
function isOrderingBlocked(mode) {
  return normalizeModeStr(mode) !== 'ONLINE_ORDER';
}
function normalizeModeStr(mode) {
  return DISPLAY_MODES.indexOf(mode) !== -1 ? mode : 'ONLINE_ORDER';
}

// Thai-friendly reason for a blocked public order (safe conflict/status response body).
function blockedPayload(mode) {
  const m = normalizeModeStr(mode);
  if (m === 'MENU_CLOSED') return { error: 'ร้านปิดรับออเดอร์ออนไลน์ชั่วคราว', display_mode: m, reason: 'MENU_CLOSED' };
  if (m === 'PROMOTION_DISPLAY') return { error: 'ขณะนี้หน้าลูกค้าอยู่ในโหมดโปรโมชั่น ยังไม่เปิดรับออเดอร์ออนไลน์', display_mode: m, reason: 'PROMOTION_DISPLAY' };
  return { error: 'ไม่สามารถสั่งได้ในขณะนี้', display_mode: m, reason: 'ORDER_BLOCKED' };
}

const clip = (v, n) => (v == null ? '' : String(v)).slice(0, n);

// Build the customer-facing display payload (only what the menu page needs to render the mode).
function publicDisplay(menuConfig) {
  const cfg = menuConfig || {};
  const mode = normalizeMode(cfg);
  const p = cfg.promo_display || {};
  const c = cfg.closed_display || {};
  return {
    display_mode: mode,
    promo_display: {
      image: p.image || '', title: clip(p.title, 120), description: clip(p.description, 400),
      cta_label: clip(p.cta_label, 40), cta_target: clip(p.cta_target, 300),
    },
    closed_display: {
      image: c.image || '', title: clip(c.title, 120), description: clip(c.description, 400),
    },
  };
}

module.exports = { DISPLAY_MODES, normalizeMode, isOrderingBlocked, blockedPayload, publicDisplay };
