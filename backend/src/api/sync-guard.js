// Emergency /sync hardening (Phase A0). The offline-first client posts the WHOLE dataset every sync,
// so we cannot reject merely because a protected resource is present — we compare the incoming values
// against current DB state and only require a permission when a protected field actually CHANGES.
// Owner/superadmin bypass entirely. Any unauthorized change aborts the whole transaction with a typed
// error (never a silent partial write).
//
// req.hasPerm(key) is the single authority (catalog resolver: legacy + new keys + aliases + defaults).

function deny(code, field) { const e = new Error(code); e.statusCode = 403; e.code = code; if (field) e.field = field; return e; }

// Normalize a scalar/object for stable comparison (null/undefined equal; numbers coerced; objects sorted).
function norm(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'object') return JSON.stringify(sortKeys(v));
  const n = Number(v);
  return (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(n) && String(n) === v.trim()) ? n : String(v).trim();
}
function sortKeys(o) {
  if (Array.isArray(o)) return o.map(sortKeys);
  if (o && typeof o === 'object') return Object.keys(o).sort().reduce((a, k) => { a[k] = sortKeys(o[k]); return a; }, {});
  return o;
}
function eq(a, b) { return norm(a) === norm(b); }

// POS Operations Manager (P0): availability change-detection that does NOT punish plain creation.
// A brand-new recipe/material always carries pos_available:true (the frontend's default), so
// treating "new row" as an automatic change (like rowChanged does for other fields) would force
// EVERY staff recipe/material creation to also require pos_toggle_availability — breaking existing
// recipe_edit-only staff. Only require the permission when the row is created/left in a NON-default
// (unavailable) state, or when an existing row's availability actually differs from the DB.
function availabilityChanged(incoming, dbRow) {
  const availIn = Object.prototype.hasOwnProperty.call(incoming, 'pos_available') ? incoming.pos_available : undefined;
  const reasonIn = Object.prototype.hasOwnProperty.call(incoming, 'pos_unavailable_reason') ? incoming.pos_unavailable_reason : undefined;
  if (!dbRow) {
    return availIn === false || (reasonIn != null && reasonIn !== '');
  }
  const fields = ['pos_available', 'pos_unavailable_reason'];
  return rowChanged(incoming, dbRow, fields);
}

// Compare monitored fields of an incoming row vs its DB row. Returns true if any differs (a change).
// Only fields the incoming row actually CONTAINS are considered — a field the client omitted is not
// asserted as a change (avoids false positives from DB defaults / partial payloads). A brand-new id
// (no DB row) is always a change (creation).
function rowChanged(incoming, dbRow, fields) {
  if (!dbRow) return true; // new id → creation
  for (const f of fields) {
    if (!Object.prototype.hasOwnProperty.call(incoming, f)) continue;
    if (!eq(incoming[f], dbRow[f])) return true;
  }
  return false;
}

