// Payment Channel configuration API — PC-1 (inert config layer).
// Design: PAYMENT_CHANNEL_DESIGN_2026-07-20.md (REV 3, Founder-approved).
//
// Mounted at /api/payments/channels behind the SAME flag gate as the payment platform
// (PAYMENT_PLATFORM_ENABLED !== '1' -> 503, app.js). PC-1 is configuration only: nothing here
// touches bills/intents/transactions/state machines — the sale-time binding is PC-2, POS is PC-3.
//
// Security doctrine (same as payments.js):
//   * every route permission-gated server-side, fail-closed — frontend hiding is never the boundary
//   * account_ref (full PromptPay / bank account number) is SERVER-ONLY. Responses and audit
//     rows only ever carry account_ref_masked, computed here (keep last 4, mask the rest).
//   * mutations = owner-only via `payment_channel_manage` (MANAGER_EXCLUDE — changing the money
//     destination is the same sensitivity tier as approving a refund).
//   * REV 3 availability rule, no exceptions: a channel is usable in shop X iff an assignment
//     row (channel_id, shop_id=X) exists AND the channel is active AND today is inside the
//     effective window. Creating a channel always creates the owner-shop assignment row in the
//     same transaction — the row IS the access.
const express = require('express');
const { tx, query } = require('../db');
const { requirePerm, requireAnyPerm } = require('../tenant');
const router = express.Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUUID = (s) => typeof s === 'string' && UUID_RE.test(s);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const METHODS = ['CASH', 'STATIC_QR', 'DYNAMIC_QR', 'BANK_TRANSFER', 'CARD', 'OTHER'];
const PROVIDERS = ['MANUAL', 'PROMPTPAY_STATIC', 'KASIKORN_KSHOP', 'MOCK_PROVIDER'];
// MANUAL family: no provider connection exists (or ever will, for these) -> a human must verify.
const MANUAL_FAMILY = ['MANUAL', 'PROMPTPAY_STATIC', 'KASIKORN_KSHOP'];
const ACCOUNT_TYPES = ['INDIVIDUAL', 'JURISTIC'];
const BUSINESS_TYPES = ['PERSONAL', 'COMPANY', 'JURISTIC', 'PARTNER', 'TEMPORARY'];

function httpError(status, code, message) {
  const e = new Error(message || code);
  e.statusCode = status; e.code = code;
  return e;
}

function handleError(e, res) {
  if (e && e.statusCode) return res.status(e.statusCode).json({ error: e.message, code: e.code });
  console.error('[payment-channels]', e);
  return res.status(500).json({ error: (e && e.message) || 'internal error' });
}

// Server-side masking — the ONLY projection of account_ref that ever leaves the server
// (responses AND audit log rows). Keeps the last 4 characters, masks everything else.
function maskRef(ref) {
  if (ref == null || ref === '') return null;
  const s = String(ref);
  return 'xxx-xxx-' + s.slice(-4);
}

// Whitelist serializer — never spreads a DB row into a response, so account_ref can never leak
// through a forgotten field. `assignment` (is_default/sort_order) is per-shop context.
function toPublic(c, assignment) {
  const out = {
    id: c.id,
    owner_shop_id: c.shop_id,
    display_name: c.display_name,
    method: c.method,
    provider_type: c.provider_type,
    verification_mode: c.verification_mode,
    account_holder_name: c.account_holder_name,
    bank_or_provider_name: c.bank_or_provider_name,
    account_ref_masked: maskRef(c.account_ref),
    account_type: c.account_type,
    business_type: c.business_type,
    qr_image_ref: c.qr_image_ref,
    qr_version: c.qr_version,
    is_active: c.is_active,
    effective_from: c.effective_from,
    effective_until: c.effective_until,
    source: c.source,
    created_at: c.created_at,
    updated_at: c.updated_at,
  };
  if (assignment) {
    out.is_default = assignment.is_default;
    out.sort_order = assignment.sort_order;
  }
  return out;
}

// Masked snapshot for audit rows (old/new) — same masking rule as responses.
function auditSnapshot(c) {
  if (!c) return null;
  return {
    display_name: c.display_name, method: c.method, provider_type: c.provider_type,
    verification_mode: c.verification_mode, account_holder_name: c.account_holder_name,
    bank_or_provider_name: c.bank_or_provider_name, account_ref_masked: maskRef(c.account_ref),
    account_type: c.account_type, business_type: c.business_type, qr_image_ref: c.qr_image_ref,
    qr_version: c.qr_version, is_active: c.is_active,
    effective_from: c.effective_from, effective_until: c.effective_until, source: c.source,
  };
}

