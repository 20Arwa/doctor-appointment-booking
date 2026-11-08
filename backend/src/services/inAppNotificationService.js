function content(eventType, appointment, recipientType) {
  const doctor = `Dr. ${[appointment.doctor_first_name, appointment.doctor_last_name].filter(Boolean).join(" ")}`;
  const date = appointment.date;
  const time = String(appointment.start_time || "").slice(0, 5);
  const current = `${date} at ${time}`;
  const action = eventType.slice("appointment.".length);
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
    for (const recipient of recipients) {
      const key = `${eventKey}:${recipient.type}:${recipient.userId}`;
      try { await create({ eventKey: key, eventType, appointment, recipientUserId: recipient.userId, recipientType: recipient.type }); }
      catch (_error) { logger.error("In-App appointment notification failed", { eventType, recipientType: recipient.type, reason: "storage_error" }); }
    }
  }

  async function sendReminder(reminderType, appointment) {
    const eventType = `appointment.reminder.${reminderType}`;
    const eventKey = `${appointment.id}:${eventType}:${appointment.date}:${String(appointment.start_time).slice(0, 8)}`;
    try { await create({ eventKey, eventType, appointment, recipientUserId: appointment.patient_user_id, recipientType: "patient" }); }
    catch (_error) { logger.error("In-App appointment reminder failed", { reminderType, reason: "storage_error" }); }
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

  return { sendAppointmentNotification, sendReminder, list, markRead, markAllRead };
}

module.exports = { createInAppNotificationService };
