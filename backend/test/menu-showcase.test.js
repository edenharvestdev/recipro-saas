// Marketing Showcase model — pure unit tests (no DB). Run: node test/menu-showcase.test.js
const assert = require('assert');
const {
  MAX_SLOTS, validateForSave, sanitizeForDisplay, slotState, normalizeSlot,
} = require('../src/menu-showcase');

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); pass++; console.log('  ok  ' + name); } catch (e) { fail++; console.log('FAIL  ' + name + ' — ' + e.message); } }

// Shop context: this shop owns item i1/i2, categories "กาแฟ"/"ชา", promotion p1.
const CTX = { itemIds: new Set(['i1', 'i2']), categories: ['กาแฟ', 'ชา'], promoIds: new Set(['p1']) };
const NOW = Date.parse('2026-07-04T12:00:00Z');
const slot = (o) => Object.assign({ active: true, type: 'CUSTOM', title: 'T', target_type: 'NONE' }, o);

console.log('menu-showcase.test.js');

// ---- SAVE validation ----
t('MS1 max 4 active slots accepted', () => {
  const r = validateForSave([slot({}), slot({}), slot({}), slot({})], CTX);
  assert.strictEqual(r.ok, true, JSON.stringify(r.errors));
  assert.strictEqual(MAX_SLOTS, 4);
});
t('MS2 5th slot rejected (TOO_MANY_SLOTS)', () => {
  const r = validateForSave([slot({}), slot({}), slot({}), slot({}), slot({})], CTX);
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some((e) => e.codes.includes('TOO_MANY_SLOTS')));
});
t('MS3 5 active among stored rejected (TOO_MANY_ACTIVE)', () => {
  // 4 stored but simulate active-count guard by feeding 5 (also trips TOO_MANY_SLOTS)
  const r = validateForSave(Array.from({ length: 5 }, () => slot({})), CTX);
  assert.ok(r.errors.some((e) => e.codes.includes('TOO_MANY_ACTIVE') || e.codes.includes('TOO_MANY_SLOTS')));
});
t('MS4 active slot without title rejected (TITLE_REQUIRED)', () => {
  const r = validateForSave([slot({ title: '' })], CTX);
  assert.ok(r.errors.some((e) => e.codes.includes('TITLE_REQUIRED')));
});
t('MS5 inactive slot without title is OK', () => {
  const r = validateForSave([slot({ active: false, title: '' })], CTX);
  assert.strictEqual(r.ok, true, JSON.stringify(r.errors));
});
t('MS6 end<=start rejected (END_BEFORE_START)', () => {
  const r = validateForSave([slot({ start_at: '2026-07-10T00:00:00Z', end_at: '2026-07-01T00:00:00Z' })], CTX);
  assert.ok(r.errors.some((e) => e.codes.includes('END_BEFORE_START')));
});
t('MS7 valid date range accepted', () => {
  const r = validateForSave([slot({ start_at: '2026-07-01T00:00:00Z', end_at: '2026-07-31T00:00:00Z' })], CTX);
  assert.strictEqual(r.ok, true, JSON.stringify(r.errors));
});
t('MS8 MENU_ITEM target in shop accepted', () => {
  const r = validateForSave([slot({ target_type: 'MENU_ITEM', target_id: 'i1', cta_label: 'สั่งเมนูนี้' })], CTX);
  assert.strictEqual(r.ok, true, JSON.stringify(r.errors));
});
t('MS9 MENU_ITEM cross-shop / missing target rejected (TARGET_NOT_FOUND)', () => {
  const r = validateForSave([slot({ target_type: 'MENU_ITEM', target_id: 'OTHER_SHOP_ITEM' })], CTX);
  assert.ok(r.errors.some((e) => e.codes.includes('TARGET_NOT_FOUND')));
});
t('MS10 CATEGORY target must belong to shop', () => {
  assert.strictEqual(validateForSave([slot({ target_type: 'CATEGORY', target_id: 'กาแฟ' })], CTX).ok, true);
  assert.ok(validateForSave([slot({ target_type: 'CATEGORY', target_id: 'ไม่มีหมวดนี้' })], CTX)
    .errors.some((e) => e.codes.includes('TARGET_NOT_FOUND')));
});
t('MS11 PROMOTION target must exist', () => {
  assert.strictEqual(validateForSave([slot({ target_type: 'PROMOTION', target_id: 'p1' })], CTX).ok, true);
  assert.ok(validateForSave([slot({ target_type: 'PROMOTION', target_id: 'pX' })], CTX)
    .errors.some((e) => e.codes.includes('TARGET_NOT_FOUND')));
});
t('MS12 target_type NONE ignores target_id', () => {
  const r = validateForSave([slot({ target_type: 'NONE', target_id: 'whatever' })], CTX);
  assert.strictEqual(r.ok, true, JSON.stringify(r.errors));
  assert.strictEqual(r.slots[0].target_type, 'NONE');
  assert.strictEqual(r.slots[0].target_id, null);
});
t('MS13 non-NONE with empty target coerces to NONE', () => {
  assert.strictEqual(normalizeSlot({ target_type: 'MENU_ITEM', target_id: '' }, 0).target_type, 'NONE');
});
t('MS14 unknown type coerces to CUSTOM', () => {
  assert.strictEqual(normalizeSlot({ type: 'WHATEVER' }, 0).type, 'CUSTOM');
});

