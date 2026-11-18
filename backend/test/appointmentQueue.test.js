const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const queue = require("../src/services/appointmentQueueService");
const { AppointmentError } = require("../src/services/appointmentService");

function databaseFor(responses, profileRows = [], queryRows = []) {
  const statements = [];
  const client = {
    async query(sql, values) {
      statements.push({ sql, values });
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [] };
      return responses.shift() || { rows: [] };
    },
    release() {},
  };
  return { database: { connect: async () => client, query: async (sql, values) => {
    statements.push({ sql, values });
    return (profileRows.shift() || queryRows.shift()) || { rows: [] };
  } }, statements };
}

test("check-in requires receptionist role and atomically changes only a not-checked-in booking", async () => {
  const mocked = databaseFor([{ rows: [{ appointment_id: "appt", status: "waiting", token_number: 4 }] }]);
  const result = await queue.checkIn(mocked.database, { id: "reception", role: "receptionist" }, "appt");
  assert.equal(result.status, "waiting");
  assert.match(mocked.statements[1].sql, /q\.status = 'not_checked_in'/);
  assert.match(mocked.statements[1].sql, /checked_in_by_user_id = \$2/);
  await assert.rejects(
    queue.checkIn(mocked.database, { id: "doctor", role: "doctor" }, "appt"),
    (error) => error instanceof AppointmentError && error.status === 403,
  );
});

test("duplicate check-in is rejected when the guarded update affects no queue entry", async () => {
  const mocked = databaseFor([{ rows: [] }]);
  await assert.rejects(
    queue.checkIn(mocked.database, { id: "reception", role: "receptionist" }, "appt"),
    (error) => error.code === "QUEUE_STATE_CONFLICT",
  );
});

test("No-show becomes eligible after the appointment starts and rejects checked-in entries", async () => {
  const mocked = databaseFor([{ rows: [{ appointment_id: "appt", status: "no_show" }] }]);
  await queue.markNoShow(mocked.database, { id: "reception", role: "receptionist" }, "appt", "Asia/Kolkata");
  assert.match(mocked.statements[1].sql, /q\.status = 'not_checked_in'/);
  assert.match(mocked.statements[1].sql, /a\.scheduled_start_time/);
  assert.doesNotMatch(mocked.statements[1].sql, /a\.scheduled_end_time|INTERVAL '1 minute'/);
  assert.deepEqual(mocked.statements[1].values, ["appt", "reception", "Asia/Kolkata"]);

  for (const status of ["waiting", "in_progress"]) {
    const rejected = databaseFor([{ rows: [] }]);
    await assert.rejects(
      queue.markNoShow(rejected.database, { id: "reception", role: "receptionist" }, "appt", "Asia/Kolkata"),
      (error) => error.code === "QUEUE_STATE_CONFLICT",
    );
    assert.match(rejected.statements[1].sql, /q\.status = 'not_checked_in'/);
    assert.doesNotMatch(rejected.statements[1].sql, new RegExp(`q\\.status.*${status}`));
  }
});

test("reception no-show eligibility uses scheduled start and application timezone", async () => {
  const mocked = databaseFor([], [], [{ rows: [] }]);
  await queue.appointmentQueue(mocked.database, { id: "reception", role: "receptionist" }, null, "2026-11-18", "Asia/Kolkata");
  assert.match(mocked.statements[0].sql, /a\.scheduled_start_time/);
  assert.match(mocked.statements[0].sql, /AT TIME ZONE \$2/);
  assert.doesNotMatch(mocked.statements[0].sql, /INTERVAL '1 minute'/);
  assert.deepEqual(mocked.statements[0].values, ["2026-11-18", "Asia/Kolkata"]);
});

