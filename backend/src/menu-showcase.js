// Online Menu — Marketing Showcase (first-load highlight) model.
// PRESENTATION-ONLY: no discount/price/stock logic here. Slots merely highlight
// existing menu items / categories / promotions. Data lives additively inside
// shop_settings.menu_config.showcase_slots (jsonb) — no new table, no migration.
//
// Pure + deterministic: every time-dependent function takes `now` as an argument
// so it is fully unit-testable. Used by:
//   - api/public.js  → sanitizeForDisplay() to filter what the customer sees
//   - frontend admin → mirrors validateForSave() rules client-side (UX only)

const MAX_SLOTS = 4;

// Slot "type" = what the shop is featuring. The shop CHOOSES per slot; nothing is
// hardcoded to a fixed campaign. Highlight-only — no auto ranking/discount here.
const SHOWCASE_TYPES = [
  'PROMOTION', 'PRODUCT_OF_MONTH', 'NEW', 'SEASONAL', 'LIMITED',
  'BEST_SELLER', 'RECOMMENDED', 'BRAND_STORY', 'CUSTOM',
];

// Where the slot's CTA points. Reuses existing flows — no duplicate logic.
const TARGET_TYPES = ['MENU_ITEM', 'CATEGORY', 'PROMOTION', 'NONE'];

const s = (v) => (v == null ? '' : String(v));
const clampTrim = (v, max) => s(v).trim().slice(0, max);

// Parse an ISO-ish datetime string to epoch ms; null/'' → null; invalid → NaN sentinel.
function parseAt(v) {
  if (v == null || v === '') return null;
  const t = Date.parse(s(v));
  return Number.isNaN(t) ? NaN : t;
}

// Normalize one raw slot into a clean, typed object (no validation verdict yet).
function normalizeSlot(raw, i) {
  raw = raw && typeof raw === 'object' ? raw : {};
  const type = SHOWCASE_TYPES.includes(raw.type) ? raw.type : 'CUSTOM';
  let target_type = TARGET_TYPES.includes(raw.target_type) ? raw.target_type : 'NONE';
  let target_id = target_type === 'NONE' ? null : (raw.target_id ? s(raw.target_id) : null);
  if (target_type !== 'NONE' && !target_id) target_type = 'NONE';   // dangling target → NONE
  const order = Number.isFinite(Number(raw.order)) ? Number(raw.order) : (i + 1);
  return {
    id: raw.id ? s(raw.id) : ('slot' + (i + 1)),
    active: raw.active === true || raw.active === 1 || raw.active === 'true',
    order,
    type,
    title: clampTrim(raw.title, 120),
    description: clampTrim(raw.description, 400),
    image: s(raw.image || raw.img || ''),
    badge: clampTrim(raw.badge, 40),
    cta_label: clampTrim(raw.cta_label, 40),
    target_type,
    target_id,
    start_at: raw.start_at ? s(raw.start_at) : null,
    end_at: raw.end_at ? s(raw.end_at) : null,
  };
}

// Does this slot's target still exist in THIS shop? ctx carries the shop's own ids.
// itemIds/categories/promoIds are Sets/arrays of the shop's own data → cross-shop or
// deleted targets fail here and are never shown.
function targetExists(slot, ctx) {
  const has = (coll, v) => {
    if (!coll) return false;
    if (coll instanceof Set) return coll.has(v);
    return Array.isArray(coll) && coll.indexOf(v) !== -1;
  };
  switch (slot.target_type) {
    case 'NONE': return true;
    case 'MENU_ITEM': return has(ctx.itemIds, slot.target_id);
    case 'CATEGORY': return has(ctx.categories, slot.target_id);
    case 'PROMOTION': return has(ctx.promoIds, slot.target_id);
    default: return false;
  }
}

