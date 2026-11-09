-- Use the existing notification delivery table and recovery path for reminder SMS.
ALTER TABLE notification_deliveries
  DROP CONSTRAINT notification_deliveries_event_type_check,
  ADD CONSTRAINT notification_deliveries_event_type_check CHECK (event_type IN (
    'appointment.booked',
    'appointment.cancelled',
    'appointment.rescheduled',
    'appointment.reminder_24h',
    'appointment.reminder_1h'
  )),
  DROP CONSTRAINT notification_deliveries_reason_check,
  ADD CONSTRAINT notification_deliveries_reason_check CHECK (reason IN (
    'timeout', 'network_error', 'provider_error', 'unexpected_error',
    'missing_configuration', 'missing_recipient', 'simulated',
    'consent_not_given', 'appointment_not_eligible'
  ));