// Audit into the EXISTING `logs` table (same shape logs.js#logEvent writes), but through the
// caller's tx client so the audit row commits/rolls back atomically with the change itself.
async function audit(c, req, action, detail) {
  await c.query(
    'insert into logs (shop_id, user_id, action, detail) values ($1, $2, $3, $4)',
    [req.shopId, req.userId || null, action, JSON.stringify(Object.assign(
      { actor: { id: req.userId || null, name: req.userName || null } }, detail || {}))]
  );
}

// Validates the FULL (merged) field set of a channel; throws typed 400s.
// `forCreate` additionally enforces required-on-create fields (business_type per REV 2).
function validateChannelFields(f, forCreate) {
  if (forCreate) {
    if (!f.display_name || !String(f.display_name).trim()) throw httpError(400, 'DISPLAY_NAME_REQUIRED', 'display_name required');
    if (!f.business_type) throw httpError(400, 'BUSINESS_TYPE_REQUIRED', 'business_type required');
  }
  if (!METHODS.includes(f.method)) throw httpError(400, 'INVALID_METHOD', 'invalid method');
  if (!PROVIDERS.includes(f.provider_type)) throw httpError(400, 'INVALID_PROVIDER_TYPE', 'invalid provider_type');
  if (!BUSINESS_TYPES.includes(f.business_type)) throw httpError(400, 'INVALID_BUSINESS_TYPE', 'invalid business_type');
  if (f.account_type != null && f.account_type !== '' && !ACCOUNT_TYPES.includes(f.account_type)) {
    throw httpError(400, 'INVALID_ACCOUNT_TYPE', 'invalid account_type');
  }
  // MANUAL family forces MANUAL verification (design §1) — fail loudly, never silently flip.
  if (MANUAL_FAMILY.includes(f.provider_type) && f.verification_mode !== 'MANUAL') {
    throw httpError(400, 'VERIFICATION_MODE_MUST_BE_MANUAL', 'provider_type ' + f.provider_type + ' requires verification_mode MANUAL');
  }
  if (!['MANUAL', 'PROVIDER_VERIFIED'].includes(f.verification_mode)) {
    throw httpError(400, 'INVALID_VERIFICATION_MODE', 'invalid verification_mode');
  }
  // DYNAMIC_QR needs a provider that can actually generate per-bill QR — mock only in PC-1.
  if (f.method === 'DYNAMIC_QR' && f.provider_type !== 'MOCK_PROVIDER') {
    throw httpError(400, 'DYNAMIC_QR_REQUIRES_MOCK_PROVIDER', 'DYNAMIC_QR requires provider_type MOCK_PROVIDER (real providers are a later phase)');
  }
  if (f.provider_type === 'PROMPTPAY_STATIC') {
    const ref = String(f.account_ref || '');
    if (!/^0\d{9}$/.test(ref) && !/^\d{13}$/.test(ref)) {
      throw httpError(400, 'INVALID_PROMPTPAY_REF', 'PROMPTPAY_STATIC account_ref must be a 10-digit phone number or 13-digit national/juristic id');
    }
  }
  for (const k of ['effective_from', 'effective_until']) {
    if (f[k] != null && f[k] !== '' && !DATE_RE.test(String(f[k]))) throw httpError(400, 'INVALID_DATE', k + ' must be YYYY-MM-DD');
  }
}

const normDate = (v) => (v == null || v === '' ? null : String(v));
const normText = (v) => (v == null || v === '' ? null : String(v).trim());

async function loadOwnChannel(c, req, id) {
  // All mutations are scoped to channels OWNED by the current shop (creator shop manages the
  // channel; cross-shop availability is only ever granted through assignment rows).
  const r = await c.query('SELECT * FROM payment_channels WHERE id=$1 AND shop_id=$2 FOR UPDATE', [id, req.shopId]);
  if (!r.rows.length) throw httpError(404, 'NOT_FOUND', 'not found');
  return r.rows[0];
}

