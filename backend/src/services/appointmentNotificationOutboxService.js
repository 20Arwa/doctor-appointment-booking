const BATCH_SIZE = 25;
const LEASE_MS = 2 * 60_000;
const RETRY_MS = 30_000;

function createAppointmentNotificationOutboxService({ database, notificationDeliveryService, inAppNotificationService, logger = console }) {
  async function claimBatch() {
    const result = await database.query(
      `WITH candidates AS (
         SELECT id FROM appointment_notification_outbox
         WHERE (status = 'pending' AND next_attempt_at <= NOW())
            OR (status = 'processing' AND lease_expires_at <= NOW())
         ORDER BY created_at, id
         LIMIT $1 FOR UPDATE SKIP LOCKED
       )
       UPDATE appointment_notification_outbox event
       SET status = 'processing', attempt_count = attempt_count + 1,
           lease_token = gen_random_uuid(), lease_expires_at = NOW() + ($2 * INTERVAL '1 millisecond')
       FROM candidates WHERE event.id = candidates.id
       RETURNING event.id, event.event_key, event.event_type, event.actor_role, event.payload, event.lease_token`,
      [BATCH_SIZE, LEASE_MS],
    );
    return result.rows;
  }

  async function finish(event, succeeded) {
    if (succeeded) {
      await database.query(
        `UPDATE appointment_notification_outbox SET status = 'processed', processed_at = NOW(),
           lease_token = NULL, lease_expires_at = NULL
         WHERE id = $1 AND status = 'processing' AND lease_token = $2`,
        [event.id, event.lease_token],
      );
      return;
    }
    await database.query(
      `UPDATE appointment_notification_outbox SET status = 'pending',
         next_attempt_at = NOW() + ($3 * INTERVAL '1 millisecond'),
         lease_token = NULL, lease_expires_at = NULL
       WHERE id = $1 AND status = 'processing' AND lease_token = $2`,
      [event.id, event.lease_token, RETRY_MS],
    );
  }

  async function dispatch(event) {
    const appointment = event.payload;
    let succeeded = true;
    try {
      const email = await notificationDeliveryService.sendAppointmentNotification({
        eventKey: event.event_key,
        eventType: event.event_type,
        appointment,
        actorRole: event.actor_role,
      });
      if (email.outcomes?.some((outcome) => outcome.reason === "tracking_unavailable")) succeeded = false;
    } catch (_error) {
      succeeded = false;
      logger.error("Appointment notification outbox Email dispatch failed", { eventId: event.id });
    }
    try {
      const inApp = await inAppNotificationService.sendAppointmentNotification({
        eventKey: event.event_key,
        eventType: event.event_type,
        appointment,
        actorRole: event.actor_role,
      });
      if (inApp?.failed) succeeded = false;
    } catch (_error) {
      succeeded = false;
      logger.error("Appointment notification outbox In-App dispatch failed", { eventId: event.id });
    }
    await finish(event, succeeded);
    return succeeded;
  }

  return {
    async runRecovery() {
      const events = await claimBatch();
      let processed = 0;
      let pending = 0;
      for (const event of events) {
        try {
          if (await dispatch(event)) processed += 1;
          else pending += 1;
        } catch (_error) {
          pending += 1;
          logger.error("Appointment notification outbox processing failed", { eventId: event.id });
          await finish(event, false).catch(() => {});
        }
      }
      return { claimed: events.length, processed, pending };
    },
  };
}

module.exports = { createAppointmentNotificationOutboxService };
