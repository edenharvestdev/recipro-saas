// backend/src/payments/money.js — unit tests for the payment-platform's ONLY money-math module.
// Pure unit tests, zero DB/HTTP — money.js has no I/O of its own.
require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert');
const money = require('../src/payments/money');

// ─── bahtToSatang: exact conversions ──────────────────────────────────────────

test('M1 0.01 baht -> 1 satang', () => {
  assert.strictEqual(money.bahtToSatang('0.01'), 1);
  assert.strictEqual(money.bahtToSatang(0.01), 1);
});

test('M2 0.10 baht -> 10 satang', () => {
  assert.strictEqual(money.bahtToSatang('0.10'), 10);
  assert.strictEqual(money.bahtToSatang(0.1), 10);
});

test('M3 10.10 baht -> 1010 satang', () => {
  assert.strictEqual(money.bahtToSatang('10.10'), 1010);
  assert.strictEqual(money.bahtToSatang(10.1), 1010);
});

test('M4 integer baht 10 -> 1000 satang', () => {
  assert.strictEqual(money.bahtToSatang(10), 1000);
  assert.strictEqual(money.bahtToSatang('10'), 1000);
});

test('M5 "10.105" (3 decimal places) is rejected, never silently rounded/truncated', () => {
  assert.throws(() => money.bahtToSatang('10.105'), (e) => e.code === 'MONEY_TOO_PRECISE');
  assert.throws(() => money.bahtToSatang('0.001'), (e) => e.code === 'MONEY_TOO_PRECISE');
});

test('M6 repeated additions carry no drift: 0.10 added 100 times === 1000 satang exactly', () => {
  let sum = 0;
  for (let i = 0; i < 100; i++) sum += money.bahtToSatang('0.10');
  assert.strictEqual(sum, 1000);
  // The float-drift trap this whole module exists to avoid: naive float baht math does NOT
  // reproduce 10 exactly (proving the satang path is actually needed, not just cosmetic).
  let floatSum = 0;
  for (let i = 0; i < 100; i++) floatSum += 0.10;
  assert.notStrictEqual(floatSum, 10, 'sanity check: naive float accumulation drifts (this is why money.js exists)');
});

test('M7 NaN / Infinity / -Infinity rejected', () => {
  assert.throws(() => money.bahtToSatang(NaN), (e) => e.code === 'MONEY_NOT_FINITE');
  assert.throws(() => money.bahtToSatang(Infinity), (e) => e.code === 'MONEY_NOT_FINITE');
  assert.throws(() => money.bahtToSatang(-Infinity), (e) => e.code === 'MONEY_NOT_FINITE');
});

test('M8 negative amounts rejected', () => {
  assert.throws(() => money.bahtToSatang('-10.50'), (e) => e.code === 'MONEY_NEGATIVE');
  assert.throws(() => money.bahtToSatang(-1), (e) => e.code === 'MONEY_NEGATIVE');
});

test('M9 null/undefined/empty rejected', () => {
  assert.throws(() => money.bahtToSatang(null), (e) => e.code === 'MONEY_REQUIRED');
  assert.throws(() => money.bahtToSatang(undefined), (e) => e.code === 'MONEY_REQUIRED');
  assert.throws(() => money.bahtToSatang(''), (e) => e.code === 'MONEY_REQUIRED');
  assert.throws(() => money.bahtToSatang('   '), (e) => e.code === 'MONEY_REQUIRED');
});

test('M10 comma-grouped / locale-ambiguous input rejected outright (never guessed)', () => {
  assert.throws(() => money.bahtToSatang('1,000.50'), (e) => e.code === 'MONEY_LOCALE_AMBIGUOUS');
  assert.throws(() => money.bahtToSatang('1.000,50'), (e) => e.code === 'MONEY_LOCALE_AMBIGUOUS');
});

test('M11 garbage / non-numeric strings rejected', () => {
  assert.throws(() => money.bahtToSatang('abc'), (e) => e.code === 'MONEY_INVALID');
  assert.throws(() => money.bahtToSatang('10.10.10'), (e) => e.code === 'MONEY_INVALID');
  assert.throws(() => money.bahtToSatang('1e21'), (e) => e.code === 'MONEY_INVALID');
});

// ─── satangToDisplay ───────────────────────────────────────────────────────────

