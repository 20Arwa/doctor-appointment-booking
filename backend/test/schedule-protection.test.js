const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { createException } = require("../src/controllers/scheduleController");
const {
  appointmentAffectedByException,
  failForProtectedAppointments,
  findProtectedAppointmentsByIds,
  findProtectedAppointmentsForAvailability,
  findProtectedAppointmentsForScheduleDate,
} = require("../src/services/scheduleProtectionService");

describe("six-hour schedule protection", () => {
  it("queries appointment starts in the configured timezone and returns actionable date/time details", async () => {
    const appointment = { appointment_id: "appointment-1", date: "2026-11-11", start_time: "10:15:00", end_time: "10:45:00" };
    const calls = [];
    const client = { async query(sql, values) { calls.push({ sql, values }); return { rows: [appointment] }; } };
    const [byIds, bySchedule, byAvailability] = await Promise.all([
      findProtectedAppointmentsByIds(client, [appointment.appointment_id], "Asia/Kolkata"),
      findProtectedAppointmentsForScheduleDate(client, "schedule-1", appointment.date, "Asia/Kolkata"),
      findProtectedAppointmentsForAvailability(client, "availability-1", "Asia/Kolkata"),
    ]);
    assert.deepEqual(byIds, [appointment]);
    assert.deepEqual(bySchedule, [appointment]);
    assert.deepEqual(byAvailability, [appointment]);
    for (const { sql, values } of calls) {
      assert.match(sql, /scheduled_date \+ appointment\.scheduled_start_time\) AT TIME ZONE/);
      assert.match(sql, /INTERVAL '6 hours'/);
      assert.match(sql, /appointment\.status = 'confirmed'/);
      assert.equal(values.at(-1), "Asia/Kolkata");
    }

    const response = { status(code) { this.statusCode = code; return this; }, json(payload) { this.payload = payload; return this; } };
    assert.equal(failForProtectedAppointments(response, [appointment]), true);
    assert.equal(response.statusCode, 409);
    assert.equal(response.payload.error.code, "SCHEDULE_CHANGE_PROTECTED_APPOINTMENT");
    assert.deepEqual(response.payload.error.details.protected_appointments, [{
      appointment_id: appointment.appointment_id, date: appointment.date, start_time: "10:15", end_time: "10:45",
    }]);
  });

  it("only considers appointments changed by the exception, allowing covered bookings and added hours", () => {
    const appointment = { start_time: "10:00:00", end_time: "10:30:00" };
    assert.equal(appointmentAffectedByException(appointment, "day_off", []), true);
    assert.equal(appointmentAffectedByException(appointment, "override", [{ start_time: "09:30", end_time: "11:00" }]), false);
    assert.equal(appointmentAffectedByException(appointment, "override", [{ start_time: "10:15", end_time: "11:00" }]), true);
    assert.equal(appointmentAffectedByException(appointment, "additional", [{ start_time: "12:00", end_time: "13:00" }]), false);
  });

  it("rejects a protected Day Off before inserting the exception", async () => {
    const appointment = { appointment_id: "appointment-1", date: "2026-11-11", start_time: "10:15:00", end_time: "10:45:00" };
    const statements = [];
    const client = { async query(sql) {
      statements.push(sql);
      if (sql === "BEGIN" || sql === "ROLLBACK") return { rows: [] };
      if (sql.includes("FROM doctor_schedules") && sql.includes("FOR UPDATE")) return { rows: [{ id: "schedule-1", recurrence_type: "weekly" }] };
      if (sql.includes("FROM doctor_schedule_exceptions") && sql.includes("FOR UPDATE")) return { rows: [] };
      if (sql.startsWith("SELECT id FROM availability WHERE schedule_id")) return { rows: [] };
      if (sql.startsWith("SELECT pg_advisory_xact_lock")) return { rows: [] };
      if (sql.includes("CROSS JOIN (SELECT clock_timestamp() AS checked_at) protection_window")) return { rows: [appointment] };
      throw new Error(`Unexpected exception protection query: ${sql}`);
    }, release() {} };
    const response = {
      locals: {
        params: { id: "doctor-1", scheduleId: "schedule-1" },
        body: { service_date: appointment.date, exception_type: "day_off", periods: [] },
        user: { id: "doctor-user-1", role: "doctor" }, applicationTimezone: "Asia/Kolkata",
        database: {
          async query() { return { rows: [{ id: "doctor-1" }] }; },
          async connect() { return client; },
        },
      },
      status(code) { this.statusCode = code; return this; },
      json(payload) { this.payload = payload; return this; },
    };

    await createException({}, response, (error) => { throw error; });

    assert.equal(response.statusCode, 409);
    assert.equal(response.payload.error.code, "SCHEDULE_CHANGE_PROTECTED_APPOINTMENT");
    assert.equal(response.payload.error.details.protected_appointments[0].date, appointment.date);
    assert.ok(statements.includes("ROLLBACK"));
    assert.ok(!statements.some((sql) => /^(INSERT|UPDATE|DELETE)\s/i.test(sql)));
  });

  it("allows Add Hours beside a protected existing booking without retiring its availability", async () => {
    const appointment = { appointment_id: "appointment-1", availability_id: "old-slot", date: "2099-01-05", start_time: "09:00:00", end_time: "09:30:00" };
    const statements = [];
    let connection = 0;
    const database = {
      async query() { return { rows: [{ id: "doctor-1", appointment_duration_minutes: 30 }] }; },
      async connect() {
        connection += 1;
        if (connection === 1) return {
          async query(sql, values = []) {
            statements.push({ sql, values });
            if (sql === "BEGIN" || sql === "COMMIT" || sql.startsWith("SELECT pg_advisory_xact_lock")) return { rows: [] };
            if (sql.includes("FROM doctor_schedules") && sql.includes("FOR UPDATE")) return { rows: [{ id: "schedule-1", recurrence_type: "weekly" }] };
            if (sql.includes("FROM doctor_schedule_periods") && sql.startsWith("SELECT 1")) return { rows: [] };
            if (sql.includes("FROM doctor_schedule_periods WHERE schedule_id")) return { rows: [] };
            if (sql.includes("FROM doctor_schedule_exceptions") && sql.includes("FOR UPDATE")) return { rows: [] };
            if (sql.startsWith("SELECT id FROM availability WHERE schedule_id")) return { rows: [] };
            if (sql.includes("CROSS JOIN (SELECT clock_timestamp() AS checked_at) protection_window")) return { rows: [appointment] };
            if (sql.startsWith("SELECT 1 FROM availability av") && sql.includes("appointment_slot_holds")) return { rows: [] };
            if (sql.startsWith("INSERT INTO doctor_schedule_exceptions")) return { rows: [{ id: "exception-1", schedule_id: "schedule-1", service_date: appointment.date, exception_type: "additional" }] };
            if (sql.startsWith("SELECT start_time::text AS start_time")) return { rows: [] };
            if (sql.startsWith("INSERT INTO doctor_schedule_exception_periods")) return { rows: [] };
            if (sql.includes("FROM availability av") && sql.includes("av.mode IS NULL")) return { rows: [] };
            if (sql.includes("UPDATE availability SET deleted_at")) return { rows: [] };
            throw new Error(`Unexpected Add Hours transaction query: ${sql}`);
          }, release() {},
        };
        return {
          async query(sql, values = []) {
            statements.push({ sql, values });
            if (sql === "BEGIN" || sql === "COMMIT" || sql.startsWith("SELECT pg_advisory_xact_lock")) return { rows: [] };
            if (sql.includes("FROM doctor_schedules") && sql.includes("FOR UPDATE")) return { rows: [{
              id: "schedule-1", doctor_id: "doctor-1", mode: "wave", recurrence_type: "weekly", visibility: "public",
              starts_on: appointment.date, ends_on: appointment.date, wave_capacity_per_slot: 1, stream_capacity_per_window: 0,
            }] };
            if (sql.startsWith("SELECT weekday, service_date::text AS service_date")) return { rows: [{ weekday: 2, service_date: null, start_time: "09:00:00", end_time: "10:00:00" }] };
            if (sql.includes("FROM doctor_schedule_exceptions WHERE schedule_id")) return { rows: [{ id: "exception-1", exception_type: "additional" }] };
            if (sql.startsWith("SELECT start_time::text AS start_time")) return { rows: [{ start_time: "11:00:00", end_time: "11:30:00" }] };
            if (sql.includes("FROM appointments appointment") && sql.includes("scheduled_start_time <")) {
              return { rows: values[2] === "09:00" ? [{ id: appointment.appointment_id }] : [] };
            }
            if (sql.includes("FROM availability av") && sql.includes("av.mode IS NULL")) return { rows: [] };
            if (sql.includes("FROM availability av") && sql.includes("JOIN doctor_schedule_windows")) return { rows: [] };
            if (sql.includes("FROM availability removed") && sql.includes("JOIN doctor_schedule_windows")) return { rows: [] };
            if (sql.includes("FROM availability removed JOIN doctor_schedule_windows")) return { rows: [] };
            if (sql.startsWith("SELECT EXISTS (")) return { rows: [{ has_conflict: false }] };
            if (sql.startsWith("INSERT INTO doctor_schedule_windows") || sql.startsWith("INSERT INTO availability")) return { rows: [{ id: "generated" }] };
            throw new Error(`Unexpected Add Hours generation query: ${sql}`);
          }, release() {},
        };
      },
    };
    const response = {
      locals: {
        params: { id: "doctor-1", scheduleId: "schedule-1" },
        body: { service_date: appointment.date, exception_type: "additional", periods: [{ start_time: "11:00", end_time: "11:30" }] },
        user: { id: "doctor-user-1", role: "doctor" }, applicationTimezone: "Asia/Kolkata", database,
      },
      status(code) { this.statusCode = code; return this; },
      json(payload) { this.payload = payload; return this; },
    };

    await createException({}, response, (error) => { throw error; });

    assert.equal(response.statusCode, 201);
    assert.equal(response.payload.exception_type, "additional");
    assert.ok(!statements.some(({ sql }) => sql.startsWith("UPDATE availability SET deleted_at")));
    assert.ok(!statements.some(({ sql }) => sql.includes("SCHEDULE_EXCEPTION_BOOKED")));
    assert.ok(statements.some(({ sql }) => sql.startsWith("INSERT INTO doctor_schedule_exception_periods")));
  });
});
