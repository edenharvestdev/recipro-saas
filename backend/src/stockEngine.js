// Shared stock deduction engine — used by both POS (/api/pos/sell) and Delivery (/api/delivery).
// All functions receive a pg client `c` (inside a transaction) and operate atomically.
// Tenant isolation: every query filters by shop_id from the caller.

const TBL = { material: { table: 'materials', col: 'stock' }, recipe: { table: 'recipes', col: 'fg_stock' } };

// Insert one row into stock_movements and return its UUID.
async function logMove(c, shopId, userId, m) {
  const r = await c.query(
    `insert into stock_movements
       (shop_id,user_id,kind,ref_type,ref_id,ref_name,unit,
        qty_before,qty_after,delta,note,consumption_category,actor_name,reversal_of)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) returning id`,
    [shopId, userId || null, m.kind, m.ref_type, m.ref_id, m.ref_name || null, m.unit || null,
     m.before, m.after, (m.after - m.before),
     m.note || null, m.consumption_category || null, m.actor_name || null, m.reversal_of || null]
  );
  return r.rows[0].id;
}

// Validate option group rules for a single line (required, min_select, max_select, max_qty).
// Throws with statusCode + message on violation.
async function validateOptionsForLine(c, itemType, itemId, chosenOptions) {
  const opts = Array.isArray(chosenOptions) ? chosenOptions.filter(o => o && o.choice_id) : [];

  const groups = (await c.query(
    itemType === 'recipe'
      ? `select id, label, required, min_select, max_select from option_groups
         where id in (select group_id from recipe_option_groups where recipe_id=$1)
         and enabled=true`
      : `select id, label, required, min_select, max_select from option_groups
         where id in (select group_id from material_option_groups where material_id=$1)
         and enabled=true`,
    [itemId]
  )).rows;

  if (groups.length === 0) {
    if (opts.length > 0) { const e = new Error('OPTIONS_NOT_ALLOWED'); e.statusCode = 400; throw e; }
    return;
  }

  const groupIds = groups.map(g => g.id);
  const dbChoices = (await c.query(
    `select id, group_id, enabled, max_qty from option_choices
     where group_id = any($1::uuid[]) and enabled=true`,
    [groupIds]
  )).rows;

  for (const o of opts) {
    const ch = dbChoices.find(dc => dc.id === o.choice_id);
    if (!ch) { const e = new Error('INVALID_OPTION_CHOICE'); e.statusCode = 400; throw e; }
    const qty = Number(o.qty) || 1;
    if (ch.max_qty && qty > ch.max_qty) {
      const e = new Error('OPTION_QTY_EXCEEDED_MAX'); e.statusCode = 400; throw e;
    }
  }

  for (const g of groups) {
    const gChoiceIds = dbChoices.filter(ch => ch.group_id === g.id).map(ch => ch.id);
    const chosen = opts.filter(o => gChoiceIds.includes(o.choice_id));
    const count = chosen.length;
    if (g.required && count === 0) {
      const e = new Error(`REQUIRED_OPTION_MISSING: ${g.label}`); e.statusCode = 400; throw e;
    }
    if (g.min_select && count < g.min_select) {
      const e = new Error(`OPTION_MIN_SELECT_UNMET: ${g.label}`); e.statusCode = 400; throw e;
    }
    if (g.max_select && count > g.max_select) {
      const e = new Error(`OPTION_MAX_SELECT_EXCEEDED: ${g.label}`); e.statusCode = 400; throw e;
    }
  }
}

