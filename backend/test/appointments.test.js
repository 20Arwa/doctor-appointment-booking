const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { describe, it } = require("node:test");
const { createApp } = require("../src/app");
const { createEmailNotificationService } = require("../src/services/emailNotificationService");
const {
  appointmentQuerySchema,
  createAppointmentSchema,
  rescheduleAppointmentSchema,
} = require("../src/validators/appointmentSchemas");

const patientUserId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const doctorUserId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const otherUserId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const patientId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const doctorId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const firstSlotId = "11111111-1111-4111-8111-111111111111";
const secondSlotId = "22222222-2222-4222-8222-222222222222";
const appointmentId = "33333333-3333-4333-8333-333333333333";
const secondAppointmentId = "44444444-4444-4444-8444-444444444444";

const patientUser = { id: patientUserId, role: "patient", is_active: true, first_name: "Pia", last_name: "Patient" };
const doctorUser = { id: doctorUserId, role: "doctor", is_active: true, first_name: "Dara", last_name: "Doctor" };
const otherUser = { id: otherUserId, role: "patient", is_active: true, first_name: "Other", last_name: "Patient" };
const registeredPatientEmail = "pia@example.test";

function makeSlot(id, start_time = "10:00", date = "2099-04-10", deleted_at = null) {
  return { id, doctor_id: doctorId, date, start_time, end_time: "10:30", doctor_active: true, deleted_at };
}

function makeAppointment({ id = appointmentId, availability_id = firstSlotId, status = "confirmed", reason = "Checkup", cancelled_at = null } = {}) {
  return { id, patient_id: patientId, availability_id, status, reason, cancelled_at, created_at: "2099-01-01T00:00:00.000Z", updated_at: "2099-01-01T00:00:00.000Z" };
}

