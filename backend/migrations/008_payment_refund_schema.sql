CREATE TABLE appointment_slot_holds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  availability_id UUID NOT NULL REFERENCES availability(id) ON DELETE RESTRICT,
  patient_id UUID NOT NULL REFERENCES patients(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'released', 'consumed', 'expired')),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '10 minutes'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT appointment_slot_hold_expiry_after_creation CHECK (expires_at > created_at)
);

COMMENT ON COLUMN appointment_slot_holds.expires_at IS
  'Recommended checkout hold duration is 10 minutes; expiry handling must release the active hold before a retry.';

CREATE UNIQUE INDEX appointment_slot_holds_one_active_per_slot
  ON appointment_slot_holds (availability_id)
  WHERE status = 'active';
CREATE INDEX appointment_slot_holds_expiry_idx
  ON appointment_slot_holds (expires_at)
  WHERE status = 'active';
CREATE INDEX appointment_slot_holds_patient_idx
  ON appointment_slot_holds (patient_id, created_at DESC);

CREATE TABLE payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  appointment_id UUID REFERENCES appointments(id) ON DELETE RESTRICT,
  slot_hold_id UUID REFERENCES appointment_slot_holds(id) ON DELETE RESTRICT,
  provider TEXT NOT NULL CHECK (length(btrim(provider)) > 0),
  amount NUMERIC(10, 2) NOT NULL CHECK (amount > 0),
  currency CHAR(3) NOT NULL DEFAULT 'INR'
    CHECK (currency ~ '^[A-Z]{3}$'),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('created', 'pending', 'authorized', 'captured', 'failed', 'cancelled', 'expired', 'partially_refunded', 'refunded')),
  provider_order_id TEXT,
  provider_transaction_id TEXT,
  provider_payment_id TEXT,
  idempotency_key TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  captured_at TIMESTAMPTZ,
  failed_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  expired_at TIMESTAMPTZ,
  CONSTRAINT payments_captured_timestamp_required CHECK
    (status NOT IN ('captured', 'partially_refunded', 'refunded') OR captured_at IS NOT NULL),
  CONSTRAINT payments_failed_timestamp_required CHECK
    (status <> 'failed' OR failed_at IS NOT NULL),
  CONSTRAINT payments_cancelled_timestamp_required CHECK
    (status <> 'cancelled' OR cancelled_at IS NOT NULL),
  CONSTRAINT payments_expired_timestamp_required CHECK
    (status <> 'expired' OR expired_at IS NOT NULL),
  CONSTRAINT payments_appointment_or_hold_required CHECK
    ((appointment_id IS NOT NULL AND slot_hold_id IS NULL) OR
     (appointment_id IS NULL AND slot_hold_id IS NOT NULL))
);

CREATE UNIQUE INDEX payments_provider_order_unique
  ON payments (provider, provider_order_id)
  WHERE provider_order_id IS NOT NULL;
CREATE UNIQUE INDEX payments_provider_payment_unique
  ON payments (provider, provider_payment_id)
  WHERE provider_payment_id IS NOT NULL;
CREATE UNIQUE INDEX payments_provider_transaction_unique
  ON payments (provider, provider_transaction_id)
  WHERE provider_transaction_id IS NOT NULL;
