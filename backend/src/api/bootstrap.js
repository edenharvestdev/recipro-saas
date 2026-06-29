// GET /api/bootstrap — โหลดข้อมูลร้านปัจจุบันทั้งก้อน (แทน Promise.all ใน boot())
// คืน column แบบ snake_case ตรงกับที่ frontend map อยู่แล้ว
const express = require('express');
const { query } = require('../db');
const { computeBillingState, GRACE_DAYS } = require('../billing-state');
const router = express.Router();

router.get('/bootstrap', async (req, res) => {
  try {
    const shopId = req.shopId;
    if (!shopId) return res.json({ shop: null, role: req.role, isSuperadmin: req.isSuperadmin });

    const [shop, settings, suppliers, materials, recipes, recipeItems, bills, sub, prodLogs, stockReceives, expenses, ogRows, ocRows, oclRows, rogRows, mogRows, smRows, itemCats, recurringExp, cashTopups, ordersRows, customersRows, cashSessionsRows, promotionsRows] = await Promise.all([
      query('select * from shops where id = $1', [shopId]),
      query('select * from shop_settings where shop_id = $1', [shopId]),
      query('select * from suppliers where shop_id = $1', [shopId]),
      query('select * from materials where shop_id = $1', [shopId]),
      query('select * from recipes where shop_id = $1', [shopId]),
      query(
        `select ri.* from recipe_items ri
           join recipes r on r.id = ri.recipe_id
          where r.shop_id = $1`,
        [shopId]
      ),
      query('select * from bills where shop_id = $1', [shopId]),
      query('select * from subscriptions where shop_id = $1 limit 1', [shopId]),
      query('select * from prod_logs where shop_id = $1 order by log_date desc limit 200', [shopId]),
      query('select * from stock_receives where shop_id = $1 order by received_at desc limit 200', [shopId]),
      query('select * from expenses where shop_id = $1 order by expense_date desc limit 500', [shopId]),
      query('select * from option_groups where shop_id = $1 order by sort', [shopId]),
      query('select oc.* from option_choices oc join option_groups og on og.id = oc.group_id where og.shop_id = $1 order by oc.sort', [shopId]),
      query('select ocl.* from option_choice_links ocl join option_choices oc on oc.id = ocl.choice_id join option_groups og on og.id = oc.group_id where og.shop_id = $1', [shopId]),
      query('select * from recipe_option_groups where group_id in (select id from option_groups where shop_id = $1)', [shopId]),
      query('select * from material_option_groups where group_id in (select id from option_groups where shop_id = $1)', [shopId]),
      query('select * from stock_movements where shop_id = $1 order by created_at desc limit 200', [shopId]),
      query('select * from item_categories order by sort_order'),
      query('select * from recurring_expenses where shop_id = $1 order by day_of_month', [shopId]),
      query('select * from cash_topups where shop_id = $1 order by topup_date desc limit 200', [shopId]),
      query('select * from orders where shop_id = $1 order by created_at desc limit 200', [shopId]),
      query('select * from customers where shop_id = $1 order by updated_at desc limit 1000', [shopId]),
      query('select * from cash_sessions where shop_id = $1 order by opened_at desc limit 200', [shopId]),
      query('select * from promotions where shop_id = $1 order by created_at', [shopId]),
    ]);

    // billing: plan + สถานะ (state/days_left) ให้ frontend โชว์แถบเตือน + ล็อกฟีเจอร์ตามแพ็กเกจ
    const shopRow = shop.rows[0] || null;
    const subRow = sub.rows[0] || null;
    let plan = null;
    if (subRow && subRow.plan_id) {
      plan = (await query('select id, code, name, price_month, price_year, features_json from plans where id = $1', [subRow.plan_id])).rows[0] || null;
    }
    const bs = shopRow ? computeBillingState(shopRow.status, subRow, shopRow.trial_ends_at) : { state: 'trial', daysLeft: null };

    res.json({
      server_now: new Date().toISOString(),
      role: req.role,
      isSuperadmin: req.isSuperadmin,
      shop: shopRow,
      plan,
      billing: { state: bs.state, days_left: bs.daysLeft, grace_days: GRACE_DAYS, trial_ends_at: shopRow ? shopRow.trial_ends_at : null },
      settings: (() => { const s = settings.rows[0]; if (s) delete s.omise_secret_key; return s || null; })(),  // S8: ไม่ส่ง secret key ไป frontend
      suppliers: suppliers.rows,
      materials: materials.rows,
      recipes: recipes.rows,
      recipe_items: recipeItems.rows,
      bills: bills.rows,
      subscription: sub.rows[0] || null,
      prod_logs: prodLogs.rows,
      stock_receives: stockReceives.rows,
      expenses: expenses.rows,
      option_groups: ogRows.rows,
      option_choices: ocRows.rows,
      option_choice_links: oclRows.rows,
      recipe_option_groups: rogRows.rows,
      material_option_groups: mogRows.rows,
      stock_movements: smRows.rows,
      item_categories: itemCats.rows,
      recurring_expenses: recurringExp.rows,
      cash_topups: cashTopups.rows,
      orders: ordersRows.rows,
      customers: customersRows.rows,
      cash_sessions: cashSessionsRows.rows,
      promotions: promotionsRows.rows,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
