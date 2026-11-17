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
  it("normalizes next appointment lookups to nearest confirmed scope and keeps actions aligned", async () => {
    let turn = 0;
    let receivedArgs;
    const engine = createDoctorConversationEngine({
      provider: { generate: async () => turn++ === 0 ? { toolCalls: [{ id: "next", name: "get_doctor_appointments", arguments: { scope: "nearest", status: "cancelled" } }] } : { text: "Your next confirmed appointment is January 2." } },
      toolExecutor: async ({ args }) => { receivedArgs = args; return { appointments: [{ date: "2027-01-02", start_time: "09:00", status: "confirmed" }], ui_actions: [{ type: "appointment", appointment_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }] }; },
    });
    const result = await engine.respond({ actor: doctor, messages: [{ role: "user", content: "Show my next appointment." }], tools: [], systemInstruction: "" });
    assert.deepEqual(receivedArgs, { scope: "nearest", status: "confirmed" });
    assert.deepEqual(result.results[0].ui_actions, [{ type: "appointment", appointment_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }]);
    assert.equal("appointment_id" in result.results[0].data.appointments[0], false);
  });
  it("routes a January 14 availability request directly to current slots and eligible assisted-reschedule data", async () => {
    let providerCalls = 0;
    const received = [];
    const engine = createDoctorConversationEngine({
      now: () => new Date("2026-11-16T00:00:00.000Z"),
      provider: { async generate() { providerCalls += 1; throw new Error("date-specific availability is routed deterministically"); } },
      toolExecutor: async ({ name, args }) => {
        received.push({ name, args });
        return name === "get_doctor_nearest_slots"
          ? { slots: [{ date: "2027-01-14", start_time: "11:00:00", end_time: "11:30:00", mode: "wave", remaining_capacity: 1, capacity: 2 }],
            pending_assisted_reschedules: [{ date: "2027-01-14", start_time: "10:00:00", end_time: "10:30:00", status: "pending_patient", valid_suggestion_count: 1 }],
            ui_actions: [{ type: "schedule_slot", availability_id: "internal-slot-id" }] }
          : { schedules: [], exceptions: [], conflicts: [], notice: "Availability can change; booking is not guaranteed." };
      },
    });
    const response = await engine.respond({ actor: doctor, applicationTimezone: "Asia/Kolkata", database: {},
      messages: [{ role: "user", content: "Check my availability on January 14, 2027." }] });
    assert.equal(providerCalls, 0);
    assert.deepEqual(received.map(({ name, args }) => [name, args]), [
      ["get_doctor_schedules", { from: "2027-01-14", to: "2027-01-14" }],
      ["get_doctor_schedule_exceptions", { from: "2027-01-14", to: "2027-01-14" }],
      ["get_doctor_schedule_conflicts", { from: "2027-01-14", to: "2027-01-14" }],
      ["get_doctor_nearest_slots", { from: "2027-01-14", to: "2027-01-14" }],
    ]);
    assert.equal(response.results[3].tool, "get_doctor_nearest_slots");
    assert.equal(response.results[3].data.pending_assisted_reschedules[0].start_time, "10:00:00");
    assert.equal(response.results[3].ui_actions[0].availability_id, "internal-slot-id");
    assert.equal(response.results.filter(({ data }) => data.notice).length, 1);
  });
  it("keeps navigation identifiers in UI metadata and out of model tool results", async () => {
    const providerCalls = [];
    let round = 0;
    const engine = createDoctorConversationEngine({
      provider: { generate: async (input) => { providerCalls.push(input); return round++ === 0 ? { toolCalls: [{ id: "call", name: "get_doctor_appointments", arguments: {} }] } : { text: "One appointment." }; } },
      toolExecutor: async () => ({ appointments: [{ date: "2027-01-01", start_time: "09:00", status: "confirmed" }], ui_actions: [{ type: "appointment", appointment_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }] }),
    });
    const result = await engine.respond({ actor: doctor, messages: [], database: {}, tools: [], systemInstruction: "" });
    assert.equal(result.results[0].ui_actions[0].appointment_id, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    assert.equal("ui_actions" in providerCalls[1].messages.at(-1).toolResults[0].result, false);
    assert.equal("appointment_id" in providerCalls[1].messages.at(-1).toolResults[0].result.appointments[0], false);
  });
  it("exposes only read-only doctor tools and denies other roles", () => {
    const names = getToolsForActor(doctor).map(({ name }) => name);
    assert.deepEqual(names, ["get_doctor_schedules", "get_doctor_schedule_exceptions", "get_doctor_schedule_conflicts", "get_doctor_nearest_slots", "get_doctor_appointments", "get_doctor_appointment_statistics", "get_doctor_assisted_reschedule_requests"]);
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
    assert.equal(list.schema.safeParse({ scope: "nearest", status: "confirmed" }).success, true);
    assert.equal(list.schema.safeParse({ scope: "nearest", from: "2027-02-01", to: "2027-02-02" }).success, false);
    assert.equal(list.schema.safeParse({ scope: "upcoming", from: "2027-02-01", to: "2027-02-28", status: "confirmed" }).success, true);
    assert.equal(list.schema.safeParse({ scope: "upcoming", from: "2027-02-01" }).success, false);
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
    assert.deepEqual(result.ui_actions, [{ type: "appointment", appointment_id: "appointment-id" }]);
    assert.doesNotMatch(JSON.stringify(result.appointments), /patient-id|appointment-id|payment-id|patient@example\.com|555-0100|private reason|"A"|"B"/);
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

  it("normalizes last-week statistics provider arguments to the previous Asia/Kolkata week", async () => {
    const { createDoctorConversationEngine } = require("../src/services/assistant/doctorConversationEngine");
    const received = [];
    const statisticsTool = getToolsForActor(doctor).find(({ name }) => name === "get_doctor_appointment_statistics");
    assert.equal(statisticsTool.schema.safeParse({ period: "last_week", date: "last week" }).success, false);
    let generated = false;
    const engine = createDoctorConversationEngine({
      now: () => new Date("2026-11-18T12:00:00.000Z"),
      provider: { async generate() { if (generated) return { text: "No appointments last week.", toolCalls: [] }; generated = true; return { text: "", toolCalls: [{ name: "get_doctor_appointment_statistics", arguments: { period: "last_week", date: "last week" }, id: "weekly-stats" }] }; } },
      toolExecutor: async ({ name, args }) => { received.push({ name, args }); return { from: args.from, to: args.to, total: 0, by_status: { confirmed: 0, completed: 0, cancelled: 0 } }; },
    });
    const response = await engine.respond({ actor: doctor, messages: [{ role: "user", content: "Show my appointments statistics for the last week" }] });
    assert.deepEqual(received, [{ name: "get_doctor_appointment_statistics", args: { from: "2026-11-09", to: "2026-11-15" } }]);
    assert.equal(response.results[0].tool, "get_doctor_appointment_statistics");
  });

  it("normalizes a yearless availability date once for schedules, exceptions, conflicts, and slots", async () => {
    const received = [];
    let providerCalls = 0;
    const engine = createDoctorConversationEngine({
      now: () => new Date("2026-12-31T20:00:00.000Z"),
      provider: { async generate() { providerCalls += 1; throw new Error("date-specific availability is routed deterministically"); } },
      toolExecutor: async ({ name, args }) => { received.push({ name, args }); return { schedules: [], exceptions: [], conflicts: [], slots: [], notice: "Point-in-time view." }; },
    });
    await engine.respond({ actor: doctor, applicationTimezone: "Asia/Kolkata", messages: [{ role: "user", content: "Check my availability on 20 January" }] });
    assert.equal(providerCalls, 0);
    assert.deepEqual(received.map(({ name, args }) => [name, args.from, args.to]), [
      ["get_doctor_schedules", "2027-01-20", "2027-01-20"],
      ["get_doctor_schedule_exceptions", "2027-01-20", "2027-01-20"],
      ["get_doctor_schedule_conflicts", "2027-01-20", "2027-01-20"],
      ["get_doctor_nearest_slots", "2027-01-20", "2027-01-20"],
    ]);
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

  it("executes nearest doctor appointments as one upcoming confirmed appointment with its navigation action", async () => {
    let call;
    const database = { async query(sql, values) {
      call = { sql, values };
      return { rows: [{ id: "next-id", status: "confirmed", date: "2027-02-03", start_time: "09:00:00", end_time: "09:30:00", mode: "wave", patient_first_name: "Private", patient_id: "private-id" }] };
    } };
    const result = await executeTool({ name: "get_doctor_appointments", actor: doctor, database, args: { scope: "nearest", status: "confirmed" } });
    assert.match(call.sql, /a\.status = 'confirmed'/);
    assert.match(call.sql, /scheduled_date \+ a\.scheduled_start_time/);
    assert.deepEqual(result.appointments, [{ date: "2027-02-03", start_time: "09:00:00", end_time: "09:30:00", status: "confirmed", mode: "wave" }]);
    assert.deepEqual(result.ui_actions, [{ type: "appointment", appointment_id: "next-id" }]);
    assert.equal(result.has_more, false);
    assert.doesNotMatch(JSON.stringify(result), /Private|private-id/);
  });

  it("lists only future confirmed appointments in range, caps at 15, and keeps same-time appointments distinct", async () => {
    let call;
    const rows = Array.from({ length: 16 }, (_, index) => ({
      id: `appointment-${index + 1}`, status: "confirmed",
      date: index < 2 ? "2026-11-20" : `2026-11-${String(20 + Math.floor(index / 2)).padStart(2, "0")}`,
      start_time: index < 2 ? "09:00:00" : `${String(10 + index).padStart(2, "0")}:00:00`,
      end_time: index < 2 ? "09:30:00" : `${String(10 + index).padStart(2, "0")}:30:00`,
      mode: "wave", patient_id: "private-patient", patient_first_name: "Private",
    }));
    const database = { async query(sql, values) { call = { sql, values }; return { rows }; } };
    const result = await executeTool({ name: "get_doctor_appointments", actor: doctor, database, args: { scope: "upcoming", from: "2026-11-01", to: "2026-11-30" } });
    assert.match(call.sql, /a\.status = 'confirmed'/);
    assert.match(call.sql, /\(\(a\.scheduled_date \+ a\.scheduled_start_time\) AT TIME ZONE \$2\) > NOW\(\)/);
    assert.match(call.sql, /a\.scheduled_date >= \$4::date/);
    assert.match(call.sql, /a\.scheduled_date <= \$5::date/);
    assert.match(call.sql, /ORDER BY a\.scheduled_date, a\.scheduled_start_time, a\.id/);
    assert.deepEqual(call.values, [doctor.id, "Asia/Kolkata", "confirmed", "2026-11-01", "2026-11-30", 16, 0]);
    assert.equal(result.appointments.length, 15);
    assert.deepEqual(result.appointments.slice(0, 2).map(({ date, start_time }) => ({ date, start_time })), [
      { date: "2026-11-20", start_time: "09:00:00" }, { date: "2026-11-20", start_time: "09:00:00" },
    ]);
    assert.deepEqual(result.ui_actions.slice(0, 2), [
      { type: "appointment", appointment_id: "appointment-1" }, { type: "appointment", appointment_id: "appointment-2" },
    ]);
    assert.equal(result.has_more, true);
    assert.doesNotMatch(JSON.stringify(result.appointments), /appointment-1|appointment-2|Private|private-patient/);
  });

  it("limits default upcoming list requests but leaves explicit cancelled history queries unchanged", async () => {
    const received = [];
    let turn = 0;
    const engine = createDoctorConversationEngine({
      provider: { generate: async () => turn++ === 0
        ? { toolCalls: [{ id: "list", name: "get_doctor_appointments", arguments: { from: "2026-11-01", to: "2026-11-30", status: "cancelled" } }] }
        : { text: "Here are your appointments." } },
      now: () => new Date("2026-11-15T08:00:00.000Z"),
      maxToolCalls: 1,
      toolExecutor: async ({ args }) => { received.push(args); return { appointments: [], has_more: false }; },
    });
    await engine.respond({ actor: doctor, messages: [{ role: "user", content: "Show my appointments for November 2026." }], tools: [], systemInstruction: "" });
    assert.deepEqual(received[0], { from: "2026-11-01", to: "2026-11-30", status: "confirmed", scope: "upcoming" });

    received.length = 0;
    turn = 0;
    const historyEngine = createDoctorConversationEngine({
      provider: { generate: async () => turn++ === 0
        ? { toolCalls: [{ id: "history", name: "get_doctor_appointments", arguments: { from: "2026-11-01", to: "2026-11-30", status: "cancelled" } }] }
        : { text: "Here are the cancelled appointments." } },
      now: () => new Date("2026-11-15T08:00:00.000Z"), maxToolCalls: 1,
      toolExecutor: async ({ args }) => { received.push(args); return { appointments: [] }; },
    });
    await historyEngine.respond({ actor: doctor, messages: [{ role: "user", content: "Show my cancelled appointments for November 2026." }], tools: [], systemInstruction: "" });
    assert.deepEqual(received[0], { from: "2026-11-01", to: "2026-11-30", status: "cancelled" });
  });

  it("resolves a yearless exact-date appointment list to the next occurrence and aggregates all pages", async () => {
    const received = [];
    let providerCalls = 0;
    const engine = createDoctorConversationEngine({
      now: () => new Date("2026-11-17T08:00:00.000Z"),
      provider: { async generate() { providerCalls += 1; throw new Error("exact-date all appointment lists use the authenticated list tool"); } },
      toolExecutor: async ({ args }) => {
        received.push(args);
        if (args.offset === 0) return {
          appointments: [
            { date: "2026-12-15", start_time: "09:00:00", end_time: "09:30:00", status: "confirmed" },
            { date: "2026-12-15", start_time: "10:00:00", end_time: "10:30:00", status: "cancelled" },
          ],
          has_more: true,
          next_offset: 2,
          ui_actions: [{ type: "appointment", appointment_id: "appointment-1" }, { type: "appointment", appointment_id: "appointment-2" }],
        };
        return {
          appointments: [{ date: "2026-12-15", start_time: "11:00:00", end_time: "11:30:00", status: "confirmed" }],
          has_more: false,
          next_offset: null,
          ui_actions: [{ type: "appointment", appointment_id: "appointment-3" }],
        };
      },
    });
    const response = await engine.respond({ actor: doctor, applicationTimezone: "Asia/Kolkata", messages: [{ role: "user", content: "Show me all my appointments for 15th December" }] });
    assert.equal(providerCalls, 0);
    assert.deepEqual(received, [
      { date: "2026-12-15", limit: 50, offset: 0 },
      { date: "2026-12-15", limit: 50, offset: 2 },
    ]);
    assert.equal(response.results[0].data.appointments.length, 3);
    assert.equal(response.results[0].data.has_more, false);
    assert.deepEqual(response.results[0].ui_actions.map(({ appointment_id }) => appointment_id), ["appointment-1", "appointment-2", "appointment-3"]);
    assert.match(response.answer, /3 appointments for 2026-12-15/);
  });

  it("preserves an explicitly supplied year in an exact-date appointment list", async () => {
    let received;
    const engine = createDoctorConversationEngine({
      now: () => new Date("2026-11-17T08:00:00.000Z"),
      provider: { async generate() { throw new Error("exact-date all appointment lists use the authenticated list tool"); } },
      toolExecutor: async ({ args }) => { received = args; return { appointments: [], has_more: false }; },
    });
    const response = await engine.respond({ actor: doctor, applicationTimezone: "Asia/Kolkata", messages: [{ role: "user", content: "Show me all my appointments for 15th December 2024" }] });
    assert.deepEqual(received, { date: "2024-12-15", limit: 50, offset: 0 });
    assert.match(response.answer, /2024-12-15/);
  });

  it("corrects a model-provided year from a yearless appointment date before the list query", async () => {
    let received;
    let round = 0;
    const engine = createDoctorConversationEngine({
      now: () => new Date("2026-11-17T08:00:00.000Z"),
      provider: { async generate() { return round++ === 0
        ? { text: "", toolCalls: [{ name: "get_doctor_appointments", arguments: { date: "2024-12-15" }, id: "date-list" }] }
        : { text: "Here are your appointments.", toolCalls: [] }; } },
      toolExecutor: async ({ args }) => { received = args; return { appointments: [], has_more: false }; },
    });
    await engine.respond({ actor: doctor, applicationTimezone: "Asia/Kolkata", messages: [{ role: "user", content: "List my appointments for 15th December" }] });
    assert.equal(received.from, "2026-12-15");
    assert.equal(received.to, "2026-12-15");
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
    assert.deepEqual(result.conflicts.map(({ mode }) => mode), ["stream"]);
    assert.equal(result.conflicts[0].conflicts.includes("confirmed_appointment"), false);
    assert.equal(result.conflicts[0].conflicts.includes("active_reservation"), false);
    assert.equal(result.conflicts[0].conflicts.includes("payment_hold"), false);
    assert.ok(result.conflicts[0].conflicts.includes("capacity_reached"));
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
    assert.ok(result.conflicts[0].conflicts.includes("capacity_reached"));
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
        return { rows: [{ id: "open-slot", date: "2027-02-02", start_time: "10:00:00", end_time: "10:30:00", mode: "stream", capacity: 3, remaining_capacity: 2, is_private_one_off: true }] };
      }
      return { rows: [] };
    } };
    const response = await executeTool({ name: "get_doctor_nearest_slots", actor: doctor, database,
      applicationTimezone: "Asia/Kolkata", now: new Date("2027-01-31T20:00:00.000Z"), args: { days_ahead: 3 } });
    assert.deepEqual(availabilityOffsets, [0, 100, 200, 300, 400, 500]);
    assert.match(availabilitySql, /LIMIT \$10 OFFSET \$11/);
    assert.match(availabilitySql, /availability\.schedule_id IS NULL[\s\S]*source_schedule\.active[\s\S]*availability\.start_time >= source_period\.start_time[\s\S]*availability\.end_time <= source_period\.end_time/);
    assert.equal(response.slots[0].mode, "stream");
    assert.equal(response.slots[0].source, "private_one_off");
    assert.match(availabilitySql, /schedule_id IS NULL AND availability\.booking_visibility = 'private'/);
    assert.equal(response.scan_limit_reached, false);
    assert.equal(response.notice, "Availability can change; booking is not guaranteed.");
  });

  it("includes the point-in-time disclaimer once when a response contains multiple schedule results", async () => {
    let generated = false;
    const engine = createDoctorConversationEngine({
      provider: { async generate() {
        if (generated) return { text: "Here are the requested schedule details.", toolCalls: [] };
        generated = true;
        return { text: "", toolCalls: [
          { name: "get_doctor_schedules", arguments: { from: "2027-01-14", to: "2027-01-14" }, id: "schedules" },
          { name: "get_doctor_schedule_exceptions", arguments: { from: "2027-01-14", to: "2027-01-14" }, id: "exceptions" },
        ] };
      } },
      toolExecutor: async () => ({ schedules: [], exceptions: [], has_more: false, notice: "Availability can change; booking is not guaranteed." }),
    });
    const response = await engine.respond({ actor: doctor, messages: [{ role: "user", content: "Show schedules and exceptions for January 14, 2027" }] });
    assert.equal(response.results.filter(({ data }) => data.notice).length, 1);
    assert.equal(response.results[0].data.notice, "Availability can change; booking is not guaranteed.");
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

  it("surfaces a current pending assisted-reschedule appointment separately from open availability", async () => {
    const queryLog = [];
    const database = { async query(sql, values) {
      queryLog.push({ sql, values });
      if (sql.includes("SELECT id FROM doctors WHERE user_id")) return { rows: [{ id: "owned-doctor-id" }] };
      if (sql.includes("FROM availability WHERE")) return { rows: [] };
      if (sql.includes("FROM assisted_reschedule_requests request")) return { rows: [{
        request_id: "private-request-id", date: "2027-01-14", start_time: "10:00:00", end_time: "10:30:00",
        mode: "wave", availability_id: "valid-suggestion-slot", capacity: 2,
      }] };
      if (sql.includes("SELECT reservation.availability_id")) return { rows: [{ availability_id: "valid-suggestion-slot", occupied: 1 }] };
      return { rows: [] };
    } };
    const response = await executeTool({ name: "get_doctor_nearest_slots", actor: doctor, database,
      applicationTimezone: "Asia/Kolkata", now: new Date("2027-01-13T20:00:00.000Z"),
      args: { from: "2027-01-14", to: "2027-01-14" } });
    assert.deepEqual(response.slots, []);
    assert.deepEqual(response.pending_assisted_reschedules, [{
      date: "2027-01-14", start_time: "10:00:00", end_time: "10:30:00", mode: "wave",
      status: "pending_patient", valid_suggestion_count: 1,
    }]);
    assert.equal(JSON.stringify(response).includes("private-request-id"), false);
    assert.ok(queryLog.some(({ sql }) => /request\.status = 'pending_patient'.*request\.expires_at > NOW\(\)/s.test(sql)));
    assert.ok(queryLog.some(({ sql }) => /appointment\.updated_at = request\.appointment_updated_at/.test(sql)));
  });

  it("lists only the authenticated doctor's assisted requests with authorized operational details", async () => {
    const requestId = "private-request-id";
    const appointmentId = "private-appointment-id";
    const selectedAvailabilityId = "private-selected-slot";
    const database = { async query(sql, values) {
      if (sql.includes("SELECT id FROM doctors WHERE user_id")) return { rows: [{ id: "owned-doctor-id" }] };
      if (sql.startsWith("UPDATE assisted_reschedule_requests")) return { rows: [], rowCount: 0 };
      if (sql.includes("FROM assisted_reschedule_requests request") && sql.includes("appointment.reason")) return { rows: [{
        id: requestId, appointment_id: appointmentId, patient_id: "private-patient-id", selected_availability_id: selectedAvailabilityId,
        previous_date: "2027-01-14", previous_start_time: "10:00:00", previous_end_time: "10:30:00", mode: "wave",
        status: "accepted", responded_at: "2027-01-12T10:00:00.000Z", patient_first_name: "Asha", patient_last_name: "Rao",
        appointment_status: "confirmed", appointment_reason: "Follow-up visit", appointment_date: "2027-01-15",
        appointment_start_time: "11:00:00", appointment_end_time: "11:30:00", suggestion_count: 1,
      }] };
      if (sql.includes("FROM assisted_reschedule_suggestions suggestion")) return { rows: [{
        request_id: requestId, availability_id: selectedAvailabilityId, mode: "wave", date: "2027-01-15",
        start_time: "11:00:00", end_time: "11:30:00", rank: 1, remaining_capacity_at_suggestion: 2,
      }] };
      throw new Error(`Unexpected query: ${sql} ${JSON.stringify(values)}`);
    } };
    const result = await executeTool({ name: "get_doctor_assisted_reschedule_requests", actor: doctor, database, args: {} });
    assert.equal(result.items.length, 1);
    assert.deepEqual(result.items[0], {
      patient_name: "Asha Rao",
      appointment: { date: "2027-01-14", start_time: "10:00:00", end_time: "10:30:00", status: "confirmed", reason: "Follow-up visit" },
      current_appointment: { date: "2027-01-15", start_time: "11:00:00", end_time: "11:30:00", status: "confirmed" },
      mode: "wave", status: "accepted", patient_response: "Accepted", responded_at: "2027-01-12T10:00:00.000Z",
      alternatives: [{ date: "2027-01-15", start_time: "11:00:00", end_time: "11:30:00", mode: "wave", rank: 1, selected: true, capacity_at_suggestion: 2 }],
    });
    assert.doesNotMatch(JSON.stringify(result), /private-request-id|private-appointment-id|private-patient-id|private-selected-slot/);
  });

  it("routes assisted-rescheduling request listings to their request tool without availability results", async () => {
    const received = [];
    let providerCalls = 0;
    const engine = createDoctorConversationEngine({
      provider: { async generate() { providerCalls += 1; throw new Error("request listing should be routed deterministically"); } },
      toolExecutor: async ({ name, args }) => {
        received.push({ name, args });
        return { items: [{ patient_name: "Asha Rao", status: "pending_patient", patient_response: "Awaiting patient response", appointment: { date: "2027-01-14", start_time: "10:00:00", reason: "Follow-up visit" }, alternatives: [] }], has_more: false, next_offset: null };
      },
    });
    const response = await engine.respond({ actor: doctor, messages: [{ role: "user", content: "Show me all assisted rescheduling requests" }] });
    assert.equal(providerCalls, 0);
    assert.deepEqual(received, [{ name: "get_doctor_assisted_reschedule_requests", args: { limit: 100, offset: 0 } }]);
    assert.deepEqual(response.results.map(({ tool }) => tool), ["get_doctor_assisted_reschedule_requests"]);
    assert.doesNotMatch(JSON.stringify(response.results), /get_doctor_nearest_slots|get_available_slots/);
    assert.match(response.answer, /patient response/i);
    assert.match(response.answer, /specific request for its details and saved alternatives/i);
  });

  it("filters requests awaiting patient response by pending_patient in the request tool query", async () => {
    let received;
    const engine = createDoctorConversationEngine({
      provider: { async generate() { throw new Error("pending request listing should use the authorized request tool"); } },
      toolExecutor: async (input) => { received = input; return { items: [], has_more: false, next_offset: null }; },
    });
    await engine.respond({ actor: doctor, messages: [{ role: "user", content: "Show assisted rescheduling requests awaiting patient response" }] });
    assert.equal(received.name, "get_doctor_assisted_reschedule_requests");
    assert.deepEqual(received.args, { status: "pending_patient", limit: 100, offset: 0 });
    assert.ok(received.now instanceof Date);
  });

  it("routes a specific assisted-request alternatives question through the authorized detail tool", async () => {
    const providerInputs = [];
    let round = 0;
    const engine = createDoctorConversationEngine({
      provider: { async generate(input) {
        providerInputs.push(input);
        return round++ === 0
          ? { toolCalls: [{ id: "request-details", name: "get_doctor_assisted_reschedule_requests", arguments: {} }] }
          : { text: "Asha Rao has one saved alternative on January 15 at 11:00 AM." };
      } },
      toolExecutor: async ({ name }) => name === "get_doctor_assisted_reschedule_requests"
        ? { items: [{ patient_name: "Asha Rao", status: "pending_patient", patient_response: "Awaiting patient response", appointment: { date: "2027-01-14", start_time: "10:00:00" }, alternatives: [{ date: "2027-01-15", start_time: "11:00:00" }] }] }
        : {},
    });
    const response = await engine.respond({ actor: doctor, messages: [{ role: "user", content: "What alternatives were saved for Asha Rao's assisted rescheduling request?" }] });
    assert.equal(providerInputs.length, 2);
    assert.match(response.answer, /January 15/);
    assert.equal(response.results[0].tool, "get_doctor_assisted_reschedule_requests");
    assert.equal(response.results[0].data.items[0].patient_name, "Asha Rao");
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
