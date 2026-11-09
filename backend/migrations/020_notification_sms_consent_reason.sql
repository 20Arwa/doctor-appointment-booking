ALTER TABLE notification_deliveries
  DROP CONSTRAINT notification_deliveries_reason_check,
  ADD CONSTRAINT notification_deliveries_reason_check CHECK (reason IN (
    'timeout', 'network_error', 'provider_error', 'unexpected_error',
    'missing_configuration', 'missing_recipient', 'simulated', 'consent_not_given'
  ));
