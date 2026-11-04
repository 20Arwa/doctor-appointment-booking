const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { createEmailNotificationService } = require("../src/services/emailNotificationService");

const config = { BREVO_API_KEY: "test-api-key", BREVO_SENDER_EMAIL: "sender@example.test", BREVO_SENDER_NAME: "Medrella" };
const appointment = {
  patient_email: "patient@example.test", doctor_first_name: "Dara", doctor_last_name: "Doctor",
  date: "2099-04-10", start_time: "10:00:00", previous_date: "2099-04-09", previous_start_time: "09:00:00",
};
const ok = { ok: true, status: 201 };

describe("Brevo email notification service", () => {
  it("sends appointment notifications with the configured sender and existing template", async () => {
    let request;
    const service = createEmailNotificationService({ config, fetchImpl: async (url, options) => { request = { url, options }; return ok; } });
    const result = await service.sendAppointmentNotification("rescheduled", appointment);
    const body = JSON.parse(request.options.body);
    assert.equal(result.sent, true);
    assert.equal(request.url, "https://api.brevo.com/v3/smtp/email");
    assert.equal(request.options.headers["api-key"], config.BREVO_API_KEY);
    assert.deepEqual(body.sender, { email: config.BREVO_SENDER_EMAIL, name: config.BREVO_SENDER_NAME });
    assert.deepEqual(body.to, [{ email: appointment.patient_email }]);
    assert.equal(body.subject, "Appointment rescheduled");
    assert.match(body.textContent, /2099-04-09 at 09:00 to 2099-04-10 at 10:00/);
    assert.ok(request.options.signal instanceof AbortSignal);
  });

  it("aborts a stalled request at the configured timeout and retries only within the attempt limit", async () => {
    let calls = 0;
    const logs = [];
    const service = createEmailNotificationService({
      config, timeoutMs: 5, maxAttempts: 2, retryDelayMs: 0, delay: async () => {}, logger: { error: (...args) => logs.push(args) },
      fetchImpl: (_url, { signal }) => {
        calls += 1;
        return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new DOMException("secret-bearing detail", "AbortError")), { once: true }));
      },
    });
    const result = await service.sendAppointmentNotification("booked", appointment);
    assert.equal(result.reason, "timeout");
    assert.equal(calls, 2);
    assert.equal(logs.length, 1);
  });

  it("retries temporary network failures but respects the bounded attempt count", async () => {
    let calls = 0;
    const service = createEmailNotificationService({ config, maxAttempts: 3, retryDelayMs: 0, delay: async () => {}, fetchImpl: async () => { calls += 1; throw new TypeError("network unavailable"); } });
    const result = await service.sendAppointmentReminder("1h", appointment);
    assert.equal(result.reason, "network_error");
    assert.equal(calls, 3);
  });

  it("does not retry permanent provider errors and logs only sanitized details", async () => {
    let calls = 0;
    const logs = [];
    const service = createEmailNotificationService({
      config, retryDelayMs: 0, logger: { error: (...args) => logs.push(args) },
      fetchImpl: async () => { calls += 1; return { ok: false, status: 401, text: async () => `${config.BREVO_API_KEY} ${appointment.patient_email}` }; },
    });
    const result = await service.sendAppointmentNotification("cancelled", appointment);
    assert.equal(result.status, 401);
    assert.equal(calls, 1);
    assert.doesNotMatch(JSON.stringify(logs), new RegExp(`${config.BREVO_API_KEY}|${appointment.patient_email}`));
    assert.deepEqual(logs[0][1], { failure: "provider_error", status: 401, attempts: 1 });
  });

  it("retries temporary provider responses and stops after the configured limit", async () => {
    let calls = 0;
    const service = createEmailNotificationService({ config, maxAttempts: 2, retryDelayMs: 0, delay: async () => {}, fetchImpl: async () => { calls += 1; return { ok: false, status: 503 }; } });
    const result = await service.sendAppointmentReminder("24h", appointment);
    assert.equal(result.status, 503);
    assert.equal(calls, 2);
  });

  it("distinguishes missing configuration and recipient without making requests", async () => {
    let calls = 0;
    const fetchImpl = async () => { calls += 1; return ok; };
    const missingConfig = createEmailNotificationService({ config: { ...config, BREVO_API_KEY: "replace_with_key" }, fetchImpl });
    assert.deepEqual(await missingConfig.sendAppointmentNotification("booked", appointment), { sent: false, skipped: true, reason: "missing_configuration" });
    const missingRecipient = createEmailNotificationService({ config, fetchImpl });
    assert.deepEqual(await missingRecipient.sendAppointmentReminder("1h", { ...appointment, patient_email: "" }), { sent: false, skipped: true, reason: "missing_recipient" });
    assert.equal(calls, 0);
  });

  it("keeps reminder and appointment notification method results compatible on success", async () => {
    let count = 0;
    const service = createEmailNotificationService({ config, fetchImpl: async () => { count += 1; return ok; } });
    assert.deepEqual(await service.sendAppointmentNotification("booked", appointment), { sent: true });
    assert.deepEqual(await service.sendAppointmentReminder("24h", appointment), { sent: true });
    assert.equal(count, 2);
  });
});