test("migration resets every lifecycle field on re-confirmation and protects daily tokens", () => {
  const migration = fs.readFileSync(path.join(__dirname, "../migrations/031_appointment_queue.sql"), "utf8");
  assert.match(migration, /UNIQUE \(doctor_id, service_date, token_number\)/);
  assert.match(migration, /pg_advisory_xact_lock\(hashtext\(target_doctor_id::text\), hashtext\(NEW\.scheduled_date::text\)\)/);
  assert.match(migration, /checked_in_at = NULL, checked_in_by_user_id = NULL, called_at = NULL, called_by_user_id = NULL,[\s\S]*completed_at = NULL, no_show_at = NULL, no_show_by_user_id = NULL/);
  assert.match(migration, /OLD\.scheduled_start_time IS DISTINCT FROM NEW\.scheduled_start_time/);
  assert.match(migration, /CREATE TABLE appointment_queue_status_history/);
  assert.match(migration, /CONSTRAINT appointment_queue_call_actor_pair CHECK \(\(called_at IS NULL\) = \(called_by_user_id IS NULL\)\)/);
  assert.match(migration, /ON appointment_queue_entries \(doctor_id, service_date, checked_in_at, token_number\)\s+WHERE status = 'waiting'/);
  assert.match(migration, /CASE NEW\.status\s+WHEN 'waiting' THEN NEW\.checked_in_by_user_id\s+WHEN 'no_show' THEN NEW\.no_show_by_user_id\s+WHEN 'in_progress' THEN NEW\.called_by_user_id\s+WHEN 'completed' THEN/);
  assert.match(migration, /IF TG_OP = 'INSERT' THEN[\s\S]*?ELSE\s+schedule_changed := OLD\.scheduled_date/);
  assert.doesNotMatch(migration, /TG_OP = 'INSERT' OR OLD\./);
  assert.match(migration, /called_by_user_id = NULL, completed_at = NULL/);
  assert.match(migration, /should_assign_token := schedule_changed AND OLD\.status IN \('confirmed', 'cancelled'\)/);
  assert.match(migration, /AND \(NOT reactivating_cancelled OR appointment_queue_entries\.status = 'cancelled'\)/);
  assert.match(migration, /IF reactivating_cancelled AND NOT EXISTS \([\s\S]*?WHERE appointment_id = NEW\.id[\s\S]*?should_assign_token := TRUE;/);
  assert.match(migration, /DO \$\$\s+DECLARE\s+item RECORD;\s+next_token INTEGER;\s+BEGIN/);
  assert.doesNotMatch(migration, /DO \$\$\s+DECLARE item RECORD;\s+DECLARE next_token INTEGER;/);
  assert.match(migration, /WHERE appointment_id = NEW\.id AND status = 'cancelled'/);
  assert.doesNotMatch(migration, /WHERE appointment_id = NEW\.id;\s*END IF;/);
  assert.match(migration, /a\.scheduled_date >= \(NOW\(\) AT TIME ZONE 'Asia\/Kolkata'\)::date/);
  assert.doesNotMatch(migration, /scheduled_start_time\) AT TIME ZONE 'Asia\/Kolkata' > NOW\(\)/);
});

test("Call Next serializes per doctor/day and refuses a second active consultation", async () => {
  const mocked = databaseFor([{ rows: [] }, { rows: [{ appointment_id: "current" }] }], [{ rows: [{ id: "doctor-id" }] }]);
  await assert.rejects(
    queue.callNext(mocked.database, { id: "doctor-user", role: "doctor" }),
    (error) => error.code === "CONSULTATION_ALREADY_IN_PROGRESS",
  );
  assert.match(mocked.statements[2].sql, /pg_advisory_xact_lock/);
});

test("doctor queue separates active and waiting entries, with scheduled appointment list order", async () => {
  const mocked = databaseFor([], [{ rows: [{ id: "doctor-id" }] }], [{ rows: [
    { appointment_id: "late", token_number: 2, status: "waiting", checked_in_at: "2026-11-18T10:30:00Z" },
    { appointment_id: "current", token_number: 3, status: "in_progress", checked_in_at: "2026-11-18T09:00:00Z" },
    { appointment_id: "early", token_number: 9, status: "waiting", checked_in_at: "2026-11-18T10:00:00Z" },
  ] }]);
  const result = await queue.appointmentQueue(mocked.database, { id: "doctor-user", role: "doctor" }, null, "2026-11-18");
  assert.equal(result.current.appointment_id, "current");
  assert.deepEqual(result.waiting.map((entry) => entry.appointment_id), ["early", "late"]);
  assert.match(mocked.statements[1].sql, /ORDER BY a\.scheduled_date ASC, a\.scheduled_start_time ASC, a\.id ASC/);
});