function createDatabase({
  currentUser = patientUser,
  slots = [makeSlot(firstSlotId), makeSlot(secondSlotId, "11:00")],
  appointments = [],
  appointmentRefs = [],
} = {}) {
  const state = { slots: slots.map((slot) => ({ ...slot })), appointments: appointments.map((appointment) => ({ ...appointment })) };
  const lockTails = new Map();

  function details(appointment) {
    const slot = state.slots.find((item) => item.id === appointment.availability_id);
    if (!slot) return undefined;
    return {
      ...appointment,
      date: appointment.scheduled_date ?? slot.date,
      start_time: `${appointment.scheduled_start_time ?? slot.start_time}:00`,
      end_time: `${appointment.scheduled_end_time ?? slot.end_time}:00`,
      doctor_id: doctorId,
      doctor_first_name: doctorUser.first_name,
      doctor_last_name: doctorUser.last_name,
      specialty: "General Practice",
      patient_first_name: "Pia",
      patient_last_name: "Patient",
      patient_email: registeredPatientEmail,
    };
  }

  const database = {
    state,
    async query(sql, values = []) {
      if (sql.includes("FROM users WHERE clerk_user_id")) return { rows: [currentUser] };
      if (sql === "SELECT id FROM patients WHERE user_id = $1") return { rows: currentUser.id === patientUserId ? [{ id: patientId }] : [] };
      if (sql === "SELECT id FROM doctors WHERE user_id = $1") return { rows: currentUser.id === doctorUserId ? [{ id: doctorId }] : [] };
      if (sql.includes("FROM appointments a") && sql.includes("WHERE a.id = $1 AND")) {
        const [id, ownerId] = values;
        const appointment = state.appointments.find((row) => row.id === id);
        const slot = appointment && state.slots.find((item) => item.id === appointment.availability_id);
        const allowed = currentUser.role === "patient"
          ? currentUser.id === patientUserId && appointment?.patient_id === patientId && ownerId === currentUser.id
          : slot?.doctor_id === doctorId && ownerId === currentUser.id;
        return { rows: allowed ? [details(appointment)] : [] };
      }
      if (sql.includes("FROM appointments a") && sql.includes("ORDER BY av.date")) {
        const [ownerId, status, from, to] = values;
        const rows = state.appointments.filter((appointment) => {
          const slot = state.slots.find((item) => item.id === appointment.availability_id);
          const owned = currentUser.role === "patient" ? ownerId === patientUserId && appointment.patient_id === patientId : ownerId === doctorUserId && slot?.doctor_id === doctorId;
          return owned && (!status || appointment.status === status) && (!from || slot.date >= from) && (!to || slot.date <= to);
        }).map(details);
        return { rows };
      }
      throw new Error(`Unexpected database query: ${sql}`);
    },
    async connect() {
      let txAppointments;
      let pendingLocks = [];
      let heldLocks = false;
      const client = {
        async query(sql, values = []) {
          if (sql === "BEGIN") {
            txAppointments = state.appointments.map((appointment) => ({ ...appointment }));
            return { rows: [] };
          }
          if (sql === "SELECT id FROM patients WHERE user_id = $1") {
            return { rows: values[0] === patientUserId ? [{ id: patientId }] : [] };
          }
          if (sql.includes("pg_advisory_xact_lock")) return { rows: [] };
          if (sql.includes("FROM appointment_slot_holds h") && sql.includes("h.expires_at > NOW()")) return { rows: [] };
          if (sql.startsWith("SELECT id, deleted_at FROM availability")) {
            const [ownerDoctorId, date, start, end] = values;
            const slot = state.slots.find((item) => item.doctor_id === ownerDoctorId && item.date === date && item.start_time === start && item.end_time === end);
            return { rows: slot ? [{ id: slot.id, deleted_at: slot.deleted_at }] : [] };
          }
          if (sql.includes("FROM availability av") && sql.includes("FOR UPDATE OF av")) {
            const [slotId] = values;
            const previous = lockTails.get(slotId) || Promise.resolve();
            let release;
            lockTails.set(slotId, new Promise((resolve) => { release = resolve; }));
            await previous;
            pendingLocks.push(release);
            heldLocks = true;
            const slot = state.slots.find((item) => item.id === slotId && item.doctor_active);
            return { rows: slot ? [{ ...slot }] : [] };
          }
          if (sql.startsWith("SELECT id, status") && sql.includes("FROM appointments a JOIN patients")) {
            const [id, ownerId] = values;
            const appointment = txAppointments.find((row) => row.id === id && ownerId === patientUserId && row.patient_id === patientId);
            return { rows: appointment ? [{ ...appointment }] : [] };
          }
          if (sql.startsWith("SELECT id, status") && sql.includes("JOIN availability av")) {
            const [id, ownerDoctorId] = values;
            const appointment = txAppointments.find((row) => {
              const slot = state.slots.find((item) => item.id === row.availability_id);
              return row.id === id && slot?.doctor_id === ownerDoctorId;
            });
            return { rows: appointment ? [{ id: appointment.id, status: appointment.status }] : [] };
          }
          if (sql.includes("FROM appointments a JOIN availability av") && sql.includes("FOR UPDATE OF a")) {
            const [id, ownerDoctorId] = values;
            const appointment = txAppointments.find((row) => row.id === id && state.slots.find((slot) => slot.id === row.availability_id)?.doctor_id === ownerDoctorId);
            return { rows: appointment ? [{ ...appointment, date: appointment.scheduled_date ?? state.slots.find((slot) => slot.id === appointment.availability_id).date, start_time: appointment.scheduled_start_time ?? "10:00", end_time: appointment.scheduled_end_time ?? "10:30" }] : [] };
          }
          if (sql.includes("SELECT 1 FROM appointments other")) {
            const [ownerDoctorId, date, start, end] = values;
            const conflict = [...state.appointments, ...txAppointments].some((row) => {
              if (row.id === values[1] || row.status !== "confirmed") return false;
              const slot = state.slots.find((item) => item.id === row.availability_id);
              const rowDate = row.scheduled_date ?? slot?.date;
              const rowStart = row.scheduled_start_time ?? slot?.start_time;
              const rowEnd = row.scheduled_end_time ?? slot?.end_time;
              return slot?.doctor_id === ownerDoctorId && rowDate === date && rowStart < end && rowEnd > start;
            });
            return { rows: conflict ? [{ "?column?": 1 }] : [] };
          }
          if (sql.startsWith("UPDATE appointments SET availability_id")) {
            const [id, availabilityId, date, start, end] = values;
            const appointment = txAppointments.find((row) => row.id === id);
            if (appointment) Object.assign(appointment, { availability_id: availabilityId, scheduled_date: date, scheduled_start_time: start, scheduled_end_time: end });
            return { rows: [{ id }] };
          }
          if (sql.startsWith("SELECT 1 FROM appointments")) {
            const [slotId] = values;
            const rows = [...state.appointments, ...txAppointments];
            return { rows: rows.some((row) => row.availability_id === slotId && row.status !== "cancelled") ? [{ "?column?": 1 }] : [] };
          }
          if (sql.startsWith("INSERT INTO appointments")) {
            let appointment;
            appointment = makeAppointment({ id: secondAppointmentId, patient_id: values[0], availability_id: values[1], reason: values[2] });
            if (txAppointments.some((row) => row.availability_id === appointment.availability_id && row.status !== "cancelled")) {
              const error = new Error("unique slot index conflict");
              error.code = "23505";
              throw error;
            }
            txAppointments.push(appointment);
            return { rows: [{ id: appointment.id }] };
          }
          if (sql.startsWith("UPDATE appointments SET status = 'cancelled'")) {
            const appointment = txAppointments.find((row) => row.id === values[0]);
            if (appointment) Object.assign(appointment, { status: "cancelled", cancelled_at: "2099-02-01T00:00:00.000Z", updated_at: "2099-02-01T00:00:00.000Z" });
            return { rows: [] };
          }
          if (sql.startsWith("UPDATE appointments SET status = 'completed'")) {
            const appointment = txAppointments.find((row) => row.id === values[0]);
            if (appointment) Object.assign(appointment, { status: "completed", updated_at: "2099-02-01T00:00:00.000Z" });
            return { rows: [] };
          }
          if (sql.includes("FROM appointments a") && sql.includes("WHERE a.id = $1")) {
            const appointment = txAppointments.find((row) => row.id === values[0]);
            return { rows: appointment ? [details(appointment)] : [] };
          }
          if (sql === "COMMIT") {
            state.appointments.splice(0, state.appointments.length, ...txAppointments);
            releaseLocks();
            return { rows: [] };
          }
          if (sql === "ROLLBACK") {
            txAppointments = undefined;
            releaseLocks();
            return { rows: [] };
          }
          throw new Error(`Unexpected transaction query: ${sql}`);
        },
        release() { releaseLocks(); },
      };
      function releaseLocks() {
        if (!heldLocks) return;
        for (const release of pendingLocks) release();
        pendingLocks = [];
        heldLocks = false;
      }
      return client;
    },
  };
  return database;
}

