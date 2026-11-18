ALTER TABLE notification_deliveries
  DROP CONSTRAINT notification_deliveries_event_type_check,
  ADD CONSTRAINT notification_deliveries_event_type_check CHECK (event_type IN (
    'appointment.booked', 'appointment.cancelled', 'appointment.rescheduled',
    'appointment.reminder_24h', 'appointment.reminder_1h',
    'appointment.assisted_reschedule_requested',
    'appointment.queue_checked_in', 'appointment.doctor_ready'
  ));

ALTER TABLE appointment_notification_outbox
  DROP CONSTRAINT appointment_notification_outbox_event_type_check,
  ADD CONSTRAINT appointment_notification_outbox_event_type_check CHECK (event_type IN (
    'appointment.booked', 'appointment.cancelled', 'appointment.rescheduled',
    'appointment.queue_checked_in', 'appointment.doctor_ready'
  ));
