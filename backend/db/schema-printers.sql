-- POS printer registry (feat/pos-printer-setup-p1). Additive + idempotent. No destructive DDL.
-- The registry stores printer CONFIG only (name, capability, purpose, paper, copies, defaults, last
-- test). Actual printing stays client-side (browser/system dialog now; native SUNMI/bridge later).
-- BROWSER_SYSTEM printers store NO hardware identifiers — a "test" means the print dialog opened,
-- NOT that paper physically printed. Status wording is exact to avoid false hardware claims.

CREATE TABLE IF NOT EXISTS printers (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id            UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  name               TEXT NOT NULL,
  capability_type    TEXT NOT NULL DEFAULT 'BROWSER_SYSTEM'
                     CHECK (capability_type IN ('BROWSER_SYSTEM','SUNMI_NATIVE','LOCAL_BRIDGE','LAN_ESC_POS','USB_ESC_POS','BLUETOOTH_ESC_POS')),
  connection_type    TEXT,                         -- free-text detail (e.g. 'system-dialog'); no secrets
  purpose            TEXT NOT NULL DEFAULT 'RECEIPT' CHECK (purpose IN ('RECEIPT','KITCHEN','BOTH')),
  paper_width        INTEGER NOT NULL DEFAULT 80 CHECK (paper_width IN (58, 80)),
  copies             INTEGER NOT NULL DEFAULT 1,
  is_default_receipt BOOLEAN NOT NULL DEFAULT false,
  is_default_kitchen BOOLEAN NOT NULL DEFAULT false,
  status             TEXT NOT NULL DEFAULT 'NOT_CONFIGURED'
                     CHECK (status IN ('AVAILABLE','NOT_CONFIGURED','BRIDGE_NOT_AVAILABLE','UNSUPPORTED','CONNECTION_FAILED')),
  last_test_at       TIMESTAMPTZ,
  last_test_status   TEXT,                         -- e.g. 'PRINT_DIALOG_OPENED', 'PRINTER_BRIDGE_NOT_AVAILABLE'
  last_test_error    TEXT,
  configured_by      UUID REFERENCES users(id),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS printers_shop_idx ON printers (shop_id);
-- At most ONE default receipt / kitchen printer per shop (partial unique indexes).
CREATE UNIQUE INDEX IF NOT EXISTS printers_default_receipt_idx ON printers (shop_id) WHERE is_default_receipt = true;
CREATE UNIQUE INDEX IF NOT EXISTS printers_default_kitchen_idx ON printers (shop_id) WHERE is_default_kitchen = true;
