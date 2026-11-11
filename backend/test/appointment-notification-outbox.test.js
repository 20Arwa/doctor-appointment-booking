const assert = require("node:assert/strict");
const { it } = require("node:test");
const { createAppointmentNotificationOutboxService } = require("../src/services/appointmentNotificationOutboxService");

const event = {
  id: "event-1",
  event_key: "appointment.booked:event-1",
  event_type: "appointment.booked",
  actor_role: "system",
  payload: {
    id: "appointment-1", patient_user_id: "patient-1", doctor_user_id: "doctor-1",
    patient_first_name: "Pia", patient_last_name: "Patient",
  },
  lease_token: "lease-1",
};

it("dispatches an event into existing Email delivery and In-App paths and marks it processed", async () => {
  const calls = [];
  const database = { async query(sql) {
    if (sql.includes("WITH candidates AS")) return { rows: [event] };
    if (sql.includes("SET status = 'processed'")) { calls.push("processed"); return { rows: [] }; }
    throw new Error(`Unexpected query: ${sql}`);
  } };
  const service = createAppointmentNotificationOutboxService({
    database,
    notificationDeliveryService: { async sendAppointmentNotification(input) {
      calls.push(["email", input.eventKey, input.eventType, input.appointment.patient_first_name, input.appointment.patient_last_name]);
      return { outcomes: [{ sent: true }] };
    } },
    inAppNotificationService: { async sendAppointmentNotification(input) { calls.push(["in-app", input.eventKey, input.eventType]); return { failed: 0 }; } },
  });
  assert.deepEqual(await service.runRecovery(), { claimed: 1, processed: 1, pending: 0 });
  assert.deepEqual(calls, [["email", event.event_key, event.event_type, "Pia", "Patient"], ["in-app", event.event_key, event.event_type], "processed"]);
});

it("retries safely after records are created but marking the Outbox row processed fails", async () => {
  let claims = 0;
  let markProcessedFails = true;
  const deliveries = new Set();
  const notifications = new Set();
  const database = { async query(sql) {
    if (sql.includes("WITH candidates AS")) return { rows: claims++ === 0 ? [event] : [{ ...event, lease_token: "lease-2" }] };
    if (sql.includes("SET status = 'processed'")) {
      if (markProcessedFails) { markProcessedFails = false; throw new Error("simulated worker interruption"); }
      return { rows: [] };
    }
    if (sql.includes("SET status = 'pending'")) return { rows: [] };
    throw new Error(`Unexpected query: ${sql}`);
  } };
  const service = createAppointmentNotificationOutboxService({
    database,
    notificationDeliveryService: { async sendAppointmentNotification({ eventKey }) { deliveries.add(`${eventKey}:patient`); deliveries.add(`${eventKey}:doctor`); return { outcomes: [{ sent: true }] }; } },
    inAppNotificationService: { async sendAppointmentNotification({ eventKey }) { notifications.add(`${eventKey}:patient`); notifications.add(`${eventKey}:doctor`); return { failed: 0 }; } },
    logger: { error() {} },
  });
  await service.runRecovery();
  assert.deepEqual(await service.runRecovery(), { claimed: 1, processed: 1, pending: 0 });
  assert.equal(deliveries.size, 2);
  assert.equal(notifications.size, 2);
});

it("leaves an event pending when existing notification records cannot be created", async () => {
  const updates = [];
  const database = { async query(sql) {
    if (sql.includes("WITH candidates AS")) return { rows: [event] };
    if (sql.includes("SET status = 'pending'")) { updates.push("pending"); return { rows: [] }; }
    throw new Error(`Unexpected query: ${sql}`);
  } };
  const service = createAppointmentNotificationOutboxService({
    database,
    notificationDeliveryService: { async sendAppointmentNotification() { return { outcomes: [{ reason: "tracking_unavailable" }] }; } },
    inAppNotificationService: { async sendAppointmentNotification() { return { failed: 1 }; } },
  });
  assert.deepEqual(await service.runRecovery(), { claimed: 1, processed: 0, pending: 1 });
  assert.deepEqual(updates, ["pending"]);
});
