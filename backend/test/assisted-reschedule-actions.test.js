const assert = require("node:assert/strict");
const test = require("node:test");
const { AppointmentError, confirmAssistedReschedule, declineAssistedReschedule } = require("../src/services/appointmentService");

const ids = {
  user: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  patient: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  doctor: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  appointment: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  oldAvailability: "11111111-1111-4111-8111-111111111111",
  newAvailability: "22222222-2222-4222-8222-222222222222",
  oldAllocation: "33333333-3333-4333-8333-333333333333",
  newAllocation: "44444444-4444-4444-8444-444444444444",
  request: "55555555-5555-4555-8555-555555555555",
  suggestion: "66666666-6666-4666-8666-666666666666",
};

function createDatabase({ status = "pending_patient", selectedAvailabilityId = null, snapshotMatches = true, occupied = 0, requestExpired = false, acceptedGuardConflict = false, guardConflictStatus = "pending_patient", guardConflictExpired = false, mode = "wave", acceptedAppointmentMatches = true, failAppointmentUpdate = false } = {}) {
  const calls = [];
  let allocationCreated = false;
  let historyInserted = false;
  const request = {
    id: ids.request, appointment_id: ids.appointment, doctor_id: ids.doctor, patient_id: ids.patient,
    source_availability_id: ids.oldAvailability, appointment_updated_at: "2098-01-01T00:00:00.000000Z",
    mode, status, selected_availability_id: selectedAvailabilityId,
    appointment_status: "confirmed", current_availability_id: ids.oldAvailability,
    current_allocation_id: ids.oldAllocation, current_patient_id: ids.patient,
    reason: "Checkup", consultation_fee: "1500.00", current_date: "2099-04-10",
    current_start_time: "10:00:00", current_end_time: "10:30:00", current_mode: mode,
    current_doctor_id: ids.doctor, snapshot_matches: snapshotMatches,
    expires_at: "2099-04-10T04:30:00.000Z", request_expired: requestExpired,
  };
  const appointment = {
    id: ids.appointment, status: "confirmed", availability_id: status === "accepted" && acceptedAppointmentMatches ? ids.newAvailability : ids.oldAvailability,
    mode, date: status === "accepted" && acceptedAppointmentMatches ? "2099-04-11" : "2099-04-10",
    start_time: status === "accepted" && acceptedAppointmentMatches ? "11:00:00" : "10:00:00",
    end_time: status === "accepted" && acceptedAppointmentMatches ? "11:30:00" : "10:30:00",
    allocation_id: ids.oldAllocation, consultation_fee: "1500.00",
  };
  const client = { async query(sql, values = []) {
    calls.push({ sql, values });
    if (sql === "BEGIN" || sql === "COMMIT") return { rows: [] };
    if (sql === "ROLLBACK") {
      request.status = status;
      request.selected_availability_id = selectedAvailabilityId;
      appointment.availability_id = status === "accepted" && acceptedAppointmentMatches ? ids.newAvailability : ids.oldAvailability;
      appointment.allocation_id = ids.oldAllocation;
      appointment.date = status === "accepted" && acceptedAppointmentMatches ? "2099-04-11" : "2099-04-10";
      appointment.start_time = status === "accepted" && acceptedAppointmentMatches ? "11:00:00" : "10:00:00";
      appointment.end_time = status === "accepted" && acceptedAppointmentMatches ? "11:30:00" : "10:30:00";
      delete appointment.oldAllocationReleased;
      allocationCreated = false;
      historyInserted = false;
      return { rows: [] };
    }
    if (sql.includes("FROM assisted_reschedule_requests request") && sql.includes("JOIN patients patient")) return { rows: [{ ...request }] };
    if (sql.includes("FROM assisted_reschedule_suggestions suggestion")) return { rows: [{
      id: ids.suggestion, availability_id: ids.newAvailability, mode, date: "2099-04-11",
      start_time: "11:00:00", end_time: "11:30:00",
    }] };
    if (sql.includes("FROM availability") && sql.includes("ORDER BY id") && sql.includes("FOR UPDATE")) {
      return { rows: values[0].map((id) => ({ id, doctor_id: ids.doctor })) };
    }
    if (sql.includes("pg_advisory_xact_lock")) return { rows: [] };
    if (sql.includes("FOR UPDATE OF av")) return { rows: [{
      id: ids.newAvailability, doctor_id: ids.doctor, deleted_at: null, booking_visibility: "public",
      date: "2099-04-11", start_time: "11:00:00", end_time: "11:30:00", mode, capacity: 2,
    }] };
    if (sql.startsWith("SELECT COUNT(DISTINCT reservation.patient_id)::int AS occupied")) return { rows: [{ occupied }] };
    if (sql.startsWith("INSERT INTO appointment_allocations")) {
      allocationCreated = true;
      return { rows: [{ id: ids.newAllocation }] };
    }
    if (sql.startsWith("UPDATE appointments SET availability_id")) {
      if (failAppointmentUpdate) throw new Error("Simulated appointment update failure");
      Object.assign(appointment, { availability_id: values[1], allocation_id: values[2], date: values[3], start_time: values[4], end_time: values[5] });
      return { rows: [{ id: ids.appointment }] };
    }
    if (sql.startsWith("UPDATE appointment_allocations SET status = 'released'")) { appointment.oldAllocationReleased = values[0]; return { rows: [] }; }
    if (sql.startsWith("INSERT INTO appointment_reschedule_history")) {
      historyInserted = true;
      return { rows: [] };
    }
    if (sql.startsWith("UPDATE assisted_reschedule_requests") && sql.includes("SET status = 'expired'")) {
      request.status = "expired";
      return { rows: [{ id: ids.request }], rowCount: 1 };
    }
    if (sql.startsWith("UPDATE assisted_reschedule_requests") && sql.includes("SET status = 'accepted'")) {
      if (acceptedGuardConflict) {
        request.status = guardConflictStatus;
        request.request_expired = guardConflictExpired;
        return { rows: [], rowCount: 0 };
      }
      request.status = "accepted";
      request.selected_availability_id = values[1];
      return sql.includes("RETURNING id") ? { rows: [{ id: ids.request }], rowCount: 1 } : { rows: [], rowCount: 1 };
    }
    if (sql.includes("SELECT status, selected_availability_id, expires_at <= clock_timestamp() AS request_expired")) {
      return { rows: [{ status: request.status, selected_availability_id: request.selected_availability_id, request_expired: request.request_expired }] };
    }
    if (sql.startsWith("UPDATE assisted_reschedule_requests")) return { rows: [] };
    if (sql.includes("WHERE a.id = $1")) return { rows: [{ ...appointment }] };
    throw new Error(`Unexpected query: ${sql}`);
  }, release() {} };
  return {
    calls, request, appointment,
    get allocationCreated() { return allocationCreated; },
    get historyInserted() { return historyInserted; },
    database: { async connect() { return client; } },
  };
}

