// POS Operations Manager (P0) — extraction-style acceptance tests, no DB / no browser.
// node backend/test/pos-operations.test.js
//
// Follows the same technique as backend/test/category-hotfix.test.js: real functions are pulled
// out of the SHIPPED source (backend/src/api/sync.js, sync-guard.js, clone.js, migrate.js,
// permissions/catalog.js, frontend/index.html, frontend/styles.css) by brace-matched extraction
// or plain require(), then exercised directly. A rename/deletion of any of these makes the
// extraction throw and the suite fail loudly, rather than silently testing nothing.
//
// Scope: the four concepts stay separated —
//   A recipe inclusion (on_menu/show_in_pos, unchanged)
//   B menu availability (NEW: pos_available / pos_unavailable_reason — this file)
//   C category visibility (pre-existing posCatArchive/posCatUnarchive, untouched)
//   D stock health (unchanged — never coupled to B here)
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log('  ✓', name); }
  else { failed++; console.log('  ✗', name, extra !== undefined ? JSON.stringify(extra) : ''); }
}

const readSrc = (p) => fs.readFileSync(path.join(__dirname, p), 'utf8').replace(/\r\n/g, '\n');
const INDEX_SRC = readSrc('../../frontend/index.html');
const STYLES_SRC = readSrc('../../frontend/styles.css');
const SYNC_SRC = readSrc('../src/api/sync.js');
const GUARD_SRC = readSrc('../src/api/sync-guard.js');
const CLONE_SRC = readSrc('../src/api/clone.js');
const MIGRATE_SRC = readSrc('../src/migrate.js');
const SCHEMA_SRC = readSrc('../db/schema-pos-ops.sql');

// ---------------------------------------------------------------------------
// Extraction helpers (same brace-matching technique as category-hotfix.test.js)
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

