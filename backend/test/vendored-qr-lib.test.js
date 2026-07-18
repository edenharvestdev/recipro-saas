// P0 security fix (Fix 3 of the payment-path hardening set): the payment screen used to
// load qrcode-generator@1.4.4 at runtime from https://cdn.jsdelivr.net on every visit. This
// test proves the library is now vendored locally, the loader has no remote fallback of any
// kind, and the vendor asset is wired into the app's static-asset cache-busting mechanism —
// all via extraction from the real source files (frontend/index.html, backend/src/app.js),
// no copies kept here.
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');

const INDEX_PATH = path.join(__dirname, '../../frontend/index.html');
const VENDOR_PATH = path.join(__dirname, '../../frontend/vendor/qrcode-generator-1.4.4.js');
const APP_JS_PATH = path.join(__dirname, '../src/app.js');

const html = fs.readFileSync(INDEX_PATH, 'utf8');

// Same string/comment/regex-aware brace-matching extractor used across the other
// index.html-extraction tests (print-routing.test.js, promptpay-local-qr.test.js).
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

// Functions that are actually on the payment path — the unrelated printLabel() price/product
// label feature also happens to load qrcode-generator (+ JsBarcode) from jsdelivr, but it
// carries no merchant/payment data and is explicitly out of scope (see
// docs/vendored-dependencies.md). We only assert "no external QR host" for these.
const PAYMENT_PATH_FNS = ['ensureQrLib', 'showQrReceive', 'openQrBox', 'qrBoxPoll', 'renderBillPromptPayQr'];

test('vendor file exists, is non-empty, and contains the expected library marker + pinned version', () => {
  assert.ok(fs.existsSync(VENDOR_PATH), 'expected frontend/vendor/qrcode-generator-1.4.4.js to exist');
  const content = fs.readFileSync(VENDOR_PATH, 'utf8');
  assert.ok(content.length > 10000, 'vendor file looks too small to be the real library: ' + content.length + ' bytes');
  assert.ok(content.includes('QR Code Generator for JavaScript'), 'missing the upstream library banner — wrong file vendored?');
  assert.ok(content.includes('1.4.4'), 'vendor file header must state the pinned version');
  assert.ok(content.includes('Kazuhiko Arase'), 'vendor file must retain the MIT copyright attribution');
  assert.match(content, /SHA-256:\s*[0-9a-f]{64}/i, 'vendor file header must record the SHA-256 of the upstream source');
  // sanity: the vendored code actually defines the global it's meant to
  assert.ok(/var\s+qrcode\s*=\s*function/.test(content), 'vendor file does not look like the qrcode-generator source (no `var qrcode = function`)');
});

test('payment-path QR loader (ensureQrLib) points at the local vendored file, not a CDN', () => {
  const src = extractFn('ensureQrLib');
  assert.ok(src.includes('./vendor/qrcode-generator-1.4.4.js'), 'ensureQrLib() must load the local vendored file');
  assert.ok(!src.includes('cdn.jsdelivr.net'), 'REGRESSION: ensureQrLib() still references the external CDN');
  assert.ok(!/unpkg\.com|jsdelivr\.net|cdnjs\.cloudflare\.com/.test(src), 'ensureQrLib() must not reference ANY external CDN host');
});

test('the loader has NO silent remote fallback — on failure it rejects with a controlled Thai error, never retries a different URL', () => {
  const src = extractFn('ensureQrLib');
  // exactly one script src assignment in the whole function, and it's the local path
  const srcAssignments = src.match(/\.src\s*=\s*["'][^"']+["']/g) || [];
  assert.strictEqual(srcAssignments.length, 1, 'expected exactly one script src assignment, found: ' + JSON.stringify(srcAssignments));
  assert.ok(srcAssignments[0].includes('./vendor/qrcode-generator-1.4.4.js'), 'the single src assignment must be the local vendored file');
  assert.ok(!/https?:\/\//.test(src), 'ensureQrLib() must not contain any remote URL to fall back to');
  assert.ok(src.includes('reject('), 'onerror/onload-failure must reject the promise, not silently resolve');
  assert.ok(src.includes('สร้าง QR ไม่ได้'), 'failure must surface the controlled Thai QR-failure message');
});

test('no external QR-library CDN host remains anywhere on the payment path', () => {
  for (const name of PAYMENT_PATH_FNS) {
    const src = extractFn(name);
    assert.ok(!/cdn\.jsdelivr\.net|unpkg\.com|cdnjs\.cloudflare\.com/.test(src),
      `${name}() must not reference an external script CDN`);
  }
});

test('backend/src/app.js serves and version-tags the vendor asset like the app\'s other static assets', () => {
  const appSrc = fs.readFileSync(APP_JS_PATH, 'utf8');
  const m = appSrc.match(/const VERSIONED_ASSETS\s*=\s*(\[[^\]]*\]);/);
  assert.ok(m, 'could not find VERSIONED_ASSETS array in backend/src/app.js');
  const list = new Function('return ' + m[1])();
  assert.ok(Array.isArray(list) && list.includes('vendor/qrcode-generator-1.4.4.js'),
    'VERSIONED_ASSETS must include vendor/qrcode-generator-1.4.4.js so it gets cache-busted, got: ' + JSON.stringify(list));
});

test('the versioned-asset rewrite actually rewrites the vendor <script> src (end-to-end check of the app.js mechanism)', () => {
  const appSrc = fs.readFileSync(APP_JS_PATH, 'utf8');
  const m = appSrc.match(/const VERSIONED_ASSETS\s*=\s*(\[[^\]]*\]);/);
  const VERSIONED_ASSETS = new Function('return ' + m[1])();
  let rewritten = html;
  VERSIONED_ASSETS.forEach((f) => { rewritten = rewritten.split('./' + f + '"').join('./' + f + '?v=TESTHASH"'); });
  assert.ok(rewritten.includes('./vendor/qrcode-generator-1.4.4.js?v=TESTHASH"'),
    'the app.js cache-busting rewrite did not match the vendor script src in index.html — quoting mismatch?');
});

test('docs/vendored-dependencies.md documents the library, version, source, license, hash, and update procedure', () => {
  const docPath = path.join(__dirname, '../../docs/vendored-dependencies.md');
  assert.ok(fs.existsSync(docPath), 'expected docs/vendored-dependencies.md to exist');
  const doc = fs.readFileSync(docPath, 'utf8');
  for (const needle of ['qrcode-generator', '1.4.4', 'MIT', 'SHA-256', 'Update procedure']) {
    assert.ok(doc.includes(needle), `docs/vendored-dependencies.md is missing expected content: "${needle}"`);
  }
});
