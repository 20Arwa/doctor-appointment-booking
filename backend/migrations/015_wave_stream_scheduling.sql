-- The migration runner wraps each file in a transaction; keep unqualified
-- objects in the repository's established public schema.
SET LOCAL search_path TO public;

CREATE EXTENSION IF NOT EXISTS btree_gist;

DO $$
DECLARE
  duration_column_type OID;
BEGIN
  SELECT attribute.atttypid
    INTO duration_column_type
  FROM pg_attribute AS attribute
  WHERE attribute.attrelid = 'public.doctors'::regclass
    AND attribute.attname = 'appointment_duration_minutes'
    AND NOT attribute.attisdropped;

  IF duration_column_type IS NULL
     OR format_type(duration_column_type, NULL) <> 'integer' THEN
    RAISE EXCEPTION
      'Migration 015 requires public.doctors.appointment_duration_minutes to already exist as INTEGER; no column or type change is performed here';
  END IF;
END;
$$;

CREATE SCHEMA IF NOT EXISTS medrella_legacy;

-- Move old implementations aside before creating replacement public tables.
-- ALTER TABLE SET SCHEMA preserves each table's rows, indexes, constraints,
-- and foreign-key dependencies.
DO $$
DECLARE
  legacy_table_name TEXT;
  public_table_kind "char";
  legacy_table_exists BOOLEAN;
BEGIN
  FOREACH legacy_table_name IN ARRAY ARRAY[
    'doctor_weekly_schedule_periods',
    'doctor_schedule_exceptions',
    'doctor_schedule_exception_periods',
    'appointment_reschedule_history'
  ] LOOP
    SELECT relation.relkind
      INTO public_table_kind
    FROM pg_class AS relation
    JOIN pg_namespace AS schema_name ON schema_name.oid = relation.relnamespace
    WHERE schema_name.nspname = 'public'
      AND relation.relname = legacy_table_name;

    SELECT EXISTS (
      SELECT 1
      FROM pg_class AS relation
      JOIN pg_namespace AS schema_name ON schema_name.oid = relation.relnamespace
      WHERE schema_name.nspname = 'medrella_legacy'
        AND relation.relname = legacy_table_name
    ) INTO legacy_table_exists;

    IF public_table_kind IS NOT NULL AND public_table_kind NOT IN ('r', 'p') THEN
      RAISE EXCEPTION 'Expected public.% to be a table before moving it', legacy_table_name;
    END IF;

    IF public_table_kind IS NOT NULL AND legacy_table_exists THEN
      RAISE EXCEPTION
        'Cannot move public.%: medrella_legacy.% already exists',
        legacy_table_name,
        legacy_table_name;
    ELSIF public_table_kind IS NOT NULL THEN
      EXECUTE format(
        'ALTER TABLE public.%I SET SCHEMA medrella_legacy',
        legacy_table_name
      );
    END IF;

    public_table_kind := NULL;
    legacy_table_exists := FALSE;
  END LOOP;
END;
$$;

CREATE TABLE doctor_schedules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  doctor_id UUID NOT NULL REFERENCES doctors(id) ON DELETE RESTRICT,
  mode TEXT NOT NULL CHECK (mode IN ('wave', 'stream')),
  recurrence_type TEXT NOT NULL
    CHECK (recurrence_type IN ('weekly', 'specific_dates')),
  visibility TEXT NOT NULL DEFAULT 'public'
    CHECK (visibility IN ('public', 'private')),
  starts_on DATE,
  ends_on DATE,
  time_zone TEXT NOT NULL DEFAULT 'Asia/Kolkata',
  wave_capacity_per_slot INTEGER NOT NULL,
  stream_capacity_per_window INTEGER NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  archived_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT doctor_schedules_id_doctor_mode_visibility_key
    UNIQUE (
      id, doctor_id, mode, visibility,
      wave_capacity_per_slot, stream_capacity_per_window
    ),
  CONSTRAINT doctor_schedules_id_recurrence_type_key
    UNIQUE (id, recurrence_type),
  CONSTRAINT doctor_schedules_recurrence_dates_check CHECK (
    (recurrence_type = 'weekly'
      AND starts_on IS NOT NULL
      AND ends_on IS NOT NULL
      AND ends_on >= starts_on)
    OR
    (recurrence_type = 'specific_dates'
      AND starts_on IS NULL
      AND ends_on IS NULL)
  ),
  CONSTRAINT doctor_schedules_capacity_check CHECK (
    (mode = 'wave'
      AND wave_capacity_per_slot > 0
      AND stream_capacity_per_window = 0)
    OR
    (mode = 'stream'
      AND stream_capacity_per_window > 0
      AND wave_capacity_per_slot = 0)
  ),
  CONSTRAINT doctor_schedules_archive_check
    CHECK (archived_at IS NULL OR active = FALSE)
);

