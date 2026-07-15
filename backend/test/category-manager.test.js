// Category Manager (Workstream A) — RC-1/RC-2/RC-3 root-cause fixes + Category Manager V2.
// Extracts the REAL functions from frontend/index.html (and the guard from backend/src/api/sync.js)
// and runs them against mocked globals, the same pattern as backend/test/print-routing.test.js.
// No copy of the logic is kept here — extraction guarantees the tests track the shipped source.
// Run: node backend/test/category-manager.test.js
const fs = require('fs');
const path = require('path');
const html = fs.readFileSync(path.join(__dirname, '../../frontend/index.html'), 'utf8');
const syncSrc = fs.readFileSync(path.join(__dirname, '../src/api/sync.js'), 'utf8');

// String/comment/regex-aware extractor (mirrors print-routing.test.js's extractFn): returns the full
// source of `function NAME(...) {...}` without mismatching on braces inside string/template literals.
function extractFn(name) {
  let start = html.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('function not found: ' + name);
  // include a preceding "async " keyword (if any) so extracted async functions stay valid syntax
  const asyncMatch = html.slice(Math.max(0, start - 8), start).match(/async(\s+)$/);
  if (asyncMatch) start -= asyncMatch[0].length;
  let i = html.indexOf('{', start);
  let depth = 0, str = null, prevSig = '(';
  for (; i < html.length; i++) {
    const ch = html[i], nx = html[i + 1];
    if (str) {
      if (ch === '\\') { i++; continue; }
      if (ch === str) str = null;
      continue;
    }
    if (ch === '/' && nx === '/') { i = html.indexOf('\n', i); if (i < 0) break; continue; }
    if (ch === '/' && nx === '*') { i = html.indexOf('*/', i + 2) + 1; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { str = ch; prevSig = ch; continue; }
    if (ch === '/' && '([{,;:=!&|?+-*%~^<>'.includes(prevSig)) {
      i++; while (i < html.length && html[i] !== '/') { if (html[i] === '\\') i++; i++; }
      prevSig = '/'; continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return html.slice(start, i + 1); }
    if (!/\s/.test(ch)) prevSig = ch;
  }
  throw new Error('unbalanced braces for: ' + name);
}

let passed = 0, failed = 0;
function check(name, cond, extra) { if (cond) { passed++; console.log('  ✓', name); } else { failed++; console.log('  ✗', name, extra !== undefined ? JSON.stringify(extra) : ''); } }

console.log('\n=== Category Manager (Workstream A) — RC-1/RC-2/RC-3 + V2 ===\n');

// -------------------------------------------------------------------------
// Sandbox factory: builds a fresh, isolated copy of the real functions
// (extracted from index.html) each time so tests never leak state.
// -------------------------------------------------------------------------
function buildSandbox() {
  const factorySrc = [
    'var settings = {};',
    'var recipes = [];',
    'var materials = [];',
    'var posCategoryFilter = "";',
    'var _saveAllCalls = 0;',
    'var _toasts = [];',
    'var _confirmAnswer = true;',
    'var _renders = 0;',
    'function saveAll(){ _saveAllCalls++; }',
    'function renderPosCatManagerBody(){ _renders++; }',
    'function renderPosCategoryBar(){}',
    'function renderPosGrid(){}',
    'function esc(s){ return String(s==null?"":s); }',
    'function posSellableMats(){ return materials.filter(function(m){ return m.showInPos && m.saleType===\"SELLABLE\"; }); }',
    'function matById(id){ return materials.find(function(m){ return m.id===id; }) || null; }',
    'function recById(id){ return recipes.find(function(r){ return r.id===id; }) || null; }',
    'var ui = { toast: function(m,t){ _toasts.push({m:m,t:t}); }, confirm: function(){ return Promise.resolve(_confirmAnswer); } };',
    extractFn('mergePosCategories'),
    extractFn('visiblePosCategories'),
    extractFn('posCatArchivedList'),
    extractFn('posCatIsArchived'),
    extractFn('posCatItemCount'),
    extractFn('posCatAdd'),
    extractFn('posCatRemove'),
    extractFn('posCatDeleteConfirm'),
    extractFn('posCatMove'),
    extractFn('posCatReorder'),
    extractFn('posCatRename'),
    extractFn('posCatArchive'),
    extractFn('posCatUnarchive'),
    'return {',
    '  setSettings:function(s){settings=s;}, setRecipes:function(r){recipes=r;}, setMaterials:function(m){materials=m;},',
    '  setConfirm:function(v){_confirmAnswer=v;},',
    '  saveAllCalls:function(){return _saveAllCalls;}, toasts:function(){return _toasts;}, clearToasts:function(){_toasts=[];},',
    '  mergePosCategories:mergePosCategories, visiblePosCategories:visiblePosCategories,',
    '  posCatArchivedList:posCatArchivedList, posCatIsArchived:posCatIsArchived, posCatItemCount:posCatItemCount,',
    '  posCatAdd:posCatAdd, posCatRemove:posCatRemove, posCatDeleteConfirm:posCatDeleteConfirm, posCatMove:posCatMove,',
    '  posCatReorder:posCatReorder, posCatRename:posCatRename, posCatArchive:posCatArchive, posCatUnarchive:posCatUnarchive,',
    '  getSettings:function(){return settings;}, getRecipes:function(){return recipes;}, getMaterials:function(){return materials;}',
    '};',
  ].join('\n');
  return new Function(factorySrc)();
}

// =========================================================================
// 1. wizard-merge: mergePosCategories — union, order preserved, nothing lost
// =========================================================================
console.log('--- 1. RC-1 wizard-merge ---');
{
  const M = buildSandbox();
  check('1a existing+incoming union, order preserved, nothing lost',
    JSON.stringify(M.mergePosCategories(['A', 'B'], ['B', 'C'])) === JSON.stringify(['A', 'B', 'C']));
  check('1b incoming empty → existing unchanged',
    JSON.stringify(M.mergePosCategories(['A', 'B'], [])) === JSON.stringify(['A', 'B']));
  check('1c existing empty + incoming → just incoming',
    JSON.stringify(M.mergePosCategories([], ['X', 'Y'])) === JSON.stringify(['X', 'Y']));
  check('1d existing not array → treated as empty, incoming used',
    JSON.stringify(M.mergePosCategories(null, ['X'])) === JSON.stringify(['X']));
  check('1e whitespace/exact-match dedup (trim compare)',
    JSON.stringify(M.mergePosCategories(['กาแฟ'], [' กาแฟ ', 'ชา'])) === JSON.stringify(['กาแฟ', 'ชา']));
}

// =========================================================================
// 2. posCatAdd source-contract: push (append), duplicate guard, empty guard,
//    NO whole-array assignment (the RC-1 bug pattern: settings.posCategories = X)
// =========================================================================
console.log('\n--- 2. posCatAdd source-contract ---');
{
  const src = extractFn('posCatAdd');
  check('2a contains .push( (append, never replaces)', /\.push\s*\(/.test(src), src);
  check('2b has empty-name guard', /if\s*\(\s*!name\s*\)\s*return/.test(src), src);
  check('2c has duplicate guard (includes check + toast)', /\.includes\s*\(\s*name\s*\)/.test(src) && /toast/.test(src), src);
  check('2d contains NO whole-array assignment (settings.posCategories = [...] / = arr)',
    !/settings\.posCategories\s*=\s*(\[|[a-zA-Z_$][\w$]*\.(slice|map|filter))/.test(src.replace(/settings\.posCategories\s*=\s*\[\];/, '')), src);
}

// =========================================================================
// 3. Enter-safety: newPosCat input's keydown handler must preventDefault
// =========================================================================
console.log('\n--- 3. Enter-safety (newPosCat) ---');
{
  const idx = html.indexOf('id="newPosCat"');
  check('3a newPosCat input exists', idx !== -1);
  const tagEnd = html.indexOf('>', idx);
  const tag = html.slice(Math.max(0, idx - 20), tagEnd + 1);
  check('3b keydown handler present', /onkeydown="/.test(tag), tag);
  check('3c Enter key handled', /event\.key\s*===\s*'Enter'/.test(tag), tag);
  check('3d preventDefault called before posCatAdd (cannot submit/close a parent form)',
    /preventDefault\(\)/.test(tag) && tag.indexOf('preventDefault') < tag.indexOf('posCatAdd()'), tag);
}

// =========================================================================
// 4. RC-2: payload builder sends _posCategoriesRaw when set; parse-fallback
//    sets _posCategoriesRaw on catch (regex contract against the real source)
// =========================================================================
console.log('\n--- 4. RC-2 payload + parse-fallback contract ---');
{
  const syncFnSrc = extractFn('syncToSupabase');
  check('4a payload pos_categories field references _posCategoriesRaw',
    /pos_categories\s*:\s*settings\._posCategoriesRaw/.test(syncFnSrc), syncFnSrc.match(/pos_categories:[^\n]*/));
  const bootstrapFnSrc = extractFn('applyBootstrapData');
  check('4b parse-fallback (catch) sets a raw-fail variable from the raw string',
    /catch\s*\(e\)\s*\{\s*_posCatRawFail\s*=\s*sRow\.pos_categories/.test(bootstrapFnSrc), true);
  check('4c settings object carries _posCategoriesRaw from that variable',
    /_posCategoriesRaw\s*:\s*_posCatRawFail/.test(bootstrapFnSrc), true);
  check('4d one-time toast warns the owner (contact admin, does not silently fix)',
    /หมวดหน้าขายอ่านไม่สำเร็จ/.test(bootstrapFnSrc) && /_posCatRawWarned/.test(bootstrapFnSrc), true);
}

// =========================================================================
// 5. RC-3 server guard: sync.js rejects a payload that WRITES pos_categories
//    with no _base_version; the original non-null version-mismatch guard is
//    unchanged. Scoped to pos_categories (not shop_settings as a whole) —
//    see judgment-call note below and in sync.js: a blanket "shop_settings
//    present + no _base_version" guard breaks legacy full-sync permission
//    tests (backend/test/permissions.test.js PA3/PA7/PA17) that intentionally
//    omit _base_version while touching unrelated shop_settings fields.
// =========================================================================
console.log('\n--- 5. RC-3 server guard (sync.js) ---');
{
  check('5a original version-mismatch guard present unchanged',
    /if\s*\(\s*b\._base_version\s*!=\s*null\s*&&\s*Number\(b\._base_version\)\s*!==\s*current\s*\)/.test(syncSrc));
  check('5b new reject branch exists: shop_settings.pos_categories present + _base_version == null',
    /if\s*\(\s*b\.shop_settings\s*&&\s*b\.shop_settings\.pos_categories\s*!==\s*undefined\s*&&\s*b\._base_version\s*==\s*null\s*\)/.test(syncSrc));
  // the new branch must throw the same typed CONFLICT shape as the existing guard (same res.status(409) path)
  const marker = "if (b.shop_settings && b.shop_settings.pos_categories !== undefined && b._base_version == null)";
  const guardBlock = syncSrc.slice(syncSrc.indexOf(marker), syncSrc.indexOf(marker) + 260);
  check('5c new branch throws the same version_conflict/CONFLICT shape', /CONFLICT/.test(guardBlock) && /currentVersion/.test(guardBlock), guardBlock);
  check('5d the 409 handler shape (version_conflict) still exists once, shared by both guards',
    (syncSrc.match(/version_conflict/g) || []).length >= 1 && /res\.status\(409\)\.json\(\{ error: 'version_conflict'/.test(syncSrc));
  // 5e: a payload that writes OTHER shop_settings fields (not pos_categories) without _base_version
  // must NOT trip the new guard — this is exactly the legacy-compat shape PA3/PA7/PA17 exercise live.
  check('5e narrow guard does not match a shop_settings payload lacking pos_categories',
    !/if\s*\(\s*b\.shop_settings\s*&&\s*b\._base_version\s*==\s*null\s*\)/.test(syncSrc), true);
}

// =========================================================================
// 6. posCatRemove(i) removes exactly one; other entries intact (pure logic)
// =========================================================================
console.log('\n--- 6. posCatRemove ---');
{
  const M = buildSandbox();
  M.setSettings({ posCategories: ['A', 'B', 'C', 'D'] });
  M.posCatRemove(1);
  const after = M.getSettings().posCategories;
  check('6a removes exactly one', after.length === 3, after);
  check('6b other entries intact, in order', JSON.stringify(after) === JSON.stringify(['A', 'C', 'D']), after);
  check('6c saveAll invoked (persists the change)', M.saveAllCalls() === 1);
}

// =========================================================================
// 7. Rename mass-update: posCatRename updates matching product categories
//    only, count correct
// =========================================================================
console.log('\n--- 7. posCatRename mass-update ---');
{
  const M = buildSandbox();
  M.setSettings({ posCategories: ['เครื่องดื่ม', 'ขนม'], menuConfig: {} });
  M.setRecipes([
    { id: 'r1', category: 'เครื่องดื่ม', onMenu: true, isRaw: false },
    { id: 'r2', category: 'ขนม', onMenu: true, isRaw: false },
    { id: 'r3', category: 'เครื่องดื่ม', onMenu: true, isRaw: false },
  ]);
  M.setMaterials([
    { id: 'm1', category: 'เครื่องดื่ม', showInPos: true, saleType: 'SELLABLE' },
    { id: 'm2', category: 'ขนม', showInPos: true, saleType: 'SELLABLE' },
  ]);
  M.posCatRename(0, 'เครื่องดื่มเย็น');
  const s = M.getSettings();
  const recsAfter = M.getRecipes();
  const matsAfter = M.getMaterials();
  check('7a category array updated at the renamed index', s.posCategories[0] === 'เครื่องดื่มเย็น', s.posCategories);
  check('7b matching recipes renamed (r1 + r3, both were "เครื่องดื่ม")',
    recsAfter.find(r => r.id === 'r1').category === 'เครื่องดื่มเย็น' && recsAfter.find(r => r.id === 'r3').category === 'เครื่องดื่มเย็น',
    recsAfter);
  check('7c non-matching recipe (r2, "ขนม") left untouched', recsAfter.find(r => r.id === 'r2').category === 'ขนม', recsAfter);
  check('7d untouched category (ขนม) unaffected in the list', s.posCategories[1] === 'ขนม');
  check('7d2 matching material (m1) renamed, non-matching (m2) untouched',
    matsAfter.find(m => m.id === 'm1').category === 'เครื่องดื่มเย็น' && matsAfter.find(m => m.id === 'm2').category === 'ขนม', matsAfter);
  check('7e count toast mentions the right number of updated items (2 recipes + 1 material = 3)',
    M.toasts().some(t => /ปรับ 3 รายการ/.test(t.m)), M.toasts());
}
// (separately re-verify the actual objects passed in were mutated correctly)
{
  const M = buildSandbox();
  const r1 = { id: 'r1', category: 'เครื่องดื่ม', onMenu: true, isRaw: false };
  const r2 = { id: 'r2', category: 'ขนม', onMenu: true, isRaw: false };
  M.setSettings({ posCategories: ['เครื่องดื่ม', 'ขนม'], menuConfig: {} });
  M.setRecipes([r1, r2]);
  M.setMaterials([]);
  M.posCatRename(0, 'เย็น');
  check('7f matching recipe object mutated to new category', r1.category === 'เย็น', r1);
  check('7g non-matching recipe object left alone', r2.category === 'ขนม', r2);
}

// =========================================================================
// 8. visiblePosCategories() excludes archived entries
// =========================================================================
console.log('\n--- 8. visiblePosCategories (archive exclusion) ---');
{
  const M = buildSandbox();
  M.setSettings({ posCategories: ['A', 'B', 'C'], menuConfig: { pos_categories_archived: ['B'] } });
  const vis = M.visiblePosCategories();
  check('8a archived category excluded', !vis.includes('B'), vis);
  check('8b non-archived categories kept, order preserved', JSON.stringify(vis) === JSON.stringify(['A', 'C']), vis);
}
{
  const M = buildSandbox();
  M.setSettings({ posCategories: ['A', 'B'], menuConfig: {} });
  check('8c no archived list → all visible', JSON.stringify(M.visiblePosCategories()) === JSON.stringify(['A', 'B']));
}
{
  const M = buildSandbox();
  M.setSettings({ posCategories: ['A', 'B', 'C'], menuConfig: { pos_categories_archived: ['A', 'C'] } });
  M.posCatUnarchive(0); // "A" restored
  const vis = M.visiblePosCategories();
  check('8d posCatUnarchive restores visibility', vis.includes('A') && !vis.includes('C'), vis);
  M.posCatArchive(1); // archive "B" (current index 1 after no removal — array itself never shrinks on archive)
  const vis2 = M.visiblePosCategories();
  check('8e posCatArchive hides without removing from posCategories', !vis2.includes('B') && M.getSettings().posCategories.includes('B'), { vis2, cats: M.getSettings().posCategories });
}

// =========================================================================
// Extra: posCatDeleteConfirm shows impact count then delegates to posCatRemove
// =========================================================================
console.log('\n--- 9. posCatDeleteConfirm (delete impact + confirm) ---');
(async () => {
  const M = buildSandbox();
  M.setSettings({ posCategories: ['เครื่องดื่ม', 'ขนม'] });
  M.setRecipes([{ id: 'r1', category: 'เครื่องดื่ม', onMenu: true, isRaw: false }]);
  M.setMaterials([{ id: 'm1', category: 'เครื่องดื่ม', showInPos: true, saleType: 'SELLABLE' }]);
  check('9a posCatItemCount counts recipe+material matches', M.posCatItemCount('เครื่องดื่ม') === 2);
  M.setConfirm(true);
  await M.posCatDeleteConfirm(0);
  check('9b confirmed delete removes the category', !M.getSettings().posCategories.includes('เครื่องดื่ม'), M.getSettings().posCategories);

  const M2 = buildSandbox();
  M2.setSettings({ posCategories: ['เครื่องดื่ม', 'ขนม'] });
  M2.setConfirm(false);
  await M2.posCatDeleteConfirm(0);
  check('9c cancelled delete leaves category intact', M2.getSettings().posCategories.includes('เครื่องดื่ม'), M2.getSettings().posCategories);

  console.log('\n=== Results: ' + passed + ' passed, ' + failed + ' failed ===');
  process.exit(failed > 0 ? 1 : 0);
})().catch((err) => {
  console.error('UNEXPECTED ERROR:', err.message, err.stack);
  process.exit(1);
});