// ── GET / — channels available to the CURRENT shop (REV 3 assignment-row rule ONLY) ────────
// Readable by anyone who can sell or review payments. Masked data only.
// ?include_inactive=1 (payment_channel_manage holders only) relaxes the active/effective filter
// so the owner admin UI can list deactivated channels to reactivate them — assignment scope is
// NEVER relaxed.
router.get('/', requireAnyPerm(['bill_confirm', 'billing_view', 'payment_review']), async (req, res) => {
  try {
    const includeInactive = req.query.include_inactive === '1' && req.hasPerm('payment_channel_manage');
    const activeFilter = includeInactive ? '' :
      ` AND c.is_active = TRUE
        AND (c.effective_from  IS NULL OR c.effective_from  <= CURRENT_DATE)
        AND (c.effective_until IS NULL OR c.effective_until >= CURRENT_DATE)`;
    const rows = (await query(
      `SELECT c.*, pcs.is_default, pcs.sort_order
         FROM payment_channels c
         JOIN payment_channel_shops pcs ON pcs.channel_id = c.id AND pcs.shop_id = $1
        WHERE TRUE${activeFilter}
        ORDER BY pcs.is_default DESC, pcs.sort_order ASC, c.created_at ASC`,
      [req.shopId]
    )).rows;
    res.json({ channels: rows.map((r) => toPublic(r, { is_default: r.is_default, sort_order: r.sort_order })) });
  } catch (e) { handleError(e, res); }
});

// ── POST / — create channel (+ owner-shop assignment row, SAME transaction) ────────────────
router.post('/', requirePerm('payment_channel_manage'), async (req, res) => {
  const b = req.body || {};
  try {
    const fields = {
      display_name: normText(b.display_name),
      method: b.method,
      provider_type: b.provider_type,
      // MANUAL family always verifies manually; default the mode so simple clients need not send it.
      verification_mode: b.verification_mode || (MANUAL_FAMILY.includes(b.provider_type) ? 'MANUAL' : 'PROVIDER_VERIFIED'),
      account_holder_name: normText(b.account_holder_name),
      bank_or_provider_name: normText(b.bank_or_provider_name),
      account_ref: normText(b.account_ref),
      account_type: normText(b.account_type),
      business_type: b.business_type,
      qr_image_ref: normText(b.qr_image_ref),
      effective_from: normDate(b.effective_from),
      effective_until: normDate(b.effective_until),
    };
    validateChannelFields(fields, true);

    const out = await tx(async (c) => {
      const ch = (await c.query(
        `INSERT INTO payment_channels
           (shop_id, display_name, method, provider_type, verification_mode, account_holder_name,
            bank_or_provider_name, account_ref, account_type, business_type, qr_image_ref,
            effective_from, effective_until, source, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'MANUAL_ADMIN',$14)
         RETURNING *`,
        [req.shopId, fields.display_name, fields.method, fields.provider_type, fields.verification_mode,
         fields.account_holder_name, fields.bank_or_provider_name, fields.account_ref, fields.account_type,
         fields.business_type, fields.qr_image_ref, fields.effective_from, fields.effective_until, req.userId || null]
      )).rows[0];

      // REV 3: the assignment row IS the access — owner shop gets one on every create, default
      // only if the shop has none yet (respects uq_payment_channel_shop_default).
      const hasDefault = (await c.query(
        'SELECT 1 FROM payment_channel_shops WHERE shop_id=$1 AND is_default=TRUE', [req.shopId])).rows.length > 0;
      const asg = (await c.query(
        `INSERT INTO payment_channel_shops (channel_id, shop_id, is_default, sort_order, added_by)
         VALUES ($1,$2,$3,0,$4) RETURNING *`,
        [ch.id, req.shopId, !hasDefault, req.userId || null]
      )).rows[0];

      await audit(c, req, 'payment_channel.create', { channel_id: ch.id, old: null, new: auditSnapshot(ch) });
      await audit(c, req, 'payment_channel.assign_shop', {
        channel_id: ch.id, shop_id: req.shopId, is_default: asg.is_default, sort_order: asg.sort_order, via: 'create',
      });
      return { channel: ch, assignment: asg };
    });
    res.status(201).json({ channel: toPublic(out.channel, out.assignment) });
  } catch (e) { handleError(e, res); }
});