CREATE INDEX doctor_schedules_doctor_active_idx
  ON doctor_schedules (doctor_id, active)
  WHERE archived_at IS NULL;

CREATE TABLE doctor_schedule_periods (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_id UUID NOT NULL,
  recurrence_type TEXT NOT NULL,
  weekday SMALLINT,
  service_date DATE,
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,

  CONSTRAINT doctor_schedule_periods_schedule_type_fk
    FOREIGN KEY (schedule_id, recurrence_type)
    REFERENCES doctor_schedules (id, recurrence_type) ON DELETE RESTRICT,
  CONSTRAINT doctor_schedule_periods_end_after_start_check
    CHECK (end_time > start_time),
  CONSTRAINT doctor_schedule_periods_recurrence_shape_check CHECK (
    (recurrence_type = 'weekly'
      AND weekday IS NOT NULL
      AND weekday BETWEEN 0 AND 6
      AND service_date IS NULL)
    OR
    (recurrence_type = 'specific_dates'
      AND weekday IS NULL
      AND service_date IS NOT NULL)
  )
);

CREATE UNIQUE INDEX doctor_schedule_weekday_period_unique
  ON doctor_schedule_periods (schedule_id, weekday, start_time)
  WHERE recurrence_type = 'weekly';

CREATE UNIQUE INDEX doctor_schedule_specific_date_period_unique
  ON doctor_schedule_periods (schedule_id, service_date, start_time)
  WHERE recurrence_type = 'specific_dates';

ALTER TABLE doctor_schedule_periods
  ADD CONSTRAINT doctor_schedule_weekly_periods_no_overlap
  EXCLUDE USING gist (
    schedule_id WITH =,
    weekday WITH =,
    tsrange(
      DATE '2000-01-03' + start_time,
      DATE '2000-01-03' + end_time,
      '[)'
    ) WITH &&
  )
  WHERE (recurrence_type = 'weekly');

ALTER TABLE doctor_schedule_periods
  ADD CONSTRAINT doctor_schedule_specific_date_periods_no_overlap
  EXCLUDE USING gist (
    schedule_id WITH =,
    service_date WITH =,
    tsrange(service_date + start_time, service_date + end_time, '[)') WITH &&
  )
  WHERE (recurrence_type = 'specific_dates');

CREATE TABLE doctor_schedule_exceptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_id UUID NOT NULL
    REFERENCES doctor_schedules(id) ON DELETE RESTRICT,
  service_date DATE NOT NULL,
  exception_type TEXT NOT NULL
    CHECK (exception_type IN ('day_off', 'override', 'additional')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT doctor_schedule_exceptions_one_per_date
    UNIQUE (schedule_id, service_date),
  CONSTRAINT doctor_schedule_exceptions_id_type_key
    UNIQUE (id, exception_type)
);