for (const mode of ["wave", "stream"]) test(`confirms a saved ${mode} alternative in place and atomically replaces its allocation`, async () => {
  const fixture = createDatabase({ mode });
  const result = await confirmAssistedReschedule(fixture.database, { id: ids.user, role: "patient" }, "UTC", ids.request, ids.suggestion);
  assert.equal(result.id, ids.appointment);
  assert.equal(fixture.appointment.availability_id, ids.newAvailability);
  assert.equal(fixture.appointment.id, ids.appointment);
  assert.equal(fixture.appointment.mode, mode);
  assert.equal(fixture.appointment.date, "2099-04-11");
  assert.equal(fixture.appointment.start_time, "11:00:00");
  assert.equal(fixture.appointment.end_time, "11:30:00");
  assert.equal(fixture.appointment.allocation_id, ids.newAllocation);
  assert.equal(fixture.appointment.oldAllocationReleased, ids.oldAllocation);
  assert.equal(fixture.allocationCreated, true);
  assert.equal(fixture.historyInserted, true);
  assert.equal(fixture.appointment.consultation_fee, "1500.00");
  assert.equal(fixture.request.status, "accepted");
  assert.ok(fixture.calls.some(({ sql, values }) => sql.startsWith("INSERT INTO appointment_reschedule_history")
    && values[0] === ids.appointment && values[3] === ids.oldAllocation && values[8] === ids.newAllocation));
  assert.ok(fixture.calls.some(({ sql }) => sql.includes("FOR UPDATE OF request, appointment")));
  assert.ok(fixture.calls.some(({ sql }) => sql.includes("pg_advisory_xact_lock")));
  assert.ok(fixture.calls.some(({ sql }) => sql.includes("SET status = 'accepted'") && sql.includes("status = 'pending_patient'") && sql.includes("RETURNING id")));
  assert.ok(fixture.calls.findIndex(({ sql }) => sql === "BEGIN") < fixture.calls.findIndex(({ sql }) => sql.startsWith("UPDATE appointments SET availability_id")));
  assert.ok(fixture.calls.findIndex(({ sql }) => sql.startsWith("UPDATE assisted_reschedule_requests") && sql.includes("SET status = 'accepted'")) < fixture.calls.findIndex(({ sql }) => sql === "COMMIT"));
  assert.ok(fixture.calls.findIndex(({ sql }) => sql.startsWith("INSERT INTO appointment_allocations")) < fixture.calls.findIndex(({ sql }) => sql === "COMMIT"));
  assert.ok(fixture.calls.findIndex(({ sql }) => sql.startsWith("UPDATE appointment_allocations SET status = 'released'")) < fixture.calls.findIndex(({ sql }) => sql === "COMMIT"));
  assert.ok(fixture.calls.findIndex(({ sql }) => sql.startsWith("INSERT INTO appointment_reschedule_history")) < fixture.calls.findIndex(({ sql }) => sql === "COMMIT"));
});

