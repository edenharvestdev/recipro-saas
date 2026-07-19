// backend/src/payments/money.js
//
// THE ONLY place payment-platform money MATH happens. Every payment-platform monetary value is
// authoritative as an INTEGER number of satang (1 baht = 100 satang) from the moment it crosses
// this boundary (backend/db/schema-payment-platform.sql — every new payment-platform monetary
// column is BIGINT `..._satang`). Baht-denominated input from API request bodies (human-typed,
// e.g. "10.10", 10.1, 10) is converted EXACTLY ONCE, here, via bahtToSatang(); nothing downstream
// may re-derive money by multiplying a float baht amount by 100 (that reintroduces float drift).
//
// Legacy app tables (bills.net_sales, bills.gross_sales, all menu/product prices) are OUT OF
// SCOPE for this module — they stay float/NUMERIC baht, untouched, forever (see the schema file's
// header for the full legacy-vs-platform boundary). This module is reached ONLY from
// backend/src/payments/* and backend/src/api/payments.js.
//
// ══════════════════════════════════════════════════════════════════════════════════════════
// TEMPORARY INTERNAL RULE — COMMERCIAL ROUNDING = FOUNDER REVIEW REQUIRED
// ══════════════════════════════════════════════════════════════════════════════════════════
// The Founder has an UNRESOLVED commercial rounding policy decision (e.g. round-half-up vs.
// round-half-to-even/banker's vs. round-down, for percentage discounts / service charge / tax
// splits that land on a fractional satang). Until that decision is made, this module applies
// ROUND-HALF-UP (a.k.a. "round half away from zero" for the non-negative case) at every site
// listed below. This is a TEMPORARY, explicitly documented stand-in — NOT a final policy — and
// must be revisited the moment the Founder decides.
//
// EVERY ROUNDING CALL SITE IN THIS FILE (grep `ROUNDING SITE` to find them all):
//   1. percentOfSatang() — ROUNDING SITE — the only function in this file that can produce a
//      non-integer intermediate result (satang * percent / 100) and therefore the only place
//      that ever rounds. percentSatang()/taxSatang()/serviceChargeSatang() below are thin,
//      non-rounding wrappers that all route through this one function.
// No other function in this file rounds anything:
//   - bahtToSatang() is an EXACT integer reparse (it REJECTS >2 decimal places rather than
//     rounding/truncating them away — see MONEY_TOO_PRECISE).
//   - satangToDisplay() is exact string formatting of an already-integer satang value.
//   - compareSatang() / remainingSatang() / cashChangeSatang() are exact integer arithmetic.
'use strict';

const SATANG_PER_BAHT = 100;
const ROUNDING_MODES = ['HALF_UP', 'HALF_EVEN', 'DOWN', 'UP'];
const DEFAULT_ROUNDING = 'HALF_UP'; // see the TEMPORARY INTERNAL RULE header above

class MoneyError extends Error {
  constructor(code, message, extra) {
    super(message || code);
    this.code = code;
    this.statusCode = 400;
    if (extra) Object.assign(this, extra);
  }
}

function assertSatangInteger(value, label) {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new MoneyError('MONEY_NOT_SATANG_INTEGER', `${label || 'value'} must be an integer number of satang, got: ${JSON.stringify(value)}`);
  }
  return value;
}

// Converts a baht-denominated amount (string OR number — "10.10", "10.1", "0.01", 10, 10.1) into
// an INTEGER number of satang. Never does `Number(input) * 100` (float multiplication of a
// non-power-of-two-friendly base-10 fraction is exactly the drift source this module exists to
// avoid) — always reparses through the decimal string representation instead.
//
// Rejects (never silently coerces):
//   - null/undefined/empty string
//   - NaN / Infinity / -Infinity
//   - more than 2 decimal places (e.g. "10.105") — NEVER silently truncated/rounded away
//   - negative amounts (payment-platform amounts are never negative at this boundary; a REFUND
//     or DISCOUNT direction is expressed by which column/kind it is written to, never by sign)
//   - comma-grouped / locale-ambiguous input ("1,000.50", "1.000,50") — rejected outright rather
//     than guessing which punctuation mark is the decimal separator
function bahtToSatang(input) {
  if (input === null || input === undefined) {
    throw new MoneyError('MONEY_REQUIRED', 'amount is required');
  }
  if (typeof input === 'number' && !Number.isFinite(input)) {
    throw new MoneyError('MONEY_NOT_FINITE', 'amount must be a finite number');
  }
  const str = (typeof input === 'number' ? String(input) : input).trim();
  if (str === '') {
    throw new MoneyError('MONEY_REQUIRED', 'amount is required');
  }
  if (str.includes(',')) {
    throw new MoneyError('MONEY_LOCALE_AMBIGUOUS',
      `amount "${input}" uses a comma separator — locale-ambiguous input is rejected; pass a plain decimal like "1000.50"`);
  }
  const m = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(str);
  if (!m) {
    throw new MoneyError('MONEY_INVALID', `amount "${input}" is not a valid plain decimal number`);
  }
  const [, sign, intPart, fracPartRaw] = m;
  if (sign === '-') {
    throw new MoneyError('MONEY_NEGATIVE', `amount "${input}" must not be negative`);
  }
  const fracPart = fracPartRaw || '';
  if (fracPart.length > 2) {
    throw new MoneyError('MONEY_TOO_PRECISE', `amount "${input}" has more than 2 decimal places — refusing to silently round/truncate`);
  }
  const paddedFrac = (fracPart + '00').slice(0, 2);
  const satang = Number(intPart) * SATANG_PER_BAHT + Number(paddedFrac);
  if (!Number.isSafeInteger(satang)) {
    throw new MoneyError('MONEY_OUT_OF_RANGE', `amount "${input}" is out of the safe integer satang range`);
  }
  return satang;
}

