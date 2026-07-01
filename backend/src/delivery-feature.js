// Delivery feature-flag and per-shop allowlist enforcement.
// Default OFF: DELIVERY_ENABLED must be exactly '1' to activate globally.
// Per-shop: DELIVERY_ALLOWED_SHOP_IDS=uuid1,uuid2  or  '*' for all shops.
// DELIVERY_ALLOW_ALL_SHOPS=1 is an explicit "open to all" override.
// Empty allowlist denies every shop.
// All checks are evaluated at request time so env vars can be changed without restart.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isDeliveryEnabledForShop(shopId) {
  if (process.env.DELIVERY_ENABLED !== '1') return false;
  const raw = (process.env.DELIVERY_ALLOWED_SHOP_IDS || '').trim();
  if (raw === '*' || process.env.DELIVERY_ALLOW_ALL_SHOPS === '1') return true;
  if (!raw) return false;
  return raw.split(',').some(s => { const t = s.trim(); return UUID_RE.test(t) && t === shopId; });
}

function requireDeliveryAllowed(req, res, next) {
  if (!isDeliveryEnabledForShop(req.shopId)) {
    return res.status(403).json({ error: 'DELIVERY_NOT_ENABLED_FOR_SHOP' });
  }
  next();
}

module.exports = { isDeliveryEnabledForShop, requireDeliveryAllowed };
