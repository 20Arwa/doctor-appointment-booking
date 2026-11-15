const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { getPolicyForActor, getToolsForActor } = require("../src/services/assistant/toolRegistry");
const { executeTool } = require("../src/services/assistant/toolExecutor");
const { createDoctorConversationEngine } = require("../src/services/assistant/doctorConversationEngine");
const { createAssistantConversationService } = require("../src/services/assistantConversationService");
const controller = require("../src/controllers/assistantController");

const doctor = { id: "11111111-1111-4111-8111-111111111111", role: "doctor" };
const otherDoctor = { id: "99999999-9999-4999-8999-999999999999", role: "doctor" };
const conversationId = "22222222-2222-4222-8222-222222222222";

describe("doctor assistant appointment insights", () => {
  it("exposes only read-only doctor tools and denies other roles", () => {
    const names = getToolsForActor(doctor).map(({ name }) => name);
    assert.deepEqual(names, ["get_doctor_schedules", "get_doctor_schedule_exceptions", "get_doctor_schedule_conflicts", "get_doctor_nearest_slots", "get_doctor_appointments", "get_doctor_appointment_statistics"]);
    assert.match(getPolicyForActor(doctor), /Asia\/Kolkata/);
    assert.deepEqual(getToolsForActor({ ...doctor, role: "patient" }).map(({ name }) => name).includes("get_patient_appointments"), true);
    assert.deepEqual(getToolsForActor({ ...doctor, role: "admin" }), []);
    assert.equal(getPolicyForActor({ ...doctor, role: "admin" }), null);
    const list = getToolsForActor(doctor).find(({ name }) => name === "get_doctor_appointments");
    assert.equal(list.schema.safeParse({ from: "2027-02-30", to: "2027-02-30" }).success, false);
    assert.equal(list.schema.safeParse({ from: "2027-02-01", to: "2027-02-02", doctor_id: "arbitrary" }).success, false);
    assert.equal(list.schema.safeParse({ day: "today" }).success, true);
    assert.equal(list.schema.safeParse({ date: "2027-02-01", to: "2027-02-01" }).success, false);
    assert.equal(list.schema.safeParse({ day: "today", offset: 10, limit: 50 }).success, true);
    assert.equal(list.schema.safeParse({ day: "today", limit: 51 }).success, false);
    const scheduleTool = getToolsForActor(doctor).find(({ name }) => name === "get_doctor_schedules");
    assert.equal(scheduleTool.schema.safeParse({ from: "2027-02-01", to: "2027-03-04" }).success, false);
    assert.equal(scheduleTool.schema.safeParse({ from: "2027-02-01", to: "2027-02-02", doctor_id: otherDoctor.id }).success, false);
    const nearestTool = getToolsForActor(doctor).find(({ name }) => name === "get_doctor_nearest_slots");
    assert.equal(nearestTool.schema.safeParse({ from: "2027-02-01" }).success, false);
    assert.equal(nearestTool.schema.safeParse({ from: "2027-02-02", to: "2027-02-01" }).success, false);
    assert.equal(nearestTool.schema.safeParse({ from: "2027-02-01", to: "2027-03-04" }).success, false);
    assert.equal(nearestTool.schema.safeParse({ from: "2027-02-01", to: "2027-02-02", days_ahead: 4 }).success, false);
    assert.equal(nearestTool.schema.safeParse({ from: "2027-02-01", to: "2027-02-02", mode: "wave" }).success, true);
  });

  it("uses inclusive local-date boundaries and excludes patient-identifying fields from doctor appointment results", async () => {
    let call;
    const database = { async query(sql, values) {
      call = { sql, values };
      return { rows: [{ id: "appointment-id", date: "2027-02-01", start_time: "09:00:00", end_time: "09:30:00", status: "confirmed", mode: "wave",
        patient_id: "patient-id", patient_first_name: "A", patient_last_name: "B", email: "patient@example.com", phone: "555-0100", reason: "private reason", payment_id: "payment-id" }] };
    } };
    const result = await executeTool({ name: "get_doctor_appointments", actor: doctor, database, args: { from: "2027-02-01", to: "2027-02-01" }, applicationTimezone: "Asia/Kolkata" });
    assert.deepEqual(call.values, [doctor.id, "2027-02-01", "2027-02-01", 21, 0]);
    assert.match(call.sql, /scheduled_date BETWEEN \$2::date AND \$3::date/);
    assert.match(call.sql, /doctor\.user_id = \$1/);
    assert.doesNotMatch(call.sql, /JOIN patients|patient_user|patient_id|first_name|last_name|email|phone|date_of_birth|gender|reason|payment/i);
    assert.deepEqual(result.appointments[0], { date: "2027-02-01", start_time: "09:00:00", end_time: "09:30:00", status: "confirmed", mode: "wave" });
    assert.doesNotMatch(JSON.stringify(result), /patient-id|appointment-id|payment-id|patient@example\.com|555-0100|private reason|"A"|"B"/);
    assert.match(getToolsForActor(doctor).find(({ name }) => name === "get_doctor_appointments").description, /never request or disclose patient names, IDs, or other patient details/i);
    assert.equal("doctor_id" in result, false);
  });

  it("returns grouped status counts and totals for the inclusive range", async () => {
    let call;
    const database = { async query(sql, values) { call = { sql, values }; return { rows: [{ status: "confirmed", count: 2 }, { status: "completed", count: 1 }] }; } };
    const result = await executeTool({ name: "get_doctor_appointment_statistics", actor: doctor, database, args: { from: "2027-02-01", to: "2027-02-28", status: "confirmed" } });
    assert.deepEqual(call.values, [doctor.id, "2027-02-01", "2027-02-28", "confirmed"]);
    assert.match(call.sql, /GROUP BY appointment\.status/);
    assert.deepEqual(result, { from: "2027-02-01", to: "2027-02-28", total: 3, by_status: { confirmed: 2, completed: 1, cancelled: 0 } });
  });

  it("resolves relative calendar days at the Asia/Kolkata boundary in application time", async () => {
    let values;
    const database = { async query(_sql, queryValues) { values = queryValues; return { rows: [] }; } };
    await executeTool({ name: "get_doctor_appointments", actor: doctor, database, args: { day: "today" }, applicationTimezone: "Asia/Riyadh", now: new Date("2027-01-31T19:00:00.000Z") });
    assert.deepEqual(values, [doctor.id, "2027-02-01", "2027-02-01", 21, 0]);
  });

  it("returns bounded appointment pages and continuation metadata", async () => {
    let call;
    const database = { async query(sql, values) {
      call = { sql, values };
      return { rows: [1, 2, 3].map((n) => ({ date: "2027-02-01", start_time: `0${n}:00`, end_time: `0${n}:30`, status: "confirmed", patient_first_name: "A", patient_last_name: "B" })) };
    } };
    const page = await executeTool({ name: "get_doctor_appointments", actor: doctor, database, args: { date: "2027-02-01", offset: 10, limit: 2 } });
    assert.deepEqual(call.values, [doctor.id, "2027-02-01", "2027-02-01", 3, 10]);
    assert.match(call.sql, /LIMIT \$4 OFFSET \$5/);
    assert.equal(page.appointments.length, 2);
    assert.equal(page.has_more, true);
    assert.equal(page.next_offset, 12);
  });

  it("doctor conversation engine never exposes patient action tools and keeps tools read-only", async () => {
    const calls = [];
    let round = 0;
    const engine = createDoctorConversationEngine({
      provider: { async generate({ tools }) {
        assert.equal(tools.some(({ name }) => name.includes("booking_action") || name.includes("cancellation_action")), false);
        round += 1;
        return round === 1 ? { text: "", providerContent: { role: "model", parts: [] }, toolCalls: [{ name: "get_doctor_appointment_statistics", arguments: { from: "2027-02-01", to: "2027-02-01" }, id: "call" }] } : { text: "One", toolCalls: [] };
      } },
      toolExecutor: async (input) => { calls.push(input); return { total: 1 }; },
    });
    const response = await engine.respond({ actor: doctor, messages: [{ role: "user", content: "How many today?" }], tools: getToolsForActor(doctor), systemInstruction: getPolicyForActor(doctor) });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].actor, doctor);
    assert.equal(response.results[0].tool, "get_doctor_appointment_statistics");
  });

  it("always discloses when an appointment page is partial", async () => {
    let round = 0;
    const engine = createDoctorConversationEngine({
      provider: { async generate() { round += 1; return round === 1
        ? { text: "Here are your appointments.", providerContent: { role: "model", parts: [] }, toolCalls: [{ name: "get_doctor_appointments", arguments: { date: "2027-02-01" }, id: "page" }] }
        : { text: "Here are the appointments I found.", toolCalls: [] }; } },
      toolExecutor: async () => ({ appointments: [], has_more: true, next_offset: 20 }),
    });
    const response = await engine.respond({ actor: doctor, messages: [{ role: "user", content: "List my appointments." }], tools: getToolsForActor(doctor), systemInstruction: getPolicyForActor(doctor) });
    assert.match(response.answer, /only the returned page; additional appointments exist beyond this page/i);
    assert.doesNotMatch(response.answer, /ask me to continue|continue to see the next page/i);
  });

  it("fails closed after a doctor tool error without asking Gemini for another answer", async () => {
    let modelCalls = 0;
    const engine = createDoctorConversationEngine({
      provider: { async generate() { modelCalls += 1; return { text: "", providerContent: { role: "model", parts: [] }, toolCalls: [{ name: "get_doctor_appointment_statistics", arguments: { date: "2027-02-01" }, id: "stats" }] }; } },
      toolExecutor: async () => { throw new Error("database failure"); },
    });
    await assert.rejects(engine.respond({ actor: doctor, messages: [{ role: "user", content: "How many today?" }], tools: getToolsForActor(doctor), systemInstruction: getPolicyForActor(doctor) }), { code: "DOCTOR_TOOL_QUERY_FAILED", status: 503 });
    assert.equal(modelCalls, 1);
  });

  it("derives owner from actor.id and keeps schedules limited to that owner", async () => {
    const scheduling = require("../src/services/assistantSchedulingService");
    const calls = [];
    const database = { async query(sql, values) { calls.push({ sql, values }); return { rows: [{ id: "schedule-secret", mode: "wave", periods: [] }] }; } };
    const doctorId = await scheduling.requireDoctorId(database, doctor);
    assert.equal(doctorId, "schedule-secret");
    assert.deepEqual(calls[0].values, [doctor.id]);
    await assert.rejects(scheduling.requireDoctorId(database, { ...doctor, role: "patient" }), { code: "TOOL_UNAVAILABLE" });
  });

  it("filters specific-date schedules and exception queries at the requested date range and limit", async () => {
    const scheduling = require("../src/services/assistantSchedulingService");
    const calls = [];
    const database = { async query(sql, values) {
      calls.push({ sql, values });
      if (sql.includes("FROM doctor_schedules s LEFT JOIN")) return { rows: [{ id: "s1", recurrence_type: "specific_dates", periods: [{ service_date: "2027-02-01" }] }] };
      if (sql.includes("FROM doctor_schedules schedule")) return { rows: [{ date: "2027-02-01", exception_type: "override", periods: [{ start_time: "10:00:00", end_time: "12:00:00" }] }] };
      return { rows: [] };
    } };
    const schedules = await scheduling.getSchedules(database, "doctor-id", "2027-02-01", "2027-02-02", 4);
    assert.deepEqual(schedules[0].periods, [{ service_date: "2027-02-01" }]);
    assert.match(calls[0].sql, /p\.service_date BETWEEN \$2::date AND \$3::date/);
    assert.match(calls[0].sql, /ranged_period\.service_date BETWEEN \$2::date AND \$3::date/);
    assert.match(calls[0].sql, /generate_series\([\s\S]*?EXTRACT\(DOW FROM occurrence\.service_date\)::int = p\.weekday/);
    assert.match(calls[0].sql, /EXTRACT\(DOW FROM occurrence\.service_date\)::int = ranged_period\.weekday/);
    const exceptions = await scheduling.getExceptions(database, "doctor-id", "2027-02-01", "2027-02-02", 2);
    assert.equal(exceptions[0].date, "2027-02-01");
    assert.deepEqual(calls[1].values, ["doctor-id", "2027-02-01", "2027-02-02", 2]);
    assert.match(calls[1].sql, /exception\.service_date BETWEEN \$2::date AND \$3::date/);
    assert.match(calls[1].sql, /LIMIT \$4/);
  });

  it("classifies Wave and Stream blockers separately and never returns patient or payment details", async () => {
    const scheduling = require("../src/services/assistantSchedulingService");
    const slots = [
      { id: "wave-id", schedule_id: "s1", date: "2027-02-01", start_time: "09:00:00", end_time: "09:30:00", mode: "wave", capacity: 2 },
      { id: "stream-id", schedule_id: "s2", date: "2027-02-01", start_time: "10:00:00", end_time: "11:00:00", mode: "stream", capacity: 1 },
    ];
    let occupancyCalls = 0;
    let detailCalls = 0;
    const database = { async query(sql) {
      if (sql.includes("FROM availability WHERE")) return { rows: slots };
      if (sql.includes("SELECT EXISTS (SELECT 1 FROM appointments")) { detailCalls += 1; const rows = [
        { has_confirmed_appointment: true, has_active_reservation: false, has_active_payment_hold: false },
        { has_confirmed_appointment: false, has_active_reservation: true, has_active_payment_hold: true },
      ]; return { rows: rows[detailCalls - 1] ? [rows[detailCalls - 1]] : [] }; }
      if (sql.includes("doctor_schedule_periods")) return { rows: [] };
      if (sql.includes("COUNT(DISTINCT reservation.patient_id)")) { occupancyCalls += 1; return { rows: [{ occupied: occupancyCalls }] }; }
      return { rows: [] };
    } };
    const result = await scheduling.getConflicts(database, "doctor-id", "2027-02-01", "2027-02-01", 10);
    assert.deepEqual(result.conflicts.map(({ mode }) => mode), ["wave", "stream"]);
    assert.ok(result.conflicts[0].conflicts.includes("confirmed_appointment"));
    assert.ok(result.conflicts[1].conflicts.includes("active_reservation"));
    assert.ok(result.conflicts[1].conflicts.includes("payment_hold"));
    assert.ok(result.conflicts[1].conflicts.includes("capacity_reached"));
    assert.equal(JSON.stringify(result).includes("patient"), false);
    assert.equal(JSON.stringify(result).includes("payment_id"), false);
  });

  it("reports retired confirmed appointments and conflict result truncation", async () => {
    const scheduling = require("../src/services/assistantSchedulingService");
    const queryCalls = [];
    const database = { async query(sql) {
      queryCalls.push(sql);
      if (sql.includes("FROM availability WHERE")) return { rows: [1, 2].map((index) => ({ id: `retired-${index}`, schedule_id: null, date: "2027-02-01", start_time: `0${index}:00:00`, end_time: `0${index}:30:00`, mode: "wave", capacity: 1 })) };
      if (sql.includes("SELECT EXISTS (SELECT 1 FROM appointments")) return { rows: [{ has_confirmed_appointment: true, has_active_reservation: false, has_active_payment_hold: false }] };
      if (sql.includes("COUNT(DISTINCT reservation.patient_id)")) return { rows: [{ occupied: 1 }] };
      return { rows: [] };
    } };
    const result = await scheduling.getConflicts(database, "doctor-id", "2027-02-01", "2027-02-01", 1);
    const availabilityQuery = queryCalls.find((sql) => sql.includes("FROM availability WHERE"));
    assert.match(availabilityQuery, /EXISTS \(SELECT 1 FROM appointments confirmed_appt WHERE confirmed_appt\.availability_id = availability\.id AND confirmed_appt\.status = 'confirmed'\)/);
    assert.match(availabilityQuery, /AND \([\s\S]*?availability\.deleted_at IS NULL[\s\S]*?OR EXISTS \([\s\S]*?OR EXISTS \([\s\S]*?\)\s*ORDER BY date, start_time LIMIT 501/);
    assert.equal(result.conflicts.length, 1);
    assert.ok(result.conflicts[0].conflicts.includes("confirmed_appointment"));
    assert.equal(result.truncated, true);
  });

  it("pages past full slots when searching for nearest genuinely available slots", async () => {
    const availabilityOffsets = [];
    let availabilitySql = "";
    const database = { async query(sql, values) {
      if (sql.includes("SELECT id FROM doctors WHERE user_id")) return { rows: [{ id: "owned-doctor-id" }] };
      if (sql.includes("FROM availability")) {
        availabilitySql = sql;
        const offset = values.at(-1);
        availabilityOffsets.push(offset);
        if (offset < 500) return { rows: Array.from({ length: 100 }, (_, index) => ({ id: `full-${offset + index}`, date: "2027-02-01", start_time: "09:00:00", end_time: "09:30:00", mode: "wave", capacity: 1, remaining_capacity: 0 })) };
        return { rows: [{ id: "open-slot", date: "2027-02-02", start_time: "10:00:00", end_time: "10:30:00", mode: "stream", capacity: 3, remaining_capacity: 2 }] };
      }
      return { rows: [] };
    } };
    const response = await executeTool({ name: "get_doctor_nearest_slots", actor: doctor, database,
      applicationTimezone: "Asia/Kolkata", now: new Date("2027-01-31T20:00:00.000Z"), args: { days_ahead: 3 } });
    assert.deepEqual(availabilityOffsets, [0, 100, 200, 300, 400, 500]);
    assert.match(availabilitySql, /LIMIT \$10 OFFSET \$11/);
    assert.equal(response.slots[0].mode, "stream");
    assert.equal(response.scan_limit_reached, false);
    assert.match(response.notice, /point-in-time.*do not guarantee booking/i);
  });

  it("filters nearest suggestions to an explicitly requested mode and returns empty when none match", async () => {
    const availabilityQueries = [];
    const database = { async query(sql, values) {
      if (sql.includes("SELECT id FROM doctors WHERE user_id")) return { rows: [{ id: "owned-doctor-id" }] };
      if (sql.includes("FROM availability")) {
        availabilityQueries.push({ sql, values });
        return { rows: [] };
      }
      return { rows: [] };
    } };
    const response = await executeTool({ name: "get_doctor_nearest_slots", actor: doctor, database,
      applicationTimezone: "Asia/Kolkata", now: new Date("2027-01-31T20:00:00.000Z"), args: { days_ahead: 3, mode: "wave" } });
    assert.deepEqual(response.slots, []);
    assert.equal(availabilityQueries.length, 1);
    assert.match(availabilityQueries[0].sql, /availability\.mode = \$10/);
    assert.equal(availabilityQueries[0].values[9], "wave");
  });

  it("keeps paginated nearest Wave and Stream suggestions within the explicit date range", async () => {
    for (const mode of ["wave", "stream"]) {
      const availabilityOffsets = [];
      let availabilityQuery;
      const database = { async query(sql, values) {
        if (sql.includes("SELECT id FROM doctors WHERE user_id")) return { rows: [{ id: "owned-doctor-id" }] };
        if (sql.includes("FROM availability")) {
          availabilityQuery = { sql, values };
          const offset = values.at(-1);
          availabilityOffsets.push(offset);
          if (offset === 0) return { rows: Array.from({ length: 100 }, (_, index) => ({
            id: `in-range-${mode}-${index}`, date: "2027-02-01", start_time: "09:00:00", end_time: "09:30:00",
            mode, capacity: 1, remaining_capacity: 0,
          })) };
          if (offset === 100) {
            const candidates = [
              { id: `last-in-range-${mode}`, date: "2027-02-02", start_time: "10:00:00", end_time: "10:30:00", mode, capacity: 2, remaining_capacity: 1 },
              { id: `outside-range-${mode}`, date: "2027-02-03", start_time: "11:00:00", end_time: "11:30:00", mode, capacity: 2, remaining_capacity: 1 },
            ];
            return { rows: candidates.filter((row) => row.date >= values[7] && row.date <= values[8] && row.mode === values[9]) };
          }
          return { rows: [] };
        }
        return { rows: [] };
      } };
      const response = await executeTool({ name: "get_doctor_nearest_slots", actor: doctor, database,
        applicationTimezone: "Asia/Kolkata", now: new Date("2027-01-31T20:00:00.000Z"),
        args: { from: "2027-02-01", to: "2027-02-02", mode } });
      assert.deepEqual(availabilityOffsets, [0, 100]);
      assert.match(availabilityQuery.sql, /date >= \$8::date/);
      assert.match(availabilityQuery.sql, /date <= \$9::date/);
      assert.match(availabilityQuery.sql, /availability\.mode = \$10/);
      assert.deepEqual(availabilityQuery.values.slice(7, 10), ["2027-02-01", "2027-02-02", mode]);
      assert.deepEqual(response.slots.map(({ date, mode: returnedMode }) => ({ date, mode: returnedMode })), [
        { date: "2027-02-02", mode },
      ]);
    }
  });

  it("preserves conversation owner isolation for doctors and denies unsupported roles at API access", async () => {
    const database = { async query(sql, values) {
      if (sql.includes("INSERT INTO assistant_conversations")) return { rows: [] };
      if (sql.includes("SELECT id, created_at, updated_at FROM assistant_conversations")) return { rows: values[1] === doctor.id ? [{ id: conversationId }] : [] };
      return { rows: [] };
    } };
    const service = createAssistantConversationService({ engine: { async respond() { return { answer: "ok", results: [] }; } } });
    await service.create(database, doctor, conversationId);
    await assert.rejects(service.get(database, otherDoctor, conversationId), { code: "CONVERSATION_NOT_FOUND" });
    const response = { locals: { user: { ...doctor, role: "admin" } }, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
    await controller.create({}, response);
    assert.equal(response.statusCode, 403);
  });
});
