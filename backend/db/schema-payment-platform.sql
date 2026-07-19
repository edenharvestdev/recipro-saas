-- Payment Data Foundation (feat/payment-data-foundation, Phase 6).
-- Additive + idempotent ONLY. Does NOT drop/rename/retype anything that exists.
-- No live billing/payment usage exists yet in Recipro (menu display + menu management only) —
-- there is nothing to backfill. Every new table is inert until Phase 7 code paths (behind
-- PAYMENT_PLATFORM_ENABLED, default OFF) start writing to it.
--
-- Design carried from BILLING_PLATFORM_BLUEPRINT.md Parts B + F.
--
-- ══════════════════════════════════════════════════════════════════════════════════════════
-- FOUNDER DATA-MODEL CORRECTION (binding — supersedes the original draft of this file)
-- ══════════════════════════════════════════════════════════════════════════════════════════
-- The ORIGINAL draft of this file enforced "at most ONE CONFIRMED payment transaction per
-- bill" via a partial unique index (payment_transactions_one_confirmed_per_bill_idx, same
-- idiom as printers_default_receipt_idx). The Founder has explicitly OVERRULED that as a
-- permanent restriction: the canonical model MUST support split payment, mixed methods
-- (cash+QR on the same bill), deposit-then-balance, multiple partial payments, and a
-- reversal followed by a replacement payment.
--
-- DISPOSITION: that index is REMOVED ENTIRELY (not narrowed, not kept for any method) —
-- see the note at the bottom of the payment_transactions block below for exactly why no
-- limited variant was justified. `payment_allocations` becomes the sole authoritative
-- Bill <-> confirmed-transaction link, redesigned below from the original draft's
-- (payment_intent_id, payment_transaction_id, allocation_amount) placeholder shape into its
-- real authoritative shape: (bill_id, transaction_id, kind PAYMENT|REFUND, amount,
-- status ACTIVE|VOID, created_by). The invariant —
--   SUM(active PAYMENT allocations) - SUM(active REFUND allocations) <= bills.<amount_due>
-- — is enforced in the APPLICATION layer (backend/src/payments/allocations.js) inside the
-- same DB transaction that locks the bill row FOR UPDATE before writing an allocation
-- (identical row-locking discipline to bills.js's existing bill-row FOR UPDATE pattern).
-- `bills.paid_state` (UNPAID/PARTIALLY_PAID/PAID) is the derived/stored projection of that
-- invariant, written in the same transaction as the allocation.
--
-- Uniqueness that STAYS at the DB level (unchanged intent from the original draft, just
-- corrected/tightened where noted):
--   - unique (provider, event_id) on payment_provider_events            [already present]
--   - unique (provider, provider_txn_id) on payment_transactions        [ADDED — was missing]
--   - unique tenant/provider-scoped idempotency key (shop_id, provider, idempotency_key) on
--     payment_transactions AND payment_intents                          [CORRECTED — the
--     draft's idempotency indexes were (shop_id, idempotency_key) only, missing `provider`]
--
--  - "Confirm Bill" != "Payment Received" — Bill lifecycle and Payment lifecycle are separate
--    state machines (enforced in application code, backend/src/payments/state-machine.js).
--  - The existing `bills` table stays the Bill aggregate (per Founder correction: no live data,
--    so a parallel Order model is not needed) — we only add `payment_state`, `paid_state` and
--    `kitchen_release_eligible` to it, all nullable/defaulted so legacy rows are untouched.
--  - New normalized `bill_items` / `bill_adjustments` are additive companions used ONLY by the
--    new payment-platform bill-creation path (backend/src/payments/service.js); the legacy
--    items_json blob on `bills` is completely untouched.
--  - Idempotency backbone: `payment_provider_events` unique (provider,event_id) for webhook
--    dedupe (mirrors the delivery/printers precedent of partial-unique-index-as-guard).
--
-- ══════════════════════════════════════════════════════════════════════════════════════════
-- INTEGER SATANG MONEY MODEL (Founder-approved — supersedes any float/NUMERIC money column in
-- this file's original draft) — 1 baht = 100 satang; e.g. 385.50 THB is stored as 38550.
-- ══════════════════════════════════════════════════════════════════════════════════════════
-- Every payment-platform monetary column below is authoritative as an INTEGER (BIGINT) number
-- of satang, named with an explicit `_satang` suffix. The ONLY place baht<->satang conversion
-- happens is backend/src/payments/money.js (bahtToSatang/satangToDisplay) — every write path in
-- backend/src/payments/service.js converts exactly once, at the API boundary.
--
-- Source-of-truth boundary (do not blur this):
--   (A) LEGACY app tables/columns — bills.net_sales, bills.gross_sales, bills.discount, and
--       every menu/product price (recipes.sell_price etc.) — stay float/NUMERIC baht, UNTOUCHED,
--       forever. Nothing in this file converts them; legacy display/behavior is byte-identical.
--   (B) NEW immutable bill-item satang snapshots — bill_items.*_satang below — captured ONCE at
--       payment-platform bill-creation time via money.js, from whatever baht price the legacy
--       menu/product record held at that instant. The legacy record is never touched.
--   (C) NEW payment-platform records (payment_intents, payment_transactions, payment_allocations,
--       payment_refunds, payment_reconciliation_records, bill_adjustments, and the new
--       bills.amount_due_satang column) — satang-only, BIGINT, authoritative for this platform.
--
-- Why table definitions below are retyped in place (not merely widened): every table in this
-- file is BRAND NEW and has NEVER run against any live/production database (this whole file only
-- ships on unmerged branches — see the header above). Retyping a column that has never existed
-- outside a local dev DB carries none of the risk an in-place retype of a live table would; it is
-- exactly as safe as if the column had been typed BIGINT from the very first draft. `bills` itself
-- is a pre-existing LIVE-SHAPED table, so its satang column is added strictly ADDITIVELY
-- (ADD COLUMN IF NOT EXISTS, nullable) alongside — never replacing — the untouched legacy
-- net_sales/gross_sales/discount columns.

-- ── bills: additive columns only, both nullable/false-default so legacy + non-platform rows
--    are byte-identical to today ──
ALTER TABLE bills
  ADD COLUMN IF NOT EXISTS payment_state             TEXT DEFAULT NULL,   -- NULL = legacy/no platform
  ADD COLUMN IF NOT EXISTS paid_state                TEXT NOT NULL DEFAULT 'UNPAID',
  ADD COLUMN IF NOT EXISTS kitchen_release_eligible   BOOLEAN NOT NULL DEFAULT false,
  -- Authoritative amount-due for PAYMENT-PLATFORM bills only (payment_state IS NOT NULL), in
  -- satang. NULL for legacy bills (payment_state IS NULL) — legacy code never reads this column.
  -- This is a NEW, additive column; bills.net_sales/gross_sales (legacy, float, untouched) keep
  -- being written by service.js purely for backward-compatible display/reporting, but are no
  -- longer the source of truth for the payment invariant — amount_due_satang is.
  ADD COLUMN IF NOT EXISTS amount_due_satang          BIGINT DEFAULT NULL;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_bills_amount_due_satang_nonneg'
  ) THEN
    ALTER TABLE bills ADD CONSTRAINT chk_bills_amount_due_satang_nonneg
      CHECK (amount_due_satang IS NULL OR amount_due_satang >= 0);
  END IF;
END $$;

-- Widen the existing lifecycle_status CHECK to also allow CANCELLED (the payment-platform's own
-- simplified Bill machine: DRAFT -> CONFIRMED -> (VOIDED | CANCELLED)). Widening only — every
-- value already allowed stays allowed; no existing row can violate the new constraint.
DO $$ BEGIN
  ALTER TABLE bills DROP CONSTRAINT IF EXISTS chk_bills_lifecycle_status;
  ALTER TABLE bills ADD CONSTRAINT chk_bills_lifecycle_status
    CHECK (lifecycle_status IS NULL OR lifecycle_status IN
      ('DRAFT','CONFIRMED','CORRECTION_PENDING','VOIDED','REPLACED','CANCELLED'));
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_bills_payment_state'
  ) THEN
    ALTER TABLE bills ADD CONSTRAINT chk_bills_payment_state
      CHECK (payment_state IS NULL OR payment_state IN ('AWAITING_PAYMENT','PAID'));
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_bills_paid_state'
  ) THEN
    ALTER TABLE bills ADD CONSTRAINT chk_bills_paid_state
      CHECK (paid_state IN ('UNPAID','PARTIALLY_PAID','PAID'));
  END IF;
