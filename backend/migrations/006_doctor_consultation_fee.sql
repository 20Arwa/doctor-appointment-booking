ALTER TABLE doctors
  ADD COLUMN consultation_fee NUMERIC(10, 2) NOT NULL DEFAULT 500.00
  CHECK (consultation_fee >= 0);

UPDATE doctors
SET consultation_fee = 500.00;
