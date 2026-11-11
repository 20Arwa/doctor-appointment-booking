const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const {
  buildAvailabilityDiff,
  desiredWindows,
  filterBlockedAdditions,
  findSavedSchedulePeriodConflicts,
  findWindowBlockers,
  hasAdditionalExceptionOverlap,
  appointmentCoveredBySchedule,
  inspectDiff,
  inspectRemovedReservations,
  isStaleScheduleVersion,
  splitStreamWindowsAroundAppointments,
  excludeRetiringWindowAppointments,
  reconcileStreamCapacity,
  loadInputs,
  updateSchedule,
} = require("../src/controllers/elasticScheduleController");
const { createSchedule, generateAvailability, generatedWindows } = require("../src/controllers/scheduleController");
const { elasticScheduleSchema } = require("../src/validators/scheduleSchemas");
const { eachDateInclusive } = require("../src/utils/dateOnly");

const date = "2099-01-05";
const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
const period = (start_time, end_time) => ({ weekday, start_time, end_time });
const window = (start_time, end_time) => ({ date, start_time, end_time });
const weeklyInput = (periods) => ({ starts_on: date, ends_on: date, periods });

describe("Elastic Scheduling", () => {
  it("rejects a weekly shrink affecting an appointment within six hours before writing schedule data", async () => {
    const appointment = {
      id: "appointment-protected", appointment_id: "appointment-protected", availability_id: "availability-retired",
      allocation_id: "allocation-protected", patient_id: "patient-1", doctor_id: "doctor-1", mode: "wave",
      date, start_time: "09:30:00", end_time: "10:00:00", status: "confirmed",
    };
    const schedule = {
      id: "schedule-1", doctor_id: "doctor-1", mode: "wave", recurrence_type: "weekly", visibility: "public",
      starts_on: date, ends_on: date, wave_capacity_per_slot: 1, stream_capacity_per_window: 0,
      updated_at: "2098-01-01T00:00:00.000000Z",
    };
    const statements = [];
    const client = { async query(sql, values = []) {
      statements.push({ sql, values });
      if (sql === "BEGIN" || sql === "ROLLBACK") return { rows: [] };
      if (sql.includes("FROM doctor_schedules") && sql.includes("FOR UPDATE")) return { rows: [{ id: schedule.id, doctor_id: schedule.doctor_id }] };
      if (sql.includes("FROM doctor_schedules") && sql.includes("updated_at")) return { rows: [schedule] };
      if (sql.includes("FROM doctor_schedule_periods existing_period")) return { rows: [] };
      if (sql.includes("FROM doctor_schedule_periods WHERE schedule_id")) return { rows: [{ weekday, start_time: "09:00:00", end_time: "10:00:00" }] };
      if (sql.includes("FROM doctor_schedule_exceptions")) return { rows: [] };
      if (sql.includes("FROM assisted_reschedule_batches")) return { rows: [] };
      if (sql.startsWith("SELECT av.id FROM availability av")) return { rows: [] };
      if (sql.startsWith("SELECT pg_advisory_xact_lock")) return { rows: [] };
      if (sql.includes("SELECT appointment_duration_minutes FROM doctors WHERE id")) return { rows: [{ appointment_duration_minutes: 30 }] };
      if (sql.startsWith("SELECT av.id, av.date::text AS date")) return { rows: [{
        id: appointment.availability_id, date, start_time: "09:30:00", end_time: "10:00:00", capacity: 1,
        has_confirmed_appointment: true, has_active_allocation: false, has_active_payment_hold: false,
      }] };
      if (sql.includes("FROM availability removed")) return { rows: [] };
      if (sql.includes("SELECT id, schedule_id, date::text AS date") && sql.includes("FROM availability WHERE doctor_id")) return { rows: [] };
      if (sql.includes("SELECT av.schedule_id, scheduled_date::text AS date")) return { rows: [] };
      if (sql.includes("SELECT DISTINCT av.schedule_id")) return { rows: [] };
      if (sql.includes("WHERE a.availability_id = ANY($1::uuid[])")) return { rows: [appointment] };
      if (sql.includes("WHERE h.availability_id = ANY($1::uuid[])")) return { rows: [] };
      if (sql.includes("WHERE allocation.availability_id = ANY($1::uuid[])")) return { rows: [] };
      if (sql.includes("CROSS JOIN (SELECT clock_timestamp() AS checked_at) protection_window")) return { rows: [appointment] };
      throw new Error(`Unexpected protection test query: ${sql}`);
    }, release() {} };
    const input = { mode: "wave", expected_updated_at: schedule.updated_at, starts_on: date, ends_on: date, periods: [period("09:00", "09:30")] };
    const response = {
      locals: { user: { id: "user-1", role: "doctor" }, params: { id: schedule.doctor_id, scheduleId: schedule.id }, body: input,
        applicationTimezone: "Asia/Kolkata",
        database: {
          async query() { return { rows: [{ id: schedule.doctor_id, appointment_duration_minutes: 30 }] }; },
          async connect() { return client; },
        } },
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(payload) { this.payload = payload; return this; },
    };

    await updateSchedule({}, response, (error) => { throw error; });

    assert.equal(response.statusCode, 409);
    assert.equal(response.payload.error.code, "SCHEDULE_CHANGE_PROTECTED_APPOINTMENT");
    assert.equal(response.payload.error.details.protected_appointments[0].date, date);
    assert.equal(response.payload.error.details.protected_appointments[0].start_time, "09:30");
    assert.ok(statements.some(({ sql }) => sql === "ROLLBACK"));
    assert.ok(!statements.some(({ sql }) => /^(INSERT|UPDATE|DELETE)\s/i.test(sql)));
  });

  it("does not regenerate a manually removed scheduled window during Recovery", async () => {
    let inserted = false;
    const client = { async query(sql) {
      if (sql === "BEGIN" || sql === "COMMIT") return { rows: [] };
      if (sql.includes("FROM doctor_schedules") && sql.includes("FOR UPDATE")) return { rows: [{ id: "schedule-removed",
        doctor_id: "doctor-removed", mode: "stream", recurrence_type: "weekly", visibility: "public",
        starts_on: date, ends_on: date, stream_capacity_per_window: 7 }] };
      if (sql.startsWith("SELECT pg_advisory_xact_lock")) return { rows: [] };
      if (sql.includes("FROM doctor_schedule_periods WHERE schedule_id")) return { rows: [{ weekday, service_date: null,
        start_time: "10:00:00", end_time: "10:30:00" }] };
      if (sql.includes("FROM doctor_schedule_exceptions WHERE")) return { rows: [] };
      if (sql.includes("FROM appointments appointment")) return { rows: [] };
      if (sql.includes("FROM availability av") && sql.includes("av.mode IS NULL")) return { rows: [] };
      if (sql.includes("FROM availability av") && sql.includes("schedule_window ON")) return { rows: [] };
      if (sql.includes("FROM availability removed")) {
        assert.doesNotMatch(sql, /removed\.capacity/);
        return { rows: [{ id: "removed-row" }] };
      }
      if (sql.startsWith("INSERT INTO doctor_schedule_windows") || sql.startsWith("INSERT INTO availability")) {
        inserted = true;
        return { rows: [{ id: "unexpected-insert" }] };
      }
      throw new Error(`Unexpected Recovery query: ${sql}`);
    }, release() {} };
    const response = { locals: { params: { id: "doctor-removed", scheduleId: "schedule-removed" },
      body: { from: date, to: date }, user: { id: "user-removed", role: "doctor" }, applicationTimezone: "UTC",
      database: { async query() { return { rows: [{ id: "doctor-removed", appointment_duration_minutes: 30 }] }; },
        async connect() { return client; } } }, statusCode: 200,
      status(code) { this.statusCode = code; return this; }, json(payload) { this.payload = payload; return this; } };

    await generateAvailability({}, response, (error) => { throw error; });

    assert.equal(response.statusCode, 201);
    assert.equal(response.payload.generated_windows, 0);
    assert.equal(inserted, false);
  });

  it("generates Tuesday and Thursday occurrences through the inclusive Dec 18 end date", () => {
    const dates = [...eachDateInclusive("2026-12-07", "2026-12-18")];
    const generatedDates = dates.filter((dateValue) => [2, 4].includes(new Date(`${dateValue}T00:00:00.000Z`).getUTCDay()));
    assert.deepEqual(generatedDates, ["2026-12-08", "2026-12-10", "2026-12-15", "2026-12-17"]);
    assert.deepEqual([...eachDateInclusive("2026-12-07", "2026-12-07")], ["2026-12-07"]);
  });

  it("plans expansion as only newly added Wave slots", () => {
    const current = new Map([[`${date}|09:00|09:30`, window("09:00", "09:30")]]);
    const desired = desiredWindows({ mode: "wave" }, weeklyInput([period("09:00", "10:00")]),
      { appointment_duration_minutes: 30 }, new Map(), "UTC");
    const diff = buildAvailabilityDiff([...current.values()], desired);
    assert.deepEqual(diff.add, [window("09:30", "10:00")]);
    assert.deepEqual(diff.retire, []);
  });

  it("plans shrinkage by retiring only availability outside the proposed hours", () => {
    const current = [window("09:00", "09:30"), window("09:30", "10:00")];
    const desired = desiredWindows({ mode: "wave" }, weeklyInput([period("09:00", "09:30")]),
      { appointment_duration_minutes: 30 }, new Map(), "UTC");
    const diff = buildAvailabilityDiff(current, desired);
    assert.deepEqual(diff.retire, [current[1]]);
    assert.deepEqual(diff.add, []);
  });

  it("retains a Wave schedule's own 11 AM slots when shrinking to 11 AM–noon", () => {
    const current = [["10:00", "10:30"], ["10:30", "11:00"], ["11:00", "11:30"], ["11:30", "12:00"]]
      .map(([start, end]) => ({ id: `wave-${start}`, ...window(start, end) }));
    const desired = desiredWindows({ mode: "wave" }, weeklyInput([period("11:00", "12:00")]),
      { appointment_duration_minutes: 30 }, new Map(), "UTC");
    const diff = buildAvailabilityDiff(current, desired);
    assert.deepEqual(diff.retire.map((row) => row.start_time), ["10:00", "10:30"]);
    assert.equal(diff.kept, 2);
    assert.deepEqual(diff.add, []);
  });

  it("expands Stream availability as a single window per period", () => {
    const desired = desiredWindows({ mode: "stream" }, weeklyInput([period("09:00", "11:00")]),
      { appointment_duration_minutes: 30 }, new Map(), "UTC");
    assert.deepEqual([...desired.values()], [window("09:00", "11:00")]);
  });

  it("reuses an allocated Stream window ID and capacity for a safe expansion", () => {
    const saved = { id: "stream-id", ...window("10:00", "13:00"), capacity: 15, has_active_allocation: true };
    const desired = new Map([[`${date}|09:00|13:00`, window("09:00", "13:00")]]);
    const diff = buildAvailabilityDiff([saved], desired, "stream");
    assert.deepEqual(diff.resized, [{ availability_id: "stream-id", date,
      previous_start_time: "10:00", previous_end_time: "13:00", start_time: "09:00", end_time: "13:00" }]);
    assert.deepEqual(diff.retire, []);
    assert.deepEqual(diff.add, []);
    assert.equal(saved.capacity, 15);
  });

  it("keeps a Stream window with an active payment hold out of in-place resizing", () => {
    const held = { id: "held-stream", ...window("10:00", "13:00"), has_active_payment_hold: true };
    const desired = new Map([[`${date}|09:00|13:00`, window("09:00", "13:00")]]);
    const diff = buildAvailabilityDiff([held], desired, "stream");
    assert.deepEqual(diff.resized, []);
    assert.deepEqual(diff.retire, [held]);
    assert.deepEqual(diff.add, [window("09:00", "13:00")]);
  });

  it("rejects generated-availability conflicts before inserting a schedule", async () => {
    const input = { request_id: "request-1", mode: "wave", recurrence_type: "weekly", visibility: "public",
      starts_on: "2099-01-05", ends_on: "2099-01-05", wave_capacity_per_slot: 1,
      stream_capacity_per_window: 0, periods: [period("10:00", "11:00")] };
    const queries = [];
    const client = { async query(sql) {
      queries.push(sql);
      if (sql === "BEGIN" || sql === "ROLLBACK") return { rows: [] };
      if (sql.startsWith("SELECT id FROM doctor_schedules WHERE id = $1")) return { rows: [] };
      if (sql.includes("pg_advisory_xact_lock")) return { rows: [] };
      if (sql.includes("doctor_schedule_periods existing_period")) return { rows: [] };
      if (sql.includes("SELECT EXISTS (")) return { rows: [{ has_conflict: true }] };
      throw new Error(`Unexpected create query: ${sql}`);
    }, release() {} };
    const response = { locals: {
      user: { id: "user-1", role: "doctor" }, params: { id: "doctor-1" }, body: input,
      applicationTimezone: "UTC", database: {
        async query(sql) { assert.match(sql, /FROM doctors WHERE user_id/); return { rows: [{ id: "doctor-1", appointment_duration_minutes: 30 }] }; },
        async connect() { return client; },
      },
    }, statusCode: 200, status(code) { this.statusCode = code; return this; }, json(payload) { this.payload = payload; return this; } };
    await createSchedule({}, response, (error) => { throw error; });
    assert.equal(response.statusCode, 409);
    assert.equal(response.payload.error.code, "GENERATED_AVAILABILITY_CONFLICT");
    assert.match(response.payload.error.message, /schedule was not saved/i);
    assert.equal(queries.some((sql) => sql.startsWith("INSERT INTO doctor_schedules")), false);
    assert.equal(queries.at(-1), "ROLLBACK");
    assert.deepEqual(generatedWindows(input, 30, "UTC"), [
      { date: "2099-01-05", start_time: "10:00", end_time: "10:30" },
      { date: "2099-01-05", start_time: "10:30", end_time: "11:00" },
    ]);
  });

  it("segments expanded Stream hours around the confirmed appointment and keeps the appointment interval reserved", () => {
    const candidate = { date, start_time: "10:00", end_time: "14:00" };
    const appointments = [{ date, start_time: "11:00:00", end_time: "14:00:00" }];
    assert.deepEqual(splitStreamWindowsAroundAppointments([candidate], appointments), [
      { date, start_time: "10:00", end_time: "11:00" },
    ]);
    assert.equal(appointmentCoveredBySchedule({ date, start_time: "11:00:00", end_time: "14:00:00" },
      weeklyInput([period("10:00", "14:00")]), new Map()), true);
    assert.equal(appointmentCoveredBySchedule({ date, start_time: "10:00:00", end_time: "14:00:00" },
      weeklyInput([period("11:00", "14:00")]), new Map()), false);
  });

  it("reconciles a Stream shrink replacement while preserving the old confirmed allocation capacity", () => {
    const old = { id: "old-stream", ...window("10:00", "15:00"), has_confirmed_appointment: true, has_active_allocation: true };
    const candidate = window("11:00", "15:00");
    const appointment = { availability_id: old.id, date, start_time: "10:00:00", end_time: "15:00:00" };
    assert.deepEqual(splitStreamWindowsAroundAppointments([candidate], excludeRetiringWindowAppointments([appointment], [old])), [candidate]);
    assert.deepEqual(reconcileStreamCapacity(candidate, 15, 1), { ...candidate, capacity: 14 });
    assert.equal(old.start_time, "10:00");
  });

  it("restores the Jan 4, 2027 Stream replacement when only a retired booked window remains", async () => {
    const serviceDate = "2027-01-04";
    const scheduleId = "target-stream-schedule";
    const oldAvailabilityId = "retired-stream-window";
    const confirmedAppointment = { availability_id: oldAvailabilityId, schedule_id: scheduleId,
      date: serviceDate, start_time: "10:00:00", end_time: "15:00:00" };
    const database = { async query(sql) {
      if (sql.includes("FROM doctor_schedules")) return { rows: [{ id: scheduleId, doctor_id: "doctor-1",
        mode: "stream", recurrence_type: "weekly", visibility: "public", starts_on: serviceDate,
        ends_on: serviceDate, wave_capacity_per_slot: 1, stream_capacity_per_window: 7, updated_at: "version" }] };
      if (sql.includes("FROM doctor_schedule_periods WHERE schedule_id = $1")) return { rows: [] };
      if (sql.includes("SELECT appointment_duration_minutes FROM doctors WHERE id")) return { rows: [{ appointment_duration_minutes: 30 }] };
      if (sql.includes("FROM doctor_schedule_exceptions")) return { rows: [] };
      if (sql.includes("FROM availability av") && sql.includes("av.deleted_at IS NULL")) return { rows: [] };
      if (sql.includes("FROM availability removed")) return { rows: [] };
      if (sql.includes("doctor_schedule_periods existing_period")) return { rows: [] };
      if (sql.includes("FROM appointments a JOIN availability av") && sql.includes("scheduled_date BETWEEN")) return { rows: [confirmedAppointment] };
      if (sql.includes("FROM availability av") && sql.includes("av.deleted_at IS NOT NULL")) return { rows: [{
        id: oldAvailabilityId, date: serviceDate, start_time: "10:00:00", end_time: "15:00:00",
        has_confirmed_appointment: true, has_active_allocation: true, has_active_payment_hold: false,
      }] };
      if (sql.includes("COUNT(DISTINCT reservation.patient_id)")) return { rows: [{ count: 1 }] };
      if (sql.includes("FROM availability WHERE doctor_id = $1")) return { rows: [] };
      if (sql.includes("FROM appointments a JOIN availability av")) return { rows: [confirmedAppointment] };
      if (sql.includes("SELECT DISTINCT av.schedule_id")) return { rows: [{ schedule_id: scheduleId,
        date: serviceDate, start_time: "10:00:00", end_time: "15:00:00", has_payment_hold: false, has_allocation: true }] };
      throw new Error(`Unexpected Jan 4 schedule query: ${sql}`);
    } };
    const input = { mode: "stream", starts_on: serviceDate, ends_on: "2027-01-15",
      periods: [{ weekday: 1, start_time: "11:00", end_time: "15:00" },
        { weekday: 2, start_time: "11:00", end_time: "15:00" }] };
    const loaded = await loadInputs({ locals: { database, applicationTimezone: "UTC" } }, "doctor-1", scheduleId, input);
    assert.deepEqual(loaded.additions, [
      { date: "2027-01-04", start_time: "11:00", end_time: "15:00", capacity: 6 },
      { date: "2027-01-05", start_time: "11:00", end_time: "15:00" },
      { date: "2027-01-11", start_time: "11:00", end_time: "15:00" },
      { date: "2027-01-12", start_time: "11:00", end_time: "15:00" },
    ]);
    assert.equal(loaded.blocked.length, 0);
  });

  it("persists Jan 4–5 Stream candidates with booked Monday at capacity 6 and unbooked Tuesday at 7", async () => {
    const doctorId = "doctor-1";
    const scheduleId = "target-stream-schedule";
    const serviceDate = "2027-01-04";
    const currentVersion = "2026-11-09T00:00:00.000000Z";
    const oldId = "retired-stream-window";
    const oldRow = { id: oldId, date: serviceDate, start_time: "10:00:00", end_time: "15:00:00", capacity: 7,
      has_confirmed_appointment: true, has_active_allocation: true, has_active_payment_hold: false };
    const appointment = { availability_id: oldId, schedule_id: scheduleId, date: serviceDate,
      start_time: "10:00:00", end_time: "15:00:00" };
    const schedule = { id: scheduleId, doctor_id: doctorId, mode: "stream", recurrence_type: "weekly", visibility: "public",
      starts_on: serviceDate, ends_on: serviceDate, wave_capacity_per_slot: 1, stream_capacity_per_window: 7,
      updated_at: currentVersion };
    const insertedAvailability = [];
    const statements = [];
    let committed = false;
    const client = { async query(sql, values = []) {
      statements.push({ sql, values });
      if (sql === "BEGIN" || sql === "ROLLBACK") return { rows: [] };
      if (sql === "COMMIT") { committed = true; return { rows: [] }; }
      if (sql.includes("FROM doctor_schedules")) return { rows: [{ ...schedule }] };
      if (sql.includes("FROM doctor_schedule_periods existing_period")) return { rows: [] };
      if (sql.includes("FROM doctor_schedule_periods WHERE schedule_id")) return { rows: [] };
      if (sql.includes("FROM doctor_schedule_exceptions")) return { rows: [] };
      if (sql.includes("FROM availability removed")) return { rows: [] };
      if (sql.includes("SELECT appointment_duration_minutes FROM doctors WHERE id")) return { rows: [{ appointment_duration_minutes: 30 }] };
      if (sql.includes("FROM availability av") && sql.includes("av.deleted_at IS NULL")) return { rows: [] };
      if (sql.includes("FROM appointments a JOIN availability av") && sql.includes("scheduled_date BETWEEN")) return { rows: [appointment] };
      if (sql.includes("FROM availability av") && sql.includes("av.deleted_at IS NOT NULL")) return { rows: [oldRow] };
      if (sql.includes("COUNT(DISTINCT reservation.patient_id)")) return { rows: [{ count: 1 }] };
      if (sql.includes("FROM availability WHERE doctor_id = $1")) return { rows: [] };
      if (sql.includes("FROM appointments a JOIN availability av")) return { rows: [appointment] };
      if (sql.includes("SELECT DISTINCT av.schedule_id")) return { rows: [{ schedule_id: scheduleId,
        date: serviceDate, start_time: oldRow.start_time, end_time: oldRow.end_time,
        has_payment_hold: false, has_allocation: true }] };
      if (sql.startsWith("INSERT INTO doctor_schedule_windows")) return { rows: [{ id: `replacement-window-${insertedAvailability.length + 1}` }] };
      if (sql.startsWith("INSERT INTO availability")) {
        const row = { id: `replacement-availability-${insertedAvailability.length + 1}`, doctor_id: values[0], date: values[1],
          start_time: values[2], end_time: values[3], schedule_window_id: values[4], schedule_id: values[5],
          mode: values[6], booking_visibility: values[7], capacity: values[8], deleted_at: null };
        insertedAvailability.push(row);
        return { rows: [{ id: row.id }] };
      }
      if (sql.startsWith("DELETE FROM doctor_schedule_periods")) return { rows: [] };
      if (sql.startsWith("INSERT INTO doctor_schedule_periods")) return { rows: [] };
      if (sql.startsWith("UPDATE doctor_schedules SET starts_on")) return { rows: [] };
      if (sql.startsWith("SELECT av.id FROM availability")) return { rows: [] };
      if (sql.startsWith("SELECT pg_advisory_xact_lock")) return { rows: [] };
      throw new Error(`Unexpected Stream update query: ${sql}`);
    }, release() {} };
    const input = { mode: "stream", expected_updated_at: currentVersion, starts_on: serviceDate, ends_on: "2027-01-05",
      periods: [{ weekday: 1, start_time: "11:00", end_time: "15:00" },
        { weekday: 2, start_time: "11:00", end_time: "15:00" }] };
    const response = { locals: { user: { id: "user-1", role: "doctor" }, params: { id: doctorId, scheduleId }, body: input,
      applicationTimezone: "UTC", database: {
        async query() { return { rows: [{ id: doctorId, appointment_duration_minutes: 30 }] }; },
        async connect() { return client; },
      } }, statusCode: 200, status(code) { this.statusCode = code; return this; },
      json(payload) { this.payload = payload; return this; } };

    await updateSchedule({}, response, (error) => { throw error; });

    assert.equal(committed, true);
    assert.deepEqual(insertedAvailability.map(({ date, start_time, end_time, capacity }) => ({ date, start_time, end_time, capacity })), [
      { date: "2027-01-04", start_time: "11:00", end_time: "15:00", capacity: 6 },
      { date: "2027-01-05", start_time: "11:00", end_time: "15:00", capacity: 7 },
    ]);
    assert.equal(oldRow.start_time, "10:00:00");
    assert.equal(oldRow.end_time, "15:00:00");
    assert.equal(oldRow.capacity, 7);
    assert.equal(response.statusCode, 200);
    assert.equal(response.payload.added_count, 2);
    assert.deepEqual(response.payload.generated.map((row) => row.availability_id), ["replacement-availability-1", "replacement-availability-2"]);
    assert.ok(statements.some(({ sql }) => sql === "COMMIT"));
    assert.ok(!statements.some(({ sql }) => sql.startsWith("UPDATE availability SET deleted_at")));
  });

  it("keeps the availability diff isolated to the edited schedule ID", async () => {
    const currentRows = [{ id: "target-availability", date, start_time: "11:00:00", end_time: "11:30:00" }];
    const database = { async query(sql, values) {
      assert.match(sql, /WHERE av\.schedule_id = \$1 AND av\.deleted_at IS NULL/);
      assert.equal(values[0], "target-schedule");
      return { rows: currentRows };
    } };
    const desired = new Map([[`${date}|11:00|11:30`, window("11:00", "11:30")]]);
    const diff = await inspectDiff(database, { id: "target-schedule" }, desired, "2099-01-01");
    assert.equal(diff.kept, 1);
    assert.deepEqual(diff.retire, []);
    assert.deepEqual(diff.add, []);
  });

  it("does not classify the edited Wave schedule's own slots as other availability conflicts", async () => {
    const ownSlot = { id: "own-slot", schedule_id: "target-schedule", date, start_time: "11:00:00", end_time: "12:00:00" };
    const database = { async query(sql) {
      if (sql.includes("FROM availability WHERE doctor_id = $1")) return { rows: [ownSlot] };
      if (sql.includes("FROM appointments a JOIN availability")) return { rows: [] };
      if (sql.includes("SELECT DISTINCT av.schedule_id")) return { rows: [] };
      if (sql.includes("SELECT DISTINCT av.date::text")) return { rows: [] };
      throw new Error(`Unexpected conflict query: ${sql}`);
    } };
    const conflicts = await findWindowBlockers(database, "doctor-1", "target-schedule",
      new Map([[`${date}|11:00|12:00`, { date, start_time: "11:00", end_time: "12:00" }]]), []);
    assert.deepEqual(conflicts, []);
  });

  it("reports confirmed appointments, active holds, and allocations separately for removed availability", async () => {
    const retire = [{ id: "old-stream", date, start_time: "10:00:00", end_time: "14:00:00" }];
    const database = { async query(sql) {
      if (sql.includes("FROM appointments a WHERE")) return { rows: [{ id: "appointment-1", availability_id: "old-stream", allocation_id: "allocation-1", status: "confirmed", date, start_time: "11:00:00", end_time: "14:00:00" }] };
      if (sql.includes("FROM appointment_slot_holds h JOIN availability")) return { rows: [{ id: "hold-1", availability_id: "old-stream", date, start_time: "10:00:00", end_time: "14:00:00", expires_at: "2099-01-01T00:00:00Z" }] };
      if (sql.includes("FROM appointment_allocations allocation JOIN availability")) return { rows: [
        { id: "allocation-1", availability_id: "old-stream", status: "confirmed", expires_at: null, date, start_time: "10:00:00", end_time: "14:00:00" },
        { id: "unassociated-allocation", availability_id: "old-stream", status: "confirmed", expires_at: null, date, start_time: "10:00:00", end_time: "14:00:00" },
      ] };
      throw new Error(`Unexpected reservation query: ${sql}`);
    } };
    const reservations = await inspectRemovedReservations(database, retire,
      weeklyInput([period("11:00", "14:00")]), new Map());
    assert.deepEqual(reservations.affectedAppointments, []);
    assert.equal(reservations.activePaymentHolds[0].id, "hold-1");
    assert.deepEqual(reservations.activeAllocations.map((row) => row.id), ["unassociated-allocation"]);
    const shrinkReservations = await inspectRemovedReservations(database, retire,
      weeklyInput([period("12:00", "14:00")]), new Map());
    assert.equal(shrinkReservations.affectedAppointments[0].id, "appointment-1");
  });

  it("uses the doctor's current profile duration for Wave preview windows", () => {
    const desired = desiredWindows({ mode: "wave" }, weeklyInput([period("09:00", "10:30")]),
      { appointment_duration_minutes: 45 }, new Map(), "UTC");
    assert.deepEqual([...desired.values()], [window("09:00", "09:45"), window("09:45", "10:30")]);
  });

  it("marks confirmed appointments on removed availability for preservation", () => {
    const current = [{ id: "booked", ...window("09:30", "10:00"), has_confirmed_appointment: true }];
    const desired = desiredWindows({ mode: "wave" }, weeklyInput([period("09:00", "09:30")]),
      { appointment_duration_minutes: 30 }, new Map(), "UTC");
    const diff = buildAvailabilityDiff(current, desired);
    assert.equal(diff.affected[0].availability_id, "booked");
    assert.equal(diff.affected[0].has_confirmed_appointment, true);
  });

  it("preserves both active payment holds and active allocations on retired slots", () => {
    const current = [
      { id: "payment-hold", ...window("09:30", "10:00"), has_active_payment_hold: true },
      { id: "allocation-hold", ...window("10:00", "10:30"), has_active_allocation: true },
    ];
    const desired = desiredWindows({ mode: "stream" }, weeklyInput([period("09:00", "09:30")]),
      { appointment_duration_minutes: 30 }, new Map(), "UTC");
    const diff = buildAvailabilityDiff(current, desired);
    assert.deepEqual(diff.affected.map((item) => [item.has_active_payment_hold, item.has_active_allocation]), [[true, undefined], [undefined, true]]);
  });

  it("applies saved date exceptions without changing their records", () => {
    const exceptions = new Map([[date, { exception_type: "override", periods: [{ start_time: "11:00", end_time: "11:30" }] }]]);
    const desired = desiredWindows({ mode: "wave" }, weeklyInput([period("09:00", "09:30")]),
      { appointment_duration_minutes: 30 }, exceptions, "UTC");
    assert.deepEqual([...desired.values()], [window("11:00", "11:30")]);
    exceptions.set(date, { exception_type: "day_off", periods: [] });
    assert.equal(desiredWindows({ mode: "wave" }, weeklyInput([period("09:00", "09:30")]),
      { appointment_duration_minutes: 30 }, exceptions, "UTC").size, 0);
  });

  it("rejects an edit that would make a preserved additional-hours exception overlap", () => {
    const exceptions = new Map([[date, { service_date: date, exception_type: "additional", periods: [{ start_time: "09:30", end_time: "10:00" }] }]]);
    assert.equal(hasAdditionalExceptionOverlap(weeklyInput([period("09:00", "10:00")]), exceptions), true);
    assert.equal(hasAdditionalExceptionOverlap(weeklyInput([period("09:00", "09:30")]), exceptions), false);
  });

  it("finds conflicting saved weekly periods even when no availability exists", async () => {
    const savedPeriod = {
      schedule_id: "saved-schedule",
      recurrence_type: "weekly",
      weekday,
      service_date: null,
      start_time: "09:30:00",
      end_time: "10:00:00",
    };
    const database = { async query(sql, values) {
      assert.match(sql, /doctor_schedule_periods existing_period/);
      assert.match(sql, /existing_schedule\.active AND existing_schedule\.archived_at IS NULL/);
      assert.equal(values[0], "doctor-owner");
      assert.equal(values[1], weekday);
      assert.equal(values[8], "edited-schedule");
      return { rows: [savedPeriod] };
    } };
    const conflicts = await findSavedSchedulePeriodConflicts(database, "doctor-owner", "edited-schedule", {
      ...weeklyInput([period("09:00", "10:00")]), mode: "wave",
    });
    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0].existing_schedule_id, "saved-schedule");
    assert.deepEqual(filterBlockedAdditions([window("09:00", "09:30")], [window("09:00", "09:30")]), []);
  });

  it("uses the same blocker calculation for availability, appointments, payment holds, and allocations", async () => {
    const windows = [window("09:00", "09:30"), window("10:00", "10:30"), window("11:00", "11:30"), window("12:00", "12:30")];
    const database = { async query(sql) {
      if (sql.includes("FROM availability WHERE doctor_id")) {
        return { rows: [{ id: "legacy", schedule_id: null, date, start_time: "09:00:00", end_time: "09:30:00" }] };
      }
      if (sql.includes("FROM appointments a JOIN availability")) {
        return { rows: [{ date, start_time: "10:00:00", end_time: "10:30:00" }] };
      }
      if (sql.includes("SELECT DISTINCT av.schedule_id")) {
        return { rows: [
          { date, start_time: "11:00:00", end_time: "11:30:00", has_payment_hold: true, has_allocation: false },
          { date, start_time: "12:00:00", end_time: "12:30:00", has_payment_hold: false, has_allocation: true },
        ] };
      }
      if (sql.includes("SELECT DISTINCT av.date::text")) {
        return { rows: [
          { date, start_time: "11:00:00", end_time: "11:30:00", has_payment_hold: true, has_allocation: false },
          { date, start_time: "12:00:00", end_time: "12:30:00", has_payment_hold: false, has_allocation: true },
        ] };
      }
      throw new Error(`Unexpected blocker query: ${sql}`);
    } };
    const blocked = await findWindowBlockers(database, "doctor-owner", "edited-schedule", new Map(windows.map((item) => [`${date}|${item.start_time}|${item.end_time}`, item])), []);
    assert.deepEqual(blocked.map((item) => item.reasons[0]), [
      "overlaps_other_availability",
      "overlaps_confirmed_appointment",
      "overlaps_active_payment_hold",
      "overlaps_active_allocation",
    ]);
    assert.deepEqual(filterBlockedAdditions(windows, blocked), []);
  });

  it("rejects invalid preview/update inputs and detects concurrent schedule edits", () => {
    const valid = { mode: "wave", expected_updated_at: "2026-10-01T00:00:00.000Z", starts_on: date, ends_on: date, periods: [period("09:00", "10:00")] };
    assert.equal(elasticScheduleSchema.safeParse(valid).success, true);
    assert.equal(elasticScheduleSchema.safeParse({ ...valid, unexpected: true }).success, false);
    assert.equal(isStaleScheduleVersion("2026-10-02T00:00:00.000Z", valid.expected_updated_at), true);
    assert.equal(isStaleScheduleVersion(valid.expected_updated_at, valid.expected_updated_at), false);
  });

  it("persists the two-week Wave expansion through PUT and returns committed diff counts", async () => {
    const doctorId = "doctor-1";
    const scheduleId = "schedule-1";
    const startsOn = "2099-01-05"; // Monday
    const endsOn = "2099-01-18";
    const currentVersion = "2026-10-01T00:00:00.123456Z";
    const weekdays = [1, 3, 5];
    const desiredInput = {
      mode: "wave",
      expected_updated_at: currentVersion,
      starts_on: startsOn,
      ends_on: endsOn,
      periods: weekdays.map((weekdayValue) => ({ weekday: weekdayValue, start_time: "09:00", end_time: "12:00" })),
    };
    const existingAvailability = [];
    const cursor = new Date(`${startsOn}T00:00:00Z`);
    const lastDate = new Date(`${endsOn}T00:00:00Z`);
    let oldId = 0;
    for (; cursor <= lastDate; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
      if (!weekdays.includes(cursor.getUTCDay())) continue;
      const dateValue = cursor.toISOString().slice(0, 10);
      for (let minute = 600; minute < 720; minute += 30) {
        const start = `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
        const endMinute = minute + 30;
        const end = `${String(Math.floor(endMinute / 60)).padStart(2, "0")}:${String(endMinute % 60).padStart(2, "0")}`;
        existingAvailability.push({
          id: `existing-${oldId++}`, date: dateValue, start_time: `${start}:00`, end_time: `${end}:00`, capacity: 1,
          has_confirmed_appointment: false, has_active_allocation: false, has_active_payment_hold: false,
        });
      }
    }

    const schedule = {
      id: scheduleId, doctor_id: doctorId, mode: "wave", recurrence_type: "weekly", visibility: "public",
      starts_on: startsOn, ends_on: endsOn, wave_capacity_per_slot: 1, stream_capacity_per_window: 0,
      updated_at: currentVersion,
    };
    let nextGeneratedId = 0;
    let committed = false;
    let windowInsertCount = 0;
    let availabilityInsertCount = 0;
    const writtenPeriods = [];
    const client = {
      async query(sql, values = []) {
        if (sql === "BEGIN" || sql === "ROLLBACK") return { rows: [] };
        if (sql === "COMMIT") { committed = true; return { rows: [] }; }
        if (sql.includes("FROM doctor_schedules")) return { rows: [{ ...schedule }] };
        if (sql.includes("FROM doctor_schedule_periods existing_period")) return { rows: [] };
        if (sql.includes("FROM doctor_schedule_periods WHERE schedule_id")) return { rows: [] };
        if (sql.includes("FROM doctor_schedule_exceptions")) return { rows: [] };
        if (sql.includes("FROM availability removed")) return { rows: [] };
        if (sql.includes("SELECT appointment_duration_minutes FROM doctors WHERE id")) return { rows: [{ appointment_duration_minutes: 30 }] };
        if (sql.includes("SELECT id, appointment_duration_minutes FROM doctors WHERE user_id")) return { rows: [{ id: doctorId, appointment_duration_minutes: 30 }] };
        if (sql.includes("FROM availability av") && sql.includes("av.schedule_id = $1")) return { rows: existingAvailability };
        if (sql.includes("FROM availability av") && sql.includes("av.doctor_id = $1")) return { rows: [] };
        if (sql.includes("FROM availability WHERE doctor_id = $1")) return { rows: [] };
        if (sql.includes("FROM appointments a JOIN availability")) return { rows: [] };
        if (sql.includes("SELECT DISTINCT av.date::text")) return { rows: [] };
        if (sql.startsWith("INSERT INTO doctor_schedule_windows")) {
          windowInsertCount += 1;
          assert.equal(values[1], doctorId);
          return { rows: [{ id: `new-window-${nextGeneratedId}` }] };
        }
        if (sql.startsWith("INSERT INTO availability")) {
          availabilityInsertCount += 1;
          return { rows: [{ id: `new-availability-${nextGeneratedId++}` }] };
        }
        if (sql.startsWith("INSERT INTO doctor_schedule_periods")) { writtenPeriods.push(values); return { rows: [] }; }
        if (sql.startsWith("DELETE FROM doctor_schedule_periods")) return { rows: [] };
        if (sql.startsWith("UPDATE doctor_schedules SET starts_on")) {
          schedule.starts_on = values[1]; schedule.ends_on = values[2]; schedule.updated_at = "2026-10-02T00:00:00.000000Z";
          return { rows: [] };
        }
        if (sql.startsWith("SELECT av.id FROM availability")) return { rows: [] };
        if (sql.startsWith("SELECT pg_advisory_xact_lock")) return { rows: [] };
        throw new Error(`Unexpected update query: ${sql}`);
      },
      release() {},
    };
    const response = {
      locals: {
        user: { id: "user-1", role: "doctor" },
        params: { id: doctorId, scheduleId },
        body: desiredInput,
        applicationTimezone: "UTC",
        database: {
          async query(sql) {
            assert.match(sql, /FROM doctors WHERE user_id/);
            return { rows: [{ id: doctorId, appointment_duration_minutes: 30 }] };
          },
          async connect() { return client; },
        },
      },
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(payload) { this.payload = payload; return this; },
    };

    await updateSchedule({}, response, (error) => { throw error; });

    assert.equal(committed, true);
    assert.equal(windowInsertCount, 12);
    assert.equal(availabilityInsertCount, 12);
    assert.equal(writtenPeriods.length, 3);
    assert.deepEqual(writtenPeriods.map((values) => values.slice(1)), [
      [1, "09:00", "12:00"], [3, "09:00", "12:00"], [5, "09:00", "12:00"],
    ]);
    assert.equal(schedule.starts_on, startsOn);
    assert.equal(schedule.ends_on, endsOn);
    assert.equal(response.statusCode, 200);
    assert.equal(response.payload.added_count, 12);
    assert.equal(response.payload.removed_count, 0);
    assert.equal(response.payload.unchanged_count, 24);
    assert.equal(response.payload.wave_appointment_duration_minutes, 30);
  });
});
