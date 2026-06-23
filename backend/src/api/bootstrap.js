// GET /api/bootstrap — โหลดข้อมูลร้านปัจจุบันทั้งก้อน (แทน Promise.all ใน boot())
// คืน column แบบ snake_case ตรงกับที่ frontend map อยู่แล้ว
const express = require('express');
const { query } = require('../db');
const router = express.Router();

router.get('/bootstrap', async (req, res) => {
  try {
    const shopId = req.shopId;
    if (!shopId) return res.json({ shop: null, role: req.role, isSuperadmin: req.isSuperadmin });

    const [shop, settings, suppliers, materials, recipes, recipeItems, bills, sub, prodLogs, stockReceives, expenses, ogRows, ocRows, oclRows, rogRows, smRows, itemCats, recurringExp, cashTopups, ordersRows] = await Promise.all([
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
      query('select * from stock_movements where shop_id = $1 order by created_at desc limit 200', [shopId]),
      query('select * from item_categories order by sort_order'),
      query('select * from recurring_expenses where shop_id = $1 order by day_of_month', [shopId]),
      query('select * from cash_topups where shop_id = $1 order by topup_date desc limit 200', [shopId]),
      query('select * from orders where shop_id = $1 order by created_at desc limit 200', [shopId]),
    ]);

    res.json({
      server_now: new Date().toISOString(),
      role: req.role,
      isSuperadmin: req.isSuperadmin,
      shop: shop.rows[0] || null,
      settings: settings.rows[0] || null,
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
      stock_movements: smRows.rows,
      item_categories: itemCats.rows,
      recurring_expenses: recurringExp.rows,
      cash_topups: cashTopups.rows,
      orders: ordersRows.rows,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
