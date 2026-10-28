CREATE TABLE availability (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  doctor_id UUID NOT NULL REFERENCES doctors(id) ON DELETE RESTRICT,
  date DATE NOT NULL,
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT availability_end_after_start CHECK (end_time > start_time)
);

CREATE UNIQUE INDEX availability_doctor_date_start_unique
  ON availability (doctor_id, date, start_time);

CREATE INDEX availability_date_idx ON availability (date);

-- Phase 3 appointments must reference availability with ON DELETE RESTRICT.
-- Slot deletion must then reject any slot referenced by current or historical appointments.