test("Call Next chooses the earliest check-in, with token number as tie-breaker", async () => {
  let nextQuery = "";
  let calledUpdate = "";
  const client = {
    async query(sql) {
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK" || sql.includes("pg_advisory_xact_lock")) return { rows: [] };
      if (sql.includes("status = 'in_progress' FOR UPDATE")) return { rows: [] };
      if (sql.includes("status = 'waiting'")) { nextQuery = sql; return { rows: [{ appointment_id: "earlier-checkin" }] }; }
      if (sql.startsWith("UPDATE appointment_queue_entries SET status = 'in_progress'")) { calledUpdate = sql; return { rows: [{ appointment_id: "earlier-checkin", token_number: 11, status: "in_progress" }] }; }
      throw new Error(`Unexpected transaction query: ${sql}`);
    },
    release() {},
  };
  const database = {
    async query() { return { rows: [{ id: "doctor-id" }] }; },
    async connect() { return client; },
  };
  const result = await queue.callNext(database, { id: "doctor-user", role: "doctor" }, "2026-11-18");
  assert.equal(result.appointment_id, "earlier-checkin");
  assert.match(nextQuery, /ORDER BY q\.checked_in_at ASC, q\.token_number ASC LIMIT 1 FOR UPDATE OF q/);
  assert.match(calledUpdate, /called_at = NOW\(\), called_by_user_id = \$2/);
});

test("concurrent Call Next requests serialize and only one patient becomes active", async () => {
  let lockTail = Promise.resolve();
  let active = false;
  let called = false;
  const database = {
    async query(sql) {
      if (sql.includes("FROM doctors WHERE user_id")) return { rows: [{ id: "doctor-id" }] };
      throw new Error(`Unexpected pool query: ${sql}`);
    },
    async connect() {
      let releaseLock;
      const client = {
        async query(sql) {
          if (sql === "BEGIN") return { rows: [] };
          if (sql.includes("pg_advisory_xact_lock")) {
            const previous = lockTail;
            lockTail = new Promise((resolve) => { releaseLock = resolve; });
            await previous;
            return { rows: [] };
          }
          if (sql.includes("status = 'in_progress' FOR UPDATE")) return { rows: active ? [{ appointment_id: "appt-1" }] : [] };
          if (sql.includes("status = 'waiting'")) return { rows: called ? [] : [{ appointment_id: "appt-1" }] };
          if (sql.startsWith("UPDATE appointment_queue_entries SET status = 'in_progress'")) {
            active = true; called = true;
            return { rows: [{ appointment_id: "appt-1", status: "in_progress" }] };
          }
          if (sql === "COMMIT" || sql === "ROLLBACK") { releaseLock?.(); return { rows: [] }; }
          throw new Error(`Unexpected transaction query: ${sql}`);
        },
        release() { releaseLock?.(); },
      };
      return client;
    },
  };
  const user = { id: "doctor-user", role: "doctor" };
  const results = await Promise.allSettled([queue.callNext(database, user, "2026-11-18"), queue.callNext(database, user, "2026-11-18")]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected" && result.reason.code === "CONSULTATION_ALREADY_IN_PROGRESS").length, 1);
});

test("patient queue position counts waiting patients ahead and the current consultation", async () => {
  const mocked = databaseFor([], [], [
    { rows: [{ appointment_id: "own", doctor_id: "doc", date: "2026-11-18", token_number: 7, status: "waiting" }] },
    { rows: [
      { appointment_id: "ahead", token_number: 12, status: "waiting", checked_in_at: "2026-11-18T10:00:00Z" },
      { appointment_id: "own", token_number: 7, status: "waiting", checked_in_at: "2026-11-18T10:30:00Z" },
      { appointment_id: "current", token_number: 8, status: "in_progress", checked_in_at: "2026-11-18T09:00:00Z" },
    ] },
  ]);
  const result = await queue.patientAppointmentQueue(mocked.database, { id: "patient-user", role: "patient" }, "own");
  assert.deepEqual(result, { token_number: 7, position: 3, people_ahead: 2, current_token: 8, status: "waiting", date: "2026-11-18" });
  assert.match(mocked.statements[0].sql, /p\.user_id = \$2/);
});
