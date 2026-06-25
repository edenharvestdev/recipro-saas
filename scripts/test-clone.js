// เทส engine โคลนบน local: merryjane → ร้านชั่วคราว → ตรวจ id ใหม่ + remap + ลบทิ้ง
require('dotenv').config();
const { pool, query, tx } = require('../backend/src/db');
const { gatherFullShopData, importIntoShop } = require('../backend/src/api/clone');
const SRC = '86d3838d-1d26-42c4-9b2a-e2fb28f8572a'; // merryjane

(async () => {
  // สร้างร้านปลายทางชั่วคราว + shop_settings
  const dst = (await query("insert into shops (name, status) values ('CLONE-TEST', 'trial') returning id")).rows[0].id;
  await query("insert into shop_settings (shop_id, theme) values ($1, 'recipro')", [dst]);
  console.log('dst shop:', dst);
  try {
    const result = await tx(async (c) => {
      const data = await gatherFullShopData(c, SRC);
      console.log('SRC counts: mats', data.materials.length, 'recs', data.recipes.length, 'items', data.recipe_items.length,
        'groups', data.option_groups.length, 'choices', data.option_choices.length, 'links', data.option_choice_links.length, 'rog', data.recipe_option_groups.length);
      return importIntoShop(c, dst, data, { replace: true, resetStock: true, includeSettings: true });
    });
    console.log('IMPORTED:', JSON.stringify(result));

    // ตรวจสอบ
    const srcMatIds = new Set((await query('select id from materials where shop_id=$1', [SRC])).rows.map(r => r.id));
    const dstMats = (await query('select id, stock from materials where shop_id=$1', [dst])).rows;
    const idCollision = dstMats.filter(m => srcMatIds.has(m.id)).length;
    const stockNonZero = dstMats.filter(m => Number(m.stock) !== 0).length;

    // recipe_items ของ dst อ้างวัตถุดิบ/สูตรของ dst เท่านั้น (remap ถูก)?
    const badRefs = (await query(`
      select count(*)::int n from recipe_items ri
       join recipes r on r.id=ri.recipe_id
       where r.shop_id=$1 and (
         (ri.material_id is not null and ri.material_id not in (select id from materials where shop_id=$1)) or
         (ri.sub_recipe_id is not null and ri.sub_recipe_id not in (select id from recipes where shop_id=$1)))`, [dst])).rows[0].n;

    // option_choices target/variant remap ชี้ในร้าน dst?
    const badOpt = (await query(`
      select count(*)::int n from option_choices oc
       join option_groups og on og.id=oc.group_id
       where og.shop_id=$1 and (
         (oc.target_material_id is not null and oc.target_material_id not in (select id from materials where shop_id=$1)) or
         (oc.variant_recipe_id is not null and oc.variant_recipe_id not in (select id from recipes where shop_id=$1)))`, [dst])).rows[0].n;

    const dstCounts = {
      materials: dstMats.length,
      recipes: (await query('select count(*)::int n from recipes where shop_id=$1', [dst])).rows[0].n,
      recipe_items: (await query('select count(ri.*)::int n from recipe_items ri join recipes r on r.id=ri.recipe_id where r.shop_id=$1', [dst])).rows[0].n,
      option_groups: (await query('select count(*)::int n from option_groups where shop_id=$1', [dst])).rows[0].n,
    };
    console.log('\n=== VERIFY ===');
    console.log('dst counts:', JSON.stringify(dstCounts));
    console.log('id collisions (ควร 0):', idCollision);
    console.log('stock != 0 (ควร 0):', stockNonZero);
    console.log('recipe_items อ้างข้ามร้าน (ควร 0):', badRefs);
    console.log('option target/variant อ้างข้ามร้าน (ควร 0):', badOpt);
    const ok = idCollision === 0 && stockNonZero === 0 && badRefs === 0 && badOpt === 0
      && dstCounts.materials === result.materials && dstCounts.recipes === result.recipes;
    console.log(ok ? 'CLONE_TEST_PASS' : 'CLONE_TEST_FAIL');
  } finally {
    // ลบร้านทดสอบ (cascade ลบ master ทั้งหมด)
    await query('delete from shops where id=$1', [dst]);
    console.log('cleaned up dst shop');
  }
  await pool.end();
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
