ALTER TABLE notification_deliveries
  ADD COLUMN payload JSONB,
  ADD COLUMN idempotency_key UUID NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN next_attempt_at TIMESTAMPTZ,
  ADD COLUMN failure_classification TEXT CHECK (failure_classification IN ('transient', 'permanent', 'ambiguous')),
  ADD COLUMN lease_token UUID,
  ADD COLUMN lease_expires_at TIMESTAMPTZ;

ALTER TABLE notification_deliveries DROP CONSTRAINT notification_deliveries_status_check;
ALTER TABLE notification_deliveries ADD CONSTRAINT notification_deliveries_status_check
  CHECK (status IN ('processing', 'accepted', 'failed', 'skipped', 'ambiguous'));

ALTER TABLE notification_deliveries DROP CONSTRAINT notification_deliveries_final_state;
ALTER TABLE notification_deliveries ADD CONSTRAINT notification_deliveries_final_state CHECK (
  (status = 'processing' AND completed_at IS NULL)
  OR (status IN ('accepted', 'failed', 'skipped', 'ambiguous') AND completed_at IS NOT NULL)
);

ALTER TABLE notification_deliveries DROP CONSTRAINT notification_deliveries_outcome_reason;
ALTER TABLE notification_deliveries ADD CONSTRAINT notification_deliveries_outcome_reason CHECK (
  (status IN ('processing', 'accepted') AND reason IS NULL)
  OR (status IN ('failed', 'skipped', 'ambiguous') AND reason IS NOT NULL)
);

-- Rows created before recovery had no payload or provider idempotency key to retry safely.
UPDATE notification_deliveries
SET status = 'ambiguous', failure_classification = 'ambiguous', reason = 'unexpected_error', completed_at = NOW()
WHERE status = 'processing';

ALTER TABLE notification_deliveries ADD CONSTRAINT notification_deliveries_lease_state CHECK (
  (status = 'processing' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
  OR (status <> 'processing' AND lease_token IS NULL AND lease_expires_at IS NULL)
) NOT VALID;

CREATE INDEX notification_deliveries_retry_idx
  ON notification_deliveries (next_attempt_at, created_at)
  WHERE status = 'failed' AND failure_classification = 'transient';

CREATE INDEX notification_deliveries_expired_lease_idx
  ON notification_deliveries (lease_expires_at)
  WHERE status = 'processing';
