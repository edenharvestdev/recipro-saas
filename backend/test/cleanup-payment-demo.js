#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════════════════════
// PAYMENT DEMO DATA CLEANUP — dev-only companion to seed-payment-dashboard-demo.js
// ═══════════════════════════════════════════════════════════════════════════════════════════
// Removes the LOCAL demo shops/accounts the seeder (and UX-review prep) created. Same guard
// as the seeder: refuses to run against anything but a LOCAL Postgres. Not part of `npm test`.
//
// Usage:
//   node backend/test/cleanup-payment-demo.js --shop-id <uuid>   # remove ONE shop + its data
//   node backend/test/cleanup-payment-demo.js --all-demo         # remove every known demo shop
//                                                                # (PAYDASH DEMO SHOP, ISOLATION
//                                                                #  SHOP B, *SCRATCH*) + demo
//                                                                #  users (paydash_demo_*/ux_*_demo
//                                                                #  @local.test) with no other shop
//
// Strategy: delete rows from every table that carries a shop_id column (discovered from
// information_schema, so new tables are covered automatically), in retry passes so FK order
// never matters, then the shop rows, then orphaned demo users. Prints per-table counts.
// ═══════════════════════════════════════════════════════════════════════════════════════════
require('dotenv').config();

const DB = process.env.DATABASE_URL || '';
if (!/@(localhost|127\.0\.0\.1)[:/]/.test(DB)) {
  console.error('refusing to run: DATABASE_URL is not local');
  process.exit(1);
}

const { pool, query } = require('../src/db');

const DEMO_SHOP_NAMES = ['PAYDASH DEMO SHOP', 'ISOLATION SHOP B', 'STAFF SCRATCH (ignore)', 'MGR SCRATCH (ignore)'];
const DEMO_USER_PATTERNS = ['paydash_demo_%@local.test', 'ux_staff_demo@local.test', 'ux_manager_demo@local.test', 'ux_shopb_demo@local.test'];

async function main() {
  const args = process.argv.slice(2);
  const shopIdArg = args.includes('--shop-id') ? args[args.indexOf('--shop-id') + 1] : null;
  const allDemo = args.includes('--all-demo');
  if (!shopIdArg && !allDemo) {
    console.error('usage: cleanup-payment-demo.js --shop-id <uuid> | --all-demo');
    process.exit(1);
  }

  let shopIds;
  if (shopIdArg) {
    shopIds = [shopIdArg];
  } else {
    shopIds = (await query(
      `SELECT id FROM shops WHERE name = ANY($1)`, [DEMO_SHOP_NAMES])).rows.map((r) => r.id);
  }
  if (!shopIds.length) { console.log('nothing to clean (no matching demo shops)'); await pool.end(); return; }
  console.log('cleaning', shopIds.length, 'shop(s):', shopIds.join(', '));

  // Every table with a shop_id column (future-proof: new payment tables are picked up automatically).
  const tables = (await query(
    `SELECT table_name FROM information_schema.columns
      WHERE table_schema='public' AND column_name='shop_id'
        AND table_name IN (SELECT table_name FROM information_schema.tables
                            WHERE table_schema='public' AND table_type='BASE TABLE')`)).rows
    .map((r) => r.table_name).filter((t) => t !== 'shops');

  const counts = {};
  let pending = tables.slice();
  for (let pass = 1; pass <= 5 && pending.length; pass++) {
    const failed = [];
    for (const t of pending) {
      try {
        const safe = t.replace(/[^a-z0-9_]/g, '');   // identifier can't be a bind param
        const r = await query(`DELETE FROM ${safe} WHERE shop_id = ANY($1)`, [shopIds]);
        counts[t] = (counts[t] || 0) + r.rowCount;
      } catch (e) { failed.push(t); }
    }
    pending = failed;
  }
  if (pending.length) { console.error('FAILED (FK cycle?):', pending.join(', ')); await pool.end(); process.exit(1); }

  const shops = await query(`DELETE FROM shops WHERE id = ANY($1)`, [shopIds]);
  counts.shops = shops.rowCount;

  // Demo users that no longer belong to any shop.
  const users = await query(
    `DELETE FROM users u WHERE (u.email LIKE ANY($1))
       AND NOT EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = u.id)`, [DEMO_USER_PATTERNS]);
  counts['users (orphaned demo)'] = users.rowCount;

  for (const [t, c] of Object.entries(counts)) if (c > 0) console.log(`  ${t}: ${c} row(s) deleted`);
  console.log('CLEANUP DONE');
  await pool.end();
}
main().catch((e) => { console.error('CLEANUP FAILED:', e.message); process.exit(1); });
