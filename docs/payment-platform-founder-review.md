# Payment Platform — Founder Review Package

**Branch:** `feat/payment-dashboard-foundation` @ `4663f9e1be8cb5d47f0395ff90f4420277e20250` (final integrated tip: Phase 6 + Phase 7 + Dashboard + integer-satang conversion, all landed).
**Status:** mock-only, feature-flagged OFF by default, NOT merged to `main`, NOT deployed.
**Purpose of this document:** a self-contained review package. You should not need to read commit history to understand what exists, why it is shaped this way, what is still a placeholder, and what decisions are waiting on you.

---

## 1. Architecture summary

The payment platform is a new, additive subsystem bolted onto the existing Recipro POS/bill codebase. Four design decisions define its shape:

- **Allocation-authoritative model.** The question "how much of this bill has actually been paid?" is answered by summing rows in one table — `payment_allocations` — never by counting `payment_transactions` rows or trusting a single "the" payment. `backend/src/payments/allocations.js:1-22` states the invariant plainly:
  ```
  net_paid_satang = SUM(PAYMENT, ACTIVE) - SUM(REFUND, ACTIVE)
  net_paid_satang MUST NEVER exceed bill.amount_due_satang
  ```
  This one design choice is what makes split payment, mixed methods, deposit+balance, and reversal+replacement all work without special-casing — they are just more rows in the same ledger table.

- **Flag-gated, default OFF.** The entire `/api/payments/*` surface is mounted behind an `if (process.env.PAYMENT_PLATFORM_ENABLED !== '1') return res.status(503)` guard at `backend/src/app.js:121-130`. With the flag unset (the production default), every route — including the mock webhook endpoint — returns `503 {"error":"PAYMENT_PLATFORM_DISABLED"}` before any payment code runs. The frontend nav item ships `hidden` in static HTML (`frontend/index.html:203`) and is un-hidden only by a successful probe against `/api/payments/status`, so flag-OFF means literally zero bytes of UI difference. This is proven, not just claimed — see §14.

- **Mock-only.** There is exactly one registered provider adapter, `MockProviderAdapter` (`backend/src/payments/mock-adapter.js`), zero external network calls anywhere in the payment code (enforced by a source-scan + runtime network-disabled test, `backend/test/payment-platform-guards.test.js:117-165`), and zero real credentials. A provider-neutral registry (`backend/src/payments/provider-registry.js`) is the seam where a real adapter (Omise, K SHOP, …) would register later.

- **Integer satang.** Every payment-platform monetary column is `BIGINT ..._satang` (1 baht = 100 satang). All money math funnels through one module, `backend/src/payments/money.js`, and every comparison for "is this bill paid" is strict integer `===`, never a float epsilon. See §4.

Bills stay the single Bill aggregate — no parallel Order model was introduced (`backend/db/schema-payment-platform.sql:43-45`). Confirming a bill (`lifecycle_status: DRAFT → CONFIRMED`) and confirming a payment (a separate `payment_state`/`paid_state` machine) are two different events; see §5.

---

## 2. Branch dependency diagram

```
main (5c5319f — PR #40 Compact Option Editor, tip before payment work started)
  │
  ▼
feat/payment-data-foundation  (35faceb)
   fc98032  Phase 6 payment data foundation — allocation-authoritative schema
   468d34c  fix: payment_allocations.transaction_id FK uses NO ACTION, not RESTRICT
   35faceb  integer satang money model — schema + central money utility
  │  (merged via 66a42e8)
  ▼
feat/billing-payment-state-machine  (c6fa7ea)
   3b4435d  Phase 7 state machines + cash/static-QR/mock-dynamic flows (flag OFF)
   26c6c4d  lazy expiry enforced in the webhook path too
   27e5d20  test: 31 core + 5 guard tests (Founder's 24 + 6 correction cases)
   c6fa7ea  convert allocation/service/API logic to integer satang (Part 1+2)
  │  (merged via f63edef)
  ▼
feat/payment-dashboard-foundation  (4663f9e ← THIS document's tip)
   cc4803b  dashboard read API — order_no join, requireAnyPerm, audit endpoint
   24bdebf  dashboard read API — /status probe, provider_verified + confirmer name
   c9a56b1  frontend: Store Payment Dashboard page (flag + permission gated)
   bcb71a3  dev-only demo seeder for the payment dashboard
   647f103  test: payment-dashboard.test.js — 16 API + frontend-extraction tests
   4663f9e  dashboard formatting from satang (Part 1 finish)
```

**Recommended PR review order: A → B → C**, in the order above (`feat/payment-data-foundation` → `feat/billing-payment-state-machine` → `feat/payment-dashboard-foundation`), because each branch's diff is only reviewable against the one before it (B assumes A's schema exists; C assumes B's service/API layer exists). Reviewing C in isolation without A/B context will look like an enormous, un-followable diff.

None of the three branches has touched `main`. `main`'s tip (verified via `git merge-base main feat/payment-data-foundation`) is `5c5319f`, unchanged.

---

## 3. Schema summary

File: `backend/db/schema-payment-platform.sql` (402 lines). Applied additively/idempotently — every `ALTER TABLE` uses `ADD COLUMN IF NOT EXISTS`, every `CREATE TABLE`/`CREATE INDEX` uses `IF NOT EXISTS`. It runs as the last of 39 migration files in `backend/src/migrate.js:8-64` (line 63), which Railway's boot sequence always runs first (`railway.json`: `"startCommand": "node backend/src/migrate.js && node backend/src/bootstrap.js && node backend/src/index.js"`). So the schema lands on every deploy regardless of whether the feature flag is on.

### bills — additive column only (schema-payment-platform.sql:83-129)
```
payment_state             TEXT DEFAULT NULL          -- NULL = legacy/non-platform bill
paid_state                TEXT NOT NULL DEFAULT 'UNPAID'
kitchen_release_eligible  BOOLEAN NOT NULL DEFAULT false
amount_due_satang         BIGINT DEFAULT NULL         -- satang-authoritative amount due
```
Plus two widened CHECK constraints (never narrowed — every previously-legal value stays legal): `lifecycle_status` gains `CANCELLED` (line 108-110), and two brand-new constraints on `payment_state`/`paid_state` (lines 117-129). Legacy bills (`payment_state IS NULL`) are untouched in every dimension — the platform's code paths never read or write them.

### The 9 new tables

| Table | Purpose | Money columns (all `BIGINT ..._satang`) |
|---|---|---|
| `bill_items` (153-169) | Normalized line items for platform-created bills only; legacy `items_json` blob untouched | `unit_price_satang`, `line_gross_satang`, `line_discount_satang`, `line_net_satang` |
| `bill_adjustments` (173-184) | Bill-level discount/service-charge/tax lines | `amount_satang` |
| `payment_provider_events` (189-200) | Raw inbound webhook/event log — the idempotency backbone | none (payload is JSONB) |
| `payment_intents` (207-235) | One payment attempt-context (method, amount, expiry) | `amount_due_satang` |
| `payment_transactions` (244-301) | Outcome of an intent that reached CONFIRMED/FAILED/etc | `expected_amount_satang`, `paid_amount_satang`, `refund_total_satang`, `amount_received_satang`, `change_amount_satang` |
| `payment_allocations` (316-337) | **The authoritative Bill↔transaction link** — PAYMENT/REFUND rows | `allocated_amount_satang` |
| `payment_refunds` (341-356) | Refund request/approval model — never moves money | `refunded_amount_satang` |
| `payment_reconciliation_records` (362-378) | Manual match-status flags vs provider/bank statements | `expected_amount_satang`, `provider_amount_satang`, `settlement_amount_satang` |
| `receipts` (384-402) | Projection-on-demand of a confirmed payment; multiple per bill are expected | none |

