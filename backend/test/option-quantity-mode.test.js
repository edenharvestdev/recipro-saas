// Additive quantity-resolution capability — engine acceptance tests.
// node --test backend/test/option-quantity-mode.test.js
//
// Context: stockEngine.js's buildEffectiveBom() was previously FROZEN (byte-
// identical behavior required). The Founder approved ONE narrowly scoped
// additive capability: option_choices gains `quantity_mode` / `quantity_value`
// so REPLACE/QUANTITY effects can resolve an amount from the recipe's OWN BOM
// instead of only ever storing a fixed number.
//
//   REPLACE  quantity_mode: null|'FIXED' (legacy) | 'MATCH_SOURCE'
//   QUANTITY quantity_mode: null|'FIXED' (legacy) | 'PERCENT_OF_BASE' | 'USE_BASE'
//
// These tests run against a REAL local Postgres (DATABASE_URL from the
// repo-root .env), inside a single transaction that is ALWAYS rolled back —
// no test rows are ever left behind. They call the REAL buildEffectiveBom
// from backend/src/stockEngine.js (never re-implemented here). Fixtures use
// generic, neutral names only (Fresh Milk / Oat Milk / Syrup / Whipped
// Cream) — no shop-specific or HIBI logic.
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const test = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../src/db');
const { buildEffectiveBom } = require('../src/stockEngine');

