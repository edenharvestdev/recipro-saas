// Category Management incident hotfix — pure unit tests (no DB, no browser).
// node backend/test/category-hotfix.test.js
//
// Context: production incident — a real shop's POS category list was wiped.
// This file proves the Founder's 15 acceptance requirements against the REAL
// shipped code, not a re-implementation:
//   • frontend functions are extracted from frontend/index.html by brace-matched
//     regex and eval'd inside a minimal sandbox (same technique the other
//     index.html-sourced suites here use). If a function is renamed or deleted,
//     extraction throws and the suite fails loudly rather than silently
//     testing nothing.
//   • backend guards are extracted from backend/src/api/sync.js the same way,
//     so the RC-3 + audit contracts are asserted without a Postgres pool.
//
// Founder requirements 1-15 are labelled F1..F15 below.
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log('  ✓', name); }
  else { failed++; console.log('  ✗', name, extra !== undefined ? JSON.stringify(extra) : ''); }
}

// Sources are CRLF in this repo — normalize to LF so the extraction regexes
// below behave identically regardless of the checkout's line endings.
const readSrc = (p) => fs.readFileSync(path.join(__dirname, p), 'utf8').replace(/\r\n/g, '\n');
const INDEX_SRC = readSrc('../../frontend/index.html');
const SYNC_SRC = readSrc('../src/api/sync.js');

// ---------------------------------------------------------------------------
// Extraction helpers — pull real declarations out of the shipped sources.
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
// Strip // comments so "what the code does" assertions are not fooled by
// prose that quotes the old buggy line (the RC-1 fix documents it verbatim).
function stripComments(src) {
  return src.split('\n').map(l => l.replace(/(^|\s)\/\/.*$/, '$1')).join('\n');
}
function extractConst(src, name) {
  const re = new RegExp('const\\s+' + name + '\\s*=\\s*([\\s\\S]*?);\\n');
  const m = re.exec(src);
  if (!m) throw new Error('cannot find const ' + name + ' in source');
  return m[1];
}

// Every category function the sandbox links together, in source order.
const FRONT_FNS = [
  'mergePosCategories', 'posCatArchivedList', 'posCatIsArchived', 'visiblePosCategories',
  'posCatItemCount', 'posCatSetArchivedList', 'posCatSnapshotProducts', 'posCatRestoreProducts',
  'posCatCorrelation', 'posCatAuditPush', 'posCatAuditClear', 'posCatSaveNow', 'posCatCommit',
  'posCatStatusHtml', 'posCatSetStatus',
  'posCatAdd', 'posCatRemove', 'posCatDeleteUnplaced', 'posCatReassign',
  'posCatMove', 'posCatReorder', 'posCatRename', 'posCatArchive', 'posCatUnarchive',
];
const F = {};
for (const n of FRONT_FNS) F[n] = extractFn(INDEX_SRC, n, 'frontend/index.html');

const POS_CAT_STATUS_TEXT_SRC = extractConst(INDEX_SRC, 'POS_CAT_STATUS_TEXT');
const POS_CAT_AUDIT_ACTIONS_SRC = extractConst(INDEX_SRC, 'POS_CAT_AUDIT_ACTIONS');

// ---------------------------------------------------------------------------
// Sandbox: the smallest environment the extracted category code touches.
// Everything that is NOT category logic is stubbed, so a failure here means the
// category logic itself is wrong. `saveMode` drives the injected save result.
// ---------------------------------------------------------------------------
function build(opts) {
  opts = opts || {};
  const env = {
    settings: opts.settings || { posCategories: [], menuConfig: {} },
    recipes: opts.recipes || [],
    materials: opts.materials || [],
    saveMode: opts.saveMode || 'ok',   // 'ok' | 'fail' | 'conflict'
    saveCalls: 0,
    toasts: [],
    conflictHandled: false,
    sentQueues: [],   // one entry per sync attempt: the _category_audit rows it carried
    input: { value: opts.inputValue != null ? opts.inputValue : '' },
    hasInput: opts.inputValue != null,
  };
  const preamble = `
    let _posCatEditingIdx = null, _posCatSuppressBlur = false;
    let _posCatStatus = null, _posCatStatusTimer = null, _posCatInlineSave = false;
    const POS_CAT_STATUS_TEXT = ${POS_CAT_STATUS_TEXT_SRC};
    const POS_CAT_AUDIT_ACTIONS = ${POS_CAT_AUDIT_ACTIONS_SRC};
    let posCategoryFilter = '';
    let syncTimeout = null;
    const window = { _categoryAuditQueue: [] };
    const document = { getElementById: (id) => ((id === 'newPosCat' && ENV.hasInput) ? ENV.input : null) };
    const ui = { toast: (msg, kind) => ENV.toasts.push({ msg, kind }) };
    const setTimeout = () => 0;
    const clearTimeout = () => {};
    const settings = ENV.settings;
    const recipes = ENV.recipes;
    const materials = ENV.materials;
    function posSellableMats() { return materials.filter(m => m.showInPos && m.saleType === 'SELLABLE'); }
    function renderPosCatManagerBody() {}
    function renderPosCategoryBar() {}
    function handleSyncConflict() { ENV.conflictHandled = true; }
    async function syncToSupabase() {
      ENV.saveCalls++;
      // Record exactly what _category_audit would carry on this sync — this is
      // the real hand-off point to the server-side audit writer.
      ENV.sentQueues.push(JSON.parse(JSON.stringify(window._categoryAuditQueue)));
      if (ENV.saveMode === 'fail') { const e = new Error('boom'); e.status = 500; throw e; }
      if (ENV.saveMode === 'conflict') { const e = new Error('version_conflict'); e.status = 409; throw e; }
    }
  `;
  const body = FRONT_FNS.map(n => F[n]).join('\n\n');
  const factory = new Function('ENV', preamble + '\n' + body + `
    return {
      ${FRONT_FNS.join(', ')},
      getStatus: () => _posCatStatus,
      getQueue: () => window._categoryAuditQueue,
    };
  `);
  const api = factory(env);
  api.ENV = env;
  return api;
}

