const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { createAssistedRescheduleNotificationService } = require("../src/services/assistedRescheduleNotificationService");
const { createEmailNotificationService } = require("../src/services/emailNotificationService");
const { createInAppNotificationService } = require("../src/services/inAppNotificationService");
const { createNotificationDeliveryService } = require("../src/services/notificationDeliveryService");

const requestId = "11111111-1111-4111-8111-111111111111";
const appointmentId = "22222222-2222-4222-8222-222222222222";
const patientUserId = "33333333-3333-4333-8333-333333333333";
const emailConfig = { BREVO_API_KEY: "test-key", BREVO_SENDER_EMAIL: "sender@example.test", BREVO_SENDER_NAME: "Clinic" };
const context = {
  id: requestId, appointment_id: appointmentId, patient_user_id: patientUserId,
  patient_email: "patient@example.test", doctor_first_name: "Asha", doctor_last_name: "Doctor",
  previous_date: "2099-04-10", previous_start_time: "10:00:00", suggestion_count: 2,
  appointment_status: "confirmed", snapshot_matches: true,
};

function workerFixture({ inAppFails = false, failFinalize = false, contextRow = context, claims = 1 } = {}) {
  let claimCount = 0;
  let inAppCount = 0;
  let finalizeCount = 0;
  const queries = [];
  const database = { async query(sql, values = []) {
    queries.push({ sql, values });
    if (sql.startsWith("UPDATE assisted_reschedule_requests request") && sql.includes("NOT EXISTS")) return { rows: [], rowCount: 0 };
    if (sql.includes("WITH candidates")) {
      claimCount += 1;
      return { rows: claimCount <= claims ? [{ id: requestId, notification_lease_token: `lease-${claimCount}`, notification_attempt_count: claimCount }] : [] };
    }
    if (sql.includes("JOIN users doctor_user")) return { rows: contextRow ? [{ ...contextRow }] : [] };
    if (sql.includes("SET notification_status = 'not_required'")) return { rows: [{ id: requestId }], rowCount: 1 };
    if (sql.includes("SET notification_status = $3")) {
      finalizeCount += 1;
      if (failFinalize && finalizeCount === 1) throw new Error("simulated process crash before request finalization");
      return { rows: [{ id: requestId }], rowCount: 1 };
    }
    throw new Error(`Unexpected query: ${sql}`);
  } };
  const emailCalls = [];
  let providerSends = 0;
  const emailKeys = new Set();
  const inAppCalls = [];
  const notificationDeliveryService = { async sendAssistedRescheduleEmail(input) {
    emailCalls.push(input);
    const duplicate = emailKeys.has(input.eventKey);
    emailKeys.add(input.eventKey);
    if (!duplicate) providerSends += 1;
    return { sent: true, duplicate };
  } };
  const inAppNotificationService = { async sendAssistedRescheduleRequested(input) {
    inAppCalls.push(input);
    inAppCount += 1;
    if (inAppFails && inAppCount === 1) throw new Error("In-App store unavailable");
    return { created: inAppCount === 1 };
  } };
  const service = createAssistedRescheduleNotificationService({
    database, notificationDeliveryService, inAppNotificationService,
    frontendOrigin: "https://clinic.example.test/", logger: { error() {} },
  });
  return { service, database, queries, emailCalls, inAppCalls, get providerSends() { return providerSends; } };
}

test("claims assisted requests with SKIP LOCKED so concurrent workers dispatch once", async () => {
  const fixture = workerFixture({ claims: 1 });
  const [first, second] = await Promise.all([fixture.service.run(), fixture.service.run()]);
  assert.equal(first.claimed + second.claimed, 1);
  assert.equal(fixture.emailCalls.length, 1);
  assert.equal(fixture.inAppCalls.length, 1);
  assert.equal(fixture.emailCalls[0].appointmentUrl, `https://clinic.example.test/patient/appointments?appointment=${appointmentId}`);
  const claim = fixture.queries.find(({ sql }) => sql.includes("WITH candidates"));
  assert.match(claim.sql, /FOR UPDATE OF request SKIP LOCKED/i);
  assert.match(claim.sql, /notification_lease_expires_at <= NOW\(\)/i);
  assert.match(claim.sql, /notification_lease_token = gen_random_uuid\(\)/i);
  assert.match(claim.sql, /request\.expires_at > NOW\(\)/i);
});

