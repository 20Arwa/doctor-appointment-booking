const { createHash, randomUUID } = require("node:crypto");

const SAFE_REASONS = new Set(["timeout", "network_error", "provider_error", "unexpected_error", "missing_configuration", "missing_recipient", "consent_not_given", "appointment_not_eligible", "phone_changed"]);
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

function appointmentSmsMessage(eventType, appointment, recipientType) {
  const doctor = `Dr. ${[appointment.doctor_first_name, appointment.doctor_last_name].filter(Boolean).join(" ")}`;
  const current = `${appointment.date} at ${String(appointment.start_time || "").slice(0, 5)}`;
  const previous = `${appointment.previous_date} at ${String(appointment.previous_start_time || "").slice(0, 5)}`;
  if (recipientType === "doctor") {
    if (eventType === "appointment.booked") return `New appointment booked with you for ${current}.`;
    if (eventType === "appointment.cancelled") return `An appointment with you on ${current} was cancelled.`;
    return `An appointment with you moved from ${previous} to ${current}.`;
  }
  if (eventType === "appointment.booked") return `Your appointment with ${doctor} is confirmed for ${current}.`;
  if (eventType === "appointment.cancelled") return `Your appointment with ${doctor} on ${current} was cancelled.`;
  return `Your appointment with ${doctor} was rescheduled from ${previous} to ${current}.`;
}

function normalizeSmsPhone(phone) {
  if (typeof phone !== "string") return null;
  const normalized = phone.trim().replace(/[\s().-]/g, "");
  return /^\+[1-9]\d{7,14}$/.test(normalized) ? normalized : null;
}

function validSmsPhone(phone) {
  return normalizeSmsPhone(phone) !== null;
}

