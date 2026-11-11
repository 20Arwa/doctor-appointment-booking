function content(eventType, appointment, recipientType) {
  const doctor = `Dr. ${[appointment.doctor_first_name, appointment.doctor_last_name].filter(Boolean).join(" ")}`;
  const date = appointment.date;
  const time = String(appointment.start_time || "").slice(0, 5);
  const current = `${date} at ${time}`;
  const action = eventType.slice("appointment.".length);
  if (action === "assisted_reschedule_requested") {
    return {
      title: "Choose a new appointment time",
      message: `Your appointment with ${doctor} is affected by a schedule change. Review the suggested alternatives, then choose and confirm a new time. It will not change until you confirm it.`,
    };
  }
  if (action === "reminder.24h" || action === "reminder.1h") {
    const lead = action === "reminder.24h" ? "24 hours" : "1 hour";
    return { title: "Appointment reminder", message: `Your appointment with ${doctor} is in ${lead} (${current}).` };
  }
  if (recipientType === "doctor") {
    const verb = action === "booked" ? "booked" : action === "cancelled" ? "cancelled" : "rescheduled";
    return { title: { booked: "New appointment booking", cancelled: "Appointment cancelled", rescheduled: "Appointment rescheduled" }[action], message: `A patient ${verb} an appointment with you for ${current}.` };
  }
  if (action === "booked") return { title: "Appointment confirmed", message: `Your appointment with ${doctor} is confirmed for ${current}.` };
  if (action === "cancelled") return { title: "Appointment cancelled", message: `Your appointment with ${doctor} on ${current} has been cancelled.` };
  return { title: "Appointment rescheduled", message: `Your appointment with ${doctor} was rescheduled to ${current}.` };
}

