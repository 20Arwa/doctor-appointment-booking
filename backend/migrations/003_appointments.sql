CREATE TABLE appointments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id UUID NOT NULL REFERENCES patients(id) ON DELETE RESTRICT,
  availability_id UUID NOT NULL REFERENCES availability(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'confirmed'
    CONSTRAINT appointments_status_allowed CHECK (status IN ('confirmed', 'cancelled', 'completed')),
  reason TEXT,
  cancelled_at TIMESTAMPTZ,
  rescheduled_from_appointment_id UUID REFERENCES appointments(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT appointments_cancelled_timestamp_required
    CHECK (status <> 'cancelled' OR cancelled_at IS NOT NULL)
);

CREATE INDEX appointments_patient_created_idx ON appointments (patient_id, created_at DESC);
CREATE INDEX appointments_availability_idx ON appointments (availability_id);
CREATE INDEX appointments_status_idx ON appointments (status);
CREATE INDEX appointments_rescheduled_from_idx
  ON appointments (rescheduled_from_appointment_id)
  WHERE rescheduled_from_appointment_id IS NOT NULL;

CREATE UNIQUE INDEX appointments_availability_active_unique
  ON appointments (availability_id)
  WHERE status <> 'cancelled';
