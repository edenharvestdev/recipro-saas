// Reusable search normaliser for target search (materials/recipes) — fixes the legacy dropdown that
// only jumped by first character and could not match Thai vowels/tone marks or multi-character queries.
//
// - Unicode NFC normalise (so composed/decomposed Thai vowels compare equal)
// - trim + collapse internal whitespace
// - lowercase (affects English/Latin only; Thai has no case)
// - substring matching (middle-of-name), NOT prefix-only
// - preserves Thai vowels & tone marks (no stripping)

function normalizeSearch(s) {
  if (s == null) return '';
  let out = String(s);
  try { out = out.normalize('NFC'); } catch (_) { /* older runtimes */ }
  out = out.replace(/\s+/g, ' ').trim().toLowerCase();
  return out;
}

// Does haystack contain the (normalised) needle as a substring? Empty needle → no match (avoid
// returning the whole table for an empty query; callers decide how to handle empty).
function matchesQuery(haystack, query) {
  const n = normalizeSearch(query);
  if (!n) return false;
  return normalizeSearch(haystack).includes(n);
}

// Build the fields blob a row is searchable by (name + code/sku, both normalised).
function searchableBlob(row) {
  return normalizeSearch([row && row.name, row && row.code, row && row.sku].filter(Boolean).join(' '));
}

module.exports = { normalizeSearch, matchesQuery, searchableBlob };
