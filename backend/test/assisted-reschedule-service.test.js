const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  createRequestsForAffectedAppointments,
  findAlternatives,
  findScheduleUpdateBatch,
  supersedeCoveredRequestsForScheduleChange,
  getPatientRequest,
  listDoctorRequests,
  scheduleRequestFingerprint,
} = require("../src/services/assistedRescheduleService");

function appointment(id, mode) {
  return {
    id,
    availability_id: `old-${id}`,
    appointment_updated_at: "2026-11-01T00:00:00.000Z",
    date: "2026-12-10",
    start_time: "10:00:00",
    end_time: "10:30:00",
    doctor_id: "doctor-1",
    patient_id: `patient-${id}`,
    mode,
  };
}

test("discovers only public alternatives for the same doctor and booking mode with capacity", async () => {
  let occupancyChecks = 0;
  const database = { async query(sql, values) {
    if (sql.includes("FROM availability") && sql.includes("booking_visibility = 'public'")) {
      assert.deepEqual(values.slice(0, 3), ["doctor-1", "wave", "old-appointment-1"]);
      assert.match(sql, /mode = \$2/);
      assert.match(sql, /booking_visibility = 'public'/);
      return { rows: [
        { id: "wave-open", mode: "wave", capacity: 3, date: "2026-12-10", start_time: "11:00:00", end_time: "11:30:00" },
        { id: "wave-full", mode: "wave", capacity: 1, date: "2026-12-11", start_time: "10:00:00", end_time: "10:30:00" },
      ] };
    }
    if (sql.includes("COUNT(DISTINCT reservation.patient_id)")) {
      occupancyChecks += 1;
      return { rows: values[0].map((id) => ({ availability_id: id, occupied: 1 })) };
    }
    throw new Error(`Unexpected query: ${sql}`);
  } };
  const suggestions = await findAlternatives(database, appointment("appointment-1", "wave"), "Asia/Kolkata");
  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0].mode, "wave");
  assert.equal(suggestions[0].remaining_capacity_at_suggestion, 2);
});

test("continues alternative discovery past full first-page candidates", async () => {
  const offsets = [];
  const database = { async query(sql, values) {
    if (sql.includes("FROM availability") && sql.includes("booking_visibility = 'public'")) {
      offsets.push(values[10]);
      if (values[10] === 0) return { rows: Array.from({ length: 50 }, (_, index) => ({
        id: `full-${index}`, mode: "wave", capacity: 1, date: "2026-12-10",
        start_time: "11:00:00", end_time: "11:30:00",
      })) };
      return { rows: [{ id: "available-51", mode: "wave", capacity: 1, date: "2026-12-11",
        start_time: "11:00:00", end_time: "11:30:00" }] };
    }
    if (sql.includes("COUNT(DISTINCT reservation.patient_id)")) {
      return { rows: values[0].filter((id) => id !== "available-51").map((availability_id) => ({ availability_id, occupied: 1 })) };
    }
    throw new Error(`Unexpected query: ${sql}`);
  } };
  const suggestions = await findAlternatives(database, appointment("appointment-1", "wave"), "Asia/Kolkata");
  assert.deepEqual(offsets, [0, 50]);
  assert.deepEqual(suggestions.map(({ id }) => id), ["available-51"]);
});

test("schedule update retry lookup returns the committed batch result", async () => {
  const stored = { schedule_id: "schedule-1", added_count: 3 };
  const database = { async query(sql, values) {
    assert.match(sql, /SELECT id, request_fingerprint, result/);
    assert.deepEqual(values, ["schedule-1", "2026-11-01T00:00:00.000Z"]);
    return { rows: [{ id: "batch-1", request_fingerprint: "fingerprint", result: stored }] };
  } };
  const batch = await findScheduleUpdateBatch(database, "schedule-1", "2026-11-01T00:00:00.000Z");
  assert.deepEqual(batch.result, stored);
});