test("notification recovery expires requests at the original appointment deadline without dispatching them", async () => {
  const fixture = workerFixture({ claims: 0 });
  const result = await fixture.service.run();
  assert.equal(result.claimed, 0);
  assert.equal(fixture.emailCalls.length, 0);
  assert.equal(fixture.inAppCalls.length, 0);
  const sweep = fixture.queries.find(({ sql }) => sql.startsWith("UPDATE assisted_reschedule_requests request"));
  assert.match(sweep.sql, /request\.expires_at <= NOW\(\)/i);
  assert.match(sweep.sql, /THEN 'expired' ELSE 'superseded' END/i);
});

test("reclaims an expired request lease after a worker crashes between channel work and finalization", async () => {
  const fixture = workerFixture({ claims: 2, failFinalize: true });
  const first = await fixture.service.run();
  const second = await fixture.service.run();
  assert.equal(first.failed, 0);
  assert.equal(second.dispatched, 1);
  assert.equal(fixture.emailCalls.length, 2);
  assert.equal(fixture.inAppCalls.length, 2);
  assert.ok(fixture.queries.some(({ sql }) => sql.includes("notification_status = 'processing' AND request.notification_lease_expires_at <= NOW()")));
});

test("retries only the failed channel after a partial Email and In-App delivery", async () => {
  const fixture = workerFixture({ inAppFails: true, claims: 2 });
  const first = await fixture.service.run();
  const second = await fixture.service.run();
  assert.equal(first.failed, 1);
  assert.equal(second.dispatched, 1);
  assert.equal(fixture.emailCalls.length, 2);
  assert.equal(fixture.providerSends, 1);
  assert.equal(fixture.inAppCalls.length, 2);
  assert.ok(fixture.emailCalls[1]);
  assert.deepEqual(fixture.emailCalls[0].eventKey, fixture.emailCalls[1].eventKey);
});

test("does not dispatch requests whose appointment snapshot is stale or request is superseded", async () => {
  for (const row of [null, { ...context, appointment_status: "confirmed", snapshot_matches: false }]) {
    const fixture = workerFixture({ contextRow: row });
    const result = await fixture.service.run();
    assert.equal(result.skipped, 1);
    assert.equal(fixture.emailCalls.length, 0);
    assert.equal(fixture.inAppCalls.length, 0);
    assert.ok(fixture.queries.some(({ sql }) => sql.includes("SET notification_status = 'not_required'")));
  }
});

test("Email template and In-App record require patient choice and point to the existing appointment route", async () => {
  const email = createEmailNotificationService({
    config: emailConfig,
    fetchImpl: async () => ({ ok: true, status: 201 }),
  });
  const emailPayload = email.createAssistedReschedulePayload({ ...context, id: appointmentId }, `https://clinic.example.test/patient/appointments?appointment=${appointmentId}`);
  const appointmentUrl = `https://clinic.example.test/patient/appointments?appointment=${appointmentId}`;
  assert.match(emailPayload.subject, /Choose a new appointment time/);
  assert.match(emailPayload.textContent, /choose and confirm a new time/i);
  assert.ok(emailPayload.textContent.endsWith(appointmentUrl));
  assert.equal(emailPayload.htmlContent.split(`href="${appointmentUrl}"`).length - 1, 2);

  const inserted = [];
  const inApp = createInAppNotificationService({ database: { async query(sql, values) {
    if (sql.includes("INSERT INTO in_app_notifications")) { inserted.push({ sql, values }); return { rows: [{ id: "notification-1" }] }; }
    throw new Error(`Unexpected query: ${sql}`);
  } } });
  await inApp.sendAssistedRescheduleRequested({ eventKey: `assisted:${requestId}`, appointment: { ...context, id: appointmentId }, recipientUserId: patientUserId, requestId });
  assert.equal(inserted[0].values[2], `assisted:${requestId}`);
  assert.equal(inserted[0].values[3], "appointment.assisted_reschedule_requested");
  assert.match(inserted[0].values[5], /choose and confirm a new time/i);
  assert.equal(inserted[0].values[1], appointmentId);
  assert.match(inserted[0].sql, /appointment\.updated_at = request\.appointment_updated_at/);
});