test("rolls back request acceptance and all later confirmation changes if appointment update fails", async () => {
  const fixture = createDatabase({ failAppointmentUpdate: true });
  await assert.rejects(
    confirmAssistedReschedule(fixture.database, { id: ids.user, role: "patient" }, "UTC", ids.request, ids.suggestion),
    /Simulated appointment update failure/,
  );
  assert.equal(fixture.request.status, "pending_patient");
  assert.equal(fixture.request.selected_availability_id, null);
  assert.equal(fixture.appointment.availability_id, ids.oldAvailability);
  assert.equal(fixture.appointment.allocation_id, ids.oldAllocation);
  assert.equal(fixture.allocationCreated, false);
  assert.equal(fixture.historyInserted, false);
  assert.ok(fixture.calls.findIndex(({ sql }) => sql.includes("SET status = 'accepted'") && sql.includes("RETURNING id"))
    < fixture.calls.findIndex(({ sql }) => sql.startsWith("UPDATE appointments SET availability_id")));
  assert.ok(fixture.calls.some(({ sql }) => sql === "ROLLBACK"));
  assert.ok(!fixture.calls.some(({ sql }) => sql === "COMMIT"));
});

test("rejects full alternatives and rolls back without accepting the request", async () => {
  const fixture = createDatabase({ occupied: 2 });
  await assert.rejects(
    confirmAssistedReschedule(fixture.database, { id: ids.user, role: "patient" }, "UTC", ids.request, ids.suggestion),
    (error) => error instanceof AppointmentError && error.code === "SLOT_CAPACITY_REACHED",
  );
  assert.equal(fixture.request.status, "pending_patient");
  assert.ok(fixture.calls.some(({ sql }) => sql === "ROLLBACK"));
});

test("expires and commits an assisted request when confirmation reaches the original appointment start", async () => {
  const fixture = createDatabase({ requestExpired: true });
  await assert.rejects(
    confirmAssistedReschedule(fixture.database, { id: ids.user, role: "patient" }, "UTC", ids.request, ids.suggestion),
    (error) => error instanceof AppointmentError && error.code === "ASSISTED_RESCHEDULE_REQUEST_EXPIRED",
  );
  assert.equal(fixture.request.status, "expired");
  assert.ok(fixture.calls.some(({ sql }) => sql.includes("expires_at <= clock_timestamp()")));
  assert.ok(fixture.calls.some(({ sql }) => sql === "COMMIT"));
  assert.ok(!fixture.calls.some(({ sql }) => sql.startsWith("INSERT INTO appointment_allocations")));
});

test("marks the request expired if its deadline passes at the final guarded update", async () => {
  const fixture = createDatabase({ acceptedGuardConflict: true, guardConflictExpired: true });
  await assert.rejects(
    confirmAssistedReschedule(fixture.database, { id: ids.user, role: "patient" }, "UTC", ids.request, ids.suggestion),
    (error) => error instanceof AppointmentError && error.code === "ASSISTED_RESCHEDULE_REQUEST_EXPIRED",
  );
  assert.equal(fixture.request.status, "expired");
  assert.ok(fixture.calls.some(({ sql }) => sql === "COMMIT"));
  assert.ok(!fixture.calls.some(({ sql }) => sql.startsWith("INSERT INTO appointment_allocations")));
  assert.equal(fixture.appointment.availability_id, ids.oldAvailability);
});

test("reports declined or superseded requests as closed instead of expired", async () => {
  for (const [status, code] of [
    ["declined", "ASSISTED_RESCHEDULE_REQUEST_DECLINED"],
    ["superseded", "ASSISTED_RESCHEDULE_REQUEST_SUPERSEDED"],
  ]) {
    const fixture = createDatabase({ status });
    await assert.rejects(
      confirmAssistedReschedule(fixture.database, { id: ids.user, role: "patient" }, "UTC", ids.request, ids.suggestion),
      (error) => error instanceof AppointmentError && error.code === code,
    );
    assert.ok(fixture.calls.some(({ sql }) => sql === "ROLLBACK"));
    assert.ok(!fixture.calls.some(({ sql }) => sql.startsWith("INSERT INTO appointment_allocations")));
  }
});

