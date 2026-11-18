const CANDIDATE_SQL = `
  SELECT a.id, a.scheduled_date::text AS date,
         a.scheduled_start_time::text AS start_time,
         d.id AS doctor_id, du.first_name AS doctor_first_name, du.last_name AS doctor_last_name,
         p.id AS patient_id, pu.id AS patient_user_id, pu.email AS patient_email,
         pu.phone AS patient_phone, pu.sms_consent AS patient_sms_consent
  FROM appointments a
  JOIN availability av ON av.id = a.availability_id
  JOIN doctors d ON d.id = av.doctor_id
  JOIN users du ON du.id = d.user_id
  JOIN patients p ON p.id = a.patient_id
  JOIN users pu ON pu.id = p.user_id
  WHERE a.status = 'confirmed'
    AND a.scheduled_date IS NOT NULL AND a.scheduled_start_time IS NOT NULL
    AND ((a.scheduled_date + a.scheduled_start_time) AT TIME ZONE $1)
      BETWEEN NOW() + $2::interval AND NOW() + $2::interval + $3::interval
`;

function reminderSmsMessage(reminderType, appointment) {
  const lead = reminderType === "24h" ? "24-hour" : "1-hour";
  const doctor = `Dr. ${[appointment.doctor_first_name, appointment.doctor_last_name].filter(Boolean).join(" ")}`;
  return `Reminder: your ${lead} appointment with ${doctor} is ${appointment.date} at ${String(appointment.start_time || "").slice(0, 5)}.`;
}

function createAppointmentReminderService({ database, inAppNotificationService, notificationDeliveryService, timeZone = "Asia/Kolkata", logger = console }) {
  return {
    async run() {
      const window = "5 minutes";
      const counts = { considered: 0, smsAttempted: 0, smsFailed: 0 };
      for (const { type, lead } of [{ type: "24h", lead: "24 hours" }, { type: "1h", lead: "1 hour" }]) {
        const candidates = await database.query(CANDIDATE_SQL, [timeZone, lead, window]);
        for (const appointment of candidates.rows) {
          counts.considered += 1;
          try {
            await inAppNotificationService?.sendReminder(type, appointment);
          } catch (_error) {
            logger.error("In-App appointment reminder failed", { reminderType: type, reason: "unexpected_error" });
          }
          if (notificationDeliveryService?.sendSmsDelivery && appointment.patient_user_id) {
            try {
              await notificationDeliveryService.sendSmsDelivery({
                eventKey: `appointment.reminder:${appointment.id}:${type}:${appointment.date}:${appointment.start_time}`,
                eventType: `appointment.reminder_${type}`,
                appointment: { id: appointment.id, date: appointment.date, start_time: appointment.start_time },
                recipient: { type: "patient", userId: appointment.patient_user_id },
                message: reminderSmsMessage(type, appointment),
                payloadExtra: { reminder_type: type, scheduled_date: appointment.date, scheduled_start_time: String(appointment.start_time).slice(0, 8) },
              });
              counts.smsAttempted += 1;
            } catch (_error) {
              counts.smsFailed += 1;
              logger.error("Appointment SMS reminder delivery failed", { appointmentId: appointment.id, reminderType: type, reason: "delivery_error" });
            }
          }
        }
      }
      return counts;
    },
  };
}

module.exports = { CANDIDATE_SQL, createAppointmentReminderService, reminderSmsMessage };
