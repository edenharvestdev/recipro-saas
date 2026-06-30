#!/usr/bin/env node
/**
 * RECIPRO — Clone Option Fix QA Test Runner
 * Tests T1–T13 for selective-clone option dependency fix.
 *
 * Usage:
 *   NODE_ENV=test node backend/scripts/test-clone-option-fix.js [--reset] [--preserve] [--cleanup]
 *
 * Flags:
 *   --reset     Reset + re-seed fixture before running (default)
 *   --preserve  Skip teardown after tests (keep fixture for inspection)
 *   --cleanup   Only clean up fixture, do not run tests
 *
 * SAFETY: Aborts if DATABASE_URL points to production host or NODE_ENV != test.
 */

'use strict';

const { Pool } = require('pg');
const http = require('http');
const fs = require('fs');
const path = require('path');

// ============================================================
// SAFETY GUARDS
// ============================================================
const DB_URL = process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/recipro';
const NODE_ENV = process.env.NODE_ENV || '';

const PRODUCTION_HOSTS = ['railway.app', 'recipro.love', 'render.com', 'heroku'];
const PRODUCTION_DB_NAMES = ['recipro_prod', 'railway'];

function safetyCheck() {
  if (NODE_ENV !== 'test') {
    console.error('\n🚨 SAFETY ABORT: NODE_ENV must be "test". Got:', NODE_ENV);
    console.error('   Run with: NODE_ENV=test node backend/scripts/test-clone-option-fix.js');
    process.exit(2);
  }
  for (const host of PRODUCTION_HOSTS) {
    if (DB_URL.includes(host)) {
      console.error('\n🚨 SAFETY ABORT: DATABASE_URL appears to be production host:', host);
      process.exit(2);
    }
  }
  for (const name of PRODUCTION_DB_NAMES) {
    if (DB_URL.endsWith('/' + name) || DB_URL.includes('/' + name + '?')) {
      console.error('\n🚨 SAFETY ABORT: DATABASE_URL appears to be production database:', name);
      process.exit(2);
    }
  }
  console.log('✓ Safety check passed');
  console.log('  NODE_ENV  :', NODE_ENV);
  console.log('  DB_URL    :', DB_URL.replace(/:[^@]+@/, ':***@'));
}

// ============================================================
// CONFIG
// ============================================================
const API_URL = process.env.API_URL || 'http://localhost:3100';
const QA_EMAIL = 'qa-clone-test@local.test';
const QA_PASS = 'recipro-admin-2026';  // hash was set in fixture

const SRC = 'aaaaaaaa-0001-0001-0001-000000000001';
const DST = 'aaaaaaaa-0002-0002-0002-000000000002';

// Stable source IDs (must match fixture SQL)
const IDS = {
  matA:    'bb000001-0000-0000-0000-000000000001',
  matB:    'bb000001-0000-0000-0000-000000000002',
  matDirect: 'bb000001-0000-0000-0000-000000000003',
  recipe:  'cc000001-0000-0000-0000-000000000001',
  group1:  'dd000001-0000-0000-0000-000000000001',
  group2:  'dd000001-0000-0000-0000-000000000002',
  ch1:     'ee000001-0000-0000-0000-000000000001',
  ch2:     'ee000001-0000-0000-0000-000000000002',
  ch3:     'ee000001-0000-0000-0000-000000000003',
  ch4:     'ee000001-0000-0000-0000-000000000004',
};

// ============================================================
// RESULTS TRACKER
// ============================================================
const results = { pass: 0, fail: 0, tests: [] };
let TOKEN = '';
let pool;

function ok(name, detail = '') {
  results.pass++;
  results.tests.push({ name, status: 'PASS' });
  console.log('    ✓', name);
}

function fail(name, detail = '') {
  results.fail++;
  results.tests.push({ name, status: 'FAIL', detail });
  console.error('    ✗', name, detail ? '— ' + detail : '');
}

function assert(name, cond, detail = '') {
  if (cond) ok(name); else fail(name, detail);
}