// Build effective BOM for a recipe after applying chosen options (RECIPE_VARIANT/REPLACE/ADD/QUANTITY).
async function buildEffectiveBom(c, recipeId, chosenOptions) {
  const opts = Array.isArray(chosenOptions) ? chosenOptions.filter(o => o && o.choice_id) : [];
  let choices = [];
  if (opts.length) {
    const ids = opts.map(o => o.choice_id);
    const qById = {}; opts.forEach(o => { qById[o.choice_id] = Number(o.qty) || 1; });
    const cr = (await c.query(
      `select id, effect_type, target_role, target_material_id, variant_recipe_id,
              is_metadata_only, amount, quantity_mode, quantity_value from option_choices where id=any($1::uuid[])`,
      [ids]
    )).rows;
    const lr = (await c.query(
      `select choice_id, material_id, amount from option_choice_links where choice_id=any($1::uuid[])`,
      [ids]
    )).rows;
    const byChoice = {};
    lr.forEach(l => { (byChoice[l.choice_id] = byChoice[l.choice_id] || []).push(l); });
    choices = cr
      .map(x => ({ ...x, qty: qById[x.id] || 1, links: byChoice[x.id] || [] }))
      .filter(x => !x.is_metadata_only);
  }

  const variant = choices.find(x => x.effect_type === 'RECIPE_VARIANT' && x.variant_recipe_id);
  const baseId = variant ? variant.variant_recipe_id : recipeId;

  const items = (await c.query(
    `select material_id, sub_recipe_id, amount, role from recipe_items where recipe_id=$1`,
    [baseId]
  )).rows;

  const bom = new Map();
  const subs = [];
  const roleIndex = new Map();

  for (const it of items) {
    if (it.sub_recipe_id) { subs.push({ sub_recipe_id: it.sub_recipe_id, amount: Number(it.amount) || 0 }); continue; }
    if (!it.material_id) continue;
    const e = bom.get(it.material_id) || { amount: 0 };
    e.amount += Number(it.amount) || 0;
    bom.set(it.material_id, e);
    if (it.role) roleIndex.set(it.role, it.material_id);
  }

  for (const ch of choices) {
    if (ch.effect_type !== 'REPLACE') continue;
    const oldId = ch.target_material_id || (ch.target_role ? roleIndex.get(ch.target_role) : null);

    // Additive: MATCH_SOURCE — the replacement's amount is the SOURCE
    // material's own resolved amount in THIS recipe's BOM, captured before
    // the delete below. If the source isn't present in this recipe's BOM
    // (unresolvable), the choice contributes nothing — never guess a link
    // amount as a fallback. null/'FIXED' (legacy rows) fall through
    // untouched to the original fixed-link-amount behavior.
    if (ch.quantity_mode === 'MATCH_SOURCE') {
      const srcEntry = oldId ? bom.get(oldId) : null;
      const sourceAmt = srcEntry ? (Number(srcEntry.amount) || 0) : null;
      if (oldId) { bom.delete(oldId); if (ch.target_role) roleIndex.delete(ch.target_role); }
      if (sourceAmt == null) continue;
      for (const l of ch.links) {
        if (!l.material_id) continue;
        const e = bom.get(l.material_id) || { amount: 0 };
        e.amount += sourceAmt;
        bom.set(l.material_id, e);
        if (ch.target_role) roleIndex.set(ch.target_role, l.material_id);
      }
      continue;
    }

    if (oldId) { bom.delete(oldId); if (ch.target_role) roleIndex.delete(ch.target_role); }
    for (const l of ch.links) {
      if (!l.material_id) continue;
      const e = bom.get(l.material_id) || { amount: 0 };
      e.amount += Number(l.amount) || 0;
      bom.set(l.material_id, e);
      if (ch.target_role) roleIndex.set(ch.target_role, l.material_id);
    }
  }

  for (const ch of choices) {
    if (ch.effect_type !== 'QUANTITY') continue;
    const matId = ch.target_material_id || (ch.target_role ? roleIndex.get(ch.target_role) : null);
    if (!matId) continue;

    // Additive: PERCENT_OF_BASE / USE_BASE — resolved relative to this
    // material's own amount in this recipe's BOM (as left by any prior
    // REPLACE effect), never a guessed/global value. null/'FIXED' (legacy
    // rows) fall through untouched to the original fixed-absolute behavior.
    if (ch.quantity_mode === 'PERCENT_OF_BASE' || ch.quantity_mode === 'USE_BASE') {
      const baseEntry = bom.get(matId);
      if (!baseEntry) continue; // base amount unresolvable in this BOM — contribute nothing, never guess
      const baseAmt = Number(baseEntry.amount) || 0;
      let newAmt;
      if (ch.quantity_mode === 'USE_BASE') {
        newAmt = baseAmt;
      } else {
        const rawPct = ch.quantity_value;
        const pct = (rawPct === null || rawPct === undefined || rawPct === '') ? NaN : Number(rawPct);
        if (!isFinite(pct)) continue; // invalid/unresolvable percent — never fall back to a fixed quantity
        newAmt = baseAmt * (pct / 100);
      }
      if (newAmt <= 0) bom.delete(matId);
      else { baseEntry.amount = newAmt; bom.set(matId, baseEntry); }
      continue;
    }

    const newAmt = Number(ch.amount) || 0;
    if (newAmt <= 0) bom.delete(matId);
    else { const e = bom.get(matId) || { amount: 0 }; e.amount = newAmt; bom.set(matId, e); }
  }

  for (const ch of choices) {
    if (ch.effect_type !== 'ADD') continue;
    for (const l of ch.links) {
      if (!l.material_id) continue;
      const e = bom.get(l.material_id) || { amount: 0 };
      e.amount += (Number(l.amount) || 0) * (ch.qty || 1);
      bom.set(l.material_id, e);
    }
  }

  for (const [k, v] of bom) { if (v.amount <= 0) bom.delete(k); }
  return { bom, subs };
}

