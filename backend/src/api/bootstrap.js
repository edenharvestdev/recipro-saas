// GET /api/bootstrap — โหลดข้อมูลร้านปัจจุบันทั้งก้อน (แทน Promise.all ใน boot())
// คืน column แบบ snake_case ตรงกับที่ frontend map อยู่แล้ว
const express = require('express');
const { query } = require('../db');
const router = express.Router();

router.get('/bootstrap', async (req, res) => {
  try {
    const shopId = req.shopId;
    if (!shopId) return res.json({ shop: null, role: req.role, isSuperadmin: req.isSuperadmin });

    const [shop, settings, suppliers, materials, recipes, recipeItems, bills, sub] = await Promise.all([
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
    ]);

    res.json({
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
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