test("schedule update supersedes open requests when the resulting schedule covers the appointment", async () => {
  const updates = [];
  const database = { async query(sql, values) {
    if (sql.includes("FROM assisted_reschedule_requests request") && sql.includes("JOIN appointments appointment")) {
      return { rows: [
        { id: "request-covered", date: "2026-12-10", start_time: "10:00:00", end_time: "10:30:00" },
        { id: "request-not-covered", date: "2026-12-11", start_time: "10:00:00", end_time: "10:30:00" },
      ] };
    }
    if (sql.startsWith("UPDATE assisted_reschedule_requests")) {
      updates.push(values[0]);
      return { rows: [{ id: values[0] }] };
    }
    throw new Error(`Unexpected query: ${sql}`);
  } };
  const superseded = await supersedeCoveredRequestsForScheduleChange(database, {
    scheduleId: "schedule-1",
    input: { starts_on: "2026-12-01", ends_on: "2026-12-31", periods: [
      { weekday: 4, start_time: "09:00", end_time: "11:00" },
    ] },
    exceptions: new Map(),
  });
  assert.deepEqual(superseded, ["request-covered"]);
  assert.deepEqual(updates, ["request-covered"]);
});

test("creates pending and no-alternative requests and does not duplicate an existing batch request", async () => {
  const insertedRequests = [];
  const suggestions = [];
  const existing = new Map();
  const database = { async query(sql, values) {
    if (sql.includes("WHERE request.batch_id = $1 AND request.appointment_id = $2")) {
      const row = existing.get(`${values[0]}:${values[1]}`);
      return { rows: row ? [{ ...row, suggestion_count: row.status === "pending_patient" ? 1 : 0 }] : [] };
    }
    if (sql.startsWith("UPDATE assisted_reschedule_requests")) return { rows: [] };
    if (sql.includes("FROM availability") && sql.includes("booking_visibility = 'public'")) {
      const rows = values[1] === "wave" ? [{ id: "candidate-wave", mode: "wave", capacity: 2,
        date: "2026-12-10", start_time: "11:00:00", end_time: "11:30:00" }] : [];
      return { rows };
    }
    if (sql.includes("COUNT(DISTINCT reservation.patient_id)")) return { rows: values[0].map((id) => ({ availability_id: id, occupied: 0 })) };
    if (sql.startsWith("INSERT INTO assisted_reschedule_requests")) {
      const id = `request-${insertedRequests.length + 1}`;
      const row = { id, status: values[10] };
      insertedRequests.push({ id, values, sql });
      existing.set(`${values[0]}:${values[1]}`, row);
      return { rows: [{ id }] };
    }
    if (sql.startsWith("INSERT INTO assisted_reschedule_suggestions")) {
      suggestions.push(values);
      return { rows: [] };
    }
    throw new Error(`Unexpected query: ${sql}`);
  } };
  const affected = [appointment("appointment-1", "wave"), appointment("appointment-2", "stream")];
  const first = await createRequestsForAffectedAppointments(database, {
    batchId: "batch-1", affectedAppointments: affected, timeZone: "Asia/Kolkata",
  });
  assert.deepEqual(first.map(({ status, suggestion_count }) => [status, suggestion_count]), [
    ["pending_patient", 1], ["no_alternatives", 0],
  ]);
  assert.equal(insertedRequests[0].values[11], "pending");
  assert.equal(insertedRequests[1].values[11], "not_required");
  assert.equal(insertedRequests[0].values[12], "Asia/Kolkata");
  assert.match(insertedRequests[0].sql, /expires_at[\s\S]*AT TIME ZONE \$13/);
  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0][2], "wave");

  const retried = await createRequestsForAffectedAppointments(database, {
    batchId: "batch-1", affectedAppointments: affected, timeZone: "Asia/Kolkata",
  });
  assert.equal(insertedRequests.length, 2);
  assert.equal(suggestions.length, 1);
  assert.equal(retried[0].id, "request-1");
});

test("schedule request fingerprint is stable across period ordering", () => {
  const first = { mode: "wave", starts_on: "2026-12-01", ends_on: "2026-12-31", periods: [
    { weekday: 1, start_time: "09:00", end_time: "10:00" },
    { weekday: 3, start_time: "11:00", end_time: "12:00" },
  ] };
  assert.equal(scheduleRequestFingerprint(first), scheduleRequestFingerprint({ ...first, periods: [...first.periods].reverse() }));
});

