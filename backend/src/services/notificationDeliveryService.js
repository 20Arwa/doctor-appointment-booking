const { createHash, randomUUID } = require("node:crypto");

const SAFE_REASONS = new Set(["timeout", "network_error", "provider_error", "unexpected_error", "missing_configuration", "missing_recipient"]);
const MAX_ATTEMPTS = 5;
const BASE_BACKOFF_MS = 30_000;
const MAX_BACKOFF_MS = 30 * 60_000;
const BREVO_IDEMPOTENCY_TTL_MS = 30 * 60_000;
const PROCESSING_LEASE_MS = 2 * 60_000;
const BATCH_SIZE = 25;

function appointmentPayload(eventType, appointment, recipientType) {
  const action = eventType.slice("appointment.".length);
  const doctor = `Dr. ${[appointment.doctor_first_name, appointment.doctor_last_name].filter(Boolean).join(" ")}`;
  const current = `${appointment.date} at ${String(appointment.start_time || "").slice(0, 5)}`;
  const subject = { booked: "Appointment confirmed", cancelled: "Appointment cancelled", rescheduled: "Appointment rescheduled" }[action];
  const textContent = recipientType === "doctor"
    ? `${action === "booked" ? "A patient booked" : action === "cancelled" ? "A patient cancelled" : "A patient's appointment was rescheduled"} with you. Doctor: ${doctor}. Date: ${appointment.date}. Time: ${String(appointment.start_time || "").slice(0, 5)}.`
    : action === "booked" ? `Your appointment with ${doctor} is confirmed for ${current}.`
      : action === "cancelled" ? `Your appointment with ${doctor} on ${current} has been cancelled.`
        : `Your appointment with ${doctor} has been rescheduled from ${appointment.previous_date} at ${String(appointment.previous_start_time || "").slice(0, 5)} to ${current}.`;
  const recipient = recipientType === "doctor" ? appointment.doctor_email : appointment.patient_email;
  return { to: recipient || null, subject, textContent, sender: { email: null, name: null } };
}