CREATE UNIQUE INDEX payments_provider_idempotency_unique
  ON payments (provider, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX payments_one_open_or_captured_per_appointment
  ON payments (appointment_id)
  WHERE appointment_id IS NOT NULL
    AND status IN ('created', 'pending', 'authorized', 'captured', 'partially_refunded', 'refunded');
CREATE UNIQUE INDEX payments_one_open_or_captured_per_hold
  ON payments (slot_hold_id)
  WHERE slot_hold_id IS NOT NULL
    AND status IN ('created', 'pending', 'authorized', 'captured', 'partially_refunded', 'refunded');
CREATE INDEX payments_appointment_created_idx
  ON payments (appointment_id, created_at DESC)
  WHERE appointment_id IS NOT NULL;
CREATE INDEX payments_hold_created_idx
  ON payments (slot_hold_id, created_at DESC)
  WHERE slot_hold_id IS NOT NULL;
CREATE INDEX payments_status_created_idx ON payments (status, created_at);

CREATE TABLE refunds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id UUID NOT NULL REFERENCES payments(id) ON DELETE RESTRICT,
  provider TEXT NOT NULL CHECK (length(btrim(provider)) > 0),
  amount NUMERIC(10, 2) NOT NULL CHECK (amount > 0),
  currency CHAR(3) NOT NULL DEFAULT 'INR'
    CHECK (currency ~ '^[A-Z]{3}$'),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processed', 'failed', 'cancelled')),
  reason TEXT,
  provider_refund_id TEXT,
  idempotency_key TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX refunds_provider_reference_unique
  ON refunds (provider, provider_refund_id)
  WHERE provider_refund_id IS NOT NULL;
CREATE UNIQUE INDEX refunds_provider_idempotency_unique
  ON refunds (provider, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX refunds_payment_created_idx ON refunds (payment_id, created_at DESC);
CREATE INDEX refunds_status_created_idx ON refunds (status, created_at);

CREATE FUNCTION enforce_refund_amount_within_payment() RETURNS trigger AS $$
DECLARE
  payment_amount NUMERIC(10, 2);
  payment_currency CHAR(3);
  payment_status TEXT;
  payment_provider TEXT;
  existing_refunds NUMERIC(10, 2);
BEGIN
  -- A write lock creates a new row version so stricter isolation levels fail closed
  -- instead of checking a stale refund total after waiting for another refund.
  UPDATE payments
    SET updated_at = NOW()
    WHERE id = NEW.payment_id
    RETURNING amount, currency, status, provider
    INTO payment_amount, payment_currency, payment_status, payment_provider
    ;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Payment % does not exist', NEW.payment_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF payment_status NOT IN ('captured', 'partially_refunded') THEN
    RAISE EXCEPTION 'Refunds require a captured payment'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.currency <> payment_currency THEN
    RAISE EXCEPTION 'Refund currency must match payment currency'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.provider <> payment_provider THEN
    RAISE EXCEPTION 'Refund provider must match payment provider'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT COALESCE(SUM(amount), 0)
    INTO existing_refunds
    FROM refunds
    WHERE payment_id = NEW.payment_id
      AND status IN ('pending', 'processed')
      AND id <> NEW.id;

  -- IF existing_refunds + CASE WHEN NEW.status IN ('pending', 'processed') THEN NEW.amount ELSE 0 END > payment_amount THEN
  IF (
  NEW.status IN ('pending', 'processed')
  AND existing_refunds + NEW.amount > payment_amount
) OR (
  NEW.status NOT IN ('pending', 'processed')
  AND existing_refunds > payment_amount
) THEN
    RAISE EXCEPTION 'Total pending and processed refunds cannot exceed the payment amount'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER refunds_amount_within_payment
  BEFORE INSERT OR UPDATE ON refunds
  FOR EACH ROW EXECUTE FUNCTION enforce_refund_amount_within_payment();

CREATE TABLE payment_provider_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider TEXT NOT NULL CHECK (length(btrim(provider)) > 0),
  provider_event_id TEXT NOT NULL CHECK (length(btrim(provider_event_id)) > 0),
  event_type TEXT NOT NULL CHECK (length(btrim(event_type)) > 0),
  payment_id UUID REFERENCES payments(id) ON DELETE RESTRICT,
  refund_id UUID REFERENCES refunds(id) ON DELETE RESTRICT,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ,
  CONSTRAINT payment_provider_event_target CHECK
    ((payment_id IS NOT NULL AND refund_id IS NULL) OR
     (payment_id IS NULL AND refund_id IS NOT NULL)),
  CONSTRAINT payment_provider_event_unique UNIQUE (provider, provider_event_id)
);

CREATE INDEX payment_provider_events_payment_idx
  ON payment_provider_events (payment_id, received_at DESC)
  WHERE payment_id IS NOT NULL;
CREATE INDEX payment_provider_events_refund_idx
  ON payment_provider_events (refund_id, received_at DESC)
  WHERE refund_id IS NOT NULL;
CREATE INDEX payment_provider_events_unprocessed_idx
  ON payment_provider_events (received_at)
  WHERE processed_at IS NULL;
