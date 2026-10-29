const CANDIDATE_SQL = `
  SELECT a.id, a.scheduled_date::text AS date,
         a.scheduled_start_time::text AS start_time,
         d.id AS doctor_id, du.first_name AS doctor_first_name, du.last_name AS doctor_last_name,
         p.id AS patient_id, pu.email AS patient_email
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

function createAppointmentReminderService({ database, emailNotificationService, timeZone, logger = console }) {
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
          let outcome;
          try {
            outcome = await emailNotificationService.sendAppointmentReminder(type, appointment);
          } catch (error) {
            await database.query("DELETE FROM appointment_reminder_deliveries WHERE id = $1 AND status = 'processing'", [claimId]);
            counts.failed += 1;
            logger.error("Appointment reminder delivery failed", { appointmentId: appointment.id, reminderType: type, message: error.message });
            continue;
          }
          if (outcome?.sent) {
            await database.query(
              "UPDATE appointment_reminder_deliveries SET status = 'sent', sent_at = NOW() WHERE id = $1 AND status = 'processing'",
              [claimId],
            );
            counts.sent += 1;
          } else if (outcome?.skipped) {
            await database.query("DELETE FROM appointment_reminder_deliveries WHERE id = $1 AND status = 'processing'", [claimId]);
            counts.skipped += 1;
          } else {
            await database.query("DELETE FROM appointment_reminder_deliveries WHERE id = $1 AND status = 'processing'", [claimId]);
            counts.failed += 1;
            logger.error("Appointment reminder will be retried by the next scheduler run", { appointmentId: appointment.id, reminderType: type });
          }
        }
      }
      return counts;
    },
  };
}

module.exports = { createAppointmentReminderService };