test('option quantity-mode — additive engine capability (Founder\'s 15)', async () => {
  const client = await pool.connect();
  try {
    await client.query('begin');

    // ---------------------------------------------------------------------
    // Fixtures — one shop, four neutral materials, four recipes.
    // ---------------------------------------------------------------------
    const shopId = (await client.query(
      "insert into shops(name) values ('QM Engine Test Shop') returning id"
    )).rows[0].id;

    async function makeMaterial(name, unit) {
      const r = await client.query(
        `insert into materials (shop_id, name, unit, stock, price, qty)
         values ($1,$2,$3,100,10,1) returning id`,
        [shopId, name, unit]
      );
      return r.rows[0].id;
    }
    const freshMilk = await makeMaterial('Fresh Milk', 'ml');
    const oatMilk = await makeMaterial('Oat Milk', 'ml');
    const syrup = await makeMaterial('Syrup', 'ml');
    const whippedCream = await makeMaterial('Whipped Cream', 'g');

    async function makeRecipe(name) {
      const r = await client.query(
        `insert into recipes (shop_id, name) values ($1,$2) returning id`,
        [shopId, name]
      );
      return r.rows[0].id;
    }
    // recipeA / recipeB: same option choices resolved against two DIFFERENT
    // recipes, each with its own Fresh Milk / Syrup amount.
    const recipeA = await makeRecipe('Latte A');       // Fresh Milk 150, Syrup 10
    const recipeB = await makeRecipe('Latte B');       // Fresh Milk 120, Syrup 15
    const recipeNoMilk = await makeRecipe('Latte No Milk'); // Syrup only — no Fresh Milk item at all
    const recipeUseBase = await makeRecipe('Latte UseBase'); // Syrup 20

    async function addItem(recipeId, materialId, amount) {
      await client.query(
        'insert into recipe_items (recipe_id, material_id, amount) values ($1,$2,$3)',
        [recipeId, materialId, amount]
      );
    }
    await addItem(recipeA, freshMilk, 150);
    await addItem(recipeA, syrup, 10);
    await addItem(recipeB, freshMilk, 120);
    await addItem(recipeB, syrup, 15);
    await addItem(recipeNoMilk, syrup, 10);
    await addItem(recipeUseBase, syrup, 20);

    const groupId = (await client.query(
      "insert into option_groups (shop_id, label) values ($1, 'Milk Choice') returning id",
      [shopId]
    )).rows[0].id;

    async function makeChoice(f) {
      const r = await client.query(
        `insert into option_choices
           (group_id, label, effect_type, target_material_id, amount, quantity_mode, quantity_value)
         values ($1,$2,$3,$4,$5,$6,$7) returning id`,
        [groupId, f.label || '', f.effect_type, f.target_material_id || null,
         f.amount ?? 0, f.quantity_mode || null, f.quantity_value ?? null]
      );
      return r.rows[0].id;
    }
    async function addLink(choiceId, materialId, amount) {
      await client.query(
        'insert into option_choice_links (choice_id, material_id, amount) values ($1,$2,$3)',
        [choiceId, materialId, amount]
      );
    }

    // =======================================================================
    // 1 & 14 — existing fixed replacement behaves EXACTLY as before
    //          (quantity_mode column has no value = legacy row)
    // =======================================================================
    const legacyReplace = await makeChoice({
      label: 'Oat Milk (legacy fixed)', effect_type: 'REPLACE', target_material_id: freshMilk,
    });
    await addLink(legacyReplace, oatMilk, 999); // fixed link amount, unrelated to recipe amount

    {
      const { bom } = await buildEffectiveBom(client, recipeA, [{ choice_id: legacyReplace }]);
      assert.equal(bom.has(freshMilk), false, '1/14: source material removed');
      assert.ok(bom.has(oatMilk), '1/14: replacement present');
      assert.equal(bom.get(oatMilk).amount, 999, '1/14: legacy FIXED amount used verbatim, recipe amount ignored');
      assert.equal(bom.get(syrup).amount, 10, '1/14: unrelated BOM lines untouched');
    }

    // =======================================================================
    // 2, 3, 4, 5 — MATCH_SOURCE
    // =======================================================================
    const matchSource = await makeChoice({
      label: 'Oat Milk (match source)', effect_type: 'REPLACE',
      target_material_id: freshMilk, quantity_mode: 'MATCH_SOURCE',
    });
    // link amount deliberately poisoned — MATCH_SOURCE must never read it.
    await addLink(matchSource, oatMilk, 1);

    {
      const { bom: bomA } = await buildEffectiveBom(client, recipeA, [{ choice_id: matchSource }]);
      assert.equal(bomA.get(oatMilk).amount, 150, '2: MATCH_SOURCE resolves to source amount (150) for recipeA');
      assert.equal(bomA.has(freshMilk), false, '4: source ingredient removed exactly once');
      assert.equal(bomA.size, 2, '5: replacement deducted exactly once — no double-deduct (oatMilk+syrup only)');
    }
    {
      // 3: the SAME option choice, resolved against a DIFFERENT recipe, uses
      // that recipe's own source amount (120), not the 150 from recipeA.
      const { bom: bomB } = await buildEffectiveBom(client, recipeB, [{ choice_id: matchSource }]);
      assert.equal(bomB.get(oatMilk).amount, 120, '3: same choice resolves 120 for a different recipe (source=120)');
      assert.equal(bomB.has(freshMilk), false, '3: source removed for recipeB too');
    }

    // =======================================================================
    // 6 — MATCH_SOURCE where the source is absent from the recipe's BOM:
    //     contributes nothing (never guesses a link/fixed amount).
    // =======================================================================
    {
      const { bom } = await buildEffectiveBom(client, recipeNoMilk, [{ choice_id: matchSource }]);
      assert.equal(bom.has(oatMilk), false, '6: replacement NOT added when source is absent from this BOM');
      assert.equal(bom.has(freshMilk), false, '6: (sanity) recipe never had Fresh Milk to begin with');
      assert.equal(bom.get(syrup).amount, 10, '6: unrelated BOM lines still present/untouched');
    }

    // =======================================================================
    // 7 — invalid/unresolvable amount never silently becomes a fixed quantity
    // =======================================================================
    const invalidPercent = await makeChoice({
      label: 'Syrup adjust (invalid %)', effect_type: 'QUANTITY', target_material_id: syrup,
      amount: 12345, // poisoned legacy fixed-amount field — must NEVER be used as a fallback
      quantity_mode: 'PERCENT_OF_BASE', quantity_value: null,
    });
    {
      const { bom } = await buildEffectiveBom(client, recipeA, [{ choice_id: invalidPercent }]);
      assert.equal(bom.get(syrup).amount, 10, '7: unresolvable percent leaves the base amount untouched (never falls back to the fixed `amount` field)');
    }

    // =======================================================================
    // 8, 9, 10 — PERCENT_OF_BASE
    // =======================================================================
    const pct50 = await makeChoice({
      label: 'Syrup 50%', effect_type: 'QUANTITY', target_material_id: syrup,
      quantity_mode: 'PERCENT_OF_BASE', quantity_value: 50,
    });
    {
      const { bom: a } = await buildEffectiveBom(client, recipeA, [{ choice_id: pct50 }]);
      const { bom: b } = await buildEffectiveBom(client, recipeB, [{ choice_id: pct50 }]);
      assert.equal(a.get(syrup).amount, 5, '8: recipeA base 10 * 50% = 5');
      assert.equal(b.get(syrup).amount, 7.5, '8: recipeB base 15 * 50% = 7.5, resolved independently');
    }

    const pct0 = await makeChoice({
      label: 'Syrup 0%', effect_type: 'QUANTITY', target_material_id: syrup,
      quantity_mode: 'PERCENT_OF_BASE', quantity_value: 0,
    });
    {
      const { bom } = await buildEffectiveBom(client, recipeA, [{ choice_id: pct0 }]);
      assert.equal(bom.has(syrup), false, '9: 0% removes the ingredient');
    }

    const pct100 = await makeChoice({
      label: 'Syrup 100%', effect_type: 'QUANTITY', target_material_id: syrup,
      quantity_mode: 'PERCENT_OF_BASE', quantity_value: 100,
    });
    {
      const { bom } = await buildEffectiveBom(client, recipeA, [{ choice_id: pct100 }]);
      assert.equal(bom.get(syrup).amount, 10, '10: 100% preserves the base quantity');
    }

    // =======================================================================
    // 11 — deterministic across repeated calls (same input -> same output)
    // =======================================================================
    {
      const r1 = await buildEffectiveBom(client, recipeA, [{ choice_id: matchSource }]);
      const r2 = await buildEffectiveBom(client, recipeA, [{ choice_id: matchSource }]);
      const norm = (bom) => JSON.stringify([...bom.entries()].sort((x, y) => (x[0] > y[0] ? 1 : -1)));
      assert.equal(norm(r1.bom), norm(r2.bom), '11: identical input resolves to an identical BOM every time');
    }

    // =======================================================================
    // 12 — USE_BASE resolves to the recipe's own base amount (explicit no-op)
    // =======================================================================
    const useBase = await makeChoice({
      label: 'Syrup use base', effect_type: 'QUANTITY', target_material_id: syrup,
      amount: 777, // poisoned legacy fixed-amount field — must NEVER be used
      quantity_mode: 'USE_BASE',
    });
    {
      const { bom } = await buildEffectiveBom(client, recipeUseBase, [{ choice_id: useBase }]);
      assert.equal(bom.get(syrup).amount, 20, '12: USE_BASE resolves to the recipe\'s own base amount (20), not the poisoned fixed amount');
    }

    // =======================================================================
    // 13 — mixing a MATCH_SOURCE replace with an unrelated ADD composes correctly
    // =======================================================================
    const addWhippedCream = await makeChoice({ label: 'Add Whipped Cream', effect_type: 'ADD' });
    await addLink(addWhippedCream, whippedCream, 30);
    {
      const { bom } = await buildEffectiveBom(client, recipeA, [
        { choice_id: matchSource }, { choice_id: addWhippedCream },
      ]);
      assert.equal(bom.get(oatMilk).amount, 150, '13: MATCH_SOURCE still resolves correctly alongside an unrelated ADD');
      assert.equal(bom.get(whippedCream).amount, 30, '13: the unrelated ADD still composes correctly');
      assert.equal(bom.has(freshMilk), false, '13: source is still removed');
      assert.equal(bom.get(syrup).amount, 10, '13: untouched BOM lines still present');
    }

    // 15: every fixture above uses generic/neutral names only (Fresh Milk /
    // Oat Milk / Syrup / Whipped Cream) — no shop-specific or HIBI logic
    // anywhere in this file.
  } finally {
    await client.query('rollback');
    client.release();
  }
});
