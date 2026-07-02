// Admin-preview verification for the public online menu.
// The public /menu/:token page is customer-facing. To show an Admin Preview Bar it must SERVER-VERIFY
// that the viewer is an authenticated owner/superadmin member of THIS shop — the ?preview=admin query
// param alone grants nothing. Mounted under /api (requireAuth + tenant already applied), so an
// unauthenticated caller gets 401 and the menu page shows the plain customer view.
const express = require('express');
const { query } = require('../db');
const router = express.Router();

// GET /api/preview/verify/:token — is the authed user an owner/admin of the shop that owns this menu?
router.get('/preview/verify/:token', async (req, res) => {
  const token = req.params.token;
  if (!token) return res.status(400).json({ error: 'no token' });
  try {
    const shop = (await query(
      `SELECT s.id, s.name FROM shops s
         JOIN shop_settings ss ON ss.shop_id = s.id
        WHERE ss.public_menu_token = $1 OR ss.public_slug = $1
        LIMIT 1`,
      [token]
    )).rows[0];
    if (!shop) return res.status(404).json({ error: 'menu not found' });

    const m = (await query('SELECT role FROM memberships WHERE user_id = $1 AND shop_id = $2', [req.userId, shop.id])).rows[0];
    const allowed = req.isSuperadmin === true || (m && (m.role === 'owner' || m.role === 'superadmin'));
    if (!allowed) return res.status(403).json({ error: 'not an admin of this shop' });

    res.json({ ok: true, shop_name: shop.name, back_url: '/' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
