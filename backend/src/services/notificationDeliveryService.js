const { createHash } = require("node:crypto");

const SAFE_REASONS = new Set([
  "timeout", "network_error", "provider_error", "unexpected_error",
  "missing_configuration", "missing_recipient",
]);

function createNotificationDeliveryService({ database, emailNotificationService, logger = console }) {
  function logTrackingFailure(operation) {
    logger.error("Notification delivery tracking failed", { operation, reason: "database_error" });
  }

  async function createDelivery({ eventKey, eventType, appointment }) {
    const inserted = await database.query(
      `INSERT INTO notification_deliveries (event_key, event_type, appointment_id, recipient_user_id, last_attempt_at)
       SELECT $1, $2, $3, p.user_id, NOW()
       FROM patients p
       WHERE p.id = $4
       ON CONFLICT (event_key) DO NOTHING
       RETURNING id`,
      [eventKey, eventType, appointment.id, appointment.patient_id],
    );
    if (inserted.rows[0]) return { id: inserted.rows[0].id, created: true };

    let existing;
    try {
      existing = await database.query(
        "SELECT id FROM notification_deliveries WHERE event_key = $1",
        [eventKey],
      );
    } catch (_error) {
      // The insert was not ours; fail closed because a duplicate record may exist.
      return { created: false, duplicate: true, lookupFailed: true };
    }
    if (existing.rows[0]) return { id: existing.rows[0].id, created: false };
    return null;
  }

  async function updateDelivery(id, outcome) {
    const attempts = Number.isInteger(outcome.attempts) && outcome.attempts >= 0 ? outcome.attempts : 0;
    const status = outcome.sent ? "accepted" : outcome.skipped ? "skipped" : "failed";
    const reason = status === "accepted" ? null : SAFE_REASONS.has(outcome.reason) ? outcome.reason : "unexpected_error";
    const providerMessageId = typeof outcome.providerMessageId === "string" && outcome.providerMessageId.length <= 255
      ? outcome.providerMessageId
      : null;
    const providerHttpStatus = Number.isInteger(outcome.status) && outcome.status >= 100 && outcome.status <= 599
      ? outcome.status
      : null;

    await database.query(
      `UPDATE notification_deliveries
       SET status = $2, attempt_count = $3, provider_message_id = $4,
           reason = $5, provider_http_status = $6,
           last_attempt_at = CASE WHEN $3 > 0 THEN COALESCE(last_attempt_at, NOW()) ELSE NULL END,
           completed_at = NOW()
       WHERE id = $1 AND status = 'processing'`,
      [id, status, attempts, providerMessageId, reason, providerHttpStatus],
    );
  }

  async function sendAppointmentNotification({ eventKey, eventType, appointment }) {
    let delivery;
    try {
      delivery = await createDelivery({ eventKey, eventType, appointment });
    } catch (_error) {
      logTrackingFailure("create");
      return sendWithoutTracking(eventType, appointment);
    }

    if (!delivery) {
      logTrackingFailure("create");
      return sendWithoutTracking(eventType, appointment);
    }
    if (!delivery.created) {
      if (delivery.lookupFailed) logTrackingFailure("duplicate_check");
      return { sent: false, duplicate: true };
    }

    let outcome;
    try {
      outcome = await emailNotificationService.sendAppointmentNotification(eventType.slice("appointment.".length), appointment);
      if (!outcome || typeof outcome !== "object") outcome = { sent: true, attempts: 1 };
    } catch (_error) {
      outcome = { sent: false, error: true, reason: "unexpected_error", attempts: 0 };
    }

    try {
      await updateDelivery(delivery.id, outcome);
    } catch (_error) {
      logTrackingFailure("update");
    }
    return outcome;
  }

  async function sendWithoutTracking(eventType, appointment) {
    try {
      return await emailNotificationService.sendAppointmentNotification(eventType.slice("appointment.".length), appointment);
    } catch (_error) {
      logger.error("Appointment email notification failed", { eventType, reason: "unexpected_error" });
      return { sent: false, error: true, reason: "unexpected_error", attempts: 0, untracked: true };
    }
  }

  return { sendAppointmentNotification };
}

function appointmentEventKey(eventType, appointment) {
  let occurrence;
  if (eventType === "appointment.rescheduled") {
    // Patient reschedules receive a new appointment ID; doctor reschedules update_at is the persisted row version.
    occurrence = {
      appointmentId: appointment.id,
      updatedAt: appointment.reschedule_version
        || (appointment.updated_at instanceof Date ? appointment.updated_at.toISOString() : appointment.updated_at),
      previousDate: appointment.previous_date,
      previousStartTime: appointment.previous_start_time,
      date: appointment.date,
      startTime: appointment.start_time,
    };
  } else {
    occurrence = { appointmentId: appointment.id };
  }
  const digest = createHash("sha256").update(JSON.stringify([eventType, occurrence])).digest("hex");
  return `${eventType}:${digest}`;
}

module.exports = { appointmentEventKey, createNotificationDeliveryService };
