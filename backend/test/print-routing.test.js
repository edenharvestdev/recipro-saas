// Live print-routing tests (feat/pos-printer-setup-p1) — PRT1..PRT22.
// These exercise the REAL frontend functions (resolvePrintConfiguration / printPosBillWindow /
// printBackOfHouse / printDirectWarn / printLocked) by extracting their source from frontend/index.html
// and running them against mocked globals. No copy of the logic is kept here — extraction guarantees the
// tests track the shipped source. Run: node test/print-routing.test.js
const fs = require('fs');
const path = require('path');
const html = fs.readFileSync(path.join(__dirname, '../../frontend/index.html'), 'utf8');

// String/comment/regex-aware extractor: returns the full source of `function NAME(...) {...}` including
// the CSS-string braces the print builders contain (a naive brace count would mis-match on those).
function extractFn(name) {
  const start = html.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('function not found: ' + name);
  let i = html.indexOf('{', start);
  let depth = 0, str = null, prevSig = '(';
  for (; i < html.length; i++) {
    const ch = html[i], nx = html[i + 1];
    if (str) {                                   // inside a string literal
      if (ch === '\\') { i++; continue; }
      if (ch === str) str = null;
      continue;
    }
    if (ch === '/' && nx === '/') { i = html.indexOf('\n', i); if (i < 0) break; continue; }   // line comment
    if (ch === '/' && nx === '*') { i = html.indexOf('*/', i + 2) + 1; continue; }             // block comment
    if (ch === '"' || ch === "'" || ch === '`') { str = ch; prevSig = ch; continue; }
    if (ch === '/' && '([{,;:=!&|?+-*%~^<>'.includes(prevSig)) {                                 // regex literal
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
  'var _printLocks = {};',
  'var PRINTERS = [];',
  "var settings = { kitchenTicketMode: 'receipt', shopName: 'ร้านทดสอบ' };",
  'var _bridges = new Set();',
  'var _toasts = [];',
  'var _alerts = 0;',
  'var _legacyReceipt = 1, _legacyKitchen = 1;',
  'var _opened = [];',
  'var _confirms = [];',
  'var _confirmAnswer = false;',
  'var ui = { toast: function(m,t){ _toasts.push({m:m,t:t}); }, alert: function(){ _alerts++; }, confirm: function(m,o){ _confirms.push({m:m,o:o}); return Promise.resolve(_confirmAnswer); } };',
  'function esc(s){ return String(s==null?"":s); }',
  'function money(n){ return Number(n).toFixed(2); }',
  'function matById(){ return null; } function recById(){ return null; } function billIdLabel(){ return "โต๊ะ"; }',
  'function detectPrinterBridges(){ return _bridges; }',
  'function posBillCopies(){ return _legacyReceipt; }',
  'function posKitchenCopies(){ return _legacyKitchen; }',
  'function posBillReceiptHtml(b,total){ return "<div class=\\"rcpt\\">RC</div>"; }',
  'var window = { open: function(){ var w = { document: { html: "", write: function(h){ this.html += h; }, close: function(){} } }; _opened.push(w); return w; } };',
  extractFn('capCopies'),
  extractFn('resolvePrintConfiguration'),
  extractFn('gateDirectPrint'),
  extractFn('printLocked'),
  extractFn('printPosBillWindow'),
  extractFn('printBackOfHouse'),
  'return {',
  '  setPrinters:function(p){PRINTERS=p;}, setSettings:function(s){settings=s;}, setBridges:function(s){_bridges=s;},',
  '  setLegacy:function(r,k){_legacyReceipt=r;_legacyKitchen=k;},',
  '  setConfirm:function(v){_confirmAnswer=v;}, confirms:function(){return _confirms;}, clearConfirms:function(){_confirms=[];},',
  '  toasts:function(){return _toasts;}, clearToasts:function(){_toasts=[];}, alerts:function(){return _alerts;},',
  '  opened:function(){return _opened;}, clearOpened:function(){_opened.length=0;}, resetLocks:function(){for(var k in _printLocks)delete _printLocks[k];},',
  '  capCopies:capCopies, resolvePrintConfiguration:resolvePrintConfiguration, gateDirectPrint:gateDirectPrint,',
  '  printLocked:printLocked, printPosBillWindow:printPosBillWindow, printBackOfHouse:printBackOfHouse',
  '};',
].join('\n');

const M = new Function(factorySrc)();

let passed = 0, failed = 0;
function check(name, cond, extra) { if (cond) { passed++; console.log('  ✓', name); } else { failed++; console.log('  ✗', name, extra !== undefined ? JSON.stringify(extra) : ''); } }
function lastHtml() { const o = M.opened(); return o.length ? o[o.length - 1].document.html : ''; }
function countOf(hay, needle) { return hay.split(needle).length - 1; }
function reset() { M.resetLocks(); M.clearOpened(); M.clearToasts(); M.clearConfirms(); M.setConfirm(false); }
const tick = () => new Promise((r) => setImmediate(r));   // let gateDirectPrint's confirm .then settle

const P = (over) => Object.assign({ id: 'id-' + Math.random().toString(36).slice(2), capability_type: 'BROWSER_SYSTEM', purpose: 'RECEIPT', paper_width: 80, copies: 1, status: 'AVAILABLE', is_default_receipt: false, is_default_kitchen: false }, over);

(async () => {
console.log('\n=== Live Print Routing Tests (PRT1-PRT22) ===\n');
try {
  // PRT1: receipt uses the default RECEIPT registry printer.
  M.setPrinters([P({ purpose: 'RECEIPT', is_default_receipt: true, paper_width: 80, copies: 2 })]);
  let cfg = M.resolvePrintConfiguration('RECEIPT');
  check('PRT1 Receipt resolves to default receipt registry printer', cfg.source === 'PRINTER_REGISTRY' && cfg.purpose === 'RECEIPT' && cfg.copies === 2, cfg);

  // PRT2: kitchen uses the default KITCHEN registry printer.
  M.setPrinters([P({ purpose: 'KITCHEN', is_default_kitchen: true, paper_width: 58, copies: 3 })]);
  cfg = M.resolvePrintConfiguration('KITCHEN');
  check('PRT2 Kitchen resolves to default kitchen registry printer', cfg.source === 'PRINTER_REGISTRY' && cfg.purpose === 'KITCHEN' && cfg.paper_width === 58 && cfg.copies === 3, cfg);

  // PRT3: a BOTH-purpose printer set default for both roles resolves for both purposes.
  M.setPrinters([P({ purpose: 'BOTH', is_default_receipt: true, is_default_kitchen: true, copies: 2 })]);
  const cr = M.resolvePrintConfiguration('RECEIPT'), ck = M.resolvePrintConfiguration('KITCHEN');
  check('PRT3 BOTH-purpose default serves both receipt and kitchen', cr.source === 'PRINTER_REGISTRY' && ck.source === 'PRINTER_REGISTRY' && cr.purpose === 'RECEIPT' && ck.purpose === 'KITCHEN', { cr, ck });

  // PRT4: a receipt-only default is NOT used for kitchen (kitchen falls back).
  M.setPrinters([P({ purpose: 'RECEIPT', is_default_receipt: true })]);
  cfg = M.resolvePrintConfiguration('KITCHEN');
  check('PRT4 Receipt-only default not used for kitchen (falls back)', cfg.printer_id === null && cfg.source !== 'PRINTER_REGISTRY', cfg);

  // PRT5: 58mm receipt changes the real template (@page 58mm + narrow width).
  reset(); M.setPrinters([P({ is_default_receipt: true, paper_width: 58, copies: 1 })]);
  M.printPosBillWindow({ billNo: 'A1' }, 100, null);
  let h = lastHtml();
  check('PRT5 58mm receipt template applied (@page 58mm, width 50mm)', h.includes('@page{size:58mm auto') && h.includes('width:50mm'), h.slice(0, 0));

  // PRT6: 80mm receipt template.
  reset(); M.setPrinters([P({ is_default_receipt: true, paper_width: 80, copies: 1 })]);
  M.printPosBillWindow({ billNo: 'A2' }, 100, null); h = lastHtml();
  check('PRT6 80mm receipt template applied (@page 80mm, width 72mm)', h.includes('@page{size:80mm auto') && h.includes('width:72mm'), null);

  // PRT7: receipt copies honored (registry copies drive the number of receipt blocks).
  reset(); M.setPrinters([P({ is_default_receipt: true, copies: 3 })]);
  M.printPosBillWindow({ billNo: 'A3' }, 100, null); h = lastHtml();
  check('PRT7 Receipt copies honored (3 copies → 3 blocks, 2 breaks)', countOf(h, 'class="rcpt"') === 3 && countOf(h, 'copybreak"></div>') === 2, countOf(h, 'class="rcpt"'));

  // PRT8: kitchen copies honored.
  reset(); M.setPrinters([P({ purpose: 'KITCHEN', is_default_kitchen: true, copies: 2, paper_width: 80 })]);
  M.printBackOfHouse('meta', [{ qty: 1, name: 'ชาไทย' }], 1); h = lastHtml();
  check('PRT8 Kitchen copies honored (2 copies → 2 kitchen headers)', countOf(h, 'ใบส่งงานหลังร้าน</div>') === 2, countOf(h, 'ใบส่งงานหลังร้าน</div>'));

  // PRT9: copies capped safely at 5 (registry copies=9 → 5).
  reset(); M.setPrinters([P({ is_default_receipt: true, copies: 9 })]);
  cfg = M.resolvePrintConfiguration('RECEIPT');
  M.printPosBillWindow({ billNo: 'A4' }, 100, null); h = lastHtml();
  check('PRT9 Copies capped at safe max 5', cfg.copies === 5 && countOf(h, 'class="rcpt"') === 5, cfg.copies);

  // PRT10: rapid double-click does not duplicate the print job (same purpose lock).
  reset(); M.setPrinters([P({ is_default_receipt: true, copies: 1 })]);
  M.printPosBillWindow({ billNo: 'A5' }, 100, null);
  M.printPosBillWindow({ billNo: 'A5' }, 100, null);   // second rapid click blocked
  check('PRT10 Rapid double-click prints once (lock)', M.opened().length === 1, M.opened().length);

  // PRT10b: receipt + kitchen from one confirm are different locks — both run.
  reset(); M.setPrinters([P({ is_default_receipt: true }), P({ purpose: 'KITCHEN', is_default_kitchen: true })]);
  M.printPosBillWindow({ billNo: 'A6' }, 100, null);
  M.printBackOfHouse('meta', [{ qty: 1, name: 'x' }], 1);
  check('PRT10b Receipt + kitchen use separate locks (both print)', M.opened().length === 2, M.opened().length);

  // PRT11: no registry → legacy/browser fallback preserved (paper 80, legacy copies).
  reset(); M.setPrinters([]); M.setLegacy(2, 2);
  cfg = M.resolvePrintConfiguration('RECEIPT');
  check('PRT11 No registry preserves browser fallback (paper 80, legacy copies)', cfg.source === 'BROWSER_FALLBACK' && cfg.paper_width === 80 && cfg.copies === 2 && cfg.printer_id === null, cfg);

  // PRT12: printers exist but none is default → LEGACY_SETTINGS fallback.
  M.setPrinters([P({ is_default_receipt: false }), P({ is_default_kitchen: false })]);
  cfg = M.resolvePrintConfiguration('RECEIPT');
  check('PRT12 Printers exist but no default → LEGACY_SETTINGS', cfg.source === 'LEGACY_SETTINGS' && cfg.printer_id === null, cfg);

  // PRT13: legacy receipt template still 80mm when no registry (behavior preserved).
  reset(); M.setPrinters([]); M.setLegacy(1, 1);
  M.printPosBillWindow({ billNo: 'A7' }, 100, null); h = lastHtml();
  check('PRT13 Legacy receipt preserves 80mm/72mm layout', h.includes('@page{size:80mm auto') && h.includes('width:72mm'), null);

  // PRT14: SUNMI direct default → fail-closed. Explicit error + fallback offer, NO silent browser print.
  reset(); M.setConfirm(false); M.setPrinters([P({ is_default_receipt: true, capability_type: 'SUNMI_NATIVE' })]);
  M.printPosBillWindow({ billNo: 'A8' }, 100, null); await tick();
  check('PRT14 SUNMI default does NOT silently print; offers explicit fallback',
    M.opened().length === 0 && M.confirms().length === 1
    && /SUNMI_PRINTER_NOT_AVAILABLE/.test(M.confirms()[0].m)
    && M.confirms()[0].o.okText === 'พิมพ์ผ่านระบบของเครื่องแทน', { opened: M.opened().length, confirms: M.confirms() });

  // PRT14b: user explicitly accepts the fallback → browser print then runs (only after explicit choice).
  reset(); M.setConfirm(true); M.setPrinters([P({ is_default_receipt: true, capability_type: 'SUNMI_NATIVE' })]);
  M.printPosBillWindow({ billNo: 'A8b' }, 100, null); await tick();
  check('PRT14b Explicit fallback choice → browser print runs (1 window)', M.opened().length === 1, M.opened().length);

  // PRT14c: LAN/USB/BT direct default → generic PRINTER_BRIDGE_NOT_AVAILABLE, still fail-closed.
  reset(); M.setConfirm(false); M.setPrinters([P({ is_default_kitchen: true, purpose: 'KITCHEN', capability_type: 'LAN_ESC_POS' })]);
  M.printBackOfHouse('meta', [{ qty: 1, name: 'x' }], 1); await tick();
  check('PRT14c LAN direct kitchen default fail-closed (PRINTER_BRIDGE_NOT_AVAILABLE, no print)',
    M.opened().length === 0 && /PRINTER_BRIDGE_NOT_AVAILABLE/.test(M.confirms()[0].m), { opened: M.opened().length });

  // PRT15: BROWSER_SYSTEM default → prints directly, no confirm, no warning.
  reset(); M.setPrinters([P({ is_default_receipt: true, capability_type: 'BROWSER_SYSTEM' })]);
  M.printPosBillWindow({ billNo: 'A9' }, 100, null); await tick();
  check('PRT15 BROWSER_SYSTEM default prints without a fallback prompt', M.opened().length === 1 && M.confirms().length === 0, { opened: M.opened().length, confirms: M.confirms().length });

  // PRT16: direct type is fail-closed even if a bridge is "detected" — this release performs no direct
  // send, so it must never claim direct success; it routes through the explicit fallback offer.
  reset(); M.setConfirm(false); M.setBridges(new Set(['SUNMI_NATIVE'])); M.setPrinters([P({ is_default_receipt: true, capability_type: 'SUNMI_NATIVE' })]);
  M.printPosBillWindow({ billNo: 'A10' }, 100, null); await tick();
  check('PRT16 Direct type never claims direct success (fail-closed to explicit fallback)', M.opened().length === 0 && M.confirms().length === 1, { opened: M.opened().length });
  M.setBridges(new Set());

  // PRT17: capCopies clamps min 1 and max 5.
  check('PRT17 capCopies clamps (0→1, 9→5, 3→3)', M.capCopies(0) === 1 && M.capCopies(9) === 5 && M.capCopies(3) === 3, [M.capCopies(0), M.capCopies(9)]);

  // PRT18: invalid/malformed default entry does not crash the resolver.
  reset();
  let threw = false;
  try { M.setPrinters([{ is_default_receipt: true }]); cfg = M.resolvePrintConfiguration('RECEIPT'); } catch (e) { threw = true; }
  check('PRT18 Malformed default resolves without crashing', !threw && cfg && cfg.purpose === 'RECEIPT', { threw, cfg });

  // PRT19: kitchen 58mm template applies to the live kitchen ticket.
  reset(); M.setPrinters([P({ purpose: 'KITCHEN', is_default_kitchen: true, paper_width: 58, copies: 1 })]);
  M.printBackOfHouse('meta', [{ qty: 1, name: 'ชาไทย' }], 1); h = lastHtml();
  check('PRT19 Kitchen 58mm template applied (@page 58mm, body 58mm)', h.includes('@page{size:58mm auto') && h.includes('width:58mm'), null);

  // PRT20: sticker mode honors kitchen copies and stays 50×40 (width-independent).
  reset(); M.setSettings({ kitchenTicketMode: 'sticker', shopName: 'x' });
  M.setPrinters([P({ purpose: 'KITCHEN', is_default_kitchen: true, paper_width: 58, copies: 2 })]);
  M.printBackOfHouse('meta', [{ qty: 1, name: 'ชาไทย' }], 1); h = lastHtml();
  check('PRT20 Sticker mode: 50×40 fixed, kitchen copies honored', h.includes('size:50mm 40mm') && countOf(h, 'class="lb"') === 2, countOf(h, 'class="lb"'));
  M.setSettings({ kitchenTicketMode: 'receipt', shopName: 'x' });

  // PRT21: printing does not mutate the stored bill values / total (calcs untouched).
  reset(); M.setPrinters([P({ is_default_receipt: true, copies: 2, paper_width: 58 })]);
  const bill = { billNo: 'A11', items: [{ qty: 2, price: 40 }] }; const snap = JSON.stringify(bill);
  M.printPosBillWindow(bill, 80, null);
  check('PRT21 Receipt print does not mutate bill object', JSON.stringify(bill) === snap, null);

  // PRT22: one receipt action prints only the receipt document (no kitchen header leaks in).
  reset(); M.setPrinters([P({ purpose: 'BOTH', is_default_receipt: true, is_default_kitchen: true })]);
  M.printPosBillWindow({ billNo: 'A12' }, 100, null); h = lastHtml();
  check('PRT22 One receipt action prints receipt only (no kitchen doc)', h.includes('class="rcpt"') && !h.includes('ใบส่งงานหลังร้าน'), null);

  // PRT23 (extra): resolver return shape is complete.
  cfg = M.resolvePrintConfiguration('RECEIPT');
  const keys = ['printer_id', 'capability_type', 'purpose', 'paper_width', 'copies', 'status', 'source'];
  check('PRT23 Resolver returns full documented shape', keys.every(k => k in cfg), Object.keys(cfg));

} catch (err) {
  console.error('UNEXPECTED ERROR:', err.message, err.stack);
  failed++;
}
console.log('\n=== Results: ' + passed + ' passed, ' + failed + ' failed ===');
process.exit(failed > 0 ? 1 : 0);
})();