// Formats an integer satang value as a fixed 2-decimal baht display string ("385.50"). Exact —
// no rounding is possible or needed since the input is already an integer.
function satangToDisplay(satang) {
  assertSatangInteger(satang, 'satang');
  const neg = satang < 0;
  const abs = Math.abs(satang);
  const baht = Math.floor(abs / SATANG_PER_BAHT);
  const rem = abs % SATANG_PER_BAHT;
  return (neg ? '-' : '') + String(baht) + '.' + String(rem).padStart(2, '0');
}

function roundHalfUp(x) {
  // round-half-away-from-zero for both signs (documented TEMPORARY rule — see file header).
  return x >= 0 ? Math.floor(x + 0.5) : -Math.floor(-x + 0.5);
}

function roundHalfEven(x) {
  const floor = Math.floor(x);
  const diff = x - floor;
  if (diff < 0.5) return floor;
  if (diff > 0.5) return floor + 1;
  // exactly .5 — go to the even neighbor
  return (floor % 2 === 0) ? floor : floor + 1;
}

// ROUNDING SITE (see file header). Computes `pct` percent of `satang`, rounded per `rounding`
// (defaults to the TEMPORARY DEFAULT_ROUNDING = 'HALF_UP'). Used for percentage discounts,
// service-charge %, and tax % — the only arithmetic in the payment platform that can land on a
// fractional satang.
function percentOfSatang(satang, pct, rounding) {
  assertSatangInteger(satang, 'satang');
  if (typeof pct !== 'number' || !Number.isFinite(pct)) {
    throw new MoneyError('MONEY_INVALID', 'percent must be a finite number');
  }
  const mode = rounding || DEFAULT_ROUNDING;
  if (!ROUNDING_MODES.includes(mode)) {
    throw new MoneyError('MONEY_INVALID', `unknown rounding mode "${mode}"`);
  }
  const scaled = (satang * pct) / 100;
  let rounded;
  switch (mode) {
    case 'HALF_UP': rounded = roundHalfUp(scaled); break;
    case 'HALF_EVEN': rounded = roundHalfEven(scaled); break;
    case 'DOWN': rounded = Math.trunc(scaled); break;
    case 'UP': rounded = scaled >= 0 ? Math.ceil(scaled) : Math.floor(scaled); break;
    default: rounded = roundHalfUp(scaled);
  }
  return rounded;
}

// Thin, non-rounding-policy-inventing wrappers over percentOfSatang — kept as named call sites
// so a future rounding-policy change (or a per-purpose override) has one obvious place per
// concern to land, without adding a second independent rounding implementation.
function taxSatang(satang, taxPct, rounding) { return percentOfSatang(satang, taxPct, rounding); }
function serviceChargeSatang(satang, scPct, rounding) { return percentOfSatang(satang, scPct, rounding); }

// Strict, epsilon-free comparison of two satang integers: -1 / 0 / 1.
function compareSatang(a, b) {
  assertSatangInteger(a, 'a');
  assertSatangInteger(b, 'b');
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

// dueSatang - paidSatang, exact integer subtraction. May be negative if `paidSatang` already
// exceeds `dueSatang` — callers use that to detect an over-allocation; this function does not
// clamp, so the sign is always meaningful to the caller.
function remainingSatang(dueSatang, paidSatang) {
  assertSatangInteger(dueSatang, 'dueSatang');
  assertSatangInteger(paidSatang, 'paidSatang');
  return dueSatang - paidSatang;
}

// CASH change calculation: receivedSatang - dueSatang, floored at 0 (change is never negative;
// insufficient cash is rejected by the caller BEFORE this is invoked).
function cashChangeSatang(receivedSatang, dueSatang) {
  assertSatangInteger(receivedSatang, 'receivedSatang');
  assertSatangInteger(dueSatang, 'dueSatang');
  return Math.max(0, receivedSatang - dueSatang);
}

module.exports = {
  SATANG_PER_BAHT,
  MoneyError,
  DEFAULT_ROUNDING,
  assertSatangInteger,
  bahtToSatang,
  satangToDisplay,
  percentOfSatang,
  taxSatang,
  serviceChargeSatang,
  compareSatang,
  remainingSatang,
  cashChangeSatang,
};