(async () => {
  console.log('\n=== POS Operations Manager (P0) — extraction acceptance ===\n');

  // -------------------------------------------------------------------------
  // 1) SCHEMA — additive, idempotent, correct defaults
  // -------------------------------------------------------------------------
  check('SCH1 recipes.pos_available additive boolean default true',
    /alter table recipes\s+add column if not exists pos_available boolean not null default true/.test(SCHEMA_SRC));
  check('SCH2 recipes.pos_unavailable_reason additive nullable text',
    /alter table recipes\s+add column if not exists pos_unavailable_reason text default null/.test(SCHEMA_SRC));
  check('SCH3 materials.pos_available additive boolean default true',
    /alter table materials add column if not exists pos_available boolean not null default true/.test(SCHEMA_SRC));
  check('SCH4 materials.pos_unavailable_reason additive nullable text',
    /alter table materials add column if not exists pos_unavailable_reason text default null/.test(SCHEMA_SRC));
  {
    const codeLines = SCHEMA_SRC.split('\n').map((l) => l.replace(/--.*$/, '').trim()).filter(Boolean);
    const addColumnLines = codeLines.filter((l) => /^alter table \S+\s+add column\b/.test(l));
    const constraintLines = codeLines.filter((l) => /^alter table \S+\s+add constraint\b/.test(l));
    const dropConstraintLines = codeLines.filter((l) => /^alter table \S+\s+drop constraint\b/.test(l));
    check('SCH5a every "add column" statement is guarded with "if not exists"',
      addColumnLines.length > 0 && addColumnLines.every((l) => /if not exists/.test(l)), addColumnLines);
    check('SCH5b every "add constraint" is preceded by a matching "drop constraint if exists" (idempotent replace, not a crash on re-run)',
      constraintLines.length > 0 && dropConstraintLines.length === constraintLines.length &&
      dropConstraintLines.every((l) => /if exists/.test(l)), { constraintLines, dropConstraintLines });
  }
  check('SCH6 reason length capped at the DB layer too (defense in depth beyond app-layer cap)',
    /check \(char_length\(pos_unavailable_reason\) <= 200\)/.test(SCHEMA_SRC));

  // -------------------------------------------------------------------------
  // 2) MIGRATE — schema file is actually registered and runs before seed.sql
  // -------------------------------------------------------------------------
  const filesArr = /const files = \[([\s\S]*?)\];/.exec(MIGRATE_SRC)[1];
  check('MIG1 schema-pos-ops.sql is registered in migrate.js', /schema-pos-ops\.sql/.test(filesArr));
  const posOpsIdx = filesArr.indexOf('schema-pos-ops.sql');
  const seedIdx = filesArr.indexOf('seed.sql');
  check('MIG2 registered before seed.sql (so seed data can rely on the columns existing)',
    posOpsIdx !== -1 && seedIdx !== -1 && posOpsIdx < seedIdx);

  // -------------------------------------------------------------------------
  // 3) SYNC.JS — whitelist + NOT-NULL safety (the exact bug class this file guards against:
  //    a client that omits pos_available entirely must never reach the INSERT as NULL)
  // -------------------------------------------------------------------------
  const matCols = /upsertRows\(client, 'materials',\s*\[([\s\S]*?)\]/.exec(SYNC_SRC)[1];
  const recCols = /upsertRows\(client, 'recipes',\s*\[([\s\S]*?)\]/.exec(SYNC_SRC)[1];
  check('SYN1 materials sync whitelist carries pos_available', /'pos_available'/.test(matCols));
  check('SYN2 materials sync whitelist carries pos_unavailable_reason', /'pos_unavailable_reason'/.test(matCols));
  check('SYN3 recipes sync whitelist carries pos_available', /'pos_available'/.test(recCols));
  check('SYN4 recipes sync whitelist carries pos_unavailable_reason', /'pos_unavailable_reason'/.test(recCols));
  check('SYN5 materials row-build coerces pos_available to a real boolean (never lets undefined/null through to a NOT NULL column)',
    /pos_available:\s*m\.pos_available === false \? false : true/.test(SYNC_SRC));
  check('SYN6 recipes row-build coerces pos_available the same way',
    /pos_available:\s*r\.pos_available === false \? false : true/.test(SYNC_SRC));

  // normalizeAvailabilityAudit — extract the REAL function + REAL constants, run it directly.
  function buildAvailabilityNormalizer() {
    const normSrc = extractFn(SYNC_SRC, 'normalizeAvailabilityAudit', 'sync.js');
    const actionsSrc = /const AVAILABILITY_AUDIT_ACTIONS = new Set\(\[([\s\S]*?)\]\);/.exec(SYNC_SRC)[1];
    const typesSrc = /const AVAILABILITY_AUDIT_TARGET_TYPES = new Set\(\[([\s\S]*?)\]\);/.exec(SYNC_SRC)[1];
    const reasonsSrc = /const AVAILABILITY_REASONS = new Set\(\[([\s\S]*?)\]\);/.exec(SYNC_SRC)[1];
    const max = /const AVAILABILITY_AUDIT_MAX = (\d+)/.exec(SYNC_SRC)[1];
    const strMax = /const AVAILABILITY_AUDIT_STR_MAX = (\d+)/.exec(SYNC_SRC)[1];
    return new Function(`
      const AVAILABILITY_AUDIT_ACTIONS = new Set([${actionsSrc}]);
      const AVAILABILITY_AUDIT_TARGET_TYPES = new Set([${typesSrc}]);
      const AVAILABILITY_REASONS = new Set([${reasonsSrc}]);
      const AVAILABILITY_AUDIT_MAX = ${max};
      const AVAILABILITY_AUDIT_STR_MAX = ${strMax};
      ${normSrc}
      return normalizeAvailabilityAudit;
    `)();
  }
  const normAvail = buildAvailabilityNormalizer();
  check('SYN7 normalizer accepts a well-formed menu.availability_change event',
    normAvail([{ action: 'menu.availability_change', target_type: 'recipe', target_id: 'r1', target_name: 'Latte', old: true, new: false, reason: 'ของหมด', correlation: 'c1', at: '2026-07-18T00:00:00Z' }]).length === 1);
  check('SYN8 normalizer rejects unknown actions', normAvail([{ action: 'menu.wipe_everything' }]).length === 0);
  check('SYN9 normalizer rejects unknown target_type', normAvail([{ action: 'menu.availability_change', target_type: 'supplier' }]).length === 0);
  check('SYN10 normalizer caps at 50 events per sync',
    normAvail(Array.from({ length: 500 }, () => ({ action: 'menu.availability_change', target_type: 'material' }))).length === 50);
  check('SYN11 normalizer flags a controlled reason as reason_controlled=true',
    normAvail([{ action: 'menu.availability_change', target_type: 'recipe', reason: 'Seasonal' }])[0].detail.reason_controlled === true);
  check('SYN12 normalizer flags a free-text/non-listed reason as reason_controlled=false (never hidden, just marked)',
    normAvail([{ action: 'menu.availability_change', target_type: 'recipe', reason: 'สั่งจากลูกค้าพิเศษ' }])[0].detail.reason_controlled === false);
  check('SYN13 normalizer truncates an over-long reason instead of storing it whole',
    normAvail([{ action: 'menu.availability_change', target_type: 'material', reason: 'x'.repeat(5000) }])[0].detail.reason.length === 200);
  check('SYN14 normalizer coerces old/new to the literal strings available/unavailable only',
    normAvail([{ action: 'menu.availability_change', target_type: 'material', old: 'garbage', new: 'garbage' }])[0].detail.old === null &&
    normAvail([{ action: 'menu.availability_change', target_type: 'material', old: 'garbage', new: 'garbage' }])[0].detail.new === 'available');
  check('SYN15 normalizer tolerant of non-array input', normAvail('not-an-array').length === 0 && normAvail(undefined).length === 0 && normAvail(null).length === 0);

  check('SYN16 sync route writes one logs row per normalized availability event (action=menu.availability_change)',
    /for \(const ev of normalizeAvailabilityAudit\(b\._availability_audit\)\) \{\s*logEvent\(shopId, req\.userId, ev\.action, ev\.detail\);/.test(SYNC_SRC));

  // -------------------------------------------------------------------------
  // 4) PERMISSIONS CATALOG — additive key, fail-closed by default, explicit in front_store
  // -------------------------------------------------------------------------
  const catalog = require('../src/permissions/catalog');
  check('PRM1 pos_toggle_availability exists in the catalog (drives /api/permissions/catalog + my_permissions)',
    catalog.ALL_KEYS.includes('pos_toggle_availability'));
  check('PRM2 NOT a legacy alias target (no pre-existing shop can be silently granted it)',
    !Object.values(catalog.LEGACY_ALIASES).some((arr) => arr.includes('pos_toggle_availability')));
  check('PRM3 NOT in STAFF_DEFAULTS (a staff member with zero explicit config does not get it for free)',
    catalog.STAFF_DEFAULTS.pos_toggle_availability !== true);
  check('PRM4 front_store preset grants it (day-to-day "close a sold-out item" is front-of-house work)',
    catalog.PRESETS.front_store.pos_toggle_availability === true);
  check('PRM5 manager preset grants it (manager preset = ALL_KEYS minus escalation keys, and this is not one)',
    catalog.PRESETS.manager.pos_toggle_availability === true);
  check('PRM6 read_only preset does NOT grant it', catalog.PRESETS.read_only.pos_toggle_availability !== true);
  check('PRM7 owner/superadmin bypass still wins regardless (hasPerm short-circuits before any key lookup)',
    catalog.hasPerm({}, 'owner', false, 'pos_toggle_availability') === true &&
    catalog.hasPerm({}, 'staff', true, 'pos_toggle_availability') === true);
  check('PRM8 plain staff with no grant is denied (fail-closed)',
    catalog.hasPerm({}, 'staff', false, 'pos_toggle_availability') === false);
  check('PRM9 explicit grant on the key works', catalog.hasPerm({ pos_toggle_availability: true }, 'staff', false, 'pos_toggle_availability') === true);

  // -------------------------------------------------------------------------
  // 5) SYNC-GUARD.JS — server-side enforcement is real (not just frontend hiding), and does not
  //    punish plain creation of a brand-new (default-available) recipe/material.
  // -------------------------------------------------------------------------
  function buildAvailabilityChanged() {
    const rowChangedSrc = extractFn(GUARD_SRC, 'rowChanged', 'sync-guard.js');
    const normSrc = extractFn(GUARD_SRC, 'norm', 'sync-guard.js');
    const sortKeysSrc = extractFn(GUARD_SRC, 'sortKeys', 'sync-guard.js');
    const eqSrc = extractFn(GUARD_SRC, 'eq', 'sync-guard.js');
    const availSrc = extractFn(GUARD_SRC, 'availabilityChanged', 'sync-guard.js');
    return new Function(`
      ${normSrc}
      ${sortKeysSrc}
      ${eqSrc}
      ${rowChangedSrc}
      ${availSrc}
      return availabilityChanged;
    `)();
  }
  const availabilityChanged = buildAvailabilityChanged();
  check('GRD1 brand-new row with NO pos_available field (frontend default) needs no permission',
    availabilityChanged({ id: 'new1', name: 'x' }, undefined) === false);
  check('GRD2 brand-new row explicitly created closed DOES need the permission',
    availabilityChanged({ id: 'new2', pos_available: false }, undefined) === true);
  check('GRD3 brand-new row created with a reason but no explicit pos_available:false still needs the permission (reason implies intent)',
    availabilityChanged({ id: 'new3', pos_unavailable_reason: 'ของหมด' }, undefined) === true);
  check('GRD4 existing row, unchanged availability → no permission needed',
    availabilityChanged({ id: 'e1', pos_available: true, pos_unavailable_reason: null }, { pos_available: true, pos_unavailable_reason: null }) === false);
  check('GRD5 existing row flips available→unavailable → permission needed',
    availabilityChanged({ id: 'e2', pos_available: false }, { pos_available: true, pos_unavailable_reason: null }) === true);
  check('GRD6 existing row: reason text changes alone (still unavailable) → permission needed',
    availabilityChanged({ id: 'e3', pos_available: false, pos_unavailable_reason: 'Seasonal' }, { pos_available: false, pos_unavailable_reason: 'ของหมด' }) === true);
  check('GRD7 existing row: field omitted entirely by client → not asserted as a change',
    availabilityChanged({ id: 'e4', name: 'unrelated edit' }, { pos_available: false, pos_unavailable_reason: 'ของหมด' }) === false);

  check('GRD8 recipes loop enforces pos_toggle_availability with POS_AVAILABILITY_PERMISSION_DENIED',
    /for \(const r of b\.recipes\) \{\s*if \(availabilityChanged\(r, dbById\[r\.id\]\) && !has\('pos_toggle_availability'\)\) \{\s*throw deny\('POS_AVAILABILITY_PERMISSION_DENIED', 'recipes\.pos_available'\);/.test(GUARD_SRC));
  check('GRD9 materials loop enforces the same, independently of recipe_edit/recipe_edit_cost',
    /if \(availabilityChanged\(m, db\) && !has\('pos_toggle_availability'\)\) \{\s*throw deny\('POS_AVAILABILITY_PERMISSION_DENIED', 'materials\.pos_available'\);/.test(GUARD_SRC));

  // -------------------------------------------------------------------------
  // 6) CLONE.JS — every INSERT/UPDATE column list that writes recipes/materials carries the
  //    new columns (the "phantom-field silent-disable" bug class this task was warned about).
  // -------------------------------------------------------------------------
  const cloneHits = (CLONE_SRC.match(/pos_available/g) || []).length;
  check('CLN1 pos_available appears in all 6 write sites (2 selective-clone update, 2 selective-clone insert, 2 importIntoShop insert) — column + value each = 12 occurrences',
    cloneHits === 12, { cloneHits });
  check('CLN2 selective-clone materials UPDATE carries both new columns with safe fallbacks',
    /update materials set[\s\S]*?pos_available=\$18, pos_unavailable_reason=\$19[\s\S]*?m\.pos_available \?\? true, m\.pos_unavailable_reason \?\? null/.test(CLONE_SRC));
  check('CLN3 selective-clone materials INSERT carries both new columns with safe fallbacks',
    /insert into materials \([^)]*pos_available, pos_unavailable_reason\)[\s\S]{0,400}m\.pos_available \?\? true, m\.pos_unavailable_reason \?\? null\]/.test(CLONE_SRC));
  check('CLN4 selective-clone recipes UPDATE carries both new columns with safe fallbacks',
    /update recipes set[\s\S]*?pos_available=\$17, pos_unavailable_reason=\$18[\s\S]*?r\.pos_available \?\? true, r\.pos_unavailable_reason \?\? null/.test(CLONE_SRC));
  check('CLN5 selective-clone recipes INSERT carries both new columns with safe fallbacks',
    /insert into recipes \([^)]*pos_available, pos_unavailable_reason\)[\s\S]{0,700}r\.pos_available \?\? true, r\.pos_unavailable_reason \?\? null\]/.test(CLONE_SRC));
  check('CLN6 importIntoShop materials INSERT carries both new columns with safe fallbacks',
    /m\.pos_available \?\? true, m\.pos_unavailable_reason \?\? null\]\);\s*\n\s*out\.materials\+\+/.test(CLONE_SRC));
  check('CLN7 importIntoShop recipes INSERT carries both new columns with safe fallbacks',
    /r\.pos_available \?\? true, r\.pos_unavailable_reason \?\? null\]\);\s*\n\s*out\.recipes\+\+/.test(CLONE_SRC));

  // -------------------------------------------------------------------------
  // 7) FRONTEND — bootstrap mapping, sync payload, card rendering wiring, defense-in-depth gates
  // -------------------------------------------------------------------------
  check('FE1 applyBootstrapData maps materials.pos_available with a null-safe default of true (legacy row = fully available)',
    /posAvailable: \(m\.pos_available == null \? true : !!m\.pos_available\)/.test(INDEX_SRC));
  check('FE2 applyBootstrapData maps recipes.pos_available the same way',
    /posAvailable: \(r\.pos_available == null \? true : !!r\.pos_available\)/.test(INDEX_SRC));
  check('FE3 syncToSupabase always sends materials.pos_available as a real boolean (never omits it → never risks the NOT NULL 500)',
    /pos_available: m\.posAvailable !== false, pos_unavailable_reason: m\.posUnavailableReason \|\| null/.test(INDEX_SRC));
  check('FE4 syncToSupabase always sends recipes.pos_available the same way',
    /pos_available: r\.posAvailable !== false, pos_unavailable_reason: r\.posUnavailableReason \|\| null/.test(INDEX_SRC));
  check('FE5 sync payload attaches _availability_audit (client-reported intent, same pattern as _category_audit)',
    /_availability_audit: Array\.isArray\(window\._availabilityAuditQueue\)/.test(INDEX_SRC));

  // posItemAvailability — pure function, extract + run directly.
  const posItemAvailabilitySrc = extractFn(INDEX_SRC, 'posItemAvailability', 'frontend/index.html');
  const posItemAvailability = new Function('item', posItemAvailabilitySrc.slice(posItemAvailabilitySrc.indexOf('{') + 1, posItemAvailabilitySrc.lastIndexOf('}')));
  check('FE6 legacy item (posAvailable undefined) reads as fully available', posItemAvailability({ name: 'legacy' }).available === true);
  check('FE7 posAvailable:false item reads as unavailable with its reason', (() => { const s = posItemAvailability({ posAvailable: false, posUnavailableReason: 'ของหมด' }); return s.available === false && s.reason === 'ของหมด'; })());
  check('FE8 null/undefined item defensively reads as available (never crashes a render)', posItemAvailability(null).available === true && posItemAvailability(undefined).available === true);

  // Card wiring — every sellable-card branch must consult the availability gate. This is the exact
  // gap this task closed: the toggle/audit machinery existed but nothing on the actual POS card
  // read pos_available before rendering/allowing a sale.
  check('FE9 matCardHtml consults posItemAvailability before deciding the card class/click handler',
    /const matCardHtml = m => \{[\s\S]{0,400}posItemAvailability\(m\)/.test(INDEX_SRC));
  check('FE10 recCardHtml (all three inventory-mode branches) render the closed badge + manager toggle',
    (INDEX_SRC.match(/posAvailBadgeHtml\(r\)/g) || []).length === 3 &&
    (INDEX_SRC.match(/posMgrToggleBtnHtml\('recipe', r\.id\)/g) || []).length === 3);
  check('FE11 material card renders the closed badge + manager toggle too',
    INDEX_SRC.includes("posAvailBadgeHtml(m)") && INDEX_SRC.includes("posMgrToggleBtnHtml('material', m.id)"));
  check('FE12 posCardTapHandler routes a closed card to the manager sheet (if permitted) or a read-only reason toast (if not) — never to addToCart/addMatToCart',
    /function posCardTapHandler\(kind, id, item, sellableExpr\) \{\s*if \(!posItemAvailability\(item\)\.available\) \{\s*return can\('pos_toggle_availability'\) \? `openPosAvailabilitySheet/.test(INDEX_SRC));

  // Defense-in-depth: entry points OTHER than the card's own onclick (barcode scan, future callers)
  // must also refuse to sell a closed item.
  check('FE13 addToCart() itself refuses a closed recipe (belt-and-suspenders beyond the card onclick)',
    /function addToCart\(recipeId\) \{\s*const r = recById\(recipeId\);\s*if \(!r\) return;[\s\S]{0,300}if \(!posItemAvailability\(r\)\.available\) \{ posShowUnavailableReason\('recipe', recipeId\); return; \}/.test(INDEX_SRC));
  check('FE14 addMatToCart() itself refuses a closed material the same way',
    /function addMatToCart\(matId\) \{\s*const m = matById\(matId\);\s*if \(!m\) return;[\s\S]{0,200}if \(!posItemAvailability\(m\)\.available\) \{ posShowUnavailableReason\('material', matId\); return; \}/.test(INDEX_SRC));
  check('FE15 barcode-scan quick-add (posScanEnter) does not report a false "เพิ่ม: x" success when the matched item turned out to be closed',
    /if \(rec\) \{ found = true; addToCart\(rec\.id\); if \(posItemAvailability\(rec\)\.available\) hit = rec\.name; \}/.test(INDEX_SRC));

  // One-click manager toggle + compact sheet (the "compact manager surface" from the P0 spec).
  check('FE16 openPosAvailabilitySheet is permission-gated (fails closed for staff without the key)',
    /function openPosAvailabilitySheet\(kind, id\) \{\s*if \(!can\('pos_toggle_availability'\)\) \{ ui\.toast/.test(INDEX_SRC));
  check('FE17 posSetAvailability is permission-gated independently too (defense in depth vs. a stale/forced sheet open)',
    /function posSetAvailability\(kind, id, available, reason\) \{[\s\S]{0,200}if \(!can\('pos_toggle_availability'\)\)/.test(INDEX_SRC));
  check('FE18 the controlled reason list matches the Founder spec exactly',
    /const POS_AVAILABILITY_REASONS = \['ของหมด', 'ปิดขายชั่วคราว', 'ไม่ขายวันนี้', 'Seasonal', 'Kitchen unavailable', 'Other'\];/.test(INDEX_SRC));
  check('FE19 posSetAvailability records BOTH the mutation and an audit entry, then defers persistence to the existing debounced saveAll() (no competing auto-save path)',
    /item\.posAvailable = !!available;\s*item\.posUnavailableReason = cleanReason;\s*posAvailAuditPush\(/.test(INDEX_SRC) && /renderPosGrid\(\);\s*saveAll\(\);/.test(INDEX_SRC));

  // -------------------------------------------------------------------------
  // 8) CSS — closed-for-sale must be a distinct SHAPE/label, not merely a stock-warning color
  // -------------------------------------------------------------------------
  check('CSS1 .pos-mgr-closed is a distinct rule from .out-of-stock (own selector, own declarations)',
    /\.pos-product-card\.pos-mgr-closed \{/.test(STYLES_SRC) && /\.pos-product-card\.out-of-stock \{/.test(STYLES_SRC));
  check('CSS2 closed state renders a ribbon/label element (.ppc-closed-ribbon), not just a color/opacity change',
    /\.ppc-closed-ribbon \{/.test(STYLES_SRC) && /transform: rotate\(-40deg\)/.test(STYLES_SRC));
  check('CSS3 manager toggle affordance has its own visible control (.ppc-avail-toggle)',
    /\.ppc-avail-toggle \{/.test(STYLES_SRC));

  console.log('\n=== Results: ' + passed + ' passed, ' + failed + ' failed ===');
  process.exit(failed > 0 ? 1 : 0);
})();
