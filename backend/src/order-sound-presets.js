// Online-order notification sound presets — canonical, genuinely-distinct GENERATED tone patterns.
// No audio files, no copyrighted assets: each preset is an original Web Audio oscillator sequence.
// This is the source of truth; frontend/index.html plays the SAME 4 patterns via AudioContext.
// A note = { f: freq Hz, d: duration s, t: waveform, gap: silence-after s, g: peak gain }.

const ORDER_SOUND_PRESETS = {
  // recognizable default — gentle two-tone "ดิง-ดอง"
  STANDARD: { label: 'มาตรฐาน', pattern: [
    { f: 660, d: 0.12, t: 'sine', gap: 0.02, g: 0.6 },
    { f: 880, d: 0.22, t: 'sine', gap: 0, g: 0.6 },
  ] },
  // bright ascending sparkle triad — friendly/cute, café-appropriate, not alarming
  CUTE_BELL: { label: 'กริ่งน่ารัก', pattern: [
    { f: 1047, d: 0.09, t: 'triangle', gap: 0.02, g: 0.5 },
    { f: 1319, d: 0.09, t: 'triangle', gap: 0.02, g: 0.5 },
    { f: 1568, d: 0.18, t: 'sine', gap: 0, g: 0.55 },
  ] },
  // four rapid short square pulses — "ติ๊ด ๆ ๆ", urgent but not a siren
  URGENT_TICKS: { label: 'ติ๊ดเร่งรับออเดอร์', pattern: [
    { f: 1200, d: 0.05, t: 'square', gap: 0.06, g: 0.5 },
    { f: 1200, d: 0.05, t: 'square', gap: 0.06, g: 0.5 },
    { f: 1200, d: 0.05, t: 'square', gap: 0.06, g: 0.5 },
    { f: 1200, d: 0.05, t: 'square', gap: 0, g: 0.5 },
  ] },
  // two clear electronic beeps — "บิ๊บ บิ๊บ", easy to hear in a noisy store
  DOUBLE_BEEP: { label: 'บิ๊บ บิ๊บ', pattern: [
    { f: 740, d: 0.12, t: 'square', gap: 0.09, g: 0.55 },
    { f: 740, d: 0.12, t: 'square', gap: 0, g: 0.55 },
  ] },
};

const PRESET_KEYS = Object.keys(ORDER_SOUND_PRESETS);

// Total audible duration of a preset (for the "duration" report + tests).
function presetDuration(key) {
  const p = ORDER_SOUND_PRESETS[key];
  if (!p) return 0;
  return p.pattern.reduce((s, n) => s + (n.d || 0) + (n.gap || 0), 0);
}

// Are all preset patterns genuinely distinct? (no two presets share an identical pattern)
function arePatternsDistinct() {
  const seen = new Set();
  for (const k of PRESET_KEYS) {
    const sig = JSON.stringify(ORDER_SOUND_PRESETS[k].pattern);
    if (seen.has(sig)) return false;
    seen.add(sig);
  }
  return seen.size === PRESET_KEYS.length;
}

// Migrate legacy stored value ('1'/'2'/'3' or unknown) → a valid preset key.
function resolvePresetKey(stored) {
  return ORDER_SOUND_PRESETS[stored] ? stored : 'STANDARD';
}

// SHOP-SCOPED resolution: the shop's default order sound lives in menu_config.order_sound_preset.
// Missing / invalid → STANDARD. This is the single source of truth (NOT device localStorage).
function resolveShopPreset(menuConfig) {
  const k = menuConfig && menuConfig.order_sound_preset;
  return ORDER_SOUND_PRESETS[k] ? k : 'STANDARD';
}

module.exports = { ORDER_SOUND_PRESETS, PRESET_KEYS, presetDuration, arePatternsDistinct, resolvePresetKey, resolveShopPreset };
