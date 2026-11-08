CREATE TABLE in_app_notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  appointment_id UUID NOT NULL REFERENCES appointments(id) ON DELETE RESTRICT,
  event_key TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'appointment.booked', 'appointment.cancelled', 'appointment.rescheduled',
    'appointment.reminder.24h', 'appointment.reminder.1h'
  )),
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  read_at TIMESTAMPTZ,
  CONSTRAINT in_app_notifications_event_recipient_unique UNIQUE (recipient_user_id, event_key)
);

CREATE INDEX in_app_notifications_recipient_created_idx
  ON in_app_notifications (recipient_user_id, created_at DESC, id DESC);
CREATE INDEX in_app_notifications_recipient_unread_idx
  ON in_app_notifications (recipient_user_id, created_at DESC)
  WHERE read_at IS NULL;
