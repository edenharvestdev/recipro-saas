// Coupon redemption core — free-item redemption with REAL stock + COGS.
// Financial/stock rule for a free item: Gross keeps the normal menu price, Coupon Discount = the
// eligible free amount, Net may be 0, stock deducts NORMALLY (via the existing bill confirm path),
// and COGS stays real/non-zero (campaign-funded cost). This module never sets COGS to 0, never skips
// stock, and never records a redemption without a linked bill item.
//
// Lifecycle vs bill lifecycle:
//   apply (on a DRAFT)   → PENDING reservation (locks the code; no stock yet)
//   bill CONFIRM         → REDEEMED + real COGS snapshot (stock already deducted by confirm)
//   bill VOID            → VOIDED_REVIEW (stock reversed by void; code NOT silently reusable)
//   draft delete         → release PENDING → REJECTED (code freed)
//   bill CORRECT/REPLACE → transfer redemption to the replacement (no double redeem / double COGS)
//   reinstate (Owner)    → REINSTATED
const engine = require('../stockEngine');

const ACTIVE_STATES = ['PENDING', 'VALIDATED', 'REDEEMED', 'VOIDED_REVIEW', 'REINSTATED'];

function nowExpired(descriptor, now) {
  if (descriptor.expires_at && new Date(descriptor.expires_at).getTime() < now) return 'COUPON_EXPIRED';
  if (descriptor.starts_at && new Date(descriptor.starts_at).getTime() > now) return 'COUPON_NOT_STARTED';
  return null;
}

// Unit COGS for a menu line (recipe or material), same basis as the bill confirm path.
async function previewUnitCogs(c, shopId, refType, refId) {
  if (refType === 'material') {
    const m = (await c.query('SELECT price, qty, conv_qty FROM materials WHERE id=$1 AND shop_id=$2', [refId, shopId])).rows[0];
    if (!m) return 0;
    return Number(m.qty) > 0 ? Number(m.price) / ((Number(m.qty) || 1) * (Number(m.conv_qty) || 1)) : 0;
  }
  try { return await engine.computeRecipeCostPerUnit(c, shopId, refId); } catch (e) { return 0; }
}

// Full server-side validation. Returns { ok, descriptor, error, eligible:{recipe_id,category} }.
// Never trusts client status — re-derives eligibility + one-time-use from the DB.
async function validate(c, shopId, code, ctx, providers) {
  const now = Date.now();
  const descriptor = await providers.lookupCoupon(c, shopId, String(code || '').trim());
  if (!descriptor) {
    // FAIL CLOSED: the code is not a known LOCAL_IMPORT coupon for this shop. If no external provider
    // is configured we cannot validate it — reject explicitly (never fall back to auto-approval).
    if (!providers.externalConfigured()) return { ok: false, error: 'COUPON_PROVIDER_NOT_CONFIGURED' };
    return { ok: false, error: 'COUPON_NOT_FOUND' };   // provider configured but code unknown/unavailable
  }
  if (!descriptor.active) return { ok: false, error: 'COUPON_INACTIVE', descriptor };
  const winErr = nowExpired(descriptor, now);
  if (winErr) return { ok: false, error: winErr, descriptor };
  if (descriptor.shop_id && descriptor.shop_id !== shopId) return { ok: false, error: 'COUPON_WRONG_SHOP', descriptor };

  // Eligible menu / category — server-derived, not trusting the client.
  const refType = ctx.refType === 'material' ? 'material' : 'recipe';
  if (descriptor.eligible_recipe_id && descriptor.eligible_recipe_id !== ctx.refId) {
    return { ok: false, error: 'COUPON_WRONG_MENU', descriptor };
  }
  if (descriptor.eligible_category) {
    let cat = null;
    if (refType === 'recipe') cat = ((await c.query('SELECT category FROM recipes WHERE id=$1 AND shop_id=$2', [ctx.refId, shopId])).rows[0] || {}).category;
    if (cat !== descriptor.eligible_category) return { ok: false, error: 'COUPON_WRONG_CATEGORY', descriptor };
  }

  // Member eligibility (when the coupon is member-bound or a member limit applies).
  if (descriptor.member_id && String(descriptor.member_id) !== String(ctx.memberId || '')) {
    return { ok: false, error: 'COUPON_WRONG_MEMBER', descriptor };
  }

  // One-time / usage-limit — count redemptions already holding this code in active/consumed states.
  const used = (await c.query(
    `SELECT count(*)::int c FROM coupon_redemptions
      WHERE shop_id=$1 AND external_coupon_code=$2 AND redemption_status = ANY($3)`,
    [shopId, descriptor.code, ACTIVE_STATES]
  )).rows[0].c;
  const limit = descriptor.usage_limit == null ? 1 : descriptor.usage_limit;
  if (used >= limit) return { ok: false, error: 'COUPON_ALREADY_REDEEMED', descriptor };
  if (descriptor.per_member_limit != null && ctx.memberId) {
    const perM = (await c.query(
      `SELECT count(*)::int c FROM coupon_redemptions
        WHERE shop_id=$1 AND external_coupon_code=$2 AND external_member_id=$3 AND redemption_status = ANY($4)`,
      [shopId, descriptor.code, String(ctx.memberId), ACTIVE_STATES]
    )).rows[0].c;
    if (perM >= descriptor.per_member_limit) return { ok: false, error: 'COUPON_MEMBER_LIMIT', descriptor };
  }

  return { ok: true, descriptor };
}

