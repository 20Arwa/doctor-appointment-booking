ALTER TABLE appointment_notification_outbox
  DROP CONSTRAINT appointment_notification_outbox_event_type_check,
  ADD CONSTRAINT appointment_notification_outbox_event_type_check CHECK (event_type IN (
    'appointment.booked', 'appointment.cancelled', 'appointment.rescheduled',
    'appointment.reminder_24h', 'appointment.reminder_1h',
    'appointment.queue_checked_in', 'appointment.doctor_ready'
  ));

WITH eligible AS (
  SELECT a.id AS appointment_id, a.scheduled_date::text AS date,
         to_char(a.scheduled_start_time, 'HH24:MI:SS') AS start_time,
         to_char(a.scheduled_end_time, 'HH24:MI:SS') AS end_time,
         a.scheduled_start_time, p.user_id AS patient_user_id, pu.email AS patient_email,
         pu.first_name AS patient_first_name, pu.last_name AS patient_last_name,
         d.user_id AS doctor_user_id, du.email AS doctor_email,
         du.first_name AS doctor_first_name, du.last_name AS doctor_last_name,
         av.mode, queue.token_number, reminder.event_type, reminder.reminder_type,
         ((a.scheduled_date + a.scheduled_start_time) AT TIME ZONE 'Asia/Kolkata')
           - (reminder.lead_hours * INTERVAL '1 hour') AS due_at
    FROM appointments a
    JOIN availability av ON av.id = a.availability_id
    LEFT JOIN appointment_queue_entries queue ON queue.appointment_id = a.id
    JOIN doctors d ON d.id = av.doctor_id
    JOIN users du ON du.id = d.user_id
    JOIN patients p ON p.id = a.patient_id
    JOIN users pu ON pu.id = p.user_id
    CROSS JOIN (VALUES
      ('appointment.reminder_24h', '24h', 24),
      ('appointment.reminder_1h', '1h', 1)
    ) AS reminder(event_type, reminder_type, lead_hours)
   WHERE a.status = 'confirmed'
     AND a.scheduled_date IS NOT NULL AND a.scheduled_start_time IS NOT NULL
), scheduled AS (
  SELECT eligible.* FROM eligible WHERE due_at > NOW()
)
INSERT INTO appointment_notification_outbox
  (event_key, event_type, appointment_id, actor_role, payload, next_attempt_at)
SELECT event_type || ':' || appointment_id::text || ':' || date || ':' || start_time,
       event_type, appointment_id, 'system',
       jsonb_build_object(
         'id', appointment_id, 'patient_user_id', patient_user_id, 'patient_email', patient_email,
         'patient_first_name', patient_first_name, 'patient_last_name', patient_last_name,
         'doctor_user_id', doctor_user_id, 'doctor_email', doctor_email,
         'doctor_first_name', doctor_first_name, 'doctor_last_name', doctor_last_name,
         'date', date, 'start_time', start_time, 'end_time', end_time, 'mode', mode,
         'reminder_type', reminder_type, 'scheduled_date', date, 'scheduled_start_time', start_time
       ) || CASE WHEN token_number IS NOT NULL THEN jsonb_build_object('token_number', token_number) ELSE '{}'::jsonb END,
       due_at
  FROM scheduled
ON CONFLICT (event_key) DO NOTHING;
