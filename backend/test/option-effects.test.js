// Option Stock Effect Engine — management API tests (OE1..OE22). node test/option-effects.test.js
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const app = require('../src/app');
const { pool, query } = require('../src/db');

let base;
async function api(method, path, { token, body, shop } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  if (shop) headers['X-Shop-Id'] = shop;
  const r = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let data = null; try { data = await r.json(); } catch (_) {}
  return { status: r.status, data };
}
let passed = 0, failed = 0;
function check(name, cond, extra) { if (cond) { passed++; console.log('  ✓', name); } else { failed++; console.log('  ✗', name, extra !== undefined ? JSON.stringify(extra) : ''); } }

(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = 'http://127.0.0.1:' + server.address().port;
  const sfx = Math.random().toString(36).slice(2, 8);
  try {
    console.log('\n=== Option Stock Effect Engine — mgmt API (OE1-OE22) ===\n');
    const saEmail = 'oesa_' + sfx + '@t.local';
    const reg = await api('POST', '/auth/register', { body: { email: saEmail, password: 'password123' } });
    const hq = (await query("insert into shops(name) values('OE-HQ') returning id")).rows[0];
    await query("insert into memberships(user_id,shop_id,role) values($1,$2,'superadmin')", [reg.data.user.id, hq.id]);
    const saToken = (await api('POST', '/auth/login', { body: { email: saEmail, password: 'password123' } })).data.accessToken;
    const ownerEmail = 'oeowner_' + sfx + '@t.local';
    const shopA = (await api('POST', '/api/admin/shops', { token: saToken, body: { shopName: 'OE A', ownerEmail, ownerPassword: 'password123' } })).data.shopId;
    const ownerToken = (await api('POST', '/auth/login', { body: { email: ownerEmail, password: 'password123' } })).data.accessToken;
    const ownerBEmail = 'oeownerB_' + sfx + '@t.local';
    const shopB = (await api('POST', '/api/admin/shops', { token: saToken, body: { shopName: 'OE B', ownerEmail: ownerBEmail, ownerPassword: 'password123' } })).data.shopId;
    const staffEmail = 'oestaff_' + sfx + '@t.local';
    await api('POST', '/auth/register', { body: { email: staffEmail, password: 'password123' } });
    const staffLogin = await api('POST', '/auth/login', { body: { email: staffEmail, password: 'password123' } });
    const staffToken = staffLogin.data.accessToken;
    await query("INSERT INTO memberships(user_id,shop_id,role) VALUES($1,$2,'staff')", [staffLogin.data.user.id, shopA]);
    const setStaffPerms = (o) => query('update memberships set permissions=$1 where user_id=$2 and shop_id=$3', [JSON.stringify(o), staffLogin.data.user.id, shopA]);

    // catalog in shop A
    const freshMilk = (await query("insert into materials(shop_id,name,unit,stock,item_type,sku) values($1,'M Milk นมสด','ml',5000,'RAW','MILK-01') returning id", [shopA])).rows[0].id;
    const oatMilk = (await query("insert into materials(shop_id,name,unit,stock,item_type) values($1,'Oat Milk นมโอ๊ต','ml',3000,'RAW') returning id", [shopA])).rows[0].id;
    const iceCup = (await query("insert into materials(shop_id,name,unit,stock,item_type,sku) values($1,'ถ้วยน้ำแข็งแยก Ice Cup','pcs',900,'PACKAGING','COOL-CUP-58') returning id", [shopA])).rows[0].id;
    const syrup = (await query("insert into materials(shop_id,name,unit,stock,item_type) values($1,'ไซรัปวานิลลา','g',2000,'RAW') returning id", [shopA])).rows[0].id;
    const baseRecipe = (await query("insert into recipes(shop_id,code,name,is_raw,on_menu,fg_stock) values($1,'HBR01M21C','Clear Matcha มัทฉะ',false,true,0) returning id", [shopA])).rows[0].id;
    const cloudProduced = (await query("insert into recipes(shop_id,code,name,is_raw,on_menu,fg_stock) values($1,'PRD-CLOUD','Matcha Cloud ของกลาง',true,false,50) returning id", [shopA])).rows[0].id;
    // recipe cycle fixture: recipe X contains baseRecipe as sub → adding X as component of a choice on baseRecipe = circular
    const recipeX = (await query("insert into recipes(shop_id,code,name,is_raw) values($1,'RX','Recipe X',true) returning id", [shopA])).rows[0].id;
    await query("insert into recipe_items(recipe_id,sub_recipe_id,amount) values($1,$2,1)", [recipeX, baseRecipe]);
    // option group + choice attached to baseRecipe
    const grp = (await query("insert into option_groups(shop_id,label) values($1,'Milk / Cool Pack') returning id", [shopA])).rows[0].id;
    const choice = (await query("insert into option_choices(group_id,label) values($1,'Cool Pack') returning id", [grp])).rows[0].id;
    await query("insert into recipe_option_groups(group_id,recipe_id) values($1,$2)", [grp, baseRecipe]);
    // cross-shop material in B
    const bMat = (await query("insert into materials(shop_id,name,unit,stock) values($1,'B Milk','ml',100) returning id", [shopB])).rows[0].id;

    // OE1 owner lists (empty)
    const l0 = await api('GET', '/api/option-effects?choice_id=' + choice, { token: ownerToken, shop: shopA });
    check('OE1 owner lists effects (empty)', l0.status === 200 && Array.isArray(l0.data.effects) && l0.data.effects.length === 0, l0.data);

    // OE2 owner creates ADD MATERIAL
    const c1 = await api('POST', '/api/option-effects', { token: ownerToken, shop: shopA, body: { choice_id: choice, target_type: 'MATERIAL', target_ref_id: iceCup, action: 'ADD', amount: 1, unit: 'pcs' } });
    check('OE2 owner creates ADD effect (201)', c1.status === 201 && !!c1.data.effect.id, c1.data);
    const effId = c1.data.effect.id;

    // OE3 staff WITHOUT recipe_edit blocked
    await setStaffPerms({ recipe_view: true });
    const s1 = await api('POST', '/api/option-effects', { token: staffToken, shop: shopA, body: { choice_id: choice, target_type: 'MATERIAL', target_ref_id: iceCup, action: 'ADD', amount: 1 } });
    check('OE3 staff without recipe_edit → 403', s1.status === 403, s1.data);

    // OE4 staff WITH recipe_edit allowed
    await setStaffPerms({ recipe_view: true, recipe_edit: true });
    const s2 = await api('POST', '/api/option-effects', { token: staffToken, shop: shopA, body: { choice_id: choice, target_type: 'PACKAGING', target_ref_id: iceCup, action: 'ADD', amount: 1 } });
    check('OE4 staff with recipe_edit creates (201)', s2.status === 201, s2.data);

    // OE5 cross-shop target rejected
    const x1 = await api('POST', '/api/option-effects', { token: ownerToken, shop: shopA, body: { choice_id: choice, target_type: 'MATERIAL', target_ref_id: bMat, action: 'ADD', amount: 1 } });
    check('OE5 cross-shop target → CROSS_SHOP_TARGET', x1.status === 400 && x1.data.code === 'CROSS_SHOP_TARGET', x1.data);

    // OE6 missing target
    const x2 = await api('POST', '/api/option-effects', { token: ownerToken, shop: shopA, body: { choice_id: choice, target_type: 'MATERIAL', target_ref_id: '11111111-1111-1111-1111-111111111111', action: 'ADD', amount: 1 } });
    check('OE6 missing target → TARGET_NOT_FOUND', x2.status === 400 && x2.data.code === 'TARGET_NOT_FOUND', x2.data);

    // OE7 invalid target type
    const x3 = await api('POST', '/api/option-effects', { token: ownerToken, shop: shopA, body: { choice_id: choice, target_type: 'WIDGET', target_ref_id: iceCup, action: 'ADD', amount: 1 } });
    check('OE7 invalid target type → INVALID_TARGET_TYPE', x3.status === 400 && x3.data.code === 'INVALID_TARGET_TYPE', x3.data);

    // OE8 invalid action
    const x4 = await api('POST', '/api/option-effects', { token: ownerToken, shop: shopA, body: { choice_id: choice, target_type: 'MATERIAL', target_ref_id: iceCup, action: 'FROBNICATE', amount: 1 } });
    check('OE8 invalid action → INVALID_ACTION', x4.status === 400 && x4.data.code === 'INVALID_ACTION', x4.data);

    // OE9 NO_STOCK valid + mismatch
    const n1 = await api('POST', '/api/option-effects', { token: ownerToken, shop: shopA, body: { choice_id: choice, target_type: 'NO_STOCK', action: 'NO_STOCK' } });
    check('OE9a NO_STOCK/NO_STOCK → 201', n1.status === 201, n1.data);
    const n2 = await api('POST', '/api/option-effects', { token: ownerToken, shop: shopA, body: { choice_id: choice, target_type: 'NO_STOCK', action: 'ADD' } });
    check('OE9b NO_STOCK type + ADD → NO_STOCK_MISMATCH', n2.status === 400 && n2.data.code === 'NO_STOCK_MISMATCH', n2.data);

    // OE10 REPLACE validation (needs from + with)
    const r1 = await api('POST', '/api/option-effects', { token: ownerToken, shop: shopA, body: { choice_id: choice, target_type: 'MATERIAL', target_ref_id: oatMilk, replace_ref_id: freshMilk, action: 'REPLACE', amount: 150, unit: 'ml' } });
    check('OE10a REPLACE from+with → 201', r1.status === 201, r1.data);
    const r2 = await api('POST', '/api/option-effects', { token: ownerToken, shop: shopA, body: { choice_id: choice, target_type: 'MATERIAL', action: 'REPLACE', amount: 150 } });
    check('OE10b REPLACE missing "with" → REPLACE_WITH_REQUIRED', r2.status === 400 && r2.data.code === 'REPLACE_WITH_REQUIRED', r2.data);

    // OE11 amount <= 0
    const a0 = await api('POST', '/api/option-effects', { token: ownerToken, shop: shopA, body: { choice_id: choice, target_type: 'MATERIAL', target_ref_id: iceCup, action: 'ADD', amount: 0 } });
    check('OE11 amount 0 for ADD → AMOUNT_MUST_BE_POSITIVE', a0.status === 400 && a0.data.code === 'AMOUNT_MUST_BE_POSITIVE', a0.data);

    // OE12 circular recipe (adding recipeX as RECIPE_COMPONENT on a choice attached to baseRecipe, X contains baseRecipe)
    const cyc = await api('POST', '/api/option-effects', { token: ownerToken, shop: shopA, body: { choice_id: choice, target_type: 'RECIPE_COMPONENT', target_ref_id: recipeX, action: 'ADD', amount: 1 } });
    check('OE12 circular recipe → CIRCULAR_RECIPE', cyc.status === 400 && cyc.data.code === 'CIRCULAR_RECIPE', cyc.data);

    // OE13 produced item (non-circular) ok
    const prd = await api('POST', '/api/option-effects', { token: ownerToken, shop: shopA, body: { choice_id: choice, target_type: 'PRODUCED_ITEM', target_ref_id: cloudProduced, action: 'ADD', amount: 1 } });
    check('OE13 PRODUCED_ITEM add (non-circular) → 201', prd.status === 201, prd.data);

    // OE14 list shows effects with resolved names
    const l1 = await api('GET', '/api/option-effects?choice_id=' + choice, { token: ownerToken, shop: shopA });
    check('OE14 list resolves target names', l1.status === 200 && l1.data.effects.some(e => e.target_name === 'ถ้วยน้ำแข็งแยก Ice Cup'), l1.data.effects && l1.data.effects.map(e => e.target_name));

    // OE15 update
    const up = await api('PATCH', '/api/option-effects/' + effId, { token: ownerToken, shop: shopA, body: { amount: 2 } });
    check('OE15 update amount → 2', up.status === 200 && Number(up.data.effect.amount) === 2, up.data);

    // OE16 soft-disable
    const dis = await api('PATCH', '/api/option-effects/' + effId + '/disable', { token: ownerToken, shop: shopA });
    check('OE16 soft-disable → ok', dis.status === 200 && dis.data.ok === true, dis.data);
    const stillThere = (await query('select enabled from option_stock_effects where id=$1', [effId])).rows[0];
    check('OE16 disabled row retained (enabled=false)', stillThere && stillThere.enabled === false, stillThere);

    // OE17 reorder deterministic
    const listNow = (await query('select id from option_stock_effects where choice_id=$1 order by seq', [choice])).rows.map(r => r.id);
    const reordered = listNow.slice().reverse();
    const ro = await api('POST', '/api/option-effects/reorder', { token: ownerToken, shop: shopA, body: { choice_id: choice, order: reordered } });
    const seqNow = (await query('select id from option_stock_effects where choice_id=$1 order by seq', [choice])).rows.map(r => r.id);
    check('OE17 reorder applied deterministically', ro.status === 200 && JSON.stringify(seqNow) === JSON.stringify(reordered), { seqNow, reordered });

    // OE18 target search — material Thai + English + code/sku, shop-scoped
    const srchTh = await api('GET', '/api/option-effects/targets/search?target_type=MATERIAL&q=' + encodeURIComponent('นม'), { token: ownerToken, shop: shopA });
    check('OE18a search MATERIAL Thai "นม" finds milks', srchTh.status === 200 && srchTh.data.results.some(r => r.ref_id === freshMilk) && srchTh.data.results.some(r => r.ref_id === oatMilk), srchTh.data);
    const srchSku = await api('GET', '/api/option-effects/targets/search?target_type=MATERIAL&q=MILK-01', { token: ownerToken, shop: shopA });
    check('OE18b search MATERIAL by SKU fragment', srchSku.data.results.some(r => r.ref_id === freshMilk), srchSku.data);
    const srchRec = await api('GET', '/api/option-effects/targets/search?target_type=FINISHED_GOOD&q=' + encodeURIComponent('มัทฉะ'), { token: ownerToken, shop: shopA });
    check('OE18c search recipe Thai "มัทฉะ"', srchRec.data.results.some(r => r.ref_id === baseRecipe), srchRec.data);
    const srchCode = await api('GET', '/api/option-effects/targets/search?target_type=FINISHED_GOOD&q=HBR01', { token: ownerToken, shop: shopA });
    check('OE18d search recipe by code "HBR01"', srchCode.data.results.some(r => r.ref_id === baseRecipe), srchCode.data);
    const srchPack = await api('GET', '/api/option-effects/targets/search?target_type=PACKAGING&q=' + encodeURIComponent('ถ้วย'), { token: ownerToken, shop: shopA });
    check('OE18e search PACKAGING filters to packaging items', srchPack.data.results.some(r => r.ref_id === iceCup) && !srchPack.data.results.some(r => r.ref_id === freshMilk), srchPack.data);

    // OE19 no cross-shop search leakage
    const leak = await api('GET', '/api/option-effects/targets/search?target_type=MATERIAL&q=Milk', { token: ownerToken, shop: shopA });
    check('OE19 search shop-scoped (no shop B rows)', !leak.data.results.some(r => r.ref_id === bMat), leak.data);

    // OE20 preview
    const pv = await api('GET', '/api/option-effects/preview?choice_id=' + choice, { token: ownerToken, shop: shopA });
    check('OE20 preview returns effects + net_lines + engine flag', pv.status === 200 && Array.isArray(pv.data.effects) && Array.isArray(pv.data.net_lines) && pv.data.engine_enabled === false, pv.data);

    // OE21 target-type table
    const tt = await api('GET', '/api/option-effects/target-types', { token: ownerToken, shop: shopA });
    check('OE21 target-type table lists 6 types', tt.status === 200 && tt.data.target_types.length === 6, tt.data);

    // OE22 cross-shop choice access rejected (owner B cannot touch shop A choice)
    const ownerBToken = (await api('POST', '/auth/login', { body: { email: ownerBEmail, password: 'password123' } })).data.accessToken;
    const xchoice = await api('GET', '/api/option-effects?choice_id=' + choice, { token: ownerBToken, shop: shopB });
    check('OE22 cross-shop choice → CHOICE_NOT_FOUND', xchoice.status === 404 && xchoice.data.code === 'CHOICE_NOT_FOUND', xchoice.data);

  } catch (err) {
    console.error('UNEXPECTED ERROR:', err.message, err.stack);
    failed++;
  } finally {
    await pool.end();
    server.close();
    console.log('\n=== Results: ' + passed + ' passed, ' + failed + ' failed ===');
    process.exit(failed > 0 ? 1 : 0);
  }
})();