### The three DB-level uniquenesses that stay (schema-payment-platform.sql:33-40)
1. `UNIQUE (provider, event_id)` on `payment_provider_events` — webhook replay dedupe (already present in the original draft).
2. `UNIQUE (provider, provider_txn_id)` on `payment_transactions` (line 284-285) — **added**; the original draft had no protection against recording the same provider transaction twice. Proven by test `C4` (`backend/test/payment-platform.test.js:598-612`).
3. Tenant/provider-scoped idempotency key — `UNIQUE (shop_id, provider, idempotency_key)` on **both** `payment_intents` (line 234-235) and `payment_transactions` (line 280-281) — **corrected**; the original draft's indexes omitted `provider`, which would have let two different providers collide on the same key within a shop.

### The REMOVED index, and why (schema-payment-platform.sql:10-32, 286-301)
The original draft enforced *at most one CONFIRMED payment transaction per bill* via a partial unique index, `payment_transactions_one_confirmed_per_bill_idx ON payment_transactions (bill_id) WHERE status='CONFIRMED'`. **The Founder explicitly overruled this as a permanent restriction.** Split payment, mixed methods (cash+QR on one bill), deposit-then-balance, multiple partial payments, and reversal-then-replacement all legitimately require *multiple* CONFIRMED transactions against the same bill. The index is removed entirely — no method-scoped subset was justified, because CASH/STATIC_QR/DYNAMIC_QR are all named as legitimate mixed-payment participants. The invariant that actually matters (total collected never exceeds amount due) moved to the application layer (`payment_allocations` + `allocations.js`), because only the application layer can reason about *net* (payments minus refunds) rather than merely counting CONFIRMED rows.

---

## 4. Integer satang policy

File: `backend/src/payments/money.js` (200 lines) — the **only** place payment-platform money math happens.

- **`bahtToSatang(input)`** (lines 70-103): converts human-typed baht input ("10.10", 10.1, 10) into integer satang. It never does `Number(input) * 100` — it always re-parses the decimal string via regex (`/^([+-]?)(\d+)(?:\.(\d+))?$/`, line 85) to avoid float-multiplication drift. It rejects, never silently coerces:
  - `null`/`undefined`/empty string → `MONEY_REQUIRED`
  - `NaN`/`Infinity`/`-Infinity` → `MONEY_NOT_FINITE`
  - more than 2 decimal places (e.g. `"10.105"`) → `MONEY_TOO_PRECISE` (never truncated/rounded away)
  - negative amounts → `MONEY_NEGATIVE`
  - comma-grouped/locale-ambiguous input (`"1,000.50"`, `"1.000,50"`) → `MONEY_LOCALE_AMBIGUOUS` (rejected outright, never guessed)
  - non-numeric garbage → `MONEY_INVALID`
  - amounts outside `Number.isSafeInteger` range → `MONEY_OUT_OF_RANGE`

  Proven by unit tests `M1–M11, M18` in `backend/test/money-satang.test.js`, including `M6` which demonstrates naive float accumulation of `0.10 × 100` does **not** equal `10` exactly, while the satang path does.

- **`satangToDisplay(satang)`** (lines 107-114): exact string formatting of an already-integer value — no rounding possible or needed.

