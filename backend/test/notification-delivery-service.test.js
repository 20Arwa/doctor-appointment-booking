const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { describe, it } = require("node:test");
const { appointmentEventKey, createNotificationDeliveryService } = require("../src/services/notificationDeliveryService");

const appointment = {
  id: "11111111-1111-4111-8111-111111111111",
  patient_id: "22222222-2222-4222-8222-222222222222",
  updated_at: "2099-01-01T00:00:00.000Z",
  date: "2099-04-10", start_time: "10:00:00",
  previous_date: "2099-04-09", previous_start_time: "09:00:00",
};
const recipientUserId = "33333333-3333-4333-8333-333333333333";

function createDatabase({ failInsert = false } = {}) {
  const records = new Map();
  let nextId = 1;
  return {
    records,
    async query(sql, values = []) {
      if (sql.startsWith("INSERT INTO notification_deliveries")) {
        if (failInsert) throw new Error("database credentials or private details");
        const [eventKey, eventType, appointmentId] = values;
        if (records.has(eventKey)) return { rows: [] };
        const record = { id: nextId++, event_key: eventKey, event_type: eventType, appointment_id: appointmentId, recipient_user_id: recipientUserId, status: "processing", attempt_count: 0 };
        records.set(eventKey, record);
        return { rows: [{ id: record.id }] };
      }
      if (sql.startsWith("SELECT id FROM notification_deliveries")) {
        const record = records.get(values[0]);
        return { rows: record ? [{ id: record.id }] : [] };
      }
      if (sql.startsWith("UPDATE notification_deliveries")) {
        const [, status, attemptCount, providerMessageId, reason, providerHttpStatus] = values;
        const record = [...records.values()].find(({ id }) => id === values[0]);
        if (record) Object.assign(record, { status, attempt_count: attemptCount, provider_message_id: providerMessageId, reason, provider_http_status: providerHttpStatus, completed: true });
        return { rows: [] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
  };
}

function createHarness({ outcome = { sent: true, attempts: 1, providerMessageId: "brevo-id" }, failInsert = false } = {}) {
  const database = createDatabase({ failInsert });
  const sent = [];
  const logs = [];
  const service = createNotificationDeliveryService({
    database,
    emailNotificationService: { async sendAppointmentNotification(action, item) { sent.push([action, item.id]); return outcome; } },
    logger: { error: (...args) => logs.push(args) },
  });
  return { database, sent, logs, service };
}

describe("notification delivery persistence", () => {
  it("defines event, recipient, provider, status, and history constraints in a migration", () => {
    const migration = fs.readFileSync(path.join(__dirname, "..", "migrations", "013_notification_deliveries.sql"), "utf8");
    assert.match(migration, /event_key TEXT NOT NULL UNIQUE/i);
    assert.match(migration, /recipient_user_id UUID NOT NULL REFERENCES users\(id\) ON DELETE RESTRICT/i);
    assert.match(migration, /appointment_id UUID NOT NULL REFERENCES appointments\(id\) ON DELETE RESTRICT/i);
    assert.match(migration, /'appointment\.booked'.*'appointment\.cancelled'.*'appointment\.rescheduled'/is);
    assert.match(migration, /'processing'.*'accepted'.*'failed'.*'skipped'/is);
    assert.doesNotMatch(migration, /recipient_email|text_content|html_content/i);
  });

  it("records accepted deliveries, message IDs, and actual transport attempt counts", async () => {
    const harness = createHarness({ outcome: { sent: true, attempts: 2, providerMessageId: "brevo-accepted-id", status: 201 } });
    const result = await harness.service.sendAppointmentNotification({ eventKey: "booked:key", eventType: "appointment.booked", appointment });
    const record = harness.database.records.get("booked:key");
    assert.equal(result.sent, true);
    assert.equal(record.status, "accepted");
    assert.equal(record.attempt_count, 2);
    assert.equal(record.provider_message_id, "brevo-accepted-id");
    assert.equal(record.provider_http_status, 201);
    assert.equal(record.completed, true);
    assert.equal(record.recipient_user_id, recipientUserId);
  });

  it("records failed and skipped outcomes with sanitized reasons and status", async () => {
    const failed = createHarness({ outcome: { sent: false, error: true, reason: "provider_error", attempts: 2, status: 503 } });
    await failed.service.sendAppointmentNotification({ eventKey: "failed:key", eventType: "appointment.cancelled", appointment });
    const failedRecord = failed.database.records.get("failed:key");
    assert.equal(failedRecord.status, "failed");
    assert.equal(failedRecord.reason, "provider_error");
    assert.equal(failedRecord.provider_http_status, 503);
    assert.equal(failedRecord.attempt_count, 2);

    const skipped = createHarness({ outcome: { sent: false, skipped: true, reason: "missing_configuration", attempts: 0 } });
    await skipped.service.sendAppointmentNotification({ eventKey: "skipped:key", eventType: "appointment.rescheduled", appointment });
    const skippedRecord = skipped.database.records.get("skipped:key");
    assert.equal(skippedRecord.status, "skipped");
    assert.equal(skippedRecord.reason, "missing_configuration");
    assert.equal(skippedRecord.attempt_count, 0);
  });

  it("prevents duplicate sends for existing records in processing and finalized states", async () => {
    for (const status of ["processing", "accepted", "failed", "skipped"]) {
      const harness = createHarness();
      harness.database.records.set("same:event", { id: status, status });
      const result = await harness.service.sendAppointmentNotification({ eventKey: "same:event", eventType: "appointment.booked", appointment });
      assert.equal(result.duplicate, true);
      assert.equal(harness.sent.length, 0);
    }
  });

  it("uses the unique event key to allow only one concurrent send", async () => {
    const harness = createHarness();
    const input = { eventKey: "concurrent:event", eventType: "appointment.booked", appointment };
    const outcomes = await Promise.all([
      harness.service.sendAppointmentNotification(input),
      harness.service.sendAppointmentNotification(input),
    ]);
    assert.equal(harness.sent.length, 1);
    assert.equal(outcomes.filter(({ duplicate }) => duplicate).length, 1);
  });

  it("falls back to one untracked email when delivery record creation fails", async () => {
    const harness = createHarness({ failInsert: true });
    const result = await harness.service.sendAppointmentNotification({ eventKey: "untracked:event", eventType: "appointment.booked", appointment });
    assert.equal(result.sent, true);
    assert.equal(result.sent, true);
    assert.equal(harness.sent.length, 1);
    assert.deepEqual(harness.logs[0], ["Notification delivery tracking failed", { operation: "create", reason: "database_error" }]);
  });

  it("uses deterministic distinct occurrence keys for separate reschedules", () => {
    const firstKey = appointmentEventKey("appointment.rescheduled", appointment);
    assert.equal(appointmentEventKey("appointment.rescheduled", appointment), firstKey);
    const later = { ...appointment, updated_at: "2099-01-02T00:00:00.000Z", previous_date: appointment.date, previous_start_time: appointment.start_time, date: "2099-04-11", start_time: "11:00:00" };
    assert.notEqual(appointmentEventKey("appointment.rescheduled", later), firstKey);
    assert.equal(appointmentEventKey("appointment.booked", appointment), appointmentEventKey("appointment.booked", appointment));
  });
});
