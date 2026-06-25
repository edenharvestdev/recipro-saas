const fs = require('fs');
const root = JSON.parse(fs.readFileSync(process.env.F, 'utf8'));
const rec = (root.recipes || []).find(r => r.name === 'Kori Osmanthus Matcha');
console.log('RECIPE all keys:', Object.keys(rec).join(', '));
const slim = {}; for (const k of Object.keys(rec)) { if (k === 'imgData') { slim[k] = (rec[k] ? '[base64 len ' + rec[k].length + ']' : ''); } else if (k !== 'items') slim[k] = rec[k]; }
console.log('RECIPE values (imgData/items stripped):', JSON.stringify(slim));
console.log('ITEM keys:', rec.items[0] ? Object.keys(rec.items[0]).join(', ') : '(none)');
console.log('ITEMS:', JSON.stringify(rec.items));
// ตรวจ field ที่อาจไม่มีในทุก record
const recKeys = new Set();
(root.recipes || []).forEach(r => Object.keys(r).forEach(k => recKeys.add(k)));
console.log('UNION of all recipe keys:', [...recKeys].join(', '));
const itemKeys = new Set();
(root.recipes || []).forEach(r => (r.items || []).forEach(it => Object.keys(it).forEach(k => itemKeys.add(k))));
console.log('UNION of all item keys:', [...itemKeys].join(', '));
