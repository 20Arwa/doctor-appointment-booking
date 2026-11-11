CREATE TABLE assisted_reschedule_batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_id UUID NOT NULL REFERENCES doctor_schedules(id) ON DELETE RESTRICT,
  source_schedule_updated_at TIMESTAMPTZ NOT NULL,
  request_fingerprint TEXT NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  result JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT assisted_reschedule_batches_schedule_revision_unique
    UNIQUE (schedule_id, source_schedule_updated_at)
);

CREATE TABLE assisted_reschedule_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id UUID NOT NULL REFERENCES assisted_reschedule_batches(id) ON DELETE RESTRICT,
  appointment_id UUID NOT NULL REFERENCES appointments(id) ON DELETE RESTRICT,
  doctor_id UUID NOT NULL REFERENCES doctors(id) ON DELETE RESTRICT,
  patient_id UUID NOT NULL REFERENCES patients(id) ON DELETE RESTRICT,
  source_availability_id UUID NOT NULL REFERENCES availability(id) ON DELETE RESTRICT,
  appointment_updated_at TIMESTAMPTZ NOT NULL,
  previous_date DATE NOT NULL,
  previous_start_time TIME NOT NULL,
  previous_end_time TIME NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('wave', 'stream')),
  status TEXT NOT NULL CHECK (status IN (
    'pending_patient', 'no_alternatives', 'accepted', 'declined', 'expired', 'superseded'
  )),
  notification_status TEXT NOT NULL DEFAULT 'not_required'
    CHECK (notification_status IN ('pending', 'processing', 'dispatched', 'failed', 'not_required')),
  selected_availability_id UUID REFERENCES availability(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  responded_at TIMESTAMPTZ,
  CONSTRAINT assisted_reschedule_requests_appointment_patient_fk
    FOREIGN KEY (appointment_id, patient_id)
    REFERENCES appointments(id, patient_id) ON DELETE RESTRICT,
  CONSTRAINT assisted_reschedule_requests_previous_end_check
    CHECK (previous_end_time > previous_start_time),
  CONSTRAINT assisted_reschedule_requests_batch_appointment_unique
    UNIQUE (batch_id, appointment_id)
);

CREATE UNIQUE INDEX assisted_reschedule_requests_one_open_per_appointment
  ON assisted_reschedule_requests (appointment_id)
  WHERE status IN ('pending_patient', 'no_alternatives');

CREATE INDEX assisted_reschedule_requests_doctor_status_idx
  ON assisted_reschedule_requests (doctor_id, status, created_at DESC);

CREATE INDEX assisted_reschedule_requests_patient_status_idx
  ON assisted_reschedule_requests (patient_id, status, created_at DESC);

CREATE INDEX assisted_reschedule_requests_notification_idx
  ON assisted_reschedule_requests (notification_status, created_at)
  WHERE notification_status = 'pending';

CREATE TABLE assisted_reschedule_suggestions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id UUID NOT NULL REFERENCES assisted_reschedule_requests(id) ON DELETE RESTRICT,
  availability_id UUID NOT NULL REFERENCES availability(id) ON DELETE RESTRICT,
  mode TEXT NOT NULL CHECK (mode IN ('wave', 'stream')),
  service_date DATE NOT NULL,
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  remaining_capacity_at_suggestion INTEGER NOT NULL CHECK (remaining_capacity_at_suggestion > 0),
  rank SMALLINT NOT NULL CHECK (rank > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT assisted_reschedule_suggestions_end_check CHECK (end_time > start_time),
  CONSTRAINT assisted_reschedule_suggestions_request_availability_unique
    UNIQUE (request_id, availability_id),
  CONSTRAINT assisted_reschedule_suggestions_request_rank_unique
    UNIQUE (request_id, rank)
);

CREATE INDEX assisted_reschedule_suggestions_request_rank_idx
  ON assisted_reschedule_suggestions (request_id, rank);
