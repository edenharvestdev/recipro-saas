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
// source values returned by resolveMaterialCost:
//   'explicit'          — material carries an explicit conv_qty + stock_unit
//   'standard_fallback' — recognized kg/L family, auto-converted with factor 1000
//   'identity'          — recognized same-unit inventory (gram/ml/piece/egg),
//                         trusted 1:1 with factor 1 (no conversion needed)
//   'ambiguous'         — unknown/packaging unit with no conversion; not trusted
//
// Public API (returned by the factory below):
//   { resolveMaterialCost, STANDARD_UNITS, IDENTITY_UNITS }
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();                 // Node / CommonJS
  } else {
    root.MaterialResolver = factory();          // browser global
  }
})(typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : this), function () {
  'use strict';

  // Standard unit families that RECIPRO knows how to auto-convert without an
  // explicit conv_qty/stock_unit pair on the material record. Keys are
  // normalized (trimmed, lowercased) aliases; factor is always 1000 for these
  // two families (kg -> g, L -> mL).
  var STANDARD_UNITS = {
    // kg family -> base unit "กรัม" (gram), factor 1000
    'กิโลกรัม': { base: 'กรัม', factor: 1000 },
    'กก.': { base: 'กรัม', factor: 1000 },
    'กก': { base: 'กรัม', factor: 1000 },
    'กิโล': { base: 'กรัม', factor: 1000 },
    'kg': { base: 'กรัม', factor: 1000 },
    'kilogram': { base: 'กรัม', factor: 1000 },
    'kilograms': { base: 'กรัม', factor: 1000 },
    // L family -> base unit "มิลลิลิตร" (milliliter), factor 1000
    'ลิตร': { base: 'มิลลิลิตร', factor: 1000 },
    'ล.': { base: 'มิลลิลิตร', factor: 1000 },
    'l': { base: 'มิลลิลิตร', factor: 1000 },
    'liter': { base: 'มิลลิลิตร', factor: 1000 },
    'litre': { base: 'มิลลิลิตร', factor: 1000 },
    'liters': { base: 'มิลลิลิตร', factor: 1000 }
  };

  // Trusted identity units: same-unit inventory that needs NO conversion
  // (factor 1). The purchase unit already IS the stock unit, so cost is
  // computed directly. Keys are normalized (trimmed, lowercased) aliases;
  // `base` is the canonical stock-unit label. These are trusted GREEN when
  // price/qty are valid — they are NOT ambiguous. Packaging units
  // (ถุง/กล่อง/แพ็ค/ลัง/ถาด/แผง) and a bare ขวด are deliberately EXCLUDED here
  // and remain ambiguous unless the material supplies an explicit conversion.
  var IDENTITY_UNITS = {
    // gram family
    'กรัม': 'กรัม', 'g': 'กรัม', 'gram': 'กรัม', 'grams': 'กรัม',
    // milliliter family
    'มล.': 'มิลลิลิตร', 'มล': 'มิลลิลิตร', 'มิลลิลิตร': 'มิลลิลิตร',
    'ml': 'มิลลิลิตร', 'milliliter': 'มิลลิลิตร', 'millilitre': 'มิลลิลิตร', 'milliliters': 'มิลลิลิตร',
    // piece family
    'ชิ้น': 'ชิ้น', 'piece': 'ชิ้น', 'pieces': 'ชิ้น', 'pcs': 'ชิ้น', 'pc': 'ชิ้น',
    // egg family
    'ฟอง': 'ฟอง', 'egg': 'ฟอง', 'eggs': 'ฟอง'
  };

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
    var std = STANDARD_UNITS[unit.toLowerCase()];

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

      if (std && convQty !== std.factor) {
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
    } else if (std) {
      // Branch 2: no explicit conversion, but the unit is a recognized
      // standard (kg/L family) — fall back to the standard factor.
      var factor2 = std.factor;
      result = {
        costPerStockUnit: computeCost(price, qty, factor2),
        stockUnit: std.base,
        source: 'standard_fallback',
        health: 'GREEN',
        warningCode: null,
        needsConfirmation: false,
        receivingBlocked: false
      };
    } else if (IDENTITY_UNITS[unit.toLowerCase()]) {
      // Branch 3: no explicit conversion, but the unit is a recognized
      // same-unit inventory (gram/ml/piece/egg) — trusted 1:1, factor 1.
      result = {
        costPerStockUnit: computeCost(price, qty, 1),
        stockUnit: IDENTITY_UNITS[unit.toLowerCase()],
        source: 'identity',
        health: 'GREEN',
        warningCode: null,
        needsConfirmation: false,
        receivingBlocked: false
      };
    } else {
      // Branch 4: no explicit conversion and not a recognized standard or
      // identity unit — we cannot safely compute a per-stock-unit cost.
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
    STANDARD_UNITS: STANDARD_UNITS,
    IDENTITY_UNITS: IDENTITY_UNITS
  };
});