// Compute the free-item money preview for a menu line at the given normal unit price.
// FREE_ITEM → discount is the full normal price (Net 0). AMOUNT/PERCENT → partial.
function computeBenefit(descriptor, normalUnitPrice, qty) {
  const q = Number(qty) || 1; const price = Number(normalUnitPrice) || 0;
  const gross = price * q;
  let discount;
  if (descriptor.benefit_type === 'AMOUNT') discount = Math.min(gross, Number(descriptor.benefit_value) || 0);
  else if (descriptor.benefit_type === 'PERCENT') discount = gross * Math.min(100, Number(descriptor.benefit_value) || 0) / 100;
  else discount = gross; // FREE_ITEM
  return { gross, discount, net: gross - discount };
}

// Apply a validated coupon to a DRAFT bill item → PENDING reservation (locks the code). No stock yet.
// Idempotent per (bill_id, bill_item_key): re-apply updates the same reservation.
async function apply(c, shopId, userId, opts, providers) {
  const { billId, billItemKey, code, refType, refId, category, memberId, qty, normalUnitPrice } = opts;
  if (!billId || !billItemKey) { const e = new Error('COUPON_NEEDS_BILL_ITEM'); e.statusCode = 400; throw e; }
  const v = await validate(c, shopId, code, { refType, refId, category, memberId }, providers);
  if (!v.ok) { const e = new Error(v.error); e.statusCode = 409; throw e; }
  const d = v.descriptor;
  const unitCogs = await previewUnitCogs(c, shopId, refType, refId);
  const money = computeBenefit(d, normalUnitPrice, qty);
  const totalCogs = unitCogs * (Number(qty) || 1);

  // Reuse an existing reservation for this bill item if present (idempotent apply).
  const existing = (await c.query(
    `SELECT id, redemption_status FROM coupon_redemptions WHERE shop_id=$1 AND bill_id=$2 AND bill_item_key=$3`,
    [shopId, billId, billItemKey]
  )).rows[0];
  const cols = {
    branch_id: shopId, coupon_id: d.coupon_id || null, external_coupon_code: d.code,
    external_campaign_id: d.campaign_id || null, external_member_id: memberId || d.member_id || null,
    external_reference: d.external_reference || null, eligible_recipe_id: d.eligible_recipe_id || null,
    eligible_category: d.eligible_category || null, normal_unit_price: Number(normalUnitPrice) || 0,
    coupon_discount_amount: money.discount, net_amount: money.net, unit_cogs_snapshot: unitCogs,
    total_cogs: totalCogs, funding_source: d.funding_source || 'CAMPAIGN_FUNDED',
  };
  if (existing) {
    if (existing.redemption_status === 'REDEEMED' || existing.redemption_status === 'REINSTATED') return { id: existing.id, already: true, descriptor: d, money, unitCogs };
    await c.query(
      `UPDATE coupon_redemptions SET external_coupon_code=$1, external_campaign_id=$2, external_member_id=$3,
             external_reference=$4, coupon_id=$5, eligible_recipe_id=$6, eligible_category=$7, normal_unit_price=$8,
             coupon_discount_amount=$9, net_amount=$10, unit_cogs_snapshot=$11, total_cogs=$12, funding_source=$13,
             redemption_status='PENDING', updated_at=now() WHERE id=$14`,
      [cols.external_coupon_code, cols.external_campaign_id, cols.external_member_id, cols.external_reference,
       cols.coupon_id, cols.eligible_recipe_id, cols.eligible_category, cols.normal_unit_price,
       cols.coupon_discount_amount, cols.net_amount, cols.unit_cogs_snapshot, cols.total_cogs, cols.funding_source, existing.id]
    );
    return { id: existing.id, descriptor: d, money, unitCogs };
  }
  const id = (await c.query(
    `INSERT INTO coupon_redemptions
       (shop_id, branch_id, coupon_id, external_coupon_code, external_campaign_id, external_member_id,
        external_reference, bill_id, bill_item_key, eligible_recipe_id, eligible_category, normal_unit_price,
        coupon_discount_amount, net_amount, unit_cogs_snapshot, total_cogs, funding_source, redemption_status, redeemed_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'PENDING',$18) RETURNING id`,
    [shopId, cols.branch_id, cols.coupon_id, cols.external_coupon_code, cols.external_campaign_id, cols.external_member_id,
     cols.external_reference, billId, billItemKey, cols.eligible_recipe_id, cols.eligible_category, cols.normal_unit_price,
     cols.coupon_discount_amount, cols.net_amount, cols.unit_cogs_snapshot, cols.total_cogs, cols.funding_source, userId]
  )).rows[0].id;
  return { id, descriptor: d, money, unitCogs };
}

