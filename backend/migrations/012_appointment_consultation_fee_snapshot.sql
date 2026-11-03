ALTER TABLE appointments
  ADD COLUMN consultation_fee NUMERIC(10, 2)
  CHECK (consultation_fee IS NULL OR consultation_fee >= 0);

UPDATE appointments appointment
SET consultation_fee = payment.amount
FROM payments payment
WHERE payment.appointment_id = appointment.id
  AND payment.status IN ('captured', 'partially_refunded', 'refunded');
