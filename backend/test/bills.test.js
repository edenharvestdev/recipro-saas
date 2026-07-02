// Front-store Bill Lifecycle — Integration Tests (feat/bill-correction-v1)
// Runs against real local Postgres. node test/bills.test.js
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
const fgStock = async (id) => Number((await query('SELECT fg_stock FROM recipes WHERE id=$1', [id])).rows[0].fg_stock);

(async () => {
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  base = 'http://127.0.0.1:' + server.address().port;
  const sfx = Math.random().toString(36).slice(2, 8);
  const crypto = require('crypto');

  try {
    // ── Setup ──
    const saEmail = 'bcsa_' + sfx + '@test.local';
    const reg = await api('POST', '/auth/register', { body: { email: saEmail, password: 'password123' } });
    const hq = (await query("insert into shops(name) values('BC-HQ') returning id")).rows[0];
    await query("insert into memberships(user_id,shop_id,role) values($1,$2,'superadmin')", [reg.data.user.id, hq.id]);
    const saToken = (await api('POST', '/auth/login', { body: { email: saEmail, password: 'password123' } })).data.accessToken;

    const ownerEmail = 'bcowner_' + sfx + '@test.local';
    const shopA = (await api('POST', '/api/admin/shops', { token: saToken, body: { shopName: 'BC Shop A', ownerEmail, ownerPassword: 'password123' } })).data.shopId;
    const ownerToken = (await api('POST', '/auth/login', { body: { email: ownerEmail, password: 'password123' } })).data.accessToken;

    const ownerBEmail = 'bcownerB_' + sfx + '@test.local';
    const shopB = (await api('POST', '/api/admin/shops', { token: saToken, body: { shopName: 'BC Shop B', ownerEmail: ownerBEmail, ownerPassword: 'password123' } })).data.shopId;
    const ownerBToken = (await api('POST', '/auth/login', { body: { email: ownerBEmail, password: 'password123' } })).data.accessToken;

    // staff on shopA — default perms (void_bill=false, correct_bill=false)
    const staffEmail = 'bcstaff_' + sfx + '@test.local';
    await api('POST', '/auth/register', { body: { email: staffEmail, password: 'password123' } });
    const staffLogin = await api('POST', '/auth/login', { body: { email: staffEmail, password: 'password123' } });
    const staffToken = staffLogin.data.accessToken;
    await query("INSERT INTO memberships(user_id,shop_id,role) VALUES($1,$2,'staff')", [staffLogin.data.user.id, shopA]);

    // Materials + FG recipe (unit cost of milk = price/(qty*conv) = 10/(1*1) = 10)
    const milk = crypto.randomUUID(); const fgRec = crypto.randomUUID();
    await query("INSERT INTO materials(id,shop_id,name,unit,stock_unit,price,qty,conv_qty,stock,updated_at) VALUES($1,$2,'BC-Milk','ml','ml',10,1,1,1000,now())", [milk, shopA]);
    await query("INSERT INTO recipes(id,shop_id,name,yield_unit,fg_stock,batch_yield,inventory_mode,updated_at) VALUES($1,$2,'BC-FG','cup',2,1,'finished_goods',now())", [fgRec, shopA]);

    const mItem = (qty, price, disc) => ({ key: 'k' + Math.random().toString(36).slice(2, 6), menu_type: 'material', ref_id: milk, menu_name: 'BC-Milk', qty, unit_price: price, discount: disc || 0 });

    console.log('\n=== Bill Lifecycle Tests (BC1-BC35) ===\n');

    // ── BC1: Draft saves without stock deduction ──
    const s0 = await matStock(milk);
    const d1 = await api('POST', '/api/bills/draft', { token: ownerToken, shop: shopA, body: { items: [mItem(3, 20)], bill_discount: 0 } });
    check('BC1 Draft created (201)', d1.status === 201, d1.data);
    const draftId = d1.data.bill?.id;
    check('BC1 lifecycle=DRAFT, no number', d1.data.bill?.lifecycle_status === 'DRAFT' && !d1.data.bill?.number, d1.data.bill);
    check('BC1 Draft did NOT deduct stock', (await matStock(milk)) === s0, { before: s0, after: await matStock(milk) });

    // ── BC2/BC3: Draft reopens + edit, still no stock movement ──
    const d2 = await api('POST', '/api/bills/draft', { token: ownerToken, shop: shopA, body: { id: draftId, items: [mItem(5, 20)], bill_discount: 10 } });
    check('BC2 Draft reopened/updated (201)', d2.status === 201, d2.data);
    check('BC3 Draft edit still no stock movement', (await matStock(milk)) === s0, await matStock(milk));
    const draftGross = Number(d2.data.bill?.gross_sales);
    check('BC3 Draft gross recomputed (5*20=100)', draftGross === 100, draftGross);

    // ── BC4/BC5/BC6: Confirm assigns number, deducts once, snapshots COGS ──
    const c1 = await api('POST', '/api/bills/' + draftId + '/confirm', { token: ownerToken, shop: shopA, body: {} });
    check('BC4 Confirm assigns number + CONFIRMED', c1.status === 201 && !!c1.data.number && c1.data.bill?.lifecycle_status === 'CONFIRMED', c1.data);
    check('BC5 Confirm deducted stock once (1000-5=995)', (await matStock(milk)) === s0 - 5, await matStock(milk));
    const origMovs = (await query("SELECT count(*)::int n FROM bill_stock_movements WHERE bill_id=$1 AND movement_role='ORIGINAL_DEDUCTION'", [draftId])).rows[0].n;
    check('BC5 One ORIGINAL_DEDUCTION link', origMovs === 1, origMovs);
    check('BC6 COGS snapshot stored (5*10=50)', Number(c1.data.cogs_total) === 50, c1.data.cogs_total);
    // idempotent re-confirm
    const c1b = await api('POST', '/api/bills/' + draftId + '/confirm', { token: ownerToken, shop: shopA, body: {} });
    check('BC5 Re-confirm idempotent (already), no double deduct', c1b.data?.already === true && (await matStock(milk)) === s0 - 5, { already: c1b.data?.already, stock: await matStock(milk) });

    // ── BC7: Confirmed cannot be edited as draft ──
    const e7 = await api('POST', '/api/bills/draft', { token: ownerToken, shop: shopA, body: { id: draftId, items: [mItem(9, 20)] } });
    check('BC7 Confirmed bill not editable as draft (409 BILL_NOT_DRAFT)', e7.status === 409 && e7.data?.error === 'BILL_NOT_DRAFT', e7.data);

    // ── BC8: Correction requires reason ──
    const e8 = await api('POST', '/api/bills/' + draftId + '/correct', { token: ownerToken, shop: shopA, body: { items: [mItem(3, 20)] } });
    check('BC8 Correction without reason → 400', e8.status === 400 && e8.data?.error === 'CORRECTION_REASON_REQUIRED', e8.data);

    // ── BC9: Correction requires permission (staff → 403) ──
    const e9 = await api('POST', '/api/bills/' + draftId + '/correct', { token: staffToken, shop: shopA, body: { reason: 'x', items: [mItem(3, 20)] } });
    check('BC9 Staff correction → 403', e9.status === 403, e9.data);

    // ── BC10-BC15: Owner correction (qty 5 → 3), atomic void+replacement ──
    const stockBeforeCorrect = await matStock(milk);   // 995
    const corr = await api('POST', '/api/bills/' + draftId + '/correct', { token: ownerToken, shop: shopA, body: { reason: 'wrong qty', items: [mItem(3, 20)] } });
    check('BC10 Owner correction → 201', corr.status === 201, corr.data);
    const repId = corr.data.replacement?.id;
    check('BC11 Original preserved + REPLACED', corr.data.original?.lifecycle_status === 'REPLACED', corr.data.original?.lifecycle_status);
    // original reversed +5, replacement deducted -3 → net from 995: +5-3 = 997
    check('BC12/BC13 Reversal(+5) once & replacement(-3) once → stock 997', (await matStock(milk)) === stockBeforeCorrect + 5 - 3, { before: stockBeforeCorrect, after: await matStock(milk) });
    check('BC14 Replacement number differs from original', corr.data.replacement?.number && corr.data.replacement.number !== c1.data.number, { orig: c1.data.number, rep: corr.data.replacement?.number });
    check('BC15 Original↔replacement linked', corr.data.original?.replacement_bill_id === repId && corr.data.replacement?.original_bill_id === draftId, { o: corr.data.original?.replacement_bill_id, r: corr.data.replacement?.original_bill_id });
    const revCount = (await query("SELECT count(*)::int n FROM bill_stock_movements WHERE bill_id=$1 AND movement_role='REVERSAL'", [draftId])).rows[0].n;
    check('BC12 Exactly one REVERSAL link on original', revCount === 1, revCount);

    // ── BC16: Duplicate correction blocked ──
    const e16 = await api('POST', '/api/bills/' + draftId + '/correct', { token: ownerToken, shop: shopA, body: { reason: 'again', items: [mItem(1, 20)] } });
    check('BC16 Duplicate correction blocked (409 ALREADY_REPLACED/ORIGINAL_NOT_CORRECTABLE)', e16.status === 409, e16.data);

    // ── BC17: Double void blocked (original already REPLACED) ──
    const e17 = await api('POST', '/api/bills/' + draftId + '/void', { token: ownerToken, shop: shopA, body: { reason: 'x' } });
    check('BC17 Void of REPLACED bill → already/blocked', e17.data?.already === true || e17.status === 409, e17.data);

    // ── BC18: Failure during replacement rolls back everything (atomicity) ──
    // Confirm a fresh bill, then correct with FG qty exceeding stock → FG_STOCK_INSUFFICIENT → rollback.
    const d18 = await api('POST', '/api/bills/draft', { token: ownerToken, shop: shopA, body: { items: [mItem(4, 20)] } });
    const b18 = d18.data.bill.id;
    await api('POST', '/api/bills/' + b18 + '/confirm', { token: ownerToken, shop: shopA, body: {} });
    const stock18 = await matStock(milk);
    const fg18 = await fgStock(fgRec);
    const e18 = await api('POST', '/api/bills/' + b18 + '/correct', { token: ownerToken, shop: shopA, body: { reason: 'bad', items: [{ key: 'f', menu_type: 'recipe', ref_id: fgRec, menu_name: 'BC-FG', qty: 99, unit_price: 50 }] } });
    check('BC18 Replacement failure → 409', e18.status === 409, e18.data);
    const b18after = (await query('SELECT lifecycle_status FROM bills WHERE id=$1', [b18])).rows[0].lifecycle_status;
    check('BC18 Rollback: original still CONFIRMED (not REPLACED)', b18after === 'CONFIRMED', b18after);
    check('BC18 Rollback: milk stock unchanged (no partial reversal)', (await matStock(milk)) === stock18, { before: stock18, after: await matStock(milk) });
    check('BC18 Rollback: FG stock unchanged (no partial deduction)', (await fgStock(fgRec)) === fg18, { before: fg18, after: await fgStock(fgRec) });

    // ── BC19/BC20: qty correction changes stock via replacement; discount-only correction does NOT change stock ──
    const d20 = await api('POST', '/api/bills/draft', { token: ownerToken, shop: shopA, body: { items: [mItem(6, 20)] } });
    const b20 = d20.data.bill.id;
    await api('POST', '/api/bills/' + b20 + '/confirm', { token: ownerToken, shop: shopA, body: {} });
    const stock20 = await matStock(milk);   // after -6
    // discount-only correction: same qty 6, add discount 30
    const corr20 = await api('POST', '/api/bills/' + b20 + '/correct', { token: ownerToken, shop: shopA, body: { reason: 'discount fix', items: [mItem(6, 20, 30)] } });
    check('BC20 Discount-only correction → stock unchanged (+6-6=0)', (await matStock(milk)) === stock20, { before: stock20, after: await matStock(milk) });
    check('BC20 Discount changed Net (120-30=90), not quantity', Number(corr20.data.replacement?.net_sales) === 90, corr20.data.replacement?.net_sales);

    // ── BC21/BC22: actual_received & payment_adjustment separate from Gross/Net & stock ──
    const d21 = await api('POST', '/api/bills/draft', { token: ownerToken, shop: shopA, body: { items: [mItem(2, 50)], actual_received_amount: 80, payment_adjustment: 5 } });
    check('BC21 actual_received stored separately from net (net=100, received=80)', Number(d21.data.bill?.net_sales) === 100 && Number(d21.data.bill?.actual_received_amount) === 80, d21.data.bill);
    const stock22 = await matStock(milk);
    check('BC22 draft with payment_adjustment did not touch stock', stock22 === stock20, { s20: stock20, s22: stock22 });

    // ── BC23/BC24: business_date preserved; audit trail present ──
    const HIST = '2026-06-15';
    const d23 = await api('POST', '/api/bills/draft', { token: ownerToken, shop: shopA, body: { items: [mItem(1, 20)], business_date: HIST } });
    const b23 = d23.data.bill.id;
    const c23 = await api('POST', '/api/bills/' + b23 + '/confirm', { token: ownerToken, shop: shopA, body: {} });
    const bd23 = (await query("SELECT to_char(business_date,'YYYY-MM-DD') d, confirmed_at FROM bills WHERE id=$1", [b23])).rows[0];
    check('BC23 business_date preserved; confirmed_at real (recent)', bd23.d === HIST && Math.abs(Date.now() - new Date(bd23.confirmed_at).getTime()) < 5 * 60 * 1000, bd23);
    const audit23 = (await query('SELECT action FROM bill_audit_log WHERE bill_id=$1 ORDER BY created_at', [b23])).rows.map(r => r.action);
    check('BC24 Audit trail: created + confirmed', audit23.includes('created') && audit23.includes('confirmed'), audit23);

    // ── BC25: Staff void → 403 ──
    const e25 = await api('POST', '/api/bills/' + b23 + '/void', { token: staffToken, shop: shopA, body: { reason: 'x' } });
    check('BC25 Staff void → 403', e25.status === 403, e25.data);

    // ── BC26: Tenant isolation — Shop B cannot see/confirm/void Shop A bill ──
    const e26a = await api('GET', '/api/bills/' + b23, { token: ownerBToken, shop: shopB });
    const e26b = await api('POST', '/api/bills/' + b23 + '/void', { token: ownerBToken, shop: shopB, body: { reason: 'x' } });
    check('BC26 Shop B cannot read Shop A bill (404)', e26a.status === 404, e26a.status);
    check('BC26 Shop B cannot void Shop A bill (404)', e26b.status === 404, e26b.status);

    // ── BC27: Owner void reverses once; re-void idempotent (movement not reversed twice) ──
    const stock27 = await matStock(milk);
    const v27 = await api('POST', '/api/bills/' + b23 + '/void', { token: ownerToken, shop: shopA, body: { reason: 'void test' } });
    check('BC27 Owner void → reversed once (+1)', v27.data?.reversed >= 1 && (await matStock(milk)) === stock27 + 1, { reversed: v27.data?.reversed, before: stock27, after: await matStock(milk) });
    const v27b = await api('POST', '/api/bills/' + b23 + '/void', { token: ownerToken, shop: shopA, body: { reason: 'again' } });
    check('BC27 Re-void idempotent → stock not reversed twice', (v27b.data?.already === true || v27b.status === 409) && (await matStock(milk)) === stock27 + 1, { already: v27b.data?.already, after: await matStock(milk) });

    // ── BC28: /bills/recent lists lifecycle bills (manager UI feed) ──
    const rec = await api('GET', '/api/bills/recent', { token: ownerToken, shop: shopA });
    check('BC28 /bills/recent returns lifecycle bills', rec.status === 200 && Array.isArray(rec.data?.bills) && rec.data.bills.length > 0, { status: rec.status, n: rec.data?.bills?.length });
    check('BC28 recent excludes other shop (tenant)', (rec.data.bills || []).every(x => true) && (await api('GET', '/api/bills/recent', { token: ownerBToken, shop: shopB })).data.bills.every(x => x.original_bill_id !== draftId), true);

    // ── BC29: payment_method flows through draft/confirm/correct, separate from Net, no stock impact ──
    const d29 = await api('POST', '/api/bills/draft', { token: ownerToken, shop: shopA, body: { items: [mItem(2, 50)], payment_method: 'cash', actual_received_amount: 90 } });
    const b29 = d29.data.bill.id;
    check('BC29 draft stores payment_method', d29.data.bill?.payment_method === 'cash', d29.data.bill?.payment_method);
    const g29 = (await api('GET', '/api/bills/' + b29, { token: ownerToken, shop: shopA })).data.bill;
    check('BC29 reopen restores payment_method; actual_received separate from Net', g29.payment_method === 'cash' && Number(g29.actual_received_amount) === 90 && Number(g29.net_sales) === 100, g29);
    await api('POST', '/api/bills/' + b29 + '/confirm', { token: ownerToken, shop: shopA, body: {} });
    const g29b = (await api('GET', '/api/bills/' + b29, { token: ownerToken, shop: shopA })).data.bill;
    check('BC29 confirm preserves payment_method', g29b.payment_method === 'cash', g29b.payment_method);
    const stk29 = await matStock(milk);
    const corr29 = await api('POST', '/api/bills/' + b29 + '/correct', { token: ownerToken, shop: shopA, body: { reason: 'change pay method', items: [mItem(2, 50)], payment_method: 'transfer' } });
    check('BC29 correction changes payment_method (→transfer)', corr29.data.replacement?.payment_method === 'transfer', corr29.data.replacement?.payment_method);
    check('BC29 payment-method change makes no NET stock change (reverse+rededuct same qty)', (await matStock(milk)) === stk29 + 2 - 2, { before: stk29, after: await matStock(milk) });
    check('BC29 Gross/Net unchanged by payment method (100/100)', Number(corr29.data.replacement?.gross_sales) === 100 && Number(corr29.data.replacement?.net_sales) === 100, corr29.data.replacement);

    // ── BC30 (V1): Void reason is mandatory ──
    const d30 = await api('POST', '/api/bills/draft', { token: ownerToken, shop: shopA, body: { items: [mItem(1, 20)] } });
    const b30 = d30.data.bill.id;
    await api('POST', '/api/bills/' + b30 + '/confirm', { token: ownerToken, shop: shopA, body: {} });
    const v30no = await api('POST', '/api/bills/' + b30 + '/void', { token: ownerToken, shop: shopA, body: { reason: '   ' } });
    check('BC30 Void without reason → 400 VOID_REASON_REQUIRED', v30no.status === 400 && v30no.data?.error === 'VOID_REASON_REQUIRED', v30no.data);
    const st30 = await matStock(milk);
    const v30ok = await api('POST', '/api/bills/' + b30 + '/void', { token: ownerToken, shop: shopA, body: { reason: 'มีเหตุผล' } });
    check('BC30 Void with reason → ok, stock reversed once', v30ok.status === 200 && v30ok.data?.reversed >= 1 && (await matStock(milk)) === st30 + 1, { v: v30ok.data, after: await matStock(milk) });

    // ── BC31 (V1): Draft may be DELETED with no stock reversal ──
    const stk31 = await matStock(milk);
    const d31 = await api('POST', '/api/bills/draft', { token: ownerToken, shop: shopA, body: { items: [mItem(3, 20)] } });
    const b31 = d31.data.bill.id;
    const del31 = await api('DELETE', '/api/bills/' + b31, { token: ownerToken, shop: shopA });
    const gone31 = await api('GET', '/api/bills/' + b31, { token: ownerToken, shop: shopA });
    check('BC31 Draft delete → ok, no stock change, bill gone', del31.data?.ok === true && (await matStock(milk)) === stk31 && gone31.status === 404, { del: del31.data, stock: await matStock(milk), get: gone31.status });

    // ── BC32 (V1): CONFIRMED bill CANNOT be deleted ──
    const d32 = await api('POST', '/api/bills/draft', { token: ownerToken, shop: shopA, body: { items: [mItem(1, 20)] } });
    const b32 = d32.data.bill.id;
    await api('POST', '/api/bills/' + b32 + '/confirm', { token: ownerToken, shop: shopA, body: {} });
    const del32 = await api('DELETE', '/api/bills/' + b32, { token: ownerToken, shop: shopA });
    const still32 = await api('GET', '/api/bills/' + b32, { token: ownerToken, shop: shopA });
    check('BC32 Confirmed delete → 409 CONFIRMED_BILL_NOT_DELETABLE, bill preserved', del32.status === 409 && del32.data?.error === 'CONFIRMED_BILL_NOT_DELETABLE' && still32.status === 200, { del: del32.data, get: still32.status });

    // ── BC33 (V1): Void audit records actor + time + reason; original preserved ──
    await api('POST', '/api/bills/' + b32 + '/void', { token: ownerToken, shop: shopA, body: { reason: 'ตรวจสอบ audit' } });
    const g33 = await api('GET', '/api/bills/' + b32, { token: ownerToken, shop: shopA });
    const voidedEntry = (g33.data.audit || []).find(a => a.action === 'voided');
    check('BC33 Original preserved as VOIDED', g33.data.bill?.lifecycle_status === 'VOIDED' && !!g33.data.bill?.voided_at && !!g33.data.bill?.voided_by, g33.data.bill);
    check('BC33 Void audit has actor + reason + time', !!voidedEntry && !!voidedEntry.actor_name && voidedEntry.reason === 'ตรวจสอบ audit' && !!voidedEntry.created_at, voidedEntry);

    // ── BC34 (V1): VOIDED bill cannot be corrected again ──
    const corr34 = await api('POST', '/api/bills/' + b32 + '/correct', { token: ownerToken, shop: shopA, body: { reason: 'x', items: [mItem(1, 20)] } });
    check('BC34 Correct on VOIDED bill → 409', corr34.status === 409, corr34.data);

    // ── BC35 (V1): Legacy bill (no strong stock linkage) is NOT auto-reversed ──
    const legacyId = (await query(
      `INSERT INTO bills(shop_id, doc_type, lifecycle_status, status, stock_deducted, gross_sales, net_sales, number, items_json, business_date, created_by, confirmed_at)
       VALUES($1,'sale','CONFIRMED','paid',true,100,100,'BC-LEGACY-' || $2,'[]'::jsonb,CURRENT_DATE,(SELECT user_id FROM memberships WHERE shop_id=$1 AND role='owner' LIMIT 1),now()) RETURNING id`,
      [shopA, sfx]
    )).rows[0].id;
    const stkLegacy = await matStock(milk);
    const vLegacyBlocked = await api('POST', '/api/bills/' + legacyId + '/void', { token: ownerToken, shop: shopA, body: { reason: 'legacy void' } });
    check('BC35 Legacy void blocked → 409 LEGACY_STOCK_LINK_REVIEW_REQUIRED', vLegacyBlocked.status === 409 && vLegacyBlocked.data?.error === 'LEGACY_STOCK_LINK_REVIEW_REQUIRED', vLegacyBlocked.data);
    check('BC35 Legacy still CONFIRMED (not voided), stock untouched', (await api('GET', '/api/bills/' + legacyId, { token: ownerToken, shop: shopA })).data.bill?.lifecycle_status === 'CONFIRMED' && (await matStock(milk)) === stkLegacy, { after: await matStock(milk) });
    const vLegacyAck = await api('POST', '/api/bills/' + legacyId + '/void', { token: ownerToken, shop: shopA, body: { reason: 'legacy void', acknowledge_legacy: true } });
    check('BC35 Legacy void with ack → VOIDED, reversed 0, NO unrelated stock reversal', vLegacyAck.status === 200 && vLegacyAck.data?.reversed === 0 && vLegacyAck.data?.legacy === true && (await matStock(milk)) === stkLegacy, { v: vLegacyAck.data, after: await matStock(milk) });

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
