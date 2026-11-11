const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { createAppointmentNotificationOutboxService } = require("../src/services/appointmentNotificationOutboxService");
const { enqueueAppointmentNotification } = require("../src/services/appointmentService");

function makeDatabase(events) {
  return {
    async query(sql, values) {
      if (sql.includes("WITH candidates")) {
        return { rows: events.splice(0, 25).map((event) => ({ ...event, lease_token: "lease-1" })) };
      }
      if (sql.includes("SET status = 'processed'")) return { rows: [] };
      if (sql.includes("SET status = 'pending'")) return { rows: [] };
      throw new Error(`Unexpected query: ${sql}`);
    },
  };
}

describe("appointment notification outbox", () => {
  it("creates one idempotent event with the notification snapshot inside the caller transaction", async () => {
    const calls = [];
    const client = { async query(sql, values) { calls.push({ sql, values }); return { rows: [] }; } };
    const appointment = { id: "appointment-1", updated_at: "2026-11-11T10:00:00Z", patient_user_id: "patient-1", doctor_user_id: "doctor-1", patient_email: "patient@example.test", doctor_email: "doctor@example.test", date: "2026-11-12", start_time: "10:00", previous_date: "2026-11-10", previous_start_time: "09:00" };
    await enqueueAppointmentNotification(client, "appointment.rescheduled", appointment, "patient");
    await enqueueAppointmentNotification(client, "appointment.rescheduled", appointment, "patient");
    assert.equal(calls.length, 2);
    assert.match(calls[0].sql, /ON CONFLICT \(event_key\) DO NOTHING/);
    assert.equal(calls[0].values[1], "appointment.rescheduled");
    assert.equal(calls[0].values[2], appointment.id);
    assert.deepEqual(JSON.parse(calls[0].values[4]), { id: appointment.id, updated_at: appointment.updated_at, patient_user_id: "patient-1", doctor_user_id: "doctor-1", patient_email: "patient@example.test", doctor_email: "doctor@example.test", date: "2026-11-12", start_time: "10:00", previous_date: "2026-11-10", previous_start_time: "09:00" });
    assert.equal(calls[0].values[0], calls[1].values[0]);
  });
  it("dispatches claimed events and marks them processed", async () => {
    const updates = [];
    const events = [{ id: "event-1", event_key: "key-1", event_type: "appointment.booked", actor_role: "system", payload: { id: "appointment-1" } }];
    const database = makeDatabase(events);
    const query = database.query;
    database.query = async (sql, values) => { updates.push(sql); return query(sql, values); };
    const service = createAppointmentNotificationOutboxService({
      database,
      notificationDeliveryService: { async sendAppointmentNotification() { return { outcomes: [] }; } },
      inAppNotificationService: { async sendAppointmentNotification() {} },
    });
    assert.deepEqual(await service.runRecovery(), { claimed: 1, processed: 1, pending: 0 });
    assert.ok(updates.some((sql) => sql.includes("SET status = 'processed'")));
  });

  it("releases failed dispatches for retry", async () => {
    let rescheduled = false;
    const database = makeDatabase([{ id: "event-2", event_key: "key-2", event_type: "appointment.cancelled", actor_role: "patient", payload: { id: "appointment-2" } }]);
    const query = database.query;
    database.query = async (sql, values) => { if (sql.includes("SET status = 'pending'")) rescheduled = values[2] === 30_000; return query(sql, values); };
    const service = createAppointmentNotificationOutboxService({ database, notificationDeliveryService: { async sendAppointmentNotification() { throw new Error("offline"); } }, inAppNotificationService: { async sendAppointmentNotification() {} }, logger: { error() {} } });
    assert.deepEqual(await service.runRecovery(), { claimed: 1, processed: 0, pending: 1 });
    assert.equal(rescheduled, true);
  });

  it("treats tracked delivery duplicates as successful idempotent dispatches", async () => {
    const database = makeDatabase([{ id: "event-3", event_key: "key-3", event_type: "appointment.rescheduled", actor_role: "doctor", payload: { id: "appointment-3" } }]);
    const service = createAppointmentNotificationOutboxService({ database, notificationDeliveryService: { async sendAppointmentNotification() { return { duplicate: true, outcomes: [{ duplicate: true }] }; } }, inAppNotificationService: { async sendAppointmentNotification() { return { duplicate: true }; } } });
    assert.deepEqual(await service.runRecovery(), { claimed: 1, processed: 1, pending: 0 });
  });
});
