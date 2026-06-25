// S8: Payment Gateway (Omise/Opn) — โครงพร้อมเสียบคีย์ (โหมด test) + mock ให้เทสได้ไม่ต้องมีคีย์
// ปลอดภัย: secret key อ่าน/ใช้ฝั่ง server เท่านั้น (ไม่ส่งไป frontend); แต่ละร้านใช้คีย์ของตัวเอง
const express = require('express');
const { query } = require('../db');
const router = express.Router();

const OMISE_API = 'https://api.omise.co';

// เรียก Omise ด้วย Basic auth (secret key เป็น username) — ใช้ global fetch (Node 18+)
async function omiseRequest(secret, method, path, body) {
  const auth = 'Basic ' + Buffer.from(secret + ':').toString('base64');
  const res = await fetch(OMISE_API + path, {
    method,
    headers: { Authorization: auth, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body ? new URLSearchParams(body).toString() : undefined,
  });
  const data = await res.json();
  if (!res.ok || data.object === 'error') throw new Error(data.message || ('omise ' + res.status));
  return data;
}

async function shopGateway(shopId) {
  const r = await query('select pay_gateway, omise_public_key, omise_secret_key from shop_settings where shop_id=$1', [shopId]);
  return r.rows[0] || {};
}

// GET /api/pay/status — สถานะ gateway ของร้าน (ไม่ส่ง secret)
router.get('/pay/status', async (req, res) => {
  if (!req.shopId) return res.status(400).json({ error: 'no shop' });
  try {
    const g = await shopGateway(req.shopId);
    res.json({ gateway: g.pay_gateway || '', enabled: g.pay_gateway === 'omise' && !!g.omise_secret_key,
      has_secret: !!g.omise_secret_key, public_key: g.omise_public_key || '' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/pay/keys — เจ้าของบันทึกคีย์ + เปิด/ปิด gateway (owner/superadmin)
router.post('/pay/keys', async (req, res) => {
  if (!req.shopId) return res.status(400).json({ error: 'no shop' });
  if (!(req.role === 'owner' || req.isSuperadmin)) return res.status(403).json({ error: 'owner only' });
  const pub = String(req.body.public_key || '').trim();
  const sec = String(req.body.secret_key || '').trim();
  const enable = req.body.enable !== false;
  try {
    // ถ้าไม่ส่ง secret มา (เว้นว่าง) = ไม่แก้ secret เดิม (กันลบโดยไม่ตั้งใจ)
    if (sec) {
      await query('update shop_settings set pay_gateway=$2, omise_public_key=$3, omise_secret_key=$4 where shop_id=$1',
        [req.shopId, enable ? 'omise' : '', pub, sec]);
    } else {
      await query('update shop_settings set pay_gateway=$2, omise_public_key=$3 where shop_id=$1',
        [req.shopId, enable ? 'omise' : '', pub]);
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/pay/charge { amount, source_type, token, bill_no } — สร้างรายการจ่าย (PromptPay/บัตร)
// ถ้าไม่มี secret → โหมด mock (คืน charge ปลอม ให้เทส flow ได้)
router.post('/pay/charge', async (req, res) => {
  if (!req.shopId) return res.status(400).json({ error: 'no shop' });
  const amount = Math.round(Number(req.body.amount) * 100);   // เป็นสตางค์
  const sourceType = req.body.source_type === 'card' ? 'card' : 'promptpay';
  const billNo = String(req.body.bill_no || '').slice(0, 40);
  if (!(amount > 0)) return res.status(400).json({ error: 'amount ต้องมากกว่า 0' });
  try {
    const g = await shopGateway(req.shopId);
    if (!g.omise_secret_key) {
      // mock: ไม่มีคีย์จริง → สร้าง charge จำลอง (pending) ให้เทส flow + QR Box ได้
      const id = 'mock_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      await query('insert into pay_charges (id, shop_id, amount, status, source_type, bill_no) values ($1,$2,$3,$4,$5,$6)',
        [id, req.shopId, amount / 100, 'pending', sourceType, billNo]);
      return res.json({ ok: true, mock: true, charge_id: id, status: 'pending', qr: null,
        note: 'โหมดทดสอบ (ยังไม่ใส่คีย์ Omise) — ใช้ /pay/charge/:id/mock-paid เพื่อจำลองจ่ายสำเร็จ' });
    }
    // โหมดจริง: สร้าง charge ผ่าน Omise
    const body = { amount, currency: 'thb', 'metadata[shop_id]': req.shopId, 'metadata[bill_no]': billNo };
    if (sourceType === 'card') { body.card = String(req.body.token || ''); }
    else { body['source[type]'] = 'promptpay'; }
    const ch = await omiseRequest(g.omise_secret_key, 'POST', '/charges', body);
    const qr = ch.source && ch.source.scannable_code && ch.source.scannable_code.image
      ? ch.source.scannable_code.image.download_uri : null;
    await query('insert into pay_charges (id, shop_id, amount, status, source_type, bill_no) values ($1,$2,$3,$4,$5,$6) on conflict (id) do nothing',
      [ch.id, req.shopId, amount / 100, ch.paid ? 'paid' : 'pending', sourceType, billNo]);
    res.json({ ok: true, charge_id: ch.id, status: ch.paid ? 'paid' : 'pending', qr, authorize_uri: ch.authorize_uri || null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/pay/charge/:id — เช็คสถานะ (frontend poll จนกว่าจะ paid)
router.get('/pay/charge/:id', async (req, res) => {
  if (!req.shopId) return res.status(400).json({ error: 'no shop' });
  try {
    const r = await query('select id, status, amount, source_type, bill_no, paid_at from pay_charges where id=$1 and shop_id=$2', [req.params.id, req.shopId]);
    if (!r.rows[0]) return res.status(404).json({ error: 'not found' });
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/pay/charge/:id/mock-paid — จำลองจ่ายสำเร็จ (เฉพาะ charge mock, สำหรับเทส)
router.post('/pay/charge/:id/mock-paid', async (req, res) => {
  if (!req.shopId) return res.status(400).json({ error: 'no shop' });
  if (!String(req.params.id).startsWith('mock_')) return res.status(400).json({ error: 'mock เท่านั้น' });
  try {
    const r = await query("update pay_charges set status='paid', paid_at=now() where id=$1 and shop_id=$2 returning amount", [req.params.id, req.shopId]);
    if (!r.rows[0]) return res.status(404).json({ error: 'not found' });
    await markDisplayPaid(req.shopId);
    res.json({ ok: true, status: 'paid' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// อัปเดตจอ QR Box เป็น "ขอบคุณ" เมื่อจ่ายสำเร็จ
async function markDisplayPaid(shopId) {
  try {
    await query(`insert into pos_display (shop_id, amount, status, updated_at) values ($1,0,'paid',now())
                 on conflict (shop_id) do update set status='paid', updated_at=now()`, [shopId]);
  } catch (e) {}
}

// Webhook (public, ไม่ต้อง auth) — Omise เรียกเมื่อ charge สำเร็จ → mark paid + เด้งจอ
async function omiseWebhook(req, res) {
  try {
    const ev = req.body || {};
    const ch = ev.data || {};
    const chargeId = ch.id;
    const ok = ev.key === 'charge.complete' || ch.status === 'successful' || ch.paid === true;
    if (chargeId && ok) {
      const row = (await query("update pay_charges set status='paid', paid_at=now() where id=$1 returning shop_id", [chargeId])).rows[0];
      const shopId = row ? row.shop_id : (ch.metadata && ch.metadata.shop_id);
      if (shopId) await markDisplayPaid(shopId);
    }
    res.json({ ok: true });
  } catch (e) { res.status(200).json({ ok: true }); }   // ตอบ 200 เสมอ กัน Omise retry ถล่ม
}

module.exports = router;
module.exports.omiseWebhook = omiseWebhook;