- **TEMPORARY ROUND-HALF-UP rule — FOUNDER REVIEW REQUIRED** (money.js:15-34). The Founder has an unresolved commercial rounding policy decision (round-half-up vs. banker's rounding vs. round-down for percentage discounts/service-charge/tax splits that land on a fractional satang). Until decided, the module applies `HALF_UP` (round-half-away-from-zero) as an explicitly documented **stand-in, not a final policy**.

  **The single rounding site**: `percentOfSatang(satang, pct, rounding)` (money.js:130-153) is the *only* function in the entire module that can produce a non-integer intermediate result (`(satang * pct) / 100`) and therefore the only place that ever rounds. `taxSatang()` and `serviceChargeSatang()` (lines 158-159) are thin, non-rounding-policy-inventing wrappers that route through this one function — so a future policy change has exactly one call site to edit. Every other function in the file (`compareSatang`, `remainingSatang`, `cashChangeSatang`) is exact integer arithmetic with zero rounding. Proven by `M13`/`M13b` in the money test file, which exercises `HALF_UP` (default), `HALF_EVEN`, `DOWN`, and `UP` explicitly.

---

## 5. Bill vs Payment state separation

Core doctrine, stated verbatim in `backend/src/payments/service.js:5-14`: **"BILL_CONFIRMED != PAYMENT_CONFIRMED."** Confirming a bill never marks it paid. All four state machines live in one file, `backend/src/payments/state-machine.js`, each with an explicit transition table enforced by `assertTransition(machine, from, to)` (lines 77-83), which throws a typed `TransitionError` (HTTP 409, code `INVALID_TRANSITION`) on any illegal move — never a silent no-op, never a generic 500.

### BILL (state-machine.js:14-19)
| From | Allowed to |
|---|---|
| DRAFT | CONFIRMED, CANCELLED |
| CONFIRMED | VOIDED, CANCELLED |
| VOIDED | *(terminal)* |
| CANCELLED | *(terminal)* |

### INTENT — one payment attempt-context (state-machine.js:23-37)
| From | Allowed to |
|---|---|
| CREATED | AWAITING_PAYMENT, CANCELLED |
| AWAITING_PAYMENT | INITIATED, QR_DISPLAYED, CONFIRMED, CANCELLED, EXPIRED |
| QR_DISPLAYED | AWAITING_MANUAL_CONFIRMATION, CANCELLED, EXPIRED |
| AWAITING_MANUAL_CONFIRMATION | CONFIRMED, CANCELLED, EXPIRED |
| INITIATED | VERIFICATION_PENDING, CONFIRMED, FAILED, EXPIRED, CANCELLED |
| VERIFICATION_PENDING | CONFIRMED, FAILED, EXPIRED |
| CONFIRMED / FAILED / EXPIRED / CANCELLED | *(all terminal)* |

A retry after any terminal non-CONFIRMED state is always a **new** intent row — this machine is never re-entered once terminal (state-machine.js:21-22).

### TRANSACTION — outcome record of a confirmed/terminal intent (state-machine.js:40-48)
| From | Allowed to |
|---|---|
| RECEIVED | VERIFYING, CONFIRMED, FAILED |
| VERIFYING | CONFIRMED, FAILED |
| CONFIRMED | REVERSED, PARTIALLY_REFUNDED, REFUNDED |
| PARTIALLY_REFUNDED | REFUNDED |
| REVERSED / FAILED / REFUNDED | *(all terminal)* |

### REFUND (state-machine.js:56-59) and RECEIPT (state-machine.js:50-54)
| REFUND | Allowed to | | RECEIPT | Allowed to |
|---|---|---|---|---|
| REQUESTED | APPROVED, REJECTED | | DRAFT | ISSUED |
| APPROVED / REJECTED | *(terminal)* | | ISSUED | VOIDED |

**Why never merged:** `confirmBill()` (`service.js:89-104`) sets `lifecycle_status='CONFIRMED'`, `payment_state='AWAITING_PAYMENT'`, `paid_state='UNPAID'` — it deliberately does **not** touch the legacy `status` column to `'paid'`. Test `T2` (`payment-platform.test.js:104-112`) asserts exactly this: after a bare confirm, `bill.status !== 'paid'`, `paid_state === 'UNPAID'`, `kitchen_release_eligible === false`, and zero transactions exist. Payment confirmation is a fully separate later event, driven only by `cashConfirm`/`staticQrConfirm`/`processProviderWebhook`.

---

## 6. Split / mixed / deposit examples (worked in satang)

All examples are real, passing tests in `backend/test/payment-platform.test.js`, "FOUNDER CORRECTION TESTS" block (lines 515-710) — written specifically to prove the one-confirmed-per-bill index removal was correct.

**Two partials summing to due (deposit-then-balance pattern) — test C1 (517-531):**
Bill due = 100.00 baht = 10,000 satang.
1. Intent #1 (CASH, 60.00 baht = 6,000 satang) confirmed → allocation +6,000 → net=6,000 → `paid_state = PARTIALLY_PAID`.
2. Intent #2 (CASH, 40.00 baht = 4,000 satang) confirmed → allocation +4,000 → net=10,000 → `paid_state = PAID`.
Two CONFIRMED transactions coexist on one bill — the overruled index would have forbidden this at step 2.

**Cash + QR mixed on one bill — test C2 (533-547):**
Bill due = 200.00 baht = 20,000 satang.
1. CASH intent 120.00 baht confirmed → net=12,000 → PARTIALLY_PAID.
2. DYNAMIC_QR intent 80.00 baht confirmed via signed mock webhook (amount=8,000 satang) → net=20,000 → PAID.
`SELECT DISTINCT method` on confirmed transactions returns `['CASH','DYNAMIC_QR']` — both methods confirmed on the same bill.

**Reversal → replacement — test C5 (614-632):**
Bill due = 100.00 baht = 10,000 satang. CASH confirm (100.00) → PAID. `POST /transactions/:id/reverse` writes an ACTIVE REFUND allocation for the full amount → net returns to 0 → `paid_state = UNPAID`, transaction status → `REVERSED`. A brand-new CASH intent (100.00) confirms immediately after → PAID again. `payment_allocations` has no 1:1 cardinality lock, so the replacement payment is simply more ledger rows.

**Refund PAID → PARTIALLY_PAID — test C6 (634-654):** Bill due 100.00 baht, CASH-confirmed → PAID. Refund of 30.00 baht (3,000 satang) requested + approved → REFUND allocation written → net = 10,000 − 3,000 = 7,000 → `paid_state = PARTIALLY_PAID`; transaction status → `PARTIALLY_REFUNDED`.

**Full refund PAID → UNPAID — test C9 (694-710):** Bill due 50.00 baht (5,000 satang), CASH-confirmed → PAID. Refund of the full 50.00 baht approved → net = 0 → `paid_state = UNPAID`; transaction status → `REFUNDED`; `refund_total_satang === paid_amount_satang` exactly.

**One-satang boundary tests (C7/C8, 656-692)** — the strictness of "no epsilon, ever" proven at the smallest possible unit: a bill due 1,000 satang paid to exactly 999 satang stays `PARTIALLY_PAID` forever (never rounds up to PAID), and a second payment that would push net to 1,001 satang (one satang over) is rejected with `OVER_ALLOCATION`, never silently accepted.

---

## 7. Cash walkthrough

Flow: `POST /api/payments/bills` → `POST /bills/:id/confirm` → `POST /intents` (`method: CASH`) → `POST /intents/:id/cash-confirm`. Implementation: `cashConfirm()`, `backend/src/payments/service.js:207-262`.

- **Server-computed change.** The cashier submits `amount_received` (baht); the server converts it via `bahtToSatang`, and change = `cashChangeSatang(receivedSatang, allocationAmountSatang)` (money.js:181-185) = `max(0, received - due)`. The client never supplies change directly. Test `T6` (payment-platform.test.js:174-186): received 100.00 baht against a due of 85.00 baht → `change_amount_satang: 1500`, and the allocation still carries the *due* amount (8,500), never the received amount.
- **Idempotent duplicate.** A repeated cash-confirm with the same `idempotency_key` returns the *existing* transaction (HTTP 200, `already: true`) rather than creating a second one — checked *before* any state mutation (`service.js:213-219`). Test `T4` (146-162): double-tap produces exactly one transaction and one allocation.
- **Below-due rejection.** If `amount_received < allocationAmountSatang`, the server throws `CASH_RECEIVED_INSUFFICIENT` (400) before any row is written; the bill stays `UNPAID`. Test `T5` (164-172).

| Step | Server action | Expected result |
|---|---|---|
| 1. เปิดบิลใหม่ (สร้าง+ยืนยัน) | `createBill` → `confirmBill` | `lifecycle_status=CONFIRMED`, `payment_state=AWAITING_PAYMENT`, `paid_state=UNPAID` |
| 2. สร้างคำขอชำระเงินสด | `createIntent(method='CASH')` | intent `status=AWAITING_PAYMENT` |
| 3. พนักงานรับเงินสดครบ/เกิน | `cashConfirm` | txn `CONFIRMED`, allocation ACTIVE, `paid_state` updates, เงินทอนคำนวณจากเซิร์ฟเวอร์, ใบเสร็จออกอัตโนมัติ |
| 3b. พนักงานรับเงินสดไม่ครบ | `cashConfirm` | 400 `CASH_RECEIVED_INSUFFICIENT`, บิลยังคง `UNPAID` |
| 3c. กดยืนยันซ้ำ (คีย์เดิม) | `cashConfirm` (idempotent) | 200 `already:true`, ไม่มีรายการซ้ำ |

---

## 8. Static QR manual-confirmation walkthrough

Flow: `POST /intents` (`STATIC_QR`) → `POST /intents/:id/static-qr/display` → `POST /intents/:id/static-qr/confirm`. Implementation: `staticQrDisplay()`/`staticQrConfirm()`, `service.js:266-324`.

- **Display ≠ confirm.** `staticQrDisplay` only moves the intent to `QR_DISPLAYED` and audits `STATIC_QR_DISPLAYED`; it never touches `payment_transactions` or allocations. Test `T7` (payment-platform.test.js:190-206) shows the customer-paid signal explicitly does **not** confirm.
- **Customer-signal no-op endpoint.** `POST /intents/:id/customer-paid-signal` (`backend/src/api/payments.js:137-140`) requires **no permission** — and no permission would matter, because it is structurally a no-op: it always returns `{acknowledged:true, state_changed:false}` and never calls into `service.js` at all. This is the concrete anti-`confirmQrReceived()` contract: a customer holds no permission to reach the real confirm path, so a customer-facing screen has somewhere harmless to send its "I paid" tap.
- **Permission + audit.** The real confirm path is gated by `payment_static_qr_confirm` (`payments.js:121`); confirming records `confirmed_by = <user id>` and `provider_verified = false` (never true for static QR — it is always a manual human decision), and writes a `STATIC_QR_MANUALLY_CONFIRMED` audit row. Test `T8` (208-220) and the permission-denial test `T9` (222-238, a staff member without the key gets 403 and the bill stays UNPAID).

| Step | Server action | Expected result |
|---|---|---|
| 1. แสดง QR คงที่ให้ลูกค้า | `staticQrDisplay` | intent `status=QR_DISPLAYED`, audit `STATIC_QR_DISPLAYED` |
| 2. ลูกค้าแตะ "ฉันโอนแล้ว" (ถ้ามีจอลูกค้า) | `customer-paid-signal` (no-op) | `state_changed:false`, ไม่มีอะไรเปลี่ยนในระบบ |
| 3. พนักงาน/ผจก. ตรวจสลิปแล้วกดยืนยันเอง | `staticQrConfirm` | txn `CONFIRMED`, `provider_verified=false`, `confirmed_by=<user>`, ใบเสร็จออก |
| 3b. พนักงานไม่มีสิทธิ์ `payment_static_qr_confirm` | `staticQrConfirm` | 403 `PERMISSION_DENIED`, บิลยังคง `UNPAID` |

---

## 9. Mock Dynamic QR walkthrough

Flow: `POST /intents` (`DYNAMIC_QR`) → mock provider creates a QR payload → `POST /webhooks/mock` delivers a signed event. Implementation: `mock-adapter.js` + `processProviderWebhook()` (`service.js:333-425`).

- **Adapter interface** (mock-adapter.js:1-7): `createPaymentIntent`, `generatePaymentPayload`, `getPaymentStatus`, `verifyWebhook`, `cancelPaymentIntent`, `refundPayment`, `getSettlementStatus`, `reconcileTransaction` — the provider-neutral contract a real adapter (Omise, K SHOP) would implement identically.
- **Deterministic mock.** `getPaymentStatus({simulate})` accepts `'success' | 'fail' | 'expire'` as a caller-controlled parameter (mock-adapter.js:47-53) — this is a test harness, not a black box.
- **Real HMAC on a mock secret.** `verifyWebhook` is *not* a stub that always returns true — it performs a genuine `crypto.createHmac('sha256', MOCK_SECRET)` check with a timing-safe comparison (`safeEqual`, mock-adapter.js:18-23), so the signature-verification code path is genuinely exercised. `MOCK_SECRET` is explicitly documented as never a real provider secret (line 12). Test `T10b` (payment-platform.test.js:270-280) proves a forged signature is rejected with 401 and *nothing* is persisted — not even the event row.
- **Amount/currency matching** happens with strict integer/string equality — a mismatch never confirms; see §15.

| Step | Server action | Expected result |
|---|---|---|
| 1. สร้างคำขอ QR ไดนามิก | `createIntent(method='DYNAMIC_QR')` → adapter `createPaymentIntent` | intent `status=INITIATED`, มี `provider_ref` |
| 2. Mock provider ส่ง webhook สำเร็จ (ลายเซ็นถูกต้อง, ยอด/สกุลเงินตรง) | `processProviderWebhook` | txn `CONFIRMED`, `provider_verified=true`, `confirmed_by='webhook:MOCK'`, บิล `PAID`, `kitchen_release_eligible=true` |
| 2b. Webhook ลายเซ็นปลอม | `verifyWebhook` fails | 401, ไม่มีการบันทึกอะไรเลย แม้แต่ event row |
| 2c. Webhook ซ้ำ (event_id เดิม) | unique index กัน | `duplicate:true`, ยังคงมี 1 transaction เท่านั้น |
| 2d. Webhook ล้มเหลว (simulate=fail) | intent → `FAILED` | บิลยังคง `UNPAID` |

---

## 10. Online-order payment walkthrough

Implementation: `runOnlineOrderMockFlow()` (`service.js:563-584`), exposed at `POST /api/payments/online-orders/mock-submit`. This reuses the exact same building blocks end to end (`createBill` → `confirmBill` → `createIntent(DYNAMIC_QR)` → mock webhook) — it adds no new state, only a convenience wrapper that proves the full chain and surfaces **one boolean**: `kitchen_release_eligible`.

`kitchen_release_eligible` is a column on `bills` (schema-payment-platform.sql:86), written only inside `writeAllocation()` (`allocations.js:104-107`) as `paidState === 'PAID'`. It is never set by the order-submission step itself — only by an actual confirmed payment reaching full due.

| Step | สถานะ | ผล |
|---|---|---|
| 1. ลูกค้าสั่งออนไลน์ (mock submit) | bill DRAFT→CONFIRMED, intent DYNAMIC_QR→INITIATED | order ยังไม่ถูกรับ |
| 2a. Mock webhook สำเร็จ | txn CONFIRMED, allocation PAYMENT เต็มจำนวน | `order_accepted:true`, `kitchen_release_eligible:true`, bill `PAID` |
| 2b. Mock webhook ล้มเหลว (`simulate:'fail'`) | intent FAILED, ไม่มี allocation | `order_accepted:false`, `kitchen_release_eligible:false`, bill ยังคง `UNPAID` |

Test `T15` (payment-platform.test.js:376-391) proves both branches in one test — kitchen release is gated strictly on `PAYMENT_CONFIRMED`, never on order submission alone. Note: this mock flow does **not** itself link a real `orders` row (`order_id` stays null unless set separately, as the dashboard demo seeder does manually) — it demonstrates only the payment↔kitchen-release invariant.

---

## 11. Dashboard walkthrough (คู่มือทดสอบสำหรับ Founder — ทำตามได้ทีละคลิก)

**เตรียมข้อมูลก่อนทดสอบ (ทำครั้งเดียว):**
1. เปิด local Postgres และตรวจว่า `backend/.env` ชี้ไปที่ฐานข้อมูล **local** เท่านั้น (สคริปต์นี้จะปฏิเสธการรันถ้า `DATABASE_URL` ไม่ใช่ localhost/127.0.0.1 — `backend/test/seed-payment-dashboard-demo.js:40-44`)
2. รันคำสั่ง (จาก root ของ repo): `node backend/test/seed-payment-dashboard-demo.js`
3. รอจนเห็นบล็อกข้อความ `PAYDASH DEMO SEEDED — 9 bills (10 demo steps) in shop "PAYDASH DEMO SHOP"` พร้อมอีเมล/รหัสผ่านที่พิมพ์ออกมา (สคริปต์สุ่มอีเมลใหม่ทุกครั้งที่รัน — ใช้ค่าที่พิมพ์ออกมาจริง อย่าเดา) — หมายเหตุ: สคริปต์สร้าง**บิล 9 ใบ** ใน 10 ขั้นตอน demo (ขั้นที่ 9 คือการ flag reconciliation บน transaction ของบิลที่ 1 ไม่ใช่บิลใหม่)
4. เปิด PowerShell แล้วสั่ง `$env:PAYMENT_PLATFORM_ENABLED='1'; npm start` (หรือ bash: `PAYMENT_PLATFORM_ENABLED=1 npm start`) — **ต้องตั้ง flag นี้ก่อน start ทุกครั้ง** ไม่งั้น API จะตอบ 503 ทั้งหมดและเมนู "ชำระเงิน" จะไม่ขึ้น
5. เปิดเบราว์เซอร์ไปที่ `http://localhost:3100` (พอร์ต local dev ตามที่ตั้งไว้)

**ขั้นตอนการคลิกทดสอบ:**

| ขั้น | คลิก / กระทำ | ผลลัพธ์ที่คาดหวัง |
|---|---|---|
| 1 | ล็อกอินด้วยอีเมล/รหัสผ่านที่สคริปต์ seeder พิมพ์ไว้ | เข้าสู่หน้าหลักของร้าน "PAYDASH DEMO SHOP" |
| 2 | มองแถบเมนูด้านซ้าย | เมนู **"ชำระเงิน"** (ไอคอนบัตรเครดิต) ปรากฏขึ้น — ถ้า flag ปิดหรือไม่มีสิทธิ์ เมนูนี้จะไม่ขึ้นเลย (`initPayDashNav`, `frontend/index.html:16303-16313`, ตรวจผ่าน `GET /api/payments/status`) |
| 3 | คลิกเมนู "ชำระเงิน" | เข้าสู่หน้า **แดชบอร์ดการชำระเงิน** (`#paydashPage`), ระบบเรียก `loadPayDash()` อัตโนมัติ และแสดงตาราง **9 แถว** (บิล 9 ใบที่ seed ไว้ — บิลละ 1 แถว) พร้อมชุดตัวกรอง **7 ช่อง** (สถานะธุรกรรม · วิธีชำระ · วันที่เริ่ม · วันที่สิ้นสุด · เลขออเดอร์ · เลขที่บิล · checkbox เฉพาะรอตรวจสอบ) — ขอบเขตร้าน/สาขามาจากร้านที่ล็อกอินอยู่ (`shop_id` ฝั่งเซิร์ฟเวอร์) ผ่านตัวสลับร้านเดิมของระบบ ไม่ใช่ตัวกรองของแดชบอร์ด |
| 4 | สังเกตหัวตาราง (เลื่อนซ้าย-ขวาได้ถ้าจอแคบ) | เห็นครบ **14 คอลัมน์**: เลขออเดอร์ · เลขที่บิล · ยอดเงิน · วิธีชำระ · สถานะ Intent · สถานะธุรกรรม · การตรวจสอบ · เวลาสร้าง · เวลาชำระ · หมดอายุ · ผู้ยืนยัน · อ้างอิงผู้ให้บริการ · ยอดตรงกัน · ตรวจสอบด้วยตนเอง |
| 5 | มองแถวที่ 1 (บิล 120 บาท เงินสด) | ยอดเงินแสดง **฿120.00** (จัดรูปแบบจาก satang ผ่าน `paydashMoney`), badge สถานะ "ชำระครบ" (สีเขียว), วิธีชำระ "เงินสด" |
| 6 | มองแถวบิล STATIC_QR ที่ "แสดง QR แล้ว" (bill 2) | สถานะ Intent = "แสดง QR แล้ว" (สีฟ้า), สถานะธุรกรรม = "—" (ยังไม่มี transaction เพราะยังไม่ยืนยัน) |
| 7 | มองแถวบิล DYNAMIC_QR ที่สำเร็จ (bill 4, 350 บาท) | คอลัมน์ "การตรวจสอบ" แสดง **"ตรวจสอบโดยผู้ให้บริการ"** (provider-verified) ต่างจากแถวเงินสด/QR คงที่ที่จะแสดง "ยืนยันด้วยมือ" |
| 8 | มองแถวบิลที่ refund แล้ว (bill 8, 500 บาท) | สถานะการชำระ = "ชำระบางส่วน" (PARTIALLY_PAID) เพราะคืนเงินไปแล้วบางส่วน |
| 9 | เปิด filter "สถานะการชำระเงิน" เลือก "ย้อนรายการ (REVERSED)" | ตารางกรองเหลือเฉพาะบิลที่ถูก reverse (ถ้า seed มี) — ยืนยันว่า filter ทำงานจริงกับฐานข้อมูล ไม่ใช่กรองฝั่ง client |
| 10 | ลบ filter สถานะ แล้วเลือก filter "วิธีชำระ" = "QR ไดนามิก" | เหลือเฉพาะ 2 แถวที่จ่ายด้วย DYNAMIC_QR |
| 11 | พิมพ์คำในช่อง "เลขที่บิล" (บางส่วนของเลขบิลจริง) | ตารางกรองแบบ partial + ไม่สนตัวพิมพ์เล็กใหญ่ (`ILIKE '%...%'`) |
| 12 | พิมพ์ `Q-0042` ในช่อง "เลขออเดอร์" | เหลือเฉพาะบิลที่ 10 (เชื่อมกับ order แถวที่มี `order_no='Q-0042'`) |
| 13 | ติ๊กช่อง "เฉพาะรายการรอตรวจสอบด้วยตนเอง" | เหลือเฉพาะบิล 1 (ที่ seeder ทำ reconciliation flag ไว้เป็น AMOUNT_MISMATCH) |
| 14 | คลิกที่แถวใดก็ได้ (ทั้งแถวคลิกได้ ไม่ใช่แค่ปุ่ม) | แถวย่อยขยายออกด้านล่าง แสดง **ประวัติการทำรายการ (audit)** ของบิลนั้น — เวลา, ประเภทเหตุการณ์ (ภาษาไทย), ผู้ทำรายการ, เหตุผล เรียงตามเวลา |
| 15 | คลิกแถวเดิมซ้ำ | แถว audit ที่ขยายไว้จะปิดลง (toggle) |
| 16 | คลิกแถวอื่นขณะที่มีแถว audit เปิดอยู่แล้ว | แถว audit เก่าปิดอัตโนมัติ เหลือเปิดแค่แถวเดียวเสมอ |
| 17 | คลิกปุ่ม "รีเฟรช" มุมขวาบน | โหลดข้อมูลใหม่จากเซิร์ฟเวอร์ (คงค่า filter เดิมไว้) |
| 18 | ทดสอบด้วย user ที่ไม่มีสิทธิ์ `billing_view`/`payment_review` | เมนู "ชำระเงิน" จะไม่ปรากฏเลยตั้งแต่แรก (client-side gate ที่ `paydashAllowed()`) และถ้าเข้า URL ตรง ๆ เซิร์ฟเวอร์จะตอบ 403 เสมอ |

**หมายเหตุสำคัญ:** ทุกคอลัมน์/ทุกฟิลเตอร์ข้างต้นมีการทดสอบอัตโนมัติยืนยันไว้แล้วใน `backend/test/payment-dashboard.test.js` (18 tests, D1–D5 + F1–F7) — การคลิกทดสอบนี้คือการยืนยันด้วยตาว่าสิ่งที่เทสต์พิสูจน์ไว้ตรงกับสิ่งที่ Founder เห็นจริงบนหน้าจอ

---

## 12. Permission matrix

11 permission keys govern every `/api/payments/*` route (8 new keys defined for this platform, `backend/src/permissions/catalog.js:98-107`, plus 3 reused from the existing `bills` group). Enforcement is always server-side via `requirePerm(key)`/`requireAnyPerm(keys)` (`backend/src/tenant.js:63-81`) attached directly to each route in `backend/src/api/payments.js` — frontend hiding is never the security boundary (stated doctrine, `payments.js:5-8`).

| Key | Route(s) | Cashier (`front_store` preset) | Manager (`manager` preset) | Owner |
|---|---|---|---|---|
| `bill_create_draft` | `POST /bills` | ✅ (also a conservative staff default) | ✅ | ✅ (bypass) |
| `bill_confirm` | `POST /bills/:id/confirm`, `POST /intents`, `POST /intents/:id/static-qr/display` | ✅ (also a conservative staff default) | ✅ | ✅ |
| `void_bill` | `POST /bills/:id/void` | ❌ | ✅ | ✅ |
| `billing_view` | `GET /dashboard`, `GET /status`, `GET /bills/:id/audit` (OR with `payment_review`) | ✅ | ✅ | ✅ |
| `payment_cash_confirm` | `POST /intents/:id/cash-confirm` | ✅ | ✅ | ✅ |
| `payment_static_qr_confirm` | `POST /intents/:id/static-qr/confirm` | ✅ | ✅ | ✅ |
| `payment_review` | `GET /dashboard`, `GET /status`, `GET /bills/:id/audit` (OR with `billing_view`) | ❌ | ✅ | ✅ |
| `payment_refund_request` | `POST /refunds` | ❌ | ✅ | ✅ |
| `payment_refund_approve` | `POST /refunds/:id/approve`, `POST /refunds/:id/reject`, `POST /transactions/:id/reverse` | ❌ | ❌ (explicitly excluded, `MANAGER_EXCLUDE`, catalog.js:193-194) | ✅ |
| `reconciliation_view` | `POST /reconciliation/:transactionId/flag` | ❌ | ✅ | ✅ |
| `reconciliation_resolve` | `POST /reconciliation/:recordId/resolve` | ❌ | ❌ (explicitly excluded) | ✅ |

**Owner/superadmin bypass everything** (`catalog.js#hasPerm:148`: `if (isSuperadmin === true || role === 'owner') return true`). **Manager gets broad access except money-moving-adjacent approvals** — refund approval and reconciliation resolution stay owner-only by deliberate design, matching the existing sensitivity tier of `void_bill`/`bill_correct` (catalog.js:188-194). A bare staff member with **no** preset and no explicit grant gets `bill_create_draft`/`bill_confirm` for free (conservative "enough to sell" defaults, `STAFF_DEFAULTS`, catalog.js:138-142) but **none** of the payment-specific keys — proven fail-closed by tests `T9` (payment-platform.test.js:222-238) and `D1` (payment-dashboard.test.js:176-192).

The dashboard/audit endpoints use `requireAnyPerm([billing_view, payment_review])` (`tenant.js:75-81`, `payments.js:249,256,260,312`) rather than a single-key `requirePerm`, because the Founder's dashboard spec explicitly names both roles as independently sufficient.

---

## 13. Audit-event matrix

All events reuse the **existing** `bill_audit_log` table (`backend/src/payments/audit.js:1-20`), rather than a parallel audit table — the table's shape (`shop_id, bill_id, action, actor_id, actor_name, reason, snapshot jsonb`) already fits, since every payment-platform record is bill-scoped. The DB `CHECK` constraint on `action` was widened additively (schema-payment-platform.sql:135-146) to include these plus `BILL_VOIDED`/`BILL_CANCELLED` (bill-lifecycle actions that share the table but sit outside the "15 payment audit kinds" the module's own header documents).

