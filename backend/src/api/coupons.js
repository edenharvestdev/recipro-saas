// Free-item coupon redemption API. Mounted under /api (requireAuth + tenant applied).
// Server-side validation only — never trusts client status or query params. Staff may validate and
// redeem a server-validated coupon; overriding eligibility, importing, and reinstating are Owner-only.
const express = require('express');
const { query, tx } = require('../db');
const providers = require('../coupons/providers');
const redemption = require('../coupons/redemption');
const router = express.Router();

const conn = { query };   // pool-backed connection for read-only calls (validate/list)
function ownerOnly(req, res, next) {
  if (req.role === 'owner' || req.isSuperadmin) return next();
  return res.status(403).json({ error: 'OWNER_ONLY' });
}

// POST /coupons/validate — validate a code for a menu item + return the free-item preview. No writes.
router.post('/coupons/validate', async (req, res) => {
  const b = req.body || {};
  try {
    const ctx = { refType: b.ref_type === 'material' ? 'material' : 'recipe', refId: b.ref_id, category: b.category, memberId: b.member_id };
    const v = await redemption.validate(conn, req.shopId, b.code, ctx, providers);
    if (!v.ok) return res.status(200).json({ ok: false, error: v.error });
    const d = v.descriptor;
    const money = redemption.computeBenefit(d, b.unit_price, b.qty || 1);
    // COGS is cost data — only Owner/superadmin or staff with view_cost may see it in the preview.
    const showCogs = req.role === 'owner' || req.isSuperadmin === true || (req.staffPerms && req.staffPerms.view_cost === true);
    const unitCogs = showCogs ? await redemption.previewUnitCogs(conn, req.shopId, ctx.refType, ctx.refId) : null;
    const preview = {
      normal_unit_price: Number(b.unit_price) || 0, gross: money.gross, coupon_discount: money.discount,
      net: money.net, funding_source: d.funding_source,
    };
    if (showCogs) { preview.unit_cogs = unitCogs; preview.total_cogs = unitCogs * (Number(b.qty) || 1); }
    res.json({
      ok: true, campaign_id: d.campaign_id, funding_source: d.funding_source,
      benefit_type: d.benefit_type, eligible_recipe_id: d.eligible_recipe_id, eligible_category: d.eligible_category,
      external_reference: d.external_reference, source: d.source, preview,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /coupons/apply — reserve the coupon on a DRAFT bill item (PENDING; locks the code). No stock yet.
// Body: { bill_id, bill_item_key, code, ref_type, ref_id, category?, member_id?, qty, unit_price }
router.post('/coupons/apply', async (req, res) => {
  const b = req.body || {};
  try {
    const out = await tx((c) => redemption.apply(c, req.shopId, req.userId, {
      billId: b.bill_id, billItemKey: b.bill_item_key, code: b.code,
      refType: b.ref_type === 'material' ? 'material' : 'recipe', refId: b.ref_id,
      category: b.category, memberId: b.member_id, qty: b.qty || 1, normalUnitPrice: b.unit_price,
    }, providers));
    res.status(201).json({
      ok: true, redemption_id: out.id, already: !!out.already, funding_source: out.descriptor.funding_source,
      line: { unit_price: Number(b.unit_price) || 0, discount: out.money.discount, net: out.money.net, unit_cogs: out.unitCogs },
    });
  } catch (e) {
    if (e.statusCode) return res.status(e.statusCode).json({ error: e.message });
    // A unique-violation from the one-time-use index → the code is already taken.
    if (e.code === '23505') return res.status(409).json({ error: 'COUPON_ALREADY_REDEEMED' });
    res.status(500).json({ error: e.message });
  }
});

// GET /coupons/redemptions — reporting feed (Owner). Separates coupon-funded free items from cash discounts.
router.get('/coupons/redemptions', ownerOnly, async (req, res) => {
  try {
    const rows = (await query(
      `SELECT cr.id, cr.external_coupon_code, cr.external_campaign_id, cr.funding_source, cr.redemption_status,
              cr.normal_unit_price, cr.coupon_discount_amount, cr.net_amount, cr.total_cogs, cr.eligible_recipe_id,
              cr.eligible_category, cr.bill_id, cr.redeemed_at, cr.voided_at, cr.external_reference,
              b.number AS bill_number, r.name AS menu_name
         FROM coupon_redemptions cr
         LEFT JOIN bills b ON b.id = cr.bill_id
         LEFT JOIN recipes r ON r.id = cr.eligible_recipe_id
        WHERE cr.shop_id=$1 ORDER BY cr.created_at DESC LIMIT 500`,
      [req.shopId]
    )).rows;
    res.json({ redemptions: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /coupons/redemptions/:id/reinstate — Owner reinstates a VOIDED_REVIEW redemption (reason required).
router.post('/coupons/redemptions/:id/reinstate', ownerOnly, async (req, res) => {
  const reason = String((req.body && req.body.reason) || '').trim();
  if (!reason) return res.status(400).json({ error: 'REINSTATE_REASON_REQUIRED' });
  try {
    await tx((c) => redemption.reinstate(c, req.shopId, req.userId, req.params.id, reason));
    res.json({ ok: true });
  } catch (e) { if (e.statusCode) return res.status(e.statusCode).json({ error: e.message }); res.status(500).json({ error: e.message }); }
});

// POST /coupons/import — controlled LOCAL_IMPORT of coupons (Owner). Used until the external API is wired.
router.post('/coupons/import', ownerOnly, async (req, res) => {
  const list = Array.isArray(req.body && req.body.coupons) ? req.body.coupons : [];
  if (!list.length) return res.status(400).json({ error: 'no coupons' });
  try {
    let n = 0;
    await tx(async (c) => {
      for (const x of list) {
        if (!x.code) continue;
        await c.query(
          `INSERT INTO coupons (shop_id, code, campaign_id, member_id, eligible_recipe_id, eligible_category,
                 benefit_type, benefit_value, usage_limit, per_member_limit, funding_source, source,
                 external_reference, starts_at, expires_at, active)
           VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7,'FREE_ITEM'),COALESCE($8,0),COALESCE($9,1),$10,
                   COALESCE($11,'CAMPAIGN_FUNDED'),'LOCAL_IMPORT',$12,$13,$14,COALESCE($15,true))
           ON CONFLICT (source, code, COALESCE(shop_id,'00000000-0000-0000-0000-000000000000'::uuid)) DO UPDATE
             SET campaign_id=EXCLUDED.campaign_id, eligible_recipe_id=EXCLUDED.eligible_recipe_id,
                 eligible_category=EXCLUDED.eligible_category, benefit_type=EXCLUDED.benefit_type,
                 benefit_value=EXCLUDED.benefit_value, usage_limit=EXCLUDED.usage_limit,
                 funding_source=EXCLUDED.funding_source, expires_at=EXCLUDED.expires_at,
                 active=EXCLUDED.active, updated_at=now()`,
          // Tenant safety: an Owner may import ONLY into their own shop — ignore any client shop_id.
          [req.shopId, x.code, x.campaign_id || null, x.member_id || null, x.eligible_recipe_id || null,
           x.eligible_category || null, x.benefit_type || null, x.benefit_value ?? null, x.usage_limit ?? null,
           x.per_member_limit ?? null, x.funding_source || null, x.external_reference || null,
           x.starts_at || null, x.expires_at || null, x.active]
        );
        n++;
      }
    });
    res.status(201).json({ ok: true, imported: n });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
