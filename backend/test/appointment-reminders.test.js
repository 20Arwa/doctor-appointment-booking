const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { createAppointmentReminderService } = require("../src/services/appointmentReminderService");
const { createApp } = require("../src/app");

const appointment = { id: "33333333-3333-4333-8333-333333333333", date: "2099-04-10", start_time: "10:00:00", patient_email: "patient@example.test", patient_user_id: "44444444-4444-4444-8444-444444444444", patient_phone: "+15551234567", patient_sms_consent: true, doctor_first_name: "Dara", doctor_last_name: "Doctor" };

function mockDatabase(initial = [appointment]) {
  const state = { appointments: initial.map((item) => ({ ...item, status: item.status || "confirmed" })), calls: [] };
  return {
    state,
    async query(sql, values = []) {
      state.calls.push({ sql, values });
      if (sql.trimStart().startsWith("SELECT a.id") && sql.includes("FROM appointments a")) {
        return { rows: state.appointments.filter((item) => item.status === "confirmed").map((item) => ({ ...item })) };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
  };
}

describe("appointment reminders", () => {
  it("keeps the scheduler focused on in-app and SMS; email delivery belongs to the notification outbox", async () => {
    const database = mockDatabase();
    const inAppCalls = [];
    const smsCalls = [];
    const service = createAppointmentReminderService({
      database,
      timeZone: "Asia/Kolkata",
      inAppNotificationService: { async sendReminder(type, item) { inAppCalls.push([type, item.id]); } },
      notificationDeliveryService: { async sendSmsDelivery(input) { smsCalls.push(input); } },
    });
    const result = await service.run();
    assert.deepEqual(inAppCalls, [["24h", appointment.id], ["1h", appointment.id]]);
    assert.deepEqual(smsCalls.map(({ eventType }) => eventType), ["appointment.reminder_24h", "appointment.reminder_1h"]);
    assert.equal(result.considered, 2);
    assert.equal(result.smsAttempted, 2);
    assert.equal(database.state.calls.length, 2);
    assert.ok(database.state.calls.every(({ values }) => values[0] === "Asia/Kolkata"));
  });

  it("continues SMS reminder dispatch when in-app persistence fails", async () => {
    const smsCalls = [];
    const service = createAppointmentReminderService({
      database: mockDatabase(),
      timeZone: "Asia/Kolkata",
      logger: { error() {} },
      inAppNotificationService: { async sendReminder() { throw new Error("storage unavailable"); } },
      notificationDeliveryService: { async sendSmsDelivery(input) { smsCalls.push(input); } },
    });
    await service.run();
    assert.equal(smsCalls.length, 2);
  });

  it("builds reminder SMS content from the current scheduled time", async () => {
    const smsCalls = [];
    const service = createAppointmentReminderService({
      database: mockDatabase(),
      timeZone: "Asia/Kolkata",
      notificationDeliveryService: { async sendSmsDelivery(input) { smsCalls.push(input); } },
    });
    await service.run();
    assert.ok(smsCalls.every(({ recipient }) => recipient.userId === appointment.patient_user_id));
    assert.ok(smsCalls.every(({ to, consent }) => to === undefined && consent === undefined));
    assert.ok(smsCalls.every(({ eventKey }) => eventKey.includes("2099-04-10:10:00:00")));
    assert.match(smsCalls[0].message, /24-hour appointment with Dr\. Dara Doctor/);
    assert.match(smsCalls[1].message, /1-hour appointment with Dr\. Dara Doctor/);
  });

  it("excludes cancelled and completed appointments from reminder support channels", async () => {
    const database = mockDatabase([
      { ...appointment, id: "cancelled", status: "cancelled" },
      { ...appointment, id: "completed", status: "completed" },
    ]);
    let inAppCalls = 0;
    let smsCalls = 0;
    const service = createAppointmentReminderService({
      database,
      timeZone: "Asia/Kolkata",
      inAppNotificationService: { async sendReminder() { inAppCalls += 1; } },
      notificationDeliveryService: { async sendSmsDelivery() { smsCalls += 1; } },
    });
    await service.run();
    assert.equal(inAppCalls, 0);
    assert.equal(smsCalls, 0);
  });

  it("uses the configured timezone and five-minute window to retain existing SMS reminder timing", async () => {
    const database = mockDatabase();
    const query = database.query.bind(database);
    database.query = async (sql, values = []) => {
      if (sql.trimStart().startsWith("SELECT a.id") && sql.includes("AT TIME ZONE")) database.state.windowValues ||= [];
      if (database.state.windowValues) database.state.windowValues.push(values);
      return query(sql, values);
    };
    await createAppointmentReminderService({ database, timeZone: "Asia/Kolkata" }).run();
    assert.deepEqual(database.state.windowValues, [["Asia/Kolkata", "24 hours", "5 minutes"], ["Asia/Kolkata", "1 hour", "5 minutes"]]);
  });

  it("protects the external reminder scheduler endpoint with a bearer secret", async () => {
    const database = mockDatabase();
    let shouldFail = false;
    const app = createApp({ database, frontendOrigin: "http://localhost:3000", applicationTimezone: "Asia/Kolkata", reminderSecret: "test-secret-that-is-long-enough-to-meet-32", reminderService: { run: async () => { if (shouldFail) throw new Error("database unavailable"); return { considered: 0 }; } }, clerkAuthMiddleware: (_request, _response, next) => next() });
    const server = app.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    try {
      const url = `http://127.0.0.1:${server.address().port}/api/v1/internal/reminders/run`;
      assert.equal((await fetch(url, { method: "POST" })).status, 401);
      assert.equal((await fetch(url, { method: "POST", headers: { authorization: "Bearer test-secret-that-is-long-enough-to-meet-32" } })).status, 200);
      shouldFail = true;
      assert.equal((await fetch(url, { method: "POST", headers: { authorization: "Bearer test-secret-that-is-long-enough-to-meet-32" } })).status, 500);
    } finally {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
