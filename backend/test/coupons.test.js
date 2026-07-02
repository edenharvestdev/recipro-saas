// Free-item coupon redemption — integration tests (feat/coupon-free-item-redemption).
// Runs against real local Postgres. node test/coupons.test.js
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const app = require('../src/app');
const { pool, query } = require('../src/db');

let base;
async function api(method, path, { token, body, shop } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  if (shop) headers['X-Shop-Id'] = shop;
  const r = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let data = null; try { data = await r.json(); } catch (_) {}
  return { status: r.status, data };
}
let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log('  ✓', name); }
  else { failed++; console.log('  ✗', name, extra !== undefined ? JSON.stringify(extra) : ''); }
}
const matStock = async (id) => Number((await query('SELECT stock FROM materials WHERE id=$1', [id])).rows[0].stock);
const redRow = async (id) => (await query('SELECT * FROM coupon_redemptions WHERE id=$1', [id])).rows[0];

(async () => {
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  base = 'http://127.0.0.1:' + server.address().port;
  const sfx = Math.random().toString(36).slice(2, 8);
  const crypto = require('crypto');
  try {
    console.log('\n=== Coupon Redemption Tests (CR1-CR24) ===\n');
    // ── Setup ──
    const saEmail = 'crsa_' + sfx + '@t.local';
    const reg = await api('POST', '/auth/register', { body: { email: saEmail, password: 'password123' } });
    const hq = (await query("insert into shops(name) values('CR-HQ') returning id")).rows[0];
    await query("insert into memberships(user_id,shop_id,role) values($1,$2,'superadmin')", [reg.data.user.id, hq.id]);
    const saToken = (await api('POST', '/auth/login', { body: { email: saEmail, password: 'password123' } })).data.accessToken;

    const ownerEmail = 'crowner_' + sfx + '@t.local';
    const shopA = (await api('POST', '/api/admin/shops', { token: saToken, body: { shopName: 'CR A', ownerEmail, ownerPassword: 'password123' } })).data.shopId;
    const ownerToken = (await api('POST', '/auth/login', { body: { email: ownerEmail, password: 'password123' } })).data.accessToken;
    const ownerBEmail = 'crownerB_' + sfx + '@t.local';
    const shopB = (await api('POST', '/api/admin/shops', { token: saToken, body: { shopName: 'CR B', ownerEmail: ownerBEmail, ownerPassword: 'password123' } })).data.shopId;
    const ownerBToken = (await api('POST', '/auth/login', { body: { email: ownerBEmail, password: 'password123' } })).data.accessToken;
    const staffEmail = 'crstaff_' + sfx + '@t.local';
    await api('POST', '/auth/register', { body: { email: staffEmail, password: 'password123' } });
    const staffLogin = await api('POST', '/auth/login', { body: { email: staffEmail, password: 'password123' } });
    const staffToken = staffLogin.data.accessToken;
    await query("INSERT INTO memberships(user_id,shop_id,role) VALUES($1,$2,'staff')", [staffLogin.data.user.id, shopA]);

    // Menu = a material line (unit COGS = 38); a recipe for eligibility tests (category 'drinks').
    const mat = crypto.randomUUID(); const recX = crypto.randomUUID();
    await query("INSERT INTO materials(id,shop_id,name,unit,stock_unit,price,qty,conv_qty,stock,updated_at) VALUES($1,$2,'CR-FreeMat','ml','ml',38,1,1,100,now())", [mat, shopA]);
    await query("INSERT INTO recipes(id,shop_id,name,yield_unit,category,updated_at) VALUES($1,$2,'CR-Rec','cup','drinks',now())", [recX, shopA]);

    // Import local coupons (Owner).
    const imp = await api('POST', '/api/coupons/import', { token: ownerToken, shop: shopA, body: { coupons: [
      { code: 'FREE_ANY', benefit_type: 'FREE_ITEM', usage_limit: 1, funding_source: 'CAMPAIGN_FUNDED' },
      { code: 'FREE_EXP', benefit_type: 'FREE_ITEM', expires_at: '2020-01-01T00:00:00Z' },
      { code: 'FREE_MENU', benefit_type: 'FREE_ITEM', eligible_recipe_id: recX },
      { code: 'FREE_MEMBER', benefit_type: 'FREE_ITEM', member_id: 'M1' },
      { code: 'FREE_VOIDTEST', benefit_type: 'FREE_ITEM', usage_limit: 1 },
      { code: 'FREE_CORR', benefit_type: 'FREE_ITEM', usage_limit: 1 },
    ] } });
    await api('POST', '/api/coupons/import', { token: ownerBToken, shop: shopB, body: { coupons: [{ code: 'FREE_B', benefit_type: 'FREE_ITEM' }] } });
    check('CR-setup import ok', imp.status === 201 && imp.data.imported === 6, imp.data);

    const line = (key, disc) => ({ key, menu_type: 'material', ref_id: mat, menu_name: 'Free', qty: 1, unit_price: 120, discount: disc || 0 });
    // Helper: draft with a free-item line, apply coupon, set discount, return {billId,key}
    async function draftAndApply(code, token, shop, memberId) {
      const key = 'ck' + Math.random().toString(36).slice(2, 6);
      const d = await api('POST', '/api/bills/draft', { token, shop, body: { items: [line(key, 0)] } });
      const billId = d.data.bill.id;
      const ap = await api('POST', '/api/coupons/apply', { token, shop, body: { bill_id: billId, bill_item_key: key, code, ref_type: 'material', ref_id: mat, qty: 1, unit_price: 120, member_id: memberId } });
      return { billId, key, ap };
    }

    // ── CR1-CR6, CR13, CR14: happy path (draft no stock; confirm redeems + deducts + real COGS) ──
    const stock0 = await matStock(mat);
    const { billId: b1, key: k1, ap: ap1 } = await draftAndApply('FREE_ANY', ownerToken, shopA);
    check('CR3 apply returns coupon discount = normal price (120)', ap1.status === 201 && ap1.data.line?.discount === 120 && ap1.data.line?.net === 0, ap1.data);
    check('CR13 Draft (with reservation) did NOT deduct stock', (await matStock(mat)) === stock0, { s0: stock0, now: await matStock(mat) });
    // set the discount on the draft line (frontend applies the returned free amount) → Net 0
    await api('POST', '/api/bills/draft', { token: ownerToken, shop: shopA, body: { id: b1, items: [line(k1, 120)] } });
    const conf1 = await api('POST', '/api/bills/' + b1 + '/confirm', { token: ownerToken, shop: shopA, body: {} });
    check('CR14 Confirm atomically deducts stock once (100→99)', conf1.status === 201 && (await matStock(mat)) === stock0 - 1, { after: await matStock(mat) });
    const red1 = (await query('SELECT * FROM coupon_redemptions WHERE bill_id=$1', [b1])).rows[0];
    check('CR1 Redemption linked to bill item', !!red1 && red1.bill_id === b1 && red1.bill_item_key === k1, red1);
    check('CR1 Redemption status REDEEMED', red1.redemption_status === 'REDEEMED', red1?.redemption_status);
    check('CR2 Gross keeps normal price (120)', Number(red1.normal_unit_price) === 120 && Number(conf1.data.bill.gross_sales) === 120, { r: red1.normal_unit_price, g: conf1.data.bill.gross_sales });
    check('CR3 coupon discount = 120', Number(red1.coupon_discount_amount) === 120, red1.coupon_discount_amount);
    check('CR4 Net = 0', Number(red1.net_amount) === 0 && Number(conf1.data.bill.net_sales) === 0, { r: red1.net_amount, n: conf1.data.bill.net_sales });
    check('CR5 COGS real & non-zero (38)', Number(red1.total_cogs) === 38, red1.total_cogs);
    check('CR6 stock deducted exactly once', (await matStock(mat)) === stock0 - 1, await matStock(mat));
    check('CR22 funding source preserved (CAMPAIGN_FUNDED)', red1.funding_source === 'CAMPAIGN_FUNDED', red1.funding_source);

    // ── CR15: confirm retry idempotent (no double deduct, still one REDEEMED) ──
    const sBefore = await matStock(mat);
    await api('POST', '/api/bills/' + b1 + '/confirm', { token: ownerToken, shop: shopA, body: {} });
    const redsAfterRetry = (await query('SELECT count(*)::int c FROM coupon_redemptions WHERE bill_id=$1 AND redemption_status=$2', [b1, 'REDEEMED'])).rows[0].c;
    check('CR15 Confirm retry idempotent (stock unchanged, one REDEEMED)', (await matStock(mat)) === sBefore && redsAfterRetry === 1, { after: await matStock(mat), reds: redsAfterRetry });

    // ── CR7: duplicate code rejected (FREE_ANY usage_limit 1 already redeemed) ──
    const dup = await draftAndApply('FREE_ANY', ownerToken, shopA);
    check('CR7 Duplicate code rejected (409 COUPON_ALREADY_REDEEMED)', dup.ap.status === 409 && dup.ap.data?.error === 'COUPON_ALREADY_REDEEMED', dup.ap.data);

    // ── CR8: expired code rejected ──
    const exp = await draftAndApply('FREE_EXP', ownerToken, shopA);
    check('CR8 Expired code rejected (409 COUPON_EXPIRED)', exp.ap.status === 409 && exp.ap.data?.error === 'COUPON_EXPIRED', exp.ap.data);

    // ── CR9: wrong branch rejected (shopB coupon invisible/unvalidatable on shopA → fail closed) ──
    const wrongBranch = await draftAndApply('FREE_B', ownerToken, shopA);
    check('CR9 Wrong-branch coupon rejected (fail closed)', wrongBranch.ap.status === 409 && ['COUPON_NOT_FOUND', 'COUPON_PROVIDER_NOT_CONFIGURED'].includes(wrongBranch.ap.data?.error), wrongBranch.ap.data);

    // ── CR10: wrong menu rejected (coupon eligible for recipe recX, applied to material) ──
    const wrongMenu = await draftAndApply('FREE_MENU', ownerToken, shopA);
    check('CR10 Wrong-menu coupon rejected (409 COUPON_WRONG_MENU)', wrongMenu.ap.status === 409 && wrongMenu.ap.data?.error === 'COUPON_WRONG_MENU', wrongMenu.ap.data);

    // ── CR12: member eligibility enforced ──
    const wrongMember = await draftAndApply('FREE_MEMBER', ownerToken, shopA, 'M2');
    check('CR12 Wrong member rejected (COUPON_WRONG_MEMBER)', wrongMember.ap.status === 409 && wrongMember.ap.data?.error === 'COUPON_WRONG_MEMBER', wrongMember.ap.data);
    const rightMember = await draftAndApply('FREE_MEMBER', ownerToken, shopA, 'M1');
    check('CR12 Correct member accepted', rightMember.ap.status === 201, rightMember.ap.data);

    // ── CR11: quantity/usage limit enforced (FREE_MEMBER usage_limit default 1 now used) ──
    const overLimit = await draftAndApply('FREE_MEMBER', ownerToken, shopA, 'M1');
    check('CR11 Usage limit enforced (2nd use rejected)', overLimit.ap.status === 409, overLimit.ap.data);

    // ── CR16/CR17/CR18: void reverses stock once → VOIDED_REVIEW → code not silently reusable ──
    const { billId: bv, key: kv } = await draftAndApply('FREE_VOIDTEST', ownerToken, shopA);
    await api('POST', '/api/bills/draft', { token: ownerToken, shop: shopA, body: { id: bv, items: [line(kv, 120)] } });
    await api('POST', '/api/bills/' + bv + '/confirm', { token: ownerToken, shop: shopA, body: {} });
    const sVoid = await matStock(mat);
    const vres = await api('POST', '/api/bills/' + bv + '/void', { token: ownerToken, shop: shopA, body: { reason: 'coupon void' } });
    const redVoid = (await query('SELECT * FROM coupon_redemptions WHERE bill_id=$1', [bv])).rows[0];
    check('CR16 Void reverses stock once (+1)', vres.data?.reversed >= 1 && (await matStock(mat)) === sVoid + 1, { rev: vres.data?.reversed, after: await matStock(mat) });
    check('CR17 Void → redemption VOIDED_REVIEW', redVoid.redemption_status === 'VOIDED_REVIEW' && !!redVoid.voided_at, redVoid?.redemption_status);
    const reuse = await draftAndApply('FREE_VOIDTEST', ownerToken, shopA);
    check('CR18 Void does NOT silently make code reusable', reuse.ap.status === 409, reuse.ap.data);

    // ── CR19: reinstatement requires Owner permission + reason ──
    const rid = redVoid.id;
    const reinStaff = await api('POST', '/api/coupons/redemptions/' + rid + '/reinstate', { token: staffToken, shop: shopA, body: { reason: 'x' } });
    check('CR19 Staff reinstate → 403', reinStaff.status === 403, reinStaff.status);
    const reinNoReason = await api('POST', '/api/coupons/redemptions/' + rid + '/reinstate', { token: ownerToken, shop: shopA, body: {} });
    check('CR19 Owner reinstate without reason → 400', reinNoReason.status === 400, reinNoReason.data);
    const reinOk = await api('POST', '/api/coupons/redemptions/' + rid + '/reinstate', { token: ownerToken, shop: shopA, body: { reason: 'approved after review' } });
    check('CR19 Owner reinstate with reason → REINSTATED', reinOk.status === 200 && (await redRow(rid)).redemption_status === 'REINSTATED', reinOk.data);

    // ── CR20/CR21: replacement does not double-redeem or double-deduct ──
    const { billId: bc, key: kc } = await draftAndApply('FREE_CORR', ownerToken, shopA);
    await api('POST', '/api/bills/draft', { token: ownerToken, shop: shopA, body: { id: bc, items: [line(kc, 120)] } });
    await api('POST', '/api/bills/' + bc + '/confirm', { token: ownerToken, shop: shopA, body: {} });
    const sCorr = await matStock(mat);
    const corr = await api('POST', '/api/bills/' + bc + '/correct', { token: ownerToken, shop: shopA, body: { reason: 'fix', items: [line(kc, 120)] } });
    const repId = corr.data.replacement?.id;
    const redsForCode = (await query("SELECT redemption_status, bill_id FROM coupon_redemptions WHERE external_coupon_code='FREE_CORR' AND shop_id=$1", [shopA])).rows;
    check('CR20 Replacement does NOT double-redeem (still ONE redemption for code)', redsForCode.length === 1, redsForCode);
    check('CR20 Redemption transferred to replacement, still REDEEMED', redsForCode[0].redemption_status === 'REDEEMED' && redsForCode[0].bill_id === repId, redsForCode[0]);
    check('CR21 Replacement does NOT double-deduct stock (reverse+rededuct net 0)', (await matStock(mat)) === sCorr, { before: sCorr, after: await matStock(mat) });

    // ── CR23: tenant isolation (shopB owner cannot see shopA redemptions) ──
    const listB = await api('GET', '/api/coupons/redemptions', { token: ownerBToken, shop: shopB });
    check('CR23 Tenant isolation: shopB sees none of shopA redemptions', listB.status === 200 && (listB.data.redemptions || []).every(r => r.bill_number == null || true) && (listB.data.redemptions || []).length === 0, { n: listB.data.redemptions?.length });

    // ── CR24: staff permissions (can validate+apply; cannot import/reinstate) ──
    const staffValidate = await api('POST', '/api/coupons/validate', { token: staffToken, shop: shopA, body: { code: 'NOPE', ref_type: 'material', ref_id: mat } });
    check('CR24 Staff CAN call validate (200, ok:false for bad code)', staffValidate.status === 200 && staffValidate.data.ok === false, staffValidate.data);
    const staffImport = await api('POST', '/api/coupons/import', { token: staffToken, shop: shopA, body: { coupons: [{ code: 'X' }] } });
    check('CR24 Staff cannot import (403)', staffImport.status === 403, staffImport.status);

    // ── CR25: external provider FAIL CLOSED — unknown code, no provider configured ──
    const failClosed = await api('POST', '/api/coupons/validate', { token: ownerToken, shop: shopA, body: { code: 'EXT-UNKNOWN-999', ref_type: 'material', ref_id: mat } });
    check('CR25 Unknown code fails closed (COUPON_PROVIDER_NOT_CONFIGURED)', failClosed.status === 200 && failClosed.data.ok === false && failClosed.data.error === 'COUPON_PROVIDER_NOT_CONFIGURED', failClosed.data);

    // ── CR26: import tenant-forcing — Owner cannot import into another shop via body shop_id ──
    await api('POST', '/api/coupons/import', { token: ownerToken, shop: shopA, body: { coupons: [{ code: 'TENANT_TEST', shop_id: shopB }] } });
    const landedA = (await query("SELECT count(*)::int c FROM coupons WHERE code='TENANT_TEST' AND shop_id=$1", [shopA])).rows[0].c;
    const leakedB = (await query("SELECT count(*)::int c FROM coupons WHERE code='TENANT_TEST' AND shop_id=$1", [shopB])).rows[0].c;
    check('CR26 Import forced to own shop (lands in A, not B)', landedA === 1 && leakedB === 0, { landedA, leakedB });

  } catch (err) {
    console.error('UNEXPECTED ERROR:', err.message, err.stack);
    failed++;
  } finally {
    await pool.end();
    server.close();
    console.log('\n=== Results: ' + passed + ' passed, ' + failed + ' failed ===');
    process.exit(failed > 0 ? 1 : 0);
  }
})();
