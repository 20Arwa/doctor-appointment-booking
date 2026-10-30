CREATE TABLE payment_capture_reconciliation (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id UUID NOT NULL REFERENCES payments(id) ON DELETE RESTRICT,
  provider TEXT NOT NULL CHECK (length(btrim(provider)) > 0),
  provider_order_id TEXT NOT NULL CHECK (length(btrim(provider_order_id)) > 0),
  provider_payment_id TEXT NOT NULL CHECK (length(btrim(provider_payment_id)) > 0),
  amount NUMERIC(10, 2) NOT NULL CHECK (amount > 0),
  currency CHAR(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  provider_event_id TEXT,
  reason TEXT NOT NULL
    CHECK (reason IN ('additional_capture', 'slot_unavailable')),
  status TEXT NOT NULL DEFAULT 'unresolved'
    CHECK (status IN ('unresolved', 'resolved')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ,
  CONSTRAINT payment_capture_reconciliation_resolution_time CHECK
    ((status = 'resolved' AND resolved_at IS NOT NULL) OR
     (status = 'unresolved' AND resolved_at IS NULL))
);

CREATE UNIQUE INDEX payment_capture_reconciliation_provider_payment_unique
  ON payment_capture_reconciliation (provider, provider_payment_id);
CREATE INDEX payment_capture_reconciliation_unresolved_idx
  ON payment_capture_reconciliation (created_at)
  WHERE status = 'unresolved';
