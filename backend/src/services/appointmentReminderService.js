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

async function claimReminder(database, appointment, reminderType, lead, timeZone, window) {
  const result = await database.query(
    `INSERT INTO appointment_reminder_deliveries
       (appointment_id, reminder_type, scheduled_date, scheduled_start_time)
     SELECT a.id, $2, a.scheduled_date, a.scheduled_start_time
     FROM appointments a
     WHERE a.id = $1 AND a.status = 'confirmed'
       AND a.scheduled_date = $3::date AND a.scheduled_start_time = $4::time
       AND ((a.scheduled_date + a.scheduled_start_time) AT TIME ZONE $5)
         BETWEEN NOW() + $6::interval AND NOW() + $6::interval + $7::interval
     ON CONFLICT (appointment_id, reminder_type, scheduled_date, scheduled_start_time)
     DO UPDATE SET status = 'processing', lease_expires_at = NOW() + INTERVAL '10 minutes'
       WHERE appointment_reminder_deliveries.status = 'processing'
         AND appointment_reminder_deliveries.lease_expires_at < NOW()
     RETURNING id`,
    [appointment.id, reminderType, appointment.date, appointment.start_time, timeZone, lead, window],
  );
  return result.rows[0]?.id ?? null;
}

function reminderSmsMessage(reminderType, appointment) {
  const lead = reminderType === "24h" ? "24-hour" : "1-hour";
  const doctor = `Dr. ${[appointment.doctor_first_name, appointment.doctor_last_name].filter(Boolean).join(" ")}`;
  return `Reminder: your ${lead} appointment with ${doctor} is ${appointment.date} at ${String(appointment.start_time || "").slice(0, 5)}.`;
}

function createAppointmentReminderService({ database, emailNotificationService, notificationDeliveryService, timeZone = "Asia/Kolkata", logger = console }) {
  return {
    async run() {
      // The database clock drives eligibility and leases to keep all scheduler instances consistent.
      const window = "5 minutes";
      const counts = { considered: 0, sent: 0, skipped: 0, failed: 0 };
      for (const { type, lead } of [{ type: "24h", lead: "24 hours" }, { type: "1h", lead: "1 hour" }]) {
        const candidates = await database.query(CANDIDATE_SQL, [timeZone, lead, window]);
        for (const appointment of candidates.rows) {
          counts.considered += 1;
          const claimId = await claimReminder(database, appointment, type, lead, timeZone, window);
          if (!claimId) { counts.skipped += 1; continue; }

          let emailOutcome;
          let emailThrew = false;
          try {
            emailOutcome = await emailNotificationService.sendAppointmentReminder(type, appointment);
          } catch (error) {
            emailThrew = true;
            await database.query("DELETE FROM appointment_reminder_deliveries WHERE id = $1 AND status = 'processing'", [claimId]);
            counts.failed += 1;
            logger.error("Appointment reminder delivery failed", { appointmentId: appointment.id, reminderType: type, message: error.message });
          }
          if (emailOutcome?.sent) {
            await database.query(
              "UPDATE appointment_reminder_deliveries SET status = 'sent', sent_at = NOW() WHERE id = $1 AND status = 'processing'",
              [claimId],
            );
            counts.sent += 1;
          } else if (!emailOutcome?.sent && emailOutcome?.skipped) {
            await database.query("DELETE FROM appointment_reminder_deliveries WHERE id = $1 AND status = 'processing'", [claimId]);
            counts.skipped += 1;
          } else if (!emailThrew) {
            await database.query("DELETE FROM appointment_reminder_deliveries WHERE id = $1 AND status = 'processing'", [claimId]);
            counts.failed += 1;
            logger.error("Appointment reminder will be retried by the next scheduler run", { appointmentId: appointment.id, reminderType: type });
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
            } catch (error) {
              logger.error("Appointment SMS reminder delivery failed", { appointmentId: appointment.id, reminderType: type, message: error.message });
            }
          }
        }
      }
      return counts;
    },
  };
}

module.exports = { createAppointmentReminderService, reminderSmsMessage };
