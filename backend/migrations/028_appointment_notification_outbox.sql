CREATE TABLE appointment_notification_outbox (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_key TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'appointment.booked', 'appointment.cancelled', 'appointment.rescheduled'
  )),
  appointment_id UUID NOT NULL REFERENCES appointments(id) ON DELETE RESTRICT,
  actor_role TEXT NOT NULL CHECK (actor_role IN ('patient', 'doctor', 'system')),
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'processed')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  lease_token UUID,
  lease_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ,
  CONSTRAINT appointment_notification_outbox_lease_state CHECK (
    (status = 'processing' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR (status <> 'processing' AND lease_token IS NULL AND lease_expires_at IS NULL)
  ),
  CONSTRAINT appointment_notification_outbox_processed_state CHECK (
    (status = 'processed' AND processed_at IS NOT NULL)
    OR (status <> 'processed' AND processed_at IS NULL)
  )
);

CREATE INDEX appointment_notification_outbox_pending_idx
  ON appointment_notification_outbox (next_attempt_at, created_at)
  WHERE status = 'pending';
CREATE INDEX appointment_notification_outbox_lease_idx
  ON appointment_notification_outbox (lease_expires_at)
  WHERE status = 'processing';
