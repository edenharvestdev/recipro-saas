#!/usr/bin/env node
// Founder manual-authoring test — starter data.
//
// Creates ONE isolated test shop with the small representative menu set:
//   Product : Latte, base price 100 THB
//   Recipe  : Espresso 30 ml + Fresh Milk 150 ml + Syrup 10 ml
//   Materials: Espresso, Fresh Milk, Oat Milk, Syrup
// plus two extra recipes that exist only so block E can be exercised:
//   Iced Latte  — a valid, complete, DIFFERENT recipe  -> variant must publish
//   Draft Recipe — deliberately empty                  -> variant must stay draft + blocked
//
// SAFETY: refuses to run against anything that is not a local database.
// Usage:  node scripts/seed-authoring-test.js [--reset]
require('dotenv').config();
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const EMAIL = 'founder.test@local.test';
const PASSWORD = 'FounderTest#2026';
const SHOP = 'ร้านทดสอบการสร้างเมนู (Authoring Test)';

const url = process.env.DATABASE_URL || '';
if (!/@(localhost|127\.0\.0\.1)[:/]/.test(url)) {
  console.error('REFUSING TO RUN: DATABASE_URL is not a local database.');
  console.error('This script seeds test data and must never touch a shared or production database.');
  process.exit(1);
}

const pool = new Pool({ connectionString: url });
const reset = process.argv.includes('--reset');

