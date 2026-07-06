// Customer Display Mode + Order Sound presets — pure unit tests (no DB).
// Run: node test/display-sound.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { DISPLAY_MODES, normalizeMode, isOrderingBlocked, blockedPayload, publicDisplay } = require('../src/display-mode');
const { ORDER_SOUND_PRESETS, PRESET_KEYS, presetDuration, arePatternsDistinct, resolvePresetKey, resolveShopPreset } = require('../src/order-sound-presets');

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); pass++; console.log('  ok  ' + name); } catch (e) { fail++; console.log('FAIL  ' + name + ' — ' + e.message); } }
console.log('display-sound.test.js');

// ---------- DISPLAY MODE ----------
t('DM1 missing mode defaults ONLINE_ORDER', () => {
  assert.strictEqual(normalizeMode({}), 'ONLINE_ORDER');
  assert.strictEqual(normalizeMode(undefined), 'ONLINE_ORDER');
  assert.strictEqual(normalizeMode({ display_mode: 'GARBAGE' }), 'ONLINE_ORDER');
});
t('DM2 ONLINE_ORDER does not block ordering', () => {
  assert.strictEqual(isOrderingBlocked('ONLINE_ORDER'), false);
  assert.strictEqual(isOrderingBlocked(undefined), false);   // unknown → treated as ONLINE_ORDER
});
t('DM3 PROMOTION_DISPLAY blocks ordering with Thai reason', () => {
  assert.strictEqual(isOrderingBlocked('PROMOTION_DISPLAY'), true);
  const p = blockedPayload('PROMOTION_DISPLAY');
  assert.strictEqual(p.reason, 'PROMOTION_DISPLAY');
  assert.ok(/โปรโมชั่น/.test(p.error));
});
t('DM4 MENU_CLOSED blocks ordering with Thai reason', () => {
  assert.strictEqual(isOrderingBlocked('MENU_CLOSED'), true);
  const p = blockedPayload('MENU_CLOSED');
  assert.strictEqual(p.reason, 'MENU_CLOSED');
  assert.ok(/ปิดรับออเดอร์/.test(p.error));
});
t('DM5 exactly 3 modes', () => { assert.deepStrictEqual(DISPLAY_MODES, ['ONLINE_ORDER', 'PROMOTION_DISPLAY', 'MENU_CLOSED']); });
t('DM6 publicDisplay returns mode + promo + closed content (clipped)', () => {
  const d = publicDisplay({ display_mode: 'PROMOTION_DISPLAY', promo_display: { title: 'สมัครสมาชิก', description: 'รับแต้ม x2', cta_label: 'สแกน QR', image: 'data:img' } });
  assert.strictEqual(d.display_mode, 'PROMOTION_DISPLAY');
  assert.strictEqual(d.promo_display.title, 'สมัครสมาชิก');
  assert.strictEqual(d.promo_display.image, 'data:img');
  assert.ok('closed_display' in d);
});
t('DM7 publicDisplay defaults ONLINE_ORDER + empty content', () => {
  const d = publicDisplay({});
  assert.strictEqual(d.display_mode, 'ONLINE_ORDER');
  assert.strictEqual(d.promo_display.title, '');
  assert.strictEqual(d.closed_display.image, '');
});
t('DM8 shop-scoped: mode derives only from the given config (no shared state)', () => {
  const a = normalizeMode({ display_mode: 'MENU_CLOSED' });
  const b = normalizeMode({ display_mode: 'ONLINE_ORDER' });
  assert.strictEqual(a, 'MENU_CLOSED');
  assert.strictEqual(b, 'ONLINE_ORDER');   // shop B unaffected by shop A's config object
});
t('DM9 long promo text is clipped (no unbounded payload)', () => {
  const d = publicDisplay({ display_mode: 'PROMOTION_DISPLAY', promo_display: { description: 'x'.repeat(1000) } });
  assert.ok(d.promo_display.description.length <= 400);
});

