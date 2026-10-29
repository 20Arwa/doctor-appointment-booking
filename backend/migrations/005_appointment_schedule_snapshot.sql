ALTER TABLE appointments
  ADD COLUMN scheduled_date DATE,
  ADD COLUMN scheduled_start_time TIME,
  ADD COLUMN scheduled_end_time TIME;

UPDATE appointments a
SET scheduled_date = av.date,
    scheduled_start_time = av.start_time,
    scheduled_end_time = av.end_time
FROM availability av
WHERE av.id = a.availability_id;

ALTER TABLE appointments
  ALTER COLUMN scheduled_date SET NOT NULL,
  ALTER COLUMN scheduled_start_time SET NOT NULL,
  ALTER COLUMN scheduled_end_time SET NOT NULL,
  ADD CONSTRAINT appointments_schedule_end_after_start
    CHECK (scheduled_end_time > scheduled_start_time);

CREATE INDEX appointments_doctor_schedule_idx
  ON appointments (scheduled_date, scheduled_start_time)
  WHERE status = 'confirmed';

DROP INDEX appointments_availability_active_unique;
