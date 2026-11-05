ALTER TABLE doctors
  ADD COLUMN appointment_duration_minutes INTEGER NOT NULL DEFAULT 30
  CHECK (appointment_duration_minutes BETWEEN 5 AND 240),
  ADD COLUMN weekly_schedule_activated_at TIMESTAMPTZ;

CREATE TABLE doctor_weekly_schedule_periods (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  doctor_id UUID NOT NULL REFERENCES doctors(id) ON DELETE RESTRICT,
  weekday SMALLINT NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (end_time > start_time),
  UNIQUE (doctor_id, weekday, start_time)
);
CREATE INDEX doctor_weekly_schedule_periods_doctor_day_idx
  ON doctor_weekly_schedule_periods (doctor_id, weekday, start_time);

CREATE TABLE doctor_schedule_exceptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  doctor_id UUID NOT NULL REFERENCES doctors(id) ON DELETE RESTRICT,
  exception_type TEXT NOT NULL CHECK (exception_type IN ('day_off', 'vacation', 'date_override', 'extra_availability')),
  starts_on DATE NOT NULL,
  ends_on DATE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (ends_on >= starts_on),
  CHECK ((exception_type = 'vacation' AND ends_on >= starts_on) OR (exception_type <> 'vacation' AND ends_on = starts_on))
);
CREATE INDEX doctor_schedule_exceptions_doctor_dates_idx
  ON doctor_schedule_exceptions (doctor_id, starts_on, ends_on);

CREATE TABLE doctor_schedule_exception_periods (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  exception_id UUID NOT NULL REFERENCES doctor_schedule_exceptions(id) ON DELETE CASCADE,
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  CHECK (end_time > start_time),
  UNIQUE (exception_id, start_time)
);

CREATE TABLE appointment_reschedule_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  appointment_id UUID NOT NULL REFERENCES appointments(id) ON DELETE RESTRICT,
  changed_by_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  previous_availability_id UUID NOT NULL REFERENCES availability(id) ON DELETE RESTRICT,
  new_availability_id UUID NOT NULL REFERENCES availability(id) ON DELETE RESTRICT,
  previous_date DATE NOT NULL,
  previous_start_time TIME NOT NULL,
  previous_end_time TIME NOT NULL,
  new_date DATE NOT NULL,
  new_start_time TIME NOT NULL,
  new_end_time TIME NOT NULL,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (previous_end_time > previous_start_time),
  CHECK (new_end_time > new_start_time)
);
CREATE INDEX appointment_reschedule_history_appointment_idx
  ON appointment_reschedule_history (appointment_id, changed_at DESC);
