const express = require('express');
const { query, tx } = require('../db');
const { logEvent } = require('../logs');
const router = express.Router();

// B3: test-only injection hook — module-level flag, never read from HTTP request body.
// Only registered/usable when NODE_ENV=test; production code path never touches this.
let _injectAt = null;
if (process.env.NODE_ENV === 'test') {
  // Internal control endpoint: POST /api/admin/selective-clone/_test/inject
  // Sets/resets the injection point for T10.  Not reachable in production.
  router.post('/selective-clone/_test/inject', (req, res) => {
    _injectAt = req.body && req.body.at ? req.body.at : null;
    res.json({ ok: true, injectAt: _injectAt });
  });
}

// Gather all shop master data
async function gatherFullShopData(c, shopId) {
  const get = (sql) => c.query(sql, [shopId]).then(r => r.rows);
  const suppliers = await get('select * from suppliers where shop_id=$1');
  const materials = await get('select * from materials where shop_id=$1');
  const recipes = await get('select * from recipes where shop_id=$1');
  const recipe_items = await get('select ri.* from recipe_items ri join recipes r on r.id=ri.recipe_id where r.shop_id=$1');
  const option_groups = await get('select * from option_groups where shop_id=$1');
  const option_choices = await get('select oc.* from option_choices oc join option_groups og on og.id=oc.group_id where og.shop_id=$1');
  const option_choice_links = await get('select ocl.* from option_choice_links ocl join option_choices oc on oc.id=ocl.choice_id join option_groups og on og.id=oc.group_id where og.shop_id=$1');
  const recipe_option_groups = await get('select rog.* from recipe_option_groups rog join option_groups og on og.id=rog.group_id where og.shop_id=$1');
  const material_option_groups = await get('select mog.* from material_option_groups mog join option_groups og on og.id=mog.group_id where og.shop_id=$1');
  const settings = (await get('select * from shop_settings where shop_id=$1'))[0] || null;
  return { suppliers, materials, recipes, recipe_items, option_groups, option_choices, option_choice_links, recipe_option_groups, material_option_groups, settings };
}

function genUUID(c) { return c.query('select gen_random_uuid() id').then(r => r.rows[0].id); }

// Find a unique name by appending (Copy), (Copy 2), etc. — tracks both existing and in-flight names
function findUniqueName(usedNames, baseName) {
  if (!usedNames.has(baseName)) return baseName;
  let candidate = `${baseName} (Copy)`;
  let n = 2;
  while (usedNames.has(candidate)) candidate = `${baseName} (Copy ${n++})`;
  return candidate;
}

