const BATCH_SIZE = 25;
const LEASE_MS = 2 * 60_000;
const RETRY_MS = 30_000;
const QUEUE_EMAIL_EVENTS = new Set(["appointment.queue_checked_in", "appointment.doctor_ready"]);
const REMINDER_EMAIL_EVENTS = new Set(["appointment.reminder_24h", "appointment.reminder_1h"]);
const MAX_TIMER_DELAY_MS = 2_147_000_000;

function createAppointmentNotificationOutboxService({ database, notificationDeliveryService, inAppNotificationService, logger = console }) {
  let immediateScheduled = false;
  let immediateRunning = null;
  let immediatePromise = null;
  let triggerWhileRunning = false;
  let wakeTimer = null;

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
    const queueEmailEvent = QUEUE_EMAIL_EVENTS.has(event.event_type);
    let succeeded = true;
    try {
      const email = queueEmailEvent
        ? await notificationDeliveryService.sendQueueEventEmail({ eventKey: event.event_key, eventType: event.event_type, appointment })
        : REMINDER_EMAIL_EVENTS.has(event.event_type)
          ? await notificationDeliveryService.sendReminderEmail({ eventKey: event.event_key, eventType: event.event_type, appointment })
        : await notificationDeliveryService.sendAppointmentNotification({
          eventKey: event.event_key,
          eventType: event.event_type,
          appointment,
          actorRole: event.actor_role,
        });
      if (email.retryable || email.outcomes?.some((outcome) => outcome.reason === "tracking_unavailable")) succeeded = false;
    } catch (_error) {
      succeeded = false;
      logger.error("Appointment notification outbox Email dispatch failed", { eventId: event.id });
    }
    try {
      if (queueEmailEvent || REMINDER_EMAIL_EVENTS.has(event.event_type)) {
        await finish(event, succeeded);
        return succeeded;
      }
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

  const service = {
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
      const summary = { claimed: events.length, processed, pending };
      await scheduleNextWake();
      return summary;
    },
    trigger() {
      if (immediateRunning) { triggerWhileRunning = true; return immediateRunning; }
      if (immediateScheduled) return immediatePromise;
      immediateScheduled = true;
      immediatePromise = new Promise((resolve) => {
        setImmediate(() => {
          immediateScheduled = false;
          immediateRunning = this.runRecovery()
            .catch((_error) => {
              logger.error("Immediate appointment notification dispatch failed", { reason: "recovery_error" });
              return null;
            })
            .then((result) => {
              resolve(result);
              return result;
            })
            .finally(() => {
              immediateRunning = null;
              if (triggerWhileRunning) { triggerWhileRunning = false; this.trigger(); }
            });
        });
      });
      return immediatePromise;
    },
    async start() { await scheduleNextWake(); },
  };
  return service;

  async function scheduleNextWake() {
    try {
      const result = await database.query(
        "SELECT MIN(next_attempt_at) AS next_attempt_at FROM appointment_notification_outbox WHERE status = 'pending'",
      );
      const dueAt = result.rows[0]?.next_attempt_at ? new Date(result.rows[0].next_attempt_at).getTime() : null;
      if (wakeTimer) clearTimeout(wakeTimer);
      wakeTimer = null;
      if (dueAt === null || Number.isNaN(dueAt)) return;
      const delay = Math.max(0, Math.min(dueAt - Date.now(), MAX_TIMER_DELAY_MS));
      wakeTimer = setTimeout(() => {
        wakeTimer = null;
        service.trigger();
      }, delay);
      wakeTimer.unref?.();
    } catch (_error) {
      logger.error("Could not schedule the next notification outbox wake", { reason: "database_error" });
    }
  }
}

module.exports = { createAppointmentNotificationOutboxService };