function createNotificationDeliveryService({ database, emailNotificationService, logger = console }) {
  function logTrackingFailure(operation) {
    logger.error("Notification delivery tracking failed", { operation, reason: "database_error" });
  }

  async function createDelivery({ eventKey, eventType, appointment, recipient }) {
    const action = eventType.slice("appointment.".length);
    const payload = typeof emailNotificationService.createNotificationPayload === "function"
      ? emailNotificationService.createNotificationPayload(action, appointment, recipient.type)
      : appointmentPayload(eventType, appointment, recipient.type);
    const idempotencyKey = randomUUID();
    const inserted = await database.query(
      `INSERT INTO notification_deliveries (event_key, event_type, appointment_id, recipient_user_id, payload, idempotency_key, last_attempt_at, lease_token, lease_expires_at)
       SELECT $1, $2, $3, recipient.user_id, $5::jsonb, $6, NOW(), $7, NOW() + ($8 * INTERVAL '1 millisecond')
       FROM (SELECT $4::uuid AS user_id) recipient WHERE $4::uuid IS NOT NULL
       ON CONFLICT (event_key) DO NOTHING RETURNING id, idempotency_key, payload, lease_token`,
      [eventKey, eventType, appointment.id, recipient.userId, JSON.stringify(payload), idempotencyKey, randomUUID(), PROCESSING_LEASE_MS],
    );
    if (inserted.rows[0]) return { ...inserted.rows[0], created: true };
    let existing;
    try { existing = await database.query("SELECT id FROM notification_deliveries WHERE event_key = $1", [eventKey]); }
    catch (_error) { return { created: false, duplicate: true, lookupFailed: true }; }
    if (existing.rows[0]) return { id: existing.rows[0].id, created: false };
    return null;
  }

  async function updateDelivery(id, outcome, leaseToken = null) {
    const attempts = Number.isInteger(outcome.attempts) && outcome.attempts >= 0 ? outcome.attempts : 0;
    const status = outcome.sent ? "accepted" : outcome.skipped ? "skipped" : outcome.ambiguous ? "ambiguous" : "failed";
    const reason = status === "accepted" ? null : SAFE_REASONS.has(outcome.reason) ? outcome.reason : "unexpected_error";
    const providerMessageId = typeof outcome.providerMessageId === "string" && outcome.providerMessageId.length <= 255 ? outcome.providerMessageId : null;
    const providerHttpStatus = Number.isInteger(outcome.status) && outcome.status >= 100 && outcome.status <= 599 ? outcome.status : null;
    const classification = status === "accepted" || status === "skipped" ? null : status === "ambiguous" ? "ambiguous" : outcome.permanent ? "permanent" : "transient";
    await database.query(
      `UPDATE notification_deliveries SET status = $2, attempt_count = attempt_count + $3,
        provider_message_id = $4, reason = $5, provider_http_status = $6, failure_classification = $7,
        next_attempt_at = CASE WHEN $7 = 'transient' AND (attempt_count + $3) < $9
          THEN NOW() + LEAST($8 * POWER(2, GREATEST(attempt_count + $3 - 1, 0)), $10) * INTERVAL '1 millisecond'
          ELSE NULL END,
        last_attempt_at = NOW(), completed_at = NOW(),
        lease_token = NULL, lease_expires_at = NULL
       WHERE id = $1 AND status = 'processing' AND lease_token = $11`,
      [id, status, attempts, providerMessageId, reason, providerHttpStatus, classification, BASE_BACKOFF_MS, MAX_ATTEMPTS, MAX_BACKOFF_MS, leaseToken],
    );
  }

  async function dispatch(row, leaseToken = null) {
    let outcome;
    try {
      outcome = typeof emailNotificationService.sendNotificationPayload === "function"
        ? await emailNotificationService.sendNotificationPayload(row.payload, row.idempotency_key, { maxAttempts: MAX_ATTEMPTS - (row.attempt_count || 0) })
        : await emailNotificationService.sendAppointmentNotification(row.event_type.slice("appointment.".length), row.appointment || {});
      if (!outcome || typeof outcome !== "object") outcome = { sent: true, attempts: 1 };
    } catch (_error) { outcome = { sent: false, ambiguous: true, reason: "unexpected_error", attempts: 1 }; }
    await updateDelivery(row.id, outcome, leaseToken);
    return outcome;
  }

  async function sendAppointmentNotification({ eventKey, eventType, appointment, actorRole = "patient" }) {
    const recipients = [{ type: "patient", userId: appointment.patient_user_id, email: appointment.patient_email }];
    if (eventType !== "appointment.rescheduled" || actorRole !== "doctor") {
      recipients.push({ type: "doctor", userId: appointment.doctor_user_id, email: appointment.doctor_email });
    }
    const outcomes = [];
    for (const recipient of recipients) {
      if (!recipient.userId || !recipient.email) { outcomes.push({ sent: false, skipped: true, reason: "missing_recipient" }); continue; }
      const recipientEventKey = `${eventKey}:${recipient.type}:${recipient.userId}`;
      let delivery;
      try { delivery = await createDelivery({ eventKey: recipientEventKey, eventType, appointment, recipient }); }
      catch (_error) { logTrackingFailure("create"); outcomes.push({ sent: false, skipped: true, reason: "tracking_unavailable" }); continue; }
      if (!delivery) { logTrackingFailure("create"); outcomes.push({ sent: false, skipped: true, reason: "tracking_unavailable" }); continue; }
      if (!delivery.created) {
        if (delivery.lookupFailed) logTrackingFailure("duplicate_check");
        outcomes.push({ sent: false, duplicate: true });
        continue;
      }
      try { outcomes.push(await dispatch({ ...delivery, event_type: eventType, appointment }, delivery.lease_token)); }
      catch (_error) { logTrackingFailure("update"); outcomes.push({ sent: false, ambiguous: true, reason: "unexpected_error" }); }
    }
    const sent = outcomes.some((outcome) => outcome.sent);
    return { sent, duplicate: !sent && outcomes.some((outcome) => outcome.duplicate), outcomes };
  }

  async function runRecovery() {
    const stale = await database.query(
      `UPDATE notification_deliveries SET status = 'ambiguous', failure_classification = 'ambiguous',
         reason = 'unexpected_error', completed_at = NOW(), lease_token = NULL, lease_expires_at = NULL
       WHERE status = 'processing' AND lease_expires_at < NOW() RETURNING id`,
    );
    const expired = await database.query(
      `UPDATE notification_deliveries SET status = 'ambiguous', failure_classification = 'ambiguous',
         reason = 'unexpected_error', completed_at = NOW(), next_attempt_at = NULL
       WHERE status = 'failed' AND failure_classification = 'transient' AND next_attempt_at <= NOW()
         AND (created_at <= NOW() - ($1 * INTERVAL '1 millisecond')
           OR payload IS NULL OR jsonb_typeof(payload) <> 'object'
           OR NOT (payload ?& ARRAY['to', 'subject', 'textContent', 'sender'])
           OR NULLIF(payload->>'to', '') IS NULL OR NULLIF(payload->>'subject', '') IS NULL OR NULLIF(payload->>'textContent', '') IS NULL
           OR jsonb_typeof(payload->'sender') <> 'object'
           OR NULLIF(payload->'sender'->>'email', '') IS NULL OR NULLIF(payload->'sender'->>'name', '') IS NULL
           OR idempotency_key IS NULL)
       RETURNING id`,
      [BREVO_IDEMPOTENCY_TTL_MS],
    );
    const claim = await database.query(
      `WITH candidates AS (
         SELECT id FROM notification_deliveries
         WHERE status = 'failed' AND failure_classification = 'transient' AND attempt_count < $1
           AND next_attempt_at <= NOW() AND created_at > NOW() - ($3 * INTERVAL '1 millisecond')
           AND payload IS NOT NULL AND jsonb_typeof(payload) = 'object'
           AND payload ?& ARRAY['to', 'subject', 'textContent', 'sender']
           AND NULLIF(payload->>'to', '') IS NOT NULL AND NULLIF(payload->>'subject', '') IS NOT NULL AND NULLIF(payload->>'textContent', '') IS NOT NULL
           AND jsonb_typeof(payload->'sender') = 'object'
           AND NULLIF(payload->'sender'->>'email', '') IS NOT NULL AND NULLIF(payload->'sender'->>'name', '') IS NOT NULL
           AND idempotency_key IS NOT NULL
         ORDER BY next_attempt_at, created_at
         LIMIT $2 FOR UPDATE SKIP LOCKED
       )
       UPDATE notification_deliveries d SET status = 'processing', lease_token = gen_random_uuid(),
         lease_expires_at = NOW() + ($4 * INTERVAL '1 millisecond'), next_attempt_at = NULL, completed_at = NULL,
         reason = NULL, provider_http_status = NULL
       FROM candidates c WHERE d.id = c.id
       RETURNING d.id, d.payload, d.idempotency_key, d.lease_token, d.attempt_count, d.created_at`,
      [MAX_ATTEMPTS, BATCH_SIZE, BREVO_IDEMPOTENCY_TTL_MS, PROCESSING_LEASE_MS],
    );
    let retried = 0;
    for (const row of claim.rows) {
      await dispatch(row, row.lease_token);
      retried += 1;
    }
    return { claimed: claim.rows.length, retried, markedAmbiguous: (stale.rowCount || stale.rows.length) + (expired.rowCount || expired.rows.length) };
  }

  return { sendAppointmentNotification, runRecovery };
}

function appointmentEventKey(eventType, appointment) {
  let occurrence;
  if (eventType === "appointment.rescheduled") {
    occurrence = { appointmentId: appointment.id, updatedAt: appointment.reschedule_version || (appointment.updated_at instanceof Date ? appointment.updated_at.toISOString() : appointment.updated_at), previousDate: appointment.previous_date, previousStartTime: appointment.previous_start_time, date: appointment.date, startTime: appointment.start_time };
  } else occurrence = { appointmentId: appointment.id };
  const digest = createHash("sha256").update(JSON.stringify([eventType, occurrence])).digest("hex");
  return `${eventType}:${digest}`;
}

module.exports = { appointmentEventKey, createNotificationDeliveryService, appointmentPayload };
