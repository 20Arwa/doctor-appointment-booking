const EVENT_TYPE = "appointment.assisted_reschedule_requested";
const BATCH_SIZE = 25;
const MAX_ATTEMPTS = 5;
const LEASE_MS = 2 * 60_000;
const BASE_BACKOFF_MS = 30_000;
const MAX_BACKOFF_MS = 30 * 60_000;

function createAssistedRescheduleNotificationService({
  database,
  notificationDeliveryService,
  inAppNotificationService,
  frontendOrigin,
  logger = console,
}) {
  async function claimBatch() {
    await database.query(
      `UPDATE assisted_reschedule_requests request
       SET status = CASE WHEN request.expires_at <= NOW() THEN 'expired' ELSE 'superseded' END,
           notification_status = CASE WHEN notification_status IN ('pending', 'processing', 'failed') THEN 'not_required' ELSE notification_status END,
           notification_next_attempt_at = NULL, notification_lease_token = NULL, notification_lease_expires_at = NULL,
           updated_at = NOW(), responded_at = COALESCE(responded_at, NOW())
       WHERE request.status IN ('pending_patient', 'no_alternatives')
         AND (request.expires_at <= NOW() OR NOT EXISTS (
           SELECT 1 FROM appointments appointment WHERE appointment.id = request.appointment_id
             AND appointment.status = 'confirmed' AND appointment.updated_at = request.appointment_updated_at
         ))`,
    );
    await database.query(
      `UPDATE assisted_reschedule_requests request
       SET notification_status = 'not_required', notification_next_attempt_at = NULL,
           notification_lease_token = NULL, notification_lease_expires_at = NULL, updated_at = NOW()
       WHERE request.notification_status IN ('pending', 'processing', 'failed')
         AND (request.status <> 'pending_patient' OR NOT EXISTS (
           SELECT 1 FROM appointments appointment
           WHERE appointment.id = request.appointment_id AND appointment.status = 'confirmed'
             AND appointment.updated_at = request.appointment_updated_at
         ))`,
    );
    const claimed = await database.query(
      `WITH candidates AS (
         SELECT request.id
         FROM assisted_reschedule_requests request
         JOIN appointments appointment ON appointment.id = request.appointment_id
         WHERE request.status = 'pending_patient'
           AND request.expires_at > NOW()
           AND appointment.status = 'confirmed'
           AND appointment.updated_at = request.appointment_updated_at
           AND request.notification_attempt_count < $1
           AND (
             request.notification_status = 'pending'
             OR (request.notification_status = 'failed' AND request.notification_next_attempt_at <= NOW())
             OR (request.notification_status = 'processing' AND request.notification_lease_expires_at <= NOW())
           )
         ORDER BY COALESCE(request.notification_next_attempt_at, request.created_at), request.id
         LIMIT $2 FOR UPDATE OF request SKIP LOCKED
       )
       UPDATE assisted_reschedule_requests request
       SET notification_status = 'processing', notification_attempt_count = notification_attempt_count + 1,
           notification_next_attempt_at = NULL, notification_lease_token = gen_random_uuid(),
           notification_lease_expires_at = NOW() + ($3 * INTERVAL '1 millisecond'), updated_at = NOW()
       FROM candidates WHERE request.id = candidates.id
       RETURNING request.id, request.notification_lease_token, request.notification_attempt_count` ,
      [MAX_ATTEMPTS, BATCH_SIZE, LEASE_MS],
    );
    return claimed.rows;
  }

  async function getEligibleRequest(requestId) {
    const result = await database.query(
      `SELECT request.id, request.appointment_id, request.patient_id, request.doctor_id,
              request.previous_date::text AS previous_date,
              request.previous_start_time::text AS previous_start_time,
              appointment.updated_at = request.appointment_updated_at AS snapshot_matches,
              appointment.status AS appointment_status,
              request.expires_at,
              patient_user.id AS patient_user_id, patient_user.email AS patient_email,
              doctor_user.first_name AS doctor_first_name, doctor_user.last_name AS doctor_last_name,
              (SELECT COUNT(*)::int FROM assisted_reschedule_suggestions suggestion
               WHERE suggestion.request_id = request.id) AS suggestion_count
       FROM assisted_reschedule_requests request
       JOIN appointments appointment ON appointment.id = request.appointment_id
       JOIN patients patient ON patient.id = request.patient_id
       JOIN users patient_user ON patient_user.id = patient.user_id
       JOIN doctors doctor ON doctor.id = request.doctor_id
       JOIN users doctor_user ON doctor_user.id = doctor.user_id
       WHERE request.id = $1 AND request.status = 'pending_patient'
         AND request.expires_at > NOW()
         AND appointment.status = 'confirmed'
         AND appointment.updated_at = request.appointment_updated_at`,
      [requestId],
    );
    return result.rows[0] || null;
  }

  async function finishLease(requestId, leaseToken, { status, nextAttemptAt = null }) {
    return database.query(
      `UPDATE assisted_reschedule_requests request
       SET notification_status = $3, notification_next_attempt_at = $4::timestamptz,
           notification_lease_token = NULL, notification_lease_expires_at = NULL, updated_at = NOW()
       WHERE request.id = $1 AND request.notification_status = 'processing'
         AND request.notification_lease_token = $2 AND request.status = 'pending_patient'
         AND request.expires_at > NOW()
         AND EXISTS (SELECT 1 FROM appointments appointment
           WHERE appointment.id = request.appointment_id AND appointment.status = 'confirmed'
             AND appointment.updated_at = request.appointment_updated_at)
       RETURNING request.id`,
      [requestId, leaseToken, status, nextAttemptAt],
    );
  }

  async function markIneligible(requestId, leaseToken) {
    await database.query(
      `UPDATE assisted_reschedule_requests
       SET notification_status = 'not_required', notification_next_attempt_at = NULL,
           notification_lease_token = NULL, notification_lease_expires_at = NULL, updated_at = NOW()
       WHERE id = $1 AND notification_status = 'processing' AND notification_lease_token = $2`,
      [requestId, leaseToken],
    );
  }

  async function dispatchRequest(claim) {
    const request = await getEligibleRequest(claim.id);
    if (!request || request.appointment_status !== "confirmed" || request.snapshot_matches !== true) {
      await markIneligible(claim.id, claim.notification_lease_token);
      return { skipped: 1 };
    }
    const appointmentUrl = `${String(frontendOrigin || "").replace(/\/+$/, "")}/patient/appointments?appointment=${encodeURIComponent(request.appointment_id)}`;
    const eventKey = `${EVENT_TYPE}:${request.id}:patient:${request.patient_user_id}`;
    const appointment = {
      id: request.appointment_id,
      patient_email: request.patient_email,
      patient_user_id: request.patient_user_id,
      doctor_first_name: request.doctor_first_name,
      doctor_last_name: request.doctor_last_name,
      previous_date: request.previous_date,
      previous_start_time: request.previous_start_time,
      suggestion_count: request.suggestion_count,
    };

    let emailOutcome = { sent: false, retryable: true };
    let inAppSucceeded = false;
    try {
      emailOutcome = await notificationDeliveryService.sendAssistedRescheduleEmail({
        eventKey, appointment, recipientUserId: request.patient_user_id, appointmentUrl,
      });
    } catch (_error) {
      logger.error("Assisted reschedule Email dispatch failed", { requestId: request.id, reason: "delivery_error" });
    }
    try {
      const inAppOutcome = await inAppNotificationService.sendAssistedRescheduleRequested({
        eventKey, appointment, recipientUserId: request.patient_user_id, requestId: request.id,
      });
      inAppSucceeded = inAppOutcome?.skipped !== true;
    } catch (_error) {
      logger.error("Assisted reschedule In-App dispatch failed", { requestId: request.id, reason: "storage_error" });
    }

    if (emailOutcome.sent && inAppSucceeded) {
      const finalized = await finishLease(claim.id, claim.notification_lease_token, { status: "dispatched" });
      return { dispatched: finalized.rowCount ? 1 : 0 };
    }

    const attempt = claim.notification_attempt_count;
    const hasRetryableChannel = emailOutcome.retryable === true || emailOutcome.status === "processing" || inAppSucceeded === false;
    const canRetry = hasRetryableChannel && attempt < MAX_ATTEMPTS;
    const backoff = Math.min(BASE_BACKOFF_MS * (2 ** Math.max(attempt - 1, 0)), MAX_BACKOFF_MS);
    const nextAttemptAt = canRetry
      ? emailOutcome.nextAttemptAt || new Date(Date.now() + backoff)
      : null;
    const finalized = await finishLease(claim.id, claim.notification_lease_token, {
      status: "failed",
      nextAttemptAt,
    });
    return { failed: finalized.rowCount ? 1 : 0 };
  }

  return {
    async run() {
      const claims = await claimBatch();
      const counts = { claimed: claims.length, dispatched: 0, failed: 0, skipped: 0 };
      for (const claim of claims) {
        try {
          const result = await dispatchRequest(claim);
          for (const key of ["dispatched", "failed", "skipped"]) counts[key] += result[key] || 0;
        } catch (_error) {
          logger.error("Assisted reschedule dispatch processing failed", { requestId: claim.id, reason: "unexpected_error" });
        }
      }
      return counts;
    },
  };
}

module.exports = { createAssistedRescheduleNotificationService };