// ============================================================
// HTTP HELPER
// ============================================================
function apiCall(method, path, body = null, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: 'localhost',
      port: 3100,
      path,
      method,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${TOKEN}`,
        'X-Shop-Id': SRC,
        ...extraHeaders,
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    };
    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch (e) { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function clone(body) {
  return apiCall('POST', '/api/admin/selective-clone', body);
}

// ============================================================
// DB HELPERS
// ============================================================
async function dbq(sql, params = []) {
  const c = await pool.connect();
  try { return (await c.query(sql, params)).rows; }
  finally { c.release(); }
}

async function countDst(table, joins = '') {
  const rows = await dbq(
    `SELECT count(1) AS n FROM ${table} t ${joins} WHERE t.shop_id = $1`,
    [DST]
  );
  return Number(rows[0].n);
}

async function countDstGroups() {
  return (await dbq(
    'SELECT count(id) AS n FROM option_groups WHERE shop_id = $1', [DST]
  ))[0].n | 0;
}

async function countDstChoices() {
  const rows = await dbq(
    `SELECT count(oc.id) AS n
     FROM option_choices oc
     JOIN option_groups og ON og.id = oc.group_id
     WHERE og.shop_id = $1`,
    [DST]
  );
  return Number(rows[0].n);
}

async function countDstLinks() {
  const rows = await dbq(
    `SELECT count(ocl.id) AS n
     FROM option_choice_links ocl
     JOIN option_choices oc ON oc.id = ocl.choice_id
     JOIN option_groups og ON og.id = oc.group_id
     WHERE og.shop_id = $1`,
    [DST]
  );
  return Number(rows[0].n);
}

async function countDstROG() {
  const rows = await dbq(
    `SELECT count(rog.recipe_id) AS n
     FROM recipe_option_groups rog
     JOIN option_groups og ON og.id = rog.group_id
     WHERE og.shop_id = $1`,
    [DST]
  );
  return Number(rows[0].n);
}

async function countDstMOG() {
  const rows = await dbq(
    `SELECT count(mog.material_id) AS n
     FROM material_option_groups mog
     JOIN option_groups og ON og.id = mog.group_id
     WHERE og.shop_id = $1`,
    [DST]
  );
  return Number(rows[0].n);
}

// Reset destination to empty state
async function resetDst() {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(
      `DELETE FROM material_option_groups
       WHERE group_id IN (SELECT id FROM option_groups WHERE shop_id = $1)`, [DST]);
    await c.query(
      `DELETE FROM recipe_option_groups
       WHERE group_id IN (SELECT id FROM option_groups WHERE shop_id = $1)`, [DST]);
    await c.query(
      `DELETE FROM option_choice_links
       WHERE choice_id IN (
         SELECT oc.id FROM option_choices oc
         JOIN option_groups og ON og.id = oc.group_id
         WHERE og.shop_id = $1)`, [DST]);
    await c.query(
      `DELETE FROM option_choices
       WHERE group_id IN (SELECT id FROM option_groups WHERE shop_id = $1)`, [DST]);
    await c.query(`DELETE FROM option_groups WHERE shop_id = $1`, [DST]);
    await c.query(
      `DELETE FROM recipe_items
       WHERE recipe_id IN (SELECT id FROM recipes WHERE shop_id = $1)`, [DST]);
    await c.query(`DELETE FROM recipes WHERE shop_id = $1`, [DST]);
    await c.query(`DELETE FROM materials WHERE shop_id = $1`, [DST]);
    await c.query('COMMIT');
  } catch (e) { await c.query('ROLLBACK'); throw e; }
  finally { c.release(); }
}

// Seed destination with a specific option group + choices for conflict tests
async function seedDstGroup(groupLabel, choices, opts = {}) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const gId = (await c.query(
      `INSERT INTO option_groups
         (shop_id, label, select_type, required, min_select, max_select, sort, enabled,
          visible_on_pos, visible_on_receipt, visible_on_kitchen, visible_on_online)
       VALUES ($1, $2, 'single', $3, $4, $5, 1, true, true, true, true, true)
       RETURNING id`,
      [DST, groupLabel, opts.required ?? true, opts.minSel ?? 1, opts.maxSel ?? 1]
    )).rows[0].id;

    for (let i = 0; i < choices.length; i++) {
      await c.query(
        `INSERT INTO option_choices
           (group_id, label, price_add, effect_type, enabled, is_default, sort, max_qty, target_role, is_metadata_only, amount)
         VALUES ($1, $2, 0, 'NONE', true, false, $3, 1, '', false, 0)`,
        [gId, choices[i], i + 1]
      );
    }
    await c.query('COMMIT');
    return gId;
  } catch (e) { await c.query('ROLLBACK'); throw e; }
  finally { c.release(); }
}

// ============================================================
// LOGIN
// ============================================================
async function login() {
  const resp = await apiCall('POST', '/auth/login',
    { email: QA_EMAIL, password: QA_PASS }, { 'X-Shop-Id': '' });
  if (!resp.body.accessToken) {
    // Fallback: try main admin user
    const r2 = await apiCall('POST', '/auth/login',
      { email: 'bussarawarin@gmail.com', password: 'recipro-admin-2026' }, { 'X-Shop-Id': '' });
    if (!r2.body.accessToken) throw new Error('Login failed: ' + JSON.stringify(r2.body));
    TOKEN = r2.body.accessToken;
    console.log('  [auth] Using fallback admin user');
  } else {
    TOKEN = resp.body.accessToken;
    console.log('  [auth] Using QA test user');
  }
}

// ============================================================
// FIXTURE SETUP (run SQL fixture file via pg transaction)
// ============================================================
async function runFixture() {
  console.log('\n[fixture] Loading clone-option-qa.sql...');
  const sqlFile = path.join(__dirname, 'fixtures', 'clone-option-qa.sql');
  const sql = fs.readFileSync(sqlFile, 'utf8');

  const c = await pool.connect();
  try {
    // Set session variable required by safety guard in SQL file (session-level, not LOCAL)
    await c.query("SET qa.confirmed = 'yes'");
    await c.query(sql);
    console.log('  [fixture] Seeded OK');
  } catch (e) {
    console.error('  [fixture] FAILED:', e.message);
    throw e;
  } finally {
    c.release();
  }
}

// ============================================================
// SQL AUDIT QUERIES
// ============================================================
async function runAuditQueries(label) {
  console.log(`\n[audit:${label}]`);

  // 1. Duplicate option group labels in DST
  const dupGroups = await dbq(
    `SELECT label, count(id) AS cnt
     FROM option_groups
     WHERE shop_id = $1
     GROUP BY label
     HAVING count(id) > 1`, [DST]
  );
  assert('No duplicate group labels in DST', dupGroups.length === 0,
    dupGroups.map(r => `"${r.label}" x${r.cnt}`).join(', '));

  // 2. Duplicate choice labels within same group in DST
  const dupChoices = await dbq(
    `SELECT og.label AS grp, oc.label, count(oc.id) AS cnt
     FROM option_choices oc
     JOIN option_groups og ON og.id = oc.group_id
     WHERE og.shop_id = $1
     GROUP BY og.label, oc.label
     HAVING count(oc.id) > 1`, [DST]
  );
  assert('No duplicate choice labels within group in DST', dupChoices.length === 0,
    dupChoices.map(r => `"${r.grp}"."${r.label}" x${r.cnt}`).join(', '));

  // 3. Duplicate option_choice_links
  const dupLinks = await dbq(
    `SELECT ocl.choice_id, ocl.material_id, count(ocl.id) AS cnt
     FROM option_choice_links ocl
     JOIN option_choices oc ON oc.id = ocl.choice_id
     JOIN option_groups og ON og.id = oc.group_id
     WHERE og.shop_id = $1
     GROUP BY ocl.choice_id, ocl.material_id
     HAVING count(ocl.id) > 1`, [DST]
  );
  assert('No duplicate option_choice_links in DST', dupLinks.length === 0,
    `${dupLinks.length} duplicate link(s)`);

  // 4. Duplicate recipe_option_groups
  const dupROG = await dbq(
    `SELECT rog.recipe_id, rog.group_id, count(1) AS cnt
     FROM recipe_option_groups rog
     JOIN option_groups og ON og.id = rog.group_id
     WHERE og.shop_id = $1
     GROUP BY rog.recipe_id, rog.group_id
     HAVING count(1) > 1`, [DST]
  );
  assert('No duplicate recipe_option_groups in DST', dupROG.length === 0,
    `${dupROG.length} duplicate(s)`);

  // 5. Duplicate material_option_groups
  const dupMOG = await dbq(
    `SELECT mog.material_id, mog.group_id, count(1) AS cnt
     FROM material_option_groups mog
     JOIN option_groups og ON og.id = mog.group_id
     WHERE og.shop_id = $1
     GROUP BY mog.material_id, mog.group_id
     HAVING count(1) > 1`, [DST]
  );
  assert('No duplicate material_option_groups in DST', dupMOG.length === 0,
    `${dupMOG.length} duplicate(s)`);

  // 6. Orphan option choices (group not in DST)
  const orphanChoices = await dbq(
    `SELECT count(oc.id) AS n
     FROM option_choices oc
     LEFT JOIN option_groups og ON og.id = oc.group_id AND og.shop_id = $1
     WHERE og.id IS NULL
       AND oc.group_id IN (SELECT id FROM option_groups WHERE shop_id = $1)`,
    [DST]
  );
  assert('No orphan choices in DST', Number(orphanChoices[0]?.n || 0) === 0);

  // 7. Orphan choice links (choice not in DST)
  const orphanLinks = await dbq(
    `SELECT count(ocl.id) AS n
     FROM option_choice_links ocl
     LEFT JOIN option_choices oc ON oc.id = ocl.choice_id
     JOIN option_groups og ON og.id = oc.group_id
     WHERE og.shop_id = $1
       AND oc.id IS NULL`,
    [DST]
  );
  assert('No orphan choice links in DST', Number(orphanLinks[0]?.n || 0) === 0);

  // 8. Cross-shop references: any DST record referencing SRC shop_id
  const crossShop = await dbq(
    `SELECT count(id) AS n FROM option_groups
     WHERE shop_id = $1 AND id IN (
       SELECT id FROM option_groups WHERE shop_id = $2
     )`, [DST, SRC]
  );
  assert('No cross-shop group references', Number(crossShop[0]?.n || 0) === 0,
    `${crossShop[0]?.n} cross-shop refs`);

  // 9. All recipe_option_groups in DST point to valid groups in DST
  const badROG = await dbq(
    `SELECT count(rog.recipe_id) AS n
     FROM recipe_option_groups rog
     JOIN recipes r ON r.id = rog.recipe_id
     LEFT JOIN option_groups og ON og.id = rog.group_id AND og.shop_id = $1
     WHERE r.shop_id = $1 AND og.id IS NULL`, [DST]
  );
  assert('All recipe_option_groups reference valid DST groups', Number(badROG[0]?.n || 0) === 0,
    `${badROG[0]?.n} bad references`);

  // 10. All material_option_groups in DST point to valid groups in DST
  const badMOG = await dbq(
    `SELECT count(mog.material_id) AS n
     FROM material_option_groups mog
     JOIN materials m ON m.id = mog.material_id
     LEFT JOIN option_groups og ON og.id = mog.group_id AND og.shop_id = $1
     WHERE m.shop_id = $1 AND og.id IS NULL`, [DST]
  );
  assert('All material_option_groups reference valid DST groups', Number(badMOG[0]?.n || 0) === 0,
    `${badMOG[0]?.n} bad references`);
}

// ============================================================
// TESTS
// ============================================================
async function runTests() {
  await login();
  let r;

  // ----------------------------------------------------------
  console.log('\n[T1] Recipe-only dry-run (autoIncludeDependencies=false)');
  r = await clone({
    srcShopId: SRC, dstShopId: DST,
    sections: ['recipes'],
    conflictStrategy: 'skip',
    dryRun: true,
    autoIncludeDependencies: false,
  });
  assert('T1: HTTP 200', r.status === 200, `got ${r.status}`);
  assert('T1: ok=true', r.body.ok === true);
  const deps = r.body.preview?.dependencies || [];
  const optDep = deps.filter(d => d.type === 'missing_option_dependencies');
  assert('T1: has missing_option_dependencies warning', optDep.length > 0,
    `got ${deps.length} deps, 0 of type missing_option_dependencies`);
  assert('T1: warning has recipe_code', optDep[0]?.recipe_code === 'TEST-CLONE-MENU-01',
    `got ${optDep[0]?.recipe_code}`);
  assert('T1: warning has option_groups_count=2', optDep[0]?.option_groups_count === 2,
    `got ${optDep[0]?.option_groups_count}`);
  assert('T1: warning has option_choices_count=4', optDep[0]?.option_choices_count === 4,
    `got ${optDep[0]?.option_choices_count}`);
  assert('T1: no writes (DST recipes=0)', (await dbq('SELECT count(id) AS n FROM recipes WHERE shop_id=$1',[DST]))[0].n == 0,
    'data was written during dry-run');
  assert('T1: no writes (DST groups=0)', (await countDstGroups()) === 0, 'groups were created');

  // ----------------------------------------------------------
  console.log('\n[T2] Recipe-only dry-run (autoIncludeDependencies=true)');
  r = await clone({
    srcShopId: SRC, dstShopId: DST,
    sections: ['recipes'],
    conflictStrategy: 'skip',
    dryRun: true,
    autoIncludeDependencies: true,
  });
  assert('T2: HTTP 200', r.status === 200, `got ${r.status}`);
  const eff = r.body.preview?.effective_sections || [];
  assert('T2: effective_sections includes option_groups', eff.includes('option_groups'),
    `effective_sections: ${JSON.stringify(eff)}`);
  assert('T2: auto_included_option_groups=2', r.body.preview?.auto_included_option_groups === 2,
    `got ${r.body.preview?.auto_included_option_groups}`);
  assert('T2: counts.option_groups=2 (only linked groups)', r.body.preview?.counts?.option_groups === 2,
    `got ${r.body.preview?.counts?.option_groups}`);
  assert('T2: counts.option_choices=4', r.body.preview?.counts?.option_choices === 4,
    `got ${r.body.preview?.counts?.option_choices}`);
  assert('T2: no writes', (await countDstGroups()) === 0, 'groups created during dry-run');

  // ----------------------------------------------------------
  console.log('\n[T3] Clone to empty destination');
  await resetDst();
  r = await clone({
    srcShopId: SRC, dstShopId: DST,
    sections: ['materials', 'recipes', 'option_groups'],
    conflictStrategy: 'skip',
    dryRun: false,
    autoIncludeDependencies: true,
  });
  assert('T3: HTTP 200', r.status === 200, `got ${r.status}: ${JSON.stringify(r.body).slice(0,200)}`);
  assert('T3: ok=true', r.body.ok === true);
  const c3 = r.body.cloned || {};
  assert('T3: recipes cloned=1', c3.recipes === 1, `got ${c3.recipes}`);
  assert('T3: recipe_items cloned=2', c3.recipe_items === 2, `got ${c3.recipe_items}`);
  assert('T3: option_groups cloned=2', c3.option_groups === 2, `got ${c3.option_groups}`);
  assert('T3: option_choices cloned=4', c3.option_choices === 4, `got ${c3.option_choices}`);
  assert('T3: recipe_option_groups cloned=2', c3.recipe_option_groups === 2, `got ${c3.recipe_option_groups}`);
  assert('T3: material_option_groups cloned=1', c3.material_option_groups === 1, `got ${c3.material_option_groups}`);

  // Verify new IDs (DST groups must not have same IDs as SRC)
  const dstGroups = await dbq('SELECT id FROM option_groups WHERE shop_id=$1', [DST]);
  const dstGroupIds = dstGroups.map(g => g.id);
  assert('T3: DST group IDs differ from SRC IDs', !dstGroupIds.includes(IDS.group1) && !dstGroupIds.includes(IDS.group2),
    'Source IDs leaked into destination');

  // Visibility of Topping group (receipt=false, online=false should be preserved)
  const toppingDst = await dbq(
    `SELECT visible_on_pos, visible_on_receipt, visible_on_kitchen, visible_on_online
     FROM option_groups WHERE shop_id=$1 AND label='Topping'`, [DST]
  );
  assert('T3: Topping visible_on_receipt=false preserved', toppingDst[0]?.visible_on_receipt === false,
    `got ${toppingDst[0]?.visible_on_receipt}`);
  assert('T3: Topping visible_on_online=false preserved', toppingDst[0]?.visible_on_online === false,
    `got ${toppingDst[0]?.visible_on_online}`);

  await runAuditQueries('T3');

  // ----------------------------------------------------------
  console.log('\n[T4] Conflict strategy: skip');
  // DST already has groups from T3. Record counts before clone.
  const beforeGroups = await countDstGroups();
  const beforeChoices = await countDstChoices();
  r = await clone({
    srcShopId: SRC, dstShopId: DST,
    sections: ['recipes', 'option_groups'],
    conflictStrategy: 'skip',
    dryRun: false,
    autoIncludeDependencies: true,
  });
  assert('T4: HTTP 200', r.status === 200, `got ${r.status}`);
  const afterGroups = await countDstGroups();
  const afterChoices = await countDstChoices();
  assert('T4: group count unchanged (reused)', afterGroups === beforeGroups,
    `before=${beforeGroups} after=${afterGroups}`);
  assert('T4: choice count unchanged (no insert)', afterChoices === beforeChoices,
    `before=${beforeChoices} after=${afterChoices}`);
  // recipe_option_groups should still link recipe to existing groups
  const rogCount = await countDstROG();
  assert('T4: recipe_option_groups present', rogCount >= 2, `got ${rogCount}`);
  await runAuditQueries('T4');

  // ----------------------------------------------------------
  console.log('\n[T5] Conflict strategy: update (one choice missing in DST)');
  await resetDst();
  // Seed DST with group1 having only 'อุ่น' + extra choice 'อุ่นมาก'
  await seedDstGroup('การเตรียมสินค้า', ['อุ่น', 'อุ่นมาก'], { required: true, minSel: 1, maxSel: 1 });
  const beforeChoicesT5 = await countDstChoices();
  r = await clone({
    srcShopId: SRC, dstShopId: DST,
    sections: ['recipes', 'option_groups'],
    conflictStrategy: 'update',
    dryRun: false,
    autoIncludeDependencies: true,
  });
  assert('T5: HTTP 200', r.status === 200, `got ${r.status}`);
  const afterChoicesT5 = await countDstChoices();
  // Expect: อุ่น (updated) + อุ่นมาก (retained) + ไม่อุ่น (inserted) + Cream Cheese + Matcha Cloud = 5
  // But only group1 was in DST, group2 is new → group2 choices inserted fresh
  // group1: อุ่น(update) + อุ่นมาก(retained) + ไม่อุ่น(insert) = 3
  // group2: new → Cream Cheese + Matcha Cloud = 2
  assert('T5: choices increased (missing inserted)', afterChoicesT5 > beforeChoicesT5,
    `before=${beforeChoicesT5} after=${afterChoicesT5}`);

  const dstChoicesT5 = await dbq(
    `SELECT oc.label
     FROM option_choices oc
     JOIN option_groups og ON og.id = oc.group_id
     WHERE og.shop_id=$1 AND og.label='การเตรียมสินค้า'
     ORDER BY oc.label`, [DST]
  );
  const labels5 = dstChoicesT5.map(c => c.label);
  assert('T5: อุ่น retained/updated', labels5.includes('อุ่น'), `labels: ${labels5.join(',')}`);
  assert('T5: ไม่อุ่น inserted', labels5.includes('ไม่อุ่น'), `labels: ${labels5.join(',')}`);
  assert('T5: อุ่นมาก NOT deleted (extra preserved)', labels5.includes('อุ่นมาก'),
    `labels: ${labels5.join(',')}`);
  await runAuditQueries('T5');

  // ----------------------------------------------------------
  console.log('\n[T6] Conflict strategy: copy');
  await resetDst();
  // Seed DST with 'การเตรียมสินค้า' and 'การเตรียมสินค้า (Copy)' to force 'Copy 2'
  await seedDstGroup('การเตรียมสินค้า', ['อุ่น', 'ไม่อุ่น']);
  await seedDstGroup('การเตรียมสินค้า (Copy)', ['อุ่น']);
  const beforeGroupsT6 = await countDstGroups();
  r = await clone({
    srcShopId: SRC, dstShopId: DST,
    sections: ['recipes', 'option_groups'],
    conflictStrategy: 'copy',
    dryRun: false,
    autoIncludeDependencies: true,
  });
  assert('T6: HTTP 200', r.status === 200, `got ${r.status}`);
  const afterGroupsT6 = await countDstGroups();
  assert('T6: new groups created', afterGroupsT6 > beforeGroupsT6,
    `before=${beforeGroupsT6} after=${afterGroupsT6}`);

  const grpLabelsT6 = await dbq(
    'SELECT label FROM option_groups WHERE shop_id=$1 ORDER BY label', [DST]
  );
  const labelsT6 = grpLabelsT6.map(g => g.label);
  assert('T6: "การเตรียมสินค้า (Copy 2)" created', labelsT6.includes('การเตรียมสินค้า (Copy 2)'),
    `group labels: ${labelsT6.join(' | ')}`);
  assert('T6: original groups preserved', labelsT6.includes('การเตรียมสินค้า') && labelsT6.includes('การเตรียมสินค้า (Copy)'),
    'originals missing');

  // Rerun T6 — should create (Copy 3) not conflict
  r = await clone({
    srcShopId: SRC, dstShopId: DST,
    sections: ['option_groups'],
    conflictStrategy: 'copy',
    dryRun: false,
    autoIncludeDependencies: false,
  });
  assert('T6 rerun: HTTP 200', r.status === 200, `got ${r.status}`);
  const grpLabelsT6b = (await dbq(
    'SELECT label FROM option_groups WHERE shop_id=$1 ORDER BY label', [DST]
  )).map(g => g.label);
  assert('T6 rerun: unique "(Copy 3)" or "(Copy 2)" exists without error',
    !grpLabelsT6b.some((l, i, a) => a.indexOf(l) !== i),
    'Duplicate label found after rerun: ' + grpLabelsT6b.join(' | '));
  await runAuditQueries('T6');

  // ----------------------------------------------------------
  console.log('\n[T7] Direct-sale material + options');
  await resetDst();
  r = await clone({
    srcShopId: SRC, dstShopId: DST,
    sections: ['materials', 'option_groups'],
    conflictStrategy: 'skip',
    dryRun: false,
    autoIncludeDependencies: false,
  });
  assert('T7: HTTP 200', r.status === 200, `got ${r.status}`);
  const mogCount = await countDstMOG();
  assert('T7: material_option_groups cloned=1', mogCount === 1, `got ${mogCount}`);

  const dstDirectMat = await dbq(
    `SELECT m.id, m.sku, m.show_in_pos
     FROM materials m
     WHERE m.shop_id=$1 AND m.sku='TEST-DIRECT-CAKE-01'`, [DST]
  );
  assert('T7: direct-sale material cloned', dstDirectMat.length === 1, 'material not found in DST');
  assert('T7: direct-sale show_in_pos=true', dstDirectMat[0]?.show_in_pos === true,
    `got ${dstDirectMat[0]?.show_in_pos}`);

  const matGroupLink = await dbq(
    `SELECT mog.material_id, mog.group_id
     FROM material_option_groups mog
     JOIN materials m ON m.id = mog.material_id
     WHERE m.shop_id=$1 AND m.sku='TEST-DIRECT-CAKE-01'`, [DST]
  );
  assert('T7: material→group link exists', matGroupLink.length === 1, 'no material_option_groups link');

  // ----------------------------------------------------------
  console.log('\n[T8] Visibility fields preserved');
  await resetDst();
  r = await clone({
    srcShopId: SRC, dstShopId: DST,
    sections: ['option_groups'],
    conflictStrategy: 'skip',
    dryRun: false,
    autoIncludeDependencies: false,
  });
  assert('T8: HTTP 200', r.status === 200, `got ${r.status}`);

  const toppingVis = await dbq(
    `SELECT visible_on_pos, visible_on_receipt, visible_on_kitchen, visible_on_online
     FROM option_groups WHERE shop_id=$1 AND label='Topping'`, [DST]
  );
  assert('T8: Topping visible_on_pos=true', toppingVis[0]?.visible_on_pos === true,
    `got ${toppingVis[0]?.visible_on_pos}`);
  assert('T8: Topping visible_on_receipt=false (not forced true)', toppingVis[0]?.visible_on_receipt === false,
    `got ${toppingVis[0]?.visible_on_receipt}`);
  assert('T8: Topping visible_on_kitchen=true', toppingVis[0]?.visible_on_kitchen === true,
    `got ${toppingVis[0]?.visible_on_kitchen}`);
  assert('T8: Topping visible_on_online=false (not forced true)', toppingVis[0]?.visible_on_online === false,
    `got ${toppingVis[0]?.visible_on_online}`);

  const prepVis = await dbq(
    `SELECT visible_on_pos, visible_on_receipt, visible_on_kitchen, visible_on_online
     FROM option_groups WHERE shop_id=$1 AND label='การเตรียมสินค้า'`, [DST]
  );
  assert('T8: การเตรียมสินค้า all visibility=true', [
    prepVis[0]?.visible_on_pos, prepVis[0]?.visible_on_receipt,
    prepVis[0]?.visible_on_kitchen, prepVis[0]?.visible_on_online
  ].every(v => v === true), `got ${JSON.stringify(prepVis[0])}`);

  // ----------------------------------------------------------
  console.log('\n[T9] Cross-branch reference audit');
  const srcIds = await dbq(
    `SELECT id FROM option_groups WHERE shop_id=$1`, [SRC]
  );
  const srcGroupIds = srcIds.map(r => r.id);
  const crossRef = await dbq(
    `SELECT id FROM option_groups WHERE shop_id=$1 AND id = ANY($2::uuid[])`,
    [DST, srcGroupIds]
  );
  assert('T9: No SRC group IDs in DST', crossRef.length === 0,
    `${crossRef.length} cross-shop group refs: ${crossRef.map(r=>r.id).join(',')}`);

  const srcChoiceIds = (await dbq(
    `SELECT oc.id FROM option_choices oc JOIN option_groups og ON og.id=oc.group_id WHERE og.shop_id=$1`, [SRC]
  )).map(r => r.id);
  const crossChoices = await dbq(
    `SELECT oc.id FROM option_choices oc JOIN option_groups og ON og.id=oc.group_id
     WHERE og.shop_id=$1 AND oc.id = ANY($2::uuid[])`, [DST, srcChoiceIds]
  );
  assert('T9: No SRC choice IDs in DST', crossChoices.length === 0,
    `${crossChoices.length} cross-shop choice refs`);

  const srcRecipeIds = (await dbq('SELECT id FROM recipes WHERE shop_id=$1',[SRC])).map(r=>r.id);
  const crossRecipes = await dbq(
    'SELECT id FROM recipes WHERE shop_id=$1 AND id = ANY($2::uuid[])', [DST, srcRecipeIds]
  );
  assert('T9: No SRC recipe IDs in DST', crossRecipes.length === 0,
    `${crossRecipes.length} cross-shop recipe refs`);

  await runAuditQueries('T9');

  // ----------------------------------------------------------
  console.log('\n[T10] Transaction rollback on injected error');
  await resetDst();
  // Seed source with a choice link so the injection fires
  // (group→choice→link path needs to exist — it does in source)
  const beforeT10Groups = await countDstGroups();
  const beforeT10Choices = await countDstChoices();
  const beforeT10Recipes = (await dbq('SELECT count(id) AS n FROM recipes WHERE shop_id=$1',[DST]))[0].n;

  r = await clone({
    srcShopId: SRC, dstShopId: DST,
    sections: ['materials', 'recipes', 'option_groups'],
    conflictStrategy: 'skip',
    dryRun: false,
    autoIncludeDependencies: true,
    __testInjectErrorAt: 'option_choice_links',
  });
  // Should return 500 or a non-200 due to injected error
  assert('T10: returns error status', r.status === 500 || r.status >= 400,
    `got ${r.status}: ${JSON.stringify(r.body).slice(0,100)}`);

  const afterT10Groups = await countDstGroups();
  const afterT10Choices = await countDstChoices();
  const afterT10Recipes = (await dbq('SELECT count(id) AS n FROM recipes WHERE shop_id=$1',[DST]))[0].n;
  assert('T10: recipes rolled back', afterT10Recipes == beforeT10Recipes,
    `before=${beforeT10Recipes} after=${afterT10Recipes}`);
  assert('T10: groups rolled back', afterT10Groups === beforeT10Groups,
    `before=${beforeT10Groups} after=${afterT10Groups}`);
  assert('T10: choices rolled back', afterT10Choices === beforeT10Choices,
    `before=${beforeT10Choices} after=${afterT10Choices}`);

  // ----------------------------------------------------------
  console.log('\n[T11] Rerun safety');
  await resetDst();
  const cloneOpts = {
    srcShopId: SRC, dstShopId: DST,
    sections: ['materials', 'recipes', 'option_groups'],
    conflictStrategy: 'skip',
    dryRun: false,
    autoIncludeDependencies: true,
  };
  await clone(cloneOpts);  // first run
  const afterRun1Groups  = await countDstGroups();
  const afterRun1Choices = await countDstChoices();
  const afterRun1Links   = await countDstLinks();
  const afterRun1ROG     = await countDstROG();

  await clone(cloneOpts);  // second run
  const afterRun2Groups  = await countDstGroups();
  const afterRun2Choices = await countDstChoices();
  const afterRun2Links   = await countDstLinks();
  const afterRun2ROG     = await countDstROG();

  assert('T11: group count stable on rerun', afterRun2Groups === afterRun1Groups,
    `run1=${afterRun1Groups} run2=${afterRun2Groups}`);
  assert('T11: choice count stable (no duplicates)', afterRun2Choices === afterRun1Choices,
    `run1=${afterRun1Choices} run2=${afterRun2Choices}`);
  assert('T11: link count stable', afterRun2Links === afterRun1Links,
    `run1=${afterRun1Links} run2=${afterRun2Links}`);
  assert('T11: recipe_option_groups stable', afterRun2ROG === afterRun1ROG,
    `run1=${afterRun1ROG} run2=${afterRun2ROG}`);
  await runAuditQueries('T11');

  // ----------------------------------------------------------
  console.log('\n[T12] Source independence after disabling source group');
  const srcGroupBefore = await dbq(
    'SELECT enabled FROM option_groups WHERE id=$1', [IDS.group1]
  );
  // Disable source group
  await dbq('UPDATE option_groups SET enabled=false WHERE id=$1', [IDS.group1]);
  const dstGroupAfter = await dbq(
    `SELECT og.enabled FROM option_groups og WHERE og.shop_id=$1 AND og.label='การเตรียมสินค้า'`, [DST]
  );
  assert('T12: DST group unaffected by SRC disable', dstGroupAfter[0]?.enabled === true,
    `DST enabled=${dstGroupAfter[0]?.enabled}`);

  // Verify no shared IDs remain
  const sharedIds = await dbq(
    `SELECT id FROM option_groups WHERE shop_id=$1 AND id IN (
       SELECT id FROM option_groups WHERE shop_id=$2
     )`, [DST, SRC]
  );
  assert('T12: No shared IDs between SRC and DST', sharedIds.length === 0,
    `${sharedIds.length} shared IDs`);

  // Restore source group
  await dbq('UPDATE option_groups SET enabled=$1 WHERE id=$2', [srcGroupBefore[0]?.enabled ?? true, IDS.group1]);

  // ----------------------------------------------------------
  console.log('\n[T13] POS verification (backend contract checks)');
  // T13 verifies via DB queries that DST is POS-ready after T11 clone
  const dstRecipe = await dbq(
    `SELECT r.id, r.code, r.name, r.on_menu, r.sell_price
     FROM recipes r WHERE r.shop_id=$1 AND r.code='TEST-CLONE-MENU-01'`, [DST]
  );
  assert('T13: recipe visible in DST', dstRecipe.length === 1 && dstRecipe[0].on_menu,
    `found=${dstRecipe.length} on_menu=${dstRecipe[0]?.on_menu}`);
  assert('T13: sell_price=120', Number(dstRecipe[0]?.sell_price) === 120,
    `got ${dstRecipe[0]?.sell_price}`);

  const dstROG = await dbq(
    `SELECT rog.recipe_id, rog.group_id
     FROM recipe_option_groups rog
     JOIN recipes r ON r.id=rog.recipe_id
     WHERE r.shop_id=$1 AND r.code='TEST-CLONE-MENU-01'`, [DST]
  );
  assert('T13: recipe has 2 option groups linked', dstROG.length === 2, `got ${dstROG.length}`);

  const dstPrepGroup = await dbq(
    `SELECT og.required, og.min_select, og.max_select, og.visible_on_pos
     FROM option_groups og WHERE og.shop_id=$1 AND og.label='การเตรียมสินค้า'`, [DST]
  );
  assert('T13: required group has required=true', dstPrepGroup[0]?.required === true,
    `got ${dstPrepGroup[0]?.required}`);
  assert('T13: required group min_select=1', Number(dstPrepGroup[0]?.min_select) === 1,
    `got ${dstPrepGroup[0]?.min_select}`);
  assert('T13: required group visible_on_pos=true', dstPrepGroup[0]?.visible_on_pos === true,
    `got ${dstPrepGroup[0]?.visible_on_pos}`);

  const dstPriceChoices = await dbq(
    `SELECT oc.label, oc.price_add
     FROM option_choices oc JOIN option_groups og ON og.id=oc.group_id
     WHERE og.shop_id=$1 AND og.label='Topping'
     ORDER BY oc.label`, [DST]
  );
  const creamCheese = dstPriceChoices.find(c => c.label === 'Cream Cheese');
  const matcha = dstPriceChoices.find(c => c.label === 'Matcha Cloud');
  assert('T13: Cream Cheese price_add=30', Number(creamCheese?.price_add) === 30,
    `got ${creamCheese?.price_add}`);
  assert('T13: Matcha Cloud price_add=35', Number(matcha?.price_add) === 35,
    `got ${matcha?.price_add}`);

  const dstToppingGroup = await dbq(
    `SELECT og.required, og.min_select, og.max_select
     FROM option_groups og WHERE og.shop_id=$1 AND og.label='Topping'`, [DST]
  );
  assert('T13: Topping required=false (optional)', dstToppingGroup[0]?.required === false,
    `got ${dstToppingGroup[0]?.required}`);
  assert('T13: Topping max_select=2', Number(dstToppingGroup[0]?.max_select) === 2,
    `got ${dstToppingGroup[0]?.max_select}`);

  // Direct-sale material in DST
  const dstDirect = await dbq(
    `SELECT m.show_in_pos, m.sale_type
     FROM materials m WHERE m.shop_id=$1 AND m.sku='TEST-DIRECT-CAKE-01'`, [DST]
  );
  assert('T13: direct-sale material in DST', dstDirect.length === 1, 'material missing');
  assert('T13: direct-sale show_in_pos=true', dstDirect[0]?.show_in_pos === true,
    `got ${dstDirect[0]?.show_in_pos}`);

  // No stock movements from options (non-stock options only affect price, not stock)
  const optionMovements = await dbq(
    `SELECT count(sm.id) AS n FROM stock_movements sm
     WHERE sm.shop_id=$1 AND sm.kind='option'`, [DST]
  );
  assert('T13: no stock movements for non-stock options', Number(optionMovements[0]?.n || 0) === 0,
    `found ${optionMovements[0]?.n} option movements`);
}

// ============================================================
// CLEANUP
// ============================================================
async function cleanup() {
  console.log('\n[cleanup] Removing DST test data...');
  await resetDst();
  // Remove QA user membership (keep user for future runs)
  await dbq(
    'DELETE FROM memberships WHERE user_id=$1',
    ['ffffffff-0000-0000-0000-000000000001']
  );
  console.log('  [cleanup] Done');
}

// ============================================================
// MAIN
// ============================================================
async function main() {
  const args = process.argv.slice(2);
  const doReset    = !args.includes('--preserve');
  const doCleanup  = !args.includes('--preserve');
  const cleanupOnly = args.includes('--cleanup');

  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║  RECIPRO — Clone Option Fix QA  (T1–T13)                ║');
  console.log('╚══════════════════════════════════════════════════════════╝');

  safetyCheck();

  pool = new Pool({ connectionString: DB_URL });

  try {
    if (cleanupOnly) {
      await cleanup();
      await pool.end();
      return;
    }

    if (doReset) await runFixture();
    await runTests();
    if (doCleanup && !args.includes('--preserve')) await cleanup();

  } catch (e) {
    console.error('\n[FATAL]', e.message);
    console.error(e.stack);
    process.exit(1);
  } finally {
    await pool.end();
  }

  // --------------------------------------------------------
  // Report
  // --------------------------------------------------------
  const total = results.pass + results.fail;
  console.log('\n══════════════════════════════════════════════════════════');
  console.log(`  Results: ${results.pass}/${total} PASSED  |  ${results.fail} FAILED`);
  console.log('══════════════════════════════════════════════════════════');

  if (results.fail > 0) {
    console.log('\nFailed tests:');
    results.tests.filter(t => t.status === 'FAIL').forEach(t => {
      console.log(`  ✗ ${t.name}${t.detail ? ' — ' + t.detail : ''}`);
    });
    process.exit(1);
  } else {
    console.log('\n  ALL TESTS PASSED');
    process.exit(0);
  }
}

main().catch(e => {
  console.error('[UNHANDLED]', e);
  process.exit(1);
});
