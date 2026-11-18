ALTER TABLE users DROP CONSTRAINT users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('patient', 'doctor', 'receptionist'));

CREATE TABLE appointment_queue_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  appointment_id UUID NOT NULL UNIQUE REFERENCES appointments(id) ON DELETE RESTRICT,
  doctor_id UUID NOT NULL REFERENCES doctors(id) ON DELETE RESTRICT,
  service_date DATE NOT NULL,
  token_number INTEGER NOT NULL CHECK (token_number > 0),
  status TEXT NOT NULL DEFAULT 'not_checked_in'
    CHECK (status IN ('not_checked_in', 'waiting', 'in_progress', 'completed', 'no_show', 'cancelled')),
  checked_in_at TIMESTAMPTZ,
  checked_in_by_user_id UUID REFERENCES users(id) ON DELETE RESTRICT,
  no_show_at TIMESTAMPTZ,
  no_show_by_user_id UUID REFERENCES users(id) ON DELETE RESTRICT,
  called_at TIMESTAMPTZ,
  called_by_user_id UUID REFERENCES users(id) ON DELETE RESTRICT,
  completed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT appointment_queue_doctor_date_token_unique UNIQUE (doctor_id, service_date, token_number),
  CONSTRAINT appointment_queue_checkin_actor_pair CHECK ((checked_in_at IS NULL) = (checked_in_by_user_id IS NULL)),
  CONSTRAINT appointment_queue_no_show_actor_pair CHECK ((no_show_at IS NULL) = (no_show_by_user_id IS NULL)),
  CONSTRAINT appointment_queue_no_show_state CHECK ((status = 'no_show') = (no_show_at IS NOT NULL)),
  CONSTRAINT appointment_queue_checkin_state CHECK (status NOT IN ('waiting', 'in_progress', 'completed') OR checked_in_at IS NOT NULL),
  CONSTRAINT appointment_queue_call_actor_pair CHECK ((called_at IS NULL) = (called_by_user_id IS NULL)),
  CONSTRAINT appointment_queue_called_state CHECK (status NOT IN ('in_progress', 'completed') OR called_at IS NOT NULL),
  CONSTRAINT appointment_queue_completed_state CHECK ((status = 'completed') = (completed_at IS NOT NULL))
);

