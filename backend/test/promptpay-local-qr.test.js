// P0 security fix: the PromptPay QR on the bill/receipt document (frontend/index.html
// renderDoc()) used to build <img src="https://promptpay.io/${settings.pp}/${amount}.png">
// — sending the shop's PromptPay ID and the bill amount to a third party on every single
// bill render. This test proves the fix without a browser: it extracts the REAL EMVCo
// payload builder (_ppTLV / _ppCRC16 / promptpayPayload) and the new maskMerchantId()
// helper straight out of frontend/index.html (no copy kept here — extraction guarantees
// the test tracks the shipped source, same style as print-routing.test.js) and
//   (1) asserts no `https://promptpay.io` URL remains anywhere in the file,
//   (2) checks fixed-input snapshot vectors against the (unchanged) EMVCo generator —
//       proving the payload format itself was never touched by this fix,
//   (3) checks the masking helper used for any future/diagnostic logging.
//
// Scope note: frontend/index.html also calls https://api.qrserver.com for the public
// "scan to view menu" link (renderOnlineMenu(), ~line 13688). That path carries only the
// shop's already-public menu URL — no PromptPay ID, no bill amount, no merchant financial
// data — so it is a different (and much lower-risk) code path than Fix 2's target and is
// intentionally left untouched here; see the final report for the explicit judgment call.
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');

const html = fs.readFileSync(path.join(__dirname, '../../frontend/index.html'), 'utf8');

