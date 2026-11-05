-- Keep existing availability and allocation history intact. New Stream rows use
-- one availability row for an entire schedule period and store its window cap.
ALTER TABLE availability
  DROP CONSTRAINT availability_window_consistency_fk,
  DROP CONSTRAINT availability_mode_capacity_check;

ALTER TABLE doctor_schedule_windows
  ADD CONSTRAINT doctor_schedule_windows_availability_reference_key
    UNIQUE (id, schedule_id, doctor_id, mode, service_date);

ALTER TABLE availability
  ADD CONSTRAINT availability_window_consistency_fk
    FOREIGN KEY (schedule_window_id, schedule_id, doctor_id, mode, date)
    REFERENCES doctor_schedule_windows (id, schedule_id, doctor_id, mode, service_date)
    ON DELETE RESTRICT NOT VALID,
  ADD CONSTRAINT availability_mode_capacity_check
    CHECK (
      (mode = 'wave' AND capacity > 0)
      OR (mode = 'stream' AND capacity > 0)
      OR mode IS NULL
    ) NOT VALID;

DROP INDEX appointment_allocations_stream_slot_active_unique;

-- Retire pre-017 Stream sub-slots from new booking while retaining every row
-- referenced by appointments, allocations, payments, refunds, and history.
UPDATE doctor_schedule_windows
SET deleted_at = COALESCE(deleted_at, NOW())
WHERE mode = 'stream' AND deleted_at IS NULL
  AND (service_date + start_time) AT TIME ZONE 'Asia/Kolkata' > NOW();

UPDATE availability
SET deleted_at = COALESCE(deleted_at, NOW()), updated_at = NOW()
WHERE mode = 'stream' AND schedule_window_id IS NOT NULL AND deleted_at IS NULL
  AND (date + start_time) AT TIME ZONE 'Asia/Kolkata' > NOW();

CREATE FUNCTION enforce_appointment_allocation_capacity() RETURNS trigger AS $$
DECLARE
  slot_mode TEXT;
  slot_capacity INTEGER;
  active_allocations INTEGER;
  active_payment_holds INTEGER;
BEGIN
  IF NEW.status NOT IN ('held', 'confirmed')
     OR (NEW.status = 'held' AND NEW.expires_at <= NOW()) THEN
    RETURN NEW;
  END IF;

  SELECT mode, capacity
    INTO slot_mode, slot_capacity
  FROM availability
  WHERE id = NEW.availability_id
  FOR UPDATE;

  IF slot_mode IS DISTINCT FROM NEW.mode THEN
    RAISE EXCEPTION 'Allocation mode does not match availability mode'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT COUNT(*)::INTEGER
    INTO active_allocations
  FROM appointment_allocations
  WHERE availability_id = NEW.availability_id
    AND id IS DISTINCT FROM NEW.id
    AND status IN ('held', 'confirmed')
    AND (status <> 'held' OR expires_at > NOW());

  SELECT COUNT(*)::INTEGER
    INTO active_payment_holds
  FROM appointment_slot_holds
  WHERE availability_id = NEW.availability_id
    AND status = 'active'
    AND expires_at > NOW();

  IF active_allocations + active_payment_holds >= slot_capacity THEN
    RAISE EXCEPTION 'Availability capacity has been reached'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'appointment_allocation_capacity';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql
SET search_path = public, pg_temp;

CREATE TRIGGER appointment_allocations_capacity_guard
  BEFORE INSERT OR UPDATE OF availability_id, mode, status, expires_at
  ON appointment_allocations
  FOR EACH ROW EXECUTE FUNCTION enforce_appointment_allocation_capacity();