// Deduct one material by amount. Enforces shop isolation; respects item_category deduction rules.
// cats: preloaded { code: { deducted, event } } map.
async function deductMaterial(c, shopId, userId, cats, matId, amount, defaultCcat, note) {
  const m = (await c.query(
    `select id,name,unit,stock,item_type from materials where id=$1 and shop_id=$2 for update`,
    [matId, shopId]
  )).rows[0];
  if (!m) {
    const globalCheck = (await c.query('select 1 from materials where id=$1', [matId])).rowCount > 0;
    const err = new Error(globalCheck ? 'FORBIDDEN_MATERIAL' : 'MATERIAL_NOT_FOUND');
    err.statusCode = globalCheck ? 403 : 404; throw err;
  }
  const cat = m.item_type ? cats[m.item_type] : null;
  const isDirectSale = defaultCcat === 'on_sale';
  if (cat && cat.deducted === false && !(m.item_type === 'SALE' && isDirectSale)) {
    return { type: 'skip', ref_id: matId, item_type: m.item_type };
  }
  const ccat = (cat && cat.event && cat.event !== 'none') ? cat.event : defaultCcat;
  const before = Number(m.stock) || 0;
  const after = Math.max(0, before - amount);
  await c.query('update materials set stock=$1, updated_at=now() where id=$2', [after, matId]);
  const mvId = await logMove(c, shopId, userId, {
    kind: 'sale', ref_type: 'material', ref_id: matId, ref_name: m.name,
    unit: m.unit, before, after, note, consumption_category: ccat
  });
  return { type: 'material', ref_id: matId, item_type: m.item_type || null, before, after, mvId };
}

// Deduct recipe fg_stock.
async function deductRecipeFg(c, shopId, userId, rec, amount, ccat, tag, note) {
  const before = Number(rec.fg_stock) || 0;
  const after = Math.max(0, before - amount);
  await c.query('update recipes set fg_stock=$1, updated_at=now() where id=$2', [after, rec.id]);
  const mvId = await logMove(c, shopId, userId, {
    kind: 'sale', ref_type: 'recipe', ref_id: rec.id, ref_name: rec.name,
    unit: rec.yield_unit, before, after, note, consumption_category: ccat
  });
  return { type: tag, ref_id: rec.id, before, after, mvId };
}