// ── PUT /:id — update fields; account_ref/qr_image_ref change bumps qr_version ─────────────
router.put('/:id', requirePerm('payment_channel_manage'), async (req, res) => {
  if (!isUUID(req.params.id)) return res.status(400).json({ error: 'invalid id' });
  const b = req.body || {};
  try {
    const out = await tx(async (c) => {
      const cur = await loadOwnChannel(c, req, req.params.id);
      const has = (k) => Object.prototype.hasOwnProperty.call(b, k);
      const fields = {
        display_name: has('display_name') ? normText(b.display_name) : cur.display_name,
        method: has('method') ? b.method : cur.method,
        provider_type: has('provider_type') ? b.provider_type : cur.provider_type,
        verification_mode: has('verification_mode') ? b.verification_mode : cur.verification_mode,
        account_holder_name: has('account_holder_name') ? normText(b.account_holder_name) : cur.account_holder_name,
        bank_or_provider_name: has('bank_or_provider_name') ? normText(b.bank_or_provider_name) : cur.bank_or_provider_name,
        account_ref: has('account_ref') ? normText(b.account_ref) : cur.account_ref,
        account_type: has('account_type') ? normText(b.account_type) : cur.account_type,
        business_type: has('business_type') ? b.business_type : cur.business_type,
        qr_image_ref: has('qr_image_ref') ? normText(b.qr_image_ref) : cur.qr_image_ref,
        effective_from: has('effective_from') ? normDate(b.effective_from) : cur.effective_from,
        effective_until: has('effective_until') ? normDate(b.effective_until) : cur.effective_until,
      };
      if (!fields.display_name) throw httpError(400, 'DISPLAY_NAME_REQUIRED', 'display_name required');
      if (!fields.business_type) throw httpError(400, 'BUSINESS_TYPE_REQUIRED', 'business_type required');
      // MANUAL family default (mirror of create) when the provider changes without a mode.
      if (has('provider_type') && !has('verification_mode') && MANUAL_FAMILY.includes(fields.provider_type)) {
        fields.verification_mode = 'MANUAL';
      }
      validateChannelFields(fields, false);

      // qr_version increments whenever what the customer scans could change (REV 2):
      // account_ref or qr_image_ref. Compare as normalized strings; date/name edits never bump.
      const refChanged = (fields.account_ref || null) !== (cur.account_ref || null)
                      || (fields.qr_image_ref || null) !== (cur.qr_image_ref || null);

      const upd = (await c.query(
        `UPDATE payment_channels SET
           display_name=$2, method=$3, provider_type=$4, verification_mode=$5,
           account_holder_name=$6, bank_or_provider_name=$7, account_ref=$8, account_type=$9,
           business_type=$10, qr_image_ref=$11, effective_from=$12, effective_until=$13,
           qr_version = qr_version + $14, updated_at = now()
         WHERE id=$1 RETURNING *`,
        [cur.id, fields.display_name, fields.method, fields.provider_type, fields.verification_mode,
         fields.account_holder_name, fields.bank_or_provider_name, fields.account_ref, fields.account_type,
         fields.business_type, fields.qr_image_ref, fields.effective_from, fields.effective_until,
         refChanged ? 1 : 0]
      )).rows[0];

      await audit(c, req, 'payment_channel.update', {
        channel_id: cur.id, qr_version_bumped: refChanged, old: auditSnapshot(cur), new: auditSnapshot(upd),
      });
      const asg = (await c.query(
        'SELECT is_default, sort_order FROM payment_channel_shops WHERE channel_id=$1 AND shop_id=$2',
        [cur.id, req.shopId])).rows[0] || null;
      return { channel: upd, assignment: asg };
    });
    res.json({ channel: toPublic(out.channel, out.assignment) });
  } catch (e) { handleError(e, res); }
});

// ── activate / deactivate — soft only; there is deliberately NO DELETE endpoint ────────────
// (old transactions will reference channels forever once PC-2 starts binding them).
for (const action of ['deactivate', 'activate']) {
  router.post('/:id/' + action, requirePerm('payment_channel_manage'), async (req, res) => {
    if (!isUUID(req.params.id)) return res.status(400).json({ error: 'invalid id' });
    const active = action === 'activate';
    try {
      const out = await tx(async (c) => {
        const cur = await loadOwnChannel(c, req, req.params.id);
        const upd = (await c.query(
          'UPDATE payment_channels SET is_active=$2, updated_at=now() WHERE id=$1 RETURNING *',
          [cur.id, active])).rows[0];
        await audit(c, req, 'payment_channel.' + action, {
          channel_id: cur.id, old: auditSnapshot(cur), new: auditSnapshot(upd),
        });
        return upd;
      });
      res.json({ channel: toPublic(out) });
    } catch (e) { handleError(e, res); }
  });
}

