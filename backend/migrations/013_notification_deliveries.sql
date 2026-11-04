CREATE TABLE notification_deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_key TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'appointment.booked',
    'appointment.cancelled',
    'appointment.rescheduled'
  )),
  appointment_id UUID NOT NULL REFERENCES appointments(id) ON DELETE RESTRICT,
  recipient_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  channel TEXT NOT NULL DEFAULT 'email' CHECK (channel = 'email'),
  provider TEXT NOT NULL DEFAULT 'brevo' CHECK (provider = 'brevo'),
  status TEXT NOT NULL DEFAULT 'processing' CHECK (status IN ('processing', 'accepted', 'failed', 'skipped')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  provider_message_id TEXT,
  reason TEXT CHECK (reason IN (
    'timeout', 'network_error', 'provider_error', 'unexpected_error',
    'missing_configuration', 'missing_recipient'
  )),
  provider_http_status INTEGER CHECK (provider_http_status BETWEEN 100 AND 599),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_attempt_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  CONSTRAINT notification_deliveries_final_state CHECK (
    (status = 'processing' AND completed_at IS NULL)
    OR (status IN ('accepted', 'failed', 'skipped') AND completed_at IS NOT NULL)
  ),
  CONSTRAINT notification_deliveries_accepted_fields CHECK (
    status <> 'accepted' OR reason IS NULL
  ),
  CONSTRAINT notification_deliveries_outcome_reason CHECK (
    (status IN ('processing', 'accepted') AND reason IS NULL)
    OR (status IN ('failed', 'skipped') AND reason IS NOT NULL)
  )
);

CREATE INDEX notification_deliveries_appointment_created_idx
  ON notification_deliveries (appointment_id, created_at DESC);

CREATE INDEX notification_deliveries_status_created_idx
  ON notification_deliveries (status, created_at)
  WHERE status IN ('processing', 'failed');