CREATE TABLE appointment_queue_status_history (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  queue_entry_id UUID NOT NULL REFERENCES appointment_queue_entries(id) ON DELETE RESTRICT,
  previous_status TEXT NOT NULL,
  new_status TEXT NOT NULL,
  changed_by_user_id UUID REFERENCES users(id) ON DELETE RESTRICT,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX appointment_queue_status_history_entry_idx
  ON appointment_queue_status_history (queue_entry_id, changed_at, id);

CREATE FUNCTION record_appointment_queue_status_change() RETURNS trigger AS $$
BEGIN
  IF OLD.status IS DISTINCT FROM NEW.status THEN
    INSERT INTO appointment_queue_status_history (queue_entry_id, previous_status, new_status, changed_by_user_id)
    VALUES (NEW.id, OLD.status, NEW.status,
      CASE NEW.status
        WHEN 'waiting' THEN NEW.checked_in_by_user_id
        WHEN 'no_show' THEN NEW.no_show_by_user_id
        WHEN 'in_progress' THEN NEW.called_by_user_id
        WHEN 'completed' THEN (SELECT user_id FROM doctors WHERE id = NEW.doctor_id)
        ELSE NULL
      END);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER appointment_queue_status_history_trigger
  AFTER UPDATE OF status ON appointment_queue_entries
  FOR EACH ROW EXECUTE FUNCTION record_appointment_queue_status_change();

CREATE INDEX appointment_queue_active_idx
  ON appointment_queue_entries (doctor_id, service_date, token_number)
  WHERE status IN ('waiting', 'in_progress');
CREATE INDEX appointment_queue_waiting_order_idx
  ON appointment_queue_entries (doctor_id, service_date, checked_in_at, token_number)
  WHERE status = 'waiting';
CREATE UNIQUE INDEX appointment_queue_one_consultation_per_doctor
  ON appointment_queue_entries (doctor_id)
  WHERE status = 'in_progress';

-- Appointment lifecycle writes remain authoritative. The trigger gives every
-- confirmed booking a token and carries cancellation/completion/reschedule state
-- into the independent queue lifecycle in the same transaction.
CREATE FUNCTION sync_appointment_queue_entry() RETURNS trigger AS $$
DECLARE
  target_doctor_id UUID;
  next_token INTEGER;
  schedule_changed BOOLEAN := FALSE;
  should_assign_token BOOLEAN := FALSE;
  reactivating_cancelled BOOLEAN := FALSE;
BEGIN
  SELECT doctor_id INTO target_doctor_id FROM availability WHERE id = NEW.availability_id;
  IF TG_OP = 'INSERT' THEN
    schedule_changed := TRUE;
    should_assign_token := TRUE;
  ELSE
    schedule_changed := OLD.scheduled_date IS DISTINCT FROM NEW.scheduled_date
      OR OLD.scheduled_start_time IS DISTINCT FROM NEW.scheduled_start_time
      OR OLD.scheduled_end_time IS DISTINCT FROM NEW.scheduled_end_time
      OR OLD.availability_id IS DISTINCT FROM NEW.availability_id;
    should_assign_token := schedule_changed AND OLD.status IN ('confirmed', 'cancelled');
    reactivating_cancelled := OLD.status = 'cancelled';
    IF reactivating_cancelled AND NOT EXISTS (
      SELECT 1 FROM appointment_queue_entries WHERE appointment_id = NEW.id
    ) THEN
      should_assign_token := TRUE;
    END IF;
  END IF;

  IF NEW.status = 'confirmed' THEN
    IF should_assign_token THEN
      PERFORM pg_advisory_xact_lock(hashtext(target_doctor_id::text), hashtext(NEW.scheduled_date::text));
      SELECT COALESCE(MAX(token_number), 0) + 1 INTO next_token
        FROM appointment_queue_entries
       WHERE doctor_id = target_doctor_id AND service_date = NEW.scheduled_date;
      INSERT INTO appointment_queue_entries (appointment_id, doctor_id, service_date, token_number)
      VALUES (NEW.id, target_doctor_id, NEW.scheduled_date, next_token)
      ON CONFLICT (appointment_id) DO UPDATE SET
        doctor_id = EXCLUDED.doctor_id, service_date = EXCLUDED.service_date,
        token_number = EXCLUDED.token_number, status = 'not_checked_in',
        checked_in_at = NULL, checked_in_by_user_id = NULL, called_at = NULL, called_by_user_id = NULL,
        completed_at = NULL, no_show_at = NULL, no_show_by_user_id = NULL, updated_at = NOW()
      WHERE appointment_queue_entries.status <> 'completed'
        AND (NOT reactivating_cancelled OR appointment_queue_entries.status = 'cancelled');
    END IF;
    IF TG_OP = 'UPDATE' THEN
      IF OLD.status = 'cancelled' THEN
        UPDATE appointment_queue_entries SET status = 'not_checked_in',
          checked_in_at = NULL, checked_in_by_user_id = NULL, called_at = NULL,
          called_by_user_id = NULL, completed_at = NULL, no_show_at = NULL,
          no_show_by_user_id = NULL, updated_at = NOW()
         WHERE appointment_id = NEW.id AND status = 'cancelled';
      END IF;
    END IF;
  ELSIF NEW.status = 'cancelled' THEN
    UPDATE appointment_queue_entries SET status = 'cancelled', completed_at = NULL,
      no_show_at = NULL, no_show_by_user_id = NULL, updated_at = NOW()
     WHERE appointment_id = NEW.id AND status IN ('not_checked_in', 'waiting', 'in_progress', 'no_show');
  ELSIF NEW.status = 'completed' THEN
    UPDATE appointment_queue_entries SET status = 'completed', completed_at = COALESCE(completed_at, NOW()), updated_at = NOW()
     WHERE appointment_id = NEW.id AND status = 'in_progress';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER appointments_sync_queue_entry
  AFTER INSERT OR UPDATE OF status, availability_id, scheduled_date, scheduled_start_time, scheduled_end_time ON appointments
  FOR EACH ROW EXECUTE FUNCTION sync_appointment_queue_entry();

-- Existing upcoming confirmed appointments are tokenized in deterministic
-- appointment order, serialized per doctor/day.
DO $$
DECLARE
  item RECORD;
  next_token INTEGER;
BEGIN
  FOR item IN
    SELECT a.id AS appointment_id, av.doctor_id, a.scheduled_date
      FROM appointments a JOIN availability av ON av.id = a.availability_id
     WHERE a.status = 'confirmed'
       AND a.scheduled_date >= (NOW() AT TIME ZONE 'Asia/Kolkata')::date
     ORDER BY av.doctor_id, a.scheduled_date, a.scheduled_start_time, a.id
  LOOP
    PERFORM pg_advisory_xact_lock(hashtext(item.doctor_id::text), hashtext(item.scheduled_date::text));
    SELECT COALESCE(MAX(token_number), 0) + 1 INTO next_token
      FROM appointment_queue_entries
     WHERE doctor_id = item.doctor_id AND service_date = item.scheduled_date;
    INSERT INTO appointment_queue_entries (appointment_id, doctor_id, service_date, token_number)
    VALUES (item.appointment_id, item.doctor_id, item.scheduled_date, next_token)
    ON CONFLICT (appointment_id) DO NOTHING;
  END LOOP;
END;
$$;