function createNotificationDeliveryService({ database, emailNotificationService, smsNotificationService, logger = console }) {
  function logTrackingFailure(operation) {
    logger.error("Notification delivery tracking failed", { operation, reason: "database_error" });
  }

  async function createDelivery({ eventKey, eventType, appointment, recipient, channel = "email", payload: providedPayload }) {
    const action = eventType.slice("appointment.".length);
    const payload = providedPayload || (typeof emailNotificationService.createNotificationPayload === "function"
      ? emailNotificationService.createNotificationPayload(action, appointment, recipient.type)
      : appointmentPayload(eventType, appointment, recipient.type));
    const provider = channel === "sms" ? smsNotificationService?.providerName : "brevo";
    if (channel === "sms" && !provider) throw new Error("SMS provider identity is required for delivery tracking");
    const idempotencyKey = randomUUID();
    const inserted = await database.query(
      `INSERT INTO notification_deliveries (event_key, event_type, appointment_id, recipient_user_id, channel, provider, payload, idempotency_key, last_attempt_at, lease_token, lease_expires_at)
       SELECT $1, $2, $3, recipient.user_id, $5, $6, $7::jsonb, $8, NOW(), $9, NOW() + ($10 * INTERVAL '1 millisecond')
       FROM (SELECT $4::uuid AS user_id) recipient WHERE $4::uuid IS NOT NULL
       ON CONFLICT (event_key, channel) DO NOTHING RETURNING id, channel, provider, idempotency_key, payload, lease_token, appointment_id, recipient_user_id`,
      [eventKey, eventType, appointment.id, recipient.userId, channel, provider, JSON.stringify(payload), idempotencyKey, randomUUID(), PROCESSING_LEASE_MS],
    );
    if (inserted.rows[0]) return { ...inserted.rows[0], created: true };
    let existing;
    try { existing = await database.query("SELECT id FROM notification_deliveries WHERE event_key = $1 AND channel = $2", [eventKey, channel]); }
    catch (_error) { return { created: false, duplicate: true, lookupFailed: true }; }
    if (existing.rows[0]) return { id: existing.rows[0].id, created: false };
    return null;
  }

  async function updateDelivery(id, outcome, leaseToken = null) {
    const attempts = Number.isInteger(outcome.attempts) && outcome.attempts >= 0 ? outcome.attempts : 0;
    const status = outcome.status === "simulated" || outcome.simulated ? "simulated" : outcome.sent ? "accepted" : outcome.skipped ? "skipped" : outcome.ambiguous ? "ambiguous" : "failed";
    const reason = status === "accepted" ? null : status === "simulated" ? "simulated" : SAFE_REASONS.has(outcome.reason) ? outcome.reason : "unexpected_error";
    const providerMessageId = typeof outcome.providerMessageId === "string" && outcome.providerMessageId.length <= 255 ? outcome.providerMessageId : null;
    const providerHttpStatus = Number.isInteger(outcome.status) && outcome.status >= 100 && outcome.status <= 599 ? outcome.status : null;
    const classification = status === "accepted" || status === "skipped" || status === "simulated" ? null : status === "ambiguous" ? "ambiguous" : outcome.permanent ? "permanent" : "transient";
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
      if (row.channel === "sms") {
        if (row.event_type === "appointment.assisted_reschedule_requested") {
          outcome = { sent: false, skipped: true, reason: "appointment_not_eligible", attempts: 0 };
        } else
        if (row.event_type === "appointment.reminder_24h" || row.event_type === "appointment.reminder_1h") {
          let current;
          try {
            current = await database.query(
              `SELECT a.status, a.scheduled_date::text AS date, a.scheduled_start_time::text AS start_time,
                      u.phone, u.sms_consent
               FROM appointments a
               JOIN patients p ON p.id = a.patient_id
               JOIN users u ON u.id = p.user_id
               WHERE a.id = $1 AND u.id = $2`,
              [row.appointment_id, row.recipient_user_id],
            );
          } catch (_error) {
            outcome = { sent: false, reason: "unexpected_error", attempts: 1 };
          }
          if (!outcome) {
            const currentAppointment = current.rows[0];
            const snapshotMatches = currentAppointment?.date === row.payload.scheduled_date
              && String(currentAppointment?.start_time || "").slice(0, 8) === row.payload.scheduled_start_time;
            if (!currentAppointment || currentAppointment.status !== "confirmed" || !snapshotMatches) {
              outcome = { sent: false, skipped: true, reason: "appointment_not_eligible", attempts: 0 };
            } else if (currentAppointment.sms_consent !== true) {
              outcome = { sent: false, skipped: true, reason: "consent_not_given", attempts: 0 };
            } else if (!normalizeSmsPhone(currentAppointment.phone)) {
              outcome = { sent: false, skipped: true, reason: "missing_recipient", attempts: 0 };
            } else {
              // Reminders use the current profile destination after validating current consent and schedule.
              row.payload.to = normalizeSmsPhone(currentAppointment.phone);
            }
          }
        } else {
          let current;
          try {
            current = await database.query(
              "SELECT phone, sms_consent FROM users WHERE id = $1",
              [row.recipient_user_id],
            );
          } catch (_error) {
            outcome = { sent: false, reason: "unexpected_error", attempts: 1 };
          }
          if (!outcome) {
            const preference = current.rows[0];
            const currentPhone = normalizeSmsPhone(preference?.phone);
            const storedPhone = normalizeSmsPhone(row.payload.original_to || row.payload.to);
            if (!preference) {
              outcome = { sent: false, skipped: true, reason: "missing_recipient", attempts: 0 };
            } else if (preference.sms_consent !== true) {
              outcome = { sent: false, skipped: true, reason: "consent_not_given", attempts: 0 };
            } else if (!currentPhone) {
              outcome = { sent: false, skipped: true, reason: "missing_recipient", attempts: 0 };
            } else if (storedPhone && storedPhone !== currentPhone) {
              outcome = { sent: false, skipped: true, reason: "phone_changed", attempts: 0 };
            } else {
              if (!storedPhone) {
                row.payload.original_to = currentPhone;
                row.payload.to = currentPhone;
                delete row.payload.eligibility_lookup_pending;
                try {
                  const persisted = await database.query(
                    `UPDATE notification_deliveries SET payload = $2::jsonb
                     WHERE id = $1 AND status = 'processing' AND lease_token = $3 RETURNING id`,
                    [row.id, JSON.stringify(row.payload), leaseToken],
                  );
                  if (!persisted.rows[0]) outcome = { sent: false, ambiguous: true, reason: "unexpected_error", attempts: 0 };
                } catch (_error) {
                  outcome = { sent: false, reason: "unexpected_error", attempts: 1 };
                }
              }
            }
          }
        }
        if (!outcome) {
          if (!smsNotificationService) {
            outcome = { sent: false, skipped: true, reason: "missing_configuration", attempts: 0 };
          } else if (typeof smsNotificationService.hasProvider === "function"
            ? !smsNotificationService.hasProvider(row.provider)
            : smsNotificationService.providerName !== row.provider) {
            outcome = { sent: false, permanent: true, reason: "missing_configuration", attempts: 0 };
          } else {
            outcome = await smsNotificationService.sendSms(
              row.payload,
              row.idempotency_key,
              { maxAttempts: MAX_ATTEMPTS - (row.attempt_count || 0), providerName: row.provider },
            );
          }
        }
      } else {
        if (row.event_type === "appointment.assisted_reschedule_requested") {
          try {
            const eligible = await database.query(
              `SELECT 1 FROM assisted_reschedule_requests request
               JOIN appointments appointment ON appointment.id = request.appointment_id
               JOIN patients patient ON patient.id = request.patient_id
               WHERE request.appointment_id = $1 AND patient.user_id = $2
                 AND request.status = 'pending_patient' AND request.expires_at > NOW()
                 AND appointment.status = 'confirmed' AND appointment.updated_at = request.appointment_updated_at LIMIT 1`,
              [row.appointment_id, row.recipient_user_id],
            );
            if (!eligible.rows[0]) outcome = { sent: false, skipped: true, reason: "appointment_not_eligible", attempts: 0 };
          } catch (_error) { outcome = { sent: false, reason: "unexpected_error", attempts: 1 }; }
        }
        if (!outcome) outcome = typeof emailNotificationService.sendNotificationPayload === "function"
          ? await emailNotificationService.sendNotificationPayload(row.payload, row.idempotency_key, { maxAttempts: MAX_ATTEMPTS - (row.attempt_count || 0) })
          : await emailNotificationService.sendAppointmentNotification(row.event_type.slice("appointment.".length), row.appointment || {});
      }
      if (!outcome || typeof outcome !== "object") outcome = { sent: true, attempts: 1 };
    } catch (_error) { outcome = { sent: false, ambiguous: true, reason: "unexpected_error", attempts: 1 }; }
    await updateDelivery(row.id, outcome, leaseToken);
    return outcome;
  }

  async function sendAppointmentNotification({ eventKey, eventType, appointment, actorRole = "patient" }) {
    if (eventType === "appointment.assisted_reschedule_requested") return { sent: false, skipped: true, reason: "dedicated_dispatch_required", outcomes: [] };
    const recipients = [{ type: "patient", userId: appointment.patient_user_id, email: appointment.patient_email }];
    if (eventType !== "appointment.rescheduled" || actorRole !== "doctor") {
      recipients.push({ type: "doctor", userId: appointment.doctor_user_id, email: appointment.doctor_email });
    }
    const outcomes = [];
    for (const recipient of recipients) {
      const recipientEventKey = `${eventKey}:${recipient.type}:${recipient.userId}`;
      if (!recipient.userId || !recipient.email) {
        outcomes.push({ sent: false, skipped: true, reason: "missing_recipient", channel: "email" });
      } else {
        let delivery;
        let creationFailed = false;
        try { delivery = await createDelivery({ eventKey: recipientEventKey, eventType, appointment, recipient }); }
        catch (_error) { creationFailed = true; logTrackingFailure("create"); }
        if (!delivery) {
          if (!creationFailed) logTrackingFailure("create");
          outcomes.push({ sent: false, skipped: true, reason: "tracking_unavailable", channel: "email" });
        } else if (!delivery.created) {
          if (delivery.lookupFailed) logTrackingFailure("duplicate_check");
          outcomes.push({ sent: false, duplicate: true, channel: "email" });
        } else {
          try { outcomes.push({ ...(await dispatch({ ...delivery, event_type: eventType, appointment }, delivery.lease_token)), channel: "email" }); }
          catch (_error) { logTrackingFailure("update"); outcomes.push({ sent: false, ambiguous: true, reason: "unexpected_error", channel: "email" }); }
        }
      }

      if (smsNotificationService && recipient.userId) {
        try {
          outcomes.push({
            ...(await sendSmsDelivery({
              eventKey,
              eventType,
              appointment,
              recipient,
              deferEligibility: true,
              message: appointmentSmsMessage(eventType, appointment, recipient.type),
            })),
            channel: "sms",
          });
        } catch (_error) {
          logTrackingFailure("sms_delivery");
          outcomes.push({ sent: false, ambiguous: true, reason: "unexpected_error", channel: "sms" });
        }
      }
    }
    const sent = outcomes.some((outcome) => outcome.sent);
    return { sent, duplicate: !sent && outcomes.some((outcome) => outcome.duplicate), outcomes };
  }

  async function sendAssistedRescheduleEmail({ eventKey, appointment, recipientUserId, appointmentUrl }) {
    const eventType = "appointment.assisted_reschedule_requested";
    const recipient = { type: "patient", userId: recipientUserId, email: appointment.patient_email };
    if (!recipient.userId || !recipient.email) return { sent: false, skipped: true, reason: "missing_recipient" };
    if (typeof emailNotificationService.createAssistedReschedulePayload !== "function") {
      throw new TypeError("Email service does not support assisted reschedule notifications");
    }
    const payload = emailNotificationService.createAssistedReschedulePayload(appointment, appointmentUrl);
    const delivery = await createDelivery({ eventKey, eventType, appointment, recipient, payload });
    if (!delivery) return { sent: false, reason: "tracking_unavailable" };
    if (delivery.created) {
      const outcome = await dispatch({ ...delivery, event_type: eventType, appointment }, delivery.lease_token);
      return { ...outcome, retryable: !outcome.sent && !outcome.skipped && !outcome.ambiguous && !outcome.permanent };
    }
    const existing = await database.query(
      "SELECT status, failure_classification, next_attempt_at, lease_expires_at FROM notification_deliveries WHERE event_key = $1 AND channel = 'email'",
      [eventKey],
    );
    const row = existing.rows[0];
    if (row?.status === "accepted") return { sent: true, duplicate: true };
    return { sent: false, duplicate: true, status: row?.status || "missing",
      retryable: row?.status === "failed" && row.failure_classification === "transient",
      nextAttemptAt: row?.next_attempt_at || row?.lease_expires_at || null };
  }

  // Records each event's SMS delivery independently from its email delivery.
  async function sendSmsDelivery({ eventKey, eventType, appointment, recipient, to, consent = false, deferEligibility = false, message, payloadExtra = {} }) {
    if (eventType === "appointment.assisted_reschedule_requested") return { sent: false, skipped: true, reason: "appointment_not_eligible" };
    if (!recipient?.userId || !message) return { sent: false, skipped: true, reason: "missing_recipient" };
    const isReminder = eventType === "appointment.reminder_24h" || eventType === "appointment.reminder_1h";
    const resolveEligibilityAtDispatch = deferEligibility || isReminder;
    const eligiblePhone = resolveEligibilityAtDispatch ? null : normalizeSmsPhone(to);
    const skipReason = resolveEligibilityAtDispatch ? null : consent !== true ? "consent_not_given" : eligiblePhone ? null : "missing_recipient";
    const recipientEventKey = `${eventKey}:${recipient.type}:${recipient.userId}`;
    const payload = {
      to: skipReason || resolveEligibilityAtDispatch ? null : eligiblePhone,
      original_to: skipReason || resolveEligibilityAtDispatch ? null : eligiblePhone,
      recipient_user_id: recipient.userId,
      message,
      ...(resolveEligibilityAtDispatch ? { eligibility_lookup_pending: true } : {}),
      ...payloadExtra,
    };
    let delivery;
    try {
      delivery = await createDelivery({ eventKey: recipientEventKey, eventType, appointment, recipient, channel: "sms", payload });
    } catch (_error) {
      logTrackingFailure("create");
      return { sent: false, skipped: true, reason: "tracking_unavailable" };
    }
    if (!delivery) return { sent: false, skipped: true, reason: "tracking_unavailable" };
    if (!delivery.created) return { sent: false, duplicate: true };
    if (skipReason) {
      await updateDelivery(delivery.id, { sent: false, skipped: true, reason: skipReason, attempts: 0 }, delivery.lease_token);
      return { sent: false, skipped: true, reason: skipReason };
    }
    return dispatch({ ...delivery, channel: "sms", event_type: eventType, appointment }, delivery.lease_token);
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
           OR (channel = 'email' AND (payload IS NULL OR jsonb_typeof(payload) <> 'object'
           OR NOT (payload ?& ARRAY['to', 'subject', 'textContent', 'sender'])
           OR NULLIF(payload->>'to', '') IS NULL OR NULLIF(payload->>'subject', '') IS NULL OR NULLIF(payload->>'textContent', '') IS NULL
           OR jsonb_typeof(payload->'sender') <> 'object'
           OR NULLIF(payload->'sender'->>'email', '') IS NULL OR NULLIF(payload->'sender'->>'name', '') IS NULL))
          OR (channel = 'sms' AND (payload IS NULL OR jsonb_typeof(payload) <> 'object'
           OR NOT (payload ?& ARRAY['to', 'message'])
           OR (NULLIF(payload->>'to', '') IS NULL AND payload->>'eligibility_lookup_pending' IS DISTINCT FROM 'true')
           OR NULLIF(payload->>'message', '') IS NULL))
           OR idempotency_key IS NULL)
       RETURNING id`,
      [BREVO_IDEMPOTENCY_TTL_MS],
    );
    const claim = await database.query(
      `WITH candidates AS (
         SELECT id FROM notification_deliveries
         WHERE status = 'failed' AND failure_classification = 'transient' AND attempt_count < $1
           AND next_attempt_at <= NOW() AND created_at > NOW() - ($3 * INTERVAL '1 millisecond')
           AND ((channel = 'email' AND payload IS NOT NULL AND jsonb_typeof(payload) = 'object'
             AND payload ?& ARRAY['to', 'subject', 'textContent', 'sender']
             AND NULLIF(payload->>'to', '') IS NOT NULL AND NULLIF(payload->>'subject', '') IS NOT NULL AND NULLIF(payload->>'textContent', '') IS NOT NULL
             AND jsonb_typeof(payload->'sender') = 'object'
             AND NULLIF(payload->'sender'->>'email', '') IS NOT NULL AND NULLIF(payload->'sender'->>'name', '') IS NOT NULL)
             OR (channel = 'sms' AND payload IS NOT NULL AND jsonb_typeof(payload) = 'object'
             AND payload ?& ARRAY['to', 'message']
             AND (NULLIF(payload->>'to', '') IS NOT NULL OR payload->>'eligibility_lookup_pending' = 'true')
             AND NULLIF(payload->>'message', '') IS NOT NULL))
           AND idempotency_key IS NOT NULL
         ORDER BY next_attempt_at, created_at
         LIMIT $2 FOR UPDATE SKIP LOCKED
       )
       UPDATE notification_deliveries d SET status = 'processing', lease_token = gen_random_uuid(),
         lease_expires_at = NOW() + ($4 * INTERVAL '1 millisecond'), next_attempt_at = NULL, completed_at = NULL,
         reason = NULL, provider_http_status = NULL
       FROM candidates c WHERE d.id = c.id
      RETURNING d.id, d.channel, d.provider, d.payload, d.idempotency_key, d.lease_token, d.attempt_count, d.created_at, d.appointment_id, d.recipient_user_id, d.event_type`,
      [MAX_ATTEMPTS, BATCH_SIZE, BREVO_IDEMPOTENCY_TTL_MS, PROCESSING_LEASE_MS],
    );
    let retried = 0;
    for (const row of claim.rows) {
      await dispatch(row, row.lease_token);
      retried += 1;
    }
    return { claimed: claim.rows.length, retried, markedAmbiguous: (stale.rowCount || stale.rows.length) + (expired.rowCount || expired.rows.length) };
  }

  return { sendAppointmentNotification, sendAssistedRescheduleEmail, sendSmsDelivery, runRecovery };
}

function appointmentEventKey(eventType, appointment) {
  let occurrence;
  if (eventType === "appointment.rescheduled") {
    occurrence = { appointmentId: appointment.id, updatedAt: appointment.reschedule_version || (appointment.updated_at instanceof Date ? appointment.updated_at.toISOString() : appointment.updated_at), previousDate: appointment.previous_date, previousStartTime: appointment.previous_start_time, date: appointment.date, startTime: appointment.start_time };
  } else occurrence = { appointmentId: appointment.id };
  const digest = createHash("sha256").update(JSON.stringify([eventType, occurrence])).digest("hex");
  return `${eventType}:${digest}`;
}

module.exports = { appointmentEventKey, appointmentPayload, appointmentSmsMessage, createNotificationDeliveryService, normalizeSmsPhone, validSmsPhone };
