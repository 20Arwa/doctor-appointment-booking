ALTER TABLE appointment_slot_holds
  ADD COLUMN reason TEXT;

ALTER TABLE appointment_slot_holds
  ALTER COLUMN expires_at SET DEFAULT (NOW() + INTERVAL '40 minutes');

COMMENT ON COLUMN appointment_slot_holds.expires_at IS
  'Stripe Checkout Sessions expire after 35 minutes; the 40-minute hold leaves time for the signed expiration event and delayed payment reconciliation.';
