// Stock Production UX (P0/P1) — pure unit tests (no DB, no browser).
// node backend/test/stock-production-ux.test.js
//
// Context: การผลิต ("สั่งผลิตเข้าร้าน", frontend/index.html stockPage) used a
// single unfiltered <select id="prodRecipe"> to choose which recipe to
// produce — unusable once a shop has many recipes. This suite proves the
// new searchable selector against the REAL shipped code (extracted from
// frontend/index.html by brace-matched regex and eval'd inside a minimal
// sandbox — the same technique category-hotfix.test.js and
// compact-option-editor.test.js already use), and separately proves the
// actual production-calculation code (produce/pushMovement) was not touched
// at all, byte-for-byte, against the pre-branch main baseline (5c5319f).
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log('  ✓', name); }
  else { failed++; console.log('  ✗', name, extra !== undefined ? JSON.stringify(extra) : ''); }
}

// Sources are CRLF in this repo — normalize to LF so extraction/regex behave
// identically regardless of the checkout's line endings.
const readSrc = (p) => fs.readFileSync(path.join(__dirname, p), 'utf8').replace(/\r\n/g, '\n');
const INDEX_SRC = readSrc('../../frontend/index.html');

// ---------------------------------------------------------------------------
// Extraction helpers (same technique as category-hotfix.test.js /
// compact-option-editor.test.js).
// ---------------------------------------------------------------------------
function extractFn(src, name, label) {
  const decl = new RegExp('(?:^|\\n)(?:async\\s+)?function\\s+' + name + '\\s*\\(');
  const m = decl.exec(src);
  if (!m) throw new Error('cannot find function ' + name + ' in ' + (label || 'source'));
  const start = m.index + (m[0].startsWith('\n') ? 1 : 0);
  const bodyStart = src.indexOf('{', m.index + m[0].length - 1);
  let depth = 0, i = bodyStart, inStr = null, inTpl = false;
  for (; i < src.length; i++) {
    const ch = src[i], prev = src[i - 1];
    if (inStr) { if (ch === inStr && prev !== '\\') inStr = null; continue; }
    if (inTpl) { if (ch === '`' && prev !== '\\') inTpl = false; continue; }
    if (ch === '"' || ch === "'") { inStr = ch; continue; }
    if (ch === '`') { inTpl = true; continue; }
    if (ch === '/' && src[i + 1] === '/') { const nl = src.indexOf('\n', i); i = nl === -1 ? src.length : nl; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  return src.slice(start, i);
}

// Every function the new selector is made of, in source order.
const FRONT_FNS = [
  'prodRecipeMatches', 'prodRecipeSearchInput', 'prodRecipeSearchFocus',
  'prodRecipeSearchBlur', 'prodRecipeSearchKeydown', 'renderProdRecipeResults',
  'selectProdRecipe', 'syncProdRecipeSearchDisplay', 'renderProdPreview',
];
const F = {};
for (const n of FRONT_FNS) F[n] = extractFn(INDEX_SRC, n, 'frontend/index.html');

// ---------------------------------------------------------------------------
// Sandbox: the smallest environment the extracted selector code touches.
// Fake DOM elements are plain objects (value/innerHTML/style), a fake
// setTimeout/clearTimeout queue lets tests fire the debounce deterministically
// instead of racing real timers.
// ---------------------------------------------------------------------------
function makeEl(overrides) {
  return Object.assign({ value: '', innerHTML: '', style: {} }, overrides);
}

function build(opts) {
  opts = opts || {};
  const env = {
    recipes: opts.recipes || [],
    materials: opts.materials || [],
    dom: {
      prodRecipe: makeEl({ value: opts.selectedId || '' }),
      prodRecipeSearch: makeEl({ value: opts.searchValue || '' }),
      prodRecipeResults: makeEl({}),
      prodPreview: makeEl({}),
      prodRounds: makeEl({ value: '1' }),
    },
    activeElementId: null,
    timers: {},
    timerSeq: 0,
  };
  const preamble = `
    let prodSearchQuery = '';
    let prodSearchActiveIdx = -1;
    let prodSearchOpen = false;
    let prodSearchDebounceTimer = null;
    const recipes = ENV.recipes;
    const materials = ENV.materials;
    function recById(id) { return recipes.find(r => r.id === id); }
    function matById(id) { return materials.find(m => m.id === id); }
    const matStockBase = m => Number(m.stock) || 0;
    const baseU = m => m.stockUnit || m.unit || '';
    function icon(name) { return '[icon:' + name + ']'; }
    const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const document = {
      getElementById: (id) => ENV.dom[id] || null,
      get activeElement() { return ENV.activeElementId ? ENV.dom[ENV.activeElementId] : null; },
    };
    const $ = id => document.getElementById(id);
    function setTimeout(fn, ms) { const id = ++ENV.timerSeq; ENV.timers[id] = fn; return id; }
    function clearTimeout(id) { delete ENV.timers[id]; }
  `;
  const body = FRONT_FNS.map(n => F[n]).join('\n\n');
  const factory = new Function('ENV', preamble + '\n' + body + `
    return {
      ${FRONT_FNS.join(', ')},
      getQuery: () => prodSearchQuery,
      getActiveIdx: () => prodSearchActiveIdx,
      getOpen: () => prodSearchOpen,
      getDebounceTimerId: () => prodSearchDebounceTimer,
      runPendingTimer: () => { const id = prodSearchDebounceTimer; if (ENV.timers[id]) { ENV.timers[id](); delete ENV.timers[id]; } },
    };
  `);
  const api = factory(env);
  api.ENV = env;
  return api;
}

// A recipe fixture builder — 'id' is the only thing selection may ever key on.
const rec = (id, name, code, category) => ({
  id, name, code: code || '', category: category || '',
  yieldUnit: 'ชิ้น', fgStock: 0, items: [],
});

(async () => {
  console.log('\n=== Stock Production UX — searchable recipe selector ===\n');

  // -------------------------------------------------------------------------
  // 1 — Thai partial-name matching
  // -------------------------------------------------------------------------
  {
    const recipes = [
      rec('r1', 'ลาเต้เย็น'),
      rec('r2', 'ลาเต้ร้อน'),
      rec('r3', 'ชาไทยเย็น'),
      rec('r4', 'เอสเปรสโซ่'),
    ];
    const api = build({ recipes });
    const matches = api.prodRecipeMatches('เย็น');
    check('1 Thai partial substring match finds every name containing it',
      matches.map(r => r.id).sort().join(',') === 'r1,r3', matches.map(r => r.name));
    check('1 Thai match excludes non-matching names', !matches.some(r => r.id === 'r2' || r.id === 'r4'));
    check('1 Thai has no case to fold — matching a substring works without any case handling',
      api.prodRecipeMatches('ลาเต้').length === 2);
  }

  // -------------------------------------------------------------------------
  // 2 — English partial-name matching, case-insensitive
  // -------------------------------------------------------------------------
  {
    const recipes = [
      rec('r1', 'Iced Latte'),
      rec('r2', 'Hot Latte'),
      rec('r3', 'Cold Brew'),
    ];
    const api = build({ recipes });
    check('2 English partial match is case-insensitive (lowercase query)',
      api.prodRecipeMatches('latte').map(r => r.id).sort().join(',') === 'r1,r2');
    check('2 English partial match is case-insensitive (uppercase query)',
      api.prodRecipeMatches('LATTE').map(r => r.id).sort().join(',') === 'r1,r2');
    check('2 English partial match is case-insensitive (mixed-case query, substring mid-word)',
      api.prodRecipeMatches('ceD lA').map(r => r.id).join(',') === 'r1');
    check('2 non-matching English term returns nothing', api.prodRecipeMatches('mocha').length === 0);
  }

  // -------------------------------------------------------------------------
  // 3 — SKU / code matching
  // -------------------------------------------------------------------------
  {
    const recipes = [
      rec('r1', 'ลาเต้เย็น', 'BEV-001'),
      rec('r2', 'ลาเต้ร้อน', 'BEV-002'),
      rec('r3', 'ชาไทย', 'bev-003'),
    ];
    const api = build({ recipes });
    check('3 code match is exact-substring, case-insensitive',
      api.prodRecipeMatches('bev-001').map(r => r.id).join(',') === 'r1');
    check('3 code match works on a partial code fragment',
      api.prodRecipeMatches('BEV-00').map(r => r.id).sort().join(',') === 'r1,r2,r3');
    check('3 uppercase query matches a lowercase-stored code',
      api.prodRecipeMatches('BEV-003').map(r => r.id).join(',') === 'r3');
    // Recipes with no code at all must never throw or false-match.
    const api2 = build({ recipes: [rec('r9', 'ไม่มีรหัส', '')] });
    check('3 recipes without a code do not throw and are matched by name only',
      api2.prodRecipeMatches('ไม่มีรหัส').length === 1 && api2.prodRecipeMatches('xyz').length === 0);
  }

  // -------------------------------------------------------------------------
  // 4 — selection carries the real ID, never the display name (collision fixture)
  // -------------------------------------------------------------------------
  {
    // Two recipes that render with the IDENTICAL display name but different ids —
    // the sharpest possible test that selection cannot be resolved by name.
    const recipes = [
      rec('dup-1', 'ลาเต้เย็น', 'A1'),
      rec('dup-2', 'ลาเต้เย็น', 'A2'),
    ];
    const api = build({ recipes });
    const matches = api.prodRecipeMatches('ลาเต้เย็น');
    check('4 both colliding-name recipes are found, as distinct records',
      matches.length === 2 && matches[0].id !== matches[1].id);

    api.selectProdRecipe('dup-2');
    check('4 selecting the SECOND colliding-name recipe stores its real id, not the shared name',
      api.ENV.dom.prodRecipe.value === 'dup-2');
    check('4 the visible text box shows the (shared) display name for confirmation only',
      api.ENV.dom.prodRecipeSearch.value === 'ลาเต้เย็น');

    api.selectProdRecipe('dup-1');
    check('4 selecting the FIRST colliding-name recipe stores its own distinct id',
      api.ENV.dom.prodRecipe.value === 'dup-1');

    // Source contract: selectProdRecipe must assign the select's value from the
    // id argument, never from r.name / any name-shaped identifier.
    check('4 selectProdRecipe source sets sel.value from the id parameter',
      /sel\.value\s*=\s*id/.test(F.selectProdRecipe));
    check('4 selectProdRecipe source never assigns the select value from a name field',
      !/sel\.value\s*=\s*r\.name/.test(F.selectProdRecipe) && !/sel\.value\s*=\s*name/.test(F.selectProdRecipe));
    check('4 prodRecipeMatches returns the real recipe records (ids intact), never name-only shapes',
      !/\{\s*name:/.test(F.prodRecipeMatches));
  }

  // -------------------------------------------------------------------------
  // 5 — keyboard navigation contract (↑/↓ + Enter selects, Esc closes)
  // -------------------------------------------------------------------------
  {
    const recipes = [rec('r1', 'กาแฟเย็น'), rec('r2', 'กาแฟร้อน'), rec('r3', 'ชาเย็น')];
    const api = build({ recipes });
    let prevented = 0;
    const evt = (key) => ({ key, preventDefault: () => { prevented++; } });

    api.prodRecipeSearchFocus(api.ENV.dom.prodRecipeSearch); // opens with all 3, activeIdx 0
    check('5 focusing with an empty query opens the dropdown on the first item',
      api.getOpen() === true && api.getActiveIdx() === 0);

    api.prodRecipeSearchKeydown(evt('ArrowDown'));
    check('5 ArrowDown advances the active index', api.getActiveIdx() === 1);
    api.prodRecipeSearchKeydown(evt('ArrowDown'));
    api.prodRecipeSearchKeydown(evt('ArrowDown'));
    check('5 ArrowDown clamps at the last match (never runs past the end)', api.getActiveIdx() === 2);

    api.prodRecipeSearchKeydown(evt('ArrowUp'));
    check('5 ArrowUp retreats the active index', api.getActiveIdx() === 1);
    api.prodRecipeSearchKeydown(evt('ArrowUp'));
    api.prodRecipeSearchKeydown(evt('ArrowUp'));
    check('5 ArrowUp clamps at the first match (never goes negative)', api.getActiveIdx() === 0);

    check('5 every nav key calls preventDefault (never scrolls/moves the caret)', prevented === 6);

    api.prodRecipeSearchKeydown(evt('Enter'));
    check('5 Enter selects the currently active match by id',
      api.ENV.dom.prodRecipe.value === 'r1' && api.ENV.dom.prodRecipeSearch.value === 'กาแฟเย็น');
    check('5 Enter closes the dropdown', api.getOpen() === false);

    // Clear the box (simulating the owner erasing the confirmed name) and
    // refocus — the full list should reopen and nav should work again.
    api.ENV.dom.prodRecipeSearch.value = '';
    api.prodRecipeSearchFocus(api.ENV.dom.prodRecipeSearch);
    api.prodRecipeSearchKeydown(evt('ArrowDown'));
    check('5 dropdown reopened after clearing the box shows the full list again, nav works',
      api.getOpen() === true && api.getActiveIdx() === 1);
    api.prodRecipeSearchKeydown(evt('Escape'));
    check('5 Escape closes the dropdown', api.getOpen() === false);
    check('5 Escape clears the active index', api.getActiveIdx() === -1);
    check('5 Escape does not change the underlying selection',
      api.ENV.dom.prodRecipe.value === 'r1');

    // Enter while the dropdown is already closed (e.g. stale keypress) must be inert.
    const api2 = build({ recipes });
    api2.prodRecipeSearchKeydown({ key: 'Enter', preventDefault: () => {} });
    check('5 Enter with a closed/never-opened dropdown selects nothing',
      api2.ENV.dom.prodRecipe.value === '');
  }

  // -------------------------------------------------------------------------
  // 6 — empty state
  // -------------------------------------------------------------------------
  {
    const recipes = [rec('r1', 'กาแฟเย็น'), rec('r2', 'ชาเย็น')];
    const api = build({ recipes });
    api.prodRecipeSearchFocus(api.ENV.dom.prodRecipeSearch);
    // Drive a query with no matches through the real input path.
    api.prodRecipeSearchInput(Object.assign(api.ENV.dom.prodRecipeSearch, { value: 'มอคค่าคาราเมล' }));
    api.runPendingTimer();
    check('6 a query with zero matches renders the Thai empty state ("ไม่พบ... ลองคำอื่น")',
      /ไม่พบ[\s\S]*ลองคำอื่น/.test(api.ENV.dom.prodRecipeResults.innerHTML),
      api.ENV.dom.prodRecipeResults.innerHTML);
    check('6 empty state is still shown (dropdown stays open, informative, not silently blank)',
      api.ENV.dom.prodRecipeResults.style.display !== 'none');
  }

  // -------------------------------------------------------------------------
  // 7 — debounced filtering never re-renders the element being typed in
  // -------------------------------------------------------------------------
  {
    const recipes = [rec('r1', 'กาแฟเย็น'), rec('r2', 'ชาเย็น'), rec('r3', 'Cold Brew')];
    const api = build({ recipes });

    // Source contract: the input handler must never write back to the typed
    // element (it only ever reads el.value), and must never even reference
    // the search box's own DOM id — only the results box.
    check('7 prodRecipeSearchInput never assigns el.value (never rewrites the focused field)',
      !/el\.value\s*=/.test(F.prodRecipeSearchInput));
    check('7 prodRecipeSearchInput touches only the results dropdown, not the search input by id',
      !/getElementById\(.prodRecipeSearch./.test(F.prodRecipeSearchInput) && !/\$\(.prodRecipeSearch.\)/.test(F.prodRecipeSearchInput));
    check('7 renderProdRecipeResults never touches the search input element',
      !/prodRecipeSearch/.test(F.renderProdRecipeResults));
    check('7 prodRecipeSearchInput is debounced via setTimeout/clearTimeout (no per-keystroke full rebuild)',
      /clearTimeout\(/.test(F.prodRecipeSearchInput) && /setTimeout\(/.test(F.prodRecipeSearchInput));

    // Behavioural: simulate the exact element object the browser would pass as
    // `this` — call the handler, and prove that object is untouched afterward.
    const typedEl = { value: 'กาแฟ' };
    const before = JSON.stringify(typedEl);
    api.prodRecipeSearchInput(typedEl);
    check('7 calling the input handler leaves the typed element object byte-identical (sync phase)',
      JSON.stringify(typedEl) === before);
    check('7 the results box is untouched until the debounce timer actually fires',
      api.ENV.dom.prodRecipeResults.innerHTML === '');
    api.runPendingTimer();
    check('7 after the debounce fires, results DO update',
      api.ENV.dom.prodRecipeResults.innerHTML.includes('กาแฟเย็น'));
    check('7 the typed element is STILL untouched after the debounced render ran',
      JSON.stringify(typedEl) === before);

    // A second keystroke before the first timer fires must cancel the first
    // (clearTimeout), proving this is a real debounce, not a stacked queue.
    const api3 = build({ recipes });
    const el2 = { value: 'ก' };
    api3.prodRecipeSearchInput(el2);
    const firstTimerId = api3.getDebounceTimerId();
    el2.value = 'กา';
    api3.prodRecipeSearchInput(el2);
    const secondTimerId = api3.getDebounceTimerId();
    check('7 a second keystroke schedules a new timer distinct from the first',
      firstTimerId !== secondTimerId);
    check('7 the first (superseded) timer was cleared and cannot fire late',
      api3.ENV.timers[firstTimerId] === undefined);
  }

  // -------------------------------------------------------------------------
  // 8 — syncProdRecipeSearchDisplay never clobbers text the owner is mid-typing
  // -------------------------------------------------------------------------
  {
    const recipes = [rec('r1', 'ลาเต้เย็น')];
    const api = build({ recipes, selectedId: 'r1' });
    api.ENV.dom.prodRecipeSearch.value = 'ยังพิมพ์ไม่จบ';
    api.ENV.activeElementId = 'prodRecipeSearch'; // the box currently has focus
    api.syncProdRecipeSearchDisplay();
    check('8 while the search box has focus, a data-driven resync leaves the typed text alone',
      api.ENV.dom.prodRecipeSearch.value === 'ยังพิมพ์ไม่จบ');

    api.ENV.activeElementId = null; // focus moved away
    api.syncProdRecipeSearchDisplay();
    check('8 once focus has moved on, the box is resynced to the real selection\'s name',
      api.ENV.dom.prodRecipeSearch.value === 'ลาเต้เย็น');
  }

  // -------------------------------------------------------------------------
  // 9 — P1 selected-item preview (name, unit, current FG stock, ingredient count)
  // -------------------------------------------------------------------------
  {
    const recipes = [{
      id: 'r1', name: 'ลาเต้เย็น', code: 'BEV-1', category: 'เครื่องดื่ม',
      yieldUnit: 'แก้ว', fgStock: 42, batchYield: 4,
      items: [{ matId: 'm1', amount: 2 }, { matId: 'm2', amount: 1 }],
    }];
    const materials = [{ id: 'm1', name: 'นม', stock: 100, unit: 'ml' }, { id: 'm2', name: 'กาแฟ', stock: 50, unit: 'g' }];
    const api = build({ recipes, materials, selectedId: 'r1' });
    api.renderProdPreview();
    const html = api.ENV.dom.prodPreview.innerHTML;
    check('9 preview shows the selected recipe name', html.includes('ลาเต้เย็น'));
    check('9 preview shows the unit (yieldUnit)', html.includes('แก้ว'));
    check('9 preview shows the current FG stock value', html.includes('42'));
    check('9 preview shows the ingredient count', /\b2\b[\s\S]{0,20}รายการ/.test(html), html);
    check('9 the existing ingredient need/have table is still present (not replaced, only prefixed)',
      html.includes('ต้องใช้') && html.includes('มีในคลัง'));
    check('9 P1 introduces no new persistence — reads only pre-existing fields (fgStock/items/yieldUnit)',
      !/localStorage|saveAll\(|_base_version|prodFavoriteIds|prodRecentIds/.test(F.renderProdPreview));
  }

  // -------------------------------------------------------------------------
  // 10 — source contract: no production-calculation / deduction function touched
  // -------------------------------------------------------------------------
  {
    const PROD_CALC_FNS = ['produce', 'pushMovement'];
    for (const fn of PROD_CALC_FNS) {
      check(`10 ${fn} still exists in the shipped source`,
        (() => { try { extractFn(INDEX_SRC, fn, 'frontend/index.html'); return true; } catch (e) { return false; } })());
    }
    try {
      const baseline = execFileSync('git', ['show', '5c5319f:frontend/index.html'], {
        cwd: path.join(__dirname, '../..'), encoding: 'utf8', maxBuffer: 1024 * 1024 * 50,
      }).replace(/\r\n/g, '\n');
      const diffs = [];
      for (const fn of PROD_CALC_FNS) {
        const before = extractFn(baseline, fn, '5c5319f:frontend/index.html');
        const after = extractFn(INDEX_SRC, fn, 'frontend/index.html');
        if (before !== after) diffs.push(fn);
      }
      check('10 (git) produce() and pushMovement() are byte-identical to the 5c5319f baseline',
        diffs.length === 0, diffs);
    } catch (e) {
      console.log('  · (skipped git-baseline diff check — git unavailable in this environment:', e.message.split('\n')[0], ')');
    }
    // Static guard even without git: the new selector functions must never
    // reach into stock/movement/BOM state themselves — only read display fields.
    const FORBIDDEN = /pushMovement\(|matStockBase\(m\)\s*-|\.fgStock\s*=|\.stock\s*=/;
    const offenders = FRONT_FNS.filter(fn => FORBIDDEN.test(F[fn]));
    check('10 none of the new selector/preview functions write stock or fgStock or call pushMovement',
      offenders.length === 0, offenders);
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
})();