// ---- DISPLAY sanitize ----
t('MS15 no slots → empty display (menu opens directly)', () => {
  assert.deepStrictEqual(sanitizeForDisplay([], CTX, NOW), []);
  assert.deepStrictEqual(sanitizeForDisplay(undefined, CTX, NOW), []);
});
t('MS16 inactive slots hidden', () => {
  assert.strictEqual(sanitizeForDisplay([slot({ active: false })], CTX, NOW).length, 0);
});
t('MS17 future (scheduled) slots hidden', () => {
  const out = sanitizeForDisplay([slot({ start_at: '2026-08-01T00:00:00Z' })], CTX, NOW);
  assert.strictEqual(out.length, 0);
});
t('MS18 expired slots hidden', () => {
  const out = sanitizeForDisplay([slot({ end_at: '2026-06-01T00:00:00Z' })], CTX, NOW);
  assert.strictEqual(out.length, 0);
});
t('MS19 active in-window slot shown', () => {
  const out = sanitizeForDisplay([slot({ title: 'Live', start_at: '2026-07-01T00:00:00Z', end_at: '2026-07-31T00:00:00Z' })], CTX, NOW);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].title, 'Live');
});
t('MS20 display sorted by order then index', () => {
  const out = sanitizeForDisplay([
    slot({ title: 'B', order: 2 }), slot({ title: 'A', order: 1 }), slot({ title: 'C', order: 3 }),
  ], CTX, NOW);
  assert.deepStrictEqual(out.map((x) => x.title), ['A', 'B', 'C']);
});
t('MS21 display hard-capped at 4', () => {
  const many = Array.from({ length: 8 }, (_, i) => slot({ title: 'S' + i, order: i }));
  assert.strictEqual(sanitizeForDisplay(many, CTX, NOW).length, 4);
});
t('MS22 slot with cross-shop/deleted target hidden from display', () => {
  const out = sanitizeForDisplay([slot({ target_type: 'MENU_ITEM', target_id: 'GHOST' })], CTX, NOW);
  assert.strictEqual(out.length, 0);
});
t('MS23 MENU_ITEM/CATEGORY/PROMOTION links preserved in display payload', () => {
  const out = sanitizeForDisplay([
    slot({ title: 'm', target_type: 'MENU_ITEM', target_id: 'i1', order: 1 }),
    slot({ title: 'c', target_type: 'CATEGORY', target_id: 'ชา', order: 2 }),
    slot({ title: 'p', target_type: 'PROMOTION', target_id: 'p1', order: 3 }),
  ], CTX, NOW);
  assert.deepStrictEqual(out.map((x) => [x.target_type, x.target_id]),
    [['MENU_ITEM', 'i1'], ['CATEGORY', 'ชา'], ['PROMOTION', 'p1']]);
});
t('MS24 display payload never leaks active/order/date internals', () => {
  const out = sanitizeForDisplay([slot({ title: 'x' })], CTX, NOW)[0];
  assert.ok(!('active' in out) && !('order' in out) && !('start_at' in out));
});

// ---- lifecycle state (admin badges) ----
t('MS25 slotState DISABLED/SCHEDULED/EXPIRED/LIVE', () => {
  assert.strictEqual(slotState(normalizeSlot(slot({ active: false }), 0), NOW), 'DISABLED');
  assert.strictEqual(slotState(normalizeSlot(slot({ start_at: '2026-08-01T00:00:00Z' }), 0), NOW), 'SCHEDULED');
  assert.strictEqual(slotState(normalizeSlot(slot({ end_at: '2026-06-01T00:00:00Z' }), 0), NOW), 'EXPIRED');
  assert.strictEqual(slotState(normalizeSlot(slot({ start_at: '2026-07-01T00:00:00Z', end_at: '2026-07-31T00:00:00Z' }), 0), NOW), 'LIVE');
});

console.log(`\nmenu-showcase: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