// Server-side normalizer, rebuilt from the real sync.js source (no DB import).
function buildNormalizer() {
  const normSrc = extractFn(SYNC_SRC, 'normalizeCategoryAudit', 'sync.js');
  const actionsSrc = /const CATEGORY_AUDIT_ACTIONS = new Set\(\[([\s\S]*?)\]\);/.exec(SYNC_SRC)[1];
  const max = /const CATEGORY_AUDIT_MAX = (\d+)/.exec(SYNC_SRC)[1];
  const strMax = /const CATEGORY_AUDIT_STR_MAX = (\d+)/.exec(SYNC_SRC)[1];
  return new Function(`
    const CATEGORY_AUDIT_ACTIONS = new Set([${actionsSrc}]);
    const CATEGORY_AUDIT_MAX = ${max};
    const CATEGORY_AUDIT_STR_MAX = ${strMax};
    ${normSrc}
    return normalizeCategoryAudit;
  `)();
}

(async () => {
  console.log('\n=== Category Management hotfix — Founder acceptance (F1-F15) ===\n');

  // -------------------------------------------------------------------------
  // F1 — existing categories survive add (RC-1: merge, never whole-array replace)
  // -------------------------------------------------------------------------
  {
    const api = build();
    check('F1 merge keeps existing + appends new (no drop, order preserved)',
      JSON.stringify(api.mergePosCategories(['กาแฟ', 'ชา'], ['ชา', 'ขนม'])) === JSON.stringify(['กาแฟ', 'ชา', 'ขนม']));
    check('F1 merge with empty incoming keeps every existing category',
      JSON.stringify(api.mergePosCategories(['กาแฟ', 'ชา'], [])) === JSON.stringify(['กาแฟ', 'ชา']));
    check('F1 merge tolerates null existing and takes incoming',
      JSON.stringify(api.mergePosCategories(null, ['ก'])) === JSON.stringify(['ก']));
    check('F1 merge is trim-exact (padded duplicate is not re-added)',
      JSON.stringify(api.mergePosCategories(['กาแฟ'], ['  กาแฟ  '])) === JSON.stringify(['กาแฟ']));
    // The incident itself: wizFinish must merge, never assign the array.
    // (comments stripped — the fix's own comment quotes the old buggy line)
    const wizFinishSrc = stripComments(extractFn(INDEX_SRC, 'wizFinish', 'frontend/index.html'));
    check('F1 wizFinish merges instead of replacing posCategories wholesale',
      /settings\.posCategories\s*=\s*mergePosCategories\(/.test(wizFinishSrc) &&
      !/settings\.posCategories\s*=\s*wizState\.cats\.slice\(\)/.test(wizFinishSrc));
    // Adding through the manager must also preserve what is already there.
    const api2 = build({ inputValue: 'ขนม', settings: { posCategories: ['กาแฟ', 'ชา'], menuConfig: {} } });
    await api2.posCatAdd();
    check('F1 add appends without disturbing existing categories',
      JSON.stringify(api2.ENV.settings.posCategories) === JSON.stringify(['กาแฟ', 'ชา', 'ขนม']));
  }

  // -------------------------------------------------------------------------
  // F2 — Enter cannot replace the list (preventDefault contract)
  // -------------------------------------------------------------------------
  {
    const managerSrc = extractFn(INDEX_SRC, 'openPosCatManager', 'frontend/index.html');
    check('F2 newPosCat Enter handler calls preventDefault before posCatAdd (no submit/reload)',
      /onkeydown="if\(event\.key==='Enter'\)\{event\.preventDefault\(\);posCatAdd\(\);\}"/.test(managerSrc));
    const renameRow = extractFn(INDEX_SRC, 'renderPosCatManagerBody', 'frontend/index.html');
    check('F2 inline rename Enter/Escape also preventDefault (never submits the page)',
      /if\(event\.key==='Enter'\)\{event\.preventDefault\(\);/.test(renameRow) &&
      /event\.key==='Escape'\)\{event\.preventDefault\(\);/.test(renameRow));
    const api = build({ settings: { posCategories: ['กาแฟ', 'ชา'], menuConfig: {} } });
    await api.posCatAdd();   // no #newPosCat element → must be an inert no-op
    check('F2 add with no input element leaves the list untouched',
      JSON.stringify(api.ENV.settings.posCategories) === JSON.stringify(['กาแฟ', 'ชา']) && api.ENV.saveCalls === 0);
  }

  // -------------------------------------------------------------------------
  // F3 — empty / invalid input cannot wipe the list
  // -------------------------------------------------------------------------
  {
    for (const v of ['', '   ', '\t']) {
      const api = build({ inputValue: v, settings: { posCategories: ['กาแฟ', 'ชา'], menuConfig: {} } });
      await api.posCatAdd();
      check(`F3 add ${JSON.stringify(v)} adds nothing and wipes nothing`,
        JSON.stringify(api.ENV.settings.posCategories) === JSON.stringify(['กาแฟ', 'ชา']) && api.ENV.saveCalls === 0,
        api.ENV.settings.posCategories);
    }
    const dup = build({ inputValue: 'ชา', settings: { posCategories: ['กาแฟ', 'ชา'], menuConfig: {} } });
    await dup.posCatAdd();
    check('F3 duplicate name warns explicitly, changes nothing, saves nothing',
      JSON.stringify(dup.ENV.settings.posCategories) === JSON.stringify(['กาแฟ', 'ชา']) &&
      dup.ENV.saveCalls === 0 && dup.ENV.toasts.some(t => /มีหมวด/.test(t.msg) && t.kind === 'warning'),
      dup.ENV.toasts);
    const padded = build({ inputValue: '  ชา  ', settings: { posCategories: ['ชา'], menuConfig: {} } });
    await padded.posCatAdd();
    check('F3 padded duplicate is caught by trim-exact comparison (no silent duplicate name)',
      JSON.stringify(padded.ENV.settings.posCategories) === JSON.stringify(['ชา']) && padded.ENV.saveCalls === 0);
  }

  // -------------------------------------------------------------------------
  // F4 — a parse failure cannot persist an empty replacement (_posCategoriesRaw)
  // -------------------------------------------------------------------------
  {
    const bootstrapSrc = extractFn(INDEX_SRC, 'applyBootstrapData', 'frontend/index.html');
    check('F4 bootstrap captures a pos_categories JSON.parse failure into _posCategoriesRaw',
      /_posCatRawFail\s*=\s*sRow\.pos_categories/.test(bootstrapSrc) &&
      /_posCategoriesRaw:\s*_posCatRawFail/.test(bootstrapSrc));
    check('F4 bootstrap warns the operator once per session',
      /_posCatRawWarned\s*=\s*true/.test(bootstrapSrc) && /หมวดหน้าขายอ่านไม่สำเร็จ/.test(bootstrapSrc));
    const syncFnSrc = extractFn(INDEX_SRC, 'syncToSupabase', 'frontend/index.html');
    check('F4 sync payload sends the RAW string back verbatim while _posCategoriesRaw is set',
      /pos_categories:\s*settings\._posCategoriesRaw\s*\?\s*settings\._posCategoriesRaw\s*:/.test(syncFnSrc));
    // The exact payload expression, both states.
    const payloadPosCats = (s) => (s._posCategoriesRaw ? s._posCategoriesRaw : (Array.isArray(s.posCategories) ? s.posCategories : []));
    check('F4 broken raw data is echoed back, NOT the empty in-memory array',
      payloadPosCats({ _posCategoriesRaw: '["กาแฟ","ชา"', posCategories: [] }) === '["กาแฟ","ชา"');
    check('F4 after explicit repair the in-memory list is what gets written',
      JSON.stringify(payloadPosCats({ _posCategoriesRaw: null, posCategories: ['กาแฟ'] })) === JSON.stringify(['กาแฟ']));
    const repairSrc = extractFn(INDEX_SRC, 'posCatRepair', 'frontend/index.html');
    check('F4 repair is explicit + confirmed, never automatic',
      /await ui\.confirm\(/.test(repairSrc) && /if \(!ok\) return;/.test(repairSrc) &&
      repairSrc.indexOf('ui.confirm') < repairSrc.indexOf('_posCategoriesRaw = null'));
  }

  // -------------------------------------------------------------------------
  // F5 — a failed API save preserves the previous list (posCatCommit restore)
  // -------------------------------------------------------------------------
  {
    const api = build({ inputValue: 'ขนม', settings: { posCategories: ['กาแฟ', 'ชา'], menuConfig: {} }, saveMode: 'fail' });
    const r = await api.posCatAdd();
    check('F5 failed save reports failure', r && r.ok === false && r.reason === 'save_failed', r);
    check('F5 failed save restores the previous list exactly (no optimistic leftovers)',
      JSON.stringify(api.ENV.settings.posCategories) === JSON.stringify(['กาแฟ', 'ชา']),
      api.ENV.settings.posCategories);
    check('F5 failed save shows "บันทึกไม่สำเร็จ" inline, never "บันทึกแล้ว"', api.getStatus() === 'failed');

    const recipes = [{ id: 'r1', category: 'กาแฟ', isRaw: false }];
    const api2 = build({ settings: { posCategories: ['กาแฟ'], menuConfig: {} }, recipes, saveMode: 'fail' });
    await api2.posCatRename(0, 'กาแฟสด');
    check('F5 failed rename rolls back BOTH the category list and the product assignments',
      api2.ENV.settings.posCategories[0] === 'กาแฟ' && recipes[0].category === 'กาแฟ',
      { cats: api2.ENV.settings.posCategories, rec: recipes[0].category });

    const api3 = build({ settings: { posCategories: ['A', 'B'], menuConfig: {} }, saveMode: 'fail' });
    await api3.posCatArchive(0);
    check('F5 failed archive rolls back the archived list too',
      JSON.stringify(api3.ENV.settings.menuConfig.pos_categories_archived) === JSON.stringify([]) &&
      JSON.stringify(api3.visiblePosCategories()) === JSON.stringify(['A', 'B']));
  }

  // -------------------------------------------------------------------------
  // F6 — version conflict blocks the second writer (RC-3 + 409 contract)
  // -------------------------------------------------------------------------
  {
    const guardSrc = extractFn(SYNC_SRC, 'posCategoriesWriteNeedsBaseVersion', 'sync.js');
    const guard = new Function('return ' + guardSrc)();
    check('F6 pos_categories write without _base_version is rejected',
      guard({ shop_settings: { pos_categories: ['ก'] } }) === true);
    check('F6 pos_categories write WITH _base_version passes the RC-3 guard',
      guard({ shop_settings: { pos_categories: ['ก'] }, _base_version: 3 }) === false);
    check('F6 _base_version: 0 (a legitimate first version) is accepted',
      guard({ shop_settings: { pos_categories: ['ก'] }, _base_version: 0 }) === false);
    check('F6 RC-3 stays narrow — a settings payload without pos_categories is untouched',
      guard({ shop_settings: { phone: '02', staff_permissions: {} } }) === false);
    check('F6 RC-3 does not fire for payloads with no shop_settings (legacy partial sync)',
      guard({ materials: [] }) === false && guard({}) === false);
    check('F6 explicit null pos_categories still requires a base version',
      guard({ shop_settings: { pos_categories: null } }) === true);
    check('F6 guard is wired into the sync route with the existing CONFLICT/409 shape',
      /if \(posCategoriesWriteNeedsBaseVersion\(b\)\) \{[\s\S]{0,200}err\.code = 'CONFLICT'/.test(SYNC_SRC) &&
      /res\.status\(409\)\.json\(\{ error: 'version_conflict'/.test(SYNC_SRC));

    // client: a 409 must not become a silent overwrite
    const api = build({ inputValue: 'ขนม', settings: { posCategories: ['กาแฟ', 'ชา'], menuConfig: {} }, saveMode: 'conflict' });
    const r = await api.posCatAdd();
    check('F6 second writer blocked: 409 reported, list restored, no latest-write-wins',
      r && r.ok === false && r.reason === 'version_conflict' &&
      JSON.stringify(api.ENV.settings.posCategories) === JSON.stringify(['กาแฟ', 'ชา']), r);
    check('F6 conflict shows the Thai "ต้องรีเฟรช" status (not a silent retry)', api.getStatus() === 'conflict');
    check('F6 conflict status offers a refresh action',
      /posCatConflictRefresh\(\)/.test(F.posCatStatusHtml));
    check('F6 all four Thai statuses exist verbatim',
      /กำลังบันทึก…/.test(POS_CAT_STATUS_TEXT_SRC) && /บันทึกแล้ว/.test(POS_CAT_STATUS_TEXT_SRC) &&
      /บันทึกไม่สำเร็จ/.test(POS_CAT_STATUS_TEXT_SRC) && /พบการแก้ไขจากที่อื่น — ต้องรีเฟรช/.test(POS_CAT_STATUS_TEXT_SRC));
    check('F6 manager 409s route to the inline handler instead of an immediate global reload',
      /if \(e && e\.status === 409\) \{ if \(_posCatInlineSave\) throw e; handleSyncConflict\(\); return; \}/.test(INDEX_SRC));
  }

  // -------------------------------------------------------------------------
  // F7 — reorder persists
  // -------------------------------------------------------------------------
  {
    const api = build({ settings: { posCategories: ['A', 'B', 'C', 'D'], menuConfig: {} } });
    await api.posCatReorder(0, 2);
    check('F7 drag-reorder moves the item to the target index (not a neighbour swap)',
      JSON.stringify(api.ENV.settings.posCategories) === JSON.stringify(['B', 'C', 'A', 'D']),
      api.ENV.settings.posCategories);
    check('F7 reorder was persisted (save invoked)', api.ENV.saveCalls === 1);
    await api.posCatReorder(3, 0);
    check('F7 reorder to the head works',
      JSON.stringify(api.ENV.settings.posCategories) === JSON.stringify(['D', 'B', 'C', 'A']));
    const before = api.ENV.settings.posCategories.slice();
    await api.posCatReorder(1, 1);
    check('F7 no-op reorder neither reorders nor re-saves',
      JSON.stringify(api.ENV.settings.posCategories) === JSON.stringify(before) && api.ENV.saveCalls === 2);
    await api.posCatReorder(0, 99);
    check('F7 out-of-range target is clamped, never drops an item', api.ENV.settings.posCategories.length === 4);
    await api.posCatMove(0, 1);
    check('F7 posCatMove still swaps neighbours and persists', api.ENV.saveCalls === 4);
    check('F7 keyboard alternative (Alt+Up/Down) is wired to the reorder path',
      /function posCatRowKeydown\(e, i\) \{[\s\S]{0,260}altKey[\s\S]{0,220}posCatMove\(i, -1\)/.test(INDEX_SRC));
    check('F7 drag-and-drop is primary (HTML5 DnD + ~300ms touch long-press + auto-scroll)',
      /ondragstart="posCatDragStart/.test(INDEX_SRC) && /onpointerdown="posCatPointerDown/.test(INDEX_SRC) &&
      /}, 300\);/.test(F.posCatReorder ? INDEX_SRC : INDEX_SRC) && /wrap\.scrollTop -= 12/.test(INDEX_SRC));
  }

  // -------------------------------------------------------------------------
  // F8 — rename changes only the selected category's references
  // -------------------------------------------------------------------------
  {
    const recipes = [
      { id: 'r1', category: 'กาแฟ', isRaw: false },
      { id: 'r2', category: 'ชา', isRaw: false },
      { id: 'r3', category: 'กาแฟ', isRaw: false },
    ];
    const materials = [
      { id: 'm1', category: 'กาแฟ', showInPos: true, saleType: 'SELLABLE' },
      { id: 'm2', category: 'ขนม', showInPos: true, saleType: 'SELLABLE' },
    ];
    const api = build({ settings: { posCategories: ['กาแฟ', 'ชา', 'ขนม'], menuConfig: {} }, recipes, materials });
    await api.posCatRename(0, 'กาแฟสด');
    check('F8 renamed label updated in place (order preserved)',
      JSON.stringify(api.ENV.settings.posCategories) === JSON.stringify(['กาแฟสด', 'ชา', 'ขนม']));
    check('F8 only matching products were re-pointed',
      recipes[0].category === 'กาแฟสด' && recipes[2].category === 'กาแฟสด' && materials[0].category === 'กาแฟสด');
    check('F8 non-matching products untouched',
      recipes[1].category === 'ชา' && materials[1].category === 'ขนม');
    const before = api.ENV.settings.posCategories.slice();
    await api.posCatRename(0, 'ชา');
    check('F8 rename onto an existing name is refused with an explicit warning (no silent merge)',
      JSON.stringify(api.ENV.settings.posCategories) === JSON.stringify(before) &&
      api.ENV.toasts.some(t => /มีหมวด/.test(t.msg) && t.kind === 'warning'));
    await api.posCatRename(0, '   ');
    check('F8 empty rename cancels — the exact display label is preserved',
      api.ENV.settings.posCategories[0] === 'กาแฟสด');
    // archived entry follows a rename so the hide state is not orphaned
    const api2 = build({ settings: { posCategories: ['A'], menuConfig: { pos_categories_archived: ['A'] } } });
    await api2.posCatRename(0, 'A2');
    check('F8 rename keeps the archived flag pointing at the renamed category',
      JSON.stringify(api2.ENV.settings.menuConfig.pos_categories_archived) === JSON.stringify(['A2']));
  }

  // -------------------------------------------------------------------------
  // F9 — archive hides but preserves products
  // -------------------------------------------------------------------------
  {
    const recipes = [{ id: 'r1', category: 'ชา', isRaw: false }];
    const materials = [{ id: 'm1', category: 'ชา', showInPos: true, saleType: 'SELLABLE' }];
    const api = build({ settings: { posCategories: ['กาแฟ', 'ชา'], menuConfig: {} }, recipes, materials });
    await api.posCatArchive(1);
    check('F9 archived category hidden from the POS bar / pickers',
      JSON.stringify(api.visiblePosCategories()) === JSON.stringify(['กาแฟ']));
    check('F9 archived category still exists in the stored list (not deleted)',
      JSON.stringify(api.ENV.settings.posCategories) === JSON.stringify(['กาแฟ', 'ชา']));
    check('F9 archive lives in menuConfig.pos_categories_archived (no schema change)',
      JSON.stringify(api.ENV.settings.menuConfig.pos_categories_archived) === JSON.stringify(['ชา']));
    check('F9 products keep their category assignment through archive',
      recipes[0].category === 'ชา' && materials[0].category === 'ชา');
    check('F9 item count still resolves for the archived category', api.posCatItemCount('ชา') === 2);
    await api.posCatArchive(0);
    check('F9 archiving every category yields an empty visible list',
      JSON.stringify(api.visiblePosCategories()) === JSON.stringify([]));
    // The POS bar's back-compat fallback must key off "are categories configured",
    // not "are any visible" — otherwise hiding them all makes product-inferred
    // chips reappear, i.e. archive silently stops hiding.
    const barSrc = extractFn(INDEX_SRC, 'renderPosCategoryBar', 'frontend/index.html');
    check('F9 POS bar fallback is driven by configured categories, not visible ones',
      /const configured = Array\.isArray\(settings\.posCategories\)/.test(barSrc) &&
      /configured\.length \? visiblePosCategories\(\)/.test(barSrc));
  }

  // -------------------------------------------------------------------------
  // F10 — restore returns the same category + assignments
  // -------------------------------------------------------------------------
  {
    const recipes = [{ id: 'r1', category: 'ชา', isRaw: false }];
    const materials = [{ id: 'm1', category: 'ชา', showInPos: true, saleType: 'SELLABLE' }];
    const api = build({ settings: { posCategories: ['กาแฟ', 'ชา'], menuConfig: {} }, recipes, materials });
    await api.posCatArchive(1);
    await api.posCatUnarchive(1);
    check('F10 restored category is visible again — same label, same position',
      JSON.stringify(api.visiblePosCategories()) === JSON.stringify(['กาแฟ', 'ชา']));
    check('F10 archived list is empty after restore',
      JSON.stringify(api.ENV.settings.menuConfig.pos_categories_archived) === JSON.stringify([]));
    check('F10 assignments survive the archive→restore round trip',
      recipes[0].category === 'ชา' && materials[0].category === 'ชา' && api.posCatItemCount('ชา') === 2);
  }

  // -------------------------------------------------------------------------
  // F11 — delete WITH assigned products is BLOCKED
  // -------------------------------------------------------------------------
  {
    const recipes = [{ id: 'r1', category: 'ชา', isRaw: false }, { id: 'r2', category: 'ชา', isRaw: false }];
    const api = build({ settings: { posCategories: ['กาแฟ', 'ชา'], menuConfig: {} }, recipes });
    const r = await api.posCatRemove(1);
    check('F11 ordinary delete of a category with products is BLOCKED',
      r && r.ok === false && r.reason === 'has_products' && r.count === 2, r);
    check('F11 blocked delete leaves the category in place',
      JSON.stringify(api.ENV.settings.posCategories) === JSON.stringify(['กาแฟ', 'ชา']));
    check('F11 blocked delete never reached the API', api.ENV.saveCalls === 0);
    check('F11 blocked delete never touched the products',
      recipes[0].category === 'ชา' && recipes[1].category === 'ชา');
    const r2 = await api.posCatRemove(1, { allowUnplaced: true });
    check('F11 delete proceeds ONLY with the explicit unplaced intent', r2 && r2.ok === true, r2);
    check('F11 products are never deleted — they keep their category string',
      recipes[0].category === 'ชา' && recipes[1].category === 'ชา');

    const api2 = build({ settings: { posCategories: ['ชา'], menuConfig: {} }, recipes: [{ id: 'x', category: 'ชา', isRaw: false }] });
    check('F11 a plain confirm/OK is NOT permission to orphan products',
      (await api2.posCatRemove(0, { confirmed: true })).reason === 'has_products');
    check('F11 allowUnplaced must be exactly true (no truthy coercion)',
      (await api2.posCatRemove(0, { allowUnplaced: 'yes' })).reason === 'has_products' &&
      (await api2.posCatRemove(0, { allowUnplaced: 1 })).reason === 'has_products');

    const dlgSrc = extractFn(INDEX_SRC, 'posCatDeleteDialog', 'frontend/index.html');
    check('F11 dialog offers exactly the three paths and states the impact count',
      /posCatDeleteReassign/.test(dlgSrc) && /posCatDeleteUnplaced/.test(dlgSrc) &&
      /ยกเลิก/.test(dlgSrc) && /ยังมีสินค้าผูกอยู่/.test(dlgSrc));
    check('F11 unplaced path is gated behind a checkbox-level second confirmation',
      /posCatDelAck/.test(dlgSrc) && /disabled/.test(dlgSrc) &&
      /if \(!chk \|\| !chk\.checked\)/.test(F.posCatDeleteUnplaced));
    check('F11 archive stays freely available as the non-destructive alternative',
      /posCatArchive\(/.test(dlgSrc));
    const confirmSrc = extractFn(INDEX_SRC, 'posCatDeleteConfirm', 'frontend/index.html');
    check('F11 the UI delete entry point routes non-empty categories to the 3-path dialog',
      /if \(n === 0\)/.test(confirmSrc) && /posCatDeleteDialog\(i, name, n\)/.test(confirmSrc));
  }
  {
    const recipes = [{ id: 'r1', category: 'ชา', isRaw: false }];
    const api = build({ settings: { posCategories: ['กาแฟ', 'ชา'], menuConfig: {} }, recipes });
    await api.posCatReassign('ชา', 'กาแฟ');
    check('F11 reassign moves the products to the target category', recipes[0].category === 'กาแฟ');
    check('F11 after reassign the emptied category reports zero items', api.posCatItemCount('ชา') === 0);
    const r = await api.posCatRemove(1);
    check('F11 delete of the now-empty category succeeds',
      r && r.ok === true && JSON.stringify(api.ENV.settings.posCategories) === JSON.stringify(['กาแฟ']));
  }

  // -------------------------------------------------------------------------
  // F12 — delete with zero assignments allowed only after an explicit confirm
  // -------------------------------------------------------------------------
  {
    const confirmSrc = extractFn(INDEX_SRC, 'posCatDeleteConfirm', 'frontend/index.html');
    check('F12 zero-assignment delete awaits ui.confirm and aborts on cancel',
      /const ok = await ui\.confirm\(/.test(confirmSrc) && /if \(!ok\) return;/.test(confirmSrc) &&
      confirmSrc.indexOf('ui.confirm') < confirmSrc.indexOf('posCatRemove(i)'));
    check('F12 the confirm is a danger-styled explicit dialog, not a bare OK',
      /danger: true/.test(confirmSrc) && /okText: 'ลบหมวด'/.test(confirmSrc));
    const api = build({ settings: { posCategories: ['กาแฟ', 'ว่าง'], menuConfig: {} } });
    const r = await api.posCatRemove(1);
    check('F12 zero-assignment delete proceeds once confirmed',
      r && r.ok === true && JSON.stringify(api.ENV.settings.posCategories) === JSON.stringify(['กาแฟ']));
    check('F12 deleting a non-existent index is a safe no-op',
      (await api.posCatRemove(99)).reason === 'not_found' &&
      JSON.stringify(api.ENV.settings.posCategories) === JSON.stringify(['กาแฟ']));
  }

  // -------------------------------------------------------------------------
  // F13 — category ops never mutate recipe/BOM/option/price/stock/historical data
  // -------------------------------------------------------------------------
  {
    const FORBIDDEN = [
      ['recipe_items', /recipe_items/],
      ['BOM items', /\.items\b/],
      ['option groups/choices', /optGroups|option_groups|optionGroups|option_choices|editGroupChoices/],
      ['sell price', /\.sell\b|sell_price|priceAdd|price_add|\.priceAdd/],
      ['stock fields', /\.stock\b|fgStock|fg_stock|lowStock|stockMovements|pushMovement/],
      ['historical orders/bills', /\bbills\b|\borders\b|prodLogs/],
    ];
    const CATEGORY_FN_NAMES = [
      'posCatAdd', 'posCatRemove', 'posCatDeleteConfirm', 'posCatDeleteUnplaced', 'posCatDeleteDialog',
      'posCatReassign', 'posCatMove', 'posCatReorder', 'posCatRename', 'posCatArchive', 'posCatUnarchive',
      'posCatCommit', 'posCatItemCount', 'visiblePosCategories', 'posCatArchivedList', 'mergePosCategories',
      'posCatSnapshotProducts', 'posCatRestoreProducts',
    ];
    const offenders = [];
    for (const fn of CATEGORY_FN_NAMES) {
      const src = extractFn(INDEX_SRC, fn, 'frontend/index.html');
      for (const [label, re] of FORBIDDEN) if (re.test(src)) offenders.push(fn + ' → ' + label);
    }
    check('F13 no category function references recipe/BOM/option/price/stock/historical fields',
      offenders.length === 0, offenders);

    // Behavioural proof: a full round of category ops leaves everything but `category` intact.
    const recipe = { id: 'r1', name: 'ชาเย็น', category: 'ชา', isRaw: false, sell: 45, items: [{ matId: 'm9', amount: 3 }], optGroups: ['g1'], fgStock: 12 };
    const material = { id: 'm1', name: 'ใบชา', category: 'ชา', showInPos: true, saleType: 'SELLABLE', price: 10, sellPrice: 25, stock: 88 };
    const before = JSON.parse(JSON.stringify({ r: recipe, m: material }));
    const api = build({ settings: { posCategories: ['ชา', 'กาแฟ'], menuConfig: {} }, recipes: [recipe], materials: [material] });
    await api.posCatRename(0, 'ชาไทย');
    await api.posCatArchive(0);
    await api.posCatUnarchive(0);
    await api.posCatReorder(0, 1);
    await api.posCatReassign('ชาไทย', 'กาแฟ');
    const after = JSON.parse(JSON.stringify({ r: recipe, m: material }));
    delete after.r.category; delete before.r.category;
    delete after.m.category; delete before.m.category;
    check('F13 every non-category field of the recipe/material is byte-identical after category ops',
      JSON.stringify(after) === JSON.stringify(before), { before, after });
    check('F13 the only thing category ops changed is the category string',
      recipe.category === 'กาแฟ' && material.category === 'กาแฟ');
    check('F13 assignment writes the product category string only — never recipe_items/BOM',
      /r\.category = to/.test(F.posCatReassign) && /m\.category = to/.test(F.posCatReassign));
  }

  // -------------------------------------------------------------------------
  // F14 — every successful state change emits the expected granular audit event
  // -------------------------------------------------------------------------
  {
    // `seen` = every audit row handed to a sync, flattened across attempts.
    // (Reading the live queue would miss rows: a successful commit clears it.)
    const auditOf = async (fn, setup) => {
      const api = build(setup);
      await fn(api);
      const seen = [].concat.apply([], api.ENV.sentQueues);
      return { seen, api };
    };
    let r = await auditOf(a => a.posCatAdd(), { inputValue: 'ขนม', settings: { posCategories: ['กาแฟ'], menuConfig: {} } });
    check('F14 category.create emitted with the new value',
      r.seen.length === 1 && r.seen[0].action === 'category.create' && r.seen[0].new === 'ขนม' && r.seen[0].old === null, r.seen);
    check('F14 audit event carries correlation + result + timestamp',
      !!r.seen[0].correlation && r.seen[0].result === 'ok' && !!r.seen[0].at);
    check('F14 queue cleared after a successful save (no duplicate rows next sync)', r.api.getQueue().length === 0);

    r = await auditOf(a => a.posCatRename(0, 'กาแฟสด'), {
      settings: { posCategories: ['กาแฟ'], menuConfig: {} },
      recipes: [{ id: 'r1', category: 'กาแฟ', isRaw: false }, { id: 'r2', category: 'กาแฟ', isRaw: false }],
    });
    check('F14 category.rename records old→new and the affected product count',
      r.seen[0].action === 'category.rename' && r.seen[0].old === 'กาแฟ' && r.seen[0].new === 'กาแฟสด' && r.seen[0].count === 2, r.seen);

    r = await auditOf(a => a.posCatReorder(0, 2), { settings: { posCategories: ['A', 'B', 'C'], menuConfig: {} } });
    check('F14 category.reorder records the index move',
      r.seen[0].action === 'category.reorder' && r.seen[0].old === '0' && r.seen[0].new === '2', r.seen);

    r = await auditOf(a => a.posCatArchive(0), { settings: { posCategories: ['A'], menuConfig: {} } });
    check('F14 category.archive emitted', r.seen[0].action === 'category.archive' && r.seen[0].old === 'A');

    r = await auditOf(async a => { await a.posCatArchive(0); await a.posCatUnarchive(0); }, { settings: { posCategories: ['A'], menuConfig: {} } });
    check('F14 category.restore emitted', r.seen.some(x => x.action === 'category.restore'));

    r = await auditOf(a => a.posCatRemove(0), { settings: { posCategories: ['A'], menuConfig: {} } });
    check('F14 category.delete emitted with old value and count',
      r.seen[0].action === 'category.delete' && r.seen[0].old === 'A' && r.seen[0].new === null && r.seen[0].count === 0);

    r = await auditOf(a => a.posCatReassign('A', 'B'), {
      settings: { posCategories: ['A', 'B'], menuConfig: {} },
      recipes: [{ id: 'r1', category: 'A', isRaw: false }],
    });
    check('F14 category.assignment_change emitted with from→to and count',
      r.seen[0].action === 'category.assignment_change' && r.seen[0].old === 'A' && r.seen[0].new === 'B' && r.seen[0].count === 1, r.seen);

    const api = build({ settings: { posCategories: [], menuConfig: {} } });
    api.posCatAuditPush({ action: 'category.wipe_everything', old: 'x' });
    check('F14 unknown audit actions are rejected client-side', api.getQueue().length === 0);

    // Server side: the real normalizer → one logs row per event.
    const norm = buildNormalizer();
    const rows = norm([{ action: 'category.rename', old: 'A', new: 'B', count: 3, correlation: 'c1', result: 'ok', at: '2026-07-16T00:00:00Z' }]);
    check('F14 server emits one row per event with action=category.<kind> + full detail',
      rows.length === 1 && rows[0].action === 'category.rename' && rows[0].detail.old === 'A' &&
      rows[0].detail.new === 'B' && rows[0].detail.count === 3 && rows[0].detail.correlation === 'c1' &&
      rows[0].detail.result === 'ok', rows);
    check('F14 server drops unknown actions',
      norm([{ action: 'settings.wipe' }, { action: 'category.create', new: 'x' }]).length === 1);
    check('F14 server caps the number of audit rows per sync',
      norm(Array.from({ length: 500 }, () => ({ action: 'category.create', new: 'x' }))).length === 50);
    check('F14 server ignores a non-array _category_audit',
      norm('not-an-array').length === 0 && norm(undefined).length === 0 && norm(null).length === 0);
    check('F14 server strips unknown fields (never logs secrets or full payloads)',
      Object.keys(norm([{ action: 'category.create', new: 'x', token: 'SECRET', payload: { all: 'data' } }])[0].detail)
        .sort().join(',') === 'at,correlation,count,new,old,reason,result');
    check('F14 server truncates over-long strings instead of storing them whole',
      norm([{ action: 'category.create', new: 'x'.repeat(5000) }])[0].detail.new.length === 200);
    check('F14 audit route wiring writes one logEvent per normalized entry',
      /for \(const ev of normalizeCategoryAudit\(b\._category_audit\)\) \{\s*logEvent\(shopId, req\.userId, ev\.action, ev\.detail\);/.test(SYNC_SRC));
    check('F14 client attaches the audit queue to the sync payload',
      /_category_audit: Array\.isArray\(window\._categoryAuditQueue\)/.test(INDEX_SRC));
  }

  // -------------------------------------------------------------------------
  // F15 — a failed state change creates failure evidence without corrupting the list
  // -------------------------------------------------------------------------
  {
    const api = build({ inputValue: 'ขนม', settings: { posCategories: ['กาแฟ', 'ชา'], menuConfig: {} }, saveMode: 'fail' });
    const r = await api.posCatAdd();
    const q = api.getQueue();
    check('F15 failed change is reported, not swallowed', r && r.ok === false);
    check('F15 list is exactly the pre-mutation snapshot',
      JSON.stringify(api.ENV.settings.posCategories) === JSON.stringify(['กาแฟ', 'ชา']));
    check('F15 failure evidence recorded with result=failed + reason',
      q.length === 1 && q[0].action === 'category.create' && q[0].result === 'failed' && q[0].reason === 'save_failed', q);
    check('F15 the failed change is NOT also recorded as a success', !q.some(x => x.result === 'ok'));
    check('F15 status shown is failure, never "saved"', api.getStatus() === 'failed');

    const api2 = build({ inputValue: 'ขนม', settings: { posCategories: ['กาแฟ'], menuConfig: {} }, saveMode: 'conflict' });
    await api2.posCatAdd();
    check('F15 conflict evidence records reason=version_conflict',
      api2.getQueue().some(x => x.result === 'failed' && x.reason === 'version_conflict'));
    check('F15 conflict leaves the list uncorrupted',
      JSON.stringify(api2.ENV.settings.posCategories) === JSON.stringify(['กาแฟ']));

    const norm = buildNormalizer();
    const failRow = norm([{ action: 'category.delete', old: 'A', result: 'failed', reason: 'version_conflict' }])[0];
    check('F15 server persists failure rows with their reason',
      failRow.detail.result === 'failed' && failRow.detail.reason === 'version_conflict');
    check('F15 a success row never carries a stale failure reason',
      norm([{ action: 'category.delete', old: 'A', result: 'ok', reason: 'should_be_dropped' }])[0].detail.reason === null);
  }

  console.log(`\ncategory-hotfix: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