// ── POST /:id/shops — add/update a shop assignment (branch availability) ───────────────────
// Cross-tenant guard: the ACTOR must hold the owner role (membership) in the TARGET shop —
// managing channel config for shop A never lets you point shop B at your account.
router.post('/:id/shops', requirePerm('payment_channel_manage'), async (req, res) => {
  if (!isUUID(req.params.id)) return res.status(400).json({ error: 'invalid id' });
  const b = req.body || {};
  if (!isUUID(b.shop_id)) return res.status(400).json({ error: 'shop_id required' });
  try {
    const targetShopId = b.shop_id;
    const actorOwnsTarget = req.isSuperadmin === true ||
      (req.memberships || []).some((m) => m.shop_id === targetShopId && m.role === 'owner');
    if (!actorOwnsTarget) throw httpError(403, 'NOT_OWNER_OF_TARGET_SHOP', 'ต้องเป็นเจ้าของสาขาที่ต้องการเพิ่มช่องทาง');

    const out = await tx(async (c) => {
      const cur = await loadOwnChannel(c, req, req.params.id);
      const existing = (await c.query(
        'SELECT * FROM payment_channel_shops WHERE channel_id=$1 AND shop_id=$2 FOR UPDATE',
        [cur.id, targetShopId])).rows[0] || null;
      const isDefault = has(b, 'is_default') ? b.is_default === true : (existing ? existing.is_default : false);
      const sortOrder = has(b, 'sort_order') ? (Number.isInteger(b.sort_order) ? b.sort_order : 0)
                                             : (existing ? existing.sort_order : 0);
      // Setting a new default atomically clears the shop's previous default IN THE SAME
      // transaction — otherwise uq_payment_channel_shop_default would (correctly) reject it.
      if (isDefault) {
        await c.query(
          'UPDATE payment_channel_shops SET is_default=FALSE WHERE shop_id=$1 AND is_default=TRUE AND channel_id<>$2',
          [targetShopId, cur.id]);
      }
      const asg = (await c.query(
        `INSERT INTO payment_channel_shops (channel_id, shop_id, is_default, sort_order, added_by)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (channel_id, shop_id)
         DO UPDATE SET is_default = EXCLUDED.is_default, sort_order = EXCLUDED.sort_order
         RETURNING *`,
        [cur.id, targetShopId, isDefault, sortOrder, req.userId || null]
      )).rows[0];
      await audit(c, req, 'payment_channel.assign_shop', {
        channel_id: cur.id, shop_id: targetShopId, is_default: asg.is_default, sort_order: asg.sort_order,
        updated: !!existing,
      });
      return { channel: cur, assignment: asg };
    });
    res.status(201).json({ assignment: {
      channel_id: out.assignment.channel_id, shop_id: out.assignment.shop_id,
      is_default: out.assignment.is_default, sort_order: out.assignment.sort_order,
    } });
  } catch (e) { handleError(e, res); }
});

// ── DELETE /:id/shops/:shopId — remove an assignment (owner shop included, with audit) ─────
router.delete('/:id/shops/:shopId', requirePerm('payment_channel_manage'), async (req, res) => {
  if (!isUUID(req.params.id) || !isUUID(req.params.shopId)) return res.status(400).json({ error: 'invalid id' });
  try {
    await tx(async (c) => {
      const cur = await loadOwnChannel(c, req, req.params.id);
      const del = await c.query(
        'DELETE FROM payment_channel_shops WHERE channel_id=$1 AND shop_id=$2 RETURNING is_default, sort_order',
        [cur.id, req.params.shopId]);
      if (!del.rows.length) throw httpError(404, 'ASSIGNMENT_NOT_FOUND', 'assignment not found');
      await audit(c, req, 'payment_channel.unassign_shop', {
        channel_id: cur.id, shop_id: req.params.shopId, was_default: del.rows[0].is_default,
      });
    });
    res.json({ removed: true });
  } catch (e) { handleError(e, res); }
});

function has(obj, k) { return Object.prototype.hasOwnProperty.call(obj || {}, k); }

module.exports = router;