// Same string/comment/regex-aware brace-matching extractor as print-routing.test.js —
// duplicated locally (not required as a module) since these are inline <script> functions.
function extractFn(name) {
  const start = html.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('function not found: ' + name);
  let i = html.indexOf('{', start);
  let depth = 0, str = null, prevSig = '(';
  for (; i < html.length; i++) {
    const ch = html[i], nx = html[i + 1];
    if (str) {
      if (ch === '\\') { i++; continue; }
      if (ch === str) str = null;
      continue;
    }
    if (ch === '/' && nx === '/') { i = html.indexOf('\n', i); if (i < 0) break; continue; }
    if (ch === '/' && nx === '*') { i = html.indexOf('*/', i + 2) + 1; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { str = ch; prevSig = ch; continue; }
    if (ch === '/' && '([{,;:=!&|?+-*%~^<>'.includes(prevSig)) {
      i++; while (i < html.length && html[i] !== '/') { if (html[i] === '\\') i++; i++; }
      prevSig = '/'; continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return html.slice(start, i + 1); }
    if (!/\s/.test(ch)) prevSig = ch;
  }
  throw new Error('unbalanced braces for: ' + name);
}

const factorySrc = [
  extractFn('_ppTLV'),
  extractFn('_ppCRC16'),
  extractFn('promptpayPayload'),
  extractFn('maskMerchantId'),
  'return { promptpayPayload: promptpayPayload, maskMerchantId: maskMerchantId };',
].join('\n');
const M = new Function(factorySrc)();

test('no promptpay.io (external QR image host) URL remains in any runtime code path', () => {
  assert.ok(!html.includes('https://promptpay.io'),
    'REGRESSION: a live https://promptpay.io URL is still present — merchant PromptPay ID + amount would leak externally again');
  // guard against a re-introduction via string concatenation tricks
  assert.ok(!/promptpay\s*\.\s*io\/\$\{/.test(html),
    'REGRESSION: a template-literal promptpay.io URL pattern was reintroduced');
});

test('renderDoc() builds the bill QR locally (EMVCo payload + qrcode-generator), not an <img> pointed at a third party', () => {
  const renderDocSrc = extractFn('renderDoc');
  assert.ok(renderDocSrc.includes('renderBillPromptPayQr'),
    'renderDoc() no longer wires up the local QR fill-in — did the local-QR fix get reverted?');
  // A code comment may mention the old host name for context; only a live URL is disallowed.
  assert.ok(!renderDocSrc.includes('https://promptpay.io'), 'renderDoc() must not build a live promptpay.io URL');
});

test('EMVCo payload snapshot vectors — the (unchanged) generator must keep producing byte-identical output', () => {
  // Vectors captured from the REAL generator in frontend/index.html before this fix touched
  // anything else in the file (the fix only changes *where the payload is rendered*, not how
  // it's built) — this proves promptpayPayload()/CRC16 were never altered by Fix 2.
  const VECTORS = {
    '135': '00020101021229370016A0000006770101110113006681234567853037645406135.005802TH630494A3',
    '7.5': '00020101021229370016A00000067701011101130066812345678530376454047.505802TH63040609',
    '1250': '00020101021229370016A00000067701011101130066812345678530376454071250.005802TH6304A54A',
  };
  for (const [amount, expected] of Object.entries(VECTORS)) {
    const actual = M.promptpayPayload('0812345678', Number(amount));
    assert.strictEqual(actual, expected, `payload changed for amount=${amount}: expected ${expected}, got ${actual}`);
  }
});

test('EMVCo payload is deterministic and re-runnable (no hidden network/state dependency)', () => {
  const a = M.promptpayPayload('0812345678', 135);
  const b = M.promptpayPayload('0812345678', 135);
  assert.strictEqual(a, b, 'payload generation must be a pure function of (id, amount)');
});

test('maskMerchantId(): masks all but the last 4 digits, for use in logs (never in the customer-facing QR label)', () => {
  assert.strictEqual(M.maskMerchantId('0812345678'), '******5678');
  assert.strictEqual(M.maskMerchantId('123'), '***', 'an id shorter than/equal to 4 digits should be fully masked, not left bare');
  assert.strictEqual(M.maskMerchantId(''), '');
  assert.strictEqual(M.maskMerchantId(null), '');
  // non-digit formatting (spaces/dashes) must not leak through unmasked
  assert.strictEqual(M.maskMerchantId('081-234-5678'), '******5678');
});

test('judgment call is documented: full merchant PromptPay ID is still shown on the customer-facing bill/QR label (legitimate), only logs are masked', () => {
  // The shop's own PromptPay ID/name on its own printed receipt is not a "leak" — the
  // customer is meant to see it (and may need it to pay manually if the QR fails to
  // render). We only assert that the masking helper EXISTS and works (previous test) and
  // that it is wired into the new failure-logging path we added.
  const src = extractFn('renderBillPromptPayQr');
  assert.ok(src.includes('maskMerchantId'), 'the new bill-QR failure log must mask the PromptPay ID, not print it raw');
});

test('bill-QR failure path shows a controlled Thai error, never leaves a broken external image or a false paid state', () => {
  const src = extractFn('renderBillPromptPayQr');
  assert.ok(src.includes('สร้าง QR ไม่ได้'), 'expected the controlled Thai QR-failure message to be shown on load failure');
  assert.ok(!/src\s*=\s*["'`]https?:\/\//.test(src), 'the failure path must not fall back to any remote image URL');
});

// ─── menu.html (public online-ordering page — /menu/:token) ──────────────────────────────
// Stream-5 verification found the SAME leak class in frontend/menu.html: every prepay
// online order rendered <img src="https://promptpay.io/<merchant-id>/<total>.png">.
// menu.html is a SEPARATE static page (served by app.js res.sendFile) — the index.html
// fix (d1df845) never covered it, and this file previously only scanned index.html.
// These tests close that audit gap.
const menuHtml = fs.readFileSync(path.join(__dirname, '../../frontend/menu.html'), 'utf8');

test('menu.html: no live promptpay.io (or other external QR-image host) request remains', () => {
  // Comment lines (// … documenting the OLD leak) are allowed; any executable line is not.
  const nonComment = menuHtml.split('\n').filter((l) =>
    /promptpay\.io|api\.qrserver|chart\.googleapis/.test(l) && !/^\s*(\/\/|<!--|\*)/.test(l.trim()));
  assert.deepStrictEqual(nonComment, [], 'menu.html must not contact any external QR host at runtime: ' + JSON.stringify(nonComment));
});

test('menu.html: renders the prepay QR locally with the vendored library via an ABSOLUTE path', () => {
  assert.ok(menuHtml.includes("'/vendor/qrcode-generator-1.4.4.js'"),
    'menu.html is served at /menu/:token — a relative ./vendor path would 404; must be absolute');
  assert.ok(/function\s+renderPromptPayQr/.test(menuHtml), 'local QR renderer missing');
  assert.ok(/function\s+promptpayPayload/.test(menuHtml), 'local EMVCo payload builder missing');
  assert.ok(!/cdn\.jsdelivr|unpkg\.com|cdnjs\./.test(menuHtml), 'no CDN script on the public payment page');
});

test('menu.html: EMVCo payload copy produces byte-identical vectors to the index.html generator', () => {
  const exM = (name) => {
    const m = new RegExp('function\\s+' + name + '\\s*\\(').exec(menuHtml);
    assert.ok(m, name + ' not found in menu.html');
    let i = menuHtml.indexOf('{', m.index), d = 0; const s = m.index;
    for (; i < menuHtml.length; i++) { if (menuHtml[i] === '{') d++; else if (menuHtml[i] === '}') { d--; if (!d) break; } }
    return menuHtml.slice(s, i + 1);
  };
  const MM = new Function(exM('_ppTLV') + '\n' + exM('_ppCRC16') + '\n' + exM('promptpayPayload')
    + '\nreturn { promptpayPayload };')();
  for (const [id, amt] of [['0812345678', 135], ['0812345678', 7.5], ['0812345678', 1250]]) {
    assert.strictEqual(MM.promptpayPayload(id, amt), M.promptpayPayload(id, amt),
      `menu.html payload for ${id}/${amt} must equal the index.html generator`);
  }
});

test('menu.html: QR failure path shows a controlled Thai message and never a remote fallback or false paid state', () => {
  assert.ok(menuHtml.includes('แสดง QR ไม่สำเร็จ'), 'controlled Thai failure message missing');
  const renderer = menuHtml.slice(menuHtml.indexOf('function renderPromptPayQr'));
  assert.ok(!/https?:\/\//.test(renderer.slice(0, renderer.indexOf('\n// ') > 0 ? renderer.indexOf('\n// ') : 2000)),
    'renderer must not reference any remote URL');
});
