const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { createAppointmentReminderService } = require("../src/services/appointmentReminderService");
const { createApp } = require("../src/app");

const appointment = { id: "33333333-3333-4333-8333-333333333333", date: "2099-04-10", start_time: "10:00:00", patient_email: "patient@example.test", doctor_first_name: "Dara", doctor_last_name: "Doctor" };

function mockDatabase(initial = [appointment]) {
  const state = { appointments: initial.map((item) => ({ ...item, status: item.status || "confirmed" })), deliveries: new Map(), nextId: 1 };
  return {
    state,
    async query(sql, values = []) {
      if (sql.trimStart().startsWith("SELECT a.id") && sql.includes("FROM appointments a")) {
        return { rows: state.appointments.filter((item) => item.status === "confirmed").map((item) => ({ ...item })) };
      }
      if (sql.startsWith("INSERT INTO appointment_reminder_deliveries")) {
        const [id, type, date, start] = values;
        const current = state.appointments.find((item) => item.id === id && item.status === "confirmed" && item.date === date && item.start_time === start);
        if (!current) return { rows: [] };
        const key = `${id}:${type}:${date}:${start}`;
        if (state.deliveries.has(key)) return { rows: [] };
        const claimId = state.nextId++;
        state.deliveries.set(key, { id: claimId, status: "processing" });
        return { rows: [{ id: claimId }] };
      }
      if (sql.startsWith("UPDATE appointment_reminder_deliveries")) {
        const record = [...state.deliveries.values()].find((item) => item.id === values[0]);
        if (record) record.status = "sent";
        return { rows: [] };
      }
      if (sql.startsWith("DELETE FROM appointment_reminder_deliveries")) {
        for (const [key, item] of state.deliveries) if (item.id === values[0]) state.deliveries.delete(key);
        return { rows: [] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
  };
}

describe("appointment reminders", () => {
  it("checks and sends both the 24 hour and 1 hour reminders", async () => {
    const database = mockDatabase();
    const sent = [];
    const service = createAppointmentReminderService({ database, timeZone: "Asia/Kolkata", emailNotificationService: { sendAppointmentReminder: async (type, item) => { sent.push([type, item.id]); return { sent: true }; } } });
    const result = await service.run();
    assert.deepEqual(sent.map(([type]) => type), ["24h", "1h"]);
    assert.equal(result.sent, 2);
    assert.deepEqual([...database.state.deliveries.values()].map(({ status }) => status), ["sent", "sent"]);
  });

  it("excludes cancelled and completed appointments", async () => {
    const database = mockDatabase([
      { ...appointment, id: "cancelled", status: "cancelled" },
      { ...appointment, id: "completed", status: "completed" },
    ]);
    const sent = [];
    const service = createAppointmentReminderService({ database, timeZone: "Asia/Kolkata", emailNotificationService: { sendAppointmentReminder: async () => { sent.push(true); return { sent: true }; } } });
    await service.run();
    assert.equal(sent.length, 0);
  });

  it("does not send stale reminders after a reschedule and creates reminders for the new schedule", async () => {
    const database = mockDatabase();
    database.state.appointments[0].date = "2099-04-11";
    database.state.appointments[0].start_time = "11:00:00";
    const sent = [];
    const service = createAppointmentReminderService({ database, timeZone: "Asia/Kolkata", emailNotificationService: { sendAppointmentReminder: async (_type, item) => { sent.push(`${item.date} ${item.start_time}`); return { sent: true }; } } });
    await service.run();
    assert.ok(sent.every((schedule) => schedule === "2099-04-11 11:00:00"));
    assert.equal([...database.state.deliveries.keys()].some((key) => key.includes("2099-04-10")), false);
  });

  it("deduplicates retries and concurrent scheduler runs by persistent schedule key", async () => {
    const database = mockDatabase();
    let calls = 0;
    const service = createAppointmentReminderService({ database, timeZone: "Asia/Kolkata", emailNotificationService: { sendAppointmentReminder: async () => { calls += 1; return { sent: true }; } } });
    await service.run();
    await service.run();
    assert.equal(calls, 2);
  });

  it("releases failed claims so the next scheduler run can retry", async () => {
    const database = mockDatabase();
    let calls = 0;
    const service = createAppointmentReminderService({ database, timeZone: "Asia/Kolkata", logger: { error() {} }, emailNotificationService: { sendAppointmentReminder: async () => { calls += 1; if (calls === 1) throw new Error("provider failure"); return { sent: true }; } } });
    const first = await service.run();
    const second = await service.run();
    assert.equal(first.failed, 1);
    assert.equal(second.sent, 1);
    assert.equal(calls, 3);
  });

  it("protects the external scheduler endpoint with a bearer secret", async () => {
    const database = mockDatabase();
    let shouldFail = false;
    const app = createApp({ database, frontendOrigin: "http://localhost:3000", applicationTimezone: "Asia/Kolkata", reminderSecret: "test-secret-that-is-long-enough-to-meet-32", reminderService: { run: async () => { if (shouldFail) throw new Error("database unavailable"); return { sent: 0 }; } }, clerkAuthMiddleware: (_request, _response, next) => next() });
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
