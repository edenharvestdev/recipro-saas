// M3: เมนูสาธารณะ + ลูกค้าสั่งเอง (ไม่ต้อง login) — เข้าถึงด้วย public_menu_token
const express = require('express');
const { query, tx } = require('../db');
const router = express.Router();

// หา shop จาก token (ต้องเปิดใช้ public menu)
async function shopByToken(token) {
  if (!token) return null;
  const r = await query(
    `select s.id, s.name from shops s
       join shop_settings ss on ss.shop_id = s.id
      where ss.public_menu_token = $1 and ss.public_menu_enabled = true`,
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
    const items = [
      ...recs.map(r => ({ id: r.id, type: 'recipe', name: r.name, price: Number(r.sell_price) || 0, img: r.img_data || '', category: r.category || '' })),
      ...mats.map(m => ({ id: m.id, type: 'material', name: m.name, price: Number(m.sell_price) || 0, img: m.img_data || '', category: m.category || '' })),
    ];
    res.json({ shop_name: shop.name, items });
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
      .map(it => ({ id: it.id, type: it.type === 'material' ? 'material' : 'recipe', name: String(it.name || '').slice(0, 120), qty: Number(it.qty) || 1, price: Number(it.price) || 0 }));
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
    res.json({ ok: true, order_no: out.order_no, queue_number: out.queue_number, total });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