test("generic notification delivery refuses assisted-event SMS and its dedicated delivery is Email-only", async () => {
  let smsCalls = 0;
  const generic = createNotificationDeliveryService({
    database: { async query() { return { rows: [] }; } },
    emailNotificationService: { async sendNotificationPayload() { throw new Error("unexpected email send"); } },
    smsNotificationService: { providerName: "mock", async sendSms() { smsCalls += 1; return { sent: true }; } },
  });
  const blocked = await generic.sendAppointmentNotification({
    eventKey: "assisted-key", eventType: "appointment.assisted_reschedule_requested",
    appointment: { ...context, id: appointmentId, doctor_user_id: "doctor-user" },
  });
  assert.equal(blocked.skipped, true);
  const smsBlocked = await generic.sendSmsDelivery({
    eventKey: "assisted-key", eventType: "appointment.assisted_reschedule_requested",
    appointment: { ...context, id: appointmentId }, recipient: { type: "patient", userId: patientUserId },
    message: "Must not be sent", to: "+15551234567", consent: true,
  });
  assert.equal(smsBlocked.skipped, true);
  assert.equal(smsCalls, 0);

  const migration = fs.readFileSync(path.join(__dirname, "..", "migrations", "026_assisted_reschedule_notifications.sql"), "utf8");
  assert.match(migration, /ALTER TABLE notification_deliveries[\s\S]*appointment\.assisted_reschedule_requested/i);
  assert.match(migration, /ALTER TABLE in_app_notifications[\s\S]*appointment\.assisted_reschedule_requested/i);
  assert.match(migration, /notification_lease_expires_at TIMESTAMPTZ/i);
  assert.match(migration, /notification_attempt_count INTEGER/i);
});

test("dedicated Email delivery reuses the request event key and accepted channel record on retry", async () => {
  const records = new Map();
  let emailSends = 0;
  let smsSends = 0;
  const database = { async query(sql, values = []) {
    if (sql.startsWith("INSERT INTO notification_deliveries")) {
      const key = `${values[0]}:${values[4]}`;
      if (records.has(key)) return { rows: [] };
      const row = { id: "delivery-1", status: "processing", event_key: values[0], channel: values[4],
        provider: values[5], idempotency_key: values[7], payload: JSON.parse(values[6]),
        lease_token: values[8], appointment_id: values[2], recipient_user_id: values[3] };
      records.set(key, row);
      return { rows: [row] };
    }
    if (sql.includes("FROM assisted_reschedule_requests request")) return { rows: [{ "?column?": 1 }] };
    if (sql.startsWith("UPDATE notification_deliveries SET status = $2")) {
      const row = [...records.values()][0];
      row.status = values[1];
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("SELECT id FROM notification_deliveries")) return { rows: [{ id: "delivery-1" }] };
    if (sql.includes("SELECT status, failure_classification")) return { rows: [{ status: "accepted" }] };
    throw new Error(`Unexpected query: ${sql}`);
  } };
  const deliveryService = createNotificationDeliveryService({
    database,
    emailNotificationService: {
      createAssistedReschedulePayload: (_appointment, url) => ({
        to: "patient@example.test", subject: "Choose a new time", textContent: `Confirm here: ${url}`,
        sender: { email: "sender@example.test", name: "Clinic" },
      }),
      async sendNotificationPayload(_payload, idempotencyKey) { emailSends += 1; assert.ok(idempotencyKey); return { sent: true, attempts: 1 }; },
    },
    smsNotificationService: { providerName: "mock", async sendSms() { smsSends += 1; return { sent: true }; } },
  });
  const input = { eventKey: `appointment.assisted_reschedule_requested:${requestId}:patient:${patientUserId}`,
    appointment: { ...context, id: appointmentId }, recipientUserId: patientUserId,
    appointmentUrl: `https://clinic.example.test/patient/appointments?appointment=${appointmentId}` };
  assert.equal((await deliveryService.sendAssistedRescheduleEmail(input)).sent, true);
  const retry = await deliveryService.sendAssistedRescheduleEmail(input);
  assert.equal(retry.sent, true);
  assert.equal(retry.duplicate, true);
  assert.equal(emailSends, 1);
  assert.equal(smsSends, 0);
  assert.equal(records.size, 1);
  assert.match([...records.values()][0].event_key, new RegExp(requestId));
});