CREATE TABLE doctor_schedule_exception_periods (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  exception_id UUID NOT NULL,
  exception_type TEXT NOT NULL
    CHECK (exception_type IN ('override', 'additional')),
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  CONSTRAINT doctor_schedule_exception_periods_exception_type_fk
    FOREIGN KEY (exception_id, exception_type)
    REFERENCES doctor_schedule_exceptions(id, exception_type) ON DELETE RESTRICT,
  CONSTRAINT doctor_schedule_exception_periods_end_after_start_check
    CHECK (end_time > start_time),
  CONSTRAINT doctor_schedule_exception_periods_start_unique
    UNIQUE (exception_id, start_time)
);

ALTER TABLE doctor_schedule_exception_periods
  ADD CONSTRAINT doctor_schedule_exception_periods_no_overlap
  EXCLUDE USING gist (
    exception_id WITH =,
    tsrange(
      DATE '2000-01-01' + start_time,
      DATE '2000-01-01' + end_time,
      '[)'
    ) WITH &&
  );

CREATE TABLE doctor_schedule_windows (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_id UUID NOT NULL,
  doctor_id UUID NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('wave', 'stream')),
  visibility TEXT NOT NULL CHECK (visibility IN ('public', 'private')),
  service_date DATE NOT NULL,
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  wave_capacity_per_slot INTEGER NOT NULL,
  stream_capacity_per_window INTEGER NOT NULL,
  slot_capacity INTEGER GENERATED ALWAYS AS (
    CASE WHEN mode = 'wave' THEN wave_capacity_per_slot ELSE 1 END
  ) STORED,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT doctor_schedule_windows_schedule_owner_fk
    FOREIGN KEY (
      schedule_id, doctor_id, mode, visibility,
      wave_capacity_per_slot, stream_capacity_per_window
    )
    REFERENCES doctor_schedules (
      id, doctor_id, mode, visibility,
      wave_capacity_per_slot, stream_capacity_per_window
    )
    ON DELETE RESTRICT,
  -- Referenced by availability's composite FK.
  CONSTRAINT doctor_schedule_windows_slot_reference_key
    UNIQUE (id, schedule_id, doctor_id, mode, service_date, slot_capacity),
  CONSTRAINT doctor_schedule_windows_end_after_start_check
    CHECK (end_time > start_time),
  CONSTRAINT doctor_schedule_windows_capacity_check CHECK (
    (mode = 'wave'
      AND wave_capacity_per_slot > 0
      AND stream_capacity_per_window = 0)
    OR
    (mode = 'stream'
      AND wave_capacity_per_slot = 0
      AND stream_capacity_per_window > 0)
  )
);

CREATE UNIQUE INDEX doctor_schedule_windows_active_start_unique
  ON doctor_schedule_windows (schedule_id, service_date, start_time)
  WHERE deleted_at IS NULL;

ALTER TABLE doctor_schedule_windows
  ADD CONSTRAINT doctor_schedule_windows_no_active_doctor_overlap
  EXCLUDE USING gist (
    doctor_id WITH =,
    tsrange(service_date + start_time, service_date + end_time, '[)') WITH &&
  )
  WHERE (deleted_at IS NULL);

CREATE INDEX doctor_schedule_windows_schedule_date_idx
  ON doctor_schedule_windows (schedule_id, service_date)
  WHERE deleted_at IS NULL;

ALTER TABLE availability
  ADD COLUMN schedule_window_id UUID,
  ADD COLUMN schedule_id UUID,
  ADD COLUMN mode TEXT,
  ADD COLUMN booking_visibility TEXT NOT NULL DEFAULT 'public',
  ADD COLUMN capacity INTEGER NOT NULL DEFAULT 1,
  ADD CONSTRAINT availability_booking_visibility_check
    CHECK (booking_visibility IN ('public', 'private')) NOT VALID,
  ADD CONSTRAINT availability_capacity_positive_check
    CHECK (capacity > 0) NOT VALID,
  ADD CONSTRAINT availability_schedule_reference_shape_check CHECK (
    (schedule_window_id IS NULL AND schedule_id IS NULL AND mode IS NULL)
    OR
    (schedule_window_id IS NOT NULL
      AND schedule_id IS NOT NULL
      AND mode IS NOT NULL)
  ) NOT VALID,
  ADD CONSTRAINT availability_mode_check
    CHECK (mode IS NULL OR mode IN ('wave', 'stream')) NOT VALID,
  ADD CONSTRAINT availability_mode_capacity_check CHECK (
    (mode = 'wave' AND capacity > 0)
    OR (mode = 'stream' AND capacity = 1)
    OR mode IS NULL
  ) NOT VALID,
  ADD CONSTRAINT availability_window_consistency_fk
    FOREIGN KEY (schedule_window_id, schedule_id, doctor_id, mode, date, capacity)
    REFERENCES doctor_schedule_windows
      (id, schedule_id, doctor_id, mode, service_date, slot_capacity)
    ON DELETE RESTRICT
    NOT VALID,
  ADD CONSTRAINT availability_slot_mode_key
    UNIQUE (id, mode);