END $$;

-- ── bill_audit_log: widen the existing action CHECK (schema-delivery-mvp.sql:328-330) to also
--    allow the payment-platform's audit kinds. Widening only — every value already allowed stays
--    allowed. This lets backend/src/payments/audit.js reuse the EXISTING bill_audit_log table
--    ("existing logs table pattern") rather than inventing a parallel audit table. ──
DO $$ BEGIN
  ALTER TABLE bill_audit_log DROP CONSTRAINT IF EXISTS bill_audit_log_action_check;
  ALTER TABLE bill_audit_log ADD CONSTRAINT bill_audit_log_action_check
    CHECK (action IN (
      'created','confirmed','voided','corrected','settled','locked','receipt_issued',
      'BILL_CREATED','BILL_CONFIRMED','BILL_VOIDED','BILL_CANCELLED',
      'PAYMENT_INTENT_CREATED','CASH_PAYMENT_CONFIRMED','STATIC_QR_DISPLAYED',
      'STATIC_QR_MANUALLY_CONFIRMED','PAYMENT_CONFIRMATION_REJECTED','PAYMENT_EXPIRED',
      'PAYMENT_CANCELLED','RECEIPT_ISSUED','REFUND_REQUESTED','REFUND_APPROVED','REFUND_REJECTED',
      'RECONCILIATION_FLAGGED','RECONCILIATION_RESOLVED'
    ));
