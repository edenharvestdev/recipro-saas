// M3: เมนูสาธารณะ + ลูกค้าสั่งเอง (ไม่ต้อง login) — เข้าถึงด้วย public_menu_token
const express = require('express');
const { query, tx } = require('../db');
const router = express.Router();

// หา shop จาก token (ต้องเปิดใช้ public menu)
async function shopByToken(token) {
  if (!token) return null;
  const r = await query(
    `select s.id, s.name, ss.promptpay, ss.logo_url, coalesce(ss.order_payment_mode,'postpay') as order_payment_mode from shops s
       join shop_settings ss on ss.shop_id = s.id
      where (ss.public_menu_token = $1 or ss.public_slug = $1) and ss.public_menu_enabled = true`,
    [token]);
  return r.rows[0] || null;
}

// GET /public/menu/:token — รายการเมนูที่ขาย (recipe ที่ไม่ใช่ RAW + วัตถุดิบที่ตั้งขาย)
router.get('/menu/:token', async (req, res) => {
  try {
    const shop = await shopByToken(req.params.token);
    if (!shop) return res.status(404).json({ error: 'menu not found or disabled' });
    const recs = (await query(
      `select id, name, sell_price, img_data, category from recipes
        where shop_id = $1 and coalesce(on_menu, not coalesce(is_raw,false)) = true and coalesce(sell_price,0) > 0
        order by category nulls last, name`, [shop.id])).rows;
    const mats = (await query(
      `select id, name, coalesce(sell_price, price) as sell_price, img_data, category from materials
        where shop_id = $1 and sale_type = 'SELLABLE' and show_in_pos = true
        order by category nulls last, name`, [shop.id])).rows;
    // ตัวเลือก (option groups) ต่อเมนู — ให้ลูกค้าเลือกตอนสั่ง (หวาน/เปลี่ยนนม ฯลฯ)
    const groups = (await query(`select id, label, select_type, required from option_groups where shop_id=$1 and enabled=true order by sort`, [shop.id])).rows;
    const glinks = (await query(`select rog.recipe_id, rog.group_id from recipe_option_groups rog join option_groups og on og.id=rog.group_id where og.shop_id=$1`, [shop.id])).rows;
    const gchoices = (await query(`select oc.id, oc.group_id, oc.label, oc.price_add from option_choices oc join option_groups og on og.id=oc.group_id where og.shop_id=$1 and oc.enabled=true order by oc.sort`, [shop.id])).rows;
    const choicesByGroup = {}; gchoices.forEach(c => { (choicesByGroup[c.group_id] = choicesByGroup[c.group_id] || []).push({ id: c.id, label: c.label, price_add: Number(c.price_add) || 0 }); });
    const groupsById = {}; groups.forEach(g => { groupsById[g.id] = { id: g.id, label: g.label, select_type: g.select_type, required: g.required, choices: choicesByGroup[g.id] || [] }; });
    const groupsByRecipe = {}; glinks.forEach(l => { if (groupsById[l.group_id]) (groupsByRecipe[l.recipe_id] = groupsByRecipe[l.recipe_id] || []).push(groupsById[l.group_id]); });
    const items = [
      ...recs.map(r => ({ id: r.id, type: 'recipe', name: r.name, price: Number(r.sell_price) || 0, img: r.img_data || '', category: r.category || '', options: (groupsByRecipe[r.id] || []).filter(g => g.choices.length) })),
      ...mats.map(m => ({ id: m.id, type: 'material', name: m.name, price: Number(m.sell_price) || 0, img: m.img_data || '', category: m.category || '', options: [] })),
    ];
    res.json({ shop_name: shop.name, logo: shop.logo_url || '', items, payment: { mode: shop.order_payment_mode, promptpay: shop.promptpay || '' } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /public/order/:token — ลูกค้าสร้างออเดอร์ (request) → คืนหมายเลขคิว (ยังไม่ตัดสต๊อก/ยังไม่จ่าย — ร้านยืนยันทีหลัง)
router.post('/order/:token', async (req, res) => {
  try {
    const shop = await shopByToken(req.params.token);
    if (!shop) return res.status(404).json({ error: 'menu not found or disabled' });
    const { customer_name, customer_phone, items, note } = req.body || {};
    if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'no items' });
    const clean = items.filter(it => it && it.id && (Number(it.qty) || 0) > 0)
      .map(it => ({ id: it.id, type: it.type === 'material' ? 'material' : 'recipe', name: String(it.name || '').slice(0, 120), qty: Number(it.qty) || 1, price: Number(it.price) || 0,
        options: Array.isArray(it.options) ? it.options.slice(0, 12).map(o => ({ group_id: o.group_id || null, choice_id: o.choice_id || null, label: String(o.label || '').slice(0, 60), price_add: Number(o.price_add) || 0 })) : [] }));
    if (!clean.length) return res.status(400).json({ error: 'no valid items' });
    const total = clean.reduce((s, it) => s + it.price * it.qty, 0);
    const today = new Date().toISOString().slice(0, 10);
    const out = await tx(async (c) => {
      const qn = (await c.query("select count(*)::int n from orders where shop_id=$1 and created_at::date=$2", [shop.id, today])).rows[0].n + 1;
      const orderNo = 'QR-' + today.replace(/-/g, '').slice(2) + '-' + String(qn).padStart(3, '0');
      const r = await c.query(
        `insert into orders (shop_id, order_no, customer_name, customer_phone, items_json, total, status, queue_number, channel)
         values ($1,$2,$3,$4,$5,$6,'pending',$7,'qr') returning order_no, queue_number`,
        [shop.id, orderNo, String(customer_name || '').slice(0, 80), String(customer_phone || '').slice(0, 30),
         JSON.stringify({ items: clean, note: String(note || '').slice(0, 200) }), total, qn]);
      return r.rows[0];
    });
    res.json({ ok: true, order_no: out.order_no, queue_number: out.queue_number, total, payment: { mode: shop.order_payment_mode, promptpay: shop.promptpay || '' } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
