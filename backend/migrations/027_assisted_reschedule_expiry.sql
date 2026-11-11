ALTER TABLE assisted_reschedule_requests
  ADD COLUMN expires_at TIMESTAMPTZ;

UPDATE assisted_reschedule_requests request
SET expires_at = (appointment.scheduled_date + appointment.scheduled_start_time) AT TIME ZONE 'Asia/Kolkata'
FROM appointments appointment
WHERE appointment.id = request.appointment_id;

ALTER TABLE assisted_reschedule_requests
  ALTER COLUMN expires_at SET NOT NULL;

CREATE INDEX assisted_reschedule_requests_expiry_idx
  ON assisted_reschedule_requests (expires_at, doctor_id)
  WHERE status IN ('pending_patient', 'no_alternatives');