CREATE INDEX availability_schedule_window_idx
  ON availability (schedule_window_id, date, start_time)
  WHERE deleted_at IS NULL;

CREATE TABLE appointment_allocations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  availability_id UUID NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('wave', 'stream')),
  patient_id UUID NOT NULL REFERENCES patients(id) ON DELETE RESTRICT,
  status TEXT NOT NULL
    CHECK (status IN ('held', 'confirmed', 'released', 'expired')),
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT appointment_allocations_slot_mode_fk
    FOREIGN KEY (availability_id, mode)
    REFERENCES availability (id, mode) ON DELETE RESTRICT,
  CONSTRAINT appointment_allocations_id_slot_patient_key
    UNIQUE (id, availability_id, patient_id),
  CONSTRAINT appointment_allocations_expiry_state_check CHECK (
    status <> 'held'
    OR (expires_at IS NOT NULL AND expires_at > created_at)
  )
);

CREATE INDEX appointment_allocations_slot_state_idx
  ON appointment_allocations (availability_id, status, expires_at);

-- Wave sharing is enforced by capacity checks in the reservation service.
-- Stream permits only one held or confirmed allocation per generated slot.
CREATE UNIQUE INDEX appointment_allocations_stream_slot_active_unique
  ON appointment_allocations (availability_id)
  WHERE mode = 'stream' AND status IN ('held', 'confirmed');

ALTER TABLE appointments
  ADD COLUMN allocation_id UUID,
  ADD CONSTRAINT appointments_id_patient_key UNIQUE (id, patient_id),
  ADD CONSTRAINT appointments_allocation_slot_patient_fk
    FOREIGN KEY (allocation_id, availability_id, patient_id)
    REFERENCES appointment_allocations (id, availability_id, patient_id)
    ON DELETE RESTRICT
    NOT VALID;

CREATE UNIQUE INDEX appointments_allocation_unique
  ON appointments (allocation_id)
  WHERE allocation_id IS NOT NULL;

CREATE INDEX appointments_confirmed_slot_time_idx
  ON appointments (availability_id, scheduled_date, scheduled_start_time)
  WHERE status = 'confirmed';

CREATE TABLE appointment_reschedule_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  appointment_id UUID NOT NULL,
  patient_id UUID NOT NULL,
  changed_by_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  previous_allocation_id UUID NOT NULL,
  previous_availability_id UUID NOT NULL
    REFERENCES availability(id) ON DELETE RESTRICT,
  previous_date DATE NOT NULL,
  previous_start_time TIME NOT NULL,
  previous_end_time TIME NOT NULL,
  new_allocation_id UUID NOT NULL,
  new_availability_id UUID NOT NULL
    REFERENCES availability(id) ON DELETE RESTRICT,
  new_date DATE NOT NULL,
  new_start_time TIME NOT NULL,
  new_end_time TIME NOT NULL,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT appointment_reschedule_history_appointment_patient_fk
    FOREIGN KEY (appointment_id, patient_id)
    REFERENCES appointments (id, patient_id) ON DELETE RESTRICT,
  CONSTRAINT appointment_reschedule_history_previous_allocation_fk
    FOREIGN KEY (previous_allocation_id, previous_availability_id, patient_id)
    REFERENCES appointment_allocations (id, availability_id, patient_id)
    ON DELETE RESTRICT,
  CONSTRAINT appointment_reschedule_history_new_allocation_fk
    FOREIGN KEY (new_allocation_id, new_availability_id, patient_id)
    REFERENCES appointment_allocations (id, availability_id, patient_id)
    ON DELETE RESTRICT,
  CONSTRAINT appointment_reschedule_history_end_times_check CHECK (
    previous_end_time > previous_start_time
    AND new_end_time > new_start_time
  ),
  CONSTRAINT appointment_reschedule_history_distinct_allocations_check
    CHECK (previous_allocation_id <> new_allocation_id)
);

