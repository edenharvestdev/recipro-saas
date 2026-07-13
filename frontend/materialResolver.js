// RECIPRO Material Engine V2 — materialResolver.js
//
// Pure, dependency-free material cost/unit-health resolver. UMD module: the
// SAME physical file is consumable from Node (`require('./materialResolver')`)
// and from the browser (`<script src="materialResolver.js">`, global
// `window.MaterialResolver`). No build step, no external dependency — built-
// ins only.
//
// PR-1 STATUS: this module is RUNTIME-INERT. It is not required/imported by
// stockEngine, bills, delivery, coupons/redemption, or any UI page. It exists
// so it can be reviewed, tested, and later wired in on purpose. Once wired
// in, this file is intended to be the single source of truth for resolving a
// material's cost-per-stock-unit and its data-quality "health" — replacing
// any ad-hoc unit-conversion math scattered elsewhere.
//
// ARCH-3: centralized UNIT_REGISTRY. All unit knowledge (WEIGHT/VOLUME/
// COUNT/PACKAGING families, their aliases, and conversion factors) lives in
// ONE place — UNIT_REGISTRY — looked up via lookupUnit(). The legacy
// STANDARD_UNITS / IDENTITY_UNITS maps are kept ONLY as derived, read-only
// views for backward compatibility with any external consumer; internal
// logic (resolveMaterialCost) no longer reads them directly.
//
// source values returned by resolveMaterialCost:
//   'explicit'          — material carries an explicit conv_qty + stock_unit
//   'standard_fallback' — recognized WEIGHT/VOLUME family MULTIPLE unit
//                         (factor > 1, e.g. kg/L/ขีด), auto-converted
//   'identity'          — recognized same-unit inventory: WEIGHT/VOLUME base
//                         units (factor 1, e.g. gram/ml) or COUNT units
//                         (piece/egg/...), trusted 1:1, no conversion needed
//   'ambiguous'         — unknown/packaging unit with no conversion; not trusted
//
// Public API (returned by the factory below):
//   { resolveMaterialCost, UNIT_REGISTRY, lookupUnit, STANDARD_UNITS, IDENTITY_UNITS }
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();                 // Node / CommonJS
  } else {
    root.MaterialResolver = factory();          // browser global
  }
})(typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : this), function () {
  'use strict';

  // ---------------------------------------------------------------------
  // UNIT_REGISTRY — single physical source of truth for every unit RECIPRO
  // knows about, grouped by family.
  //
  //   WEIGHT / VOLUME: `base` is the canonical stock-unit label for the
  //     family (กรัม / มิลลิลิตร). Each member's numeric value is its
  //     to-base conversion factor (e.g. กิโลกรัม -> 1000 กรัม, ขีด -> 100
  //     กรัม, กรัม itself -> 1).
  //   COUNT: `base` is null — every member IS its own canonical unit
  //     (factor always 1). Some members are English aliases of a Thai
  //     canonical (e.g. 'pcs' -> 'ชิ้น', 'egg' -> 'ฟอง'); the alias->canonical
  //     mapping is `canonicalOf` below.
  //   PACKAGING: `base` is null and every member's factor is null — these
  //     units are NEVER auto-converted; they stay ambiguous unless the
  //     material record supplies an explicit conv_qty/stock_unit.
  //
  // `trusted` marks whether a bare (non-explicit) member of the family can
  // be auto-resolved (WEIGHT/VOLUME/COUNT = true; PACKAGING = false).
  // ---------------------------------------------------------------------
  var UNIT_REGISTRY = {
    WEIGHT: {
      base: 'กรัม',
      trusted: true,
      members: {
        'กิโลกรัม': 1000, 'กก.': 1000, 'กก': 1000, 'กิโล': 1000,
        'kg': 1000, 'kilogram': 1000, 'kilograms': 1000,
        'ขีด': 100,
        'กรัม': 1, 'g': 1, 'gram': 1, 'grams': 1
      }
    },
    VOLUME: {
      base: 'มิลลิลิตร',
      trusted: true,
      members: {
        'ลิตร': 1000, 'ล.': 1000, 'l': 1000, 'liter': 1000, 'litre': 1000, 'liters': 1000,
        'มิลลิลิตร': 1, 'มล.': 1, 'มล': 1, 'ml': 1, 'milliliter': 1, 'millilitre': 1, 'milliliters': 1
      }
    },
    COUNT: {
      base: null,
      trusted: true,
      members: {
        // each unit is its own canonical base, factor 1
        'ชิ้น': 1, 'ฟอง': 1, 'ใบ': 1, 'อัน': 1, 'ลูก': 1, 'แผ่น': 1, 'ซอง': 1, 'คู่': 1, 'เส้น': 1, 'แท่ง': 1,
        'piece': 1, 'pieces': 1, 'pcs': 1, 'pc': 1, 'egg': 1, 'eggs': 1
      }
    },
    PACKAGING: {
      base: null,
      trusted: false,
      members: {
        'ถุง': null, 'กล่อง': null, 'แพ็ค': null, 'ลัง': null, 'ถาด': null, 'แผง': null, 'ขวด': null
      }
    }
  };

  // English/alias -> Thai canonical mapping for COUNT units. Thai count
  // units map to themselves. Keys are already-normalized (lowercased).
  var COUNT_CANONICAL = {
    'piece': 'ชิ้น', 'pieces': 'ชิ้น', 'pcs': 'ชิ้น', 'pc': 'ชิ้น',
    'egg': 'ฟอง', 'eggs': 'ฟอง'
  };

  function normalizeUnit(rawUnit) {
    return String(rawUnit == null ? '' : rawUnit).trim().toLowerCase();
  }

  // lookupUnit: normalize + scan the registry for a matching member.
  // Returns { family, canonicalUnit, toBaseFactor, trusted }.
  function lookupUnit(rawUnit) {
    var norm = normalizeUnit(rawUnit);

    if (Object.prototype.hasOwnProperty.call(UNIT_REGISTRY.WEIGHT.members, norm)) {
      return { family: 'WEIGHT', canonicalUnit: UNIT_REGISTRY.WEIGHT.base, toBaseFactor: UNIT_REGISTRY.WEIGHT.members[norm], trusted: true };
    }
    if (Object.prototype.hasOwnProperty.call(UNIT_REGISTRY.VOLUME.members, norm)) {
      return { family: 'VOLUME', canonicalUnit: UNIT_REGISTRY.VOLUME.base, toBaseFactor: UNIT_REGISTRY.VOLUME.members[norm], trusted: true };
    }
    if (Object.prototype.hasOwnProperty.call(UNIT_REGISTRY.COUNT.members, norm)) {
      var canonicalUnit = Object.prototype.hasOwnProperty.call(COUNT_CANONICAL, norm) ? COUNT_CANONICAL[norm] : norm;
      return { family: 'COUNT', canonicalUnit: canonicalUnit, toBaseFactor: 1, trusted: true };
    }
    if (Object.prototype.hasOwnProperty.call(UNIT_REGISTRY.PACKAGING.members, norm)) {
      return { family: 'PACKAGING', canonicalUnit: norm, toBaseFactor: null, trusted: false };
    }

    return { family: 'UNKNOWN', canonicalUnit: (rawUnit || null), toBaseFactor: null, trusted: false };
  }

  // ---------------------------------------------------------------------
  // deprecated: derived from UNIT_REGISTRY. Kept for backward compatibility
  // with any external consumer/test that references these directly. Do NOT
  // read these internally — resolveMaterialCost uses lookupUnit()/
  // UNIT_REGISTRY exclusively.
  // ---------------------------------------------------------------------

  // deprecated: derived from UNIT_REGISTRY — WEIGHT/VOLUME members whose
  // factor is > 1 (the "multiple" units, e.g. kg/L/ขีด), in the old
  // { alias: { base, factor } } shape.
  var STANDARD_UNITS = (function () {
    var out = {};
    ['WEIGHT', 'VOLUME'].forEach(function (famName) {
      var fam = UNIT_REGISTRY[famName];
      Object.keys(fam.members).forEach(function (alias) {
        var factor = fam.members[alias];
        if (factor > 1) out[alias] = { base: fam.base, factor: factor };
      });
    });
    return out;
  })();

  // deprecated: derived from UNIT_REGISTRY — WEIGHT/VOLUME base (factor-1)
  // aliases plus all COUNT aliases, in the old { alias: canonicalBase }
  // shape.
  var IDENTITY_UNITS = (function () {
    var out = {};
    ['WEIGHT', 'VOLUME'].forEach(function (famName) {
      var fam = UNIT_REGISTRY[famName];
      Object.keys(fam.members).forEach(function (alias) {
        if (fam.members[alias] === 1) out[alias] = fam.base;
      });
    });
    Object.keys(UNIT_REGISTRY.COUNT.members).forEach(function (alias) {
      out[alias] = Object.prototype.hasOwnProperty.call(COUNT_CANONICAL, alias) ? COUNT_CANONICAL[alias] : alias;
    });
    return out;
  })();

  // computeCost: never returns Infinity or NaN — returns null instead when
  // the price/qty/factor combination is not a valid positive divisor.
  function computeCost(price, qty, factor) {
    var q = (isFinite(qty) && qty > 0) ? qty : NaN;
    var divisor = q * factor;
    if (!isFinite(price) || !isFinite(divisor) || divisor <= 0) return null;
    return price / divisor;
  }

  function resolveMaterialCost(material) {
    material = material || {};

    var price = Number(material.price);
    var qty = Number(material.qty);
    var unit = String(material.unit || '').trim();
    var convQtyRaw = material.conv_qty;
    var convQty = (convQtyRaw === null || convQtyRaw === undefined || convQtyRaw === '')
      ? null
      : Number(convQtyRaw);
    var stockUnit = String(material.stock_unit || '').trim();
    var confirmed = material.confirmed === true;

    var hasExplicit = convQty != null && isFinite(convQty) && convQty > 0 && stockUnit !== '';
    var looked = lookupUnit(unit);

    var result;

    if (hasExplicit) {
      // Branch 1: explicit conversion supplied on the material record.
      var factor1 = convQty;
      var out = {
        costPerStockUnit: null,
        stockUnit: stockUnit,
        source: 'explicit',
        health: 'GREEN',
        warningCode: null,
        receivingBlocked: false,
        needsConfirmation: false
      };

      // kg/L-override rule: only applies when the bare unit is a WEIGHT or
      // VOLUME MULTIPLE unit (registry factor > 1, e.g. กิโลกรัม/ลิตร/ขีด).
      // Factor-1 WEIGHT/VOLUME members (กรัม/มล./ml/g — the base unit
      // itself) are NOT "standard" in the old STANDARD_UNITS sense and skip
      // this check entirely, matching legacy behavior: an explicit
      // conversion on a bare-gram unit was always trusted as-is since
      // STANDARD_UNITS never contained a 'กรัม' key.
      var isMultipleUnit = (looked.family === 'WEIGHT' || looked.family === 'VOLUME') && looked.toBaseFactor > 1;

      if (isMultipleUnit && convQty !== looked.toBaseFactor) {
        // Non-standard override of a recognized kg/L unit — requires
        // human confirmation before it's fully trusted.
        out.needsConfirmation = !confirmed;
        if (confirmed) {
          out.health = 'GREEN';
          out.warningCode = null;
        } else {
          out.health = 'YELLOW';
          out.warningCode = 'MAT_KGL_OVERRIDE_UNCONFIRMED';
        }
      } else {
        out.needsConfirmation = false;
        out.health = 'GREEN';
        out.warningCode = null;
      }

      out.costPerStockUnit = computeCost(price, qty, factor1);
      result = out;
    } else if ((looked.family === 'WEIGHT' || looked.family === 'VOLUME') && looked.toBaseFactor > 1) {
      // Branch 2: no explicit conversion, but the unit is a recognized
      // WEIGHT/VOLUME MULTIPLE unit (kg/L/ขีด family) — fall back to the
      // registry factor.
      result = {
        costPerStockUnit: computeCost(price, qty, looked.toBaseFactor),
        stockUnit: looked.canonicalUnit,
        source: 'standard_fallback',
        health: 'GREEN',
        warningCode: null,
        needsConfirmation: false,
        receivingBlocked: false
      };
    } else if (looked.trusted && looked.toBaseFactor === 1) {
      // Branch 3: no explicit conversion, but the unit is a recognized
      // same-unit inventory — either a WEIGHT/VOLUME base unit
      // (gram/ml, factor 1) or a COUNT unit (piece/egg/ใบ/อัน/...) —
      // trusted 1:1, factor 1.
      result = {
        costPerStockUnit: computeCost(price, qty, 1),
        stockUnit: looked.canonicalUnit,
        source: 'identity',
        health: 'GREEN',
        warningCode: null,
        needsConfirmation: false,
        receivingBlocked: false
      };
    } else {
      // Branch 4: no explicit conversion and not a recognized standard or
      // identity unit (PACKAGING or UNKNOWN) — we cannot safely compute a
      // per-stock-unit cost.
      result = {
        costPerStockUnit: null,
        stockUnit: stockUnit || unit || null,
        source: 'ambiguous',
        health: 'RED',
        warningCode: 'MAT_UNIT_AMBIGUOUS_NO_CONVERSION',
        receivingBlocked: true,
        needsConfirmation: false
      };
    }

    // Invalid-denominator downgrade (branches 1 & 2 only): if we couldn't
    // compute a trusted number (bad qty/price) and this isn't already the
    // override-YELLOW case, downgrade to YELLOW so GREEN always implies a
    // real, finite cost.
    if (result.source !== 'ambiguous' && result.costPerStockUnit === null &&
        result.warningCode !== 'MAT_KGL_OVERRIDE_UNCONFIRMED') {
      result.health = 'YELLOW';
      result.warningCode = 'MAT_INVALID_QUANTITY';
    }

    return result;
  }

  return {
    resolveMaterialCost: resolveMaterialCost,
    UNIT_REGISTRY: UNIT_REGISTRY,
    lookupUnit: lookupUnit,
    STANDARD_UNITS: STANDARD_UNITS,
    IDENTITY_UNITS: IDENTITY_UNITS
  };
});