function createTestApp({ currentUser = patientUser, database = createDatabase({ currentUser }), authenticated = true, applicationTimezone = "Asia/Kolkata", emailNotificationService = { sendAppointmentNotification: async () => {} } } = {}) {
  return {
    database,
    app: createApp({
      database,
      frontendOrigin: "http://localhost:3000",
      applicationTimezone,
      emailNotificationService,
      clerkAuthMiddleware: (request, _response, next) => {
        request.auth = Object.assign(
          () => authenticated
            ? { isAuthenticated: true, userId: "clerk_test_user", tokenType: "session_token" }
            : { isAuthenticated: false, userId: null, tokenType: "session_token" },
          { [Symbol.for("@clerk/express.auth")]: true },
        );
        next();
      },
    }),
  };
}

async function withServer(app, callback) {
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  try { await callback(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
}

describe("appointment schemas and migration", () => {
  it("validates appointment IDs, filters, ranges, slot IDs, and request fields", () => {
    assert.equal(appointmentQuerySchema.safeParse({ status: "confirmed", from: "2099-04-01", to: "2099-04-02" }).success, true);
    assert.equal(appointmentQuerySchema.safeParse({ status: "pending" }).success, false);
    assert.equal(appointmentQuerySchema.safeParse({ from: "2099-04-03", to: "2099-04-02" }).success, false);
    assert.equal(createAppointmentSchema.safeParse({ availability_id: firstSlotId, reason: "Checkup" }).success, true);
    assert.equal(createAppointmentSchema.safeParse({ availability_id: "nope", patient_id: patientId }).success, false);
    assert.equal(rescheduleAppointmentSchema.safeParse({ availability_id: secondSlotId }).success, true);
    assert.equal(rescheduleAppointmentSchema.safeParse({ availability_id: secondSlotId, patient_id: patientId }).success, false);
    assert.equal(rescheduleAppointmentSchema.safeParse({ date: "2099-04-11", start_time: "11:00", end_time: "11:30" }).success, true);
    assert.equal(rescheduleAppointmentSchema.safeParse({ date: "2099-04-11", start_time: "12:00", end_time: "11:30" }).success, false);
  });

  it("adds the appointment migrations in order with history-preserving constraints", () => {
    const directory = path.join(__dirname, "..", "migrations");
    const files = fs.readdirSync(directory).filter((file) => file.endsWith(".sql")).sort();
    assert.deepEqual(files.slice(0, 3), ["001_users_patients_doctors.sql", "002_doctor_availability.sql", "003_appointments.sql"]);
    assert.equal(files.length, 11);
    assert.match(files[3], /^004_.*\.sql$/);
    assert.equal(files[4], "005_appointment_schedule_snapshot.sql");
    assert.equal(files[5], "006_doctor_consultation_fee.sql");
    assert.equal(files[6], "007_appointment_reminders.sql");
    assert.equal(files[7], "008_payment_refund_schema.sql");
    assert.equal(files[8], "009_payment_booking_reason.sql");
    assert.equal(files[9], "010_payment_capture_reconciliation.sql");
    assert.equal(files[10], "011_availability_soft_delete.sql");
    const sql = fs.readFileSync(path.join(directory, "003_appointments.sql"), "utf8");
    assert.match(sql, /availability_id UUID NOT NULL REFERENCES availability\(id\) ON DELETE RESTRICT/i);
    assert.match(sql, /status <> 'cancelled' OR cancelled_at IS NOT NULL/i);
    assert.match(sql, /UNIQUE INDEX appointments_availability_active_unique\s+ON appointments \(availability_id\)\s+WHERE status <> 'cancelled'/i);
    const snapshot = fs.readFileSync(path.join(directory, "005_appointment_schedule_snapshot.sql"), "utf8");
    assert.match(snapshot, /DROP INDEX appointments_availability_active_unique/i);
  });
});

describe("appointment workflows", () => {
  it("keeps historical appointments visible through a soft-deleted availability row", async () => {
    const pastSlot = makeSlot(firstSlotId, "10:00", "2000-04-10", "2026-10-30T00:00:00.000Z");
    const historical = makeAppointment({ status: "completed" });
    historical.scheduled_date = "2000-04-10";
    historical.scheduled_start_time = "10:00";
    historical.scheduled_end_time = "10:30";
    const { app } = createTestApp({ database: createDatabase({ slots: [pastSlot], appointments: [historical] }) });
    await withServer(app, async (url) => {
      const list = await fetch(`${url}/api/v1/appointments?status=completed`);
      assert.equal(list.status, 200);
      const rows = await list.json();
      assert.equal(rows.length, 1);
      assert.equal(rows[0].availability_id, firstSlotId);
      assert.equal(rows[0].status, "completed");
      const detail = await fetch(`${url}/api/v1/appointments/${appointmentId}`);
      assert.equal(detail.status, 200);
      assert.equal((await detail.json()).availability_id, firstSlotId);
    });
  });

  it("keeps cancellation and rescheduling notifications for existing appointments", async () => {
    const notifications = [];
    const emailNotificationService = { sendAppointmentNotification: async (...args) => notifications.push(args) };
    const booking = createTestApp({ emailNotificationService });
    await withServer(booking.app, async (url) => {
      const response = await fetch(`${url}/api/v1/appointments`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ availability_id: firstSlotId }) });
      assert.equal(response.status, 402);
      assert.equal((await response.json()).error.code, "PAYMENT_REQUIRED");
    });
    const cancellation = createTestApp({ database: createDatabase({ appointments: [makeAppointment()] }), emailNotificationService });
    await withServer(cancellation.app, async (url) => {
      assert.equal((await fetch(`${url}/api/v1/appointments/${appointmentId}/cancel`, { method: "PUT" })).status, 200);
    });
    const reschedule = createTestApp({ database: createDatabase({ appointments: [makeAppointment()] }), emailNotificationService });
    await withServer(reschedule.app, async (url) => {
      assert.equal((await fetch(`${url}/api/v1/appointments/${appointmentId}/reschedule`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ availability_id: secondSlotId }) })).status, 200);
    });
    assert.deepEqual(notifications.map(([action]) => action), ["cancelled", "rescheduled"]);
    assert.equal(notifications[1][1].previous_date, "2099-04-10");
    assert.equal(notifications[1][1].previous_start_time, "10:00:00");
  });

  it("rejects unpaid direct appointment creation without sending a booking notification", async () => {
    let notificationCount = 0;
    const emailNotificationService = { sendAppointmentNotification: async () => { notificationCount += 1; throw new Error("provider unavailable"); } };
    const { app } = createTestApp({ database: createDatabase({ appointments: [makeAppointment()] }), emailNotificationService });
    await withServer(app, async (url) => {
      const failedBooking = await fetch(`${url}/api/v1/appointments`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ availability_id: secondSlotId }) });
      assert.equal(failedBooking.status, 402);
      assert.equal((await failedBooking.json()).error.code, "PAYMENT_REQUIRED");
      assert.equal(notificationCount, 0);
    });
  });

  it("skips Brevo when credentials are missing and handles provider failures", async () => {
    let calls = 0;
    const appointment = { patient_email: registeredPatientEmail, date: "2099-04-10", start_time: "10:00:00", doctor_first_name: "Dara", doctor_last_name: "Doctor" };
    const missing = createEmailNotificationService({ config: { BREVO_API_KEY: "replace_with_brevo_api_key", BREVO_SENDER_EMAIL: "sender@example.test", BREVO_SENDER_NAME: "Medrella" }, fetchImpl: async () => { calls += 1; } });
    await missing.sendAppointmentNotification("booked", appointment);
    assert.equal(calls, 0);
    const errors = [];
    const failing = createEmailNotificationService({ config: { BREVO_API_KEY: "valid-test-key", BREVO_SENDER_EMAIL: "sender@example.test", BREVO_SENDER_NAME: "Medrella" }, fetchImpl: async () => { calls += 1; return { ok: false, status: 401 }; }, logger: { error: (...args) => errors.push(args) } });
    await failing.sendAppointmentNotification("booked", appointment);
    assert.equal(calls, 1);
    assert.equal(errors.length, 1);
    assert.doesNotMatch(JSON.stringify(errors), /valid-test-key/);
  });

  it("requires a payment order before a future slot can be booked", async () => {
    const { app, database } = createTestApp();
    await withServer(app, async (url) => {
      const response = await fetch(`${url}/api/v1/appointments`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ availability_id: firstSlotId, reason: "Annual checkup" }),
      });
      assert.equal(response.status, 402);
      assert.equal((await response.json()).error.code, "PAYMENT_REQUIRED");
      assert.equal(database.state.appointments.length, 0);

      const duplicate = await fetch(`${url}/api/v1/appointments`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ availability_id: firstSlotId }),
      });
      assert.equal(duplicate.status, 402);
    });
  });

  it("does not allow direct unpaid booking requests to inspect or claim slots", async () => {
    const { app } = createTestApp({ database: createDatabase({ slots: [makeSlot(firstSlotId, "10:00", "2000-01-01")] }) });
    await withServer(app, async (url) => {
      const post = (availability_id) => fetch(`${url}/api/v1/appointments`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ availability_id }),
      });
      assert.equal((await post(secondSlotId)).status, 402);
      assert.equal((await post(firstSlotId)).status, 402);
    });
    const occupied = createTestApp({ database: createDatabase({ appointments: [makeAppointment()] }) });
    await withServer(occupied.app, async (url) => {
      const response = await fetch(`${url}/api/v1/appointments`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ availability_id: firstSlotId }),
      });
      assert.equal(response.status, 402);
    });
  });

  it("lists only the caller's appointments and hides unrelated records by ID", async () => {
    const { app } = createTestApp({ database: createDatabase({ appointments: [makeAppointment()] }) });
    await withServer(app, async (url) => {
      const list = await fetch(`${url}/api/v1/appointments?status=confirmed&from=2099-04-01`);
      assert.equal(list.status, 200);
      assert.equal((await list.json()).length, 1);
      const inaccessible = await fetch(`${url}/api/v1/appointments/${appointmentId}`);
      assert.equal(inaccessible.status, 200);
    });
    const other = createTestApp({ currentUser: otherUser, database: createDatabase({ currentUser: otherUser, appointments: [makeAppointment()] }) });
    await withServer(other.app, async (url) => {
      const inaccessible = await fetch(`${url}/api/v1/appointments/${appointmentId}`);
      assert.equal(inaccessible.status, 404);
      assert.equal((await inaccessible.json()).error.code, "APPOINTMENT_NOT_FOUND");
    });
    const doctor = createTestApp({ currentUser: doctorUser, database: createDatabase({ currentUser: doctorUser, appointments: [makeAppointment()] }) });
    await withServer(doctor.app, async (url) => {
      const list = await fetch(`${url}/api/v1/appointments`);
      assert.equal(list.status, 200);
      assert.equal((await list.json()).length, 1);
    });
  });

  it("cancels without deleting history and denies doctor cancellation under the unspecified policy", async () => {
    const { app, database } = createTestApp({ database: createDatabase({ appointments: [makeAppointment()] }) });
    await withServer(app, async (url) => {
      const cancelled = await fetch(`${url}/api/v1/appointments/${appointmentId}/cancel`, { method: "PUT" });
      assert.equal(cancelled.status, 200);
      assert.equal((await cancelled.json()).status, "cancelled");
      assert.equal(database.state.appointments.length, 1);
      assert.ok(database.state.appointments[0].cancelled_at);
      const again = await fetch(`${url}/api/v1/appointments/${appointmentId}/cancel`, { method: "PUT" });
      assert.equal(again.status, 409);
    });
    const doctor = createTestApp({ currentUser: doctorUser, database: createDatabase({ currentUser: doctorUser, appointments: [makeAppointment()] }) });
    await withServer(doctor.app, async (url) => {
      const response = await fetch(`${url}/api/v1/appointments/${appointmentId}/cancel`, { method: "PUT" });
      assert.equal(response.status, 403);
    });
  });

  it("reschedules atomically while preserving the cancelled original appointment", async () => {
    const { app, database } = createTestApp({ database: createDatabase({ appointments: [makeAppointment()] }) });
    await withServer(app, async (url) => {
      const response = await fetch(`${url}/api/v1/appointments/${appointmentId}/reschedule`, {
        method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ availability_id: secondSlotId }),
      });
      assert.equal(response.status, 200);
      const next = await response.json();
      assert.equal(next.status, "confirmed");
      assert.equal(next.availability_id, secondSlotId);
      assert.equal(next.patient_id, patientId);
      assert.equal(database.state.appointments.length, 2);
      assert.equal(database.state.appointments[0].availability_id, firstSlotId);
      assert.equal(database.state.appointments[0].status, "cancelled");
      assert.ok(database.state.appointments[0].cancelled_at);
    });
    const occupiedTarget = createTestApp({ database: createDatabase({ appointments: [
      makeAppointment(),
      makeAppointment({ id: secondAppointmentId, availability_id: secondSlotId, reason: "Existing booking" }),
    ] }) });
    await withServer(occupiedTarget.app, async (url) => {
      const response = await fetch(`${url}/api/v1/appointments/${appointmentId}/reschedule`, {
        method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ availability_id: secondSlotId }),
      });
      assert.equal(response.status, 409);
      assert.equal(occupiedTarget.database.state.appointments[0].status, "confirmed");
      assert.equal(occupiedTarget.database.state.appointments.length, 2);
    });
  });

  it("lets the owning doctor move the same appointment without changing availability", async () => {
    const slots = [makeSlot(firstSlotId)];
    const { app, database } = createTestApp({ currentUser: doctorUser, database: createDatabase({ currentUser: doctorUser, slots, appointments: [makeAppointment()] }) });
    await withServer(app, async (url) => {
      const response = await fetch(`${url}/api/v1/appointments/${appointmentId}/reschedule`, {
        method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({ date: "2099-04-11", start_time: "12:00", end_time: "12:30" }),
      });
      assert.equal(response.status, 200);
      const updated = await response.json();
      assert.equal(updated.id, appointmentId);
      assert.equal(updated.date, "2099-04-11");
      assert.equal(updated.start_time, "12:00:00");
      assert.equal(database.state.appointments.length, 1);
      assert.equal(database.state.slots[0].date, "2099-04-10");
      assert.equal(database.state.appointments[0].availability_id, firstSlotId);
    });
    const patient = createTestApp({ database: createDatabase({ appointments: [makeAppointment()] }) });
    await withServer(patient.app, async (url) => {
      const response = await fetch(`${url}/api/v1/appointments/${appointmentId}/reschedule`, {
        method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({ date: "2099-04-11", start_time: "12:00", end_time: "12:30" }),
      });
      assert.equal(response.status, 403);
    });
  });

  it("associates a direct doctor reschedule with a matching available slot and releases the old slot", async () => {
    const newSlotId = "55555555-5555-4555-8555-555555555555";
    const slots = [makeSlot(firstSlotId), { ...makeSlot(newSlotId, "12:00", "2099-04-11"), end_time: "12:30" }];
    const { app, database } = createTestApp({ currentUser: doctorUser, database: createDatabase({ currentUser: doctorUser, slots, appointments: [makeAppointment()] }) });
    await withServer(app, async (url) => {
      const response = await fetch(`${url}/api/v1/appointments/${appointmentId}/reschedule`, {
        method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({ date: "2099-04-11", start_time: "12:00", end_time: "12:30" }),
      });
      assert.equal(response.status, 200);
      const updated = await response.json();
      assert.equal(updated.id, appointmentId);
      assert.equal(updated.availability_id, newSlotId);
      assert.equal(updated.status, "confirmed");
      assert.equal(database.state.appointments.length, 1);
      assert.equal(database.state.appointments[0].availability_id, newSlotId);
      assert.equal(database.state.slots[0].date, "2099-04-10");
    });
  });

  it("completes only for the owning doctor and rejects invalid state transitions", async () => {
    const doctor = createTestApp({ currentUser: doctorUser, database: createDatabase({ currentUser: doctorUser, appointments: [makeAppointment()] }) });
    await withServer(doctor.app, async (url) => {
      const response = await fetch(`${url}/api/v1/appointments/${appointmentId}/complete`, { method: "PUT" });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).status, "completed");
      const second = await fetch(`${url}/api/v1/appointments/${appointmentId}/complete`, { method: "PUT" });
      assert.equal(second.status, 409);
    });
    const cancelled = createTestApp({ currentUser: doctorUser, database: createDatabase({ currentUser: doctorUser, appointments: [makeAppointment({ status: "cancelled", cancelled_at: "2099-01-01T00:00:00.000Z" })] }) });
    await withServer(cancelled.app, async (url) => {
      const response = await fetch(`${url}/api/v1/appointments/${appointmentId}/complete`, { method: "PUT" });
      assert.equal(response.status, 409);
    });
  });

  it("serializes concurrent bookings for the same slot", async () => {
    const { app, database } = createTestApp();
    await withServer(app, async (url) => {
      const book = () => fetch(`${url}/api/v1/appointments`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ availability_id: firstSlotId }),
      });
      const responses = await Promise.all([book(), book()]);
      assert.deepEqual(responses.map((response) => response.status).sort(), [402, 402]);
      assert.equal(database.state.appointments.length, 0);
    });
  });

  it("serializes a reschedule against a concurrent booking of its target slot", async () => {
    const { app, database } = createTestApp({ database: createDatabase({ appointments: [makeAppointment()] }) });
    await withServer(app, async (url) => {
      const reschedule = fetch(`${url}/api/v1/appointments/${appointmentId}/reschedule`, {
        method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ availability_id: secondSlotId }),
      });
      const book = fetch(`${url}/api/v1/appointments`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ availability_id: secondSlotId }),
      });
      const responses = await Promise.all([reschedule, book]);
      const statuses = responses.map((response) => response.status);
      assert.deepEqual(statuses.sort(), [200, 402]);
      assert.equal(database.state.appointments.filter((appointment) => appointment.availability_id === secondSlotId && appointment.status !== "cancelled").length, 1);
      assert.equal(database.state.appointments.length, 2);
    });
  });
});
