-- Keep email restricted to Brevo while allowing normalized, registered SMS adapter names.
ALTER TABLE notification_deliveries
  DROP CONSTRAINT notification_deliveries_provider_check,
  ADD CONSTRAINT notification_deliveries_provider_check CHECK (
    (channel = 'email' AND provider = 'brevo')
    OR (channel = 'sms' AND provider ~ '^[a-z][a-z0-9_-]{0,31}$')
  );
