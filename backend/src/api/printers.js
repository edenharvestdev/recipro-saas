// POS printer registry API (feat/pos-printer-setup-p1). Mounted under /api (requireAuth + tenant).
// Config only — real printing is client-side. BROWSER_SYSTEM works now; direct hardware
// (SUNMI_NATIVE/USB/LAN/BT) is only usable when a runtime bridge is detected client-side; the server
// never claims physical print success and returns explicit typed statuses. All routes are shop-scoped
// via req.shopId (client-supplied shop_id is ignored) and enforce the matching printer_* permission.
const express = require('express');
const { query, tx } = require('../db');
const { requirePerm } = require('../tenant');
const router = express.Router();

const CAPABILITIES = [
  { type: 'BROWSER_SYSTEM', server_status: 'AVAILABLE', label: 'พิมพ์ผ่านระบบของเครื่อง / Browser', desc: 'ใช้หน้าต่างพิมพ์ของเครื่อง เหมาะกับ SUNMI ที่ตั้งเครื่องพิมพ์ในระบบไว้แล้ว' },
  { type: 'SUNMI_NATIVE', server_status: 'BRIDGE_NOT_AVAILABLE', label: 'เครื่องพิมพ์ในตัว SUNMI', desc: 'ยังไม่รองรับในเว็บเวอร์ชันนี้ ต้องติดตั้ง Printer Bridge (SUNMI app/WebView)' },
  { type: 'LOCAL_BRIDGE', server_status: 'BRIDGE_NOT_AVAILABLE', label: 'Local Print Bridge', desc: 'ต้องติดตั้งบริการ Printer Bridge ในเครื่อง' },
  { type: 'LAN_ESC_POS', server_status: 'BRIDGE_NOT_AVAILABLE', label: 'LAN / Wi-Fi (ESC/POS)', desc: 'ต้องมี Printer Bridge' },
  { type: 'USB_ESC_POS', server_status: 'BRIDGE_NOT_AVAILABLE', label: 'USB (ESC/POS)', desc: 'ต้องมี Printer Bridge' },
  { type: 'BLUETOOTH_ESC_POS', server_status: 'BRIDGE_NOT_AVAILABLE', label: 'Bluetooth (ESC/POS)', desc: 'ต้องมี Printer Bridge' },
];
const DIRECT = new Set(['SUNMI_NATIVE', 'LOCAL_BRIDGE', 'LAN_ESC_POS', 'USB_ESC_POS', 'BLUETOOTH_ESC_POS']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function sanitize(p) {   // never expose internal-only fields; there are no secrets stored, but be explicit
  return {
    id: p.id, name: p.name, capability_type: p.capability_type, connection_type: p.connection_type,
    purpose: p.purpose, paper_width: p.paper_width, copies: p.copies,
    is_default_receipt: p.is_default_receipt, is_default_kitchen: p.is_default_kitchen,
    status: p.status, last_test_at: p.last_test_at, last_test_status: p.last_test_status, last_test_error: p.last_test_error,
    configured_by: p.configured_by, updated_at: p.updated_at,
  };
}

// GET /printers/capabilities — capability model + server-side availability (client augments with bridge detection).
router.get('/printers/capabilities', requirePerm('printer_view'), (req, res) => {
  res.json({ capabilities: CAPABILITIES });
});

// GET /printers — list this shop's printers.
router.get('/printers', requirePerm('printer_view'), async (req, res) => {
  try {
    const rows = (await query('select * from printers where shop_id=$1 order by created_at', [req.shopId])).rows;
    res.json({ printers: rows.map(sanitize) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /printers — add a printer.
router.post('/printers', requirePerm('printer_add'), async (req, res) => {
  const b = req.body || {};
  const capability = String(b.capability_type || 'BROWSER_SYSTEM');
  if (!CAPABILITIES.some((c) => c.type === capability)) return res.status(400).json({ error: 'PRINTER_UNSUPPORTED', code: 'PRINTER_UNSUPPORTED' });
  const name = String(b.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name required' });
  const purpose = ['RECEIPT', 'KITCHEN', 'BOTH'].includes(b.purpose) ? b.purpose : 'RECEIPT';
  const paper = [58, 80].includes(Number(b.paper_width)) ? Number(b.paper_width) : 80;
  const copies = Math.max(1, Math.min(5, Number(b.copies) || 1));   // safe cap 5 (matches print-time capCopies)
  // Direct hardware without a confirmed bridge cannot be AVAILABLE — mark BRIDGE_NOT_AVAILABLE.
  const status = capability === 'BROWSER_SYSTEM' ? 'NOT_CONFIGURED' : 'BRIDGE_NOT_AVAILABLE';
  try {
    const id = (await query(
      `insert into printers (shop_id, name, capability_type, connection_type, purpose, paper_width, copies, status, configured_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *`,
      [req.shopId, name, capability, capability === 'BROWSER_SYSTEM' ? 'system-dialog' : (b.connection_type || null), purpose, paper, copies, status, req.userId]
    )).rows[0];
    res.status(201).json({ printer: sanitize(id) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /printers/:id — edit config (own shop only).
router.patch('/printers/:id', requirePerm('printer_edit'), async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'invalid id' });
  const b = req.body || {};
  try {
    const cur = (await query('select * from printers where id=$1 and shop_id=$2', [req.params.id, req.shopId])).rows[0];
    if (!cur) return res.status(404).json({ error: 'PRINTER_NOT_FOUND', code: 'PRINTER_NOT_FOUND' });
    const name = b.name != null ? String(b.name).trim() : cur.name;
    const purpose = ['RECEIPT', 'KITCHEN', 'BOTH'].includes(b.purpose) ? b.purpose : cur.purpose;
    const paper = [58, 80].includes(Number(b.paper_width)) ? Number(b.paper_width) : cur.paper_width;
    const copies = b.copies != null ? Math.max(1, Math.min(5, Number(b.copies) || 1)) : cur.copies;   // safe cap 5
    const r = (await query(
      'update printers set name=$1, purpose=$2, paper_width=$3, copies=$4, updated_at=now() where id=$5 and shop_id=$6 returning *',
      [name, purpose, paper, copies, req.params.id, req.shopId]
    )).rows[0];
    res.json({ printer: sanitize(r) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /printers/:id/test — record a test. BROWSER_SYSTEM → PRINT_DIALOG_OPENED (client opens the
// dialog; we never claim physical print). Direct hardware without a bridge → explicit not-available.
router.post('/printers/:id/test', requirePerm('printer_test'), async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'invalid id' });
  try {
    const p = (await query('select * from printers where id=$1 and shop_id=$2', [req.params.id, req.shopId])).rows[0];
    if (!p) return res.status(404).json({ error: 'PRINTER_NOT_FOUND', code: 'PRINTER_NOT_FOUND' });
    let status, action, errCode = null;
    if (p.capability_type === 'BROWSER_SYSTEM') {
      status = 'PRINT_DIALOG_OPENED'; action = 'open_print_dialog';
    } else {
      // The server has no hardware bridge; the client must confirm a real bridge. Report explicitly.
      status = p.capability_type === 'SUNMI_NATIVE' ? 'SUNMI_PRINTER_NOT_AVAILABLE' : 'PRINTER_BRIDGE_NOT_AVAILABLE';
      action = 'require_bridge'; errCode = status;
    }
    await query(
      'update printers set last_test_at=now(), last_test_status=$1, last_test_error=$2, status=$3, updated_at=now() where id=$4 and shop_id=$5',
      [status, errCode, p.capability_type === 'BROWSER_SYSTEM' ? 'AVAILABLE' : 'BRIDGE_NOT_AVAILABLE', req.params.id, req.shopId]
    );
    res.json({ ok: p.capability_type === 'BROWSER_SYSTEM', status, action, paper_width: p.paper_width, copies: p.copies });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /printers/:id/set-default — set default receipt/kitchen atomically (clears the previous default).
router.post('/printers/:id/set-default', requirePerm('printer_set_default'), async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'invalid id' });
  const role = req.body && req.body.role;   // 'receipt' | 'kitchen'
  if (!['receipt', 'kitchen'].includes(role)) return res.status(400).json({ error: 'role must be receipt|kitchen' });
  const col = role === 'receipt' ? 'is_default_receipt' : 'is_default_kitchen';
  try {
    const out = await tx(async (c) => {
      const p = (await c.query('select id from printers where id=$1 and shop_id=$2 for update', [req.params.id, req.shopId])).rows[0];
      if (!p) { const e = new Error('PRINTER_NOT_FOUND'); e.statusCode = 404; throw e; }
      await c.query(`update printers set ${col}=false where shop_id=$1 and ${col}=true`, [req.shopId]);  // clear previous
      await c.query(`update printers set ${col}=true, updated_at=now() where id=$1 and shop_id=$2`, [req.params.id, req.shopId]);
      return (await c.query('select * from printers where id=$1', [req.params.id])).rows[0];
    });
    res.json({ printer: sanitize(out) });
  } catch (e) { if (e.statusCode) return res.status(e.statusCode).json({ error: e.message, code: e.message }); res.status(500).json({ error: e.message }); }
});

// DELETE /printers/:id — deleting a default requires explicit confirmation (warn/replace).
router.delete('/printers/:id', requirePerm('printer_delete'), async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'invalid id' });
  try {
    const p = (await query('select * from printers where id=$1 and shop_id=$2', [req.params.id, req.shopId])).rows[0];
    if (!p) return res.status(404).json({ error: 'PRINTER_NOT_FOUND', code: 'PRINTER_NOT_FOUND' });
    if ((p.is_default_receipt || p.is_default_kitchen) && req.query.confirm !== 'true' && (req.body || {}).confirm_default_removal !== true) {
      return res.status(409).json({ error: 'DEFAULT_PRINTER_DELETE_NEEDS_CONFIRM', code: 'DEFAULT_PRINTER_DELETE_NEEDS_CONFIRM', is_default_receipt: p.is_default_receipt, is_default_kitchen: p.is_default_kitchen });
    }
    await query('delete from printers where id=$1 and shop_id=$2', [req.params.id, req.shopId]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