| # | Action | Trigger (file:line) | Recorded snapshot fields |
|---|---|---|---|
| 1 | `BILL_CREATED` | `createBill()`, service.js:84 | `amount_due_satang`, `currency` |
| 2 | `BILL_CONFIRMED` | `confirmBill()`, service.js:101 | `number`, `amount_due_satang` |
| 3 | `PAYMENT_INTENT_CREATED` | `createIntent()`, service.js:174 | `intent_id`, `method`, `amount_satang` |
| 4 | `CASH_PAYMENT_CONFIRMED` | `cashConfirm()`, service.js:256 | `transaction_id`, `amount_satang`, `received_satang`, `change_satang`, `paid_state` |
| 5 | `STATIC_QR_DISPLAYED` | `staticQrDisplay()`, service.js:272 | `intent_id` |
| 6 | `STATIC_QR_MANUALLY_CONFIRMED` | `staticQrConfirm()`, service.js:318 | `transaction_id`, `amount_satang`, `confirmed_by`, `paid_state` |
| 7 | `PAYMENT_CONFIRMATION_REJECTED` | `processProviderWebhook()` amount/currency mismatch, service.js:399 | reason = `AMOUNT_MISMATCH`\|`CURRENCY_MISMATCH`; `intent_id`, expected/got amount+currency |
| 8 | `PAYMENT_EXPIRED` | `lazyExpireIfDue()`, service.js:186, and webhook path, service.js:376 | `intent_id` (webhook path adds `source:'provider'`) |
| 9 | `PAYMENT_CANCELLED` | `cancelIntent()`, service.js:200 **and** `reverseTransaction()`, service.js:514 | `intent_id`+`reason` (cancel) or `transaction_id`+`paid_state`+`reason:'reversal'` (reverse) — **note:** the same action name is reused for two distinct triggers |
| 10 | `RECEIPT_ISSUED` | `issueReceipt()`, service.js:436 | `receipt_id`, `transaction_id` |
| 11 | `REFUND_REQUESTED` | `requestRefund()`, service.js:457 | `refund_id`, `amount_satang`, `transaction_id` |
| 12 | `REFUND_APPROVED` | `decideRefund(approve=true)`, service.js:492 | `refund_id`, `amount_satang`, `paid_state`, `transaction_status` |
| 13 | `REFUND_REJECTED` | `decideRefund(approve=false)`, service.js:471 | `refund_id` |
| 14 | `RECONCILIATION_FLAGGED` | `flagReconciliation()`, service.js:539 | `record_id`, `status` |
| 15 | `RECONCILIATION_RESOLVED` | `resolveReconciliation()`, service.js:554 | `record_id` |

