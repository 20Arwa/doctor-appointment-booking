-- Preserve existing email rows and their keys while allowing one delivery per channel.
ALTER TABLE notification_deliveries
  DROP CONSTRAINT notification_deliveries_event_key_key,
  ADD CONSTRAINT notification_deliveries_event_channel_key UNIQUE (event_key, channel);

ALTER TABLE notification_deliveries
  DROP CONSTRAINT notification_deliveries_channel_check,
  ADD CONSTRAINT notification_deliveries_channel_check CHECK (channel IN ('email', 'sms')),
  DROP CONSTRAINT notification_deliveries_provider_check,
  ADD CONSTRAINT notification_deliveries_provider_check CHECK (
    (channel = 'email' AND provider = 'brevo') OR (channel = 'sms' AND provider = 'mock')
  );

ALTER TABLE notification_deliveries
  DROP CONSTRAINT notification_deliveries_status_check,
  ADD CONSTRAINT notification_deliveries_status_check
    CHECK (status IN ('processing', 'accepted', 'failed', 'skipped', 'ambiguous', 'simulated')),
  DROP CONSTRAINT notification_deliveries_reason_check,
  ADD CONSTRAINT notification_deliveries_reason_check CHECK (reason IN (
    'timeout', 'network_error', 'provider_error', 'unexpected_error',
    'missing_configuration', 'missing_recipient', 'simulated'
  ));

ALTER TABLE notification_deliveries
  DROP CONSTRAINT notification_deliveries_final_state,
  ADD CONSTRAINT notification_deliveries_final_state CHECK (
    (status = 'processing' AND completed_at IS NULL)
    OR (status IN ('accepted', 'failed', 'skipped', 'ambiguous', 'simulated') AND completed_at IS NOT NULL)
  ),
  DROP CONSTRAINT notification_deliveries_outcome_reason,
  ADD CONSTRAINT notification_deliveries_outcome_reason CHECK (
    (status IN ('processing', 'accepted') AND reason IS NULL)
    OR (status IN ('failed', 'skipped', 'ambiguous') AND reason IS NOT NULL AND reason <> 'simulated')
    OR (status = 'simulated' AND reason = 'simulated')
  ),
  ADD CONSTRAINT notification_deliveries_simulated_state CHECK (
    (status <> 'simulated' OR (channel = 'sms' AND provider = 'mock'))
    AND (provider <> 'mock' OR status <> 'accepted')
  );

CREATE INDEX notification_deliveries_channel_retry_idx
  ON notification_deliveries (channel, provider, next_attempt_at, created_at)
  WHERE status = 'failed' AND failure_classification = 'transient';
