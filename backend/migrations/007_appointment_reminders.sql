CREATE TABLE appointment_reminder_deliveries (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  appointment_id UUID NOT NULL REFERENCES appointments(id) ON DELETE RESTRICT,
  reminder_type TEXT NOT NULL CHECK (reminder_type IN ('24h', '1h')),
  scheduled_date DATE NOT NULL,
  scheduled_start_time TIME NOT NULL,
  status TEXT NOT NULL DEFAULT 'processing' CHECK (status IN ('processing', 'sent')),
  lease_expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '10 minutes'),
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT appointment_reminders_unique_schedule UNIQUE
    (appointment_id, reminder_type, scheduled_date, scheduled_start_time),
  CONSTRAINT appointment_reminders_sent_timestamp CHECK
    ((status = 'sent' AND sent_at IS NOT NULL) OR (status = 'processing' AND sent_at IS NULL))
);

CREATE INDEX appointment_reminders_lease_idx
  ON appointment_reminder_deliveries (lease_expires_at)
  WHERE status = 'processing';