function createInAppNotificationService({ database, logger = console }) {
  async function recoverMissingAppointmentNotifications(limit = 100) {
    const inserted = await database.query(
      `WITH candidates AS (
         SELECT delivery.event_key, delivery.event_type, delivery.appointment_id,
                delivery.recipient_user_id, delivery.payload,
                appointment.scheduled_date::text AS date,
                appointment.scheduled_start_time::text AS start_time,
                appointment.scheduled_end_time::text AS end_time,
                availability.mode,
                doctor_user.first_name AS doctor_first_name,
                doctor_user.last_name AS doctor_last_name,
                patient.user_id AS patient_user_id,
                doctor.user_id AS doctor_user_id
         FROM notification_deliveries delivery
         JOIN appointments appointment ON appointment.id = delivery.appointment_id
         JOIN availability ON availability.id = appointment.availability_id
         JOIN doctors doctor ON doctor.id = availability.doctor_id
         JOIN users doctor_user ON doctor_user.id = doctor.user_id
         JOIN patients patient ON patient.id = appointment.patient_id
         WHERE delivery.channel = 'email'
           AND delivery.event_type IN ('appointment.booked', 'appointment.cancelled', 'appointment.rescheduled')
           AND delivery.payload IS NOT NULL
           AND delivery.recipient_user_id IN (patient.user_id, doctor.user_id)
           AND NOT EXISTS (
             SELECT 1 FROM in_app_notifications notification
             WHERE notification.recipient_user_id = delivery.recipient_user_id
               AND notification.event_key = delivery.event_key
           )
         ORDER BY delivery.created_at, delivery.id
         LIMIT $1 FOR UPDATE OF delivery SKIP LOCKED
       )
       INSERT INTO in_app_notifications (recipient_user_id, appointment_id, event_key, event_type, title, message)
       SELECT candidate.recipient_user_id, candidate.appointment_id, candidate.event_key, candidate.event_type,
              COALESCE(NULLIF(candidate.payload->>'subject', ''),
                CASE candidate.event_type
                  WHEN 'appointment.booked' THEN CASE WHEN candidate.recipient_user_id = candidate.doctor_user_id THEN 'New appointment booking' ELSE 'Appointment confirmed' END
                  WHEN 'appointment.cancelled' THEN 'Appointment cancelled'
                  ELSE CASE WHEN candidate.recipient_user_id = candidate.doctor_user_id THEN 'Appointment updated' ELSE 'Appointment rescheduled' END
                END),
              COALESCE(NULLIF(candidate.payload->>'textContent', ''),
                CASE candidate.event_type
                  WHEN 'appointment.booked' THEN format('Your appointment with Dr. %s %s is confirmed for %s at %s–%s (%s).', candidate.doctor_first_name, candidate.doctor_last_name, candidate.date, left(candidate.start_time, 5), left(candidate.end_time, 5), initcap(candidate.mode))
                  WHEN 'appointment.cancelled' THEN format('Your appointment with Dr. %s %s on %s at %s–%s was cancelled.', candidate.doctor_first_name, candidate.doctor_last_name, candidate.date, left(candidate.start_time, 5), left(candidate.end_time, 5))
                  ELSE format('Your appointment with Dr. %s %s was rescheduled. The current time is %s at %s–%s.', candidate.doctor_first_name, candidate.doctor_last_name, candidate.date, left(candidate.start_time, 5), left(candidate.end_time, 5))
                END)
       FROM candidates candidate
       ON CONFLICT (recipient_user_id, event_key) DO NOTHING
       RETURNING id`, [limit],
    );
    return { recovered: inserted.rows.length };
  }

  async function create({ eventKey, eventType, appointment, recipientUserId, recipientType }) {
    if (!recipientUserId) return;
    const { title, message } = content(eventType, appointment, recipientType);
    await database.query(
      `INSERT INTO in_app_notifications (recipient_user_id, appointment_id, event_key, event_type, title, message)
       VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (recipient_user_id, event_key) DO NOTHING`,
      [recipientUserId, appointment.id, eventKey, eventType, title, message],
    );
  }

  async function sendAppointmentNotification({ eventKey, eventType, appointment, actorRole = "patient" }) {
    const recipients = [{ type: "patient", userId: appointment.patient_user_id }];
    if (eventType !== "appointment.rescheduled" || actorRole !== "doctor") recipients.push({ type: "doctor", userId: appointment.doctor_user_id });
    let failed = 0;
    for (const recipient of recipients) {
      const key = `${eventKey}:${recipient.type}:${recipient.userId}`;
      try { await create({ eventKey: key, eventType, appointment, recipientUserId: recipient.userId, recipientType: recipient.type }); }
      catch (_error) { failed += 1; logger.error("In-App appointment notification failed", { eventType, recipientType: recipient.type, reason: "storage_error" }); }
    }
    return { failed };
  }

  async function sendReminder(reminderType, appointment) {
    const eventType = `appointment.reminder.${reminderType}`;
    const eventKey = `${appointment.id}:${eventType}:${appointment.date}:${String(appointment.start_time).slice(0, 8)}`;
    try { await create({ eventKey, eventType, appointment, recipientUserId: appointment.patient_user_id, recipientType: "patient" }); }
    catch (_error) { logger.error("In-App appointment reminder failed", { reminderType, reason: "storage_error" }); }
  }

  async function sendAssistedRescheduleRequested({ eventKey, appointment, recipientUserId, requestId }) {
    if (!recipientUserId) throw new Error("Assisted rescheduling notification recipient is missing");
    const eventType = "appointment.assisted_reschedule_requested";
    const { title, message } = content(eventType, appointment, "patient");
    const inserted = await database.query(
      `INSERT INTO in_app_notifications (recipient_user_id, appointment_id, event_key, event_type, title, message)
       SELECT $1, $2, $3, $4, $5, $6
       WHERE EXISTS (
         SELECT 1 FROM assisted_reschedule_requests request
         JOIN appointments appointment ON appointment.id = request.appointment_id
         JOIN patients patient ON patient.id = request.patient_id
         WHERE request.id = $7 AND request.appointment_id = $2 AND patient.user_id = $1
           AND request.status = 'pending_patient' AND appointment.status = 'confirmed'
           AND request.expires_at > NOW()
           AND appointment.updated_at = request.appointment_updated_at
       )
       ON CONFLICT (recipient_user_id, event_key) DO NOTHING RETURNING id`,
      [recipientUserId, appointment.id, eventKey, eventType, title, message, requestId],
    );
    if (inserted.rows[0]) return { created: true };
    const existing = await database.query(
      "SELECT id FROM in_app_notifications WHERE recipient_user_id = $1 AND event_key = $2",
      [recipientUserId, eventKey],
    );
    if (!existing.rows[0]) return { created: false, skipped: true };
    return { created: false, duplicate: true };
  }

  async function list(userId, { limit, offset }) {
    const [result, counts] = await Promise.all([database.query(
      `SELECT id, appointment_id, event_type, title, message, created_at, read_at
       FROM in_app_notifications WHERE recipient_user_id = $1
       ORDER BY created_at DESC, id DESC LIMIT $2 OFFSET $3`, [userId, limit, offset],
    ), database.query("SELECT COUNT(*)::int AS total_count, COUNT(*) FILTER (WHERE read_at IS NULL)::int AS unread_count FROM in_app_notifications WHERE recipient_user_id = $1", [userId])]);
    return { notifications: result.rows, unreadCount: counts.rows[0].unread_count, totalCount: counts.rows[0].total_count };
  }

  async function markRead(userId, notificationId) {
    const result = await database.query(
      "UPDATE in_app_notifications SET read_at = COALESCE(read_at, NOW()) WHERE id = $1 AND recipient_user_id = $2 RETURNING id, appointment_id, event_type, title, message, created_at, read_at",
      [notificationId, userId],
    );
    return result.rows[0] || null;
  }

  async function markAllRead(userId) {
    const result = await database.query("UPDATE in_app_notifications SET read_at = NOW() WHERE recipient_user_id = $1 AND read_at IS NULL", [userId]);
    return { updated: result.rowCount || 0 };
  }

  return { sendAppointmentNotification, sendReminder, sendAssistedRescheduleRequested, recoverMissingAppointmentNotifications, list, markRead, markAllRead };
}

module.exports = { createInAppNotificationService };