The dashboard's audit-expand endpoint (`GET /api/payments/bills/:id/audit`, `payments.js:312-325`) deliberately selects only `action, actor_name, reason, created_at` — never the `snapshot` JSONB column, so no provider payload or internal ID ever leaks through the UI (proven by test `D4`, payment-dashboard.test.js:284-302).

---

## 14. Feature-flag behavior

`backend/src/app.js:121-130`:
```js
const paymentsRouter = require('./api/payments');
api.use('/payments', (req, res, next) => {
  if (process.env.PAYMENT_PLATFORM_ENABLED !== '1') {
    return res.status(503).json({ error: 'PAYMENT_PLATFORM_DISABLED' });
  }
  return paymentsRouter(req, res, next);
});
```

- **Every route 503s while OFF**, including the unauthenticated webhook path — proven by guard test `G1` (payment-platform-guards.test.js:64-73).
- **Hidden nav.** `frontend/index.html:203` ships `<a class="nav-item hidden" id="menuPaydash" ...>` — `hidden` is a static class in the HTML source, not applied by JS at runtime. The *only* code path that removes it is `initPayDashNav()` (index.html:16303-16313) after a successful `GET /api/payments/status`; test `F1` (payment-dashboard.test.js:323-334) asserts there is exactly one such un-hide call site in the whole file.
- **Byte-identical bootstrap + menu.** Two guard tests prove the flag is invisible to every *other* surface:
  - `G2` (guards.test.js:77-97): the public menu payload (`GET /public/menu/:token`) is asserted `deepStrictEqual` between flag-off and flag-on requests.
  - `G3` (guards.test.js:99-113): `GET /api/bootstrap` is asserted `deepStrictEqual` (modulo the wall-clock `server_now` field) between flag-off and flag-on — proving the flag never leaks into the menu-management surface staff use every day, and confirming the dashboard nav-gate design decision to keep the flag *out* of `/api/bootstrap` entirely (`payments.js:251-255`).