(async () => {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');

    // --- reset: delete ONLY this test shop, by name, never anything else ---
    const existing = (await c.query('select id from shops where name = $1', [SHOP])).rows;
    if (existing.length && !reset) {
      console.log(`Test shop already exists (${existing.length}). Re-run with --reset to rebuild it.`);
      await c.query('ROLLBACK');
      return;
    }
    for (const s of existing) {
      await c.query('delete from shops where id = $1', [s.id]);   // cascades to shop-scoped rows
      console.log('reset: removed previous test shop', s.id);
    }
    await c.query('delete from users where email = $1', [EMAIL]);

    // --- owner + shop ---
    const hash = await bcrypt.hash(PASSWORD, Number(process.env.BCRYPT_ROUNDS) || 10);
    const user = (await c.query(
      'insert into users (email, password_hash) values ($1,$2) returning id', [EMAIL, hash]
    )).rows[0];
    const shop = (await c.query(
      "insert into shops (name, status) values ($1,'trial') returning id", [SHOP]
    )).rows[0];
    await c.query("insert into memberships (user_id, shop_id, role) values ($1,$2,'owner')", [user.id, shop.id]);

    // Start with NO pos_categories on purpose: the Founder's first test is creating one.
    await c.query(
      "insert into shop_settings (shop_id, theme, pos_categories) values ($1,'recipro','[]'::jsonb)", [shop.id]
    );

    // --- materials (purchase pair: `price` per `qty` of `unit`; `stock` is on-hand) ---
    // 'มล.' is an identity base unit, so every quantity resolves cleanly and block E's unit checks pass.
    const matU = async (unit, name, price, qty, stock) => (await c.query(
      `insert into materials (shop_id, name, unit, price, qty, stock, low_stock, category, item_type)
       values ($1,$2,$3,$4,$5,$6,$7,'วัตถุดิบ','RAW') returning id, name`,
      [shop.id, name, unit, price, qty, stock, 500]
    )).rows[0];
    const mat  = (name, price, qty, stock) => matU('มล.', name, price, qty, stock);  // millilitres
    const matG = (name, price, qty, stock) => matU('ก.',  name, price, qty, stock);  // grams

    const espresso = await mat('Espresso',    600, 1000, 5000);  // 0.60  THB/ml
    const milk     = await mat('Fresh Milk',   60, 1000, 20000); // 0.06  THB/ml
    const oat      = await mat('Oat Milk',     95, 1000, 10000); // 0.095 THB/ml
    const almond   = await mat('Almond Milk', 110, 1000, 10000); // 0.11  THB/ml — a 2nd replacement choice
    const syrup    = await mat('Syrup',       120, 1000, 5000);  // 0.12  THB/ml
    const water    = await mat('Water',         5, 1000, 50000); // exists only so Americano has NO Fresh Milk
    const powder   = await matG('Tea Powder', 900, 1000, 2000);  // 0.90  THB/g — a non-milk base ingredient

    // --- recipes ---
    const rec = async (name, price) => (await c.query(
      `insert into recipes (shop_id, name, category, sell_price, batch_yield, yield_unit, is_raw, on_menu)
       values ($1,$2,'',$3,1,'แก้ว',false,true) returning id, name`,
      [shop.id, name, price]
    )).rows[0];
    const item = (rid, mid, amount, role) => c.query(
      'insert into recipe_items (recipe_id, material_id, amount, role) values ($1,$2,$3,$4)',
      [rid, mid, amount, role]
    );

    // Product under test — exactly the Founder's spec.
    const latte = await rec('Latte', 100);
    await item(latte.id, espresso.id, 30,  'ช็อต');
    await item(latte.id, milk.id,     150, 'นม');
    await item(latte.id, syrup.id,    10,  'ความหวาน');

    // Contains Fresh Milk -> must appear in the "เปลี่ยนนม" eligible list.
    const iced = await rec('Iced Latte', 110);
    await item(iced.id, espresso.id, 30,  'ช็อต');
    await item(iced.id, milk.id,     150, 'นม');
    await item(iced.id, syrup.id,    10,  'ความหวาน');

    // NO Fresh Milk -> the eligibility filter must EXCLUDE this one. It is the
    // whole point of the test: a milk option must be unlinkable from a black coffee.
    const americano = await rec('Americano', 70);
    await item(americano.id, espresso.id, 30,  'ช็อต');
    await item(americano.id, water.id,    120, 'น้ำ');

    // Contains Fresh Milk at a DIFFERENT base syrup amount (15 vs 10), so
    // percent-of-base resolves per menu (50% -> 5 here, 7.5 there) and a fixed
    // quantity shows a mismatch warning instead of applying silently.
    const powderLatte = await rec('Tea Powder Latte Example', 120);
    await item(powderLatte.id, powder.id, 3,   'ผง');
    await item(powderLatte.id, milk.id,   150, 'นม');
    await item(powderLatte.id, syrup.id,  15,  'ความหวาน');

    // Block E — deliberately empty. Must stay draft and block publication.
    const draft = await rec('Draft Recipe (ยังไม่ใส่วัตถุดิบ)', 0);

    await c.query('COMMIT');

    const baht = n => n.toFixed(2);
    const cost = 30 * 0.6 + 150 * 0.06 + 10 * 0.12;
    console.log(`
================ AUTHORING TEST DATA READY ================
  shop            ${SHOP}
  shop_id         ${shop.id}
  login           ${EMAIL}
  password        ${PASSWORD}

  Product         Latte — base price 100.00 THB
  Base recipe     Espresso 30 ml + Fresh Milk 150 ml + Syrup 10 ml
  Base cost       ${baht(cost)} THB   (espresso ${baht(30*0.6)} + milk ${baht(150*0.06)} + syrup ${baht(10*0.12)})

  Materials       Espresso     0.600 THB/ml     Almond Milk  0.110 THB/ml
                  Fresh Milk   0.060 THB/ml     Water        0.005 THB/ml
                  Oat Milk     0.095 THB/ml     Tea Powder   0.900 THB/g
                  Syrup        0.120 THB/ml

  "เปลี่ยนนม" (source = Fresh Milk) — the eligibility filter must show EXACTLY:
     eligible   Latte · Iced Latte · Tea Powder Latte Example
     EXCLUDED   Americano            (no Fresh Milk in its recipe)
                Draft Recipe         (no ingredients at all)

  Quantity modes  Latte + Iced Latte use Syrup 10 ml; Tea Powder Latte uses 15 ml,
                  so "50% of base" must resolve 5 ml / 5 ml / 7.5 ml per menu, and a
                  single fixed quantity must warn instead of applying silently.

  For block E     "Iced Latte"    complete + different  -> must publish
                  "Draft Recipe"  empty                 -> must stay draft, blocked
                  "Latte" itself                        -> must be blocked (self-reference)

  Categories      none yet — creating the first one is test 1
===========================================================`);
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    console.error('seed failed:', e.message);
    process.exitCode = 1;
  } finally {
    c.release();
    await pool.end();
  }
})();
