const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { describe, it } = require("node:test");
const { appointmentEventKey, appointmentSmsMessage, createNotificationDeliveryService } = require("../src/services/notificationDeliveryService");
const { createMockSmsProvider } = require("../src/services/mockSmsProvider");
const { createSmsNotificationService } = require("../src/services/smsNotificationService");

const appointment = {
  id: "11111111-1111-4111-8111-111111111111",
  patient_id: "22222222-2222-4222-8222-222222222222",
  patient_user_id: "33333333-3333-4333-8333-333333333333", patient_email: "patient@example.test",
  updated_at: "2099-01-01T00:00:00.000Z",
  date: "2099-04-10", start_time: "10:00:00",
  previous_date: "2099-04-09", previous_start_time: "09:00:00",
};
const recipientUserId = "33333333-3333-4333-8333-333333333333";
const doctorUserId = "44444444-4444-4444-8444-444444444444";
const appointmentWithDoctor = { ...appointment, doctor_user_id: doctorUserId, doctor_email: "doctor@example.test" };

function recordKey(eventKey, channel) { return channel === "email" ? eventKey : `${eventKey}:${channel}`; }

function createDatabase({ failInsert = false, preferences = [], currentAppointment = {}, failPreferenceLookups = 0, failCurrentAppointmentLookups = 0 } = {}) {
  const records = new Map();
  let nextId = 1;
  let insertSql;
  let preferenceLookups = 0;
  let appointmentLookups = 0;
  return {
    records,
    async query(sql, values = []) {
      if (sql.includes("SELECT a.status, a.scheduled_date::text AS date")) {
        appointmentLookups += 1;
        if (appointmentLookups <= failCurrentAppointmentLookups) throw new Error("temporary appointment eligibility lookup failure");
        return { rows: currentAppointment.status === "missing" ? [] : [{ status: currentAppointment.status || "confirmed", date: currentAppointment.date || appointment.date, start_time: currentAppointment.start_time || appointment.start_time, phone: Object.hasOwn(currentAppointment, "phone") ? currentAppointment.phone : "+15551234567", sms_consent: currentAppointment.sms_consent ?? true }] };
      }
      if (sql.includes("SELECT phone, sms_consent FROM users WHERE id = $1")) {
        preferenceLookups += 1;
        if (preferenceLookups <= failPreferenceLookups) throw new Error("temporary profile lookup failure");
        return { rows: preferences.filter(({ id }) => id === values[0]) };
      }
      if (sql.includes("lease_expires_at < NOW()")) return { rows: [], rowCount: 0 };
      if (sql.includes("created_at <= NOW()")) return { rows: [], rowCount: 0 };
      if (sql.includes("WITH candidates")) {
        const candidate = [...records.values()].find(({ status, failure_classification }) => status === "failed" && failure_classification === "transient");
        if (!candidate) return { rows: [] };
        candidate.status = "processing";
        candidate.lease_token = `recovery-lease-${candidate.id}`;
        candidate.attempt_count += 0;
        return { rows: [{ ...candidate }] };
      }
      if (sql.startsWith("INSERT INTO notification_deliveries")) {
        insertSql = sql;
        if (failInsert) throw new Error("database credentials or private details");
        const [eventKey, eventType, appointmentId, userId, channel, provider, payload] = values;
        const key = recordKey(eventKey, channel);
        if (records.has(key)) return { rows: [] };
        const record = { id: nextId++, event_key: eventKey, event_type: eventType, appointment_id: appointmentId, recipient_user_id: userId || recipientUserId, channel, provider, payload: JSON.parse(payload), idempotency_key: values[7], lease_token: values[8], status: "processing", attempt_count: 0 };
        records.set(key, record);
        return { rows: [{ id: record.id, channel: record.channel, provider: record.provider, idempotency_key: record.idempotency_key, payload: record.payload, lease_token: record.lease_token, appointment_id: record.appointment_id, recipient_user_id: record.recipient_user_id }] };
      }
      if (sql.startsWith("SELECT id FROM notification_deliveries")) {
        const record = records.get(recordKey(values[0], values[1]));
        return { rows: record ? [{ id: record.id }] : [] };
      }
      if (sql.includes("SET payload = $2::jsonb")) {
        const record = [...records.values()].find(({ id }) => id === values[0]);
        if (record) record.payload = JSON.parse(values[1]);
        return { rows: [{ id: values[0] }], rowCount: record ? 1 : 0 };
      }
      if (sql.startsWith("UPDATE notification_deliveries")) {
        const [, status, attemptCount, providerMessageId, reason, providerHttpStatus] = values;
        const record = [...records.values()].find(({ id }) => id === values[0]);
        if (record) Object.assign(record, { status, attempt_count: attemptCount, provider_message_id: providerMessageId, reason, provider_http_status: providerHttpStatus, failure_classification: values[6], completed: true });
        return { rows: [] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
    get insertSql() { return insertSql; },
  };
}

function createHarness({ outcome = { sent: true, attempts: 1, providerMessageId: "brevo-id" }, failInsert = false, preferences = [], smsNotificationService, failPreferenceLookups = 0, currentAppointment, failCurrentAppointmentLookups = 0 } = {}) {
  const database = createDatabase({ failInsert, preferences, failPreferenceLookups, currentAppointment, failCurrentAppointmentLookups });
  const sent = [];
  const smsCalls = [];
  const logs = [];
  const selectedSmsService = smsNotificationService
    ? { ...smsNotificationService, providerName: smsNotificationService.providerName || "mock" }
    : preferences.length
      ? { providerName: "mock", async sendSms(payload, idempotencyKey) { smsCalls.push({ payload, idempotencyKey }); return { status: "simulated", simulated: true, sent: false, delivered: false }; } }
      : undefined;
  const service = createNotificationDeliveryService({
    database,
    emailNotificationService: { async sendAppointmentNotification(action, item) { sent.push([action, item.id]); return outcome; } },
    smsNotificationService: selectedSmsService,
    logger: { error: (...args) => logs.push(args) },
  });
  return { database, sent, smsCalls, logs, service };
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

  it("adds channel-specific uniqueness and terminal simulated state without rewriting records", () => {
    const migration = fs.readFileSync(path.join(__dirname, "..", "migrations", "018_notification_delivery_channels.sql"), "utf8");
    assert.match(migration, /UNIQUE \(event_key, channel\)/i);
    assert.match(migration, /CHECK \(channel IN \('email', 'sms'\)\)/i);
    assert.match(migration, /status IN \('processing', 'accepted', 'failed', 'skipped', 'ambiguous', 'simulated'\)/i);
    assert.match(migration, /provider <> 'mock' OR status <> 'accepted'/i);
    assert.doesNotMatch(migration, /DELETE FROM notification_deliveries|UPDATE notification_deliveries/i);
  });

  it("allows accurately tracked reminder SMS event types and appointment eligibility skips", () => {
    const migration = fs.readFileSync(path.join(__dirname, "..", "migrations", "021_notification_reminder_sms_events.sql"), "utf8");
    assert.match(migration, /appointment\.reminder_24h/);
    assert.match(migration, /appointment\.reminder_1h/);
    assert.match(migration, /appointment_not_eligible/);
    assert.match(migration, /consent_not_given/);
  });

  it("allows a distinct reason when the recipient phone changes", () => {
    const migration = fs.readFileSync(path.join(__dirname, "..", "migrations", "022_notification_phone_changed_reason.sql"), "utf8");
    assert.match(migration, /DROP CONSTRAINT notification_deliveries_reason_check/i);
    assert.match(migration, /'phone_changed'/i);
  });

  it("allows the configured SMS adapter identity while keeping the email provider fixed", () => {
    const migration = fs.readFileSync(path.join(__dirname, "..", "migrations", "023_notification_sms_provider_identifiers.sql"), "utf8");
    assert.match(migration, /channel = 'email' AND provider = 'brevo'/i);
    assert.match(migration, /channel = 'sms' AND provider ~ '\^\[a-z\]/i);
  });

  it("allows a tracked consent skip reason", () => {
    const migration = fs.readFileSync(path.join(__dirname, "..", "migrations", "020_notification_sms_consent_reason.sql"), "utf8");
    assert.match(migration, /DROP CONSTRAINT notification_deliveries_reason_check/i);
    assert.match(migration, /'consent_not_given'/i);
  });

  it("persists the minimal rendered payload, reuses its UUID key, and applies bounded exponential backoff", async () => {
    let saved;
    let updateSql;
    let updateValues;
    const database = { async query(sql, values = []) {
      if (sql.startsWith("INSERT INTO notification_deliveries")) {
        saved = { payload: JSON.parse(values[6]), idempotencyKey: values[7] };
        return { rows: [{ id: "delivery-id", payload: saved.payload, idempotency_key: saved.idempotencyKey, lease_token: values[8] }] };
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
      if (sql.startsWith("INSERT INTO notification_deliveries")) return { rows: [{ id: "delivery", channel: values[4], payload: JSON.parse(values[6]), idempotency_key: values[7], lease_token: values[8] }] };
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

  it("dispatches recovered SMS through SMS service and keeps it out of email recovery", async () => {
    const savedPayload = { to: "+15551234567", message: "Saved SMS" };
    const smsCalls = [];
    const database = { async query(sql) {
      if (sql.includes("lease_expires_at < NOW()")) return { rows: [], rowCount: 0 };
      if (sql.includes("created_at <= NOW()")) return { rows: [], rowCount: 0 };
      if (sql.includes("WITH candidates")) return { rows: [{ id: "sms-row", channel: "sms", provider: "mock", event_type: "appointment.reminder_24h", appointment_id: appointment.id, recipient_user_id: recipientUserId, payload: { ...savedPayload, scheduled_date: appointment.date, scheduled_start_time: appointment.start_time }, idempotency_key: "sms-key", lease_token: "sms-lease", attempt_count: 1, created_at: new Date() }] };
      if (sql.includes("SELECT a.status, a.scheduled_date::text AS date")) return { rows: [{ status: "confirmed", date: appointment.date, start_time: appointment.start_time, phone: "+15551234567", sms_consent: true }] };
      if (sql.includes("SET status = $2")) return { rows: [], rowCount: 1 };
      throw new Error(`Unexpected query: ${sql}`);
    } };
    const service = createNotificationDeliveryService({
      database,
      emailNotificationService: { async sendNotificationPayload() { throw new Error("Email sender must not receive SMS"); } },
      smsNotificationService: { providerName: "mock", async sendSms(payload, idempotencyKey) { smsCalls.push({ payload, idempotencyKey }); return { status: "simulated", simulated: true, sent: false, delivered: false }; } },
    });

    const result = await service.runRecovery();
    assert.equal(result.retried, 1);
    assert.deepEqual(smsCalls, [{ payload: { ...savedPayload, scheduled_date: appointment.date, scheduled_start_time: appointment.start_time }, idempotencyKey: "sms-key" }]);
  });

  it("suppresses event SMS recovery after consent revocation, phone removal, or phone change", async () => {
    const initialPreference = { id: recipientUserId, phone: "+15551234567", sms_consent: true };
    for (const [updatedValues, expectedReason] of [
      [{ sms_consent: false }, "consent_not_given"],
      [{ phone: null }, "missing_recipient"],
      [{ phone: "+15557654321" }, "phone_changed"],
    ]) {
      const preferences = [{ ...initialPreference }];
      let providerCalls = 0;
      const harness = createHarness({
        preferences,
        smsNotificationService: { async sendSms() { providerCalls += 1; return { status: "failed", sent: false, reason: "provider_error", attempts: 1 }; } },
      });
      const result = await harness.service.sendAppointmentNotification({ eventKey: `event-revalidate-${expectedReason}`, eventType: "appointment.booked", appointment });
      assert.equal(result.sent, true);
      assert.equal(providerCalls, 1);
      const smsRecord = [...harness.database.records.values()].find(({ channel }) => channel === "sms");
      assert.equal(smsRecord.payload.recipient_user_id, recipientUserId);
      assert.equal(smsRecord.payload.original_to, initialPreference.phone);
      Object.assign(preferences[0], updatedValues);

      await harness.service.runRecovery();
      assert.equal(providerCalls, 1);
      assert.equal(smsRecord.status, "skipped");
      assert.equal(smsRecord.reason, expectedReason);
    }
  });

  it("keeps preference lookup failures retryable and retries the eligibility lookup", async () => {
    const harness = createHarness({
      preferences: [{ id: recipientUserId, phone: "+15551234567", sms_consent: true }],
      failPreferenceLookups: 1,
    });
    await harness.service.sendAppointmentNotification({ eventKey: "preference-lookup-retry", eventType: "appointment.booked", appointment });
    const smsRecord = [...harness.database.records.values()].find(({ channel }) => channel === "sms");
    assert.equal(smsRecord.status, "failed");
    assert.equal(smsRecord.reason, "unexpected_error");
    assert.equal(smsRecord.failure_classification, "transient");
    assert.equal(smsRecord.payload.eligibility_lookup_pending, true);

    await harness.service.runRecovery();
    assert.equal(harness.smsCalls.length, 1);
    assert.equal(smsRecord.status, "simulated");
    assert.equal(smsRecord.reason, "simulated");
    assert.notEqual(smsRecord.reason, "consent_not_given");
    assert.equal(smsRecord.payload.original_to, "+15551234567");
  });

  it("forwards the same delivery idempotency key on each SMS retry", async () => {
    const keys = [];
    const harness = createHarness({
      preferences: [{ id: recipientUserId, phone: "+15551234567", sms_consent: true }],
      smsNotificationService: { async sendSms(_payload, key) { keys.push(key); return keys.length === 1 ? { status: "failed", sent: false, reason: "provider_error", attempts: 1 } : { status: "simulated", simulated: true, sent: false, delivered: false }; } },
    });
    await harness.service.sendAppointmentNotification({ eventKey: "stable-sms-key", eventType: "appointment.booked", appointment });
    const smsRecord = [...harness.database.records.values()].find(({ channel }) => channel === "sms");
    const storedKey = smsRecord.idempotency_key;
    await harness.service.runRecovery();
    assert.deepEqual(keys, [storedKey, storedKey]);
    assert.equal(smsRecord.status, "simulated");
  });

  it("does not recover a reminder after cancellation or schedule change", async () => {
    let providerCalls = 0;
    const stalePayload = { to: "+15551234567", message: "Stale reminder", scheduled_date: "2099-04-10", scheduled_start_time: "10:00:00" };
    const database = { async query(sql) {
      if (sql.includes("lease_expires_at < NOW()")) return { rows: [], rowCount: 0 };
      if (sql.includes("created_at <= NOW()")) return { rows: [], rowCount: 0 };
      if (sql.includes("WITH candidates")) return { rows: [{ id: "stale-sms-row", channel: "sms", provider: "mock", event_type: "appointment.reminder_1h", appointment_id: appointment.id, recipient_user_id: recipientUserId, payload: stalePayload, idempotency_key: "stale-key", lease_token: "stale-lease", attempt_count: 1, created_at: new Date() }] };
      if (sql.includes("SELECT a.status, a.scheduled_date::text AS date")) return { rows: [{ status: "confirmed", date: "2099-04-11", start_time: "11:00:00", phone: "+15551234567", sms_consent: true }] };
      if (sql.startsWith("UPDATE notification_deliveries")) return { rows: [], rowCount: 1 };
      throw new Error(`Unexpected query: ${sql}`);
    } };
    const service = createNotificationDeliveryService({ database, emailNotificationService: {}, smsNotificationService: { providerName: "mock", async sendSms() { providerCalls += 1; return { status: "simulated", simulated: true }; } } });
    const result = await service.runRecovery();
    assert.equal(result.retried, 1);
    assert.equal(providerCalls, 0);
  });

  it("sends reminders to the latest valid phone and retries eligibility lookup failures", async () => {
    const changedPhoneDatabase = createDatabase({ currentAppointment: { phone: "+15557654321" } });
    const reminderCalls = [];
    const changedPhoneService = createNotificationDeliveryService({
      database: changedPhoneDatabase,
      emailNotificationService: {},
      smsNotificationService: { providerName: "mock", async sendSms(payload) { reminderCalls.push(payload.to); return { status: "simulated", simulated: true }; } },
    });
    await changedPhoneService.sendSmsDelivery({
      eventKey: "reminder-phone-change", eventType: "appointment.reminder_1h",
      appointment: { id: appointment.id, date: appointment.date, start_time: appointment.start_time },
      recipient: { type: "patient", userId: recipientUserId }, to: "+15551234567", consent: true, message: "Reminder",
      payloadExtra: { scheduled_date: appointment.date, scheduled_start_time: appointment.start_time },
    });
    assert.deepEqual(reminderCalls, ["+15557654321"]);

    const lookupDatabase = createDatabase({ failCurrentAppointmentLookups: 1 });
    let providerCalls = 0;
    const lookupService = createNotificationDeliveryService({
      database: lookupDatabase,
      emailNotificationService: {},
      smsNotificationService: { providerName: "mock", async sendSms() { providerCalls += 1; return { status: "simulated", simulated: true }; } },
    });
    const reminder = {
      eventKey: "reminder-lookup-retry", eventType: "appointment.reminder_24h",
      appointment: { id: appointment.id, date: appointment.date, start_time: appointment.start_time },
      recipient: { type: "patient", userId: recipientUserId }, to: "+15551234567", consent: true, message: "Reminder",
      payloadExtra: { scheduled_date: appointment.date, scheduled_start_time: appointment.start_time },
    };
    await lookupService.sendSmsDelivery(reminder);
    const row = [...lookupDatabase.records.values()][0];
    assert.equal(row.status, "failed");
    assert.equal(row.failure_classification, "transient");
    assert.notEqual(row.status, "ambiguous");
    assert.equal(providerCalls, 0);
    await lookupService.runRecovery();
    assert.equal(providerCalls, 1);
    assert.equal(row.status, "simulated");
  });

  it("stores the selected provider identity and recovers through the matching registered adapter", async () => {
    let mockCalls = 0;
    const selectedCalls = [];
    const smsNotificationService = createSmsNotificationService({
      config: { SMS_PROVIDER: "notify-v2" },
      providerRegistry: {
        mock: () => createMockSmsProvider(),
        "notify-v2": { async send(input) { selectedCalls.push(input); return { status: "simulated", simulated: true }; } },
      },
    });
    const harness = createHarness({
      preferences: [{ id: recipientUserId, phone: "+15551234567", sms_consent: true }],
      smsNotificationService,
    });
    await harness.service.sendAppointmentNotification({ eventKey: "provider-identity", eventType: "appointment.booked", appointment });
    const created = [...harness.database.records.values()].find(({ channel }) => channel === "sms");
    assert.equal(created.provider, "notify-v2");
    assert.equal(selectedCalls[0].idempotencyKey, created.idempotency_key);

    const smsPayload = { to: "+15551234567", original_to: "+15551234567", recipient_user_id: recipientUserId, message: "Saved", idempotency_lookup_pending: false };
    const recoveryDatabase = { async query(sql) {
      if (sql.includes("lease_expires_at < NOW()") || sql.includes("created_at <= NOW()")) return { rows: [], rowCount: 0 };
      if (sql.includes("WITH candidates")) return { rows: [{ id: "adapter-row", channel: "sms", provider: "notify-v2", event_type: "appointment.booked", appointment_id: appointment.id, recipient_user_id: recipientUserId, payload: smsPayload, idempotency_key: "same-adapter-key", lease_token: "adapter-lease", attempt_count: 1 }] };
      if (sql.includes("SELECT phone, sms_consent FROM users")) return { rows: [{ phone: "+15551234567", sms_consent: true }] };
      if (sql.startsWith("UPDATE notification_deliveries")) return { rows: [], rowCount: 1 };
      throw new Error(`Unexpected query: ${sql}`);
    } };
    const recoveryService = createNotificationDeliveryService({ database: recoveryDatabase, emailNotificationService: {}, smsNotificationService });
    await recoveryService.runRecovery();
    assert.equal(selectedCalls.at(-1).idempotencyKey, "same-adapter-key");
    assert.equal(mockCalls, 0);
  });

  it("does not fall back to mock for an unknown provider stored on a delivery", async () => {
    let mockCalls = 0;
    let updateValues;
    const smsNotificationService = createSmsNotificationService({
      config: { SMS_PROVIDER: "mock" },
      providerRegistry: { mock: { async send() { mockCalls += 1; return { status: "simulated", simulated: true }; } } },
    });
    const database = { async query(sql, values = []) {
      if (sql.includes("lease_expires_at < NOW()") || sql.includes("created_at <= NOW()")) return { rows: [], rowCount: 0 };
      if (sql.includes("WITH candidates")) return { rows: [{ id: "unknown-row", channel: "sms", provider: "unregistered", event_type: "appointment.booked", appointment_id: appointment.id, recipient_user_id: recipientUserId, payload: { to: "+15551234567", original_to: "+15551234567", recipient_user_id: recipientUserId, message: "Saved" }, idempotency_key: "unknown-key", lease_token: "unknown-lease", attempt_count: 1 }] };
      if (sql.includes("SELECT phone, sms_consent FROM users")) return { rows: [{ phone: "+15551234567", sms_consent: true }] };
      if (sql.startsWith("UPDATE notification_deliveries SET status = $2")) { updateValues = values; return { rows: [], rowCount: 1 }; }
      throw new Error(`Unexpected query: ${sql}`);
    } };
    const service = createNotificationDeliveryService({ database, emailNotificationService: {}, smsNotificationService });
    await service.runRecovery();
    assert.equal(mockCalls, 0);
    assert.equal(updateValues[1], "failed");
    assert.equal(updateValues[4], "missing_configuration");
    assert.equal(updateValues[6], "permanent");
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
    assert.equal(record.channel, "email");
    assert.equal(record.provider, "brevo");
    assert.match(harness.database.insertSql, /ON CONFLICT \(event_key, channel\) DO NOTHING/i);
    assert.match(harness.database.insertSql, /INSERT INTO notification_deliveries \(event_key, event_type, appointment_id, recipient_user_id, channel, provider, payload,/i);
    assert.match(harness.database.insertSql, /SELECT \$1, \$2, \$3, recipient\.user_id, \$5, \$6, \$7::jsonb/i);
  });

  it("tracks email and SMS independently for one event and keeps simulated SMS terminal", async () => {
    const harness = createHarness({ preferences: [{ id: appointment.patient_user_id, phone: "+15551234567", sms_consent: true }] });
    const service = createNotificationDeliveryService({
      database: harness.database,
      emailNotificationService: { async sendNotificationPayload() { return { sent: true, attempts: 1 }; } },
      smsNotificationService: { providerName: "mock", async sendSms(payload) { harness.smsCalls.push(payload); return { status: "simulated", simulated: true, sent: false, delivered: false }; } },
    });
    const eventKey = "shared-event";
    const result = await service.sendAppointmentNotification({ eventKey, eventType: "appointment.booked", appointment });
    const emailRecord = harness.database.records.get(`${eventKey}:patient:${appointment.patient_user_id}`);
    const smsRecord = harness.database.records.get(`${eventKey}:patient:${appointment.patient_user_id}:sms`);

    assert.equal(emailRecord.channel, "email");
    assert.equal(emailRecord.provider, "brevo");
    assert.equal(smsRecord.channel, "sms");
    assert.equal(smsRecord.provider, "mock");
    assert.equal(smsRecord.payload.to, "+15551234567");
    assert.match(smsRecord.payload.message, /Dr\. /);
    assert.equal(result.sent, true);
    assert.equal(result.outcomes.find(({ channel }) => channel === "sms").status, "simulated");
    assert.equal(result.outcomes.find(({ channel }) => channel === "sms").sent, false);
    assert.equal(smsRecord.status, "simulated");
    assert.equal(smsRecord.reason, "simulated");
    assert.equal(smsRecord.failure_classification, null);
    assert.equal(harness.smsCalls.length, 1);
  });

  it("uses current reminder consent and phone instead of scheduler snapshots", async () => {
    const cases = [
      { name: "newly enabled consent", snapshot: { to: "+15551234567", consent: false }, current: { phone: "+15557654321", sms_consent: true }, expectedStatus: "simulated", expectedPhone: "+15557654321" },
      { name: "newly added phone", snapshot: { to: null, consent: true }, current: { phone: "+15557654321", sms_consent: true }, expectedStatus: "simulated", expectedPhone: "+15557654321" },
      { name: "current consent remains disabled", snapshot: { to: "+15551234567", consent: true }, current: { phone: "+15551234567", sms_consent: false }, expectedStatus: "skipped", expectedReason: "consent_not_given" },
      { name: "current phone remains unavailable", snapshot: { to: "+15551234567", consent: true }, current: { phone: "invalid", sms_consent: true }, expectedStatus: "skipped", expectedReason: "missing_recipient" },
    ];
    for (const [index, testCase] of cases.entries()) {
      const providerCalls = [];
      const harness = createHarness({
        currentAppointment: testCase.current,
        smsNotificationService: { async sendSms(payload) { providerCalls.push(payload.to); return { status: "simulated", simulated: true }; } },
      });
      const result = await harness.service.sendSmsDelivery({
        eventKey: `reminder-current-profile-${index}`,
        eventType: "appointment.reminder_24h",
        appointment: { id: appointment.id, date: appointment.date, start_time: appointment.start_time },
        recipient: { type: "patient", userId: recipientUserId },
        message: "Reminder message",
        payloadExtra: { reminder_type: "24h", scheduled_date: appointment.date, scheduled_start_time: appointment.start_time },
        ...testCase.snapshot,
      });
      const delivery = [...harness.database.records.values()][0];
      assert.equal(delivery.status, testCase.expectedStatus, testCase.name);
      assert.equal(delivery.reason, testCase.expectedReason || "simulated", testCase.name);
      assert.deepEqual(providerCalls, testCase.expectedPhone ? [testCase.expectedPhone] : [], testCase.name);
      if (testCase.expectedReason) assert.equal(result.reason, testCase.expectedReason, testCase.name);
    }
  });

  it("records a reminder profile lookup failure as retryable and not as an opt-out", async () => {
    const providerCalls = [];
    const harness = createHarness({
      failCurrentAppointmentLookups: 1,
      smsNotificationService: { async sendSms(payload) { providerCalls.push(payload.to); return { status: "simulated", simulated: true }; } },
    });
    await harness.service.sendSmsDelivery({
      eventKey: "reminder-current-profile-lookup-failure",
      eventType: "appointment.reminder_24h",
      appointment: { id: appointment.id, date: appointment.date, start_time: appointment.start_time },
      recipient: { type: "patient", userId: recipientUserId },
      to: null,
      consent: false,
      message: "Reminder message",
      payloadExtra: { scheduled_date: appointment.date, scheduled_start_time: appointment.start_time },
    });
    const delivery = [...harness.database.records.values()][0];
    assert.equal(delivery.status, "failed");
    assert.equal(delivery.failure_classification, "transient");
    assert.notEqual(delivery.reason, "consent_not_given");
    assert.deepEqual(providerCalls, []);

    await harness.service.runRecovery();
    assert.deepEqual(providerCalls, ["+15551234567"]);
    assert.equal(delivery.status, "simulated");
  });

  it("keeps reminder mock results simulated and suppresses stale or ineligible reminders", async () => {
    const current = createHarness({ smsNotificationService: { async sendSms() { return { status: "simulated", simulated: true, sent: false, delivered: false }; } } });
    await current.service.sendSmsDelivery({ eventKey: "reminder-simulated", eventType: "appointment.reminder_1h", appointment: { id: appointment.id }, recipient: { type: "patient", userId: recipientUserId }, to: "+15551234567", consent: true, message: "Reminder", payloadExtra: { scheduled_date: appointment.date, scheduled_start_time: appointment.start_time } });
    assert.equal([...current.database.records.values()][0].status, "simulated");

    for (const currentAppointment of [
      { status: "cancelled" },
      { date: "2099-04-11", start_time: "11:00:00" },
      { sms_consent: false },
      { phone: null },
    ]) {
      const database = createDatabase({ currentAppointment });
      let calls = 0;
      const service = createNotificationDeliveryService({ database, emailNotificationService: {}, smsNotificationService: { providerName: "mock", async sendSms() { calls += 1; return { status: "simulated", simulated: true }; } } });
      const result = await service.sendSmsDelivery({ eventKey: `reminder-invalid-${calls}-${currentAppointment.status || currentAppointment.date || currentAppointment.sms_consent || "phone"}`, eventType: "appointment.reminder_1h", appointment: { id: appointment.id }, recipient: { type: "patient", userId: recipientUserId }, to: "+15551234567", consent: true, message: "Reminder", payloadExtra: { scheduled_date: appointment.date, scheduled_start_time: appointment.start_time } });
      assert.equal(result?.sent, false);
      assert.equal(calls, 0);
    }
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
    for (const status of ["processing", "accepted", "failed", "skipped", "simulated"]) {
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

  it("applies the existing SMS recipient rules to booking, cancellation, and patient/doctor rescheduling", async () => {
    const preferences = [
      { id: appointment.patient_user_id, phone: "+15551234567", sms_consent: true },
      { id: doctorUserId, phone: "+15557654321", sms_consent: true },
    ];
    const bothEvents = ["appointment.booked", "appointment.cancelled", "appointment.rescheduled"];
    for (const eventType of bothEvents) {
      const harness = createHarness({ preferences });
      await harness.service.sendAppointmentNotification({ eventKey: eventType, eventType, appointment: appointmentWithDoctor, actorRole: "patient" });
      const smsRecords = [...harness.database.records.values()].filter(({ channel }) => channel === "sms");
      assert.deepEqual(smsRecords.map(({ recipient_user_id }) => recipient_user_id), [appointment.patient_user_id, doctorUserId]);
      assert.deepEqual(smsRecords.map(({ status }) => status), ["simulated", "simulated"]);
    }

    const doctorReschedule = createHarness({ preferences });
    await doctorReschedule.service.sendAppointmentNotification({ eventKey: "doctor-reschedule-sms", eventType: "appointment.rescheduled", appointment: appointmentWithDoctor, actorRole: "doctor" });
    const smsRecords = [...doctorReschedule.database.records.values()].filter(({ channel }) => channel === "sms");
    assert.equal(smsRecords.length, 1);
    assert.equal(smsRecords[0].recipient_user_id, appointment.patient_user_id);
    assert.equal(doctorReschedule.smsCalls.length, 1);
  });

  it("uses concise SMS event templates without appointment reasons", () => {
    const withReason = { ...appointment, reason: "Sensitive medical detail", doctor_first_name: "Dara", doctor_last_name: "Doctor" };
    const booked = appointmentSmsMessage("appointment.booked", withReason, "patient");
    const cancelled = appointmentSmsMessage("appointment.cancelled", withReason, "patient");
    const rescheduled = appointmentSmsMessage("appointment.rescheduled", withReason, "patient");
    assert.match(booked, /Dr\. Dara Doctor/);
    assert.match(booked, /2099-04-10 at 10:00/);
    assert.match(cancelled, /cancelled/);
    assert.match(rescheduled, /2099-04-09 at 09:00 to 2099-04-10 at 10:00/);
    for (const message of [booked, cancelled, rescheduled]) assert.doesNotMatch(message, /Sensitive medical detail/);
  });

  it("requires each recipient's independent consent and a valid phone before calling SMS provider", async () => {
    const mixedConsent = createHarness({ preferences: [
      { id: appointment.patient_user_id, phone: "+15551234567", sms_consent: true },
      { id: doctorUserId, phone: "+15557654321", sms_consent: false },
    ] });
    await mixedConsent.service.sendAppointmentNotification({ eventKey: "mixed-consent", eventType: "appointment.booked", appointment: appointmentWithDoctor });
    const smsRecords = [...mixedConsent.database.records.values()].filter(({ channel }) => channel === "sms");
    assert.equal(mixedConsent.smsCalls.length, 1);
    assert.equal(smsRecords.find(({ recipient_user_id }) => recipient_user_id === appointment.patient_user_id).status, "simulated");
    assert.equal(smsRecords.find(({ recipient_user_id }) => recipient_user_id === doctorUserId).status, "skipped");
    assert.equal(smsRecords.find(({ recipient_user_id }) => recipient_user_id === doctorUserId).reason, "consent_not_given");

    const missingPhone = createHarness({ preferences: [
      { id: appointment.patient_user_id, phone: null, sms_consent: true },
      { id: doctorUserId, phone: "not-a-phone", sms_consent: true },
    ] });
    await missingPhone.service.sendAppointmentNotification({ eventKey: "missing-phone", eventType: "appointment.booked", appointment: appointmentWithDoctor });
    const missingPhoneRecords = [...missingPhone.database.records.values()].filter(({ channel }) => channel === "sms");
    assert.equal(missingPhone.smsCalls.length, 0);
    assert.deepEqual(missingPhoneRecords.map(({ status, reason }) => [status, reason]), [["skipped", "missing_recipient"], ["skipped", "missing_recipient"]]);

    const optedOut = createHarness({ preferences: [
      { id: appointment.patient_user_id, phone: "+15551234567", sms_consent: false },
      { id: doctorUserId, phone: "+15557654321", sms_consent: false },
    ] });
    await optedOut.service.sendAppointmentNotification({ eventKey: "opted-out", eventType: "appointment.booked", appointment: appointmentWithDoctor });
    assert.equal(optedOut.smsCalls.length, 0);
    assert.equal([...optedOut.database.records.values()].filter(({ channel, status, reason }) => channel === "sms" && status === "skipped" && reason === "consent_not_given").length, 2);
  });

  it("does not send duplicate SMS for a repeated event and preserves simulated tracking", async () => {
    const harness = createHarness({ preferences: [
      { id: appointment.patient_user_id, phone: "+15551234567", sms_consent: true },
      { id: doctorUserId, phone: "+15557654321", sms_consent: true },
    ] });
    const input = { eventKey: "repeat-sms-event", eventType: "appointment.booked", appointment: appointmentWithDoctor };
    await harness.service.sendAppointmentNotification(input);
    await harness.service.sendAppointmentNotification(input);
    assert.equal(harness.smsCalls.length, 2);
    const smsRecords = [...harness.database.records.values()].filter(({ channel }) => channel === "sms");
    assert.equal(smsRecords.length, 2);
    assert.deepEqual(smsRecords.map(({ status, failure_classification }) => [status, failure_classification]), [["simulated", null], ["simulated", null]]);
  });

  it("isolates SMS provider failures from the successful email event delivery", async () => {
    const harness = createHarness({
      preferences: [{ id: appointment.patient_user_id, phone: "+15551234567", sms_consent: true }],
      smsNotificationService: { async sendSms() { throw new Error("provider rejected request"); } },
    });
    const result = await harness.service.sendAppointmentNotification({ eventKey: "sms-provider-failure", eventType: "appointment.booked", appointment });
    const smsRecord = [...harness.database.records.values()].find(({ channel }) => channel === "sms");

    assert.equal(result.sent, true);
    assert.equal(result.outcomes.find(({ channel }) => channel === "email").sent, true);
    assert.equal(smsRecord.status, "ambiguous");
    assert.equal(smsRecord.reason, "unexpected_error");
  });
});
