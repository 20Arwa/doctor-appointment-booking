const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { getPolicyForActor, getToolsForActor } = require("../src/services/assistant/toolRegistry");
const { executeTool, nextDaysRange, safeAppointment } = require("../src/services/assistant/toolExecutor");
const { patientUiActions, publicToolResult } = require("../src/services/assistant/conversationEngine");
const { createConversationEngine, AssistantError, pairedTimeCandidates, selectedAppointmentTimes, timeRangeTarget, timeReferences } = require("../src/services/assistant/conversationEngine");
const { createGeminiProvider, readRetryAfterMs } = require("../src/services/assistant/geminiProvider");

const userId = "11111111-1111-4111-8111-111111111111";
const doctorId = "22222222-2222-4222-8222-222222222222";
const user = { id: userId, first_name: "Pat", last_name: "Patient", role: "patient", is_active: true };
describe("patient assistant tools", () => {
  it("requires an explicit or range-resolved meridiem before booking, rescheduling, or cancellation", async () => {
    for (const content of [
      "Book an appointment with Dr. Dee Doctor on 2027-02-06 at 11:00",
      "Book an appointment with Dr. Dee Doctor on 2027-02-06 at 11",
      "Reschedule my appointment with Dr. Dee Doctor on 2027-02-05 at 09:00 to 2027-02-06 at 11:00",
      "Cancel my appointment with Dr. Dee Doctor on 2027-02-06 at 11:00",
    ]) {
      let toolCalls = 0;
      const engine = createConversationEngine({ provider: { generate: async () => { throw new Error("ambiguous action must be clarified before model tools"); } }, toolExecutor: async () => { toolCalls += 1; return {}; } });
      const response = await engine.respond({ actor: user, messages: [{ role: "user", content }] });
      assert.equal(toolCalls, 0, content);
      assert.match(response.answer, /AM.*PM/i, content);
    }
  });

  it("keeps an explicit AM/PM exact booking path available", async () => {
    const calls = [];
    const doctor = { id: doctorId, name: "Dr. Dee Doctor" };
    const slotId = "88888888-8888-4888-8888-888888888888";
    let providerCalled = false;
    const engine = createConversationEngine({
      provider: { generate: async () => { providerCalled = true; return { text: "", toolCalls: [{ name: "search_doctors", arguments: { name: "Dee Doctor" }, id: "doctor" }] }; } },
      toolExecutor: async ({ name, args }) => {
        calls.push({ name, args });
        if (name === "search_doctors") return { doctors: [doctor] };
        if (name === "get_available_slots") return { slots: [{ id: slotId, availability_id: slotId, date: "2027-02-06", start_time: "11:00:00", end_time: "11:30:00", doctor_id: doctorId, doctor }] };
        return { proposal: { action_type: "book", action_args: args }, requires_patient_confirmation: true };
      },
    });
    const response = await engine.respond({ actor: user, messages: [{ role: "user", content: "Book an appointment with Dr. Dee Doctor on 2027-02-06 at 11:00 AM" }] });
    assert.equal(providerCalled, false);
    assert.equal(calls.at(-1).name, "prepare_booking_action");
    assert.equal(calls.at(-1).args.availability_id, slotId);
    assert.match(response.answer, /booking proposal/i);
    assert.deepEqual(response.internalProposalEvidence, {
      version: 1,
      proposal_succeeded: true,
      requires_patient_confirmation: true,
      tool_name: "prepare_booking_action",
      action_type: "book",
      action_args: { availability_id: slotId },
      verified_appointment_id: null,
      verified_availability_id: slotId,
      user_id: userId,
    });
  });

  it("propagates AM/PM consistently across appointment time ranges", () => {
    for (const text of ["11:00 AM–11:30", "11:00 AM–11:30 AM", "11:00–11:30 AM"]) {
      const references = timeReferences(text);
      const selected = selectedAppointmentTimes(text, references);
      assert.deepEqual(selected.start, ["11:00"]);
      assert.deepEqual(selected.end, ["11:30"]);
      const target = timeRangeTarget(text, references);
      assert.deepEqual(target.start.candidates, ["11:00"]);
      assert.deepEqual(target.end.candidates, ["11:30"]);
    }
  });
  it("validates explicit appointment-history categories and bounded pagination", () => {
    const tool = getToolsForActor(user).find(({ name }) => name === "get_patient_appointments");
    for (const query of [
      { view: "upcoming", scope: "nearest" },
      { view: "upcoming", scope: "furthest" },
      { view: "upcoming", scope: "all", offset: 20 },
      { view: "upcoming", scope: "all", offset: 1200 },
      { view: "past", scope: "last" },
      { view: "past", scope: "last_completed" },
      { view: "cancelled", scope: "all" },
    ]) assert.equal(tool.schema.safeParse(query).success, true, JSON.stringify(query));
    assert.equal(tool.schema.safeParse({ view: "past", scope: "last_completed", offset: 20 }).success, false);
  });

  it("uses a date scoped lookup for today and keeps an empty date result empty", async () => {
    const calls = [];
    const engine = createConversationEngine({
      now: () => Date.parse("2026-11-17T04:00:00.000Z"),
      provider: { generate: async () => { throw new Error("date history is deterministic"); } },
      toolExecutor: async ({ name, args }) => { calls.push({ name, args }); return { appointments: [], has_more: false }; },
    });
    const response = await engine.respond({ actor: user, messages: [{ role: "user", content: "Show me all my appointments for today" }] });
    assert.deepEqual(calls, [{ name: "get_patient_appointments", args: { view: "date", scope: "all", from: "2026-11-17", to: "2026-11-17", offset: 0 } }]);
    assert.match(response.answer, /no matching appointments/i);
    assert.equal(response.internalReferences.history_page.query.view, "date");
  });

  it("re-resolves a corrected date instead of continuing the previous appointment query", async () => {
    const calls = [];
    const engine = createConversationEngine({
      now: () => Date.parse("2026-11-17T04:00:00.000Z"),
      provider: { generate: async () => { throw new Error("date corrections are deterministic"); } },
      toolExecutor: async ({ name, args }) => { calls.push({ name, args }); return { appointments: [], has_more: false }; },
    });
    const first = await engine.respond({ actor: user, messages: [{ role: "user", content: "Show appointments for tomorrow" }] });
    const corrected = await engine.respond({ actor: user, previousReferences: first.internalReferences, messages: [
      { role: "user", content: "Show appointments for tomorrow" },
      { role: "assistant", content: first.answer },
      { role: "user", content: "I said today" },
    ] });
    assert.equal(calls[0].args.from, "2026-11-18");
    assert.equal(calls[1].args.from, "2026-11-17");
    assert.equal(corrected.internalReferences.history_page.query.to, "2026-11-17");
  });

  it("returns only the most recent completed appointment for the last-completed history scope", async () => {
    let sql;
    let values;
    const output = await executeTool({
      name: "get_patient_appointments", args: { view: "past", scope: "last_completed" }, actor: user,
      database: { async query(query, params) { sql = query; values = params; return { rows: [] }; } },
      applicationTimezone: "Asia/Kolkata",
    });
    assert.match(sql, /a\.status = \$\d+/);
    assert.match(sql, /ORDER BY a\.scheduled_date DESC/);
    assert.match(sql, /LIMIT \$\d+ OFFSET \$\d+/);
    assert.equal(values.includes("completed"), true);
    assert.deepEqual(output, { appointments: [], has_more: false, next_offset: 0 });
  });

  it("applies date filters in the owned appointment query and returns every matching row", async () => {
    let sql;
    let values;
    const rows = Array.from({ length: 27 }, (_, index) => ({ id: `id-${index}`, date: "2026-12-15", start_time: "09:00", end_time: "09:30", status: "confirmed", mode: "Wave" }));
    const output = await executeTool({
      name: "get_patient_appointments", args: { view: "date", scope: "all", from: "2026-12-15", to: "2026-12-15" }, actor: user,
      database: { async query(query, params) { sql = query; values = params; return { rows }; } },
      applicationTimezone: "Asia/Kolkata",
    });
    assert.match(sql, /p\.user_id = \$1/);
    assert.match(sql, /a\.scheduled_date >= \$\d+::date/);
    assert.match(sql, /a\.scheduled_date <= \$\d+::date/);
    assert.doesNotMatch(sql, /LIMIT/);
    assert.deepEqual(values.slice(0, 3), [userId, "2026-12-15", "2026-12-15"]);
    assert.equal(output.appointments.length, 27);
    assert.equal(output.has_more, false);
  });

  it("registers role-specific assistant tools and validates bounded patient date ranges", () => {
    assert.equal(getToolsForActor(user).length, 9);
    assert.match(getPolicyForActor(user), /Never guess or invent records/);
    assert.equal(getToolsForActor({ ...user, role: "doctor" }).length, 7);
    assert.match(getPolicyForActor({ ...user, role: "doctor" }), /Never book, cancel, reschedule/);
  });

  it("returns preparation-only proposals and rejects unexpected action fields", async () => {
    const proposal = await executeTool({ name: "prepare_booking_action", args: { availability_id: doctorId }, actor: user, database: {} });
    assert.deepEqual(proposal, { proposal: { action_type: "book", action_args: { availability_id: doctorId } }, requires_patient_confirmation: true });
    await assert.rejects(executeTool({ name: "prepare_booking_action", args: { availability_id: doctorId, patient_id: userId }, actor: user, database: {} }), { code: "INVALID_TOOL_ARGUMENTS" });
  });

  it("exposes only minimal cancellation refund preview data from the patient-owned service", async () => {
    const appointmentId = "99999999-9999-4999-8999-999999999999";
    let calledWith;
    const output = await executeTool({
      name: "get_cancellation_refund_preview", args: { appointment_id: appointmentId }, actor: user, database: {},
      paymentService: { async previewCancellationRefund(...args) {
        calledWith = args;
        return { original_payment: { amount: "500.00", currency: "INR", status: "partially_refunded", provider_payment_id: "secret" }, processed_refund_amount: "100.00", pending_refund_amount: "50.00", estimated_refund_amount: "100.00", currency: "INR", refund_expected: true, explanation: "Estimate", provider_response: { secret: true } };
      } },
    });
    assert.deepEqual(calledWith, [user, appointmentId]);
    assert.deepEqual(output, { original_payment: { amount: "500.00", currency: "INR", status: "partially_refunded" }, processed_refund_amount: "100.00", pending_refund_amount: "50.00", estimated_additional_refund_amount: "100.00", currency: "INR", refund_expected: true, explanation: "Estimate" });
    assert.doesNotMatch(JSON.stringify(output), /secret|provider_response/i);
  });

  it("exposes patient payment and refund history without provider references or receipt URLs", async () => {
    let calledWith;
    const output = await executeTool({
      name: "get_patient_payment_history", args: { limit: 5, offset: 10 }, actor: user, database: {},
      paymentService: { async getPaymentHistory(...args) {
        calledWith = args;
        return { items: [{ id: "payment-secret", amount: "500.00", currency: "INR", status: "partially_refunded", date: "2027-01-01", receipt_url: "https://private.test", provider_payment_id: "secret", appointment: { id: "appointment-secret", status: "confirmed", date: "2027-01-02", start_time: "10:00", doctor: { id: "doctor-secret", first_name: "Dee", last_name: "Doctor", specialty: "Cardiology" } }, refunds: [{ id: "refund-secret", payment_id: "payment-secret", amount: "100.00", currency: "INR", status: "processed", reason: "appointment_cancelled", created_at: "2027-01-03", processed_at: "2027-01-04" }] }], has_more: false };
      } },
    });
    assert.deepEqual(calledWith, [user, { limit: 5, offset: 10 }]);
    assert.deepEqual(output.items[0], { amount: "500.00", currency: "INR", status: "partially_refunded", date: "2027-01-01", appointment: { status: "confirmed", date: "2027-01-02", start_time: "10:00", doctor: { name: "Dr. Dee Doctor", specialty: "Cardiology" } }, refunds: [{ amount: "100.00", currency: "INR", status: "processed", reason: "appointment_cancelled", created_at: "2027-01-03", processed_at: "2027-01-04" }] });
    assert.doesNotMatch(JSON.stringify(output), /secret|receipt_url|provider_payment_id/);
  });

  it("matches recorded refunds through the uniquely identified patient-owned appointment", async () => {
    const appointmentId = "77777777-7777-4777-8777-777777777777";
    const paymentLookup = [];
    const output = await executeTool({
      name: "get_patient_refund_history",
      args: { doctor_name: "James Wilson", date: "2026-11-20", start_time: "09:00" },
      actor: user,
      database: { query: async (sql, values) => {
        assert.match(sql, /p\.user_id = \$1/);
        assert.deepEqual(values, [user.id, "2026-11-20", "2026-11-20"]);
        return { rows: [{ id: appointmentId, date: "2026-11-20", start_time: "09:00:00", doctor_first_name: "James", doctor_last_name: "Wilson", doctor_id: doctorId }] };
      } },
      paymentService: { async getPaymentHistoryForAppointment(actor, id) {
        paymentLookup.push({ actor, id });
        return { appointment: { date: "2026-11-20", start_time: "09:00:00", doctor: { first_name: "James", last_name: "Wilson" } }, payments: [
          { amount: "500.00", currency: "INR", status: "refunded", refunds: [{ amount: "500.00", currency: "INR", status: "processed", processed_at: "2026-11-21T00:00:00Z" }] },
        ] };
      } },
    });
    assert.deepEqual(paymentLookup, [{ actor: user, id: appointmentId }]);
    assert.equal(output.matches, 1);
    assert.equal(output.payments[0].status, "refunded");
    assert.equal(output.payments[0].refunds[0].status, "processed");
    assert.doesNotMatch(JSON.stringify(output), /appointment_id|payment_id|provider_payment_id/);
    await assert.rejects(executeTool({ name: "get_patient_refund_history", args: { doctor_name: "James Wilson", date: "2026-11-20", start_time: "09:00" }, actor: { ...user, role: "doctor" }, database: {}, paymentService: { getPaymentHistoryForAppointment: async () => null } }), { code: "TOOL_UNAVAILABLE" });
  });

  it("does not choose between distinct owned appointments with identical identifying details", async () => {
    const paymentLookup = [];
    const output = await executeTool({
      name: "get_patient_refund_history",
      args: { doctor_name: "James Wilson", date: "2026-11-20", start_time: "09:00" },
      actor: user,
      database: { query: async () => ({ rows: [
        { id: "77777777-7777-4777-8777-777777777777", date: "2026-11-20", start_time: "09:00:00", doctor_first_name: "James", doctor_last_name: "Wilson" },
        { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", date: "2026-11-20", start_time: "09:00:00", doctor_first_name: "James", doctor_last_name: "Wilson" },
      ] }) },
      paymentService: { async getPaymentHistoryForAppointment(_actor, id) { paymentLookup.push(id); return null; } },
    });
    assert.equal(output.matches, 2);
    assert.deepEqual(paymentLookup, []);
  });

  it("answers explicit refund-status questions from the verified payment ledger", async () => {
    const calls = [];
    const engine = createConversationEngine({ provider: { generate: async () => { throw new Error("refund status lookup should be deterministic"); } }, toolExecutor: async ({ name, args, actor }) => {
      calls.push({ name, args, actor });
      return { matches: 1, appointment: { date: "2026-11-20", start_time: "09:00:00", doctor: { name: "Dr. James Wilson" } }, payments: [{ amount: "500.00", currency: "INR", status: "refunded", refunds: [{ amount: "500.00", currency: "INR", status: "processed" }] }] };
    } });
    const answer = await engine.respond({ actor: user, messages: [{ role: "user", content: "What is the refund status for Dr. James Wilson's appointment on November 20, 2026 at 9:00 AM?" }] });
    assert.equal(calls[0].name, "get_patient_refund_history");
    assert.deepEqual(calls[0].args, { doctor_name: "James Wilson", date: "2026-11-20", start_time: "09:00" });
    assert.equal(calls[0].actor.id, user.id);
    assert.match(answer.answer, /payment status is refunded · INR 500\.00/i);
    assert.match(answer.answer, /INR 500\.00 is processed/i);
    assert.deepEqual(answer.results.map(({ tool }) => tool), ["get_patient_refund_history"]);
  });

  it("reports a partially refunded payment when the appointment has older failed payment attempts", async () => {
    const engine = createConversationEngine({
      provider: { generate: async () => { throw new Error("refund status lookup should be deterministic"); } },
      toolExecutor: async () => ({ matches: 1, appointment: { date: "2026-11-12", start_time: "16:00:00", doctor: { name: "Dr. James Wilson" } }, payments: [
        { amount: "500.00", currency: "INR", status: "partially_refunded", refunds: [{ amount: "250.00", currency: "INR", status: "processed" }] },
        { amount: "500.00", currency: "INR", status: "failed", refunds: [] },
      ] }),
    });
    const response = await engine.respond({ actor: user, messages: [{ role: "user", content: "What is the refund status for Dr. James Wilson's appointment on November 12, 2026 at 4:00 PM?" }] });
    assert.match(response.answer, /payment status is partially_refunded · INR 500\.00/i);
    assert.match(response.answer, /INR 250\.00 is processed/i);
  });

  it("routes payment-history questions to payment history without asking for an appointment", async () => {
    const calls = [];
    const engine = createConversationEngine({
      provider: { generate: async () => { throw new Error("payment history is routed deterministically"); } },
      toolExecutor: async ({ name, args }) => {
        calls.push({ name, args });
        return { items: [{ amount: "500.00", currency: "INR", status: "captured", date: "2027-01-01", refunds: [] }], has_more: false };
      },
    });
    const response = await engine.respond({ actor: user, messages: [{ role: "user", content: "Show my payment history" }] });
    assert.deepEqual(calls, [{ name: "get_patient_payment_history", args: {} }]);
    assert.deepEqual(response.results.map(({ tool }) => tool), ["get_patient_payment_history"]);
    assert.match(response.answer, /payment and refund records/i);
  });

  it("shows date-specific booking slots and prepares the selected slot as a booking proposal", async () => {
    const date = "2099-08-11";
    const slotId = "88888888-8888-4888-8888-888888888888";
    const doctor = { id: doctorId, name: "Dr. Ada Morgan", specialty: "Cardiology" };
    const calls = [];
    const engine = createConversationEngine({
      now: () => Date.parse("2026-11-15T00:00:00Z"),
      provider: { generate: async () => { throw new Error("date-only booking and its slot selection are deterministic"); } },
      toolExecutor: async ({ name, args }) => {
        calls.push({ name, args });
        if (name === "search_doctors") return { doctors: [doctor] };
        if (name === "get_available_slots") return { slots: [{ id: slotId, availability_id: slotId, doctor_id: doctorId, date, start_time: "14:30:00", end_time: "15:00:00", doctor }] };
        return { proposal: { action_type: "book", action_args: args }, requires_patient_confirmation: true };
      },
    });
    const first = await engine.respond({ actor: user, messages: [{ role: "user", content: `Book an appointment with Dr. Ada Morgan on ${date}` }] });
    assert.deepEqual(calls.map(({ name }) => name), ["search_doctors", "get_available_slots"]);
    assert.equal(first.results[0].tool, "get_available_slots");
    assert.equal(first.internalReferences.pending_action, "book");
    const selected = await engine.respond({
      actor: user, previousReferences: { ...first.internalReferences, pending_action: undefined },
      messages: [{ role: "user", content: `Book an appointment with Dr. Ada Morgan on ${date}` }, { role: "assistant", content: first.answer }, { role: "user", content: "Book slot 1" }],
    });
    assert.deepEqual(calls.map(({ name }) => name), ["search_doctors", "get_available_slots", "get_patient_appointments", "get_available_slots", "prepare_booking_action"]);
    assert.deepEqual(calls[3].args, { doctor_id: doctorId, from: date, to: date, exact_start_time: "14:30" });
    assert.equal(calls[4].args.availability_id, slotId);
    assert.equal(selected.results[0].tool, "prepare_booking_action");
    assert.match(selected.answer, /booking proposal/i);
  });

  it("retains a verified doctor and January 20 date when the patient follows with an available-times question", async () => {
    const doctor = { id: doctorId, name: "Dr. James Wilson" };
    const date = "2027-01-20";
    const slot = { id: "88888888-8888-4888-8888-888888888888", availability_id: "88888888-8888-4888-8888-888888888888", doctor_id: doctorId,
      doctor, date, start_time: "12:00:00", end_time: "12:30:00", mode: "wave", capacity: 2, remaining_capacity: 2 };
    const calls = [];
    let searched = false;
    const engine = createConversationEngine({
      now: () => Date.parse("2026-12-01T00:00:00Z"),
      provider: { async generate() {
        if (!searched) { searched = true; return { text: "", toolCalls: [{ id: "doctor-search", name: "search_doctors", arguments: { name: "James Wilson" } }] }; }
        return { text: "I found Dr. James Wilson.", toolCalls: [] };
      } },
      toolExecutor: async ({ name, args }) => {
        calls.push({ name, args });
        if (name === "search_doctors") return { doctors: [doctor] };
        if (name === "get_available_slots") return { slots: [slot] };
        throw new Error(`Unexpected tool ${name}`);
      },
    });
    const messages = [];
    let references;
    const send = async (content) => {
      messages.push({ role: "user", content });
      const response = await engine.respond({ actor: user, messages, previousReferences: references });
      references = response.internalReferences;
      messages.push({ role: "assistant", content: response.answer });
      return response;
    };

    const foundDoctor = await send("Find Dr. James Wilson.");
    assert.equal(foundDoctor.internalReferences.doctors[0].id, doctorId);
    const selectedDate = await send("January 20, 2027.");
    assert.equal(selectedDate.internalReferences.pending_target_date, date);
    assert.deepEqual(selectedDate.internalReferences.slot_query, { doctor_id: doctorId, from: date, to: date });
    assert.deepEqual(selectedDate.internalReferences.slots.map((entry) => entry.availability_id || entry.id), [slot.id]);
    assert.deepEqual(calls.at(-1), { name: "get_available_slots", args: { doctor_id: doctorId, from: date, to: date } });
    const availableTimes = await send("What are the available times?");
    assert.match(availableTimes.answer, /Dr\. James Wilson on 2027-01-20/i);
    assert.deepEqual(availableTimes.results[0].data.slots.map((entry) => entry.start_time), ["12:00:00"]);
    assert.equal(calls.filter(({ name }) => name === "search_doctors").length, 1);
    assert.deepEqual(calls.filter(({ name }) => name === "get_available_slots").map(({ args }) => args), [
      { doctor_id: doctorId, from: date, to: date },
      { doctor_id: doctorId, from: date, to: date },
    ]);
  });

  it("keeps a pending booking question on malformed January date and numeric voice transcripts", async () => {
    const doctor = { id: doctorId, name: "Dr. James Wilson" };
    const calls = [];
    const engine = createConversationEngine({
      now: () => Date.parse("2026-12-01T12:00:00Z"),
      provider: { generate: async () => ({ text: "", toolCalls: [{ id: "doctor-search", name: "search_doctors", arguments: { name: "James Wilson" } }] }) },
      toolExecutor: async ({ name, args }) => {
        calls.push({ name, args });
        if (name === "search_doctors") return { doctors: [doctor] };
        throw new Error(`Unexpected tool ${name}`);
      },
    });
    const messages = [];
    let references;
    const send = async (content) => {
      messages.push({ role: "user", content });
      const response = await engine.respond({ actor: user, messages, previousReferences: references });
      references = response.internalReferences;
      messages.push({ role: "assistant", content: response.answer });
      return response;
    };

    const foundDoctor = await send("I want to book an appointment with Dr. James Wilson.");
    assert.equal(foundDoctor.internalReferences.pending_response, "date_time");
    const malformedDate = await send("January 217");
    assert.match(malformedDate.answer, /couldn't resolve.*calendar date|valid date/i);
    assert.deepEqual(malformedDate.results, []);
    assert.equal(malformedDate.internalReferences.pending_response, "date_time");
    assert.equal(malformedDate.internalReferences.doctors[0].id, doctorId);
    const ambiguousNumber = await send("2817");
    assert.match(ambiguousNumber.answer, /date|month, day, and year/i);
    assert.deepEqual(ambiguousNumber.results, []);
    assert.equal(ambiguousNumber.internalReferences.pending_response, "date_time");
    assert.equal(ambiguousNumber.internalReferences.doctors[0].id, doctorId);
    assert.deepEqual(calls.map(({ name }) => name), ["search_doctors"]);
    assert.equal(ambiguousNumber.internalReferences.pending_target_date, undefined);
  });

  it("clarifies a month-year and time without losing the selected booking doctor", async () => {
    const doctor = { id: doctorId, name: "Dr. James Wilson" };
    const calls = [];
    const engine = createConversationEngine({
      now: () => Date.parse("2026-12-01T12:00:00Z"),
      provider: { generate: async () => ({ text: "", toolCalls: [{ id: "doctor-search", name: "search_doctors", arguments: { name: "James Wilson" } }] }) },
      toolExecutor: async ({ name, args }) => { calls.push({ name, args }); if (name === "search_doctors") return { doctors: [doctor] }; throw new Error(`Unexpected tool ${name}`); },
    });
    const first = await engine.respond({ actor: user, messages: [{ role: "user", content: "I want to book an appointment with Dr. James Wilson." }] });
    const response = await engine.respond({ actor: user, previousReferences: first.internalReferences, messages: [
      { role: "user", content: "I want to book an appointment with Dr. James Wilson." },
      { role: "assistant", content: first.answer },
      { role: "user", content: "January 2027 12 PM" },
    ] });
    assert.match(response.answer, /need the day of the month/i);
    assert.match(response.answer, /12:00 PM/i);
    assert.deepEqual(response.results, []);
    assert.equal(response.internalReferences.doctors[0].id, doctorId);
    assert.equal(response.internalReferences.pending_response, "date_time");
    assert.deepEqual(calls.map(({ name }) => name), ["search_doctors"]);
  });

  it("resolves a spoken demonstrative time to the displayed January 20 slot and revalidates once", async () => {
    const date = "2027-01-20";
    const slotId = "88888888-8888-4888-8888-888888888888";
    const doctor = { id: doctorId, name: "Dr. James Wilson" };
    const slot = { id: slotId, availability_id: slotId, doctor_id: doctorId, date, start_time: "12:00:00", end_time: "12:30:00", doctor, capacity: 2, remaining_capacity: 2 };
    const calls = [];
    const engine = createConversationEngine({
      now: () => Date.parse("2026-12-01T12:00:00Z"),
      provider: { generate: async () => ({ text: "", toolCalls: [{ id: "doctor-search", name: "search_doctors", arguments: { name: "James Wilson" } }] }) },
      toolExecutor: async ({ name, args }) => {
        calls.push({ name, args });
        if (name === "search_doctors") return { doctors: [doctor] };
        if (name === "get_available_slots") return { slots: [slot] };
        if (name === "get_patient_appointments") return { appointments: [], has_more: false };
        if (name === "prepare_booking_action") return { proposal: { action_type: "book", action_args: args }, requires_patient_confirmation: true };
        throw new Error(`Unexpected tool ${name}`);
      },
    });
    const messages = [];
    let references;
    const send = async (content) => {
      messages.push({ role: "user", content });
      const response = await engine.respond({ actor: user, messages, previousReferences: references });
      references = response.internalReferences;
      messages.push({ role: "assistant", content: response.answer });
      return response;
    };
    await send("I want to book an appointment with Dr. James Wilson.");
    const displayed = await send("January 20, 2027.");
    assert.deepEqual(displayed.results.map(({ tool }) => tool), ["get_available_slots"]);
    assert.equal(displayed.internalReferences.pending_target_date, date);
    const chosen = await send("that 12:00 PM slot");
    assert.deepEqual(chosen.results.map(({ tool }) => tool), ["prepare_booking_action"]);
    assert.equal(chosen.internalProposalEvidence.action_args.availability_id, slotId);
    assert.equal(chosen.internalProposalEvidence.verified_availability_id, slotId);
    assert.equal(chosen.internalProposalEvidence.requires_patient_confirmation, true);
    assert.deepEqual(calls.map(({ name }) => name), ["search_doctors", "get_available_slots", "get_patient_appointments", "get_available_slots", "prepare_booking_action"]);
    assert.deepEqual(calls[3].args, { doctor_id: doctorId, from: date, to: date, exact_start_time: "12:00" });
    assert.equal(calls.filter(({ name }) => name === "search_doctors").length, 1);
    assert.equal(calls.filter(({ name, args }) => name === "get_available_slots" && args.exact_start_time === "12:00").length, 1);
  });

  it("keeps an explicit 2027 target date, clarifies contradictory or ambiguous times, and offers same-date alternatives", async () => {
    const doctor = { id: doctorId, name: "Dr. James Wilson" };
    const date = "2027-01-20";
    const slot = { id: "77777777-7777-4777-8777-777777777777", availability_id: "77777777-7777-4777-8777-777777777777", doctor_id: doctorId,
      doctor, date, start_time: "12:30:00", end_time: "13:00:00", mode: "wave", capacity: 2, remaining_capacity: 2 };
    const calls = [];
    const engine = createConversationEngine({
      now: () => Date.parse("2026-12-01T00:00:00Z"),
      provider: { generate: async () => { throw new Error("explicit temporal inputs are resolved deterministically"); } },
      toolExecutor: async ({ name, args }) => {
        calls.push({ name, args });
        if (name === "search_doctors") return { doctors: [doctor] };
        if (name === "get_patient_appointments") return { appointments: [], has_more: false };
        if (name === "get_available_slots" && args.exact_start_time) return { slots: [] };
        if (name === "get_available_slots") return { slots: [slot] };
        if (name === "prepare_booking_action") return { proposal: { action_type: "book", action_args: args }, requires_patient_confirmation: true };
        throw new Error(`Unexpected tool ${name}`);
      },
    });
    const start = await engine.respond({ actor: user, messages: [{ role: "user", content: "Book an appointment with Dr. James Wilson." }] });
    const explicitRequest = await engine.respond({ actor: user, previousReferences: start.internalReferences,
      messages: [{ role: "user", content: "Book it on January 20, 2027 at 12:00 PM." }] });
    assert.equal(calls.find(({ name, args }) => name === "get_available_slots" && args.exact_start_time)?.args.from, date);
    assert.match(explicitRequest.answer, /12:00 PM time is not available.*other available times on 2027-01-20/i);
    assert.deepEqual(explicitRequest.results[0].data.slots.map((entry) => entry.start_time), ["12:30:00"]);
    assert.equal(explicitRequest.internalReferences.pending_target_date, date);
    assert.deepEqual(explicitRequest.internalReferences.slots.map((entry) => entry.availability_id || entry.id), [slot.id]);

    const beforeAmbiguous = calls.length;
    const contradictory = await engine.respond({ actor: user, previousReferences: start.internalReferences,
      messages: [{ role: "user", content: "Book it on January 20, 2027 at 12:00 AM PM." }] });
    assert.match(contradictory.answer, /conflicting AM and PM/i);
    assert.equal(calls.length, beforeAmbiguous);
    const ambiguous = await engine.respond({ actor: user, previousReferences: start.internalReferences,
      messages: [{ role: "user", content: "Book it on January 20, 2027 at 12:00." }] });
    assert.match(ambiguous.answer, /12:00 AM or 12:00 PM/i);
    assert.equal(calls.length, beforeAmbiguous);
  });

  it("resolves 'book this' and 'book this for me' against the sole displayed slot without searching again", async () => {
    const date = "2099-08-11";
    const slotId = "88888888-8888-4888-8888-888888888888";
    const doctor = { id: doctorId, name: "Dr. Ada Morgan" };
    for (const phrase of ["book this", "book this for me"]) {
      const calls = [];
      const slot = { id: slotId, availability_id: slotId, doctor_id: doctorId, date, start_time: "14:30:00", end_time: "15:00:00", doctor };
      const engine = createConversationEngine({
        now: () => Date.parse("2099-08-01T00:00:00Z"),
        provider: { generate: async () => { throw new Error("a uniquely displayed slot is deterministic"); } },
        toolExecutor: async ({ name, args }) => {
          calls.push({ name, args });
          if (name === "get_patient_appointments") return { appointments: [], has_more: false };
          if (name === "get_available_slots") return { slots: [slot] };
          if (name === "prepare_booking_action") return { proposal: { action_type: "book", action_args: args }, requires_patient_confirmation: true };
          throw new Error(`Unexpected tool: ${name}`);
        },
      });
      const response = await engine.respond({ actor: user, previousReferences: {
        version: 1, reference_timestamps: { doctors: "2099-08-01T00:00:00.000Z", slots: "2099-08-01T00:00:00.000Z" },
        pending_action: "book", pending_target_date: date, pending_response: "slot_choice",
        appointments: [], slots: [slot], doctors: [doctor], slot_query: { doctor_id: doctorId, from: date, to: date },
      }, messages: [{ role: "user", content: phrase }] });
      assert.deepEqual(calls.map(({ name }) => name), ["get_patient_appointments", "get_available_slots", "prepare_booking_action"]);
      assert.deepEqual(calls[1].args, { doctor_id: doctorId, from: date, to: date, exact_start_time: "14:30" });
      assert.equal(calls[2].args.availability_id, slotId);
      assert.equal(response.results[0].tool, "prepare_booking_action");
      assert.match(response.answer, /booking proposal/i);
      assert.match(response.answer, /no confirmation intent has been created/i);
    }
  });

  it("preserves booking context after a malformed spoken date and resolves a sole displayed slot consistently", async () => {
    const date = "2027-01-15";
    const slotId = "88888888-8888-4888-8888-888888888888";
    const doctor = { id: doctorId, name: "Dr. James Wilson" };
    const slot = { id: slotId, availability_id: slotId, doctor_id: doctorId, date, start_time: "11:30:00", end_time: "12:00:00", doctor, capacity: 2, remaining_capacity: 2 };

    for (const nextTurn of ["book this", "book this for me", "book 15 January 2027"]) {
      const calls = [];
      const engine = createConversationEngine({
        now: () => Date.parse("2026-12-01T12:00:00Z"),
        provider: { generate: async () => { throw new Error("the pending booking workflow must resolve these turns without model fallback"); } },
        toolExecutor: async ({ name, args }) => {
          calls.push({ name, args });
          if (name === "search_doctors") return { doctors: [doctor] };
          if (name === "get_available_slots") return { slots: [slot] };
          if (name === "get_patient_appointments") return { appointments: [], has_more: false, next_offset: 0 };
          if (name === "prepare_booking_action") return { proposal: { action_type: "book", action_args: args }, requires_patient_confirmation: true };
          throw new Error(`Unexpected tool ${name}`);
        },
      });
      const messages = [];
      let references;
      const send = async (content) => {
        messages.push({ role: "user", content });
        const response = await engine.respond({ actor: user, messages, previousReferences: references });
        references = response.internalReferences;
        messages.push({ role: "assistant", content: response.answer });
        return response;
      };

      const foundDoctor = await send("I want to book an appointment with Dr. James Wilson.");
      assert.equal(foundDoctor.internalReferences.doctors[0].id, doctorId);
      assert.equal(foundDoctor.internalReferences.pending_response, "date_time");
      const malformed = await send("January to I need 27");
      assert.match(malformed.answer, /clarify|valid date|month, day, and year/i);
      assert.deepEqual(malformed.results, []);
      assert.equal(malformed.internalReferences.pending_action, "book");
      assert.equal(malformed.internalReferences.pending_response, "date_time");
      assert.equal(malformed.internalReferences.doctors[0].id, doctorId);
      assert.deepEqual(calls.map(({ name }) => name), ["search_doctors"]);

      const displayed = await send("15 January 2027");
      assert.deepEqual(displayed.results.map(({ tool }) => tool), ["get_available_slots"]);
      assert.equal(displayed.internalReferences.pending_target_date, date);
      assert.deepEqual(displayed.internalReferences.slots.map(({ availability_id }) => availability_id), [slotId]);

      const proposal = await send(nextTurn);
      assert.deepEqual(proposal.results.map(({ tool }) => tool), ["prepare_booking_action"]);
      assert.equal(proposal.internalProposalEvidence.action_args.availability_id, slotId);
      assert.equal(proposal.internalProposalEvidence.verified_availability_id, slotId);
      assert.match(proposal.answer, /no confirmation intent has been created/i);
      assert.deepEqual(calls.map(({ name }) => name), [
        "search_doctors", "get_available_slots", "get_patient_appointments", "get_available_slots", "prepare_booking_action",
      ]);
      assert.deepEqual(calls[3].args, { doctor_id: doctorId, from: date, to: date, exact_start_time: "11:30" });
      assert.equal(calls.filter(({ name }) => name === "search_doctors").length, 1);
    }
  });

  it("reports an existing confirmed appointment instead of preparing a duplicate booking", async () => {
    const doctor = { id: doctorId, name: "Dr. Ada Morgan" };
    const appointment = { appointment_id: "77777777-7777-4777-8777-777777777777", date: "2099-08-11", start_time: "14:30:00", status: "confirmed", doctor };
    const calls = [];
    const engine = createConversationEngine({
      provider: { generate: async () => { throw new Error("duplicate booking should be caught before proposal creation"); } },
      toolExecutor: async ({ name, args }) => {
        calls.push({ name, args });
        if (name === "search_doctors") return { doctors: [doctor] };
        if (name === "get_patient_appointments") return { appointments: [appointment], has_more: false };
        throw new Error(`Unexpected tool: ${name}`);
      },
    });
    const response = await engine.respond({ actor: user, messages: [{ role: "user", content: "Book an appointment with Dr. Ada Morgan on 2099-08-11 at 2:30 PM" }] });
    assert.deepEqual(calls.map(({ name }) => name), ["search_doctors", "get_patient_appointments"]);
    assert.match(response.answer, /already have a confirmed appointment.*2099-08-11 at 14:30/i);
    assert.deepEqual(response.results, []);
  });

  it("prepares a selected rescheduling option with the original appointment instead of a booking proposal", async () => {
    const appointmentId = "99999999-9999-4999-8999-999999999999";
    const slotId = "88888888-8888-4888-8888-888888888888";
    const appointment = { id: appointmentId, appointment_id: appointmentId, date: "2099-08-10", start_time: "09:00:00", end_time: "09:30:00", status: "confirmed", doctor: { id: doctorId, name: "Dr. Ada Morgan" } };
    const slot = { id: slotId, availability_id: slotId, doctor_id: doctorId, date: "2099-08-12", start_time: "10:00:00", end_time: "10:30:00", doctor: appointment.doctor };
    const calls = [];
    const engine = createConversationEngine({
      now: () => Date.parse("2026-11-15T00:00:00Z"),
      provider: { generate: async () => { throw new Error("reschedule selection is deterministic"); } },
      toolExecutor: async ({ name, args }) => {
        calls.push({ name, args });
        if (name === "get_available_slots") return { slots: [slot] };
        return { proposal: { action_type: "reschedule", action_args: args }, requires_patient_confirmation: true };
      },
    });
    const response = await engine.respond({
      actor: user,
      previousReferences: {
        version: 1,
        reference_timestamps: { appointments: "2026-11-15T00:00:00.000Z", slots: "2026-11-15T00:00:00.000Z" },
        appointments: [appointment], slots: [slot], doctors: [], slot_query: { doctor_id: doctorId },
        pending_action: "reschedule", pending_appointment_id: appointmentId,
      },
      messages: [{ role: "user", content: "Reschedule my appointment and show me options" }, { role: "assistant", content: "Here are rescheduling options." }, { role: "user", content: "Reschedule my appointment to slot 1" }],
    });
    assert.deepEqual(calls, [
      { name: "get_available_slots", args: { doctor_id: doctorId, from: "2099-08-12", to: "2099-08-12", exact_start_time: "10:00" } },
      { name: "prepare_reschedule_action", args: { appointment_id: appointmentId, availability_id: slotId } },
    ]);
    assert.equal(response.results.at(-1).tool, "prepare_reschedule_action");
    assert.match(response.answer, /rescheduling proposal/i);
  });

  it("finds the owned source appointment from its doctor and date, then offers target-date reschedule slots", async () => {
    const appointmentId = "77777777-7777-4777-8777-777777777777";
    const slotId = "88888888-8888-4888-8888-888888888888";
    const sourceDate = "2099-08-10";
    const targetDate = "2099-08-12";
    const doctor = { id: doctorId, name: "Dr. Ada Morgan", specialty: "Cardiology" };
    const appointment = { id: appointmentId, appointment_id: appointmentId, date: sourceDate, start_time: "09:00:00", end_time: "09:30:00", status: "confirmed", mode: "stream", doctor };
    const calls = [];
    const engine = createConversationEngine({
      now: () => Date.parse("2026-11-15T00:00:00Z"),
      provider: { generate: async () => { throw new Error("reschedule targeting should be deterministic"); } },
      toolExecutor: async ({ name, args }) => {
        calls.push({ name, args });
        if (name === "get_patient_appointments") return { appointments: [appointment], has_more: false };
        if (name === "get_available_slots") return { slots: [{ id: slotId, availability_id: slotId, doctor_id: doctorId, date: targetDate, start_time: "10:00:00", end_time: "10:30:00", doctor }] };
        return { proposal: { action_type: "reschedule", action_args: args }, requires_patient_confirmation: true };
      },
    });
    const first = await engine.respond({ actor: user, messages: [{ role: "user", content: `Reschedule my appointment with Dr. Ada Morgan on ${sourceDate} at 9:00 AM to ${targetDate}` }] });
    assert.deepEqual(calls.map(({ name }) => name), ["get_patient_appointments", "get_available_slots"]);
    assert.deepEqual(calls[0].args, { view: "upcoming", scope: "all", from: sourceDate, to: sourceDate });
    assert.deepEqual(calls[1].args, { doctor_id: doctorId, from: targetDate, to: targetDate, mode: "stream" });
    assert.equal(first.internalReferences.pending_action, "reschedule");
    assert.equal(first.internalReferences.pending_appointment_id, appointmentId);
    const selected = await engine.respond({
      actor: user, previousReferences: first.internalReferences,
      messages: [{ role: "user", content: `Reschedule my appointment with Dr. Ada Morgan on ${sourceDate} at 9:00 AM to ${targetDate}` }, { role: "assistant", content: first.answer }, { role: "user", content: "Reschedule my appointment to slot 1" }],
    });
    assert.deepEqual(calls.at(-1), { name: "prepare_reschedule_action", args: { appointment_id: appointmentId, availability_id: slotId } });
    assert.equal(selected.results[0].tool, "prepare_reschedule_action");
  });

  it("cancels a unique doctor-and-date match without requiring a start time", async () => {
    const appointmentId = "77777777-7777-4777-8777-777777777777";
    const date = "2099-08-10";
    const appointment = { id: appointmentId, appointment_id: appointmentId, date, start_time: "09:00:00", end_time: "09:30:00", status: "confirmed", doctor: { id: doctorId, name: "Dr. Ada Morgan" } };
    const calls = [];
    const engine = createConversationEngine({
      now: () => Date.parse("2026-11-15T00:00:00Z"),
      provider: { generate: async () => { throw new Error("doctor and date cancellation should be deterministic"); } },
      toolExecutor: async ({ name, args }) => { calls.push({ name, args }); return name === "get_patient_appointments" ? { appointments: [appointment], has_more: false } : { proposal: { action_type: "cancel", action_args: args }, requires_patient_confirmation: true }; },
    });
    const response = await engine.respond({ actor: user, messages: [{ role: "user", content: `Cancel my appointment with Dr. Ada Morgan on ${date}` }] });
    assert.deepEqual(calls.map(({ name }) => name), ["get_patient_appointments", "prepare_cancellation_action"]);
    assert.deepEqual(calls[0].args, { view: "upcoming", scope: "all", from: date, to: date });
    assert.deepEqual(calls[1].args, { appointment_id: appointmentId });
    assert.equal(response.results[0].tool, "prepare_cancellation_action");
  });

  it("reports a no-match cancellation when the supplied doctor, date, and time do not identify an appointment", async () => {
    const date = "2099-08-10";
    const calls = [];
    const engine = createConversationEngine({
      now: () => Date.parse("2026-11-15T00:00:00Z"),
      provider: { generate: async () => { throw new Error("fully specified cancellation lookup should be deterministic"); } },
      toolExecutor: async ({ name, args }) => {
        calls.push({ name, args });
        return name === "get_patient_appointments" ? { appointments: [
          { id: "77777777-7777-4777-8777-777777777777", date, start_time: "10:00:00", status: "confirmed", doctor: { id: doctorId, name: "Dr. Ada Morgan" } },
          { id: "88888888-8888-4888-8888-888888888888", date, start_time: "09:00:00", status: "confirmed", doctor: { id: "66666666-6666-4666-8666-666666666666", name: "Dr. Bea Stone" } },
        ], has_more: false } : { proposal: { action_type: "cancel", action_args: args }, requires_patient_confirmation: true };
      },
    });
    const result = await engine.respond({ actor: user, messages: [{ role: "user", content: `Cancel my appointment with Dr. Ada Morgan on ${date} at 9:00 AM` }] });
    assert.deepEqual(calls.map(({ name }) => name), ["get_patient_appointments"]);
    assert.match(result.answer, /couldn't find a confirmed appointment matching Dr\. Ada Morgan on 2099-08-10 at 09:00/i);
    assert.deepEqual(result.results, []);
  });

  it("lists only confirmed appointments with the named doctor when rescheduling lacks source date and time", async () => {
    const adaAppointment = { id: "77777777-7777-4777-8777-777777777777", date: "2099-08-10", start_time: "09:00:00", status: "confirmed", doctor: { id: doctorId, name: "Dr. Ada Morgan" } };
    const calls = [];
    const engine = createConversationEngine({
      provider: { generate: async () => { throw new Error("doctor-scoped source appointments should be listed deterministically"); } },
      toolExecutor: async ({ name, args }) => {
        calls.push({ name, args });
        return { appointments: [adaAppointment,
          { id: "88888888-8888-4888-8888-888888888888", date: "2099-08-11", start_time: "10:00:00", status: "confirmed", doctor: { id: "66666666-6666-4666-8666-666666666666", name: "Dr. Bea Stone" } },
          { id: "99999999-9999-4999-8999-999999999999", date: "2099-08-12", start_time: "11:00:00", status: "cancelled", doctor: { id: doctorId, name: "Dr. Ada Morgan" } },
        ], has_more: false };
      },
    });
    const result = await engine.respond({ actor: user, messages: [{ role: "user", content: "Reschedule my appointment with Dr. Ada Morgan" }] });
    assert.deepEqual(calls, [{ name: "get_patient_appointments", args: { view: "upcoming", scope: "all" } }]);
    assert.match(result.answer, /1 confirmed upcoming appointment with Dr\. Ada Morgan/i);
    assert.equal(result.results[0].data.appointments.length, 1);
    assert.equal(result.results[0].data.appointments[0].date, adaAppointment.date);
  });

  it("returns only fresh doctor-matched rescheduling choices when a target date is supplied", async () => {
    const james = { id: "77777777-7777-4777-8777-777777777777", date: "2027-01-10", start_time: "09:00:00", status: "confirmed", doctor: { id: doctorId, name: "Dr. James Wilson" } };
    const ali = { id: "88888888-8888-4888-8888-888888888888", date: "2027-01-12", start_time: "10:00:00", status: "confirmed", doctor: { id: "66666666-6666-4666-8666-666666666666", name: "Dr. Ali Ahmed" } };
    const cancelledJames = { id: "99999999-9999-4999-8999-999999999999", date: "2027-01-13", start_time: "11:00:00", status: "cancelled", doctor: james.doctor };
    const calls = [];
    const engine = createConversationEngine({
      now: () => Date.parse("2026-11-15T00:00:00Z"),
      provider: { generate: async () => { throw new Error("doctor-scoped reschedule lookup should be deterministic"); } },
      toolExecutor: async ({ name, args }) => { calls.push({ name, args }); return { appointments: [james, ali, cancelledJames], has_more: false }; },
    });
    const response = await engine.respond({
      actor: user,
      previousReferences: { version: 1, appointments: [ali], reference_timestamps: { appointments: "2026-11-15T00:00:00.000Z" } },
      messages: [{ role: "user", content: "Reschedule my appointment with Dr. James Wilson to January 24, 2027." }],
    });
    assert.deepEqual(calls, [{ name: "get_patient_appointments", args: { view: "upcoming", scope: "all" } }]);
    assert.match(response.answer, /confirmed upcoming appointment.*Dr\. James Wilson.*2027-01-24/i);
    assert.equal(response.results[0].tool, "get_patient_appointments");
    assert.deepEqual(response.results[0].data.appointments.map(({ date, status, doctor }) => ({ date, status, doctor: doctor.name })), [{ date: james.date, status: james.status, doctor: "Dr. James Wilson" }]);
    assert.equal(response.results[0].ui_actions.length, 1);
    assert.deepEqual(response.internalReferences.appointments.map(({ id }) => id), [james.id]);
    assert.equal(response.internalReferences.pending_target_date, "2027-01-24");
  });

  it("resolves an abbreviated doctor name and checks exact booking availability before offering alternatives", async () => {
    const doctor = { id: doctorId, name: "Dr. James Wilson", specialty: "Cardiology" };
    const alternative = { id: "88888888-8888-4888-8888-888888888888", availability_id: "88888888-8888-4888-8888-888888888888", doctor_id: doctorId, date: "2099-08-10", start_time: "10:00:00", end_time: "10:30:00", doctor };
    const calls = [];
    const engine = createConversationEngine({
      now: () => Date.parse("2026-11-15T00:00:00Z"),
      provider: { generate: async () => { throw new Error("abbreviated named booking should be deterministic"); } },
      toolExecutor: async ({ name, args }) => {
        calls.push({ name, args });
        if (name === "search_doctors") return { doctors: [doctor] };
        if (name === "get_available_slots") return args.exact_start_time ? { slots: [] } : { slots: [alternative] };
        if (name === "get_patient_appointments") return { appointments: [], has_more: false };
        throw new Error(`Unexpected tool: ${name}`);
      },
    });
    const result = await engine.respond({ actor: user, messages: [{ role: "user", content: "Book an appointment with dr.james on 10 August 2099 at 9:00 AM" }] });
    assert.deepEqual(calls.map(({ name }) => name), ["search_doctors", "get_patient_appointments", "get_available_slots", "get_available_slots"]);
    assert.deepEqual(calls[0].args, { name: "james" });
    assert.equal(calls[2].args.exact_start_time, "09:00");
    assert.match(result.answer, /requested 9:00 AM time is not available.*other available times/i);
    assert.equal(result.results[0].data.slots[0].start_time, alternative.start_time);
  });

  it("returns same-date alternatives only after explicitly reporting the requested exact time unavailable", async () => {
    const date = "2027-01-15";
    const doctor = { id: doctorId, name: "Dr. James Wilson" };
    const alternative = { id: "88888888-8888-4888-8888-888888888888", availability_id: "88888888-8888-4888-8888-888888888888", doctor_id: doctorId, date, start_time: "11:30:00", end_time: "12:00:00", doctor };
    const engine = createConversationEngine({
      now: () => Date.parse("2026-11-15T00:00:00Z"),
      provider: { generate: async () => { throw new Error("exact named booking should be deterministic"); } },
      toolExecutor: async ({ name, args }) => {
        if (name === "search_doctors") return { doctors: [doctor] };
        if (name === "get_patient_appointments") return { appointments: [], has_more: false };
        if (name === "get_available_slots") return args.exact_start_time ? { slots: [] } : { slots: [alternative] };
        throw new Error(`Unexpected tool: ${name}`);
      },
    });
    const response = await engine.respond({ actor: user, messages: [{ role: "user", content: "Book an appointment with Dr. James Wilson on January 15, 2027 at 9:00 AM." }] });
    assert.match(response.answer, /9:00 AM|09:00/);
    assert.match(response.answer, /requested 9:00 AM time is not available/i);
    assert.match(response.answer, /other available times on 2027-01-15/i);
    assert.equal(response.results[0].tool, "get_available_slots");
    assert.deepEqual(response.results[0].data.slots.map(({ start_time }) => start_time), ["11:30:00"]);
  });

  it("treats explicit cancellation rejection as dismissal without running tools", async () => {
    for (const content of ["Don't cancel it", "I changed my mind", "Never mind, keep the appointment"]) {
      const engine = createConversationEngine({
        provider: { generate: async () => { throw new Error("a rejection must not call the model"); } },
        toolExecutor: async () => { throw new Error("a rejection must not execute tools"); },
      });
      const result = await engine.respond({
        actor: user,
        previousProposal: { assistant_message_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", action_type: "cancel" },
        messages: [{ role: "user", content }],
      });
      assert.match(result.answer, /dismissed the cancellation proposal/i);
      assert.deepEqual(result.dismissProposal, { assistant_message_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", action_type: "cancel" });
      assert.deepEqual(result.results, []);
    }
  });

  it("returns matching cancellation appointments for selection and prepares only the selected one", async () => {
    const date = "2099-08-10";
    const appointments = ["77777777-7777-4777-8777-777777777777", "99999999-9999-4999-8999-999999999999"].map((id, index) => ({ id, appointment_id: id, date, start_time: `${String(9 + index).padStart(2, "0")}:00:00`, end_time: `${String(9 + index).padStart(2, "0")}:30:00`, status: "confirmed", doctor: { id: doctorId, name: "Dr. Ada Morgan" } }));
    const calls = [];
    const engine = createConversationEngine({
      now: () => Date.parse("2026-11-15T00:00:00Z"),
      provider: { generate: async () => { throw new Error("ambiguous cancellation should stay in the action flow"); } },
      toolExecutor: async ({ name, args }) => { calls.push({ name, args }); return name === "get_patient_appointments" ? { appointments, has_more: false } : { proposal: { action_type: "cancel", action_args: args }, requires_patient_confirmation: true }; },
    });
    const first = await engine.respond({ actor: user, messages: [{ role: "user", content: `Cancel my appointment with Dr. Ada Morgan on ${date}` }] });
    assert.match(first.answer, /choose the appointment/i);
    assert.equal(first.results[0].tool, "get_patient_appointments");
    assert.equal(first.internalReferences.appointments.length, 2);
    const selected = await engine.respond({ actor: user, previousReferences: first.internalReferences, previousActionContext: first.internalActionContext, messages: [{ role: "user", content: `Cancel my appointment with Dr. Ada Morgan on ${date}` }, { role: "assistant", content: first.answer }, { role: "user", content: "Cancel the second appointment" }] });
    assert.deepEqual(calls.at(-1), { name: "prepare_cancellation_action", args: { appointment_id: appointments[1].id } });
    assert.equal(selected.results[0].tool, "prepare_cancellation_action");
  });

  it("answers latest from the displayed cancellation list and keeps number 10 bound to that exact appointment", async () => {
    const appointments = Array.from({ length: 10 }, (_, index) => {
      const id = `77777777-7777-4777-8777-${String(index + 1).padStart(12, "0")}`;
      const day = String(index + 1).padStart(2, "0");
      return { id, appointment_id: id, date: `2099-08-${day}`, start_time: "09:00:00", end_time: "09:30:00", status: "confirmed", doctor: { id: doctorId, name: "Dr. Ada Morgan" } };
    });
    const calls = [];
    const engine = createConversationEngine({
      now: () => Date.parse("2026-11-15T00:00:00Z"),
      provider: { generate: async () => ({ text: "I can help with that.", toolCalls: [] }) },
      toolExecutor: async ({ name, args }) => {
        calls.push({ name, args });
        return name === "get_patient_appointments" ? { appointments, has_more: false }
          : { proposal: { action_type: "cancel", action_args: args }, requires_patient_confirmation: true };
      },
    });
    const first = await engine.respond({ actor: user, messages: [{ role: "user", content: "Show my upcoming appointments" }] });
    assert.equal(first.results[0].tool, "get_patient_appointments");
    assert.deepEqual(first.internalReferences.cancellation_choices.map(({ appointment_id }) => appointment_id), appointments.map(({ id }) => id));

    const latest = await engine.respond({ actor: user, previousReferences: first.internalReferences, messages: [
      { role: "user", content: "Show my upcoming appointments" },
      { role: "assistant", content: first.answer },
      { role: "user", content: "Which appointment is the latest?" },
    ] });
    assert.match(latest.answer, /number 10: Dr\. Ada Morgan on 2099-08-10/);
    assert.equal(latest.results.length, 0);
    assert.deepEqual(latest.internalReferences.cancellation_choices.map(({ appointment_id }) => appointment_id), appointments.map(({ id }) => id));

    const unrelated = await engine.respond({ actor: user, previousReferences: latest.internalReferences, messages: [
      { role: "user", content: "Which appointment is the latest?" },
      { role: "assistant", content: latest.answer },
      { role: "user", content: "Thanks" },
    ] });
    assert.deepEqual(unrelated.internalReferences.cancellation_choices.map(({ appointment_id }) => appointment_id), appointments.map(({ id }) => id));

    const selected = await engine.respond({ actor: user, previousReferences: unrelated.internalReferences, messages: [
      { role: "user", content: "Which appointment is the latest?" },
      { role: "assistant", content: latest.answer },
      { role: "user", content: "Thanks" },
      { role: "assistant", content: unrelated.answer },
      { role: "user", content: "Cancel appointment number 10" },
    ] });
    assert.deepEqual(calls.at(-1), { name: "prepare_cancellation_action", args: { appointment_id: appointments[9].id } });
    assert.equal(selected.results[0].tool, "prepare_cancellation_action");
  });

  it("retains numbered cancellation choices across turns and refreshes expired choices before selection", async () => {
    const date = "2099-08-10";
    const appointments = ["77777777-7777-4777-8777-777777777777", "99999999-9999-4999-8999-999999999999"].map((id, index) => ({ id, appointment_id: id, date, start_time: `${String(9 + index).padStart(2, "0")}:00:00`, end_time: `${String(9 + index).padStart(2, "0")}:30:00`, status: "confirmed", doctor: { id: doctorId, name: "Dr. Ada Morgan" } }));
    const fixedNow = Date.parse("2026-11-15T00:00:00Z");
    const calls = [];
    const engine = createConversationEngine({
      now: () => fixedNow,
      provider: { generate: async () => ({ text: "No problem.", toolCalls: [] }) },
      toolExecutor: async ({ name, args }) => {
        calls.push({ name, args });
        return name === "get_patient_appointments" ? { appointments, has_more: false }
          : { proposal: { action_type: "cancel", action_args: args }, requires_patient_confirmation: true };
      },
    });
    const expiredReferences = {
      version: 1, pending_action: "cancel", reference_timestamps: { appointments: "2026-11-14T23:50:00.000Z" },
      appointments, slots: [], doctors: [],
    };
    const clarification = await engine.respond({ actor: user, previousReferences: expiredReferences, messages: [{ role: "user", content: "Thanks" }] });
    assert.equal(clarification.internalReferences.pending_action, "cancel");
    assert.deepEqual(clarification.internalReferences.appointments.map(({ appointment_id }) => appointment_id), appointments.map(({ id }) => id));
    const expiredSelection = await engine.respond({ actor: user, previousReferences: clarification.internalReferences, messages: [{ role: "user", content: "2" }] });
    assert.match(expiredSelection.answer, /choice expired.*refreshed/i);
    assert.equal(expiredSelection.results[0].tool, "get_patient_appointments");
    assert.equal(expiredSelection.internalReferences.pending_action, "cancel");
    assert.deepEqual(calls.map(({ name }) => name), ["get_patient_appointments"]);
    const selected = await engine.respond({ actor: user, previousReferences: expiredSelection.internalReferences, messages: [{ role: "user", content: "Cancel appointment number 2" }] });
    assert.deepEqual(calls.at(-1), { name: "prepare_cancellation_action", args: { appointment_id: appointments[1].id } });
    assert.equal(selected.results[0].tool, "prepare_cancellation_action");
  });

  it("refreshes and redisplays appointments when a numbered cancellation arrives without saved choices", async () => {
    const appointments = ["77777777-7777-4777-8777-777777777777", "99999999-9999-4999-8999-999999999999"].map((id, index) => ({ id, appointment_id: id, date: "2099-08-10", start_time: `${String(9 + index).padStart(2, "0")}:00:00`, status: "confirmed", doctor: { id: doctorId, name: "Dr. Ada Morgan" } }));
    const calls = [];
    const engine = createConversationEngine({
      provider: { generate: async () => ({ text: "Choose an appointment.", toolCalls: [] }) },
      toolExecutor: async ({ name, args }) => {
        calls.push({ name, args });
        return name === "get_patient_appointments" ? { appointments, has_more: false }
          : { proposal: { action_type: "cancel", action_args: args }, requires_patient_confirmation: true };
      },
    });
    const refreshed = await engine.respond({ actor: user, messages: [{ role: "user", content: "Cancel appointment number 10" }] });
    assert.match(refreshed.answer, /refreshed.*choose again/i);
    assert.equal(refreshed.results[0].tool, "get_patient_appointments");
    assert.equal(refreshed.internalReferences.pending_action, "cancel");
    assert.deepEqual(refreshed.internalReferences.cancellation_choices.map(({ appointment_id }) => appointment_id), appointments.map(({ id }) => id));
    assert.deepEqual(calls.map(({ name }) => name), ["get_patient_appointments"]);
  });

  it("uses the verified patient user for appointment lookup and projects minimal fields", async () => {
    let queryValues;
    const sensitiveRow = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", date: "2099-08-10", start_time: "10:00:00", end_time: "10:30:00", status: "confirmed", doctor_id: doctorId, doctor_first_name: "Dee", doctor_last_name: "Doctor", specialty: "Cardiology", patient_id: "sensitive", reason: "private reason", patient_email: "private@example.test", consultation_fee: "500" };
    const output = await executeTool({ name: "get_patient_appointments", args: { view: "upcoming", scope: "all" }, actor: user, applicationTimezone: "Asia/Kolkata", database: { query: async (_sql, values) => { queryValues = values; return { rows: [sensitiveRow] }; } } });
    assert.equal(queryValues[0], userId);
    assert.deepEqual(queryValues.slice(-2), [21, 0]);
    assert.deepEqual(output.appointments[0], { id: sensitiveRow.id, appointment_id: sensitiveRow.id, date: "2099-08-10", start_time: "10:00:00", end_time: "10:30:00", status: "confirmed", doctor: { id: doctorId, name: "Dr. Dee Doctor", specialty: "Cardiology" } });
    assert.equal(JSON.stringify(output).includes("private reason"), false);
    assert.equal(JSON.stringify(output).includes("private@example.test"), false);
    assert.deepEqual(safeAppointment(sensitiveRow), output.appointments[0]);
    assert.deepEqual(patientUiActions("get_patient_appointments", output), [{ type: "appointment", appointment_id: sensitiveRow.id }]);
    assert.doesNotMatch(JSON.stringify(publicToolResult(output)), /appointment_id|doctor_id|patient_id|"id"/);
    assert.doesNotMatch(JSON.stringify(publicToolResult({ slots: [{ id: "slot-id", availability_id: "slot-id", doctor_id: doctorId, doctor: { id: doctorId } }] })), /availability_id|doctor_id|"id"/);
    assert.deepEqual(patientUiActions("get_available_slots", { slots: [{ id: "slot-id", doctor_id: doctorId }] }), [{ type: "slot", availability_id: "slot-id", doctor_id: doctorId }]);
    assert.deepEqual(patientUiActions("search_doctors", { doctors: [{ id: doctorId }] }), [{ type: "doctor", doctor_id: doctorId }]);
  });

  it("executes doctor-specific availability searches and preserves doctor context for a date-only follow-up", async () => {
    const doctor = { id: doctorId, name: "Dr. Ada Morgan", specialty: "Cardiology" };
    const availabilityId = "33333333-3333-4333-8333-333333333333";
    const calls = [];
    const engine = createConversationEngine({
      now: () => Date.parse("2026-12-20T08:00:00.000Z"),
      provider: { generate: async () => { throw new Error("Availability flow should resolve deterministically"); } },
      toolExecutor: async ({ name, args }) => {
        calls.push({ name, args });
        if (name === "search_doctors") return { doctors: [doctor] };
        return { slots: [{ id: availabilityId, availability_id: availabilityId, doctor_id: doctorId, date: "2027-01-13", start_time: "10:00", end_time: "10:30", doctor }] };
      },
    });
    const first = await engine.respond({ actor: user, messages: [{ role: "user", content: "Show availability for Dr. Ada Morgan on 13 January" }] });
    assert.deepEqual(calls.map(({ name }) => name), ["search_doctors", "get_available_slots"]);
    assert.equal(calls[1].args.from, "2027-01-13");
    assert.deepEqual(first.results.map(({ tool }) => tool), ["search_doctors", "get_available_slots"]);
    assert.deepEqual(first.results[1].ui_actions, [{ type: "slot", availability_id: availabilityId, doctor_id: doctorId }]);
    assert.doesNotMatch(JSON.stringify(first.results.map(({ data }) => data)), /availability_id|doctor_id|"id"/);

    calls.length = 0;
    const followup = await engine.respond({
      actor: user,
      messages: [{ role: "user", content: "13 January" }],
      previousReferences: { version: 1, captured_at: "2026-12-20T08:00:00.000Z", reference_timestamps: { doctors: "2026-12-20T08:00:00.000Z" }, doctors: [doctor], appointments: [], slots: [] },
    });
    assert.deepEqual(calls.map(({ name }) => name), ["get_available_slots"]);
    assert.equal(calls[0].args.from, "2027-01-13");
    assert.equal(followup.results[0].tool, "get_available_slots");
  });

  it("uses Asia/Kolkata calendar boundaries and returns only matching next-days appointments", async () => {
    const now = new Date("2026-11-12T06:00:00.000Z"); // 11:30 on 12 November in India.
    assert.deepEqual(nextDaysRange(3, "Asia/Kolkata", now), { from: "2026-11-13", to: "2026-11-15" });
    let querySql;
    let queryValues;
    const rows = ["2026-11-12", "2026-11-13", "2026-11-14", "2026-11-15", "2026-11-16"].map((date) => ({
      date, start_time: "10:00:00", end_time: "10:30:00", status: "confirmed", doctor_id: doctorId,
      doctor_first_name: "Dee", doctor_last_name: "Doctor", specialty: "Cardiology",
    }));
    const result = await executeTool({
      name: "get_patient_appointments", args: { view: "upcoming", scope: "next_days", days_ahead: 3 },
      actor: user, applicationTimezone: "Asia/Kolkata", now,
      database: { query: async (sql, values) => { querySql = sql; queryValues = values; return { rows }; } },
    });
    assert.match(querySql, /a\.scheduled_date >= \$3::date/);
    assert.match(querySql, /a\.scheduled_date <= \$4::date/);
    assert.match(querySql, /a\.scheduled_start_time\) AT TIME ZONE \$2\) > NOW\(\)/);
    assert.deepEqual(queryValues, [userId, "Asia/Kolkata", "2026-11-13", "2026-11-15", 21, 0]);
    assert.deepEqual(result.appointments.map(({ date }) => date), ["2026-11-13", "2026-11-14", "2026-11-15"]);
  });

  it("returns empty next-days results when no appointment is inside the requested range", async () => {
    const result = await executeTool({
      name: "get_patient_appointments", args: { view: "upcoming", scope: "next_days", days_ahead: 2 },
      actor: user, applicationTimezone: "Asia/Kolkata", now: new Date("2099-08-10T00:00:00.000Z"),
      database: { query: async () => ({ rows: [{ date: "2099-08-13", start_time: "09:00:00", end_time: "09:30:00", status: "confirmed", doctor_id: doctorId, doctor_first_name: "Dee", doctor_last_name: "Doctor", specialty: "Cardiology" }] }) },
    });
    assert.deepEqual(result, { appointments: [], has_more: false, next_offset: 1 });
  });

  it("returns only the nearest booked appointment for nearest scope", async () => {
    let querySql;
    const rows = ["2099-08-10", "2099-08-11", "2099-08-12"].map((date) => ({
      date, start_time: "10:00:00", end_time: "10:30:00", status: "confirmed", doctor_id: doctorId,
      doctor_first_name: "Dee", doctor_last_name: "Doctor", specialty: "Cardiology",
    }));
    const result = await executeTool({
      name: "get_patient_appointments", args: { view: "upcoming", scope: "nearest" }, actor: user,
      applicationTimezone: "Asia/Kolkata", database: { query: async (sql) => { querySql = sql; return { rows }; } },
    });
    assert.match(querySql, /ORDER BY a\.scheduled_date, a\.scheduled_start_time, a\.id\s+LIMIT \$3 OFFSET \$4/);
    assert.match(querySql, /a\.scheduled_start_time\) AT TIME ZONE \$2\) > NOW\(\)/);
    assert.doesNotMatch(querySql, /a\.scheduled_end_time\) AT TIME ZONE \$2\) > NOW\(\)/);
    assert.equal(result.appointments.length, 1);
    assert.equal(result.appointments[0].date, "2099-08-10");
  });

  it("queries only the furthest upcoming appointment for latest-upcoming scope", async () => {
    let querySql;
    const rows = ["2099-08-10", "2099-08-11", "2099-08-12"].map((date) => ({
      date, start_time: "10:00:00", end_time: "10:30:00", status: "confirmed", doctor_id: doctorId,
      doctor_first_name: "Dee", doctor_last_name: "Doctor", specialty: "Cardiology",
    }));
    const result = await executeTool({
      name: "get_patient_appointments", args: { view: "upcoming", scope: "furthest" }, actor: user,
      applicationTimezone: "Asia/Kolkata", database: { query: async (sql) => { querySql = sql; return { rows: [...rows].reverse() }; } },
    });
    assert.match(querySql, /ORDER BY a\.scheduled_date DESC, a\.scheduled_start_time DESC, a\.id DESC\s+LIMIT \$3 OFFSET \$4/);
    assert.equal(result.appointments.length, 1);
    assert.equal(result.appointments[0].date, "2099-08-12");
  });

  it("expands cancellation appointment lookup to upcoming owned appointments and preserves matching fields", async () => {
    const appointmentId = "99999999-9999-4999-8999-999999999999";
    let querySql;
    let queryValues;
    const output = await executeTool({
      name: "get_patient_appointments", args: { view: "upcoming", scope: "nearest" }, actor: user,
      appointmentScopeOverride: "all", applicationTimezone: "Asia/Kolkata",
      database: { query: async (sql, values) => {
        querySql = sql; queryValues = values;
        return { rows: [{ id: appointmentId, date: "2027-01-20", start_time: "11:00:00", end_time: "11:30:00", status: "confirmed", mode: "wave", doctor_id: doctorId, doctor_first_name: "James", doctor_last_name: "Wilson", specialty: "Cardiology" }] };
      } },
    });
    assert.match(querySql, /p\.user_id = \$1/);
    assert.equal(queryValues[0], userId);
    assert.equal(queryValues.at(-2), 21);
    assert.deepEqual(output.appointments[0], { id: appointmentId, appointment_id: appointmentId, date: "2027-01-20", start_time: "11:00:00", end_time: "11:30:00", status: "confirmed", mode: "wave", doctor: { id: doctorId, name: "Dr. James Wilson", specialty: "Cardiology" } });
  });

  it("rejects incompatible appointment scopes", async () => {
    await assert.rejects(executeTool({ name: "get_patient_appointments", args: { view: "past", scope: "nearest" }, actor: user, database: { query: async () => ({ rows: [] }) } }), { code: "INVALID_TOOL_ARGUMENTS" });
    await assert.rejects(executeTool({ name: "get_patient_appointments", args: { view: "upcoming", scope: "next_days", days_ahead: 32 }, actor: user, database: { query: async () => ({ rows: [] }) } }), { code: "INVALID_TOOL_ARGUMENTS" });
  });

  it("rejects malformed slot arguments and dates beyond 31 days", async () => {
    await assert.rejects(executeTool({ name: "get_available_slots", args: { doctor_id: doctorId, from: "2099-01-01", to: "2099-02-05" }, actor: user, database: { query: async () => ({ rows: [] }) } }), { code: "INVALID_TOOL_ARGUMENTS" });
  });

  it("routes next available intent to real future slots rather than booked appointments", async () => {
    const policy = getPolicyForActor(user);
    const availabilityTool = getToolsForActor(user).find(({ name }) => name === "get_available_slots");
    assert.match(policy, /For other availability questions, use get_available_slots, never get_patient_appointments/);
    assert.match(policy, /keep the accompanying response short and contextual/);
    assert.match(availabilityTool.description, /actual bookable availability slots/);
    assert.equal(availabilityTool.schema.safeParse({}).success, true);
    assert.equal(availabilityTool.schema.safeParse({ doctor_id: doctorId }).success, true);
    assert.equal(availabilityTool.schema.safeParse({ specialty: "cardio" }).success, true);
    assert.equal(availabilityTool.schema.safeParse({ specialty: "cardio", from: "2099-08-10", to: "2099-08-10" }).success, true);
    assert.equal(availabilityTool.schema.safeParse({ doctor_id: doctorId, from: "2099-08-10" }).success, false);
    assert.equal(availabilityTool.schema.safeParse({ doctor_id: doctorId, from: "2099-08-10", to: "2099-08-10" }).success, true);
  });

  it("projects directory and availability records before they reach the model", async () => {
    const doctor = { id: doctorId, first_name: "Dee", last_name: "Doctor", specialty: "General Practice", bio: "unnecessary biography", consultation_fee: 500, appointment_duration_minutes: 30, created_at: "internal", updated_at: "internal" };
    let doctorSql;
    let doctorValues;
    const directory = await executeTool({ name: "search_doctors", args: { specialty: "General Practice" }, actor: user, database: { query: async (sql, values) => { doctorSql = sql; doctorValues = values; return { rows: [doctor] }; } } });
    assert.deepEqual(directory.doctors[0], { id: doctorId, name: "Dr. Dee Doctor", specialty: "General Practice", consultation_fee: 500, appointment_duration_minutes: 30 });
    assert.match(doctorSql, /LIMIT \$2/);
    assert.match(doctorSql, /d\.specialty ILIKE/);
    assert.deepEqual(doctorValues, ["General Practice", 10]);
    assert.equal(JSON.stringify(directory).includes("unnecessary biography"), false);

    const slot = { id: "33333333-3333-4333-8333-333333333333", doctor_id: doctorId, doctor_first_name: "Dee", doctor_last_name: "Doctor", specialty: "General Practice", consultation_fee: 500, mode: "wave", capacity: 4, schedule_id: "44444444-4444-4444-8444-444444444444", date: "2099-08-10", start_time: "10:00:00", end_time: "10:30:00", remaining_capacity: 2, hold_status: "active", hold_expires_at: "internal", preserved_reservation_count: 8 };
    let slotsSql;
    let slotsValues;
    const slots = await executeTool({ name: "get_available_slots", args: { doctor_id: doctorId, from: "2099-08-10", to: "2099-08-10" }, actor: user, applicationTimezone: "UTC", database: { query: async (sql, values) => { if (sql.includes("ORDER BY date, start_time")) { slotsSql = sql; slotsValues = values; } return { rows: [slot] }; } } });
    assert.deepEqual(slots.slots[0], { id: slot.id, availability_id: slot.id, date: "2099-08-10", start_time: "10:00:00", end_time: "10:30:00", doctor_id: doctorId, doctor: { id: doctorId, name: "Dr. Dee Doctor" }, specialty: "General Practice", consultation_fee: 500, mode: "wave", capacity: 4, remaining_capacity: 2 });
    assert.match(slotsSql, /ORDER BY date, start_time\s+LIMIT \$10/);
    assert.equal(slotsValues.at(-1), 5);
    assert.equal(JSON.stringify(slots).includes("internal"), false);

    let exactValues;
    const exactSlots = await executeTool({
      name: "get_available_slots",
      args: { doctor_id: doctorId, from: "2099-08-10", to: "2099-08-10", exact_start_time: "10:00" },
      actor: user,
      applicationTimezone: "UTC",
      database: { query: async (sql, values) => {
        if (sql.includes("ORDER BY date, start_time")) exactValues = values;
        return { rows: [slot, { ...slot, id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }, { ...slot, id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", start_time: "10:30:00" }] };
      } },
    });
    assert.equal(exactValues.at(-1), 100);
    assert.deepEqual(exactSlots.slots.map(({ availability_id }) => availability_id), [slot.id, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"]);

    let globalAvailabilitySql;
    let globalAvailabilityValues;
    const nextAvailable = await executeTool({ name: "get_available_slots", args: {}, actor: user, applicationTimezone: "UTC", database: { query: async (sql, values) => { if (sql.includes("ORDER BY date, start_time")) { globalAvailabilitySql = sql; globalAvailabilityValues = values; } return { rows: [slot, { ...slot, date: "2099-08-11" }] }; } } });
    assert.match(globalAvailabilitySql, /WHERE \$1::uuid IS NULL/);
    assert.match(globalAvailabilitySql, /active_user\.is_active = TRUE/);
    assert.match(globalAvailabilitySql, /availability\.booking_visibility = 'public'/);
    assert.equal(globalAvailabilityValues.at(-1), 5);
    assert.equal(nextAvailable.slots.length, 2);
    assert.equal(nextAvailable.slots[0].date, "2099-08-10");
    let legacySql;
    const legacySlot = { ...slot, id: "55555555-5555-4555-8555-555555555555", date: "2099-08-09", mode: null, capacity: 1, remaining_capacity: 1 };
    const fullLegacySlot = { ...legacySlot, id: "66666666-6666-4666-8666-666666666666", date: "2099-08-08", remaining_capacity: 0 };
    const withLegacy = await executeTool({ name: "get_available_slots", args: {}, actor: user, applicationTimezone: "UTC", database: { query: async (sql) => { if (sql.includes("ORDER BY date, start_time")) legacySql = sql; return { rows: [fullLegacySlot, legacySlot, slot] }; } } });
    assert.match(legacySql, /availability\.mode IS NULL OR availability\.capacity > COALESCE\(occupancy\.occupied, 0\)/);
    assert.doesNotMatch(legacySql, /availability\.mode IN \('wave', 'stream'\)/);
    assert.deepEqual(withLegacy.slots.map(({ mode }) => mode), ["legacy", "wave"]);
    assert.deepEqual(withLegacy.slots.map(({ date, mode, capacity, remaining_capacity }) => ({ date, mode, capacity, remaining_capacity })), [
      { date: "2099-08-09", mode: "legacy", capacity: 1, remaining_capacity: 1 },
      { date: "2099-08-10", mode: "wave", capacity: 4, remaining_capacity: 2 },
    ]);
    const manySlots = Array.from({ length: 6 }, (_, index) => ({ ...slot, date: `2099-08-${String(10 + index).padStart(2, "0")}` }));
    let orderedSql;
    const capped = await executeTool({ name: "get_available_slots", args: {}, actor: user, applicationTimezone: "UTC", database: { query: async (sql) => { if (sql.includes("ORDER BY date, start_time")) orderedSql = sql; return { rows: manySlots }; } } });
    assert.match(orderedSql, /ORDER BY date, start_time/);
    assert.equal(capped.slots.length, 5);
    assert.deepEqual(capped.slots.map(({ date }) => date), manySlots.slice(0, 5).map(({ date }) => date));

    let doctorFilter;
    const doctorSearch = await executeTool({ name: "get_available_slots", args: { doctor_id: doctorId }, actor: user, applicationTimezone: "UTC", database: { query: async (sql, values) => { if (sql.includes("ORDER BY date, start_time")) doctorFilter = values[0]; return { rows: [slot] }; } } });
    assert.equal(doctorFilter, doctorId);
    assert.equal(doctorSearch.slots.length, 1);

    let specialtySql;
    let specialtyValues;
    const stream = { ...slot, mode: "stream", date: "2099-08-09", capacity: 8, remaining_capacity: 3 };
    const specialtySearch = await executeTool({ name: "get_available_slots", args: { specialty: "General Practice" }, actor: user, applicationTimezone: "UTC", database: { query: async (sql, values) => { if (sql.includes("ORDER BY date, start_time")) { specialtySql = sql; specialtyValues = values; } return { rows: [stream, slot] }; } } });
    assert.match(specialtySql, /specialty_doctor\.specialty ILIKE/);
    assert.equal(specialtyValues.at(-2), "General Practice");
    assert.equal(specialtyValues.at(-1), 5);
    assert.deepEqual(specialtySearch.slots.map(({ mode, remaining_capacity, capacity }) => ({ mode, remaining_capacity, capacity })), [{ mode: "stream", remaining_capacity: 3, capacity: 8 }, { mode: "wave", remaining_capacity: 2, capacity: 4 }]);
  });

  it("does not offer a same-patient confirmed appointment as an available slot", async () => {
    const slot = { id: "33333333-3333-4333-8333-333333333333", doctor_id: doctorId, doctor_first_name: "Dee", doctor_last_name: "Doctor", specialty: "General Practice", consultation_fee: 500, mode: "wave", capacity: 4, date: "2099-08-10", start_time: "10:00:00", end_time: "10:30:00", remaining_capacity: 2 };
    const existing = { id: "77777777-7777-4777-8777-777777777777", doctor_id: doctorId, date: slot.date, start_time: slot.start_time, status: "confirmed" };
    const database = { query: async (sql) => ({ rows: sql.includes("ORDER BY date, start_time") ? [slot] : [existing] }) };
    const result = await executeTool({ name: "get_available_slots", args: { doctor_id: doctorId, from: slot.date, to: slot.date }, actor: user, applicationTimezone: "UTC", database });
    assert.deepEqual(result.slots, []);
  });

  it("normalizes a Dr-prefixed doctor search to the existing first/last-name query", async () => {
    let queryValues;
    await executeTool({
      name: "search_doctors", args: { name: "Dr. Ada Morgan" }, actor: user,
      database: { query: async (_sql, values) => { queryValues = values; return { rows: [] }; } },
    });
    assert.deepEqual(queryValues, ["Ada Morgan", 10]);
  });
});

describe("assistant conversation and Gemini adapter errors", () => {
  it("routes an explicit cross-doctor request through independently verified target doctor and slot", async () => {
    const sourceDoctor = { id: doctorId, name: "Dr. Ada Morgan" };
    const targetDoctorId = "77777777-7777-4777-8777-777777777777";
    const targetDoctor = { id: targetDoctorId, name: "Dr. Bea Stone" };
    const appointmentId = "99999999-9999-4999-8999-999999999999";
    const slotId = "88888888-8888-4888-8888-888888888888";
    const calls = [];
    const engine = createConversationEngine({
      now: () => Date.parse("2026-11-15T00:00:00Z"),
      provider: { generate: async () => { throw new Error("fully specified rescheduling should route deterministically"); } },
      toolExecutor: async ({ name, args }) => {
        calls.push({ name, args });
        if (name === "get_patient_appointments") return { appointments: [{ id: appointmentId, appointment_id: appointmentId, date: "2027-01-05", start_time: "09:00:00", end_time: "09:30:00", status: "confirmed", doctor: sourceDoctor }] };
        if (name === "search_doctors") return { doctors: [targetDoctor] };
        if (name === "get_available_slots") return { slots: [{ id: slotId, availability_id: slotId, doctor_id: targetDoctorId, date: "2027-01-07", start_time: "10:00:00", end_time: "10:30:00", doctor: targetDoctor }] };
        return { proposal: { action_type: "reschedule", action_args: args }, requires_patient_confirmation: true };
      },
    });
    const response = await engine.respond({ actor: user, messages: [{ role: "user", content: "Reschedule my appointment with Dr. Ada Morgan on 2027-01-05 at 9:00 AM to Dr. Bea Stone on 2027-01-07 at 10:00 AM" }] });
    assert.deepEqual(calls.map(({ name }) => name), ["get_patient_appointments", "search_doctors", "get_available_slots", "prepare_reschedule_action"]);
    assert.equal(calls[1].args.name, "Bea Stone");
    assert.equal(calls[2].args.doctor_id, targetDoctorId);
    assert.equal(calls[3].args.appointment_id, appointmentId);
    assert.equal(calls[3].args.availability_id, slotId);
    assert.match(response.answer, /rescheduling proposal/i);
  });

  it("keeps same-doctor rescheduling on the source doctor without an unnecessary doctor search", async () => {
    const appointmentId = "99999999-9999-4999-8999-999999999999";
    const slotId = "88888888-8888-4888-8888-888888888888";
    const calls = [];
    const doctor = { id: doctorId, name: "Dr. Ada Morgan" };
    const engine = createConversationEngine({
      provider: { generate: async () => ({ text: "", toolCalls: [{ name: "get_patient_appointments", arguments: { view: "upcoming", scope: "all" }, id: "appointments" }] }) },
      toolExecutor: async ({ name, args }) => {
        calls.push({ name, args });
        if (name === "get_patient_appointments") return { appointments: [{ appointment_id: appointmentId, id: appointmentId, date: "2027-01-05", start_time: "09:00:00", end_time: "09:30:00", status: "confirmed", doctor }] };
        if (name === "get_available_slots") return { slots: [{ id: slotId, availability_id: slotId, doctor_id: doctorId, date: "2027-01-07", start_time: "10:00:00", end_time: "10:30:00", doctor }] };
        return { proposal: { action_type: "reschedule", action_args: args }, requires_patient_confirmation: true };
      },
    });
    await engine.respond({ actor: user, messages: [{ role: "user", content: "Reschedule my appointment with Dr. Ada Morgan on 2027-01-05 at 9:00 AM to 2027-01-07 at 10:00 AM" }] });
    assert.deepEqual(calls.map(({ name }) => name), ["get_patient_appointments", "get_available_slots", "prepare_reschedule_action"]);
    assert.equal(calls[1].args.doctor_id, doctorId);
  });

  it("uses patient-owned prior appointment data for a previous-appointment refund and clarifies multiple matches", async () => {
    const appointmentIds = ["99999999-9999-4999-8999-999999999999", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"];
    const rows = appointmentIds.map((appointment_id, index) => ({ appointment_id, id: appointment_id, date: `2027-01-0${index + 5}`, start_time: "09:00:00", end_time: "09:30:00", status: "completed", doctor: { id: doctorId, name: "Dr. Ada Morgan" } }));
    const calls = [];
    const engine = createConversationEngine({
      provider: { generate: async () => { throw new Error("refund target resolution must be deterministic"); } },
      toolExecutor: async ({ name, args }) => {
        calls.push({ name, args });
        if (name === "get_patient_appointments") return { appointments: [rows[1]], has_more: false, next_offset: 1 };
        if (name === "get_cancellation_refund_preview") return { original_payment: { amount: "500.00", currency: "INR", status: "paid" }, processed_refund_amount: "0.00", pending_refund_amount: "0.00", estimated_additional_refund_amount: "250.00", currency: "INR", explanation: "" };
        throw new Error("unexpected tool");
      },
    });
    const response = await engine.respond({ actor: user, messages: [{ role: "user", content: "What refund should I expect for my previous appointment?" }] });
    assert.deepEqual(calls.map(({ name }) => name), ["get_patient_appointments", "get_cancellation_refund_preview"]);
    assert.equal(calls[0].args.scope, "last");
    assert.equal(calls[1].args.appointment_id, appointmentIds[1]);
    assert.match(response.answer, /estimated additional refund/i);

    let refundCalls = 0;
    const ambiguous = createConversationEngine({
      provider: { generate: async () => { throw new Error("ambiguous refund targets should stop before Gemini"); } },
      toolExecutor: async ({ name }) => {
        if (name === "get_patient_appointments") return { appointments: rows, has_more: false, next_offset: 2 };
        refundCalls += 1;
        return {};
      },
    });
    const clarification = await ambiguous.respond({ actor: user, messages: [{ role: "user", content: "Show the refund for my appointment with Dr. Ada Morgan" }] });
    assert.equal(refundCalls, 0);
    assert.match(clarification.answer, /multiple|choose/i);
  });

  it("routes a mixed cancellation and previous-appointment refund request as read-only refund preview", async () => {
    const appointmentId = "99999999-9999-4999-8999-999999999999";
    const calls = [];
    const engine = createConversationEngine({
      provider: { generate: async () => { throw new Error("mixed refund intent must route deterministically"); } },
      toolExecutor: async ({ name, args }) => {
        calls.push({ name, args });
        if (name === "get_patient_appointments") return { appointments: [{ appointment_id: appointmentId, id: appointmentId, date: "2027-01-05", start_time: "09:00:00", end_time: "09:30:00", status: "confirmed", doctor: { id: doctorId, name: "Dr. Ada Morgan" } }], has_more: false, next_offset: 1 };
        if (name === "get_cancellation_refund_preview") return { original_payment: { amount: "500.00", currency: "INR", status: "paid" }, processed_refund_amount: "0.00", pending_refund_amount: "0.00", estimated_additional_refund_amount: "250.00", currency: "INR", explanation: "" };
        throw new Error(`unexpected mutation or tool: ${name}`);
      },
    });
    const response = await engine.respond({ actor: user, messages: [{ role: "user", content: "Can you cancel my previous appointment and tell me the refund?" }] });
    assert.deepEqual(calls.map(({ name }) => name), ["get_patient_appointments", "get_cancellation_refund_preview"]);
    assert.equal(calls[0].args.scope, "last");
    assert.equal(calls[1].args.appointment_id, appointmentId);
    assert.deepEqual(response.results.map(({ tool }) => tool), ["get_cancellation_refund_preview"]);
    assert.match(response.answer, /estimated additional refund/i);
  });

  it("reuses successful reads for duplicate tool calls and preserves partial verified results on later failure", async () => {
    const toolExecutions = [];
    const outputs = [
      { doctors: [{ id: doctorId, name: "Dr. Dee Doctor", specialty: "Cardiology" }] },
    ];
    let providerCall = 0;
    const engine = createConversationEngine({
      provider: { generate: async () => {
        providerCall += 1;
        if (providerCall === 1 || providerCall === 2) return { text: "", toolCalls: [{ name: "search_doctors", arguments: { specialty: "Cardiology" }, id: `search-${providerCall}` }] };
        if (providerCall === 3) return { text: "", toolCalls: [{ name: "get_available_slots", arguments: { doctor_id: doctorId }, id: "slots" }] };
        return { text: "I found the doctor, but availability could not be checked.", toolCalls: [] };
      } },
      toolExecutor: async ({ name }) => {
        toolExecutions.push(name);
        if (name === "search_doctors") return outputs[0];
        throw Object.assign(new Error("temporary failure"), { code: "TOOL_QUERY_FAILED" });
      },
    });
    const response = await engine.respond({ actor: user, messages: [{ role: "user", content: "Find cardiology availability" }] });
    assert.deepEqual(toolExecutions, ["search_doctors", "get_available_slots"]);
    assert.equal(response.results.filter(({ tool }) => tool === "search_doctors").length, 1);
    assert.match(response.answer, /availability could not be checked/i);
  });

  it("returns verified earlier records when a later provider round fails", async () => {
    let requests = 0;
    const engine = createConversationEngine({
      provider: { generate: async () => {
        requests += 1;
        if (requests === 1) return { text: "", toolCalls: [{ name: "search_doctors", arguments: { specialty: "Cardiology" }, id: "search" }] };
        throw Object.assign(new Error("provider unavailable"), { status: 503 });
      } },
      toolExecutor: async () => ({ doctors: [{ id: doctorId, name: "Dr. Dee Doctor", specialty: "Cardiology" }] }),
    });
    const response = await engine.respond({ actor: user, messages: [{ role: "user", content: "Find cardiologists and their open appointment times" }] });
    assert.equal(response.results[0].tool, "search_doctors");
    assert.match(response.answer, /could not finish the rest/i);
  });

  it("does not charge rejected calls to the execution budget and caps provider rounds", async () => {
    let providerCalls = 0;
    let executions = 0;
    const engine = createConversationEngine({
      provider: { generate: async () => {
        providerCalls += 1;
        return providerCalls < 4
          ? { text: "", toolCalls: [{ name: "get_available_slots", arguments: { doctor_id: "99999999-9999-4999-8999-999999999999" }, id: `unresolved-${providerCalls}` }] }
          : { text: "Please identify a doctor first.", toolCalls: [] };
      } },
      toolExecutor: async () => { executions += 1; return {}; },
    });
    const response = await engine.respond({ actor: user, messages: [{ role: "user", content: "Show open appointment slots" }] });
    assert.equal(providerCalls, 4);
    assert.equal(executions, 0);
    assert.match(response.answer, /identify a doctor/i);
  });

  it("routes categorized appointment-history requests deterministically and preserves a clear empty result", async () => {
    const calls = [];
    const engine = createConversationEngine({
      provider: { generate: async () => { throw new Error("history should be routed before model"); } },
      toolExecutor: async ({ name, args }) => { calls.push({ name, args }); return { appointments: [], has_more: false, next_offset: 0 }; },
    });
    const response = await engine.respond({ actor: user, messages: [{ role: "user", content: "What was my last completed appointment?" }] });
    assert.deepEqual(calls, [{ name: "get_patient_appointments", args: { view: "past", scope: "last_completed" } }]);
    assert.match(response.answer, /no matching most recently completed appointment/i);
    assert.equal(response.results[0].tool, "get_patient_appointments");
  });

  it("attaches one private navigation action to every appointment in the deterministic upcoming-list response", async () => {
    const appointments = [
      { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", appointment_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", date: "2027-01-10", start_time: "09:00", end_time: "09:30", status: "confirmed", doctor: { id: doctorId, name: "Dr. Ada Morgan" } },
      { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", appointment_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", date: "2027-01-11", start_time: "10:00", end_time: "10:30", status: "confirmed", doctor: { id: doctorId, name: "Dr. Ada Morgan" } },
    ];
    const engine = createConversationEngine({
      now: () => Date.parse("2026-11-15T00:00:00Z"),
      provider: { generate: async () => { throw new Error("upcoming history should use the deterministic tool path"); } },
      toolExecutor: async () => ({ appointments, has_more: false, next_offset: appointments.length }),
    });
    const response = await engine.respond({ actor: user, messages: [{ role: "user", content: "Show my upcoming appointments" }] });
    const result = response.results[0];
    assert.equal(result.tool, "get_patient_appointments");
    assert.deepEqual(result.ui_actions, appointments.map(({ id }) => ({ type: "appointment", appointment_id: id })));
    assert.equal(result.data.appointments.length, 2);
    assert.doesNotMatch(JSON.stringify(result.data), /aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa|bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb|appointment_id|"id"/);
  });

  it("reports an appointment-history read failure instead of claiming an empty history", async () => {
    const engine = createConversationEngine({
      provider: { generate: async () => { throw new Error("history tool failure must not fall back to Gemini"); } },
      toolExecutor: async () => { throw Object.assign(new Error("db unavailable"), { code: "TOOL_QUERY_FAILED" }); },
    });
    const response = await engine.respond({ actor: user, messages: [{ role: "user", content: "Show all my upcoming appointments" }] });
    assert.match(response.answer, /could not load your upcoming appointments/i);
    assert.doesNotMatch(response.answer, /no matching|no appointments/i);
  });

  it("continues a complete upcoming history query through supported pages", async () => {
    const offsets = [];
    const engine = createConversationEngine({
      provider: { generate: async () => { throw new Error("history must not be delegated to Gemini"); } },
      toolExecutor: async ({ args }) => {
        offsets.push(args.offset);
        const start = args.offset || 0;
        return { appointments: [{ id: `appointment-${start + 1}`, appointment_id: `appointment-${start + 1}`, date: `2027-01-${String(start + 1).padStart(2, "0")}`, start_time: "09:00", end_time: "09:30", status: "confirmed", doctor: { id: doctorId, name: "Dr. Ada Morgan" } }], has_more: start < 2, next_offset: start + 1 };
      },
    });
    const response = await engine.respond({ actor: user, messages: [{ role: "user", content: "List every one of my upcoming appointments" }] });
    assert.deepEqual(offsets, [0, 1, 2]);
    assert.equal(response.results[0].data.appointments.length, 3);
    assert.doesNotMatch(response.answer, /first 3|more records/i);
  });

  it("resumes a bounded appointment-history page on a later turn and stops cleanly when exhausted", async () => {
    const offsets = [];
    const makeRow = (index) => {
      const id = `${String(index).padStart(8, "0")}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`;
      return { id, appointment_id: id, date: "2027-01-07", start_time: "09:00:00", end_time: "09:30:00", status: "confirmed", doctor: { id: doctorId, name: "Dr. Ada Morgan" } };
    };
    const engine = createConversationEngine({
      now: () => Date.parse("2026-11-15T00:00:00Z"),
      provider: { generate: async () => { throw new Error("history pagination is deterministic"); } },
      toolExecutor: async ({ args }) => {
        offsets.push(args.offset || 0);
        const offset = args.offset || 0;
      return { appointments: Array.from({ length: 20 }, (_, index) => makeRow(offset + index + 1)), has_more: offset < 160, next_offset: offset + 20 };
      },
    });
    const first = await engine.respond({ actor: user, messages: [{ role: "user", content: "Show all upcoming appointments" }] });
    assert.equal(first.internalReferences.history_page.next_offset, 80);
    assert.equal(first.internalReferences.history_page.has_more, true);
    const second = await engine.respond({ actor: user, previousReferences: first.internalReferences, messages: [{ role: "user", content: "Continue to the next page" }] });
    assert.deepEqual(offsets, [0, 20, 40, 60, 80, 100, 120, 140]);
    assert.equal(second.internalReferences.history_page.has_more, true);
    assert.doesNotMatch(second.answer, /all your upcoming appointments/i);
  });

  it("resumes a polite next-page request from a persisted cursor beyond offset 1000", async () => {
    const offsets = [];
    const engine = createConversationEngine({
      now: () => Date.parse("2026-11-15T00:00:00Z"),
      provider: { generate: async () => { throw new Error("a stored history cursor must resolve this follow-up"); } },
      toolExecutor: async ({ args }) => {
        offsets.push(args.offset);
        const offset = args.offset;
        const id = `${String(offset + 1).padStart(8, "0")}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`;
        return { appointments: [{ id, appointment_id: id, date: "2027-01-07", start_time: "09:00:00", end_time: "09:30:00", status: "confirmed", doctor: { id: doctorId, name: "Dr. Ada Morgan" } }], has_more: true, next_offset: offset + 1 };
      },
    });
    const response = await engine.respond({ actor: user, previousReferences: {
      version: 1,
      reference_timestamps: { appointments: "2026-11-15T00:00:00.000Z" },
      appointments: [], slots: [], doctors: [],
      history_page: { query: { view: "upcoming", scope: "all" }, next_offset: 1200, has_more: true, seen_appointment_ids: [] },
    }, messages: [{ role: "user", content: "Can you show me the next page?" }] });
    assert.deepEqual(offsets, [1200, 1201, 1202, 1203]);
    assert.equal(response.internalReferences.history_page.next_offset, 1204);
    assert.equal(response.internalReferences.history_page.has_more, true);
    assert.match(response.answer, /next .*upcoming appointments/i);
  });

  it("persists an exhausted or empty history page as non-continuable", async () => {
    const engine = createConversationEngine({
      now: () => Date.parse("2026-11-15T00:00:00Z"),
      provider: { generate: async () => { throw new Error("history is deterministic"); } },
      toolExecutor: async () => ({ appointments: [], has_more: false, next_offset: 0 }),
    });
    const empty = await engine.respond({ actor: user, messages: [{ role: "user", content: "Show all upcoming appointments" }] });
    assert.equal(empty.internalReferences.history_page.has_more, false);
    const next = await engine.respond({ actor: user, previousReferences: empty.internalReferences, messages: [{ role: "user", content: "next page" }] });
    assert.match(next.answer, /no more appointment pages/i);
    const emptyLaterPage = await engine.respond({ actor: user, now: () => Date.parse("2026-11-15T00:00:00Z"), previousReferences: {
      version: 1,
      reference_timestamps: { appointments: "2026-11-15T00:00:00.000Z" },
      appointments: [], slots: [], doctors: [],
      history_page: { query: { view: "upcoming", scope: "all" }, next_offset: 20, has_more: true, seen_appointment_ids: [] },
    }, messages: [{ role: "user", content: "show next page" }] });
    assert.match(emptyLaterPage.answer, /no more appointment pages/i);
    assert.equal(emptyLaterPage.internalReferences.history_page.has_more, false);
  });

  it("does not use expired slot references as authoritative targets", async () => {
    let executions = 0;
    const engine = createConversationEngine({
      now: () => Date.parse("2026-11-15T00:00:00Z"),
      provider: { generate: async () => ({ text: "Please choose a currently available slot.", toolCalls: [] }) },
      toolExecutor: async () => { executions += 1; return {}; },
    });
    const response = await engine.respond({ actor: user, messages: [{ role: "user", content: "1" }], previousReferences: {
      version: 1, reference_timestamps: { slots: "2026-11-14T23:00:00.000Z" }, pending_action: "book",
      slots: [{ id: "88888888-8888-4888-8888-888888888888", availability_id: "88888888-8888-4888-8888-888888888888", date: "2026-11-16", start_time: "10:00", end_time: "10:30" }], appointments: [], doctors: [],
    } });
    assert.equal(executions, 0);
    assert.deepEqual(response.internalReferences.slots, []);
    assert.equal(response.internalReferences.pending_action, undefined);
    assert.match(response.answer, /recent displayed slot list/i);
  });

  it("does not search for a doctor from a numeric reply after the displayed slots expired", async () => {
    let providerCalls = 0;
    const engine = createConversationEngine({
      now: () => Date.parse("2026-11-15T00:00:00Z"),
      provider: { generate: async () => { providerCalls += 1; return { text: "I searched for doctor 11.", toolCalls: [{ name: "search_doctors", arguments: { name: "11" }, id: "wrong" }] }; } },
      toolExecutor: async () => { throw new Error("a numeric follow-up must not be a doctor search"); },
    });
    const response = await engine.respond({ actor: user, messages: [{ role: "user", content: "11" }], previousReferences: {
      version: 1, reference_timestamps: { slots: "2026-11-14T23:00:00.000Z" }, slots: [{ availability_id: doctorId, id: doctorId, date: "2026-11-16", start_time: "11:00" }], appointments: [], doctors: [],
    } });
    assert.equal(providerCalls, 0);
    assert.match(response.answer, /recent displayed slot list/i);
  });

  it("asks for an exact time before preparing an action from an approximate request", async () => {
    let executions = 0;
    const engine = createConversationEngine({
      provider: { generate: async () => { throw new Error("approximate action should be clarified"); } },
      toolExecutor: async () => { executions += 1; return {}; },
    });
    const response = await engine.respond({ actor: user, messages: [{ role: "user", content: "Book Dr. Dee around 11:30 AM tomorrow" }] });
    assert.equal(executions, 0);
    assert.match(response.answer, /exact appointment start time/i);
  });
  it("resolves an exact booking through search, exact availability, then a preparation-only proposal", async () => {
    const appointmentDate = "2099-08-11";
    const returnedDoctorId = "77777777-7777-4777-8777-777777777777";
    const returnedSlotId = "88888888-8888-4888-8888-888888888888";
    const calls = [
      { name: "search_doctors", arguments: { name: "Dr. Ada Morgan" }, id: "search" },
      { name: "get_available_slots", arguments: { doctor_id: returnedDoctorId, from: appointmentDate, to: appointmentDate, exact_start_time: "14:30" }, id: "slots" },
    ];
    const toolExecutions = [];
    let providerCall = 0;
    const engine = createConversationEngine({
      provider: { generate: async ({ messages }) => {
        providerCall += 1;
        if (providerCall <= calls.length) return { text: "", toolCalls: [calls[providerCall - 1]] };
        return { text: "Available times", toolCalls: [] };
      } },
      toolExecutor: async ({ name, args }) => {
        toolExecutions.push({ name, args });
        if (name === "search_doctors") return { doctors: [{ id: returnedDoctorId, name: "Dr. Ada Morgan" }] };
        if (name === "get_patient_appointments") return { appointments: [], has_more: false };
        if (name === "get_available_slots") return { slots: [{ id: returnedSlotId, availability_id: returnedSlotId, doctor_id: returnedDoctorId, date: appointmentDate, start_time: "14:30:00", end_time: "15:00:00", consultation_fee: "640.00", doctor: { id: returnedDoctorId, name: "Dr. Ada Morgan" } }] };
        return { proposal: { action_type: "book", action_args: args }, requires_patient_confirmation: true };
      },
    });
    const response = await engine.respond({ actor: user, messages: [{ role: "user", content: `Book with Dr. Ada Morgan on ${appointmentDate} at 14:30 to 15:00` }] });
    assert.deepEqual(toolExecutions.map(({ name }) => name), ["search_doctors", "get_patient_appointments", "get_available_slots", "prepare_booking_action"]);
    assert.equal(providerCall, 0);
    assert.equal(toolExecutions[2].args.doctor_id, returnedDoctorId);
    assert.equal(toolExecutions[2].args.exact_start_time, "14:30");
    assert.equal(toolExecutions[3].args.availability_id, returnedSlotId);
    assert.match(response.answer, new RegExp(`${appointmentDate} at 14:30`));
    assert.match(response.answer, /15:00/);
    assert.match(response.answer, /INR 640\.00/);
    assert.match(response.answer, /no confirmation intent has been created/);
    assert.equal(response.results.length, 1);
    assert.equal(response.results[0].tool, "prepare_booking_action");
    assert.equal(response.results[0].data.proposal.action_type, "book");
    assert.equal(response.results[0].data.requires_patient_confirmation, true);
    assert.equal(response.results[0].data.persisted_intent_created, false);
    assert.equal(JSON.stringify(response.results).includes(returnedSlotId), false);
  });

  it("resolves an exact reschedule from owned appointment results and that doctor's exact availability", async () => {
    const oldDate = "2099-08-10";
    const targetDate = "2099-08-12";
    const appointmentId = "99999999-9999-4999-8999-999999999999";
    const returnedDoctorId = "77777777-7777-4777-8777-777777777777";
    const returnedSlotId = "88888888-8888-4888-8888-888888888888";
    const calls = [
      { name: "get_patient_appointments", arguments: { view: "upcoming", scope: "all" }, id: "appointments" },
      { name: "get_available_slots", arguments: { doctor_id: returnedDoctorId, from: targetDate, to: targetDate, exact_start_time: "16:00" }, id: "slots" },
    ];
    const toolExecutions = [];
    let providerCall = 0;
    const engine = createConversationEngine({
      provider: { generate: async () => {
        providerCall += 1;
        if (providerCall <= calls.length) return { text: "", toolCalls: [calls[providerCall - 1]] };
        return { text: "Available times", toolCalls: [] };
      } },
      toolExecutor: async ({ name, args }) => {
        toolExecutions.push({ name, args });
        if (name === "get_patient_appointments") return { appointments: [{ appointment_id: appointmentId, date: oldDate, start_time: "10:00:00", status: "confirmed", doctor: { id: returnedDoctorId, name: "Dr. Ada Morgan" } }] };
        if (name === "get_available_slots") return { slots: [{ id: returnedSlotId, availability_id: returnedSlotId, doctor_id: returnedDoctorId, date: targetDate, start_time: "16:00:00" }] };
        return { proposal: { action_type: "reschedule", action_args: args }, requires_patient_confirmation: true };
      },
    });
    const response = await engine.respond({ actor: user, messages: [{ role: "user", content: `Move my appointment with Dr. Ada Morgan on ${oldDate} at 10:00 to ${targetDate} at 16:00` }] });
    assert.deepEqual(toolExecutions.map(({ name }) => name), ["get_patient_appointments", "get_available_slots", "prepare_reschedule_action"]);
    assert.equal(providerCall, 0);
    assert.equal(toolExecutions[1].args.doctor_id, returnedDoctorId);
    assert.equal(toolExecutions[2].args.appointment_id, appointmentId);
    assert.equal(toolExecutions[2].args.availability_id, returnedSlotId);
    assert.match(response.answer, new RegExp(`${targetDate} at 16:00`));
    assert.match(response.answer, /no confirmation intent has been created/);
    assert.equal(response.results.length, 1);
    assert.equal(response.results[0].tool, "prepare_reschedule_action");
    assert.equal(response.results[0].data.proposal.action_type, "reschedule");
    assert.equal(response.results[0].data.requires_patient_confirmation, true);
    assert.equal(response.results[0].data.persisted_intent_created, false);
  });

  it("resolves a short slot choice against the prior verified availability result across turns", async () => {
    const slotId = "88888888-8888-4888-8888-888888888888";
    const slot = { id: slotId, availability_id: slotId, doctor_id: doctorId, date: "2027-01-07", start_time: "11:00:00", end_time: "11:30:00", doctor: { id: doctorId, name: "Dr. Ada Morgan" }, consultation_fee: "500.00" };
    let providerCall = 0;
    const firstEngine = createConversationEngine({
      provider: { generate: async () => {
        providerCall += 1;
        if (providerCall === 1) return { text: "", toolCalls: [{ name: "search_doctors", arguments: { name: "Dr. Ada Morgan" }, id: "doctor" }] };
        if (providerCall === 2) return { text: "", toolCalls: [{ name: "get_available_slots", arguments: { doctor_id: doctorId }, id: "slots" }] };
        return { text: "Choose a time.", toolCalls: [] };
      } },
      toolExecutor: async ({ name }) => name === "search_doctors" ? { doctors: [{ id: doctorId, name: "Dr. Ada Morgan" }] } : { slots: [slot] },
    });
    const first = await firstEngine.respond({ actor: user, messages: [{ role: "user", content: "I want to book an appointment with Dr. Ada Morgan on 2027-01-07." }] });
    assert.deepEqual(first.internalReferences.slots.map(({ availability_id }) => availability_id), [slotId]);
    assert.equal(first.internalReferences.pending_action, "book");

    const calls = [];
    const secondEngine = createConversationEngine({
      provider: { generate: async () => { throw new Error("numeric slot choice must resolve before Gemini"); } },
      toolExecutor: async ({ name, args }) => { calls.push({ name, args }); if (name === "get_patient_appointments") return { appointments: [], has_more: false }; if (name === "get_available_slots") return { slots: [slot] }; return { proposal: { action_type: "book", action_args: args }, requires_patient_confirmation: true }; },
    });
    const second = await secondEngine.respond({ actor: user, messages: [{ role: "user", content: "11" }], previousReferences: first.internalReferences });
    assert.deepEqual(calls, [
      { name: "get_patient_appointments", args: { view: "upcoming", scope: "all", from: "2027-01-07", to: "2027-01-07" } },
      { name: "get_available_slots", args: { doctor_id: doctorId, from: "2027-01-07", to: "2027-01-07", exact_start_time: "11:00" } },
      { name: "prepare_booking_action", args: { availability_id: slotId } },
    ]);
    assert.match(second.answer, /2027-01-07 at 11:00/);
    assert.equal(second.results[0].tool, "prepare_booking_action");
    assert.equal(JSON.stringify({ answer: second.answer, results: second.results }).includes(slotId), false);
  });

  it("resolves a doctor pronoun from the persisted prior search result and checks availability without another search", async () => {
    const aliId = "77777777-7777-4777-8777-777777777777";
    let firstCall = 0;
    const firstEngine = createConversationEngine({
      provider: { generate: async () => ++firstCall === 1
        ? { text: "", toolCalls: [{ name: "search_doctors", arguments: { name: "Ali" }, id: "doctor-search" }] }
        : { text: "I found Dr. Ali Ahmed.", toolCalls: [] },
      },
      toolExecutor: async () => ({ doctors: [{ id: aliId, name: "Dr. Ali Ahmed", specialty: "Cardiology" }] }),
    });
    const first = await firstEngine.respond({ actor: user, messages: [{ role: "user", content: "doctor ali?" }] });
    assert.deepEqual(first.internalReferences.doctors, [{ id: aliId, name: "Dr. Ali Ahmed", specialty: "Cardiology" }]);

    let providerCalled = false;
    let lookup;
    const secondEngine = createConversationEngine({
      provider: { generate: async () => { providerCalled = true; throw new Error("pronoun follow-up should resolve before Gemini"); } },
      toolExecutor: async (input) => { lookup = input; return { slots: [{ id: "88888888-8888-4888-8888-888888888888", availability_id: "88888888-8888-4888-8888-888888888888", date: "2027-01-06", start_time: "10:00:00", end_time: "10:30:00", doctor: { id: aliId, name: "Dr. Ali Ahmed" } }] }; },
    });
    const second = await secondEngine.respond({ actor: user, previousReferences: first.internalReferences, messages: [{ role: "user", content: "Show available appointment for him" }] });
    assert.equal(providerCalled, false);
    assert.equal(lookup.name, "get_available_slots");
    assert.deepEqual(lookup.args, { doctor_id: aliId });
    assert.match(second.answer, /Dr\. Ali Ahmed/);
    assert.equal(JSON.stringify({ answer: second.answer, results: second.results }).includes(aliId), false);

    let modelContext;
    const contextEngine = createConversationEngine({
      provider: { generate: async ({ systemInstruction }) => { modelContext = systemInstruction; return { text: "You asked about Dr. Ali Ahmed.", toolCalls: [] }; } },
      toolExecutor: async () => ({}),
    });
    await contextEngine.respond({ actor: user, previousReferences: first.internalReferences, messages: [{ role: "user", content: "Who did I ask about?" }] });
    assert.match(modelContext, /Dr\. Ali Ahmed/);
    assert.equal(modelContext.includes(aliId), false);
  });

  it("uses a complete upcoming appointment page for plural list requests", async () => {
    const appointments = [
      { id: "99999999-9999-4999-8999-999999999999", appointment_id: "99999999-9999-4999-8999-999999999999", date: "2027-01-07", start_time: "09:00:00", end_time: "09:30:00", status: "confirmed", doctor: { id: doctorId, name: "Dr. Ada Morgan" } },
      { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", appointment_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", date: "2027-01-08", start_time: "10:00:00", end_time: "10:30:00", status: "confirmed", doctor: { id: doctorId, name: "Dr. Ada Morgan" } },
    ];
    let request;
    const engine = createConversationEngine({
      provider: { generate: async () => { throw new Error("history requests route deterministically"); } },
      toolExecutor: async ({ args }) => { request = args; return { appointments, has_more: false, next_offset: 2 }; },
    });
    const result = await engine.respond({ actor: user, messages: [{ role: "user", content: "Show me my upcoming appointments." }] });
    assert.deepEqual(request, { view: "upcoming", scope: "all", offset: 0 });
    assert.equal(result.results[0].data.appointments.length, 2);
    assert.equal(result.internalReferences.appointments.length, 2);
  });

  it("distinguishes the nearest next appointment from the furthest latest upcoming appointment using the same records", async () => {
    const appointments = [
      { id: "99999999-9999-4999-8999-999999999999", appointment_id: "99999999-9999-4999-8999-999999999999", date: "2027-01-07", start_time: "09:00:00", end_time: "09:30:00", status: "confirmed", doctor: { id: doctorId, name: "Dr. Ada Morgan" } },
      { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", appointment_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", date: "2027-01-08", start_time: "10:00:00", end_time: "10:30:00", status: "confirmed", doctor: { id: doctorId, name: "Dr. Ada Morgan" } },
    ];
    const queries = [];
    const engine = createConversationEngine({
      provider: { generate: async () => { throw new Error("appointment history requests route deterministically"); } },
      toolExecutor: async ({ args }) => { queries.push(args); return { appointments, has_more: false, next_offset: appointments.length }; },
    });
    const next = await engine.respond({ actor: user, messages: [{ role: "user", content: "Show my next appointment" }] });
    const latest = await engine.respond({ actor: user, messages: [{ role: "user", content: "Show my latest upcoming appointment" }] });
    assert.deepEqual(queries.map(({ view, scope }) => ({ view, scope })), [
      { view: "upcoming", scope: "nearest" },
      { view: "upcoming", scope: "furthest" },
    ]);
    assert.deepEqual(next.results[0].data.appointments.map(({ date }) => date), ["2027-01-07"]);
    assert.deepEqual(latest.results[0].data.appointments.map(({ date }) => date), ["2027-01-08"]);
    assert.match(next.answer, /next upcoming appointment/i);
    assert.match(latest.answer, /latest upcoming appointment/i);
  });

  it("keeps a named doctor through missing-date booking follow-ups without repeating doctor cards", async () => {
    const date = "2027-02-06";
    const slotId = "88888888-8888-4888-8888-888888888888";
    const doctor = { id: doctorId, name: "Dr. Ada Morgan", specialty: "Cardiology" };
    const calls = [];
    const engine = createConversationEngine({
      now: () => Date.parse("2026-11-15T00:00:00Z"),
      provider: { generate: async () => { throw new Error("identified doctor booking follow-up is deterministic"); } },
      toolExecutor: async ({ name, args }) => {
        calls.push({ name, args });
        if (name === "search_doctors") return { doctors: [doctor] };
        if (name === "get_available_slots") return { slots: [{ id: slotId, availability_id: slotId, doctor_id: doctorId, date, start_time: "14:30:00", end_time: "15:00:00", doctor }] };
        throw new Error(`Unexpected tool ${name}`);
      },
    });
    const first = await engine.respond({ actor: user, messages: [{ role: "user", content: "Book an appointment with Dr. Ada Morgan" }] });
    assert.match(first.answer, /what date and time would you prefer/i);
    assert.deepEqual(first.results.map(({ tool }) => tool), ["search_doctors"]);
    assert.equal(first.internalReferences.pending_action, "book");
    assert.equal(first.internalReferences.doctors[0].id, doctorId);

    const followupMessages = [
      { role: "user", content: "Book an appointment with Dr. Ada Morgan" },
      { role: "assistant", content: first.answer },
      { role: "user", content: "Show me the date and time" },
    ];
    const followup = await engine.respond({ actor: user, previousReferences: first.internalReferences, messages: followupMessages });
    assert.match(followup.answer, /what date and time would you prefer/i);
    assert.deepEqual(followup.results, []);
    assert.equal(followup.internalReferences.pending_action, "book");

    const withDate = await engine.respond({
      actor: user,
      previousReferences: followup.internalReferences,
      messages: [...followupMessages, { role: "assistant", content: followup.answer }, { role: "user", content: date }],
    });
    assert.deepEqual(calls.map(({ name }) => name), ["search_doctors", "get_available_slots"]);
    assert.deepEqual(calls[1].args, { doctor_id: doctorId, from: date, to: date });
    assert.deepEqual(withDate.results.map(({ tool }) => tool), ["get_available_slots"]);
    assert.match(withDate.answer, /available appointment times with Dr\. Ada Morgan/i);
  });

  it("preserves one doctor and the requested date across exact booking time turns", async () => {
    const appointmentDate = "2026-11-20";
    const slotId = "88888888-8888-4888-8888-888888888888";
    const doctor = { id: doctorId, name: "Dr. James Wilson", specialty: "Cardiology" };
    const calls = [];
    const engine = createConversationEngine({
      now: () => Date.parse("2026-11-15T00:00:00Z"),
      provider: { generate: async () => { throw new Error("booking follow-ups are deterministic"); } },
      toolExecutor: async ({ name, args }) => {
        calls.push({ name, args });
        if (name === "search_doctors") return { doctors: [doctor] };
        if (name === "get_patient_appointments") return { appointments: [], has_more: false, next_offset: 0 };
        if (name === "get_available_slots" && !args.exact_start_time) return { slots: [{ availability_id: slotId, id: slotId, doctor_id: doctorId, date: appointmentDate, start_time: "09:30:00", end_time: "10:00:00", doctor }] };
        if (name === "get_available_slots" && args.exact_start_time === "09:00") return { slots: [] };
        if (name === "get_available_slots" && args.exact_start_time === "09:30") return { slots: [{ availability_id: slotId, id: slotId, doctor_id: doctorId, date: appointmentDate, start_time: "09:30:00", end_time: "10:00:00", doctor }] };
        if (name === "prepare_booking_action") return { proposal: { action_type: "book", action_args: args }, requires_patient_confirmation: true };
        throw new Error(`Unexpected tool ${name}`);
      },
    });
    const turnOne = [{ role: "user", content: "I want to book an appointment with Dr. James Wilson" }];
    const first = await engine.respond({ actor: user, messages: turnOne });
    assert.deepEqual(first.results.map(({ tool }) => tool), ["search_doctors"]);
    assert.match(first.answer, /date and time/i);
    const turnTwo = [...turnOne, { role: "assistant", content: first.answer }, { role: "user", content: "Dr. James Wilson, 20 November" }];
    const second = await engine.respond({ actor: user, previousReferences: first.internalReferences, messages: turnTwo });
    assert.deepEqual(second.results.map(({ tool }) => tool), ["get_available_slots"]);
    assert.deepEqual(calls.filter(({ name }) => name === "search_doctors").length, 1);
    assert.equal(calls.find(({ name, args }) => name === "get_available_slots" && !args.exact_start_time).args.from, appointmentDate);
    const turnThree = [...turnTwo, { role: "assistant", content: second.answer }, { role: "user", content: "20 November 9 AM" }];
    const third = await engine.respond({ actor: user, previousReferences: second.internalReferences, messages: turnThree });
    assert.match(third.answer, /9:00 AM time is not available/i);
    assert.deepEqual(third.results.map(({ tool }) => tool), ["get_available_slots"]);
    assert.equal(calls.find(({ name, args }) => name === "get_available_slots" && args.exact_start_time === "09:00").args.from, appointmentDate);
    const turnFour = [...turnThree, { role: "assistant", content: third.answer }, { role: "user", content: "20 November 9:30 AM" }];
    const fourth = await engine.respond({ actor: user, previousReferences: third.internalReferences, messages: turnFour });
    assert.deepEqual(fourth.results.map(({ tool }) => tool), ["prepare_booking_action"]);
    assert.deepEqual(calls.filter(({ name }) => name === "search_doctors").length, 1);
    assert.equal(calls.find(({ name }) => name === "prepare_booking_action").args.availability_id, slotId);
    assert.match(fourth.answer, /no confirmation intent has been created/i);
  });

  it("does not claim another page for nearest appointment results without a valid cursor", async () => {
    const engine = createConversationEngine({
      provider: { generate: async () => { throw new Error("nearest appointment is deterministic"); } },
      toolExecutor: async () => ({ appointments: [{ id: "99999999-9999-4999-8999-999999999999", appointment_id: "99999999-9999-4999-8999-999999999999", date: "2027-01-07", start_time: "09:00:00", status: "confirmed", doctor: { id: doctorId, name: "Dr. Ada Morgan" } }], has_more: true }),
    });
    const result = await engine.respond({ actor: user, messages: [{ role: "user", content: "Show my next appointment" }] });
    assert.match(result.answer, /next upcoming appointment/i);
    assert.doesNotMatch(result.answer, /more records|next page/i);
    assert.equal(result.internalReferences.history_page.has_more, false);
  });

  it("does not promise an all-appointments next page without a valid cursor", async () => {
    const engine = createConversationEngine({
      provider: { generate: async () => { throw new Error("appointment history is deterministic"); } },
      toolExecutor: async () => ({ appointments: [{ id: "99999999-9999-4999-8999-999999999999", appointment_id: "99999999-9999-4999-8999-999999999999", date: "2027-01-07", start_time: "09:00:00", status: "confirmed", doctor: { id: doctorId, name: "Dr. Ada Morgan" } }], has_more: true }),
    });
    const result = await engine.respond({ actor: user, messages: [{ role: "user", content: "List all upcoming appointments" }] });
    assert.doesNotMatch(result.answer, /more records|next page/i);
    assert.equal(result.internalReferences.history_page.has_more, false);
  });

  it("reports the patient's existing appointment when a contextual exact booking slot is already owned", async () => {
    const appointmentDate = "2026-11-20";
    const doctor = { id: doctorId, name: "Dr. James Wilson" };
    const ownedAppointment = { appointment_id: "99999999-9999-4999-8999-999999999999", date: appointmentDate, start_time: "09:00:00", status: "confirmed", doctor };
    const calls = [];
    const engine = createConversationEngine({
      now: () => Date.parse("2026-11-15T00:00:00Z"),
      provider: { generate: async () => { throw new Error("contextual duplicate check is deterministic"); } },
      toolExecutor: async ({ name, args }) => { calls.push({ name, args }); return { appointments: [ownedAppointment], has_more: false, next_offset: 1 }; },
    });
    const result = await engine.respond({ actor: user, previousReferences: {
      version: 1, reference_timestamps: { doctors: "2026-11-15T00:00:00.000Z" }, pending_action: "book",
      appointments: [], slots: [], doctors: [doctor],
    }, messages: [{ role: "user", content: "20 November 9 AM" }] });
    assert.match(result.answer, /already have a confirmed appointment with Dr\. James Wilson on 2026-11-20 at 09:00/i);
    assert.deepEqual(calls.map(({ name }) => name), ["get_patient_appointments"]);
    assert.doesNotMatch(JSON.stringify(result.results), /prepare_booking_action/);
  });

  it("keeps a date-only booking context for a time-only duplicate check and later exact time", async () => {
    const appointmentDate = "2026-11-20";
    const slotId = "88888888-8888-4888-8888-888888888888";
    const doctor = { id: doctorId, name: "Dr. James Wilson" };
    const ownedAppointment = { appointment_id: "99999999-9999-4999-8999-999999999999", date: appointmentDate, start_time: "09:00:00", status: "confirmed", doctor };
    const calls = [];
    const engine = createConversationEngine({
      now: () => Date.parse("2026-11-15T00:00:00Z"),
      provider: { generate: async () => { throw new Error("booking context follow-ups are deterministic"); } },
      toolExecutor: async ({ name, args }) => {
        calls.push({ name, args });
        if (name === "search_doctors") return { doctors: [doctor] };
        if (name === "get_patient_appointments") return args.from === appointmentDate && args.to === appointmentDate && args.scope === "all"
          ? { appointments: args.from === appointmentDate && args.to === appointmentDate && calls.filter(({ name: callName }) => callName === "get_patient_appointments").length === 1 ? [ownedAppointment] : [], has_more: false, next_offset: 1 }
          : { appointments: [], has_more: false, next_offset: 0 };
        if (name === "get_available_slots" && !args.exact_start_time) return { slots: [{ id: slotId, availability_id: slotId, doctor_id: doctorId, date: appointmentDate, start_time: "09:30:00", end_time: "10:00:00", doctor }] };
        if (name === "get_available_slots" && args.exact_start_time === "09:30") return { slots: [{ id: slotId, availability_id: slotId, doctor_id: doctorId, date: appointmentDate, start_time: "09:30:00", end_time: "10:00:00", doctor }] };
        if (name === "prepare_booking_action") return { proposal: { action_type: "book", action_args: args }, requires_patient_confirmation: true };
        throw new Error(`Unexpected tool ${name}`);
      },
    });
    const firstMessages = [{ role: "user", content: "I want to book an appointment with Dr. James Wilson." }];
    const first = await engine.respond({ actor: user, messages: firstMessages });
    const secondMessages = [...firstMessages, { role: "assistant", content: first.answer }, { role: "user", content: "20 November." }];
    const second = await engine.respond({ actor: user, previousReferences: first.internalReferences, messages: secondMessages });
    assert.deepEqual(second.results.map(({ tool }) => tool), ["get_available_slots"]);
    assert.equal(second.internalReferences.pending_target_date, appointmentDate);
    const thirdMessages = [...secondMessages, { role: "assistant", content: second.answer }, { role: "user", content: "9 AM." }];
    const third = await engine.respond({ actor: user, previousReferences: second.internalReferences, messages: thirdMessages });
    assert.match(third.answer, /already have a confirmed appointment with Dr\. James Wilson on 2026-11-20 at 09:00/i);
    assert.deepEqual(third.results, []);
    const fourthMessages = [...thirdMessages, { role: "assistant", content: third.answer }, { role: "user", content: "9:30 AM." }];
    const fourth = await engine.respond({ actor: user, previousReferences: third.internalReferences, messages: fourthMessages });
    assert.deepEqual(fourth.results.map(({ tool }) => tool), ["prepare_booking_action"]);
    const exactSlotQuery = calls.find(({ name, args }) => name === "get_available_slots" && args.exact_start_time === "09:30");
    assert.equal(exactSlotQuery.args.from, appointmentDate);
    assert.equal(exactSlotQuery.args.doctor_id, doctorId);
    assert.equal(calls.filter(({ name }) => name === "search_doctors").length, 1);
    assert.match(fourth.answer, /no confirmation intent has been created/i);
  });

  it("keeps a named doctor and January 2027 date across a duplicate 11 AM request and 11:30 alternative", async () => {
    const appointmentDate = "2027-01-20";
    const slotId = "88888888-8888-4888-8888-888888888888";
    const doctor = { id: doctorId, name: "Dr. James Wilson" };
    const ownedAppointment = { appointment_id: "99999999-9999-4999-8999-999999999999", date: appointmentDate, start_time: "11:00:00", status: "confirmed", doctor };
    const alternative = { id: slotId, availability_id: slotId, doctor_id: doctorId, date: appointmentDate, start_time: "11:30:00", end_time: "12:00:00", doctor, capacity: 2, remaining_capacity: 2 };
    const calls = [];
    const engine = createConversationEngine({
      now: () => Date.parse("2026-12-01T12:00:00Z"),
      provider: { generate: async () => { throw new Error("doctor/date booking context should resolve deterministically"); } },
      toolExecutor: async ({ name, args }) => {
        calls.push({ name, args });
        if (name === "search_doctors") return { doctors: [doctor] };
        if (name === "get_patient_appointments") return { appointments: [ownedAppointment], has_more: false, next_offset: 1 };
        if (name === "get_available_slots") return { slots: [alternative] };
        if (name === "prepare_booking_action") return { proposal: { action_type: "book", action_args: args }, requires_patient_confirmation: true };
        throw new Error(`Unexpected tool ${name}`);
      },
    });
    const firstMessages = [{ role: "user", content: "Book an appointment with Dr. James Wilson on January 20, 2027" }];
    const first = await engine.respond({ actor: user, messages: firstMessages });
    assert.equal(first.internalReferences.pending_target_date, appointmentDate);
    const secondMessages = [...firstMessages, { role: "assistant", content: first.answer }, { role: "user", content: "11 AM" }];
    const second = await engine.respond({ actor: user, previousReferences: first.internalReferences, messages: secondMessages });
    assert.match(second.answer, /already have a confirmed appointment with Dr\. James Wilson on 2027-01-20 at 11:00/i);
    assert.deepEqual(second.results, []);
    const thirdMessages = [...secondMessages, { role: "assistant", content: second.answer }, { role: "user", content: "11:30 AM" }];
    const third = await engine.respond({ actor: user, previousReferences: second.internalReferences, messages: thirdMessages });
    assert.deepEqual(third.results.map(({ tool }) => tool), ["prepare_booking_action"]);
    assert.equal(calls.filter(({ name }) => name === "search_doctors").length, 1);
    const exactQuery = calls.find(({ name, args }) => name === "get_available_slots" && args.exact_start_time === "11:30");
    assert.deepEqual(exactQuery.args, { doctor_id: doctorId, from: appointmentDate, to: appointmentDate, exact_start_time: "11:30" });
    assert.equal(calls.find(({ name }) => name === "prepare_booking_action").args.availability_id, slotId);
    assert.match(third.answer, /no confirmation intent has been created/i);
  });

  it("keeps booking context through doctor pronoun, date, duplicate time, alternative selection, and non-confirming okay turns", async () => {
    const appointmentDate = "2027-01-20";
    const slot11Id = "88888888-8888-4888-8888-888888888888";
    const slot1130Id = "77777777-7777-4777-8777-777777777777";
    const doctor = { id: doctorId, name: "Dr. James Wilson", specialty: "Cardiology" };
    const ownAppointment = { appointment_id: "99999999-9999-4999-8999-999999999999", date: appointmentDate, start_time: "11:00:00", end_time: "11:30:00", status: "confirmed", doctor };
    const slots = [
      { id: slot11Id, availability_id: slot11Id, doctor_id: doctorId, date: appointmentDate, start_time: "11:00:00", end_time: "11:30:00", doctor, capacity: 2, remaining_capacity: 1 },
      { id: slot1130Id, availability_id: slot1130Id, doctor_id: doctorId, date: appointmentDate, start_time: "11:30:00", end_time: "12:00:00", doctor, capacity: 2, remaining_capacity: 2 },
    ];
    const calls = [];
    const engine = createConversationEngine({
      now: () => Date.parse("2026-12-01T12:00:00Z"),
      provider: { generate: async () => ({ text: "I have not confirmed or changed anything. Use the in-app confirmation control if you want to proceed.", toolCalls: [] }) },
      toolExecutor: async ({ name, args }) => {
        calls.push({ name, args });
        if (name === "search_doctors") return { doctors: [doctor] };
        if (name === "get_available_slots" && args.exact_start_time === "11:00") return { slots: [slots[0]] };
        if (name === "get_available_slots" && args.exact_start_time === "11:30") return { slots: [slots[1]] };
        if (name === "get_available_slots") return { slots };
        if (name === "get_patient_appointments") return { appointments: args.from === appointmentDate && args.to === appointmentDate ? [ownAppointment] : [], has_more: false, next_offset: 1 };
        if (name === "prepare_booking_action") return { proposal: { action_type: "book", action_args: args }, requires_patient_confirmation: true };
        throw new Error(`Unexpected tool ${name}`);
      },
    });
    const turns = [];
    let references;
    const send = async (text) => {
      turns.push({ role: "user", content: text });
      const response = await engine.respond({ actor: user, previousReferences: references, messages: turns });
      if (response.internalReferences) references = response.internalReferences;
      turns.push({ role: "assistant", content: response.answer });
      return response;
    };

    const first = await send("I want to book an appointment with Dr. James Wilson.");
    assert.deepEqual(first.results.map(({ tool }) => tool), ["search_doctors"]);
    assert.match(first.answer, /date and time/i);
    const second = await send("I want to book an appointment with him.");
    assert.deepEqual(second.results, []);
    assert.match(second.answer, /date and time/i);
    const third = await send("20 January.");
    assert.deepEqual(third.results.map(({ tool }) => tool), ["get_available_slots"]);
    assert.deepEqual(third.results[0].data.slots.map(({ date }) => date), [appointmentDate, appointmentDate]);
    assert.equal(third.internalReferences.pending_target_date, appointmentDate);
    const fourth = await send("11 AM.");
    assert.match(fourth.answer, /already have a confirmed appointment with Dr\. James Wilson on 2027-01-20 at 11:00/i);
    assert.deepEqual(fourth.results, []);
    const fifth = await send("11:30 AM.");
    assert.deepEqual(fifth.results.map(({ tool }) => tool), ["prepare_booking_action"]);
    assert.equal(calls.find(({ name }) => name === "prepare_booking_action").args.availability_id, slot1130Id);
    assert.match(fifth.answer, /no confirmation intent has been created/i);
    const sixth = await send("Okay 11:30 AM.");
    const seventh = await send("Okay.");
    assert.deepEqual(sixth.results, []);
    assert.deepEqual(seventh.results, []);
    assert.equal(calls.filter(({ name }) => name === "search_doctors").length, 1);
    assert.equal(calls.filter(({ name }) => name === "prepare_booking_action").length, 1);
    assert.equal(calls.some(({ name }) => /confirm|cancel|reschedule|payment|execute/i.test(name)), false);
  });

  it("recovers from a stale displayed January 28 slot, keeps the alternative list, and blocks natural-language confirmation execution", async () => {
    const date = "2027-01-28";
    const doctor = { id: doctorId, name: "Dr. James Wilson" };
    const slotIds = {
      noon: "88888888-8888-4888-8888-888888888888",
      halfPast: "77777777-7777-4777-8777-777777777777",
      oneThirty: "66666666-6666-4666-8666-666666666666",
    };
    const slots = [
      { id: slotIds.noon, availability_id: slotIds.noon, doctor_id: doctorId, date, start_time: "12:00:00", end_time: "12:30:00", doctor, capacity: 2, remaining_capacity: 2 },
      { id: slotIds.halfPast, availability_id: slotIds.halfPast, doctor_id: doctorId, date, start_time: "12:30:00", end_time: "13:00:00", doctor, capacity: 2, remaining_capacity: 2 },
      { id: slotIds.oneThirty, availability_id: slotIds.oneThirty, doctor_id: doctorId, date, start_time: "13:30:00", end_time: "14:00:00", doctor, capacity: 2, remaining_capacity: 2 },
    ];
    const calls = [];
    let oneThirtyRevalidated = false;
    const engine = createConversationEngine({
      now: () => Date.parse("2026-12-01T12:00:00Z"),
      provider: { generate: async () => { throw new Error("the booking state machine must handle known booking selections without model tool loops"); } },
      toolExecutor: async ({ name, args }) => {
        calls.push({ name, args });
        if (name === "search_doctors") return { doctors: [doctor] };
        if (name === "get_available_slots" && args.exact_start_time === "13:30") { oneThirtyRevalidated = true; return { slots: [] }; }
        if (name === "get_available_slots" && args.exact_start_time === "12:30") return { slots: [slots[1]] };
        if (name === "get_available_slots") return { slots: oneThirtyRevalidated ? slots.slice(0, 2) : slots };
        if (name === "get_patient_appointments") return { appointments: [], has_more: false, next_offset: 0 };
        if (name === "prepare_booking_action") return { proposal: { action_type: "book", action_args: args }, requires_patient_confirmation: true };
        throw new Error(`Unexpected tool ${name}`);
      },
    });
    const messages = [];
    let references;
    const send = async (content, previousProposal) => {
      messages.push({ role: "user", content });
      const response = await engine.respond({ actor: user, messages, previousReferences: references, previousProposal });
      if (response.internalReferences) references = response.internalReferences;
      messages.push({ role: "assistant", content: response.answer });
      return response;
    };

    const namedDoctor = await send("I want to book an appointment with Dr. James Wilson.");
    assert.match(namedDoctor.answer, /date and time/i);
    const slotsForDate = await send("January 28, 2027.");
    assert.deepEqual(slotsForDate.results[0].data.slots.map(({ start_time }) => start_time), ["12:00:00", "12:30:00", "13:30:00"]);
    assert.equal(slotsForDate.internalReferences.pending_target_date, date);
    const staleSelection = await send("1:30 PM.");
    assert.match(staleSelection.answer, /displayed 1:30 PM option.*no longer available/i);
    assert.deepEqual(staleSelection.results[0].data.slots.map(({ start_time }) => start_time), ["12:00:00", "12:30:00"]);
    assert.equal(staleSelection.internalReferences.pending_target_date, date);
    const selectedAlternative = await send("12:30 PM.");
    assert.deepEqual(selectedAlternative.results.map(({ tool }) => tool), ["prepare_booking_action"]);
    assert.equal(calls.find(({ name }) => name === "prepare_booking_action").args.availability_id, slotIds.halfPast);
    assert.deepEqual(calls.find(({ name, args }) => name === "get_available_slots" && args.exact_start_time === "12:30").args,
      { doctor_id: doctorId, from: date, to: date, exact_start_time: "12:30" });
    assert.equal(calls.filter(({ name }) => name === "search_doctors").length, 1);

    const yesAfterProposal = await send("Yes.", { action_type: "book", assistant_message_id: "proposal-message" });
    assert.match(yesAfterProposal.answer, /in-app confirmation control/i);
    const repeatedDate = await send("January 28, 2027.", { action_type: "book", assistant_message_id: "proposal-message" });
    const changedTime = await send("12:00 PM.", { action_type: "book", assistant_message_id: "proposal-message" });
    const okayBook = await send("Okay, book this appointment.", { action_type: "book", assistant_message_id: "proposal-message" });
    assert.deepEqual(yesAfterProposal.results, []);
    assert.deepEqual(repeatedDate.results, []);
    assert.deepEqual(changedTime.results, []);
    assert.match(okayBook.answer, /does not book the appointment/i);
    assert.equal(calls.filter(({ name }) => name === "search_doctors").length, 1);
    assert.equal(calls.filter(({ name }) => name === "prepare_booking_action").length, 1);
    assert.equal(calls.some(({ name }) => /confirm|execute|create_booking/i.test(name)), false);
  });

  it("uses a stored direct slot question to resolve yes through fresh availability and proposal preparation", async () => {
    const date = "2027-01-28";
    const slotId = "88888888-8888-4888-8888-888888888888";
    const doctor = { id: doctorId, name: "Dr. James Wilson" };
    const slot = { id: slotId, availability_id: slotId, doctor_id: doctorId, date, start_time: "12:30:00", end_time: "13:00:00", doctor, capacity: 2, remaining_capacity: 2 };
    const calls = [];
    const engine = createConversationEngine({
      now: () => Date.parse("2026-12-01T12:00:00Z"),
      provider: { generate: async () => { throw new Error("affirmative slot confirmation is deterministic"); } },
      toolExecutor: async ({ name, args }) => {
        calls.push({ name, args });
        if (name === "get_patient_appointments") return { appointments: [], has_more: false, next_offset: 0 };
        if (name === "get_available_slots") return { slots: [slot] };
        if (name === "prepare_booking_action") return { proposal: { action_type: "book", action_args: args }, requires_patient_confirmation: true };
        throw new Error(`Unexpected tool ${name}`);
      },
    });
    const response = await engine.respond({ actor: user, previousReferences: {
      version: 1, reference_timestamps: { doctors: "2026-12-01T12:00:00.000Z", slots: "2026-12-01T12:00:00.000Z" },
      pending_action: "book", pending_target_date: date, pending_slot_id: slotId, pending_response: "slot_confirmation",
      last_assistant_question: "Would you like me to prepare the booking proposal for 12:30 PM?",
      appointments: [], slots: [slot], doctors: [doctor], slot_query: { doctor_id: doctorId, from: date, to: date },
    }, messages: [{ role: "user", content: "Yes." }] });
    assert.deepEqual(calls.map(({ name }) => name), ["get_patient_appointments", "get_available_slots", "prepare_booking_action"]);
    assert.deepEqual(calls[1].args, { doctor_id: doctorId, from: date, to: date, exact_start_time: "12:30" });
    assert.equal(calls[2].args.availability_id, slotId);
    assert.equal(response.results[0].tool, "prepare_booking_action");
    assert.match(response.answer, /no confirmation intent has been created/i);
  });

  it("detects an owned exact appointment for a named doctor and explicit date/time request", async () => {
    const date = "2026-11-20";
    const doctor = { id: doctorId, name: "Dr. James Wilson" };
    const appointment = { appointment_id: "99999999-9999-4999-8999-999999999999", date, start_time: "09:00:00", status: "confirmed", doctor };
    const calls = [];
    const engine = createConversationEngine({
      now: () => Date.parse("2026-11-16T00:00:00Z"),
      provider: { generate: async () => { throw new Error("an exact named booking is deterministic"); } },
      toolExecutor: async ({ name, args }) => {
        calls.push({ name, args });
        if (name === "search_doctors") return { doctors: [doctor] };
        if (name === "get_patient_appointments") return { appointments: [appointment], has_more: false, next_offset: 1 };
        throw new Error(`Unexpected tool ${name}`);
      },
    });
    const result = await engine.respond({ actor: user, messages: [{ role: "user", content: "Book an appointment with Dr. James Wilson on November 20, 2026 at 9:00 AM" }] });
    assert.match(result.answer, /already have a confirmed appointment with Dr\. James Wilson on 2026-11-20 at 09:00/i);
    assert.deepEqual(calls.map(({ name }) => name), ["search_doctors", "get_patient_appointments"]);
    assert.doesNotMatch(JSON.stringify(result.results), /prepare_booking_action/);
  });

  it("resolves a displayed natural-time slot, revalidates it, and prepares only the current slot", async () => {
    const date = "2026-11-20";
    const slotId = "88888888-8888-4888-8888-888888888888";
    const doctor = { id: doctorId, name: "Dr. James Wilson" };
    const displayedSlot = { availability_id: slotId, id: slotId, doctor_id: doctorId, doctor, date, start_time: "11:00:00", end_time: "11:30:00", capacity: 2, remaining_capacity: 2 };
    const calls = [];
    const engine = createConversationEngine({
      now: () => Date.parse("2026-11-19T00:00:00Z"),
      provider: { generate: async () => { throw new Error("a time selection must resolve against displayed slot context"); } },
      toolExecutor: async ({ name, args }) => {
        calls.push({ name, args });
        if (name === "get_patient_appointments") return { appointments: [], has_more: false, next_offset: 0 };
        if (name === "get_available_slots") return { slots: [displayedSlot] };
        if (name === "prepare_booking_action") return { proposal: { action_type: "book", action_args: args }, requires_patient_confirmation: true };
        throw new Error(`Unexpected tool ${name}`);
      },
    });
    const result = await engine.respond({ actor: user, previousReferences: {
      version: 1, reference_timestamps: { doctors: "2026-11-19T00:00:00.000Z", slots: "2026-11-19T00:00:00.000Z" },
      pending_action: "book", appointments: [], slots: [displayedSlot], doctors: [doctor],
      slot_query: { doctor_id: doctorId, from: date, to: date },
    }, messages: [{ role: "user", content: "11 AM" }] });
    assert.deepEqual(calls.map(({ name }) => name), ["get_patient_appointments", "get_available_slots", "prepare_booking_action"]);
    assert.deepEqual(calls[1].args, { doctor_id: doctorId, from: date, to: date, exact_start_time: "11:00" });
    assert.equal(calls[2].args.availability_id, slotId);
    assert.deepEqual(result.results.map(({ tool }) => tool), ["prepare_booking_action"]);
    assert.match(result.answer, /no confirmation intent has been created/i);
  });

  it("refreshes alternatives when a previously displayed natural-time slot is no longer available", async () => {
    const date = "2026-11-20";
    const doctor = { id: doctorId, name: "Dr. James Wilson" };
    const displayedSlot = { availability_id: "88888888-8888-4888-8888-888888888888", id: "88888888-8888-4888-8888-888888888888", doctor_id: doctorId, doctor, date, start_time: "11:00:00", end_time: "11:30:00", capacity: 2, remaining_capacity: 2 };
    const calls = [];
    const engine = createConversationEngine({
      now: () => Date.parse("2026-11-19T00:00:00Z"),
      provider: { generate: async () => { throw new Error("a displayed slot should be rechecked deterministically"); } },
      toolExecutor: async ({ name, args }) => {
        calls.push({ name, args });
        if (name === "get_patient_appointments") return { appointments: [], has_more: false, next_offset: 0 };
        if (name === "get_available_slots" && args.exact_start_time) return { slots: [] };
        if (name === "get_available_slots") return { slots: [{ ...displayedSlot, availability_id: "77777777-7777-4777-8777-777777777777", id: "77777777-7777-4777-8777-777777777777", start_time: "11:30:00", end_time: "12:00:00" }] };
        throw new Error(`Unexpected tool ${name}`);
      },
    });
    const result = await engine.respond({ actor: user, previousReferences: {
      version: 1, reference_timestamps: { doctors: "2026-11-19T00:00:00.000Z", slots: "2026-11-19T00:00:00.000Z" },
      pending_action: "book", pending_target_date: date, appointments: [], slots: [displayedSlot], doctors: [doctor],
      slot_query: { doctor_id: doctorId, from: date, to: date },
    }, messages: [{ role: "user", content: "11 AM" }] });
    assert.match(result.answer, /displayed 11:00 AM option on 2026-11-20 is no longer available/i);
    assert.deepEqual(calls.map(({ name }) => name), ["get_patient_appointments", "get_available_slots", "get_available_slots"]);
    assert.deepEqual(result.results.map(({ tool }) => tool), ["get_available_slots"]);
    assert.equal(result.internalReferences.slots[0].start_time, "11:30:00");
  });

  it("reschedules this appointment to a different verified doctor using prior patient-owned context", async () => {
    const appointmentId = "99999999-9999-4999-8999-999999999999";
    const targetDoctorId = "77777777-7777-4777-8777-777777777777";
    const slotId = "88888888-8888-4888-8888-888888888888";
    let initialCall = 0;
    const firstEngine = createConversationEngine({
      now: () => Date.parse("2026-12-25T12:00:00Z"),
      provider: { generate: async () => {
        initialCall += 1;
        return initialCall === 1 ? { text: "", toolCalls: [{ name: "get_patient_appointments", arguments: { view: "upcoming", scope: "nearest" }, id: "appointments" }] } : { text: "Here is your appointment.", toolCalls: [] };
      } },
      toolExecutor: async () => ({ appointments: [{ appointment_id: appointmentId, id: appointmentId, date: "2027-01-05", start_time: "09:00:00", end_time: "09:30:00", status: "confirmed", doctor: { id: doctorId, name: "Dr. Ada Morgan" } }] }),
    });
    const first = await firstEngine.respond({ actor: user, messages: [{ role: "user", content: "Show my next appointment." }] });
    const calls = [];
    const secondEngine = createConversationEngine({
      now: () => Date.parse("2026-12-25T12:00:00Z"),
      provider: { generate: async () => { throw new Error("contextual reschedule should route before Gemini"); } },
      toolExecutor: async ({ name, args }) => {
        calls.push({ name, args });
        if (name === "search_doctors") return { doctors: [{ id: targetDoctorId, name: "Dr. James Wilson" }] };
        if (name === "get_available_slots") return { slots: [{ id: slotId, availability_id: slotId, doctor_id: targetDoctorId, date: "2027-01-07", start_time: "10:00:00", end_time: "10:30:00", doctor: { id: targetDoctorId, name: "Dr. James Wilson" } }] };
        return { proposal: { action_type: "reschedule", action_args: args }, requires_patient_confirmation: true };
      },
    });
    const second = await secondEngine.respond({ actor: user, messages: [{ role: "user", content: "Can you reschedule this appointment to Dr. James on 7 January at 10 AM?" }], previousReferences: first.internalReferences });
    assert.deepEqual(calls.map(({ name }) => name), ["search_doctors", "get_available_slots", "prepare_reschedule_action"], second.answer);
    assert.deepEqual(calls[1].args, { doctor_id: targetDoctorId, from: "2027-01-07", to: "2027-01-07", exact_start_time: "10:00" });
    assert.deepEqual(calls[2].args, { appointment_id: appointmentId, availability_id: slotId });
    assert.match(second.answer, /rescheduling proposal for 2027-01-07 at 10:00/);
    assert.equal(JSON.stringify({ answer: second.answer, results: second.results }).includes(appointmentId), false);
    assert.equal(initialCall, 0);
  });

  it("asks which prior appointment when a contextual reschedule reference is ambiguous", async () => {
    const references = { version: 1, captured_at: new Date().toISOString(), appointments: [
      { id: "99999999-9999-4999-8999-999999999999", appointment_id: "99999999-9999-4999-8999-999999999999", status: "confirmed", date: "2027-01-05", start_time: "09:00:00", doctor: { id: doctorId, name: "Dr. Ada Morgan" } },
      { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", appointment_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", status: "confirmed", date: "2027-01-06", start_time: "10:00:00", doctor: { id: doctorId, name: "Dr. Ada Morgan" } },
    ], slots: [], doctors: [] };
    let calls = 0;
    const engine = createConversationEngine({
      provider: { generate: async () => { throw new Error("ambiguous reference must stop before search"); } },
      toolExecutor: async () => { calls += 1; return {}; },
    });
    const result = await engine.respond({ actor: user, previousReferences: references, messages: [{ role: "user", content: "Reschedule this appointment to Dr. James on 7 January at 10 AM." }] });
    assert.match(result.answer, /More than one confirmed appointment matches/);
    assert.equal(calls, 0);
  });

  it("preserves exact reschedule start and end times and rejects an adjacent slot", async () => {
    const targetDate = "2027-01-06";
    const appointmentId = "99999999-9999-4999-8999-999999999999";
    const availabilityId = "88888888-8888-4888-8888-888888888888";
    const doctor = { id: doctorId, name: "Dr. Ada Morgan" };
    let prepared = 0;
    const engine = createConversationEngine({
      provider: { generate: async () => ({ text: "Available times", toolCalls: [{ name: "get_patient_appointments", arguments: { view: "upcoming", scope: "all" }, id: "appointments" }] }) },
      toolExecutor: async ({ name, args }) => {
        if (name === "get_patient_appointments") return { appointments: [{ appointment_id: appointmentId, date: "2026-12-20", start_time: "09:00:00", end_time: "09:30:00", status: "confirmed", doctor }] };
        if (name === "get_available_slots") return { slots: [{ availability_id: availabilityId, doctor_id: doctorId, date: targetDate, start_time: "11:30:00", end_time: "12:00:00", doctor }] };
        prepared += 1;
        return { proposal: { action_type: "reschedule", action_args: args }, requires_patient_confirmation: true };
      },
    });
    const response = await engine.respond({ actor: user, messages: [{ role: "user", content: `Move my appointment with Dr. Ada Morgan on 2026-12-20 at 09:00 to ${targetDate} at 11:00 AM–11:30 AM` }] });
    assert.equal(prepared, 0);
    assert.match(response.answer, /exact date and time is not available|choose another time/i);
    assert.doesNotMatch(response.answer, /11:30.*proposal/i);
  });

  it("prepares cancellation only for a unique owned appointment match and explains actual ambiguities", async () => {
    const appointmentId = "99999999-9999-4999-8999-999999999999";
    const appointment = { appointment_id: appointmentId, date: "2026-12-20", start_time: "09:00:00", end_time: "09:30:00", status: "confirmed", doctor: { id: doctorId, name: "Dr. Ada Morgan" } };
    let prepared = 0;
    const makeEngine = (appointments) => createConversationEngine({
      provider: { generate: async () => ({ text: "", toolCalls: [{ name: "get_patient_appointments", arguments: { view: "upcoming", scope: "all" }, id: "appointments" }] }) },
      toolExecutor: async ({ name, args }) => {
        if (name === "get_patient_appointments") {
          assert.equal(args.view, "upcoming");
          assert.equal(args.scope, "all");
          assert.equal(args.from, "2026-12-20");
          assert.equal(args.to, "2026-12-20");
          return { appointments };
        }
        prepared += 1;
        return { proposal: { action_type: "cancel", action_args: args }, requires_patient_confirmation: true };
      },
    });
    const userText = "Cancel my appointment with Dr. Ada Morgan on December 20, 2026 at 9:00 a.m.–9:30 a.m.";
    const unique = await makeEngine([appointment]).respond({ actor: user, messages: [{ role: "user", content: userText }] });
    assert.equal(prepared, 1);
    assert.match(unique.answer, /cancellation proposal.*2026-12-20 at 09:00.*09:30/i);
    assert.match(unique.answer, /no confirmation intent has been created/);
    assert.deepEqual(unique.internalActionContext, { action_type: "cancel", appointment_id: appointmentId });
    assert.equal(unique.internalProposalEvidence.action_type, "cancel");
    assert.equal(unique.internalProposalEvidence.verified_appointment_id, appointmentId);
    assert.equal(JSON.stringify({ answer: unique.answer, results: unique.results }).includes(appointmentId), false);
    const startOnly = await makeEngine([appointment]).respond({ actor: user, messages: [{ role: "user", content: "Cancel my appointment with Dr. Ada Morgan on December 20, 2026 at 9:00 AM" }] });
    assert.equal(prepared, 2);
    assert.match(startOnly.answer, /cancellation proposal.*2026-12-20 at 09:00.*09:30/i);
    const second = { ...appointment, appointment_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" };
    const ambiguous = await makeEngine([appointment, second]).respond({ actor: user, messages: [{ role: "user", content: userText }] });
    assert.equal(prepared, 2);
    assert.match(ambiguous.answer, /multiple matching appointments/i);
    assert.match(ambiguous.answer, /2026-12-20 09:00 to 09:30/);
  });

  it("routes natural cancellation requests through owner-scoped matching before any model list response", async () => {
    const appointmentId = "99999999-9999-4999-8999-999999999999";
    const appointment = { id: appointmentId, appointment_id: appointmentId, date: "2027-01-20", start_time: "11:00:00", end_time: "11:30:00", status: "confirmed", doctor: { id: doctorId, name: "Dr. James Wilson" } };
    for (const content of [
      "Could you cancel Dr. James on 20 January 2027 at 11:00 AM?",
      "I'd like to cancel my visit with Dr James Wilson on January 20, 2027 at 11 AM.",
    ]) {
      const calls = [];
      const engine = createConversationEngine({
        provider: { generate: async () => { throw new Error("a uniquely identified cancellation must not fall back to a generic list response"); } },
        toolExecutor: async ({ name, args }) => {
          calls.push({ name, args });
          if (name === "get_patient_appointments") return { appointments: [appointment], has_more: false };
          return { proposal: { action_type: "cancel", action_args: args }, requires_patient_confirmation: true };
        },
      });
      const response = await engine.respond({ actor: user, messages: [{ role: "user", content }] });
      assert.deepEqual(calls.map(({ name }) => name), ["get_patient_appointments", "prepare_cancellation_action"], content);
      assert.deepEqual(calls[1].args, { appointment_id: appointmentId }, content);
      assert.match(response.answer, /cancellation proposal.*2027-01-20 at 11:00.*11:30/i, content);
      assert.equal(JSON.stringify({ answer: response.answer, results: response.results }).includes(appointmentId), false);
    }
  });

  it("deterministically resolves an explicit cross-doctor reschedule before generic model lookups", async () => {
    const sourceAppointmentId = "99999999-9999-4999-8999-999999999999";
    const targetDoctorId = "77777777-7777-4777-8777-777777777777";
    const targetSlotId = "88888888-8888-4888-8888-888888888888";
    const sourceDoctor = { id: doctorId, name: "Dr. Source Provider" };
    const targetDoctor = { id: targetDoctorId, name: "Dr. Destination Provider" };
    const calls = [];
    const engine = createConversationEngine({
      now: () => Date.parse("2026-11-15T00:00:00Z"),
      provider: { generate: async () => { throw new Error("explicit cross-doctor rescheduling must complete through verified deterministic orchestration"); } },
      toolExecutor: async ({ name, args }) => {
        calls.push({ name, args });
        if (name === "get_patient_appointments") return { appointments: [{ id: sourceAppointmentId, appointment_id: sourceAppointmentId, date: "2027-01-05", start_time: "09:00:00", end_time: "09:30:00", status: "confirmed", doctor: sourceDoctor }] };
        if (name === "search_doctors") return { doctors: [targetDoctor] };
        if (name === "get_available_slots") return { slots: [{ id: targetSlotId, availability_id: targetSlotId, doctor_id: targetDoctorId, date: "2027-01-07", start_time: "10:00:00", end_time: "10:30:00", doctor: targetDoctor }] };
        return { proposal: { action_type: "reschedule", action_args: args }, requires_patient_confirmation: true };
      },
    });
    const sourceDate = "5 January 2027";
    const targetDate = "7 January 2027";
    const response = await engine.respond({ actor: user, messages: [{ role: "user", content: `I want to reschedule my appointment with ${sourceDoctor.name} on ${sourceDate} at 9:00 AM–9:30 AM to ${targetDoctor.name} on ${targetDate} at 10:00 AM–10:30 AM.` }] });
    assert.deepEqual(calls.map(({ name }) => name), ["get_patient_appointments", "search_doctors", "get_available_slots", "prepare_reschedule_action"]);
    assert.equal(calls[0].args.view, "upcoming");
    assert.equal(calls[1].args.name, "Destination Provider");
    assert.equal(calls[2].args.doctor_id, targetDoctorId);
    assert.deepEqual(calls[3].args, { appointment_id: sourceAppointmentId, availability_id: targetSlotId });
    assert.match(response.answer, /rescheduling proposal.*2027-01-07 at 10:00.*10:30 with Dr\. Destination Provider/i);
  });

  it("matches cancellation ranges when AM/PM is omitted from either endpoint", async () => {
    const appointmentId = "99999999-9999-4999-8999-999999999999";
    const row = { appointment_id: appointmentId, date: "2027-01-20", start_time: "11:00:00", end_time: "11:30:00", status: "confirmed", mode: "wave", doctor: { id: doctorId, name: "Dr. James Wilson" } };
    const messages = [
      "I want to cancel my appointment with Dr. James on 20 January at 11:00 AM–11:30",
      "I want to cancel my appointment with Dr. James on 20 January at 11:00 AM–11:30 AM",
      "I want to cancel my appointment with Dr. James on 20 January at 11:00–11:30 AM",
      "I want to cancel my appointment with Dr. James on 20 January at 11:00 AM",
    ];
    for (const content of messages) {
      const executed = [];
      const engine = createConversationEngine({
        provider: { generate: async () => ({ text: "", toolCalls: [{ name: "get_patient_appointments", arguments: { view: "upcoming", scope: "nearest" }, id: "appointments" }] }) },
        toolExecutor: async ({ name, args }) => {
          if (name === "get_patient_appointments") {
            assert.equal(args.scope, "all");
            assert.equal(args.from, "2027-01-20");
            assert.equal(args.to, "2027-01-20");
            return { appointments: [row] };
          }
          executed.push({ name, args });
          return { proposal: { action_type: "cancel", action_args: args }, requires_patient_confirmation: true };
        },
      });
      const result = await engine.respond({ actor: user, messages: [{ role: "user", content }] });
      assert.deepEqual(executed, [{ name: "prepare_cancellation_action", args: { appointment_id: appointmentId } }]);
      assert.match(result.answer, /2027-01-20 at 11:00–11:30 with Dr\. James Wilson/);
      assert.match(result.answer, /only a proposal/);
      assert.equal(JSON.stringify(result.results).includes(appointmentId), false);
    }
  });

  it("matches a unique start time with omitted AM/PM and asks only when both interpretations match", async () => {
    const afternoon = { appointment_id: "99999999-9999-4999-8999-999999999999", date: "2027-01-22", start_time: "13:30:00", end_time: "14:00:00", status: "confirmed", doctor: { id: doctorId, name: "Dr. James Wilson" } };
    const morning = { ...afternoon, appointment_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", start_time: "01:30:00", end_time: "02:00:00" };
    let prepared = [];
    const makeEngine = (appointments) => createConversationEngine({
      provider: { generate: async () => ({ text: "", toolCalls: [{ name: "get_patient_appointments", arguments: { view: "upcoming", scope: "all" }, id: "appointments" }] }) },
      toolExecutor: async ({ name, args }) => {
        if (name === "get_patient_appointments") return { appointments };
        prepared.push(args.appointment_id);
        return { proposal: { action_type: "cancel", action_args: args }, requires_patient_confirmation: true };
      },
    });
    const request = "I want to cancel my appointment with Dr. James on 22 January at 1:30.";
    const unique = await makeEngine([afternoon]).respond({ actor: user, messages: [{ role: "user", content: request }] });
    assert.deepEqual(prepared, []);
    assert.match(unique.answer, /AM.*PM/i);
    assert.equal(JSON.stringify({ answer: unique.answer, results: unique.results }).includes(afternoon.appointment_id), false);

    prepared = [];
    const ambiguous = await makeEngine([morning, afternoon]).respond({ actor: user, messages: [{ role: "user", content: request }] });
    assert.deepEqual(prepared, []);
    assert.match(ambiguous.answer, /Did you mean 1:30 AM or 1:30 PM\?/);
  });

  it("answers refund questions from verified preview data and states when no appointment was checked", async () => {
    const appointmentId = "99999999-9999-4999-8999-999999999999";
    const verifiedPreview = { original_payment: { amount: "500.00", currency: "INR", status: "partially_refunded" }, processed_refund_amount: "100.00", pending_refund_amount: "50.00", estimated_additional_refund_amount: "100.00", currency: "INR", refund_expected: true, explanation: "Estimate only." };
    let providerCall = 0;
    const engine = createConversationEngine({
      provider: { generate: async () => {
        providerCall += 1;
        if (providerCall === 1) return { text: "", toolCalls: [{ name: "get_patient_appointments", arguments: { view: "upcoming", scope: "all" }, id: "appointments" }] };
        if (providerCall === 2) return { text: "", toolCalls: [{ name: "get_cancellation_refund_preview", arguments: { appointment_id: appointmentId }, id: "refund" }] };
        return { text: "A refund of INR 999 has been processed.", toolCalls: [] };
      } },
      toolExecutor: async ({ name }) => name === "get_patient_appointments"
        ? { appointments: [{ appointment_id: appointmentId, date: "2026-12-20", start_time: "09:00:00", doctor: { id: doctorId, name: "Dr. Ada Morgan" } }] }
        : verifiedPreview,
    });
    const answer = await engine.respond({ actor: user, messages: [{ role: "user", content: "What is my refund for the appointment?" }] });
    assert.match(answer.answer, /processed refunds total INR 100\.00/);
    assert.match(answer.answer, /pending refunds total INR 50\.00/);
    assert.match(answer.answer, /estimated additional refund is INR 100\.00/);
    assert.doesNotMatch(answer.answer, /999/);

    const missing = createConversationEngine({ provider: { generate: async () => ({ text: "You are owed INR 500.", toolCalls: [] }) }, toolExecutor: async () => ({}) });
    const noRecord = await missing.respond({ actor: user, messages: [{ role: "user", content: "What refund will I get?" }] });
    assert.match(noRecord.answer, /can't determine a refund amount.*specific appointment's payment record/i);
  });

  it("resolves a cancellation refund follow-up from private prior context without asking Gemini for an ID", async () => {
    const appointmentId = "99999999-9999-4999-8999-999999999999";
    const preview = { original_payment: { amount: "500.00", currency: "INR", status: "partially_refunded" }, processed_refund_amount: "100.00", pending_refund_amount: "25.00", estimated_additional_refund_amount: "125.00", currency: "INR", explanation: "This is an estimate. The backend will recalculate the refund when you confirm cancellation." };
    let providerCalls = 0;
    let toolCall;
    const engine = createConversationEngine({
      provider: { generate: async () => { providerCalls += 1; return { text: "", toolCalls: [{ name: "get_patient_appointments", arguments: { view: "upcoming", scope: "all" }, id: "wrong-fallback" }] }; } },
      toolExecutor: async (input) => { toolCall = input; return preview; },
    });
    const response = await engine.respond({
      actor: user,
      messages: [
        { role: "user", content: "Cancel my appointment with Dr. James on 20 January at 11:00 AM–11:30" },
        { role: "assistant", content: "I prepared a cancellation proposal." },
        { role: "user", content: "What refund should I expect if I cancel this appointment?" },
      ],
      previousActionContext: { action_type: "cancel", appointment_id: appointmentId },
    });
    assert.equal(providerCalls, 0);
    assert.equal(toolCall.name, "get_cancellation_refund_preview");
    assert.deepEqual(toolCall.args, { appointment_id: appointmentId });
    assert.equal(toolCall.actor.id, userId);
    assert.match(response.answer, /partially_refunded/);
    assert.match(response.answer, /processed refunds total INR 100\.00/);
    assert.match(response.answer, /pending refunds total INR 25\.00/);
    assert.match(response.answer, /estimated additional refund is INR 125\.00/);
    assert.match(response.answer, /final refund is recalculated when you confirm cancellation/i);
    assert.equal((response.answer.match(/this is an estimate/gi) || []).length, 1);
    assert.deepEqual(response.results.map(({ tool }) => tool), ["get_cancellation_refund_preview"]);
    assert.equal(JSON.stringify({ answer: response.answer, results: response.results }).includes(appointmentId), false);
    assert.deepEqual(response.internalActionContext, { action_type: "cancel", appointment_id: appointmentId });
  });

  it("previews refunds for an explicitly identified upcoming appointment without cancelling it", async () => {
    const appointmentId = "99999999-9999-4999-8999-999999999999";
    const appointmentDate = "2027-01-20";
    const appointment = { id: appointmentId, appointment_id: appointmentId, date: appointmentDate, start_time: "11:00:00", end_time: "11:30:00", status: "confirmed", doctor: { id: doctorId, name: "Dr. Example Provider" } };
    const calls = [];
    const engine = createConversationEngine({
      now: () => Date.parse("2026-11-15T00:00:00Z"),
      provider: { generate: async () => { throw new Error("identified refund requests are resolved from verified appointment data"); } },
      toolExecutor: async ({ name, args }) => {
        calls.push({ name, args });
        if (name === "get_patient_appointments" && args.view === "upcoming") return { appointments: [appointment], has_more: false };
        if (name === "get_patient_appointments") return { appointments: [], has_more: false };
        if (name === "get_cancellation_refund_preview") return { original_payment: { amount: "500.00", currency: "INR", status: "paid" }, processed_refund_amount: "0.00", pending_refund_amount: "0.00", estimated_additional_refund_amount: "250.00", currency: "INR", explanation: "" };
        throw new Error(`Unexpected tool ${name}`);
      },
    });
    const first = await engine.respond({ actor: user, messages: [{ role: "user", content: "Show my upcoming appointments" }] });
    const followup = await engine.respond({
      actor: user,
      previousReferences: first.internalReferences,
      messages: [
        { role: "user", content: "Show my upcoming appointments" },
        { role: "assistant", content: first.answer },
        { role: "user", content: `What estimated refund if I cancel my appointment with ${appointment.doctor.name} on ${appointmentDate} at 11:00 AM?` },
      ],
    });
    assert.deepEqual(calls.slice(-3).map(({ name, args }) => [name, args.view, args.from]), [
      ["get_patient_appointments", "upcoming", appointmentDate],
      ["get_patient_appointments", "past", appointmentDate],
      ["get_cancellation_refund_preview", undefined, undefined],
    ]);
    assert.deepEqual(followup.results.map(({ tool }) => tool), ["get_cancellation_refund_preview"]);
    assert.match(followup.answer, /estimated additional refund is INR 250\.00/i);
    assert.equal(calls.some(({ name }) => name === "prepare_cancellation_action"), false);
  });

  it("asks for a target or explains missing payment data without listing appointments", async () => {
    let providerCalls = 0;
    let toolCalls = 0;
    const engine = createConversationEngine({
      provider: { generate: async () => { providerCalls += 1; return { text: "", toolCalls: [{ name: "get_patient_appointments", arguments: { view: "upcoming", scope: "all" }, id: "fallback" }] }; } },
      toolExecutor: async () => { toolCalls += 1; return {}; },
    });
    const missingContext = await engine.respond({ actor: user, messages: [{ role: "user", content: "What refund should I expect for this appointment?" }] });
    assert.match(missingContext.answer, /Which appointment do you mean/);
    assert.deepEqual(missingContext.results, []);

    const noPayment = await engine.respond({
      actor: user,
      messages: [{ role: "user", content: "What refund should I expect for this appointment?" }],
      previousActionContext: { action_type: "cancel", appointment_id: "99999999-9999-4999-8999-999999999999" },
    });
    assert.match(noPayment.answer, /No payment record is associated/);
    assert.match(noPayment.answer, /can't report processed, pending, or estimated refund amounts/);
    assert.deepEqual(noPayment.results.map(({ tool }) => tool), ["get_cancellation_refund_preview"]);
    assert.equal(providerCalls, 0);
    assert.equal(toolCalls, 1);
  });

  it("does not fall back to appointments when the owned refund preview rejects the saved target", async () => {
    let providerCalls = 0;
    const engine = createConversationEngine({
      provider: { generate: async () => { providerCalls += 1; return { text: "Ask another lookup", toolCalls: [{ name: "get_patient_appointments", arguments: { view: "upcoming", scope: "all" }, id: "fallback" }] }; } },
      toolExecutor: async () => { throw Object.assign(new Error("not found"), { code: "APPOINTMENT_NOT_FOUND" }); },
    });
    const response = await engine.respond({ actor: user, messages: [{ role: "user", content: "What refund should I expect for this appointment?" }], previousActionContext: { action_type: "cancel", appointment_id: "99999999-9999-4999-8999-999999999999" } });
    assert.match(response.answer, /couldn't verify that appointment in your account/);
    assert.deepEqual(response.results, []);
    assert.equal(providerCalls, 0);
  });

  it("does not prepare an action for unavailable or ambiguous exact slots or ambiguous appointments", async () => {
    const date = "2099-08-13";
    const returnedDoctorId = "77777777-7777-4777-8777-777777777777";
    const slotId = "88888888-8888-4888-8888-888888888888";
    for (const slots of [[], [
      { availability_id: slotId, doctor_id: returnedDoctorId, date, start_time: "14:30:00" },
      { availability_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", doctor_id: returnedDoctorId, date, start_time: "14:30:00" },
    ]]) {
      let providerCall = 0;
      let prepared = 0;
      const steps = [
        { name: "search_doctors", arguments: { name: "Dr. Ada Morgan" }, id: "search" },
        { name: "get_available_slots", arguments: { doctor_id: returnedDoctorId, from: date, to: date, exact_start_time: "14:30" }, id: "slots" },
        { name: "prepare_booking_action", arguments: { availability_id: slotId }, id: "prepare" },
      ];
      const engine = createConversationEngine({
        provider: { generate: async () => {
          providerCall += 1;
          if (providerCall <= steps.length) return { text: "", toolCalls: [steps[providerCall - 1]] };
          return { text: "That requested time is unavailable or ambiguous. Please choose or clarify.", toolCalls: [] };
        } },
        toolExecutor: async ({ name }) => {
          if (name === "search_doctors") return { doctors: [{ id: returnedDoctorId, name: "Dr. Ada Morgan" }] };
          if (name === "get_available_slots") return { slots };
          if (name === "get_patient_appointments") return { appointments: [], has_more: false };
          prepared += 1;
          return { requires_patient_confirmation: true };
        },
      });
      const response = await engine.respond({ actor: user, messages: [{ role: "user", content: `Book with Dr. Ada Morgan on ${date} at 14:30` }] });
      assert.equal(prepared, 0);
      assert.match(response.answer, /not available|More than one slot/);
    }

    let providerCall = 0;
    let preparedReschedule = 0;
    const appointmentId = "99999999-9999-4999-8999-999999999999";
    const ambiguousEngine = createConversationEngine({
      provider: { generate: async () => {
        providerCall += 1;
        if (providerCall === 1) return { text: "", toolCalls: [{ name: "get_patient_appointments", arguments: { view: "upcoming", scope: "all" }, id: "appointments" }] };
        if (providerCall === 2) return { text: "", toolCalls: [{ name: "get_available_slots", arguments: { doctor_id: returnedDoctorId, from: date, to: date, exact_start_time: "14:30" }, id: "slots" }] };
        if (providerCall === 3) return { text: "", toolCalls: [{ name: "prepare_reschedule_action", arguments: { appointment_id: appointmentId, availability_id: slotId }, id: "prepare" }] };
        return { text: "Which appointment do you mean?", toolCalls: [] };
      } },
      toolExecutor: async ({ name }) => {
        if (name === "get_patient_appointments") return { appointments: [
          { appointment_id: appointmentId, date: "2099-08-10", start_time: "10:00:00", doctor: { id: returnedDoctorId, name: "Dr. Ada Morgan" } },
          { appointment_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", date: "2099-08-10", start_time: "11:00:00", doctor: { id: returnedDoctorId, name: "Dr. Ada Morgan" } },
        ] };
        if (name === "get_available_slots") return { slots: [{ availability_id: slotId, doctor_id: returnedDoctorId, date, start_time: "14:30:00" }] };
        preparedReschedule += 1;
        return { requires_patient_confirmation: true };
      },
    });
    const response = await ambiguousEngine.respond({ actor: user, messages: [{ role: "user", content: `Move my appointment to ${date} at 14:30` }] });
    assert.equal(preparedReschedule, 0);
    assert.match(response.answer, /specific appointment to change/);
  });

  it("does not present a model claim as a prepared proposal or persisted intent", async () => {
    let executedTools = 0;
    const engine = createConversationEngine({
      provider: { generate: async () => ({ text: "I prepared your booking proposal and created a confirmation intent.", toolCalls: [] }) },
      toolExecutor: async () => { executedTools += 1; return {}; },
    });
    const response = await engine.respond({ actor: user, messages: [{ role: "user", content: "Can you book for me?" }] });
    assert.equal(executedTools, 0);
    assert.match(response.answer, /have not prepared an appointment proposal or created a confirmation intent/);
    assert.deepEqual(response.results, []);
  });

  it("keeps patient navigation IDs in UI metadata and strips them from model and persisted card results", async () => {
    let providerCall = 0;
    let modelToolResult;
    const engine = createConversationEngine({
      provider: { generate: async ({ messages }) => {
        providerCall += 1;
        if (providerCall === 1) return { text: "", toolCalls: [{ name: "get_available_slots", arguments: {}, id: "slots" }] };
        modelToolResult = messages.at(-1).toolResults[0].result;
        return { text: "Choose one of these slots: 33333333-3333-4333-8333-333333333333.", toolCalls: [] };
      } },
      toolExecutor: async () => ({ slots: [{ id: "33333333-3333-4333-8333-333333333333", availability_id: "33333333-3333-4333-8333-333333333333", doctor_id: "22222222-2222-4222-8222-222222222222", date: "2099-08-10", doctor: { id: "22222222-2222-4222-8222-222222222222", name: "Dr. Dee" } }] }),
    });
    const output = await engine.respond({ actor: user, messages: [{ role: "user", content: "Find an appointment" }] });
    assert.equal("id" in modelToolResult.slots[0], false);
    assert.equal("availability_id" in modelToolResult.slots[0], false);
    assert.equal("doctor_id" in modelToolResult.slots[0], false);
    assert.equal("ui_actions" in modelToolResult, false);
    assert.deepEqual(output.results[0].ui_actions, [{ type: "slot", availability_id: "33333333-3333-4333-8333-333333333333", doctor_id: "22222222-2222-4222-8222-222222222222" }]);
    assert.deepEqual(output.results[0].data.slots[0], { date: "2099-08-10", doctor: { name: "Dr. Dee" } });
    assert.equal(JSON.stringify(output.results[0].data).includes("33333333-3333-4333-8333-333333333333"), false);
    assert.equal(output.answer.includes("33333333-3333-4333-8333-333333333333"), false);
  });

  it("blocks parallel doctor searches and availability calls until a later unique resolution", async () => {
    let providerCall = 0;
    let availabilityCalls = 0;
    let searchCalls = 0;
    let secondTurn;
    const engine = createConversationEngine({
      provider: { generate: async ({ messages }) => {
        providerCall += 1;
        if (providerCall === 1) return { text: "", toolCalls: [
          { name: "get_available_slots", arguments: { doctor_id: doctorId }, id: "availability" },
          { name: "search_doctors", arguments: { name: "Ali" }, id: "search" },
        ] };
        secondTurn = messages.at(-1);
        return { text: "Please choose which Dr. Ali you mean.", toolCalls: [] };
      } },
      toolExecutor: async ({ name }) => {
        if (name === "get_available_slots") { availabilityCalls += 1; return { slots: [] }; }
        searchCalls += 1;
        return { doctors: [
          { id: doctorId, name: "Dr. Ali One", specialty: "Cardiology" },
          { id: "66666666-6666-4666-8666-666666666666", name: "Dr. Ali Two", specialty: "Neurology" },
        ] };
      },
    });
    const output = await engine.respond({ actor: user, messages: [{ role: "user", content: "Show Dr. Ali's calendar" }] });
    assert.equal(availabilityCalls, 0);
    assert.equal(searchCalls, 1);
    assert.deepEqual(output.results[0].data.doctors.map(({ name }) => name), ["Dr. Ali One", "Dr. Ali Two"]);
    assert.equal(secondTurn.role, "user");
    assert.equal(secondTurn.toolResults.find(({ name }) => name === "get_available_slots").result.error, "Resolve the doctor in a separate search turn before checking availability.");
  });

  it("returns ambiguity candidates and blocks a later availability call in the same request", async () => {
    let providerCall = 0;
    let availabilityCalls = 0;
    let toolResponse;
    const candidates = [{ id: doctorId, name: "Dr. Ali One" }, { id: "66666666-6666-4666-8666-666666666666", name: "Dr. Ali Two" }];
    const engine = createConversationEngine({
      provider: { generate: async ({ messages }) => {
        providerCall += 1;
        if (providerCall === 1) return { text: "", toolCalls: [{ name: "search_doctors", arguments: { name: "Ali" }, id: "search" }] };
        if (providerCall === 2) {
          return { text: "", toolCalls: [{ name: "get_available_slots", arguments: { doctor_id: doctorId }, id: "availability" }] };
        }
        if (providerCall === 3) {
          toolResponse = messages.at(-1).toolResults[0].result;
          return { text: "Please clarify which doctor.", toolCalls: [] };
        }
        throw new Error("Unexpected provider call");
      } },
      toolExecutor: async ({ name }) => {
        if (name === "get_available_slots") { availabilityCalls += 1; return { slots: [] }; }
        return { doctors: candidates };
      },
    });
    await engine.respond({ actor: user, messages: [{ role: "user", content: "Find Dr. Ali" }] });
    assert.equal(availabilityCalls, 0);
    assert.deepEqual(toolResponse, { error: "Multiple doctors matched; ask the patient to clarify.", clarification_candidates: candidates });
  });

  it("rejects an arbitrary doctor ID without a unique doctor search", async () => {
    let availabilityCalls = 0;
    let providerCall = 0;
    const engine = createConversationEngine({
      provider: { generate: async () => {
        providerCall += 1;
        return providerCall === 1
          ? { text: "", toolCalls: [{ name: "get_available_slots", arguments: { doctor_id: doctorId }, id: "availability" }] }
          : { text: "Search for a doctor first.", toolCalls: [] };
      } },
      toolExecutor: async () => { availabilityCalls += 1; return { slots: [] }; },
    });
    await engine.respond({ actor: user, messages: [{ role: "user", content: "Check availability" }] });
    assert.equal(availabilityCalls, 0);
  });

  it("allows doctor availability only after a unique search result from an earlier tool turn", async () => {
    let providerCall = 0;
    let availabilityCalls = 0;
    const engine = createConversationEngine({
      provider: { generate: async () => {
        providerCall += 1;
        if (providerCall === 1) return { text: "", toolCalls: [{ name: "search_doctors", arguments: { name: "Dr. Dee Doctor" }, id: "search" }] };
        if (providerCall === 2) return { text: "", toolCalls: [{ name: "get_available_slots", arguments: { doctor_id: doctorId }, id: "availability" }] };
        return { text: "Here are the available times.", toolCalls: [] };
      } },
      toolExecutor: async ({ name }) => {
        if (name === "search_doctors") return { doctors: [{ id: doctorId, name: "Dr. Dee Doctor" }] };
        availabilityCalls += 1;
        return { slots: [] };
      },
    });
    await engine.respond({ actor: user, messages: [{ role: "user", content: "Find Dr. Dee Doctor's availability" }] });
    assert.equal(availabilityCalls, 1);
  });

  it("does not fall back to global availability when the current named doctor search has no match", async () => {
    let providerCall = 0;
    let availabilityCalls = 0;
    const engine = createConversationEngine({
      provider: { generate: async () => {
        providerCall += 1;
        if (providerCall === 1) return { text: "", toolCalls: [{ name: "search_doctors", arguments: { name: "Dr. Unknown" }, id: "search" }] };
        if (providerCall === 2) return { text: "", toolCalls: [{ name: "get_available_slots", arguments: {}, id: "global-fallback" }] };
        return { text: "I couldn't find that doctor.", toolCalls: [] };
      } },
      toolExecutor: async ({ name }) => {
        if (name === "search_doctors") return { doctors: [] };
        availabilityCalls += 1;
        return { slots: [] };
      },
    });
    await engine.respond({ actor: user, messages: [{ role: "user", content: "Show Dr. Unknown on December 31, 2030" }] });
    assert.equal(availabilityCalls, 0);
  });

  it("retries one 503 once and succeeds without logging sensitive request data", async () => {
    let attempts = 0;
    const logs = [];
    const engine = createConversationEngine({
      provider: { generate: async () => {
        attempts += 1;
        if (attempts === 1) throw Object.assign(new Error("provider payload must not be logged"), { status: 503, code: "UPSTREAM_BUSY", retryAfterMs: 0 });
        return { text: "Hello", toolCalls: [] };
      } },
      toolExecutor: async () => ({}),
    });
    const result = await engine.respond({ actor: user, messages: [{ role: "user", content: "private patient prompt" }], requestId: "request-123", logger: { info: (stage, details) => logs.push({ stage, details }) } });
    assert.equal(result.answer, "Hello");
    assert.equal(attempts, 2);
    const retry = logs.find(({ stage }) => stage === "provider_retry");
    assert.equal(retry.details.requestId, "request-123");
    assert.equal(retry.details.attempt, 2);
    assert.equal(retry.details.providerStatus, 503);
    assert.equal(retry.details.category, "provider_http_503");
    assert.equal(JSON.stringify(logs).includes("private patient prompt"), false);
    assert.equal(JSON.stringify(logs).includes("provider payload"), false);
  });

  it("preserves provider-unavailable mapping after the single retry also returns 503", async () => {
    let attempts = 0;
    const engine = createConversationEngine({ provider: { generate: async () => { attempts += 1; throw Object.assign(new Error("busy"), { status: 503, retryAfterMs: 0 }); } }, toolExecutor: async () => ({}) });
    await assert.rejects(engine.respond({ actor: user, messages: [{ role: "user", content: "hello" }] }), (error) => error.code === "ASSISTANT_PROVIDER_UNAVAILABLE" && error.status === 503 && error.message === "The AI assistant is temporarily unavailable. Please try again shortly.");
    assert.equal(attempts, 2);
  });

  it("preserves an upstream HTTP 504 and logs the actual provider attempt", async () => {
    const logs = [];
    let attempts = 0;
    const engine = createConversationEngine({ provider: { requestTimeoutMs: 30000, generate: async () => { attempts += 1; throw Object.assign(new Error("upstream gateway timeout"), { status: 504 }); } }, toolExecutor: async () => ({}) });
    await assert.rejects(engine.respond({ actor: user, messages: [{ role: "user", content: "hello" }], logger: { info: (stage, details) => logs.push({ stage, details }) } }), (error) => error.code === "ASSISTANT_PROVIDER_GATEWAY_TIMEOUT" && error.status === 504 && error.providerStatus === 504);
    const providerError = logs.find(({ stage }) => stage === "provider_error");
    assert.equal(attempts, 1);
    assert.equal(providerError.details.attempt, 1);
    assert.equal(providerError.details.providerStatus, 504);
    assert.equal(providerError.details.category, "provider_http_504");
  });

  it("skips a 503 retry when Retry-After or the remaining deadline cannot fit the provider timeout", async () => {
    let attempts = 0;
    const provider = { requestTimeoutMs: 30000, generate: async () => { attempts += 1; throw Object.assign(new Error("upstream unavailable"), { status: 503, retryAfterMs: 0 }); } };
    const engine = createConversationEngine({ provider, toolExecutor: async () => ({}), deadlineMs: 1000 });
    await assert.rejects(engine.respond({ actor: user, messages: [{ role: "user", content: "hello" }] }), (error) => error.code === "ASSISTANT_PROVIDER_UNAVAILABLE" && error.status === 503);
    assert.equal(attempts, 1);

    const longRetryAfter = { requestTimeoutMs: 30000, generate: async () => { attempts += 1; throw Object.assign(new Error("upstream unavailable"), { status: 503, retryAfterMs: 2500 }); } };
    const bounded = createConversationEngine({ provider: longRetryAfter, toolExecutor: async () => ({}) });
    await assert.rejects(bounded.respond({ actor: user, messages: [{ role: "user", content: "hello" }] }), { code: "ASSISTANT_PROVIDER_UNAVAILABLE" });
    assert.equal(attempts, 2);
  });

  it("uses bounded Retry-After metadata from SDK response headers", () => {
    assert.equal(readRetryAfterMs(new Headers({ "retry-after": "1" })), 1000);
    assert.equal(readRetryAfterMs(new Headers({ "retry-after-ms": "350" })), 350);
    assert.equal(readRetryAfterMs(new Headers()), undefined);
    const provider = createGeminiProvider({ apiKey: "test", client: { models: { generateContent: async () => ({ candidates: [{ content: { parts: [{ text: "ok" }] } }] }) } } });
    assert.equal(provider.requestTimeoutMs, 30000);
  });

  it("uses Gemini 3.5 Flash-Lite when the provider model is not overridden", async () => {
    let requestedModel;
    const provider = createGeminiProvider({ apiKey: "test", client: { models: { generateContent: async ({ model }) => {
      requestedModel = model;
      return { candidates: [{ content: { parts: [{ text: "Ready." }] } }] };
    } } } });
    await provider.generate({ messages: [], tools: [], systemInstruction: "", signal: AbortSignal.timeout(1000) });
    assert.equal(requestedModel, "gemini-3.5-flash-lite");
  });

  it("extracts sanitized candidate finish and output metadata from Gemini SDK responses", async () => {
    const provider = createGeminiProvider({ apiKey: "test", client: { models: { generateContent: async () => ({ candidates: [{
      finishReason: "STOP", content: { role: "model", parts: [{ text: "Final answer." }, { functionCall: { name: "search_doctors", args: { name: "private name" }, id: "call-id" } }] },
    }] }) } } });
    const response = await provider.generate({ messages: [], tools: [], systemInstruction: "", signal: AbortSignal.timeout(1000) });
    assert.deepEqual(response.providerMetadata, {
      finishReason: "STOP", outputPartTypes: ["text", "function_call"], hasFinalText: true, finalTextLength: 13, pendingToolCalls: 1,
    });
    assert.equal(JSON.stringify(response.providerMetadata).includes("private name"), false);
  });

  it("rejects partial final text when Gemini reports MAX_TOKENS and logs only response metadata", async () => {
    const records = [];
    const engine = createConversationEngine({
      logger: { info: (stage, details) => records.push({ stage, details }) },
      provider: { generate: async () => ({ text: "partial text", toolCalls: [], providerMetadata: {
        finishReason: "MAX_TOKENS", outputPartTypes: ["text"], hasFinalText: true, finalTextLength: 12, pendingToolCalls: 0,
      } }) },
      toolExecutor: async () => ({}),
    });
    await assert.rejects(engine.respond({ actor: user, messages: [{ role: "user", content: "private message" }] }), (error) => error.code === "PROVIDER_INCOMPLETE_RESPONSE" && !error.message.includes("partial text"));
    const responseRecord = records.find(({ stage }) => stage === "provider_response");
    assert.equal(responseRecord.details.finishReason, "MAX_TOKENS");
    assert.deepEqual(responseRecord.details.outputPartTypes, ["text"]);
    assert.equal(responseRecord.details.hasFinalText, true);
    assert.equal(responseRecord.details.pendingToolCalls, 0);
    assert.equal(JSON.stringify(records).includes("private message"), false);
  });

  it("maps provider rate limits without exposing provider details", async () => {
    const engine = createConversationEngine({ provider: { generate: async () => { throw Object.assign(new Error("private provider payload"), { status: 429 }); } }, toolExecutor: async () => ({}) });
    await assert.rejects(engine.respond({ actor: user, messages: [{ role: "user", content: "hi" }] }), (error) => error instanceof AssistantError && error.code === "ASSISTANT_PROVIDER_RATE_LIMITED" && error.message === "The AI assistant is receiving too many requests. Please wait a moment and try again." && !error.message.includes("private"));
    const quota = createConversationEngine({ provider: { generate: async () => { throw Object.assign(new Error("private provider payload"), { status: 429, category: "provider_daily_quota_exceeded" }); } }, toolExecutor: async () => ({}) });
    await assert.rejects(quota.respond({ actor: user, messages: [{ role: "user", content: "hi" }] }), { code: "ASSISTANT_DAILY_QUOTA_EXCEEDED", message: "The AI assistant has reached its current usage limit. Please try again later." });
  });

  it("maps unknown provider failures to the existing generic fallback", async () => {
    const engine = createConversationEngine({ provider: { generate: async () => { throw new Error("private provider response"); } }, toolExecutor: async () => ({}) });
    await assert.rejects(engine.respond({ actor: user, messages: [{ role: "user", content: "hi" }] }), (error) => error.code === "ASSISTANT_UNAVAILABLE" && error.message === "The assistant is temporarily unavailable. Please try again shortly." && !error.message.includes("private"));
  });

  it("classifies structured Gemini daily quota errors separately from generic 429s", async () => {
    const daily = createGeminiProvider({ apiKey: "test", client: { models: { generateContent: async () => { throw Object.assign(new Error("private"), { status: 429, error: { details: [{ reason: "QUOTA_FAILURE", violations: [{ quotaId: "GenerateRequestsPerDayPerProject" }] }] } }); } } } });
    await assert.rejects(daily.generate({ messages: [], tools: [], systemInstruction: "", signal: AbortSignal.timeout(1000) }), (error) => error.category === "provider_daily_quota_exceeded" && error.message === "Gemini request failed");
  });

  it("distinguishes the SDK request timeout from the overall execution deadline", async () => {
    const providerTimeout = createConversationEngine({ provider: { generate: async () => { throw Object.assign(new Error("abort"), { name: "AbortError" }); } }, toolExecutor: async () => ({}) });
    await assert.rejects(providerTimeout.respond({ actor: user, messages: [{ role: "user", content: "hello" }] }), (error) => error.code === "ASSISTANT_SDK_TIMEOUT" && error.category === "sdk_timeout" && error.providerStatus === undefined);
    const deadline = createConversationEngine({ provider: { generate: async () => new Promise(() => {}) }, toolExecutor: async () => ({}), deadlineMs: 5 });
    await assert.rejects(deadline.respond({ actor: user, messages: [{ role: "user", content: "hello" }] }), { code: "ASSISTANT_TIMEOUT" });
  });

  it("passes trusted persisted assistant turns to the provider", async () => {
    let providerMessages;
    const engine = createConversationEngine({ provider: { generate: async ({ messages }) => { providerMessages = messages; return { text: "I will check current data.", toolCalls: [] }; } }, toolExecutor: async () => ({}) });
    await engine.respond({ actor: user, messages: [{ role: "assistant", content: "Previous answer" }, { role: "user", content: "Tell me something general about appointment scheduling." }] });
    assert.deepEqual(providerMessages, [{ role: "assistant", content: "Previous answer" }, { role: "user", content: "Tell me something general about appointment scheduling." }]);
  });

  it("echoes Gemini function-call content unchanged before matching tool responses", async () => {
    const modelContent = {
      role: "model",
      parts: [
        { text: "I will search the directory.", thought: true, thoughtSignature: "thought-signature" },
        { functionCall: { name: "search_doctors", args: { specialty: "cardiology" }, id: "function-call-1" }, thoughtSignature: "function-signature" },
      ],
    };
    const toolOutput = { doctors: [{ id: doctorId, name: "Dr. Dee Doctor", specialty: "Cardiology" }] };
    let providerRequestCount = 0;
    let followupContents;
    const provider = createGeminiProvider({
      apiKey: "test",
      client: { models: { generateContent: async (params) => {
        providerRequestCount += 1;
        if (providerRequestCount === 1) return { candidates: [{ content: modelContent }] };
        followupContents = params.contents;
        return { candidates: [{ content: { role: "model", parts: [{ text: "I found a cardiologist." }] } }] };
      } } },
    });
    const engine = createConversationEngine({ provider, toolExecutor: async () => toolOutput });
    const result = await engine.respond({
      actor: user,
      messages: [{ role: "user", content: "Find a cardiologist" }],
      tools: [{ name: "search_doctors", description: "Search doctors", parameters: { type: "OBJECT", properties: {} } }],
      systemInstruction: "Patient assistant",
    });

    assert.equal(result.answer, "I found a cardiologist.");
    assert.equal(providerRequestCount, 2);
    assert.equal(followupContents[0].role, "user");
    assert.deepEqual(followupContents[0].parts, [{ text: "Find a cardiologist" }]);
    assert.strictEqual(followupContents[1], modelContent);
    assert.equal(followupContents[1].parts[0].thoughtSignature, "thought-signature");
    assert.equal(followupContents[1].parts[1].thoughtSignature, "function-signature");
    assert.deepEqual(followupContents[2], {
      role: "user",
      parts: [{ functionResponse: { name: "search_doctors", id: "function-call-1", response: { doctors: [{ name: "Dr. Dee Doctor", specialty: "Cardiology" }] } } }],
    });
  });

  it("preserves Gemini function-call and function-response context across sequential action lookups", async () => {
    const date = "2099-08-14";
    const returnedDoctorId = "77777777-7777-4777-8777-777777777777";
    const returnedSlotId = "88888888-8888-4888-8888-888888888888";
    const modelTurns = [
      { role: "model", parts: [{ functionCall: { name: "search_doctors", args: { name: "Dr. Ada Morgan" }, id: "search-call" } }] },
      { role: "model", parts: [{ functionCall: { name: "get_available_slots", args: { doctor_id: returnedDoctorId, from: date, to: date, exact_start_time: "14:30" }, id: "slots-call" } }] },
      { role: "model", parts: [{ text: "Available times." }] },
    ];
    let providerCall = 0;
    const providerContents = [];
    const provider = createGeminiProvider({ apiKey: "test", client: { models: { generateContent: async (params) => {
      providerContents.push(params.contents);
      return { candidates: [{ content: modelTurns[providerCall++] }] };
    } } } });
    const engine = createConversationEngine({
      provider,
      toolExecutor: async ({ name, args }) => {
        if (name === "search_doctors") return { doctors: [{ id: returnedDoctorId, name: "Dr. Ada Morgan" }] };
        if (name === "get_available_slots") return { slots: [{ availability_id: returnedSlotId, doctor_id: returnedDoctorId, date, start_time: "14:30:00" }] };
        return { proposal: { action_type: "book", action_args: args }, requires_patient_confirmation: true };
      },
    });
    const result = await engine.respond({ actor: user, messages: [{ role: "user", content: "Find Dr. Ada Morgan" }] });
    assert.equal(result.answer, "Available times.");
    assert.equal(providerContents.length, 3);
    assert.strictEqual(providerContents[1][1], modelTurns[0]);
    assert.deepEqual(providerContents[1][2].parts[0].functionResponse, { name: "search_doctors", id: "search-call", response: { doctors: [{ name: "Dr. Ada Morgan" }] } });
    assert.strictEqual(providerContents[2][3], modelTurns[1]);
    assert.equal("availability_id" in providerContents[2][4].parts[0].functionResponse.response.slots[0], false);
    assert.equal(result.results.some(({ tool }) => tool === "get_available_slots"), true);
  });

  it("rejects malformed function arguments without executing a tool", async () => {
    let calls = 0;
    const engine = createConversationEngine({
      provider: { generate: async () => ({ text: "", toolCalls: [{ name: "search_doctors", arguments: "not-object" }] }) },
      toolExecutor: async () => { calls += 1; return {}; },
    });
    await assert.rejects(engine.respond({ actor: user, messages: [{ role: "user", content: "find a doctor" }] }), { code: "INVALID_TOOL_CALL" });
    assert.equal(calls, 0);
  });

  it("returns safe provider error details from the adapter", async () => {
    const provider = createGeminiProvider({ apiKey: "test", client: { models: { generateContent: async () => { throw Object.assign(new Error("sensitive payload"), { status: 429 }); } } } });
    await assert.rejects(provider.generate({ messages: [], tools: [], systemInstruction: "", signal: AbortSignal.timeout(1000) }), (error) => error.status === 429 && error.message === "Gemini request failed");
  });

  it("preserves an SDK HTTP 504 status without treating it as a client timeout", async () => {
    const provider = createGeminiProvider({ apiKey: "test", client: { models: { generateContent: async () => { throw Object.assign(new Error("upstream response"), { status: 504 }); } } } });
    await assert.rejects(provider.generate({ messages: [], tools: [], systemInstruction: "", signal: AbortSignal.timeout(1000) }), (error) => error.status === 504 && error.category === "provider_http_504" && error.name !== "AbortError");
  });
});