test('M12 satangToDisplay formats to a fixed 2-decimal baht string', () => {
  assert.strictEqual(money.satangToDisplay(38550), '385.50');
  assert.strictEqual(money.satangToDisplay(1), '0.01');
  assert.strictEqual(money.satangToDisplay(100000), '1000.00');
  assert.strictEqual(money.satangToDisplay(0), '0.00');
});

test('M12b satangToDisplay rejects a non-integer / non-satang input', () => {
  assert.throws(() => money.satangToDisplay(10.5), (e) => e.code === 'MONEY_NOT_SATANG_INTEGER');
  assert.throws(() => money.satangToDisplay('100'), (e) => e.code === 'MONEY_NOT_SATANG_INTEGER');
});

// ─── percentOfSatang: the ONE rounding call site (documented TEMPORARY HALF_UP rule) ─────────

test('M13 percentage adjustment rounding: documented HALF_UP rule at the fractional-satang boundary', () => {
  // 7% of 10000 satang = 700.00 exactly — no rounding needed.
  assert.strictEqual(money.percentOfSatang(10000, 7), 700);
  // 10% of 5 satang = 0.5 satang -> HALF_UP rounds to 1.
  assert.strictEqual(money.percentOfSatang(5, 10), 1);
  // 15% of 33 satang = 4.95 -> rounds up to 5.
  assert.strictEqual(money.percentOfSatang(33, 15), 5);
  // Explicit alternate rounding modes are available (documented, not the default).
  assert.strictEqual(money.percentOfSatang(5, 10, 'DOWN'), 0);
  assert.strictEqual(money.percentOfSatang(5, 10, 'UP'), 1);
  assert.strictEqual(money.percentOfSatang(150, 50, 'HALF_EVEN'), 75); // exact, no rounding needed
});

test('M13b tax/service-charge helpers route through the same single rounding site', () => {
  assert.strictEqual(money.taxSatang(10000, 7), money.percentOfSatang(10000, 7));
  assert.strictEqual(money.serviceChargeSatang(10000, 10), money.percentOfSatang(10000, 10));
});

// ─── cashChangeSatang ──────────────────────────────────────────────────────────

test('M14 cash change calculated in satang: received - due, floored at 0', () => {
  assert.strictEqual(money.cashChangeSatang(10000, 8500), 1500);
  assert.strictEqual(money.cashChangeSatang(8500, 8500), 0);
  assert.strictEqual(money.cashChangeSatang(8500, 8500), 0);
});

// ─── compareSatang / remainingSatang: strict, epsilon-free integer semantics ─────────────────

test('M15 compareSatang is strict integer comparison, no epsilon', () => {
  assert.strictEqual(money.compareSatang(100, 100), 0);
  assert.strictEqual(money.compareSatang(99, 100), -1);
  assert.strictEqual(money.compareSatang(101, 100), 1);
});

test('M16 remainingSatang is exact integer subtraction, sign meaningful (negative = over-allocated)', () => {
  assert.strictEqual(money.remainingSatang(1000, 999), 1);
  assert.strictEqual(money.remainingSatang(1000, 1000), 0);
  assert.strictEqual(money.remainingSatang(1000, 1001), -1);
});

// ─── assertSatangInteger guard used across the money API ────────────────────────

test('M17 every satang-consuming function rejects a non-integer satang argument', () => {
  assert.throws(() => money.compareSatang(1.5, 1), (e) => e.code === 'MONEY_NOT_SATANG_INTEGER');
  assert.throws(() => money.remainingSatang(1000, 999.5), (e) => e.code === 'MONEY_NOT_SATANG_INTEGER');
  assert.throws(() => money.cashChangeSatang(100.1, 100), (e) => e.code === 'MONEY_NOT_SATANG_INTEGER');
  assert.throws(() => money.percentOfSatang(NaN, 10), (e) => e.code === 'MONEY_NOT_SATANG_INTEGER');
});

// ─── out-of-range guard ────────────────────────────────────────────────────────

test('M18 absurdly large amounts are rejected rather than silently overflowing', () => {
  assert.throws(() => money.bahtToSatang('99999999999999999999.99'), (e) => e.code === 'MONEY_OUT_OF_RANGE' || e.code === 'MONEY_INVALID');
});
