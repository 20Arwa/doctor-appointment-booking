ALTER TABLE availability
  ADD COLUMN deleted_at TIMESTAMPTZ;

DROP INDEX availability_doctor_date_start_unique;

CREATE UNIQUE INDEX availability_doctor_date_start_unique
  ON availability (doctor_id, date, start_time)
  WHERE deleted_at IS NULL;

COMMENT ON COLUMN availability.deleted_at IS
  'When set, the slot is removed from active availability while appointment and payment history remains linked.';
