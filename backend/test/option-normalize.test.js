// Thai-aware search normalization tests. node test/option-normalize.test.js
const { normalizeSearch, matchesQuery, searchableBlob } = require('../src/option-engine/normalize');

let passed = 0, failed = 0;
function check(name, cond, extra) { if (cond) { passed++; console.log('  ✓', name); } else { failed++; console.log('  ✗', name, extra !== undefined ? JSON.stringify(extra) : ''); } }

console.log('\n=== Option target search normalization ===\n');

// English case-insensitive + substring (middle-of-name)
check('matcha (lower) matches "Clear Matcha Yame"', matchesQuery('Clear Matcha Yame Okumidori', 'matcha'));
check('MATCHA (upper) matches', matchesQuery('Clear Matcha Yame', 'MATCHA'));
check('Kagoshima mid-name match', matchesQuery('Classic Clear Matcha Kagoshima Asanoka', 'Kagoshima'));
check('code fragment HBR01 matches', matchesQuery('HBR01M21C Clear Matcha', 'HBR01'));
check('code fragment HBM01 matches', matchesQuery('Matcha Latte HBM01M18L', 'hbm01'));
check('SKU fragment mid matches', matchesQuery('SKU-COOL-CUP-58', 'cool-cup'));

// Thai — single & multi-character, vowels/tone marks preserved, substring
check('Thai นม matches "นมสด"', matchesQuery('M Milk นมสด', 'นม'));
check('Thai น้ำ (with tone) matches "น้ำเปล่า"', matchesQuery('น้ำเปล่า', 'น้ำ'));
check('Thai multi น้ำมะพร้าว matches', matchesQuery('Plant น้ำมะพร้าว 1000ml', 'น้ำมะพร้าว'));
check('Thai มัทฉะ matches', matchesQuery('ผงมัทฉะเกรดพรีเมียม', 'มัทฉะ'));
check('Thai ไซรัป matches mid-name', matchesQuery('ไซรัปวานิลลา', 'ไซรัป'));
check('Two-character Thai query matches', matchesQuery('ชาไทย', 'ชา'));

// NFC equivalence: decomposed vs composed should compare equal after normalize
const composed = 'น้ำ';                       // typical stored form
const decomposedQuery = 'น้ำ'.normalize('NFD');
check('NFC: decomposed query still matches composed name', matchesQuery(composed, decomposedQuery));

// Whitespace collapse + trim
check('collapses whitespace in query', matchesQuery('Clear   Matcha', '  clear matcha '));

// Empty / no-result
check('empty query → no match (does not return everything)', matchesQuery('anything', '') === false);
check('no-result query returns false', matchesQuery('Clear Matcha', 'espresso') === false);
check('normalizeSearch trims + lowercases + collapses', normalizeSearch('  HeLLo   World ') === 'hello world');

// searchableBlob includes name + code + sku
check('searchableBlob merges name+code+sku', searchableBlob({ name: 'Clear Matcha', code: 'HBR01', sku: 'SKU9' }).includes('hbr01') && searchableBlob({ name: 'Clear Matcha', code: 'HBR01' }).includes('clear matcha'));

console.log('\n=== Results: ' + passed + ' passed, ' + failed + ' failed ===');
process.exit(failed > 0 ? 1 : 0);
