const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { describe, it } = require("node:test");
const { appointmentEventKey, createNotificationDeliveryService } = require("../src/services/notificationDeliveryService");

const appointment = {
  id: "11111111-1111-4111-8111-111111111111",
  patient_id: "22222222-2222-4222-8222-222222222222",
  patient_user_id: "33333333-3333-4333-8333-333333333333", patient_email: "patient@example.test",
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

  it("defines recovery payload, idempotency, scheduling, classification, and lease schema", () => {
    const migration = fs.readFileSync(path.join(__dirname, "..", "migrations", "014_notification_delivery_recovery.sql"), "utf8");
    assert.match(migration, /payload JSONB/i);
    assert.match(migration, /idempotency_key UUID/i);
    assert.match(migration, /next_attempt_at TIMESTAMPTZ/i);
    assert.match(migration, /failure_classification TEXT/i);
    assert.match(migration, /lease_token UUID/i);
    assert.match(migration, /lease_expires_at TIMESTAMPTZ/i);
    assert.match(migration, /status = 'ambiguous'/i);
  });

  it("persists the minimal rendered payload, reuses its UUID key, and applies bounded exponential backoff", async () => {
    let saved;
    let updateSql;
    let updateValues;
    const database = { async query(sql, values = []) {
      if (sql.startsWith("INSERT INTO notification_deliveries")) {
        saved = { payload: JSON.parse(values[4]), idempotencyKey: values[5] };
        return { rows: [{ id: "delivery-id", payload: saved.payload, idempotency_key: saved.idempotencyKey, lease_token: values[6] }] };
      }
      if (sql.startsWith("UPDATE notification_deliveries")) { updateSql = sql; updateValues = values; return { rows: [] }; }
      throw new Error(`Unexpected query: ${sql}`);
    } };
    const sent = [];
    const service = createNotificationDeliveryService({ database, emailNotificationService: { createNotificationPayload: () => ({ to: "before@example.test", subject: "Appointment confirmed", textContent: "Saved body", sender: { email: "saved-sender@example.test", name: "Saved Sender" } }), async sendNotificationPayload(payload, key) { sent.push({ payload, key }); return { sent: false, error: true, reason: "provider_error", status: 503, attempts: 1 }; } } });
    await service.sendAppointmentNotification({ eventKey: "snapshotted", eventType: "appointment.booked", appointment: { ...appointment, patient_email: "before@example.test" } });
    assert.deepEqual(sent[0].payload, { to: "before@example.test", subject: "Appointment confirmed", textContent: "Saved body", sender: { email: "saved-sender@example.test", name: "Saved Sender" } });
    assert.equal(sent[0].key, saved.idempotencyKey);
    assert.match(saved.idempotencyKey, /^[0-9a-f-]{36}$/i);
    assert.equal(updateValues[1], "failed");
    assert.equal(updateValues[6], "transient");
    assert.match(updateSql, /next_attempt_at = CASE WHEN \$7 = 'transient'.*NOW\(\)/is);
    assert.match(updateSql, /attempt_count \+ \$3\) < \$9/);
    assert.match(updateSql, /LEAST\(\$8 \* POWER\(2, GREATEST\(attempt_count \+ \$3 - 1, 0\)\), \$10\)/);
    assert.equal(updateValues[7], 30_000);
    assert.equal(updateValues[9], 30 * 60_000);
  });

  it("records permanent and ambiguous failures without scheduling retries", async () => {
    const results = [];
    const database = { async query(sql, values = []) {
      if (sql.startsWith("INSERT INTO notification_deliveries")) return { rows: [{ id: "delivery", payload: JSON.parse(values[4]), idempotency_key: values[5], lease_token: values[6] }] };
      if (sql.startsWith("UPDATE notification_deliveries")) { results.push(values); return { rows: [] }; }
      throw new Error(`Unexpected query: ${sql}`);
    } };
    const outcomes = [{ sent: false, permanent: true, reason: "provider_error", status: 400, attempts: 1 }, { sent: false, ambiguous: true, reason: "timeout", attempts: 1 }];
    const service = createNotificationDeliveryService({ database, emailNotificationService: { async sendNotificationPayload() { return outcomes.shift(); } } });
    await service.sendAppointmentNotification({ eventKey: "permanent", eventType: "appointment.booked", appointment: { ...appointment, patient_email: "p@example.test" } });
    await service.sendAppointmentNotification({ eventKey: "ambiguous", eventType: "appointment.booked", appointment: { ...appointment, patient_email: "p@example.test" } });
    assert.equal(results[0][1], "failed");
    assert.equal(results[0][6], "permanent");
    assert.equal(results[1][1], "ambiguous");
    assert.equal(results[1][6], "ambiguous");
  });

  it("uses SKIP LOCKED claiming, lease guarded writes, and does not resend stale or expired-key outcomes", async () => {
    let claimAttempts = 0;
    let sends = 0;
    let claimSql = "";
    let staleSql = "";
    let completionSql = "";
    const database = { async query(sql) {
      if (sql.includes("lease_expires_at < NOW()")) { staleSql = sql; return { rows: [{ id: "stale" }], rowCount: 1 }; }
      if (sql.includes("created_at <= NOW()")) return { rows: [], rowCount: 0 };
      if (sql.includes("WITH candidates")) {
        claimSql = sql;
        claimAttempts += 1;
        if (claimAttempts === 1) return { rows: [{ id: "claimed", payload: { to: "p@example.test", subject: "s", textContent: "b" }, idempotency_key: "44e37b4c-4470-4f67-91a2-0bc4f7cc9a12", lease_token: "55e37b4c-4470-4f67-91a2-0bc4f7cc9a12", attempt_count: 1, created_at: new Date() }] };
        return { rows: [] };
      }
      if (sql.startsWith("UPDATE notification_deliveries SET status = $2")) { completionSql = sql; return { rows: [] }; }
      throw new Error(`Unexpected query: ${sql}`);
    } };
    const service = createNotificationDeliveryService({ database, emailNotificationService: { async sendNotificationPayload() { sends += 1; return { sent: true, attempts: 1 }; } } });
    await Promise.all([service.runRecovery(), service.runRecovery()]);
    assert.match(claimSql, /FOR UPDATE SKIP LOCKED/i);
    assert.match(claimSql, /lease_token = gen_random_uuid\(\)/i);
    assert.match(staleSql, /lease_expires_at < NOW\(\)/i);
    assert.match(completionSql, /lease_token = \$11/i);
    assert.equal(claimAttempts, 2);
    assert.equal(sends, 1);
  });

  it("marks expired idempotency windows ambiguous without dispatching", async () => {
    const statements = [];
    let sends = 0;
    const database = { async query(sql) {
      statements.push(sql);
      if (sql.includes("lease_expires_at < NOW()")) return { rows: [], rowCount: 0 };
      if (sql.includes("created_at <= NOW()")) return { rows: [{ id: "expired" }], rowCount: 1 };
      if (sql.includes("WITH candidates")) return { rows: [] };
      throw new Error(`Unexpected query: ${sql}`);
    } };
    const service = createNotificationDeliveryService({ database, emailNotificationService: { async sendNotificationPayload() { sends += 1; return { sent: true }; } } });
    const result = await service.runRecovery();
    const expiryUpdate = statements.find((sql) => sql.includes("created_at <= NOW()"));
    assert.match(expiryUpdate, /SET status = 'ambiguous'/);
    assert.match(expiryUpdate, /NOW\(\) - \(\$1 \* INTERVAL '1 millisecond'\)/);
    assert.equal(result.markedAmbiguous, 1);
    assert.equal(sends, 0);
  });

  it("retries only due, under-limit rows with a complete saved payload and the same UUID", async () => {
    const savedPayload = { to: "original@example.test", subject: "Original subject", textContent: "Original body", sender: { email: "original-sender@example.test", name: "Original Sender" } };
    const key = "44e37b4c-4470-4f67-91a2-0bc4f7cc9a12";
    let claimSql;
    let claimValues;
    let updateValues;
    let updateSql;
    const database = { async query(sql, values = []) {
      if (sql.includes("lease_expires_at < NOW()")) return { rows: [], rowCount: 0 };
      if (sql.includes("created_at <= NOW()")) return { rows: [], rowCount: 0 };
      if (sql.includes("WITH candidates")) {
        claimSql = sql;
        claimValues = values;
        return { rows: [{ id: "delivery", payload: savedPayload, idempotency_key: key, lease_token: "55e37b4c-4470-4f67-91a2-0bc4f7cc9a12", attempt_count: 2, created_at: new Date() }] };
      }
      if (sql.includes("SET status = $2")) { updateSql = sql; updateValues = values; return { rows: [], rowCount: 1 }; }
      throw new Error(`Unexpected query: ${sql}`);
    } };
    const sends = [];
    const service = createNotificationDeliveryService({ database, emailNotificationService: { async sendNotificationPayload(payload, idempotencyKey) { sends.push({ payload, idempotencyKey }); return { sent: false, attempts: 1, reason: "provider_error" }; } } });
    await service.runRecovery();
    assert.deepEqual(sends, [{ payload: savedPayload, idempotencyKey: key }]);
    assert.match(claimSql, /next_attempt_at <= NOW\(\)/);
    assert.match(claimSql, /attempt_count < \$1/);
    assert.match(claimSql, /payload IS NOT NULL/);
    assert.match(claimSql, /idempotency_key IS NOT NULL/);
    assert.match(claimSql, /created_at > NOW\(\)/);
    assert.deepEqual(claimValues, [5, 25, 1_800_000, 120_000]);
    assert.match(updateSql, /lease_token = \$11/);
    assert.equal(updateValues[10], "55e37b4c-4470-4f67-91a2-0bc4f7cc9a12");
  });

  it("does not exceed the five-send delivery budget on its final recovery attempt", async () => {
    let requestOptions;
    let updateSql;
    let updateValues;
    const database = { async query(sql, values = []) {
      if (sql.includes("lease_expires_at < NOW()")) return { rows: [], rowCount: 0 };
      if (sql.includes("created_at <= NOW()")) return { rows: [], rowCount: 0 };
      if (sql.includes("WITH candidates")) return { rows: [{ id: "last-attempt", payload: { to: "p@example.test", subject: "s", textContent: "b", sender: { email: "s@example.test", name: "S" } }, idempotency_key: "44e37b4c-4470-4f67-91a2-0bc4f7cc9a12", lease_token: "55e37b4c-4470-4f67-91a2-0bc4f7cc9a12", attempt_count: 4, created_at: new Date() }] };
      if (sql.includes("SET status = $2")) { updateSql = sql; updateValues = values; return { rows: [], rowCount: 1 }; }
      throw new Error(`Unexpected query: ${sql}`);
    } };
    const service = createNotificationDeliveryService({ database, emailNotificationService: { async sendNotificationPayload(_payload, _key, options) { requestOptions = options; return { sent: false, attempts: 1, reason: "provider_error" }; } } });
    await service.runRecovery();
    assert.deepEqual(requestOptions, { maxAttempts: 1 });
    assert.equal(updateValues[2], 1);
    assert.match(updateSql, /\(attempt_count \+ \$3\) < \$9/);
    assert.equal(updateValues[8], 5);
  });

  it("excludes historical failed/skipped deliveries without a recovery classification or snapshot", async () => {
    const statements = [];
    let sends = 0;
    const database = { async query(sql) {
      statements.push(sql);
      if (sql.includes("lease_expires_at < NOW()")) return { rows: [], rowCount: 0 };
      if (sql.includes("created_at <= NOW()")) return { rows: [], rowCount: 0 };
      if (sql.includes("WITH candidates")) return { rows: [] };
      throw new Error(`Unexpected query: ${sql}`);
    } };
    const service = createNotificationDeliveryService({ database, emailNotificationService: { async sendNotificationPayload() { sends += 1; return { sent: true }; } } });
    await service.runRecovery();
    const claimSql = statements.find((sql) => sql.includes("WITH candidates"));
    assert.match(claimSql, /failure_classification = 'transient'/);
    assert.match(claimSql, /payload IS NOT NULL/);
    assert.match(claimSql, /idempotency_key IS NOT NULL/);
    assert.equal(sends, 0);
  });

  it("rejects completion from a stale lease token after another claim takes ownership", async () => {
    const oldToken = "55e37b4c-4470-4f67-91a2-0bc4f7cc9a12";
    let currentToken = oldToken;
    let completionApplied = false;
    let completionSql;
    const database = { async query(sql, values = []) {
      if (sql.includes("lease_expires_at < NOW()")) return { rows: [], rowCount: 0 };
      if (sql.includes("created_at <= NOW()")) return { rows: [], rowCount: 0 };
      if (sql.includes("WITH candidates")) return { rows: [{ id: "delivery", payload: { to: "p@example.test", subject: "s", textContent: "b", sender: { email: "s@example.test", name: "S" } }, idempotency_key: "44e37b4c-4470-4f67-91a2-0bc4f7cc9a12", lease_token: oldToken, attempt_count: 1, created_at: new Date() }] };
      if (sql.includes("SET status = $2")) {
        completionSql = sql;
        completionApplied = values[10] === currentToken;
        return { rows: [], rowCount: completionApplied ? 1 : 0 };
      }
      throw new Error(`Unexpected query: ${sql}`);
    } };
    const service = createNotificationDeliveryService({ database, emailNotificationService: { async sendNotificationPayload() { currentToken = "66e37b4c-4470-4f67-91a2-0bc4f7cc9a12"; return { sent: true, attempts: 1 }; } } });
    await service.runRecovery();
    assert.match(completionSql, /lease_token = \$11/);
    assert.equal(completionApplied, false);
  });

  it("records accepted deliveries, message IDs, and actual transport attempt counts", async () => {
    const harness = createHarness({ outcome: { sent: true, attempts: 2, providerMessageId: "brevo-accepted-id", status: 201 } });
    const result = await harness.service.sendAppointmentNotification({ eventKey: "booked:key", eventType: "appointment.booked", appointment });
    const record = harness.database.records.get(`booked:key:patient:${appointment.patient_user_id}`);
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
    const failedRecord = failed.database.records.get(`failed:key:patient:${appointment.patient_user_id}`);
    assert.equal(failedRecord.status, "failed");
    assert.equal(failedRecord.reason, "provider_error");
    assert.equal(failedRecord.provider_http_status, 503);
    assert.equal(failedRecord.attempt_count, 2);

    const skipped = createHarness({ outcome: { sent: false, skipped: true, reason: "missing_configuration", attempts: 0 } });
    await skipped.service.sendAppointmentNotification({ eventKey: "skipped:key", eventType: "appointment.rescheduled", appointment });
    const skippedRecord = skipped.database.records.get(`skipped:key:patient:${appointment.patient_user_id}`);
    assert.equal(skippedRecord.status, "skipped");
    assert.equal(skippedRecord.reason, "missing_configuration");
    assert.equal(skippedRecord.attempt_count, 0);
  });

  it("prevents duplicate sends for existing records in processing and finalized states", async () => {
    for (const status of ["processing", "accepted", "failed", "skipped"]) {
      const harness = createHarness();
      harness.database.records.set(`same:event:patient:${appointment.patient_user_id}`, { id: status, status });
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

  it("does not send an untracked email when delivery record creation fails", async () => {
    const harness = createHarness({ failInsert: true });
    const result = await harness.service.sendAppointmentNotification({ eventKey: "untracked:event", eventType: "appointment.booked", appointment });
    assert.equal(result.sent, false);
    assert.equal(harness.sent.length, 0);
    assert.deepEqual(harness.logs[0], ["Notification delivery tracking failed", { operation: "create", reason: "database_error" }]);
  });

  it("uses deterministic distinct occurrence keys for separate reschedules", () => {
    const firstKey = appointmentEventKey("appointment.rescheduled", appointment);
    assert.equal(appointmentEventKey("appointment.rescheduled", appointment), firstKey);
    const later = { ...appointment, updated_at: "2099-01-02T00:00:00.000Z", previous_date: appointment.date, previous_start_time: appointment.start_time, date: "2099-04-11", start_time: "11:00:00" };
    assert.notEqual(appointmentEventKey("appointment.rescheduled", later), firstKey);
    assert.equal(appointmentEventKey("appointment.booked", appointment), appointmentEventKey("appointment.booked", appointment));
  });

  it("selects recipients and deduplicates every booking, cancellation, and rescheduling event", async () => {
    const bothRecipients = { ...appointment, doctor_user_id: "44444444-4444-4444-8444-444444444444", doctor_email: "doctor@example.test" };
    for (const eventType of ["appointment.booked", "appointment.cancelled", "appointment.rescheduled"]) {
      const harness = createHarness();
      const eventKey = appointmentEventKey(eventType, bothRecipients);
      await harness.service.sendAppointmentNotification({ eventKey, eventType, appointment: bothRecipients, actorRole: "patient" });
      assert.equal(harness.database.records.size, 2, `${eventType} should persist one delivery per recipient`);
      assert.ok(harness.database.records.has(`${eventKey}:patient:${bothRecipients.patient_user_id}`));
      assert.ok(harness.database.records.has(`${eventKey}:doctor:${bothRecipients.doctor_user_id}`));
      assert.equal(harness.sent.length, 2);
      await harness.service.sendAppointmentNotification({ eventKey, eventType, appointment: bothRecipients, actorRole: "patient" });
      assert.equal(harness.sent.length, 2, `${eventType} duplicate must not send again`);
    }

    const doctorReschedule = createHarness();
    await doctorReschedule.service.sendAppointmentNotification({ eventKey: "doctor-reschedule", eventType: "appointment.rescheduled", appointment: bothRecipients, actorRole: "doctor" });
    assert.equal(doctorReschedule.database.records.size, 1);
    assert.ok(doctorReschedule.database.records.has(`doctor-reschedule:patient:${bothRecipients.patient_user_id}`));
    assert.equal(doctorReschedule.sent.length, 1);
  });
});