// Validate one slot for SAVE (admin). Returns an array of error codes ([] = ok).
function slotErrors(slot, ctx) {
  const e = [];
  if (!SHOWCASE_TYPES.includes(slot.type)) e.push('INVALID_TYPE');
  if (!TARGET_TYPES.includes(slot.target_type)) e.push('INVALID_TARGET_TYPE');
  if (slot.active && !slot.title) e.push('TITLE_REQUIRED');
  const sa = parseAt(slot.start_at), ea = parseAt(slot.end_at);
  if (Number.isNaN(sa)) e.push('INVALID_START');
  if (Number.isNaN(ea)) e.push('INVALID_END');
  if (sa != null && ea != null && !Number.isNaN(sa) && !Number.isNaN(ea) && ea <= sa) e.push('END_BEFORE_START');
  if (slot.target_type !== 'NONE' && !slot.target_id) e.push('TARGET_REQUIRED');
  if (slot.target_type !== 'NONE' && slot.target_id && ctx && !targetExists(slot, ctx)) e.push('TARGET_NOT_FOUND');
  return e;
}

// Lifecycle state for an admin slot card. Deterministic given `now`.
function slotState(slot, now) {
  if (!slot.active) return 'DISABLED';            // ปิดใช้งาน
  const sa = parseAt(slot.start_at), ea = parseAt(slot.end_at);
  if (sa != null && !Number.isNaN(sa) && now < sa) return 'SCHEDULED';   // ยังไม่ถึงเวลา
  if (ea != null && !Number.isNaN(ea) && now > ea) return 'EXPIRED';     // หมดอายุ
  return 'LIVE';                                    // กำลังแสดง
}

// Validate the whole slot list for SAVE. Enforces: ≤ MAX_SLOTS total, ≤ MAX_SLOTS
// active, per-slot rules. Returns { ok, errors:[{index,codes}], slots:normalized }.
function validateForSave(rawSlots, ctx) {
  const arr = Array.isArray(rawSlots) ? rawSlots.slice(0, 50) : [];
  const slots = arr.map(normalizeSlot);
  const errors = [];
  if (slots.length > MAX_SLOTS) errors.push({ index: -1, codes: ['TOO_MANY_SLOTS'] });
  const activeCount = slots.filter((x) => x.active).length;
  if (activeCount > MAX_SLOTS) errors.push({ index: -1, codes: ['TOO_MANY_ACTIVE'] });
  slots.forEach((slot, i) => {
    const codes = slotErrors(slot, ctx);
    if (codes.length) errors.push({ index: i, codes });
  });
  return { ok: errors.length === 0, errors, slots };
}

// Filter + order slots for CUSTOMER DISPLAY. Drops: inactive, out-of-window
// (scheduled/expired), and slots whose target no longer exists in this shop
// (covers cross-shop / deleted targets). Sorts by `order` then original index.
// Hard-caps at MAX_SLOTS. Never throws.
function sanitizeForDisplay(rawSlots, ctx, now) {
  const arr = Array.isArray(rawSlots) ? rawSlots : [];
  const out = arr
    .map((raw, i) => ({ slot: normalizeSlot(raw, i), i }))
    .filter(({ slot }) => slot.active)
    .filter(({ slot }) => slotState(slot, now) === 'LIVE')
    .filter(({ slot }) => targetExists(slot, ctx || {}))
    .sort((a, b) => (a.slot.order - b.slot.order) || (a.i - b.i))
    .slice(0, MAX_SLOTS)
    .map(({ slot }) => ({
      id: slot.id, type: slot.type, title: slot.title, description: slot.description,
      image: slot.image, badge: slot.badge, cta_label: slot.cta_label,
      target_type: slot.target_type, target_id: slot.target_id,
    }));
  return out;
}

module.exports = {
  MAX_SLOTS, SHOWCASE_TYPES, TARGET_TYPES,
  normalizeSlot, targetExists, slotErrors, slotState,
  validateForSave, sanitizeForDisplay, parseAt,
};