test("migration persists request lifecycle, alternatives, notification work, and schedule retry identity", () => {
  const migration = fs.readFileSync(path.join(__dirname, "..", "migrations", "025_assisted_reschedule_requests.sql"), "utf8");
  assert.match(migration, /CREATE TABLE assisted_reschedule_batches/i);
  assert.match(migration, /UNIQUE \(schedule_id, source_schedule_updated_at\)/i);
  assert.match(migration, /CREATE TABLE assisted_reschedule_requests/i);
  assert.match(migration, /'pending_patient', 'no_alternatives', 'accepted', 'declined', 'expired', 'superseded'/i);
  assert.match(migration, /notification_status TEXT NOT NULL DEFAULT 'not_required'/i);
  assert.match(migration, /WHERE status IN \('pending_patient', 'no_alternatives'\)/i);
  assert.match(migration, /CREATE TABLE assisted_reschedule_suggestions/i);
  const expiryMigration = fs.readFileSync(path.join(__dirname, "..", "migrations", "027_assisted_reschedule_expiry.sql"), "utf8");
  assert.match(expiryMigration, /scheduled_date \+ appointment\.scheduled_start_time\) AT TIME ZONE 'Asia\/Kolkata'/i);
  assert.match(expiryMigration, /ALTER COLUMN expires_at SET NOT NULL/i);
  assert.match(expiryMigration, /CREATE INDEX assisted_reschedule_requests_expiry_idx/i);
});

test("request read endpoints enforce the patient and doctor ownership boundaries", async () => {
  const seen = [];
  const database = { async query(sql, values) {
    seen.push({ sql, values });
    if (sql.includes("SELECT id FROM doctors WHERE user_id")) return { rows: [{ id: values[0] === "doctor-user" ? "doctor-1" : "doctor-2" }] };
    if (sql.startsWith("UPDATE assisted_reschedule_requests")) return { rows: [], rowCount: 0 };
    if (sql.includes("FROM assisted_reschedule_requests request") && sql.includes("WHERE request.appointment_id = $1")) return { rows: [{ id: "request-1", status: "pending_patient", appointment_status: "confirmed", expires_at: "2099-04-10T04:30:00.000Z" }] };
    if (sql.includes("FROM assisted_reschedule_requests request") && sql.includes("JOIN users doctor_user")) return { rows: [{ id: "request-1", status: "pending_patient", expires_at: "2099-04-10T04:30:00.000Z" }] };
    if (sql.includes("FROM assisted_reschedule_suggestions")) return { rows: [{ id: "suggestion-1", mode: "wave" }] };
    throw new Error(`Unexpected query: ${sql}`);
  } };
  assert.equal((await listDoctorRequests(database, { role: "doctor", id: "doctor-user" }, "doctor-1", { limit: 25, offset: 0 })).items.length, 1);
  assert.equal((await listDoctorRequests(database, { role: "doctor", id: "other-doctor-user" }, "doctor-1", { limit: 25, offset: 0 })).forbidden, true);
  const request = await getPatientRequest(database, { role: "patient", id: "patient-user" }, "appointment-1");
  assert.equal(request.suggestions[0].mode, "wave");
  assert.equal(request.appointment_status, "confirmed");
  assert.equal(request.expires_at, "2099-04-10T04:30:00.000Z");
  assert.ok(seen.some(({ sql }) => sql.startsWith("UPDATE assisted_reschedule_requests") && sql.includes("request.expires_at <= NOW()")));
  assert.deepEqual(seen[seen.length - 2].values, ["appointment-1", "patient-user"]);
  assert.equal((await getPatientRequest(database, { role: "doctor", id: "doctor-user" }, "appointment-1")).forbidden, true);
});

test("an error while persisting requests rolls back the caller's schedule transaction", async () => {
  const statements = [];
  const database = { async query(sql, values) {
    if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") { statements.push(sql); return { rows: [] }; }
    if (sql.includes("WHERE request.batch_id = $1 AND request.appointment_id = $2")) return { rows: [] };
    if (sql.startsWith("UPDATE assisted_reschedule_requests")) return { rows: [] };
    if (sql.includes("FROM availability") && sql.includes("booking_visibility = 'public'")) return { rows: [] };
    if (sql.startsWith("INSERT INTO assisted_reschedule_requests")) throw new Error("request persistence failure");
    throw new Error(`Unexpected query: ${sql}`);
  } };
  await database.query("BEGIN");
  try {
    await createRequestsForAffectedAppointments(database, {
      batchId: "batch-1", affectedAppointments: [appointment("appointment-1", "stream")], timeZone: "Asia/Kolkata",
    });
    await database.query("COMMIT");
  } catch {
    await database.query("ROLLBACK");
  }
  assert.deepEqual(statements, ["BEGIN", "ROLLBACK"]);
});