- **No external network, even when ON.** `G4` (guards.test.js:117-135) statically scans every file in `backend/src/payments/` + `api/payments.js` for network-module `require`s, third-party HTTP clients, `fetch()` calls, and non-localhost URLs. `G5` (guards.test.js:137-165) goes further: it monkey-patches `fetch`/`http.request`/`https.request` to throw, then drives the *entire* online-order mock flow through the real service layer and asserts it still completes successfully — proving the payment platform is genuinely network-free, not just absent of `require('http')`.

---

## 15. Failure cases

| Case | Trigger | Response | Proof |
|---|---|---|---|
| Over-allocation | A confirm/refund would push net paid past `amount_due_satang` (even by 1 satang) | `409 {code:'OVER_ALLOCATION'}` — whole transaction rolled back, allocation never written | `allocations.js:85-89`; tests `C3`, `C3b` (true concurrent race — exactly one of two simultaneous confirms wins, the other 409s), `C8` |
| Amount/currency mismatch | Dynamic-QR webhook's `amount`/`currency` don't strictly match the intent's | Intent → `VERIFICATION_PENDING` (never CONFIRMED); audit `PAYMENT_CONFIRMATION_REJECTED` with reason `AMOUNT_MISMATCH`/`CURRENCY_MISMATCH` | `service.js:389-403`; tests `T16`, `T17` |
| Expiry | Any intent read/acted-on past `expires_at` | Lazily transitioned to `EXPIRED` on next touch (cash-confirm, static-qr-confirm, or an arriving webhook) — `409 {code:'INTENT_EXPIRED'}` for direct confirms; webhook path returns `outcome:'EXPIRED'` and commits the expiry instead of throwing (so the audit row survives) | `service.js:179-188` (`lazyExpireIfDue`); test `T12` |
| Invalid state transition | Any call to `assertTransition` with an illegal `from→to` | `409 {code:'INVALID_TRANSITION'}` | `state-machine.js:63-83`; test `T2b` |
| Permission denied | Caller lacks the required key(s) | `403 {code:'PERMISSION_DENIED'}`, fail-closed (no fallback to "assume allowed") | `tenant.js:63-81`; tests `T9`, `T21`, `D1` |
| Duplicate provider event replay | Same `(provider, event_id)` webhook delivered twice | DB-level `ON CONFLICT DO NOTHING` — handler logic never re-runs; response `{duplicate:true}` | `service.js:341-350`; test `T13` |
| Duplicate provider transaction | Same `(provider, provider_txn_id)` inserted twice | Postgres unique-constraint violation (`23505`) — structurally impossible to record twice | schema:284-285; test `C4` |
| Insufficient cash | `amount_received < due` | `400 {code:'CASH_RECEIVED_INSUFFICIENT'}` | `service.js:234-237`; test `T5` |
| Forged webhook signature | HMAC verification fails | `401 {code:'WEBHOOK_SIGNATURE_INVALID'}` — nothing persisted, not even the event row | `service.js:333-339`; test `T10b` |
| Cross-tenant access | Shop B requests Shop A's bill/intent | `404` (not found — tenant scoping, never a 403 that would confirm existence) | tests `T20`, `D3` |

