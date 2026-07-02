// Coupon provider adapter — keeps external-vendor specifics OUT of core bill logic.
// A provider exposes lookup(shopId, code) → normalized coupon descriptor (or null if unknown).
// Core validation (expiry / one-time-use / eligibility / limits) is applied by redemption.js on top
// of whatever the provider returns, so the same rules hold for local and external sources.
//
// Descriptor shape (normalized):
//   { code, campaign_id, member_id, eligible_recipe_id, eligible_category,
//     benefit_type: 'FREE_ITEM'|'AMOUNT'|'PERCENT', benefit_value,
//     usage_limit, per_member_limit, funding_source, source: 'LOCAL_IMPORT'|'EXTERNAL',
//     external_reference, starts_at, expires_at, active, coupon_id }

// LOCAL_IMPORT adapter — the controlled local `coupons` table. Always available.
const localProvider = {
  name: 'LOCAL_IMPORT',
  async lookup(c, shopId, code) {
    // A coupon may be shop-scoped or global (shop_id NULL). Prefer the shop-specific row.
    const row = (await c.query(
      `SELECT * FROM coupons
        WHERE source='LOCAL_IMPORT' AND code=$1 AND (shop_id=$2 OR shop_id IS NULL)
        ORDER BY (shop_id=$2) DESC LIMIT 1`,
      [code, shopId]
    )).rows[0];
    if (!row) return null;
    return {
      coupon_id: row.id, code: row.code, campaign_id: row.campaign_id, member_id: row.member_id,
      eligible_recipe_id: row.eligible_recipe_id, eligible_category: row.eligible_category,
      benefit_type: row.benefit_type, benefit_value: Number(row.benefit_value) || 0,
      usage_limit: row.usage_limit == null ? 1 : Number(row.usage_limit),
      per_member_limit: row.per_member_limit == null ? null : Number(row.per_member_limit),
      funding_source: row.funding_source, source: 'LOCAL_IMPORT',
      external_reference: row.external_reference,
      starts_at: row.starts_at, expires_at: row.expires_at, active: row.active,
      shop_id: row.shop_id,
    };
  },
};

// EXTERNAL adapter — stub until a real vendor API is wired (set COUPON_PROVIDER_URL to enable).
// Never trusts client-supplied status; a real implementation would call the vendor here.
const externalProvider = {
  name: 'EXTERNAL',
  async lookup(/* c, shopId, code */) {
    if (!process.env.COUPON_PROVIDER_URL) return null;   // not configured → unknown (falls through)
    // Placeholder: a real adapter performs a signed server-side call to the provider and normalizes
    // the response into the descriptor shape above. Intentionally returns null until implemented.
    return null;
  },
};

// Resolve a code across providers (local first, then external). Returns the first descriptor found.
async function lookupCoupon(c, shopId, code) {
  for (const p of [localProvider, externalProvider]) {
    const d = await p.lookup(c, shopId, code);
    if (d) return d;
  }
  return null;
}

// Is a real external provider wired? Used to FAIL CLOSED: when a code isn't a known LOCAL_IMPORT
// coupon and no external provider is configured, validation is rejected (never auto-approved).
function externalConfigured() { return !!process.env.COUPON_PROVIDER_URL; }

module.exports = { lookupCoupon, externalConfigured, localProvider, externalProvider };