// ---------- ORDER SOUND PRESETS ----------
t('DS1 exactly 4 presets with required keys', () => {
  assert.deepStrictEqual(PRESET_KEYS.sort(), ['CUTE_BELL', 'DOUBLE_BEEP', 'STANDARD', 'URGENT_TICKS'].sort());
});
t('DS2 correct Thai labels', () => {
  assert.strictEqual(ORDER_SOUND_PRESETS.STANDARD.label, 'มาตรฐาน');
  assert.strictEqual(ORDER_SOUND_PRESETS.CUTE_BELL.label, 'กริ่งน่ารัก');
  assert.strictEqual(ORDER_SOUND_PRESETS.URGENT_TICKS.label, 'ติ๊ดเร่งรับออเดอร์');
  assert.strictEqual(ORDER_SOUND_PRESETS.DOUBLE_BEEP.label, 'บิ๊บ บิ๊บ');
});
t('DS3 no duplicate patterns (genuinely distinct audio)', () => {
  assert.strictEqual(arePatternsDistinct(), true);
  // pairwise explicit
  const sigs = PRESET_KEYS.map((k) => JSON.stringify(ORDER_SOUND_PRESETS[k].pattern));
  assert.strictEqual(new Set(sigs).size, 4);
});
t('DS4 URGENT_TICKS is a repeated multi-pulse pattern', () => {
  assert.ok(ORDER_SOUND_PRESETS.URGENT_TICKS.pattern.length >= 3);
});
t('DS5 DOUBLE_BEEP is exactly two beeps', () => {
  assert.strictEqual(ORDER_SOUND_PRESETS.DOUBLE_BEEP.pattern.length, 2);
});
t('DS6 CUTE_BELL differs from STANDARD (freq + note count)', () => {
  assert.notStrictEqual(JSON.stringify(ORDER_SOUND_PRESETS.CUTE_BELL.pattern), JSON.stringify(ORDER_SOUND_PRESETS.STANDARD.pattern));
});
t('DS7 every preset has audible duration > 0', () => {
  PRESET_KEYS.forEach((k) => assert.ok(presetDuration(k) > 0, k));
});
t('DS8 legacy tune value migrates to a valid preset', () => {
  assert.strictEqual(resolvePresetKey('1'), 'STANDARD');
  assert.strictEqual(resolvePresetKey('3'), 'STANDARD');
  assert.strictEqual(resolvePresetKey('CUTE_BELL'), 'CUTE_BELL');
  assert.strictEqual(resolvePresetKey(undefined), 'STANDARD');
});
t('DS9 frontend index.html references the 4 preset keys (sync check)', () => {
  const html = fs.readFileSync(path.join(__dirname, '../../frontend/index.html'), 'utf8');
  ['STANDARD', 'CUTE_BELL', 'URGENT_TICKS', 'DOUBLE_BEEP'].forEach((k) => assert.ok(html.indexOf(k) !== -1, 'missing ' + k + ' in index.html'));
});

// ---------- SHOP-SCOPED SOUND SETTING (Founder fix) ----------
t('DS10 missing preset → STANDARD', () => {
  assert.strictEqual(resolveShopPreset({}), 'STANDARD');
  assert.strictEqual(resolveShopPreset(undefined), 'STANDARD');
  assert.strictEqual(resolveShopPreset({ order_sound_preset: null }), 'STANDARD');
});
t('DS11 invalid preset → STANDARD', () => {
  assert.strictEqual(resolveShopPreset({ order_sound_preset: 'GARBAGE' }), 'STANDARD');
  assert.strictEqual(resolveShopPreset({ order_sound_preset: '1' }), 'STANDARD');   // legacy tune id is invalid here
});
t('DS12 saved CUTE_BELL / URGENT_TICKS / DOUBLE_BEEP persist', () => {
  assert.strictEqual(resolveShopPreset({ order_sound_preset: 'CUTE_BELL' }), 'CUTE_BELL');
  assert.strictEqual(resolveShopPreset({ order_sound_preset: 'URGENT_TICKS' }), 'URGENT_TICKS');
  assert.strictEqual(resolveShopPreset({ order_sound_preset: 'DOUBLE_BEEP' }), 'DOUBLE_BEEP');
});
t('DS13 shop A and shop B independent presets (shop-scoped, no shared state)', () => {
  const shopA = { order_sound_preset: 'CUTE_BELL' };
  const shopB = { order_sound_preset: 'URGENT_TICKS' };
  assert.strictEqual(resolveShopPreset(shopA), 'CUTE_BELL');
  assert.strictEqual(resolveShopPreset(shopB), 'URGENT_TICKS');
  // switching shop loads the correct preset; A unaffected by reading B
  assert.strictEqual(resolveShopPreset(shopA), 'CUTE_BELL');
});
t('DS14 resolution ignores device localStorage entirely (shop config is the only input)', () => {
  // resolveShopPreset takes ONLY menu_config → a legacy localStorage value cannot override it
  assert.strictEqual(resolveShopPreset({ order_sound_preset: 'DOUBLE_BEEP' }), 'DOUBLE_BEEP');
  assert.strictEqual(resolveShopPreset({}), 'STANDARD');   // no shop value → STANDARD, never a device value
});

console.log(`\ndisplay-sound: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