---

## 16. Known limitations

- **Mock-only.** One registered provider adapter (`MOCK`); zero real providers, zero real credentials, zero external network anywhere in the payment code (`provider-registry.js:7-9`, guard tests `G4`/`G5`).
- **Rounding policy is temporary.** `HALF_UP` is an explicit stand-in pending a Founder decision — see §4 and §18.
- **Dashboard satang formatter is duplicated inline.** `paydashMoney()` in `frontend/index.html:16291-16297` re-implements the same exact integer division/remainder logic as `money.js#satangToDisplay`, because the dashboard is a plain inline `<script>` block, not an importable module — there is no frontend bundler/module system in this codebase to share the function. The duplication is intentional and documented at the call site; test `F7` (payment-dashboard.test.js:389-405) extracts and executes the inline function in isolation to prove it stays numerically correct.
- **Reconciliation is contracts-only.** `payment_reconciliation_records` and the `flagReconciliation`/`resolveReconciliation` service functions (service.js:520-557) are a manual flag/resolve data model — there is no automated bank-statement/settlement-file ingestion or matching engine. This is explicitly scoped as "data-model only this cycle" (schema:358-361).
- **Refund approval moves no money.** `decideRefund(approve=true)` (service.js:461-497) writes a REFUND allocation and updates transaction/bill state — it does not call any provider refund API, charge a card, or move cash. Proven by test `T19` (payment-platform.test.js:411-436), which explicitly asserts zero `stock_movements` rows change and (implicitly) no provider adapter method is invoked.
- **Legacy float fields deliberately untouched.** `bills.net_sales`, `bills.gross_sales` (float baht, populated for backward-compatible display only — `service.js:74-77`), the legacy `computeMoney()` helper in `backend/src/api/bills.js:17`, and every menu/product price column (e.g. `recipes.sell_price`, `backend/db/schema.sql:60`) stay float/NUMERIC baht forever, by design — see the schema file's source-of-truth boundary (schema-payment-platform.sql:61-70). Nothing in the payment platform reads them as authoritative.
- **Online-order mock flow doesn't link a real order.** `runOnlineOrderMockFlow()` proves the payment↔kitchen-release invariant only; wiring an actual `orders.id` onto the intent/transaction (for the dashboard's order-number column) is done by hand in the demo seeder (`seed-payment-dashboard-demo.js:156-160`), not by the mock flow itself.

