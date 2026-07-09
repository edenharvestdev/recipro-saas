// Option Stock Effect Engine V1 — pure resolver tests (no DB). node test/option-engine.test.js
const { resolveEffectiveBom, scaleSnapshot } = require('../src/option-engine/effective-bom');

let passed = 0, failed = 0;
function check(name, cond, extra) { if (cond) { passed++; console.log('  ✓', name); } else { failed++; console.log('  ✗', name, extra !== undefined ? JSON.stringify(extra) : ''); } }
const find = (lines, t, id) => lines.find(l => l.target_type === t && l.ref_id === id);
const qty = (lines, t, id) => { const l = find(lines, t, id); return l ? l.qty : undefined; };

(function () {
  console.log('\n=== Option Stock Effect Engine V1 — resolver ===\n');

  // ── A. Cool Pack: base beverage + separate packaging (multi ADD) ──
  const A = resolveEffectiveBom({
    base: [
      { target_type: 'MATERIAL', ref_id: 'matcha', qty: 3, unit: 'g', role: 'matcha' },
      { target_type: 'MATERIAL', ref_id: 'water', qty: 120, unit: 'ml' },
    ],
    effects: [
      { target_type: 'PACKAGING', ref_id: 'ice_cup', action: 'ADD', amount: 1, unit: 'pcs', source: 'option:CoolPack' },
      { target_type: 'PACKAGING', ref_id: 'lid', action: 'ADD', amount: 1, unit: 'pcs', source: 'option:CoolPack' },
      { target_type: 'PACKAGING', ref_id: 'bag', action: 'ADD', amount: 1, unit: 'pcs', source: 'option:CoolPack' },
      { target_type: 'PACKAGING', ref_id: 'straw', action: 'ADD', amount: 1, unit: 'pcs', source: 'option:CoolPack' },
    ],
  });
  check('A Cool Pack keeps base beverage', qty(A.lines, 'MATERIAL', 'matcha') === 3 && qty(A.lines, 'MATERIAL', 'water') === 120);
  check('A Cool Pack adds 4 packaging items', ['ice_cup', 'lid', 'bag', 'straw'].every(p => qty(A.lines, 'PACKAGING', p) === 1));
  check('A Cool Pack total lines = 6', A.lines.length === 6, A.lines.length);

  // ── B. Matcha Cloud: produced item + packaging ──
  const B = resolveEffectiveBom({
    base: [{ target_type: 'MATERIAL', ref_id: 'matcha', qty: 3, unit: 'g' }],
    effects: [
      { target_type: 'PRODUCED_ITEM', ref_id: 'cloud_foam', action: 'ADD', amount: 1, unit: 'pcs', source: 'option:MatchaCloud' },
      { target_type: 'PACKAGING', ref_id: 'cup', action: 'ADD', amount: 1, unit: 'pcs', source: 'option:MatchaCloud' },
    ],
  });
  check('B Matcha Cloud adds produced item', qty(B.lines, 'PRODUCED_ITEM', 'cloud_foam') === 1);
  check('B Matcha Cloud adds packaging', qty(B.lines, 'PACKAGING', 'cup') === 1);

  // ── C. Milk replacement (REPLACE removes fresh, adds oat) ──
  const C = resolveEffectiveBom({
    base: [
      { target_type: 'MATERIAL', ref_id: 'fresh_milk', qty: 150, unit: 'ml', role: 'milk' },
      { target_type: 'MATERIAL', ref_id: 'matcha', qty: 3, unit: 'g' },
    ],
    effects: [
      { target_type: 'MATERIAL', ref_id: 'oat_milk', action: 'REPLACE', replace_ref_id: 'fresh_milk', amount: 150, unit: 'ml', role: 'milk', source: 'option:OatMilk' },
    ],
  });
  check('C fresh milk removed', qty(C.lines, 'MATERIAL', 'fresh_milk') === undefined);
  check('C oat milk added at 150ml', qty(C.lines, 'MATERIAL', 'oat_milk') === 150);
  check('C matcha untouched', qty(C.lines, 'MATERIAL', 'matcha') === 3);

  // Milk replacement by ROLE (no explicit replace_ref_id)
  const Crole = resolveEffectiveBom({
    base: [{ target_type: 'MATERIAL', ref_id: 'fresh_milk', qty: 150, role: 'milk' }],
    effects: [{ target_type: 'MATERIAL', ref_id: 'oat_milk', action: 'REPLACE', role: 'milk', amount: 150, source: 'opt' }],
  });
  check('C(role) role-based replace removes fresh, adds oat', qty(Crole.lines, 'MATERIAL', 'fresh_milk') === undefined && qty(Crole.lines, 'MATERIAL', 'oat_milk') === 150);

  // ── D. No syrup (REMOVE resolved qty) ──
  const D = resolveEffectiveBom({
    base: [
      { target_type: 'MATERIAL', ref_id: 'syrup', qty: 8, unit: 'g', role: 'sweet' },
      { target_type: 'MATERIAL', ref_id: 'matcha', qty: 3 },
    ],
    effects: [{ target_type: 'MATERIAL', ref_id: 'syrup', action: 'REMOVE', role: 'sweet', source: 'option:NoSyrup' }],
  });
  check('D syrup removed', qty(D.lines, 'MATERIAL', 'syrup') === undefined);
  check('D matcha kept', qty(D.lines, 'MATERIAL', 'matcha') === 3);

  // ── E. Multiple effects on ONE option (base ingredient + produced item + packaging) ──
  const E = resolveEffectiveBom({
    base: [{ target_type: 'MATERIAL', ref_id: 'matcha', qty: 3 }],
    effects: [
      { target_type: 'MATERIAL', ref_id: 'extra_shot', action: 'ADD', amount: 2, unit: 'g', source: 'option:Deluxe' },
      { target_type: 'PRODUCED_ITEM', ref_id: 'whip', action: 'ADD', amount: 1, source: 'option:Deluxe' },
      { target_type: 'PACKAGING', ref_id: 'premium_cup', action: 'ADD', amount: 1, source: 'option:Deluxe' },
    ],
  });
  check('E one option → 3 distinct effects applied', qty(E.lines, 'MATERIAL', 'extra_shot') === 2 && qty(E.lines, 'PRODUCED_ITEM', 'whip') === 1 && qty(E.lines, 'PACKAGING', 'premium_cup') === 1);
  check('E base retained', qty(E.lines, 'MATERIAL', 'matcha') === 3);

  // ── MULTIPLY ──
  const M = resolveEffectiveBom({
    base: [{ target_type: 'MATERIAL', ref_id: 'matcha', qty: 3 }],
    effects: [{ target_type: 'MATERIAL', ref_id: 'matcha', action: 'MULTIPLY', amount: 2, source: 'option:ExtraStrong' }],
  });
  check('MULTIPLY doubles the target', qty(M.lines, 'MATERIAL', 'matcha') === 6);

  // ── NO_STOCK ignored ──
  const N = resolveEffectiveBom({
    base: [{ target_type: 'MATERIAL', ref_id: 'matcha', qty: 3 }],
    effects: [{ target_type: 'NO_STOCK', action: 'NO_STOCK', source: 'option:Hot' }],
  });
  check('NO_STOCK produces no line', N.lines.length === 1 && qty(N.lines, 'MATERIAL', 'matcha') === 3 && N.trace.some(t => t.action === 'NO_STOCK'));

  // ── Order independence + determinism ──
  const eff = [
    { target_type: 'MATERIAL', ref_id: 'oat', action: 'REPLACE', replace_ref_id: 'milk', amount: 150, role: 'milk' },
    { target_type: 'MATERIAL', ref_id: 'oat', action: 'MULTIPLY', amount: 2, role: 'milk' },
    { target_type: 'PACKAGING', ref_id: 'cup', action: 'ADD', amount: 1 },
  ];
  const base = [{ target_type: 'MATERIAL', ref_id: 'milk', qty: 150, role: 'milk' }, { target_type: 'MATERIAL', ref_id: 'matcha', qty: 3 }];
  const r1 = resolveEffectiveBom({ base, effects: eff });
  const r2 = resolveEffectiveBom({ base, effects: eff.slice().reverse() });
  check('Determinism: identical output regardless of input effect order', JSON.stringify(r1.lines) === JSON.stringify(r2.lines), { r1: r1.lines, r2: r2.lines });
  check('REPLACE-then-MULTIPLY: oat 150→×2 = 300', qty(r1.lines, 'MATERIAL', 'oat') === 300);

  // ── Snapshot scaling by line qty ──
  const snap = resolveEffectiveBom({ base: [{ target_type: 'MATERIAL', ref_id: 'matcha', qty: 3 }], effects: [{ target_type: 'PACKAGING', ref_id: 'cup', action: 'ADD', amount: 1 }] });
  const scaled = scaleSnapshot(snap, 4);
  check('Snapshot scales by line qty (×4)', qty(scaled, 'MATERIAL', 'matcha') === 12 && qty(scaled, 'PACKAGING', 'cup') === 4);

  // ── Safety: bad input, missing targets ──
  check('Empty input → empty lines, no throw', (function () { try { const r = resolveEffectiveBom({}); return Array.isArray(r.lines) && r.lines.length === 0; } catch (e) { return false; } })());
  const W = resolveEffectiveBom({ base: [{ target_type: 'MATERIAL', ref_id: 'matcha', qty: 3 }], effects: [{ target_type: 'MATERIAL', ref_id: 'ghost', action: 'REMOVE' }] });
  check('REMOVE of unknown target → warning, base intact', W.warnings.some(w => w.action === 'REMOVE') && qty(W.lines, 'MATERIAL', 'matcha') === 3);

  console.log('\n=== Results: ' + passed + ' passed, ' + failed + ' failed ===');
  process.exit(failed > 0 ? 1 : 0);
})();