CREATE INDEX appointment_reschedule_history_appointment_idx
  ON appointment_reschedule_history (appointment_id, changed_at DESC);

DO $$
DECLARE
  payment_target_expression TEXT;
  target_truth_table TEXT;
BEGIN
  SELECT pg_get_expr(constraint_row.conbin, constraint_row.conrelid)
    INTO payment_target_expression
  FROM pg_constraint AS constraint_row
  WHERE constraint_row.conrelid = 'public.payments'::regclass
    AND constraint_row.conname = 'payments_appointment_or_hold_required'
    AND constraint_row.contype = 'c';

  IF payment_target_expression IS NULL THEN
    RAISE EXCEPTION
      'Migration 015 expected payments_appointment_or_hold_required from migration 008; constraint is missing or has a different name';
  END IF;

  BEGIN
    EXECUTE format(
      $query$
        SELECT string_agg((%s)::text, ',' ORDER BY case_row.ordinal)
        FROM (VALUES
          (1, NULL::uuid, NULL::uuid),
          (2, %L::uuid, NULL::uuid),
          (3, NULL::uuid, %L::uuid),
          (4, %L::uuid, %L::uuid)
        ) AS case_row(ordinal, appointment_id, slot_hold_id)
      $query$,
      payment_target_expression,
      '00000000-0000-0000-0000-000000000001',
      '00000000-0000-0000-0000-000000000002',
      '00000000-0000-0000-0000-000000000003',
      '00000000-0000-0000-0000-000000000004'
    ) INTO target_truth_table;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION
      'Migration 015 could not evaluate payments_appointment_or_hold_required; expected Migration 008 appointment/slot-hold XOR. Found expression: %',
      payment_target_expression;
  END;

  IF target_truth_table <> 'false,true,true,false' THEN
    RAISE EXCEPTION
      'Migration 015 found an unexpected payments_appointment_or_hold_required definition. Expected truth table false,true,true,false; found % (expression: %)',
      target_truth_table,
      payment_target_expression;
  END IF;
END;
$$;

ALTER TABLE payments
  ADD COLUMN allocation_id UUID
    REFERENCES appointment_allocations(id) ON DELETE RESTRICT;

ALTER TABLE payments
  DROP CONSTRAINT payments_appointment_or_hold_required;

ALTER TABLE payments
  ADD CONSTRAINT payments_booking_target_check CHECK (
    (appointment_id IS NOT NULL
      AND slot_hold_id IS NULL
      AND allocation_id IS NULL)
    OR
    (appointment_id IS NULL
      AND slot_hold_id IS NOT NULL
      AND allocation_id IS NULL)
    OR
    (appointment_id IS NULL
      AND slot_hold_id IS NULL
      AND allocation_id IS NOT NULL)
  );

CREATE UNIQUE INDEX payments_one_open_or_captured_per_allocation
  ON payments (allocation_id)
  WHERE allocation_id IS NOT NULL
    AND status IN (
      'created', 'pending', 'authorized', 'captured',
      'partially_refunded', 'refunded'
    );

CREATE INDEX payments_allocation_created_idx
  ON payments (allocation_id, created_at DESC)
  WHERE allocation_id IS NOT NULL;