// On bill CONFIRM: finalize the bill's PENDING/VALIDATED redemptions → REDEEMED with the REAL COGS
// snapshot taken from the just-created bill_stock_movements for that item. Idempotent (skips REDEEMED).
async function onConfirm(c, shopId, userId, billId) {
  const reds = (await c.query(
    `SELECT id, bill_item_key FROM coupon_redemptions
      WHERE shop_id=$1 AND bill_id=$2 AND redemption_status IN ('PENDING','VALIDATED')`,
    [shopId, billId]
  )).rows;
  for (const r of reds) {
    const cogs = (await c.query(
      `SELECT COALESCE(SUM(quantity*unit_cogs_snapshot),0) AS total FROM bill_stock_movements
        WHERE bill_id=$1 AND bill_item_key=$2 AND movement_role IN ('ORIGINAL_DEDUCTION','REPLACEMENT_DEDUCTION')`,
      [billId, r.bill_item_key]
    )).rows[0].total;
    await c.query(
      `UPDATE coupon_redemptions SET redemption_status='REDEEMED', total_cogs=$1, redeemed_at=now(), redeemed_by=$2, updated_at=now()
        WHERE id=$3`,
      [Number(cogs) || 0, userId, r.id]
    );
  }
  return reds.length;
}

// On bill VOID: move the bill's REDEEMED redemptions to VOIDED_REVIEW (Owner review to reinstate).
// The code stays locked (VOIDED_REVIEW is an active state) so it is NOT silently reusable.
async function onVoid(c, shopId, userId, billId) {
  const r = await c.query(
    `UPDATE coupon_redemptions SET redemption_status='VOIDED_REVIEW', voided_at=now(), voided_by=$1, updated_at=now()
      WHERE shop_id=$2 AND bill_id=$3 AND redemption_status IN ('REDEEMED','REINSTATED')`,
    [userId, shopId, billId]
  );
  return r.rowCount;
}

// On DRAFT delete: release un-confirmed reservations so the code becomes available again.
async function releaseDraft(c, shopId, billId) {
  const r = await c.query(
    `UPDATE coupon_redemptions SET redemption_status='REJECTED', updated_at=now()
      WHERE shop_id=$1 AND bill_id=$2 AND redemption_status IN ('PENDING','VALIDATED')`,
    [shopId, billId]
  );
  return r.rowCount;
}

// On CORRECT (void original + replacement): transfer the original's REDEEMED redemption to the
// replacement bill so the code is NOT redeemed twice and COGS/stock are NOT double-counted. If the
// replacement no longer has a matching item key, the redemption goes to VOIDED_REVIEW instead.
async function onCorrect(c, shopId, userId, origBillId, repBillId) {
  const reds = (await c.query(
    `SELECT id, bill_item_key FROM coupon_redemptions
      WHERE shop_id=$1 AND bill_id=$2 AND redemption_status IN ('REDEEMED','REINSTATED')`,
    [shopId, origBillId]
  )).rows;
  for (const r of reds) {
    const repCogs = (await c.query(
      `SELECT COALESCE(SUM(quantity*unit_cogs_snapshot),0) AS total FROM bill_stock_movements
        WHERE bill_id=$1 AND bill_item_key=$2 AND movement_role='REPLACEMENT_DEDUCTION'`,
      [repBillId, r.bill_item_key]
    )).rows[0].total;
    if (Number(repCogs) > 0) {
      // Item survived into the replacement — move linkage, keep REDEEMED, re-snapshot COGS (once).
      await c.query(
        `UPDATE coupon_redemptions SET bill_id=$1, total_cogs=$2, updated_at=now() WHERE id=$3`,
        [repBillId, Number(repCogs), r.id]
      );
    } else {
      // Free item removed in the correction → original redemption needs Owner review.
      await c.query(
        `UPDATE coupon_redemptions SET redemption_status='VOIDED_REVIEW', voided_at=now(), voided_by=$1, updated_at=now() WHERE id=$2`,
        [userId, r.id]
      );
    }
  }
  return reds.length;
}

// Owner reinstates a VOIDED_REVIEW redemption after review (reason required). Preserves history.
async function reinstate(c, shopId, userId, redemptionId, reason) {
  const row = (await c.query('SELECT redemption_status FROM coupon_redemptions WHERE id=$1 AND shop_id=$2 FOR UPDATE', [redemptionId, shopId])).rows[0];
  if (!row) { const e = new Error('REDEMPTION_NOT_FOUND'); e.statusCode = 404; throw e; }
  if (row.redemption_status !== 'VOIDED_REVIEW') { const e = new Error('NOT_IN_REVIEW'); e.statusCode = 409; throw e; }
  await c.query(
    `UPDATE coupon_redemptions SET redemption_status='REINSTATED', reinstated_at=now(), reinstated_by=$1, reinstate_reason=$2, updated_at=now()
      WHERE id=$3`,
    [userId, reason, redemptionId]
  );
  return true;
}

module.exports = { validate, apply, onConfirm, onVoid, releaseDraft, onCorrect, reinstate, previewUnitCogs, computeBenefit, ACTIVE_STATES };