// Reverse a set of deduct movements (for batch void or bill void).
// Returns array of { ref_id, ref_type, before, after, mvId }.
// Idempotency: checks reversal_of UNIQUE index — duplicate call returns { alreadyVoided: true }.
async function reverseMovements(c, shopId, userId, deductMovementIds, voidNote) {
  if (!deductMovementIds.length) return { results: [], alreadyVoided: false };

  const alreadyCheck = await c.query(
    'select 1 from stock_movements where shop_id=$1 and reversal_of=any($2::uuid[]) limit 1',
    [shopId, deductMovementIds]
  );
  if (alreadyCheck.rowCount) return { results: [], alreadyVoided: true };

  const moves = (await c.query(
    `select id, ref_type, ref_id, ref_name, unit, delta
     from stock_movements where id=any($1::uuid[]) and shop_id=$2`,
    [deductMovementIds, shopId]
  )).rows;

  const results = [];
  for (const mv of moves) {
    const restore = -Number(mv.delta);
    if (!(restore > 0)) continue;
    const meta = TBL[mv.ref_type]; if (!meta) continue;
    const cur = (await c.query(
      `select ${meta.col} as q, name from ${meta.table} where id=$1 and shop_id=$2 for update`,
      [mv.ref_id, shopId]
    )).rows[0];
    if (!cur) continue;
    const before = Number(cur.q) || 0;
    const after = before + restore;
    await c.query(`update ${meta.table} set ${meta.col}=$1, updated_at=now() where id=$2`, [after, mv.ref_id]);
    const mvId = await logMove(c, shopId, userId, {
      kind: 'void', ref_type: mv.ref_type, ref_id: mv.ref_id,
      ref_name: mv.ref_name || cur.name, unit: mv.unit,
      before, after, note: voidNote, consumption_category: 'void', reversal_of: mv.id
    });
    results.push({ ref_id: mv.ref_id, ref_type: mv.ref_type, before, after, mvId });
  }
  return { results, alreadyVoided: false };
}

// Load item_categories lookup map for deductMaterial.
async function loadCats(c) {
  const cats = {};
  for (const r of (await c.query('select code, is_stock_deducted, deduct_event from item_categories')).rows) {
    cats[r.code] = { deducted: r.is_stock_deducted, event: r.deduct_event };
  }
  return cats;
}

// Compute cost per produced unit for a recipe: sum(BOM material costs) / batch_yield.
// Shared canonical cost source used by Delivery COGS, future POS reports, P&L.
// Uses current material prices — caller snapshots result into delivery_sales_items.cogs_amount.
async function computeRecipeCostPerUnit(c, shopId, recipeId) {
  const rec = (await c.query(
    'SELECT batch_yield FROM recipes WHERE id=$1 AND shop_id=$2',
    [recipeId, shopId]
  )).rows[0];
  const batchYield = Number(rec?.batch_yield) || 1;

  const items = (await c.query(
    'SELECT material_id, sub_recipe_id, amount FROM recipe_items WHERE recipe_id=$1',
    [recipeId]
  )).rows;

  const matItems = items.filter(i => i.material_id);
  let totalCost = 0;

  if (matItems.length) {
    const matIds = matItems.map(i => i.material_id);
    const prices = (await c.query(
      'SELECT id, price, qty, conv_qty FROM materials WHERE id=ANY($1::uuid[]) AND shop_id=$2',
      [matIds, shopId]
    )).rows;
    const priceMap = Object.fromEntries(prices.map(p => {
      const pQty = Number(p.qty) || 1;
      const cQty = Number(p.conv_qty) || 1;
      return [p.id, pQty > 0 ? Number(p.price) / (pQty * cQty) : 0];
    }));
    for (const it of matItems) {
      totalCost += (priceMap[it.material_id] || 0) * Number(it.amount || 0);
    }
  }

  for (const it of items.filter(i => i.sub_recipe_id)) {
    const subCost = await computeRecipeCostPerUnit(c, shopId, it.sub_recipe_id);
    totalCost += subCost * Number(it.amount || 0);
  }

  return batchYield > 0 ? totalCost / batchYield : 0;
}

module.exports = { TBL, logMove, validateOptionsForLine, buildEffectiveBom, deductMaterial, deductRecipeFg, reverseMovements, loadCats, computeRecipeCostPerUnit };