async function checkSyncPermissions(client, req, b) {
  if (req.isSuperadmin === true || req.role === 'owner') return; // full bypass (unchanged behavior)
  const shopId = req.shopId;
  const has = (k) => req.hasPerm(k);

  // 1) staff_permissions — the self-elevation vector. Any change needs team_edit_permissions.
  if (b.shop_settings && Object.prototype.hasOwnProperty.call(b.shop_settings, 'staff_permissions')) {
    let dbSp = (await client.query('select staff_permissions from shop_settings where shop_id=$1', [shopId])).rows[0];
    dbSp = dbSp ? dbSp.staff_permissions : null;
    if (typeof dbSp === 'string') { try { dbSp = JSON.parse(dbSp); } catch (e) { dbSp = null; } }
    let inSp = b.shop_settings.staff_permissions;
    if (typeof inSp === 'string') { try { inSp = JSON.parse(inSp); } catch (e) { inSp = null; } }
    if (!eq(inSp || {}, dbSp || {}) && !has('team_edit_permissions')) throw deny('ROLE_ESCALATION_DENIED', 'staff_permissions');
  }

  // 2) other shop_settings fields — any managed-field change needs store_settings_edit.
  if (b.shop_settings) {
    const managed = ['phone', 'tax_id', 'address', 'bank', 'account', 'holder', 'promptpay', 'logo_url', 'theme',
      'categories', 'make_to_order', 'use_petty_cash', 'public_menu_enabled', 'use_delivery', 'order_payment_mode',
      'public_slug', 'kitchen_ticket_mode', 'member_config', 'business_type', 'vat_enabled', 'vat_rate',
      'staff_discount_max', 'staff_discount_max_baht', 'discount_presets', 'pos_categories', 'menu_config'];
    const db = (await client.query('select * from shop_settings where shop_id=$1', [shopId])).rows[0] || {};
    for (const f of managed) {
      if (Object.prototype.hasOwnProperty.call(b.shop_settings, f) && !eq(b.shop_settings[f], db[f])) {
        if (!has('store_settings_edit')) throw deny('STORE_SETTINGS_READ_ONLY', f);
      }
    }
  }

  // 3) shop name — change needs store_settings_edit.
  if (b.shop && b.shop.name != null) {
    const db = (await client.query('select name from shops where id=$1', [shopId])).rows[0];
    if (db && !eq(b.shop.name, db.name) && !has('store_settings_edit')) throw deny('STORE_SETTINGS_READ_ONLY', 'shop.name');
  }

  // 4) recipes — non-cost formula/identity change needs recipe_edit.
  if (Array.isArray(b.recipes) && b.recipes.length) {
    const ids = b.recipes.map((r) => r.id).filter(Boolean);
    const dbRows = ids.length ? (await client.query('select * from recipes where shop_id=$1 and id = any($2::uuid[])', [shopId, ids])).rows : [];
    const dbById = Object.fromEntries(dbRows.map((r) => [r.id, r]));
    const RECIPE_FIELDS = ['name', 'yield_unit', 'batch_yield', 'inventory_mode', 'category', 'recipe_type', 'output_item_type'];
    for (const r of b.recipes) {
      if (rowChanged(r, dbById[r.id], RECIPE_FIELDS) && !has('recipe_edit')) throw deny('RECIPE_READ_ONLY', 'recipes');
    }
    // POS Operations Manager (P0): menu availability (concept B) is DELIBERATELY separate from
    // recipe_edit — a manager toggling "sold out" must not need rights to edit the recipe formula,
    // and (per Founder guardrail) an availability change must never be gated behind a permission
    // whose denial could be mistaken for "hide the menu". Denial here only blocks the WRITE (the
    // whole tx aborts, nothing partial persists) — it never flips availability itself.
    for (const r of b.recipes) {
      if (availabilityChanged(r, dbById[r.id]) && !has('pos_toggle_availability')) {
        throw deny('POS_AVAILABILITY_PERMISSION_DENIED', 'recipes.pos_available');
      }
    }
    // recipe_items (BOM = formula/quantities) — compare the normalized item set per recipe.
    if (Array.isArray(b.recipe_items) || b.recipes.some((r) => Array.isArray(r.items))) {
      for (const r of b.recipes) {
        if (!Array.isArray(r.items)) continue;
        const dbItems = (await client.query('select material_id, amount, role, sub_recipe_id from recipe_items where recipe_id=$1', [r.id])).rows;
        const key = (x) => [x.material_id || '', x.sub_recipe_id || '', norm(x.amount), x.role || ''].join('|');
        const dbSet = new Set(dbItems.map(key));
        const inSet = new Set(r.items.map((x) => key({ material_id: x.matId || x.material_id, sub_recipe_id: x.subId || x.sub_recipe_id, amount: x.amount, role: x.role })));
        const changed = dbSet.size !== inSet.size || [...inSet].some((k) => !dbSet.has(k));
        if (changed && !has('recipe_edit')) throw deny('RECIPE_READ_ONLY', 'recipe_items');
      }
    }
  }

  // 5) materials — definition change needs recipe_edit; cost change needs recipe_edit_cost.
  if (Array.isArray(b.materials) && b.materials.length) {
    const ids = b.materials.map((m) => m.id).filter(Boolean);
    const dbRows = ids.length ? (await client.query('select * from materials where shop_id=$1 and id = any($2::uuid[])', [shopId, ids])).rows : [];
    const dbById = Object.fromEntries(dbRows.map((m) => [m.id, m]));
    for (const m of b.materials) {
      const db = dbById[m.id];
      // definition/packaging change → recipe_edit
      if (rowChanged(m, db, ['name', 'unit', 'stock_unit', 'item_type', 'qty', 'conv_qty']) && !has('recipe_edit')) throw deny('RECIPE_READ_ONLY', 'materials');
      // money cost = price. A null price is a no-cost user's redacted value being preserved (COALESCE) — not a change.
      if (m.price != null && rowChanged({ price: m.price }, db, ['price']) && !has('recipe_edit_cost')) throw deny('RECIPE_COST_READ_ONLY', 'materials.cost');
      // POS Operations Manager (P0): see the recipes block above for the full rationale — same
      // decoupling from recipe_edit, same "new row default-available never needs the permission".
      if (availabilityChanged(m, db) && !has('pos_toggle_availability')) {
        throw deny('POS_AVAILABILITY_PERMISSION_DENIED', 'materials.pos_available');
      }
    }
  }

  // 6) prod_logs — recording/executing production needs the production permission.
  if (Array.isArray(b.prod_logs) && b.prod_logs.length) {
    const ids = b.prod_logs.map((p) => p.id).filter(Boolean);
    const dbRows = ids.length ? (await client.query('select id, made, rounds, recipe_id from prod_logs where shop_id=$1 and id = any($2::uuid[])', [shopId, ids])).rows : [];
    const dbById = Object.fromEntries(dbRows.map((p) => [p.id, p]));
    for (const p of b.prod_logs) {
      if (rowChanged(p, dbById[p.id], ['made', 'rounds', 'recipe_id']) && !(has('production_execute') || has('production_record_actual'))) {
        throw deny('PRODUCTION_READ_ONLY', 'prod_logs');
      }
    }
  }
}

module.exports = { checkSyncPermissions };