END $$;

-- ── bill_items — normalized lines for bills created through the NEW payment-platform path only.
--    Legacy bills (items_json) never get rows here. ──
-- Money columns are satang BIGINT (immutable snapshot at bill-creation time, converted ONCE from
-- the legacy menu/product baht price via backend/src/payments/money.js — see the satang-model
-- header note above). `qty` stays NUMERIC — it is a quantity, not a monetary amount.
CREATE TABLE IF NOT EXISTS bill_items (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id               UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  bill_id               UUID NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
  ref_type              TEXT CHECK (ref_type IN ('recipe','material')),
  ref_id                UUID,
  name_snapshot         TEXT NOT NULL,
  qty                   NUMERIC NOT NULL DEFAULT 1,
  unit_price_satang     BIGINT NOT NULL DEFAULT 0 CHECK (unit_price_satang >= 0),
  line_gross_satang     BIGINT NOT NULL DEFAULT 0 CHECK (line_gross_satang >= 0),
  line_discount_satang  BIGINT NOT NULL DEFAULT 0 CHECK (line_discount_satang >= 0),
  line_net_satang       BIGINT NOT NULL DEFAULT 0 CHECK (line_net_satang >= 0),   -- "subtotal" for the line
  chosen_options        JSONB DEFAULT '[]',
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bill_items_bill_idx ON bill_items (bill_id);
CREATE INDEX IF NOT EXISTS bill_items_shop_idx ON bill_items (shop_id);

-- ── bill_adjustments — bill-level discounts/charges for the new path (additive to bill_discount
--    already present on `bills` from schema-bill-correction.sql) ──
CREATE TABLE IF NOT EXISTS bill_adjustments (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id         UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  bill_id         UUID NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
  adjustment_type TEXT NOT NULL DEFAULT 'DISCOUNT' CHECK (adjustment_type IN ('DISCOUNT','SERVICE_CHARGE','TAX','OTHER')),
  amount_satang   BIGINT NOT NULL DEFAULT 0 CHECK (amount_satang >= 0),
  reason          TEXT,
  created_by      UUID REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bill_adjustments_bill_idx ON bill_adjustments (bill_id);
CREATE INDEX IF NOT EXISTS bill_adjustments_shop_idx ON bill_adjustments (shop_id);

-- ── payment_provider_events — raw inbound event log, the dedupe backbone for ALL provider
--    callbacks (webhook or mock). Zero handler logic re-runs for a duplicate — the unique index
--    makes a replay an O(1) no-op at the DB layer. ──
CREATE TABLE IF NOT EXISTS payment_provider_events (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id          UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  provider         TEXT NOT NULL DEFAULT 'MOCK',
  event_id         TEXT NOT NULL,
  signature_valid  BOOLEAN NOT NULL DEFAULT false,
  payload          JSONB,
  processed_at     TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, event_id)
);
CREATE INDEX IF NOT EXISTS payment_provider_events_shop_idx ON payment_provider_events (shop_id);

-- ── payment_intents — one attempt-context (method, amount, reference, expiry). A retry after
--    FAILED/EXPIRED/CANCELLED is a NEW intent row, never a mutation of the old one. Split/partial
--    payment means a single bill legitimately accumulates MANY intents over its life (one per
--    payment attempt/method/tranche) — this table's cardinality was never 1:1 with the bill, only
--    payment_transactions' old "one CONFIRMED" rule was (now removed, see header note). ──
CREATE TABLE IF NOT EXISTS payment_intents (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id             UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  bill_id             UUID NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
  order_id            UUID REFERENCES orders(id) ON DELETE SET NULL,
  method              TEXT NOT NULL CHECK (method IN ('CASH','STATIC_QR','DYNAMIC_QR')),
  provider            TEXT NOT NULL DEFAULT 'NONE' CHECK (provider IN ('NONE','MOCK')),
  status              TEXT NOT NULL DEFAULT 'CREATED'
                      CHECK (status IN ('CREATED','AWAITING_PAYMENT','QR_DISPLAYED','AWAITING_MANUAL_CONFIRMATION',
                                         'INITIATED','VERIFICATION_PENDING',
                                         'CONFIRMED','FAILED','EXPIRED','CANCELLED')),
  amount_due_satang   BIGINT NOT NULL CHECK (amount_due_satang > 0),
  currency            TEXT NOT NULL DEFAULT 'THB',
  merchant_reference  TEXT NOT NULL,
  provider_ref        TEXT,
  idempotency_key     TEXT,
  expires_at          TIMESTAMPTZ,
  created_by          UUID REFERENCES users(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  cancelled_at        TIMESTAMPTZ,
  cancel_reason       TEXT
);
CREATE INDEX IF NOT EXISTS payment_intents_bill_idx ON payment_intents (bill_id);
CREATE INDEX IF NOT EXISTS payment_intents_shop_idx ON payment_intents (shop_id, created_at DESC);
-- A double-tapped "create intent" with the same idempotency key returns the same intent, scoped
-- per shop AND per provider (corrected from the draft, which omitted `provider`).
CREATE UNIQUE INDEX IF NOT EXISTS payment_intents_idem_idx
  ON payment_intents (shop_id, provider, idempotency_key) WHERE idempotency_key IS NOT NULL;

-- ── payment_transactions — the outcome record of an intent that reached a terminal/confirmed
--    state. Cardinality: a bill may have MANY CONFIRMED transactions over its life (split/mixed
--    payment, deposit+balance, reversal+replacement) — see header note. Every CONFIRMED
--    transaction must have a corresponding ACTIVE payment_allocations row (written in the same
--    transaction, backend/src/payments/allocations.js) for it to count toward the bill's paid
--    total; the allocation is the authoritative link, this table is the outcome-of-attempt
--    record. ──
CREATE TABLE IF NOT EXISTS payment_transactions (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id               UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  bill_id               UUID NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
  order_id              UUID REFERENCES orders(id) ON DELETE SET NULL,
  intent_id             UUID REFERENCES payment_intents(id) ON DELETE SET NULL,
  method                TEXT NOT NULL CHECK (method IN ('CASH','STATIC_QR','DYNAMIC_QR')),
  provider              TEXT NOT NULL DEFAULT 'NONE' CHECK (provider IN ('NONE','MOCK')),
  expected_amount_satang BIGINT NOT NULL CHECK (expected_amount_satang > 0),
  paid_amount_satang    BIGINT CHECK (paid_amount_satang IS NULL OR paid_amount_satang >= 0),
  currency              TEXT NOT NULL DEFAULT 'THB',
  status                TEXT NOT NULL DEFAULT 'RECEIVED'
                        CHECK (status IN ('RECEIVED','VERIFYING','CONFIRMED','FAILED',
                                           'REVERSED','PARTIALLY_REFUNDED','REFUNDED')),
  provider_txn_id       TEXT,
  merchant_ref          TEXT,
  idempotency_key       TEXT,
  initiated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  confirmed_at          TIMESTAMPTZ,
  confirmed_by          TEXT,                 -- user id (text form) OR 'webhook:<provider>' OR 'poll:<provider>' — NEVER null once confirmed
  raw_event_ref         UUID REFERENCES payment_provider_events(id) ON DELETE SET NULL,
  reconciliation_status TEXT DEFAULT NULL CHECK (reconciliation_status IS NULL OR reconciliation_status IN
                        ('MATCHED','AMOUNT_MISMATCH','MISSING_IN_PROVIDER','MISSING_IN_SYSTEM','DUPLICATE',
                         'SETTLEMENT_PENDING','RECONCILED')),
  refund_total_satang   BIGINT NOT NULL DEFAULT 0 CHECK (refund_total_satang >= 0),
  provider_verified     BOOLEAN NOT NULL DEFAULT false,   -- true only for adapter-verified (dynamic QR); false for cash/static-QR manual confirms
  cashier_id            UUID REFERENCES users(id),
  terminal_id           TEXT,
  amount_received_satang BIGINT CHECK (amount_received_satang IS NULL OR amount_received_satang >= 0),  -- CASH only
  change_amount_satang  BIGINT CHECK (change_amount_satang IS NULL OR change_amount_satang >= 0),        -- CASH only
  slip_ref              TEXT,                  -- STATIC_QR optional slip attachment reference
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS payment_transactions_bill_idx ON payment_transactions (bill_id);
CREATE INDEX IF NOT EXISTS payment_transactions_shop_idx ON payment_transactions (shop_id, created_at DESC);
-- Tenant/provider-scoped idempotency (corrected from the draft — was missing `provider`).
CREATE UNIQUE INDEX IF NOT EXISTS payment_transactions_idem_idx
  ON payment_transactions (shop_id, provider, idempotency_key) WHERE idempotency_key IS NOT NULL;
-- Duplicate-transaction guard: the SAME provider transaction can never be recorded twice
-- (ADDED — the original draft had no uniqueness on provider_txn_id at all).
CREATE UNIQUE INDEX IF NOT EXISTS payment_transactions_provider_txn_idx
  ON payment_transactions (provider, provider_txn_id) WHERE provider_txn_id IS NOT NULL;
--
-- REMOVED (Founder correction — do not reintroduce): the original draft had
--   CREATE UNIQUE INDEX payment_transactions_one_confirmed_per_bill_idx
--     ON payment_transactions (bill_id) WHERE status = 'CONFIRMED';
-- enforcing "at most one CONFIRMED transaction per bill" at the DB layer. The Founder
-- explicitly overruled this as a PERMANENT restriction: split payment, mixed methods
-- (cash+QR on one bill), deposit-then-balance, multiple partial payments, and
-- reversal-then-replacement all require MULTIPLE CONFIRMED transactions against the same
-- bill_id to be simultaneously valid. No limited variant (e.g. "only for methods that
-- prohibit split") was justified: every method in this platform (CASH, STATIC_QR,
-- DYNAMIC_QR) is a legitimate participant in a mixed/split payment per the Founder's
-- explicit example ("cash+QR"), so there is no method-scoped subset left to restrict.
-- The invariant that actually matters — total money collected never exceeds the bill's
-- amount_due — is enforced by payment_allocations + the application-layer check in
-- backend/src/payments/allocations.js, which is the correct place for it because it must
-- reason about NET (payments minus refunds), not merely count CONFIRMED rows.

-- ── payment_allocations — THE AUTHORITATIVE Bill <-> confirmed-transaction link (Founder
--    correction; redesigned from the original draft's placeholder shape). Every confirmed
--    payment writes exactly one ACTIVE PAYMENT allocation; every approved refund writes exactly
--    one ACTIVE REFUND allocation. status=VOID exists so an allocation can be superseded without
--    ever deleting history (mirrors the reversal-linkage doctrine in bill_stock_movements —
--    schema-bill-correction.sql). Invariant enforced in backend/src/payments/allocations.js,
--    inside the same transaction that locks the bill row FOR UPDATE (all in satang, integer,
--    NO epsilon — see backend/src/payments/allocations.js):
--      SUM(allocated_amount_satang WHERE kind='PAYMENT' AND status='ACTIVE')
--        - SUM(allocated_amount_satang WHERE kind='REFUND' AND status='ACTIVE')
--        <=  bills.amount_due_satang
--    bills.paid_state (UNPAID/PARTIALLY_PAID/PAID) is the stored projection of that same sum,
--    written atomically alongside the allocation. ──
CREATE TABLE IF NOT EXISTS payment_allocations (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id                 UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  bill_id                 UUID NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
  -- NO ACTION (not RESTRICT) deliberately: both are "cannot delete a transaction that still has
  -- allocations", but RESTRICT checks IMMEDIATELY and would abort a legitimate multi-path
  -- cascade (deleting a shop cascades bills -> transactions AND allocations in one statement);
  -- NO ACTION defers the check to end-of-statement, by which point the cascade has removed the
  -- allocation rows too. Protection against orphaning in ordinary statements is identical.
  transaction_id          UUID NOT NULL REFERENCES payment_transactions(id),
  kind                    TEXT NOT NULL CHECK (kind IN ('PAYMENT','REFUND')),
  allocated_amount_satang BIGINT NOT NULL CHECK (allocated_amount_satang > 0),
  status                  TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','VOID')),
  created_by              UUID REFERENCES users(id),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS payment_allocations_bill_idx ON payment_allocations (bill_id);
CREATE INDEX IF NOT EXISTS payment_allocations_shop_idx ON payment_allocations (shop_id);
CREATE INDEX IF NOT EXISTS payment_allocations_txn_idx ON payment_allocations (transaction_id);
-- Hot-path performance (Part C.3): the invariant check + paid_state derivation sums only
-- ACTIVE rows per bill on every allocation write.
CREATE INDEX IF NOT EXISTS payment_allocations_bill_active_idx ON payment_allocations (bill_id) WHERE status = 'ACTIVE';

-- ── payment_refunds — model only, NO execution. APPROVED creates a REFUND payment_allocations
--    row (reduces net paid) but never moves money or stock — clearly marked. ──
CREATE TABLE IF NOT EXISTS payment_refunds (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id                 UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  payment_transaction_id  UUID NOT NULL REFERENCES payment_transactions(id) ON DELETE CASCADE,
  status                  TEXT NOT NULL DEFAULT 'REQUESTED' CHECK (status IN ('REQUESTED','APPROVED','REJECTED')),
  refunded_amount_satang  BIGINT NOT NULL CHECK (refunded_amount_satang > 0),
  reason                  TEXT,
  requested_by            UUID REFERENCES users(id),
  approved_by             UUID REFERENCES users(id),
  requested_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at              TIMESTAMPTZ,
  allocation_id           UUID REFERENCES payment_allocations(id) ON DELETE SET NULL,   -- set once APPROVED
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS payment_refunds_txn_idx ON payment_refunds (payment_transaction_id);
CREATE INDEX IF NOT EXISTS payment_refunds_shop_idx ON payment_refunds (shop_id);

-- ── payment_reconciliation_records — F.13 contract, data-model only this cycle. Flags/records
--    match status between system transactions and provider/bank statements. The three amount
--    columns are all satang, all nullable (a flag can be raised before any of the three sides is
--    known — e.g. MISSING_IN_PROVIDER has no provider_amount_satang yet). ──
CREATE TABLE IF NOT EXISTS payment_reconciliation_records (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id                 UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  payment_transaction_id  UUID REFERENCES payment_transactions(id) ON DELETE CASCADE,
  status                  TEXT NOT NULL CHECK (status IN ('MATCHED','AMOUNT_MISMATCH','MISSING_IN_PROVIDER',
                                                           'MISSING_IN_SYSTEM','DUPLICATE','SETTLEMENT_PENDING','RECONCILED')),
  expected_amount_satang   BIGINT CHECK (expected_amount_satang IS NULL OR expected_amount_satang >= 0),   -- system's own transaction amount
  provider_amount_satang   BIGINT CHECK (provider_amount_satang IS NULL OR provider_amount_satang >= 0),   -- what the provider/bank statement reported
  settlement_amount_satang BIGINT CHECK (settlement_amount_satang IS NULL OR settlement_amount_satang >= 0), -- actually settled/received amount
  notes                   TEXT,
  flagged_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at             TIMESTAMPTZ,
  resolved_by             UUID REFERENCES users(id),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS payment_reconciliation_txn_idx ON payment_reconciliation_records (payment_transaction_id);
CREATE INDEX IF NOT EXISTS payment_reconciliation_shop_idx ON payment_reconciliation_records (shop_id);

-- ── receipts — projection-on-demand of a confirmed payment (B.7). Multiple renders (abbreviated/
--    full/tax invoice) may exist per bill; none is "the" mutable receipt. Multiple receipts per
--    bill are now also expected simply because multiple confirmed transactions can exist
--    (one receipt per confirming payment event, per F.11). ──
CREATE TABLE IF NOT EXISTS receipts (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id                 UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  bill_id                 UUID NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
  payment_transaction_id  UUID REFERENCES payment_transactions(id) ON DELETE SET NULL,
  receipt_no              TEXT,
  receipt_type            TEXT NOT NULL DEFAULT 'ABBREVIATED' CHECK (receipt_type IN ('ABBREVIATED','FULL','TAX_INVOICE')),
  status                  TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','ISSUED','VOIDED')),
  buyer_name              TEXT,
  buyer_taxid             TEXT,
  buyer_address           TEXT,
  issued_at               TIMESTAMPTZ,
  issued_by               UUID REFERENCES users(id),
  voided_at               TIMESTAMPTZ,
  voided_by               UUID REFERENCES users(id),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS receipts_bill_idx ON receipts (bill_id);
CREATE INDEX IF NOT EXISTS receipts_shop_idx ON receipts (shop_id);
