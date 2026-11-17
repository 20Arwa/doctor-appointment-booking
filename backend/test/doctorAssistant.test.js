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
    assert.deepEqual(names, ["get_doctor_appointments", "get_doctor_appointment_statistics"]);
    assert.match(getPolicyForActor(doctor), /Asia\/Kolkata/);
    assert.deepEqual(getToolsForActor({ ...doctor, role: "patient" }).map(({ name }) => name).includes("get_patient_appointments"), true);
    assert.deepEqual(getToolsForActor({ ...doctor, role: "admin" }), []);
    assert.equal(getPolicyForActor({ ...doctor, role: "admin" }), null);
    const list = getToolsForActor(doctor)[0];
    assert.equal(list.schema.safeParse({ from: "2027-02-30", to: "2027-02-30" }).success, false);
    assert.equal(list.schema.safeParse({ from: "2027-02-01", to: "2027-02-02", doctor_id: "arbitrary" }).success, false);
    assert.equal(list.schema.safeParse({ day: "today" }).success, true);
    assert.equal(list.schema.safeParse({ date: "2027-02-01", to: "2027-02-01" }).success, false);
    assert.equal(list.schema.safeParse({ day: "today", offset: 10, limit: 50 }).success, true);
    assert.equal(list.schema.safeParse({ day: "today", limit: 51 }).success, false);
  });

  it("uses inclusive local-date boundaries, derives owner from user, and returns minimal patient data", async () => {
    let call;
    const database = { async query(sql, values) {
      call = { sql, values };
      return { rows: [{ date: "2027-02-01", start_time: "09:00:00", end_time: "09:30:00", status: "confirmed", patient_first_name: "A", patient_last_name: "B" }] };
    } };
    const result = await executeTool({ name: "get_doctor_appointments", actor: doctor, database, args: { from: "2027-02-01", to: "2027-02-01" }, applicationTimezone: "Asia/Kolkata" });
    assert.deepEqual(call.values, [doctor.id, "2027-02-01", "2027-02-01", 21, 0]);
    assert.match(call.sql, /scheduled_date BETWEEN \$2::date AND \$3::date/);
    assert.match(call.sql, /doctor\.user_id = \$1/);
    assert.doesNotMatch(call.sql, /patient_user\.(email|phone)|date_of_birth|gender|reason/);
    assert.equal(result.appointments[0].patient_first_name, "A");
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