// POST /api/admin/selective-clone
// body: { srcShopId, dstShopId, sections, conflictStrategy, dryRun, autoIncludeDependencies }
router.post('/selective-clone', async (req, res) => {
  const {
    srcShopId, dstShopId,
    sections: rawSections = [],
    conflictStrategy = 'skip',
    dryRun = false,
    autoIncludeDependencies = true
  } = req.body || {};

  if (!srcShopId || !dstShopId) return res.status(400).json({ error: 'srcShopId and dstShopId are required' });
  if (srcShopId === dstShopId) return res.status(400).json({ error: 'Source and destination shops must be different' });

  try {
    const src = (await query('select id, name from shops where id=$1', [srcShopId])).rows[0];
    const dst = (await query('select id, name from shops where id=$1', [dstShopId])).rows[0];
    if (!src) return res.status(404).json({ error: 'Source shop not found' });
    if (!dst) return res.status(404).json({ error: 'Destination shop not found' });

    const report = await tx(async (c) => {
      const srcData = await gatherFullShopData(c, srcShopId);
      const dstData = await gatherFullShopData(c, dstShopId);

      const conflicts = [];
      const dependencies = [];
      const logs = [];

      // Compute effective sections — auto-include option dependencies when cloning recipes
      const effectiveSections = [...rawSections];
      const autoIncludedGroupIds = new Set();

      if (autoIncludeDependencies && effectiveSections.includes('recipes') && !effectiveSections.includes('option_groups')) {
        for (const rog of srcData.recipe_option_groups) autoIncludedGroupIds.add(rog.group_id);
        if (autoIncludedGroupIds.size > 0) effectiveSections.push('option_groups');
      }

      const selectSec = (name) => effectiveSections.includes(name);

      // Maps: source ID → destination ID
      const supMap = new Map();
      const matMap = new Map();
      const recMap = new Map();
      const grpMap = new Map();
      const choMap = new Map();

      // Seed maps for items already in destination (matched by unique key)
      dstData.suppliers.forEach(s => { const x = srcData.suppliers.find(a => a.name === s.name); if (x) supMap.set(x.id, s.id); });
      dstData.materials.forEach(m => { const x = srcData.materials.find(a => a.sku === m.sku && m.sku); if (x) matMap.set(x.id, m.id); });
      dstData.recipes.forEach(r => { const x = srcData.recipes.find(a => a.code === r.code && r.code); if (x) recMap.set(x.id, r.id); });
      dstData.option_groups.forEach(g => { const x = srcData.option_groups.find(a => a.label === g.label); if (x) grpMap.set(x.id, g.id); });

      // --- Conflict Detection ---
      for (const s of srcData.suppliers) {
        const c2 = dstData.suppliers.find(x => x.name === s.name);
        if (c2) conflicts.push({ type: 'supplier', name: s.name, src_id: s.id, dst_id: c2.id });
      }
      for (const m of srcData.materials) {
        const c2 = dstData.materials.find(x => x.sku === m.sku && m.sku);
        if (c2) conflicts.push({ type: 'material', name: m.name, sku: m.sku, src_id: m.id, dst_id: c2.id });
      }
      for (const r of srcData.recipes) {
        const c2 = dstData.recipes.find(x => x.code === r.code && r.code);
        if (c2) conflicts.push({ type: 'recipe', name: r.name, code: r.code, src_id: r.id, dst_id: c2.id });
      }
      // Check conflicts only for groups in scope
      const groupsInScope = autoIncludedGroupIds.size > 0 && !rawSections.includes('option_groups')
        ? srcData.option_groups.filter(g => autoIncludedGroupIds.has(g.id))
        : srcData.option_groups;
      for (const g of groupsInScope) {
        const c2 = dstData.option_groups.find(x => x.label === g.label);
        if (c2) conflicts.push({ type: 'option_group', label: g.label, src_id: g.id, dst_id: c2.id });
      }

      // --- Dependency Validation ---
      if (selectSec('recipes') && !rawSections.includes('materials')) {
        for (const it of srcData.recipe_items) {
          if (it.material_id && !matMap.has(it.material_id)) {
            const mat = srcData.materials.find(x => x.id === it.material_id);
            dependencies.push({ type: 'missing_material', recipe_id: it.recipe_id, material_name: mat ? mat.name : 'Unknown' });
          }
        }
      }

      // Option dependency warnings when NOT auto-including
      if (rawSections.includes('recipes') && !rawSections.includes('option_groups') && !autoIncludeDependencies) {
        const recipesWithOpts = srcData.recipes.filter(r => srcData.recipe_option_groups.some(rog => rog.recipe_id === r.id));
        for (const r of recipesWithOpts) {
          const rogs = srcData.recipe_option_groups.filter(rog => rog.recipe_id === r.id);
          const groupIds = [...new Set(rogs.map(rog => rog.group_id))];
          const choiceCount = srcData.option_choices.filter(ch => groupIds.includes(ch.group_id)).length;
          dependencies.push({
            type: 'missing_option_dependencies',
            recipe_code: r.code,
            recipe_name: r.name,
            option_groups_count: groupIds.length,
            option_choices_count: choiceCount,
            message: 'Recipe นี้มี Option ที่เกี่ยวข้อง หากไม่ Clone Options เมนูที่สาขาปลายทางจะใช้งานไม่ครบ'
          });
        }
      }

      // T14: Warn when option choices reference target_material / variant_recipe not in clone scope
      // Prevents silent NULL after clone — dependency must be resolved or warned explicitly
      if (selectSec('option_groups')) {
        const groupsForDepCheck = autoIncludedGroupIds.size > 0 && !rawSections.includes('option_groups')
          ? srcData.option_groups.filter(g => autoIncludedGroupIds.has(g.id))
          : srcData.option_groups;
        const groupIdsForDep = new Set(groupsForDepCheck.map(g => g.id));
        for (const ch of srcData.option_choices) {
          if (!groupIdsForDep.has(ch.group_id)) continue;
          const grpLabel = (srcData.option_groups.find(g => g.id === ch.group_id) || {}).label || '';
          if (ch.target_material_id && !matMap.has(ch.target_material_id) && !rawSections.includes('materials')) {
            const mat = srcData.materials.find(m => m.id === ch.target_material_id);
            dependencies.push({
              type: 'choice_target_material_missing',
              choice_label: ch.label,
              group_label: grpLabel,
              material_name: mat ? mat.name : ch.target_material_id,
              message: `Choice "${ch.label}" (กลุ่ม: ${grpLabel}) อ้าง target_material ที่ไม่ได้ Clone — FK จะเป็น NULL หลัง Clone`
            });
          }
          if (ch.variant_recipe_id && !recMap.has(ch.variant_recipe_id) && !rawSections.includes('recipes')) {
            const rec = srcData.recipes.find(r => r.id === ch.variant_recipe_id);
            dependencies.push({
              type: 'choice_variant_recipe_missing',
              choice_label: ch.label,
              group_label: grpLabel,
              recipe_name: rec ? rec.name : ch.variant_recipe_id,
              message: `Choice "${ch.label}" (กลุ่ม: ${grpLabel}) อ้าง variant_recipe ที่ไม่ได้ Clone — FK จะเป็น NULL หลัง Clone`
            });
          }
        }
      }

      // B2: Block execute when choices reference missing target_material / variant_recipe.
      // Dry-run returns warnings; execute must be blocked until deps are resolved.
      if (!dryRun) {
        const fkDeps = dependencies.filter(d =>
          d.type === 'choice_target_material_missing' || d.type === 'choice_variant_recipe_missing'
        );
        if (fkDeps.length > 0) {
          const err = new Error('UNRESOLVED_CLONE_DEPENDENCIES');
          err.statusCode = 409;
          err.dependencies = fkDeps;
          throw err;
        }
      }

      // --- Dry-run ---
      if (dryRun) {
        const grpScope = autoIncludedGroupIds.size > 0 && !rawSections.includes('option_groups')
          ? srcData.option_groups.filter(g => autoIncludedGroupIds.has(g.id))
          : srcData.option_groups;
        const grpScopeIds = new Set(grpScope.map(g => g.id));
        const choScope = srcData.option_choices.filter(ch => grpScopeIds.has(ch.group_id));
        const choScopeIds = new Set(choScope.map(ch => ch.id));
        const linkScope = srcData.option_choice_links.filter(l => choScopeIds.has(l.choice_id));
        const rogScope = srcData.recipe_option_groups.filter(rog => grpScopeIds.has(rog.group_id));
        const mogScope = srcData.material_option_groups.filter(mog => grpScopeIds.has(mog.group_id));

        return {
          preview: {
            source: src.name,
            destination: dst.name,
            selected_sections: rawSections,
            effective_sections: effectiveSections,
            auto_included_option_groups: autoIncludedGroupIds.size,
            counts: {
              suppliers: selectSec('suppliers') ? srcData.suppliers.length : 0,
              materials: selectSec('materials') ? srcData.materials.length : 0,
              recipes: selectSec('recipes') ? srcData.recipes.length : 0,
              recipe_items: selectSec('recipes') ? srcData.recipe_items.length : 0,
              option_groups: selectSec('option_groups') ? grpScope.length : 0,
              option_choices: selectSec('option_groups') ? choScope.length : 0,
              option_choice_links: selectSec('option_groups') ? linkScope.length : 0,
              recipe_option_groups: selectSec('option_groups') ? rogScope.length : 0,
              material_option_groups: selectSec('option_groups') ? mogScope.length : 0,
            },
            conflicts,
            dependencies
          }
        };
      }

      // --- Execution ---
      const counts = { suppliers: 0, materials: 0, recipes: 0, recipe_items: 0, option_groups: 0, option_choices: 0, option_choice_links: 0, recipe_option_groups: 0, material_option_groups: 0 };

      // Track which src group IDs were reused vs newly created
      const reusedGroupIds = new Set();   // skip strategy: do NOT insert choices
      const updatedGroupIds = new Set();  // update strategy: reconcile choices by label

      // Section: Suppliers
      if (selectSec('suppliers')) {
        const usedNames = new Set(dstData.suppliers.map(s => s.name));
        for (const s of srcData.suppliers) {
          const conf = conflicts.find(x => x.type === 'supplier' && x.src_id === s.id);
          if (conf) {
            if (conflictStrategy === 'skip') {
              supMap.set(s.id, conf.dst_id); logs.push(`Skipped supplier "${s.name}" (already exists)`); continue;
            } else if (conflictStrategy === 'update') {
              await c.query('update suppliers set note=$1 where id=$2', [s.note, conf.dst_id]);
              supMap.set(s.id, conf.dst_id); logs.push(`Updated supplier "${s.name}"`); counts.suppliers++; continue;
            }
          }
          const id = await genUUID(c);
          const name = conf && conflictStrategy === 'copy' ? findUniqueName(usedNames, s.name) : s.name;
          usedNames.add(name); supMap.set(s.id, id);
          await c.query('insert into suppliers (id, shop_id, name, note) values ($1,$2,$3,$4)', [id, dstShopId, name, s.note]);
          logs.push(`Created supplier "${name}"`); counts.suppliers++;
        }
      }

      // Section: Materials
      if (selectSec('materials')) {
        const usedSkus = new Set(dstData.materials.filter(m => m.sku).map(m => m.sku));
        const usedNames = new Set(dstData.materials.map(m => m.name));
        for (const m of srcData.materials) {
          const conf = conflicts.find(x => x.type === 'material' && x.src_id === m.id);
          if (conf) {
            if (conflictStrategy === 'skip') {
              matMap.set(m.id, conf.dst_id); logs.push(`Skipped material "${m.name}" (already exists)`); continue;
            } else if (conflictStrategy === 'update') {
              const supId = m.supplier_id ? (supMap.get(m.supplier_id) || null) : null;
              await c.query(
                `update materials set name=$1, qty=$2, unit=$3, price=$4, sell_price=$5, supplier_id=$6, order_url=$7, low_stock=$8, category=$9, conv_qty=$10, stock_unit=$11, is_consumable=$12, sale_type=$13, show_in_pos=$14, sale_price_2=$15, item_type=$16, img_data=$17, pos_available=$18, pos_unavailable_reason=$19, updated_at=now() where id=$20`,
                [m.name, m.qty, m.unit, m.price, m.sell_price, supId, m.order_url, m.low_stock, m.category, m.conv_qty, m.stock_unit, m.is_consumable, m.sale_type, m.show_in_pos, m.sale_price_2, m.item_type, m.img_data, m.pos_available ?? true, m.pos_unavailable_reason ?? null, conf.dst_id]
              );
              matMap.set(m.id, conf.dst_id); logs.push(`Updated material "${m.name}"`); counts.materials++; continue;
            }
          }
          const id = await genUUID(c);
          let sku = m.sku, name = m.name;
          if (conf && conflictStrategy === 'copy') {
            if (sku) { let s2 = `${sku}_copy`, n2 = 2; while (usedSkus.has(s2)) s2 = `${sku}_copy${n2++}`; sku = s2; usedSkus.add(sku); }
            name = findUniqueName(usedNames, m.name);
          }
          usedNames.add(name); matMap.set(m.id, id);
          await c.query(
            `insert into materials (id, shop_id, sku, name, qty, unit, price, sell_price, supplier_id, order_url, stock, low_stock, category, conv_qty, stock_unit, is_consumable, sale_type, show_in_pos, sale_price_2, item_type, img_data, pos_available, pos_unavailable_reason)
             values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)`,
            [id, dstShopId, sku, name, m.qty, m.unit, m.price, m.sell_price, m.supplier_id ? (supMap.get(m.supplier_id) || null) : null, m.order_url, 0, m.low_stock, m.category, m.conv_qty, m.stock_unit, m.is_consumable, m.sale_type, m.show_in_pos, m.sale_price_2, m.item_type, m.img_data, m.pos_available ?? true, m.pos_unavailable_reason ?? null]
          );
          logs.push(`Created material "${name}"`); counts.materials++;
        }
      }

      // Section: Recipes & Recipe Items
      if (selectSec('recipes')) {
        const usedCodes = new Set(dstData.recipes.filter(r => r.code).map(r => r.code));
        const usedNames = new Set(dstData.recipes.map(r => r.name));
        for (const r of srcData.recipes) {
          const conf = conflicts.find(x => x.type === 'recipe' && x.src_id === r.id);
          if (conf) {
            if (conflictStrategy === 'skip') {
              recMap.set(r.id, conf.dst_id); logs.push(`Skipped recipe "${r.name}" (already exists)`); continue;
            } else if (conflictStrategy === 'update') {
              await c.query(
                `update recipes set name=$1, sell_price=$2, batch_yield=$3, yield_unit=$4, is_raw=$5, steps=$6, detail=$7, fg_low=$8, category=$9, opt_groups=$10, img_data=$11, is_sop=$12, recipe_type=$13, output_item_type=$14, on_menu=$15, inventory_mode=$16, pos_available=$17, pos_unavailable_reason=$18, updated_at=now() where id=$19`,
                [r.name, r.sell_price, r.batch_yield, r.yield_unit, r.is_raw, r.steps, r.detail, r.fg_low, r.category,
                 r.opt_groups == null ? null : (typeof r.opt_groups === 'string' ? r.opt_groups : JSON.stringify(r.opt_groups)),
                 r.img_data, r.is_sop, r.recipe_type, r.output_item_type, r.on_menu, r.inventory_mode || 'inherit', r.pos_available ?? true, r.pos_unavailable_reason ?? null, conf.dst_id]
              );
              recMap.set(r.id, conf.dst_id); logs.push(`Updated recipe "${r.name}"`); counts.recipes++; continue;
            }
          }
          const id = await genUUID(c);
          let code = r.code, name = r.name;
          if (conf && conflictStrategy === 'copy') {
            if (code) { let c2 = `${code}_copy`, n2 = 2; while (usedCodes.has(c2)) c2 = `${code}_copy${n2++}`; code = c2; usedCodes.add(code); }
            name = findUniqueName(usedNames, r.name);
          }
          usedNames.add(name); recMap.set(r.id, id);
          await c.query(
            `insert into recipes (id, shop_id, code, name, sell_price, batch_yield, yield_unit, is_raw, steps, detail, fg_stock, fg_low, category, opt_groups, img_data, is_sop, recipe_type, output_item_type, on_menu, inventory_mode, pos_available, pos_unavailable_reason)
             values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
            [id, dstShopId, code, name, r.sell_price, r.batch_yield, r.yield_unit, r.is_raw, r.steps, r.detail, 0, r.fg_low, r.category,
             r.opt_groups == null ? null : (typeof r.opt_groups === 'string' ? r.opt_groups : JSON.stringify(r.opt_groups)),
             r.img_data, r.is_sop, r.recipe_type, r.output_item_type, r.on_menu, r.inventory_mode || 'inherit', r.pos_available ?? true, r.pos_unavailable_reason ?? null]
          );
          logs.push(`Created recipe "${name}"`); counts.recipes++;
        }

        for (const it of srcData.recipe_items) {
          const recipe_id = recMap.get(it.recipe_id);
          if (!recipe_id) continue;
          const material_id = it.material_id ? (matMap.get(it.material_id) || null) : null;
          const sub_recipe_id = it.sub_recipe_id ? (recMap.get(it.sub_recipe_id) || null) : null;
          await c.query('delete from recipe_items where recipe_id=$1 and (material_id=$2 or sub_recipe_id=$3)', [recipe_id, material_id, sub_recipe_id]);
          await c.query('insert into recipe_items (recipe_id, material_id, amount, role, sub_recipe_id) values ($1,$2,$3,$4,$5)',
            [recipe_id, material_id, it.amount, it.role, sub_recipe_id]);
          counts.recipe_items++;
        }
      }

      // Section: Option Groups, Choices, Links, Relations
      if (selectSec('option_groups')) {
        // Filter to only groups in scope (auto-include = linked to cloned recipes; manual = all)
        const groupsToProcess = autoIncludedGroupIds.size > 0 && !rawSections.includes('option_groups')
          ? srcData.option_groups.filter(g => autoIncludedGroupIds.has(g.id))
          : srcData.option_groups;
        const processedSrcGroupIds = new Set(groupsToProcess.map(g => g.id));
        const usedGroupLabels = new Set(dstData.option_groups.map(g => g.label));

        for (const g of groupsToProcess) {
          const conf = conflicts.find(x => x.type === 'option_group' && x.src_id === g.id);

          if (conf) {
            if (conflictStrategy === 'skip') {
              grpMap.set(g.id, conf.dst_id);
              reusedGroupIds.add(g.id);  // prevent inserting choices into existing group
              logs.push(`Skipped option group "${g.label}" (reusing existing)`);
              continue;
            } else if (conflictStrategy === 'update') {
              await c.query(
                `update option_groups set label=$1, select_type=$2, required=$3, min_select=$4, max_select=$5, sort=$6, enabled=$7, visible_on_pos=$8, visible_on_receipt=$9, visible_on_kitchen=$10, visible_on_online=$11 where id=$12`,
                [g.label, g.select_type, g.required, g.min_select, g.max_select, g.sort, g.enabled, g.visible_on_pos, g.visible_on_receipt, g.visible_on_kitchen, g.visible_on_online, conf.dst_id]
              );
              grpMap.set(g.id, conf.dst_id);
              updatedGroupIds.add(g.id);  // reconcile choices by label match
              logs.push(`Updated option group "${g.label}"`);
              counts.option_groups++;
              continue;
            }
            // copy: create new group with unique label
          }

          const id = await genUUID(c);
          const label = conf && conflictStrategy === 'copy' ? findUniqueName(usedGroupLabels, g.label) : g.label;
          usedGroupLabels.add(label);
          grpMap.set(g.id, id);
          await c.query(
            `insert into option_groups (id, shop_id, label, select_type, required, min_select, max_select, sort, enabled, visible_on_pos, visible_on_receipt, visible_on_kitchen, visible_on_online)
             values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
            [id, dstShopId, label, g.select_type, g.required, g.min_select, g.max_select, g.sort, g.enabled, g.visible_on_pos, g.visible_on_receipt, g.visible_on_kitchen, g.visible_on_online]
          );
          logs.push(`Created option group "${label}"`);
          counts.option_groups++;
        }

        // Option Choices — strategy-aware, no blind inserts into existing groups
        for (const ch of srcData.option_choices) {
          const srcGroupId = ch.group_id;
          if (!processedSrcGroupIds.has(srcGroupId)) continue;  // not in scope

          const group_id = grpMap.get(srcGroupId);
          if (!group_id) continue;

          const targetMatId = ch.target_material_id ? (matMap.get(ch.target_material_id) || null) : null;
          const varRecId = ch.variant_recipe_id ? (recMap.get(ch.variant_recipe_id) || null) : null;

          if (reusedGroupIds.has(srcGroupId)) {
            // skip strategy: reuse existing group — match src choice to dst choice by label for choMap (needed for links)
            const existing = dstData.option_choices.find(ec =>
              ec.group_id === group_id && ec.label.trim().toLowerCase() === ch.label.trim().toLowerCase()
            );
            if (existing) choMap.set(ch.id, existing.id);
            // no INSERT — avoid duplicates in existing group
            continue;
          }

          if (updatedGroupIds.has(srcGroupId)) {
            // update strategy: reconcile by label — update matched, insert missing, leave extras
            const dstChoices = dstData.option_choices.filter(ec => ec.group_id === group_id);
            const matched = dstChoices.find(ec => ec.label.trim().toLowerCase() === ch.label.trim().toLowerCase());
            if (matched) {
              await c.query(
                `update option_choices set price_add=$1, effect_type=$2, enabled=$3, is_default=$4, sort=$5, max_qty=$6, target_role=$7, target_material_id=$8, variant_recipe_id=$9, is_metadata_only=$10, amount=$11 where id=$12`,
                [ch.price_add, ch.effect_type, ch.enabled, ch.is_default, ch.sort, ch.max_qty, ch.target_role, targetMatId, varRecId, ch.is_metadata_only, ch.amount, matched.id]
              );
              choMap.set(ch.id, matched.id);
              counts.option_choices++;
            } else {
              const id = await genUUID(c);
              choMap.set(ch.id, id);
              await c.query(
                `insert into option_choices (id, group_id, label, price_add, effect_type, enabled, is_default, sort, max_qty, target_role, target_material_id, variant_recipe_id, is_metadata_only, amount, quantity_mode, quantity_value, kitchen_note, add_menu_mode, mismatch_ack)
                 values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
                [id, group_id, ch.label, ch.price_add, ch.effect_type, ch.enabled, ch.is_default, ch.sort, ch.max_qty, ch.target_role, targetMatId, varRecId, ch.is_metadata_only, ch.amount, ch.quantity_mode ?? null, ch.quantity_value ?? null, ch.kitchen_note ?? null, ch.add_menu_mode ?? null, ch.mismatch_ack ?? false]
              );
              counts.option_choices++;
            }
            continue;
          }

          // New group: fresh INSERT
          const id = await genUUID(c);
          choMap.set(ch.id, id);
          await c.query(
            `insert into option_choices (id, group_id, label, price_add, effect_type, enabled, is_default, sort, max_qty, target_role, target_material_id, variant_recipe_id, is_metadata_only, amount, quantity_mode, quantity_value, kitchen_note, add_menu_mode, mismatch_ack)
             values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
            [id, group_id, ch.label, ch.price_add, ch.effect_type, ch.enabled, ch.is_default, ch.sort, ch.max_qty, ch.target_role, targetMatId, varRecId, ch.is_metadata_only, ch.amount, ch.quantity_mode ?? null, ch.quantity_value ?? null, ch.kitchen_note ?? null, ch.add_menu_mode ?? null, ch.mismatch_ack ?? false]
          );
          counts.option_choices++;
        }

        // B3: T10 test-only error injection — reads module-level flag set by /_test/inject endpoint.
        // Never reads from req.body. _injectAt is null in production (block above only runs in test).
        if (process.env.NODE_ENV === 'test' && _injectAt === 'option_choice_links') {
          throw new Error('TEST_INJECT: simulated error during option_choice_links insert');
        }

        // Option Choice Links — guard against duplicates (no unique constraint assumed)
        for (const l of srcData.option_choice_links) {
          const choice_id = choMap.get(l.choice_id);
          const material_id = matMap.get(l.material_id);
          if (!choice_id || !material_id) continue;
          const exists = await c.query('select 1 from option_choice_links where choice_id=$1 and material_id=$2 limit 1', [choice_id, material_id]);
          if (exists.rowCount) continue;
          await c.query('insert into option_choice_links (id, choice_id, material_id, amount) values (gen_random_uuid(),$1,$2,$3)', [choice_id, material_id, l.amount]);
          counts.option_choice_links++;
        }

        // Recipe Option Groups — link recipes to groups (ON CONFLICT DO NOTHING guards rerun)
        for (const rg of srcData.recipe_option_groups) {
          if (!processedSrcGroupIds.has(rg.group_id)) continue;
          const recipe_id = recMap.get(rg.recipe_id);
          const group_id = grpMap.get(rg.group_id);
          if (!recipe_id || !group_id) continue;
          await c.query('insert into recipe_option_groups (recipe_id, group_id, sort) values ($1,$2,$3) on conflict do nothing', [recipe_id, group_id, rg.sort ?? 0]);
          counts.recipe_option_groups++;
        }

        // Material Option Groups
        for (const mog of srcData.material_option_groups) {
          if (!processedSrcGroupIds.has(mog.group_id)) continue;
          const material_id = matMap.get(mog.material_id);
          const group_id = grpMap.get(mog.group_id);
          if (!material_id || !group_id) continue;
          await c.query('insert into material_option_groups (material_id, group_id, sort) values ($1,$2,$3) on conflict do nothing', [material_id, group_id, mog.sort ?? 0]);
          counts.material_option_groups++;
        }
      }

      // Section: Settings
      if (selectSec('settings') && srcData.settings) {
        const s = srcData.settings;
        await c.query(
          `update shop_settings set categories=$2, make_to_order=$3, member_config=$4, business_type=$5,
             vat_enabled=$6, vat_rate=$7, staff_discount_max=$8, staff_discount_max_baht=$9, discount_presets=$10,
             kitchen_ticket_mode=$11, use_delivery=$12, use_petty_cash=$13
           where shop_id=$1`,
          [dstShopId,
           s.categories == null ? null : (typeof s.categories === 'string' ? s.categories : JSON.stringify(s.categories)),
           s.make_to_order ?? false,
           s.member_config == null ? null : (typeof s.member_config === 'string' ? s.member_config : JSON.stringify(s.member_config)),
           s.business_type || 'fnb', s.vat_enabled ?? false, s.vat_rate ?? 7, s.staff_discount_max ?? 100, s.staff_discount_max_baht ?? 0,
           s.discount_presets == null ? null : (typeof s.discount_presets === 'string' ? s.discount_presets : JSON.stringify(s.discount_presets)),
           s.kitchen_ticket_mode || 'receipt', s.use_delivery ?? false, s.use_petty_cash ?? false]
        );
        logs.push(`Copied settings configuration`);
      }

      return { counts, logs };
    });

    if (dryRun) return res.json({ ok: true, ...report });

    logEvent(dstShopId, req.userId, 'admin.selective-clone', { srcShopId, sections: rawSections, conflictStrategy, ...report.counts });
    res.json({ ok: true, cloned: report.counts, logs: report.logs });

  } catch (e) {
    if (e.statusCode === 409) {
      return res.status(409).json({ error: e.message, dependencies: e.dependencies || [] });
    }
    res.status(500).json({ error: e.message });
  }
});

// GET /api/admin/export-shop/:id — ดาวน์โหลด bundle ข้อมูลร้าน (master) เป็น JSON
router.get('/export-shop/:id', async (req, res) => {
  try {
    const shop = (await query('select id, name from shops where id=$1', [req.params.id])).rows[0];
    if (!shop) return res.status(404).json({ error: 'ไม่พบร้าน' });
    const data = await tx(async (c) => gatherFullShopData(c, req.params.id));
    res.json({ ok: true, exported_at: new Date().toISOString(), source_shop: { id: shop.id, name: shop.name },
      counts: { materials: data.materials.length, recipes: data.recipes.length, option_groups: data.option_groups.length }, data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/admin/import-shop — นำเข้า bundle ลงร้านปลายทาง (id ใหม่ + remap)
router.post('/import-shop', async (req, res) => {
  const { dstShopId, bundle, replace, resetStock, includeSettings } = req.body || {};
  if (!dstShopId || !bundle || !bundle.data) return res.status(400).json({ error: 'ต้องมี dstShopId และ bundle.data' });
  try {
    const dst = (await query('select id from shops where id=$1', [dstShopId])).rows[0];
    if (!dst) return res.status(404).json({ error: 'ไม่พบร้านปลายทาง' });
    const out = await tx(async (c) => importIntoShop(c, dstShopId, bundle.data,
      { replace: replace !== false, resetStock: resetStock !== false, includeSettings: includeSettings !== false }));
    logEvent(dstShopId, req.userId, 'admin.import-shop', { source: bundle.source_shop && bundle.source_shop.name, ...out });
    res.json({ ok: true, imported: out });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/admin/clone-shop2 — โคลนตรงร้าน→ร้าน (gather + import ในทรานแซกชันเดียว, id ใหม่ + remap ครบ)
router.post('/clone-shop2', async (req, res) => {
  const { srcShopId, dstShopId, replace, resetStock, includeSettings } = req.body || {};
  if (!srcShopId || !dstShopId) return res.status(400).json({ error: 'ระบุ srcShopId และ dstShopId' });
  if (srcShopId === dstShopId) return res.status(400).json({ error: 'ต้นทาง/ปลายทางต้องไม่ใช่ร้านเดียวกัน' });
  try {
    const src = (await query('select id from shops where id=$1', [srcShopId])).rows[0];
    const dst = (await query('select id from shops where id=$1', [dstShopId])).rows[0];
    if (!src) return res.status(404).json({ error: 'ไม่พบร้านต้นทาง' });
    if (!dst) return res.status(404).json({ error: 'ไม่พบร้านปลายทาง' });
    const out = await tx(async (c) => {
      const data = await gatherFullShopData(c, srcShopId);
      return importIntoShop(c, dstShopId, data,
        { replace: replace !== false, resetStock: resetStock !== false, includeSettings: includeSettings !== false });
    });
    logEvent(dstShopId, req.userId, 'admin.clone-shop2', { srcShopId, ...out });
    res.json({ ok: true, cloned: out });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Full-replace import helper (used by import-shop and clone-shop2)
async function importIntoShop(c, dstShopId, data, opts = {}) {
  const { replace = true, resetStock = true, includeSettings = true } = opts;
  const out = { suppliers: 0, materials: 0, recipes: 0, recipe_items: 0, option_groups: 0, option_choices: 0, option_choice_links: 0, recipe_option_groups: 0, material_option_groups: 0 };

  if (replace) {
    await c.query('delete from material_option_groups where group_id in (select id from option_groups where shop_id=$1)', [dstShopId]);
    await c.query('delete from recipe_option_groups where group_id in (select id from option_groups where shop_id=$1)', [dstShopId]);
    await c.query('delete from option_choice_links where choice_id in (select oc.id from option_choices oc join option_groups og on og.id=oc.group_id where og.shop_id=$1)', [dstShopId]);
    await c.query('delete from option_choices where group_id in (select id from option_groups where shop_id=$1)', [dstShopId]);
    await c.query('delete from option_groups where shop_id=$1', [dstShopId]);
    await c.query('delete from recipe_items where recipe_id in (select id from recipes where shop_id=$1)', [dstShopId]);
    await c.query('delete from recipes where shop_id=$1', [dstShopId]);
    await c.query('delete from materials where shop_id=$1', [dstShopId]);
    await c.query('delete from suppliers where shop_id=$1', [dstShopId]);
  }

  const supMap = new Map(), matMap = new Map(), recMap = new Map(), grpMap = new Map(), choMap = new Map();

  for (const s of data.suppliers || []) {
    const id = await genUUID(c); supMap.set(s.id, id);
    await c.query('insert into suppliers (id, shop_id, name, note) values ($1,$2,$3,$4)', [id, dstShopId, s.name, s.note || null]);
    out.suppliers++;
  }
  for (const m of data.materials || []) {
    const id = await genUUID(c); matMap.set(m.id, id);
    await c.query(
      `insert into materials (id, shop_id, sku, name, qty, unit, price, sell_price, supplier_id, order_url, stock, low_stock, category, conv_qty, stock_unit, is_consumable, sale_type, show_in_pos, sale_price_2, item_type, img_data, pos_available, pos_unavailable_reason)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)`,
      [id, dstShopId, m.sku || null, m.name, m.qty, m.unit, m.price, m.sell_price, m.supplier_id ? (supMap.get(m.supplier_id) || null) : null,
       m.order_url || '', resetStock ? 0 : (m.stock || 0), m.low_stock || 0, m.category || null, m.conv_qty || null, m.stock_unit || null,
       m.is_consumable ?? false, m.sale_type || 'INGREDIENT_ONLY', m.show_in_pos ?? false, m.sale_price_2 ?? null, m.item_type || null, m.img_data || null,
       m.pos_available ?? true, m.pos_unavailable_reason ?? null]);
    out.materials++;
  }
  for (const r of data.recipes || []) {
    const id = await genUUID(c); recMap.set(r.id, id);
    await c.query(
      `insert into recipes (id, shop_id, code, name, sell_price, batch_yield, yield_unit, is_raw, steps, detail, fg_stock, fg_low, category, opt_groups, img_data, is_sop, recipe_type, output_item_type, on_menu, inventory_mode, pos_available, pos_unavailable_reason)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
      [id, dstShopId, r.code, r.name, r.sell_price, r.batch_yield, r.yield_unit, r.is_raw, r.steps || '', r.detail || '',
       resetStock ? 0 : (r.fg_stock || 0), r.fg_low || 0, r.category || null,
       r.opt_groups == null ? null : (typeof r.opt_groups === 'string' ? r.opt_groups : JSON.stringify(r.opt_groups)),
       r.img_data || null, r.is_sop || false, r.recipe_type || null, r.output_item_type || null, r.on_menu, r.inventory_mode || 'inherit',
       r.pos_available ?? true, r.pos_unavailable_reason ?? null]);
    out.recipes++;
  }
  for (const it of data.recipe_items || []) {
    const recipe_id = recMap.get(it.recipe_id);
    if (!recipe_id) continue;
    const material_id = it.material_id ? (matMap.get(it.material_id) || null) : null;
    const sub_recipe_id = it.sub_recipe_id ? (recMap.get(it.sub_recipe_id) || null) : null;
    await c.query('insert into recipe_items (recipe_id, material_id, amount, role, sub_recipe_id) values ($1,$2,$3,$4,$5)',
      [recipe_id, material_id, it.amount, it.role || '', sub_recipe_id]);
    out.recipe_items++;
  }
  // Fix C: include all visible_on_* columns so visibility settings are preserved on import
  for (const g of data.option_groups || []) {
    const id = await genUUID(c); grpMap.set(g.id, id);
    await c.query(
      `insert into option_groups (id, shop_id, label, select_type, required, min_select, max_select, sort, enabled, visible_on_pos, visible_on_receipt, visible_on_kitchen, visible_on_online)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [id, dstShopId, g.label, g.select_type, g.required, g.min_select, g.max_select, g.sort, g.enabled,
       g.visible_on_pos ?? true, g.visible_on_receipt ?? true, g.visible_on_kitchen ?? true, g.visible_on_online ?? true]);
    out.option_groups++;
  }
  for (const ch of data.option_choices || []) {
    const group_id = grpMap.get(ch.group_id);
    if (!group_id) continue;
    const id = await genUUID(c); choMap.set(ch.id, id);
    await c.query(
      `insert into option_choices (id, group_id, label, price_add, effect_type, enabled, is_default, sort, max_qty, target_role, target_material_id, variant_recipe_id, is_metadata_only, amount, quantity_mode, quantity_value, kitchen_note, add_menu_mode, mismatch_ack)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
      [id, group_id, ch.label, ch.price_add ?? 0, ch.effect_type || 'NONE', ch.enabled ?? true, ch.is_default ?? false, ch.sort ?? 0, ch.max_qty ?? 1,
       ch.target_role || '', ch.target_material_id ? (matMap.get(ch.target_material_id) || null) : null,
       ch.variant_recipe_id ? (recMap.get(ch.variant_recipe_id) || null) : null, ch.is_metadata_only ?? false, ch.amount ?? 0, ch.quantity_mode ?? null, ch.quantity_value ?? null, ch.kitchen_note ?? null, ch.add_menu_mode ?? null, ch.mismatch_ack ?? false]);
    out.option_choices++;
  }
  for (const l of data.option_choice_links || []) {
    const choice_id = choMap.get(l.choice_id);
    const material_id = matMap.get(l.material_id);
    if (!choice_id || !material_id) continue;
    await c.query('insert into option_choice_links (id, choice_id, material_id, amount) values (gen_random_uuid(),$1,$2,$3)',
      [choice_id, material_id, l.amount]);
    out.option_choice_links++;
  }
  for (const rg of data.recipe_option_groups || []) {
    const recipe_id = recMap.get(rg.recipe_id);
    const group_id = grpMap.get(rg.group_id);
    if (!recipe_id || !group_id) continue;
    await c.query('insert into recipe_option_groups (recipe_id, group_id, sort) values ($1,$2,$3) on conflict do nothing',
      [recipe_id, group_id, rg.sort ?? 0]);
    out.recipe_option_groups++;
  }
  for (const mog of data.material_option_groups || []) {
    const material_id = matMap.get(mog.material_id);
    const group_id = grpMap.get(mog.group_id);
    if (!material_id || !group_id) continue;
    await c.query('insert into material_option_groups (material_id, group_id, sort) values ($1,$2,$3) on conflict do nothing',
      [material_id, group_id, mog.sort ?? 0]);
    out.material_option_groups++;
  }
  if (includeSettings && data.settings) {
    const s = data.settings;
    await c.query(
      `update shop_settings set categories=$2, make_to_order=$3, member_config=$4, business_type=$5,
         vat_enabled=$6, vat_rate=$7, staff_discount_max=$8, staff_discount_max_baht=$9, discount_presets=$10,
         kitchen_ticket_mode=$11, use_delivery=$12, use_petty_cash=$13
       where shop_id=$1`,
      [dstShopId,
       s.categories == null ? null : (typeof s.categories === 'string' ? s.categories : JSON.stringify(s.categories)),
       s.make_to_order ?? false,
       s.member_config == null ? null : (typeof s.member_config === 'string' ? s.member_config : JSON.stringify(s.member_config)),
       s.business_type || 'fnb', s.vat_enabled ?? false, s.vat_rate ?? 7, s.staff_discount_max ?? 100, s.staff_discount_max_baht ?? 0,
       s.discount_presets == null ? null : (typeof s.discount_presets === 'string' ? s.discount_presets : JSON.stringify(s.discount_presets)),
       s.kitchen_ticket_mode || 'receipt', s.use_delivery ?? false, s.use_petty_cash ?? false]);
  }
  return out;
}

module.exports = router;
module.exports.gatherFullShopData = gatherFullShopData;
module.exports.importIntoShop = importIntoShop;
