const assert = require("node:assert/strict");
const { it } = require("node:test");
const { createInAppNotificationService } = require("../src/services/inAppNotificationService");

const appointment = {
  id: "11111111-1111-4111-8111-111111111111",
  patient_user_id: "22222222-2222-4222-8222-222222222222",
  doctor_user_id: "33333333-3333-4333-8333-333333333333",
  patient_email: "patient@example.test",
  doctor_email: "doctor@example.test",
  doctor_first_name: "Asha",
  doctor_last_name: "Doctor",
  date: "2099-04-10",
  start_time: "10:00:00",
  end_time: "10:30:00",
  mode: "wave",
};

it("recovers missing booking In-App rows from existing Email delivery records after insertion failures", async () => {
  const queries = [];
  const logs = [];
  const database = { async query(sql) {
    queries.push(sql);
    if (sql.startsWith("INSERT INTO in_app_notifications")) throw new Error("temporary in-app write failure");
    if (sql.startsWith("WITH candidates AS (")) return { rows: [{ id: "recovered-notification" }] };
    throw new Error(`Unexpected query: ${sql}`);
  } };
  const service = createInAppNotificationService({ database, logger: { error: (...args) => logs.push(args) } });

  await service.sendAppointmentNotification({
    eventKey: "appointment.booked:stable-event",
    eventType: "appointment.booked",
    appointment,
    actorRole: "system",
  });
  const recovered = await service.recoverMissingAppointmentNotifications();

  assert.deepEqual(recovered, { recovered: 1 });
  assert.equal(logs.length, 2, "the initial patient and doctor insert failures remain isolated");
  const recoverySql = queries.find((sql) => sql.startsWith("WITH candidates AS ("));
  assert.match(recoverySql, /FROM notification_deliveries delivery/);
  assert.match(recoverySql, /delivery\.channel = 'email'/);
  assert.match(recoverySql, /delivery\.payload IS NOT NULL/);
  assert.match(recoverySql, /NOT EXISTS \([\s\S]*FROM in_app_notifications notification/);
  assert.match(recoverySql, /FOR UPDATE OF delivery SKIP LOCKED/i);
  assert.match(recoverySql, /ON CONFLICT \(recipient_user_id, event_key\) DO NOTHING/i);
  assert.match(recoverySql, /candidate\.payload->>'textContent'/);
});