---

## 17. Remaining work before a real provider

This platform already has a partial, separate legacy Omise integration in the codebase — `backend/src/omise.js` (Basic-auth wrapper over `api.omise.co`), `backend/src/api/pay.js` (S8 payment-gateway routes, per-shop `omise_secret_key`/`omise_public_key` in `shop_settings`), and a `SlipOK`-based automatic slip-verification helper (`backend/src/slipverify.js`, referenced at `pay.js:6,36`). None of this is wired to the new payment platform — it is an independent, older payment surface. This existing groundwork is the practical basis for an **Omise-first recommendation** when a real provider is chosen: Recipro already has per-shop key storage, a working Basic-auth request wrapper, and (per the code comments across `service.js`/`mock-adapter.js`) the mock adapter's shape was deliberately designed to mirror how Omise/Stripe-style gateways quote amounts in minor units — so swapping the `MOCK` adapter for a real Omise adapter is a registry addition (`provider-registry.js:7-9`), not a redesign.

Concretely, before any real provider goes live:
1. **Write a real adapter** implementing the exact interface `mock-adapter.js` already implements (`createPaymentIntent`, `generatePaymentPayload`, `getPaymentStatus`, `verifyWebhook`, `cancelPaymentIntent`, `refundPayment`, `getSettlementStatus`, `reconcileTransaction`) and register it in `provider-registry.js`.
2. **Convert at the adapter edge only.** The integer-satang boundary is already enforced at `backend/src/api/payments.js`/`service.js` — a real adapter must receive and return amounts in the provider's native minor unit (satang for THB, which conveniently *is* Omise's/most Thai gateways' native unit) and must never re-introduce a float baht multiplication anywhere in the adapter.
3. **K SHOP static QR is already structurally covered.** Static/manual bank-transfer QR (the K SHOP "static QR" style flow — display a fixed QR, manually confirm from a bank app screenshot/slip) is exactly what `STATIC_QR`/`staticQrDisplay`/`staticQrConfirm` already implement; no new state machine is needed for that class of provider, only slip-verification wiring (the existing `slipverify.js` is a candidate to attach here).
4. **Real webhook security** — HMAC verification against the provider's actual signing scheme (replacing the mock secret), plus IP/replay protections appropriate to that provider's docs.
5. **Settlement/reconciliation ingestion** — `payment_reconciliation_records` needs an actual feed (bank statement import or provider settlement API) to move beyond manual flagging.
6. **Commercial rounding policy** must be finalized before any real percentage-based discount/tax/service-charge goes live (see §18).

---

## 18. Founder decisions required

1. **Commercial rounding policy** — replace the TEMPORARY `HALF_UP` default in `money.js:16-39` with a final policy (half-up / banker's rounding / round-down) for percentage discounts, service charge, and tax splits.
2. **First real provider** — Omise (refactor/extend the existing S8 integration and per-shop key infrastructure) vs. waiting on KBank/K SHOP integration.
3. **KBank questions list** — pointer only; the specific open questions for a KBank/K SHOP integration are tracked outside this branch/document and should be attached to whichever provider decision is made in #2.
4. **Receipt-trigger default** — currently every confirmed payment method (cash, static QR, dynamic QR) auto-issues a receipt (`issueReceipt()` called from `cashConfirm`, `staticQrConfirm`, and `processProviderWebhook` — service.js:259, 321, 422). Confirm whether that should stay automatic-on-every-confirm in production, or become an explicit "issue receipt" action.
5. **Split-payment enablement default** — the schema/allocation model fully supports split/mixed/deposit payments today (§6). Decide whether that capability should be exposed to all shops by default when the platform goes live, or gated behind a separate rollout toggle.

---

## 19. Merge order if later approved

```
main
 └─▶ feat/payment-data-foundation          (PR A)
      └─▶ feat/billing-payment-state-machine (PR B)
           └─▶ feat/payment-dashboard-foundation (PR C)
```

These three branches sit **after** `main`'s current tip, which already includes PRs #41–44 (compact option editor, category-manager hotfix, and subsequent option-quantity work merged since) — no rebase conflicts are expected against those, since the payment-platform work touches no shared files besides the additive `bills`/`bill_audit_log` schema widenings and one new nav item + JS block in `frontend/index.html`.

- The migration (`schema-payment-platform.sql`) runs automatically at boot via `backend/src/migrate.js:63`, invoked by Railway's `startCommand` (`railway.json`: `node backend/src/migrate.js && node backend/src/bootstrap.js && node backend/src/index.js`) — so merging to `main` and deploying applies the schema immediately, on every restart, regardless of the flag.
- **The flag stays OFF in production** (`PAYMENT_PLATFORM_ENABLED` unset) until explicitly set to `'1'` in Railway's environment variables — merging and deploying these branches, by itself, changes nothing user-visible (§14).
- Recommended sequence: merge PR A → B → C in order (each depends on the previous), deploy with the flag still unset, confirm `G1`–`G5`/`D5` guard behavior in production (503s, hidden nav, unchanged bootstrap/menu), *then* separately decide when/whether to flip the flag per §18.

---

## 20. Rollback plan

- **Per-branch revert boundaries.** Each of the three branches is a clean, self-contained unit: `feat/payment-data-foundation` (schema + money.js only, no service/routes), `feat/billing-payment-state-machine` (adds service.js/state-machine.js/allocations.js/mock-adapter.js/api/payments.js + app.js mount), `feat/payment-dashboard-foundation` (adds only the dashboard read endpoints + frontend page). A revert of C alone removes the dashboard while leaving the core payment engine intact; reverting B+C leaves only the inert schema from A; reverting all three removes the feature entirely. Because every schema change is additive (`ADD COLUMN IF NOT EXISTS`, `CREATE TABLE IF NOT EXISTS`), no revert requires a destructive migration — the new tables/columns can simply be left in place, unused, if a code-only rollback is preferred.
- **Flag-off is the instant behavioral rollback.** Setting `PAYMENT_PLATFORM_ENABLED` back to unset (or any value other than `'1'`) in the Railway environment takes effect on the next restart and immediately 503s every route again and re-hides the nav item — no code deploy needed at all. This is the fastest rollback path and should be the first lever pulled if anything goes wrong post-enable.
- **Schema is additive-from-main, so old code is unaffected either way.** Every table this platform introduces is brand new (never existed on any live/production database — schema-payment-platform.sql:72-79); the only touch to a pre-existing live-shaped table (`bills`) is nullable/defaulted additive columns plus two widened (never narrowed) `CHECK` constraints. Legacy code paths (POS sale flow, existing `bills.js` lifecycle, menu display, reporting) never read the new columns and are provably byte-identical whether the platform code exists or not (§14, guard tests `G2`/`G3`). This means even a full revert of all three branches leaves the database in a safe, backward-compatible state, and conversely, *not* reverting (leaving the schema merged but the flag off) carries no behavioral risk to existing features.
