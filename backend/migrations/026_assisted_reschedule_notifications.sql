ALTER TABLE notification_deliveries
  DROP CONSTRAINT notification_deliveries_event_type_check,
  ADD CONSTRAINT notification_deliveries_event_type_check CHECK (event_type IN (
    'appointment.booked', 'appointment.cancelled', 'appointment.rescheduled',
    'appointment.reminder_24h', 'appointment.reminder_1h',
    'appointment.assisted_reschedule_requested'
  ));

ALTER TABLE in_app_notifications
  DROP CONSTRAINT in_app_notifications_event_type_check,
  ADD CONSTRAINT in_app_notifications_event_type_check CHECK (event_type IN (
    'appointment.booked', 'appointment.cancelled', 'appointment.rescheduled',
    'appointment.reminder.24h', 'appointment.reminder.1h',
    'appointment.assisted_reschedule_requested'
  ));

ALTER TABLE assisted_reschedule_requests
  ADD COLUMN notification_attempt_count INTEGER NOT NULL DEFAULT 0
    CHECK (notification_attempt_count >= 0),
  ADD COLUMN notification_next_attempt_at TIMESTAMPTZ,
  ADD COLUMN notification_lease_token UUID,
  ADD COLUMN notification_lease_expires_at TIMESTAMPTZ,
  ADD CONSTRAINT assisted_reschedule_requests_notification_lease_state CHECK (
    (notification_status = 'processing'
      AND notification_lease_token IS NOT NULL
      AND notification_lease_expires_at IS NOT NULL)
    OR (notification_status <> 'processing'
      AND notification_lease_token IS NULL
      AND notification_lease_expires_at IS NULL)
  );

CREATE INDEX assisted_reschedule_requests_notification_retry_idx
  ON assisted_reschedule_requests (notification_next_attempt_at, created_at)
  WHERE notification_status IN ('pending', 'failed', 'processing');