test("identifies the latest request state when the guarded acceptance update affects no rows", async () => {
  const closed = createDatabase({ acceptedGuardConflict: true, guardConflictStatus: "declined" });
  await assert.rejects(
    confirmAssistedReschedule(closed.database, { id: ids.user, role: "patient" }, "UTC", ids.request, ids.suggestion),
    (error) => error instanceof AppointmentError && error.code === "ASSISTED_RESCHEDULE_REQUEST_DECLINED",
  );
  assert.ok(closed.calls.some(({ sql }) => sql.includes("SELECT status, selected_availability_id, expires_at <= clock_timestamp() AS request_expired")));
  assert.ok(closed.calls.some(({ sql }) => sql === "ROLLBACK"));
  assert.ok(!closed.calls.some(({ sql }) => sql.startsWith("INSERT INTO appointment_allocations")));

  const conflict = createDatabase({ acceptedGuardConflict: true });
  await assert.rejects(
    confirmAssistedReschedule(conflict.database, { id: ids.user, role: "patient" }, "UTC", ids.request, ids.suggestion),
    (error) => error instanceof AppointmentError && error.code === "ASSISTED_RESCHEDULE_REQUEST_CONFLICT",
  );
  assert.ok(conflict.calls.some(({ sql }) => sql === "ROLLBACK"));
  assert.ok(!conflict.calls.some(({ sql }) => sql.startsWith("INSERT INTO appointment_allocations")));
});

test("rejects stale appointments, a different selection, and inconsistent accepted requests", async () => {
  const stale = createDatabase({ snapshotMatches: false });
  await assert.rejects(
    confirmAssistedReschedule(stale.database, { id: ids.user, role: "patient" }, "UTC", ids.request, ids.suggestion),
    (error) => error instanceof AppointmentError && error.code === "ASSISTED_RESCHEDULE_REQUEST_STALE",
  );
  const accepted = createDatabase({ status: "accepted", selectedAvailabilityId: ids.oldAvailability });
  await assert.rejects(
    confirmAssistedReschedule(accepted.database, { id: ids.user, role: "patient" }, "UTC", ids.request, ids.suggestion),
    (error) => error instanceof AppointmentError && error.code === "ASSISTED_RESCHEDULE_ALREADY_ACCEPTED",
  );
  const sameAcceptedAlternative = createDatabase({ status: "accepted", selectedAvailabilityId: ids.newAvailability });
  const retried = await confirmAssistedReschedule(sameAcceptedAlternative.database, { id: ids.user, role: "patient" }, "UTC", ids.request, ids.suggestion);
  assert.equal(retried.id, ids.appointment);
  assert.ok(!sameAcceptedAlternative.calls.some(({ sql }) => sql.startsWith("INSERT INTO appointment_allocations")));

  const inconsistentAccepted = createDatabase({ status: "accepted", selectedAvailabilityId: ids.newAvailability, acceptedAppointmentMatches: false });
  await assert.rejects(
    confirmAssistedReschedule(inconsistentAccepted.database, { id: ids.user, role: "patient" }, "UTC", ids.request, ids.suggestion),
    (error) => error instanceof AppointmentError && error.code === "ASSISTED_RESCHEDULE_ACCEPTED_STATE_CONFLICT",
  );
  assert.ok(inconsistentAccepted.calls.some(({ sql }) => sql === "ROLLBACK"));
  assert.ok(!inconsistentAccepted.calls.some(({ sql }) => sql.startsWith("INSERT INTO appointment_allocations")));
});

test("decline is patient-only and repeated decline is idempotent", async () => {
  const forbidden = createDatabase();
  await assert.rejects(
    declineAssistedReschedule(forbidden.database, { id: ids.user, role: "doctor" }, ids.request),
    (error) => error instanceof AppointmentError && error.status === 403,
  );
  const declined = createDatabase({ status: "declined" });
  const result = await declineAssistedReschedule(declined.database, { id: ids.user, role: "patient" }, ids.request);
  assert.deepEqual(result, { request_id: ids.request, status: "declined", idempotent: true });
});

test("an expired request cannot be declined as if it were still open", async () => {
  const fixture = createDatabase({ requestExpired: true });
  await assert.rejects(
    declineAssistedReschedule(fixture.database, { id: ids.user, role: "patient" }, ids.request),
    (error) => error instanceof AppointmentError && error.code === "ASSISTED_RESCHEDULE_REQUEST_EXPIRED",
  );
  assert.equal(fixture.request.status, "expired");
  assert.ok(fixture.calls.some(({ sql }) => sql === "COMMIT"));
});
