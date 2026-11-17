const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { describe, it } = require("node:test");
const { createAssistantConversationService, AssistantConversationError, messageView } = require("../src/services/assistantConversationService");
const { createConversationEngine } = require("../src/services/assistant/conversationEngine");

const user = { id: "11111111-1111-4111-8111-111111111111", role: "patient" };
const other = { id: "99999999-9999-4999-8999-999999999999", role: "patient" };
const conversationId = "22222222-2222-4222-8222-222222222222";
const requestId = "33333333-3333-4333-8333-333333333333";

function memoryDatabase(ownerId = user.id) {
  const state = { userMessage: null, assistantMessage: null, priorAssistantMessages: [], ownerId, values: [], assistantInsertCount: 0, statements: [] };
  const query = async (sql, values = []) => {
    state.statements.push(sql);
    if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [] };
    if (sql.includes("FROM assistant_conversations WHERE id = $1 AND user_id = $2 FOR UPDATE")) return { rows: values[1] === state.ownerId ? [{ id: conversationId }] : [] };
    if (sql.includes("FROM assistant_messages") && sql.includes("FOR UPDATE")) return { rows: state.userMessage?.id === values[0] ? [{ id: values[0] }] : [] };
    if (sql.includes("FROM assistant_messages WHERE conversation_id = $1 AND role = 'user' AND request_id = $2")) return { rows: state.userMessage ? [state.userMessage] : [] };
    if (sql.includes("reply_to_message_id = $1")) return { rows: state.assistantMessage ? [state.assistantMessage] : [] };
    if (sql.includes("tool_results @>")) {
      const candidate = state.assistantMessage?.tool_results?.some((result) => result?.tool === "__internal_action_context")
        ? state.assistantMessage : [...state.priorAssistantMessages].reverse().find((message) => message.tool_results?.some((result) => result?.tool === "__internal_action_context"));
      return { rows: candidate ? [{ tool_results: candidate.tool_results }] : [] };
    }
    if (sql.includes("INSERT INTO assistant_messages (conversation_id, role, content, request_id, request_status)")) {
      state.userMessage = { id: "44444444-4444-4444-8444-444444444444", role: "user", content: values[1], request_id: values[2], request_status: "processing", updated_at: new Date() };
      return { rows: [state.userMessage] };
    }
    if (sql.includes("SELECT id, role, content, tool_results, created_at FROM assistant_messages")) return { rows: state.priorAssistantMessages };
    if (sql.includes("INSERT INTO assistant_messages (conversation_id, role, content, reply_to_message_id, tool_results)")) {
      state.assistantInsertCount += 1;
      state.assistantMessage = { id: "55555555-5555-4555-8555-555555555555", role: "assistant", content: values[1], tool_results: JSON.parse(values[3]), created_at: new Date() };
      return { rows: [state.assistantMessage] };
    }
    if (sql.includes("SET tool_results = tool_results ||")) {
      state.assistantMessage.tool_results.push(...JSON.parse(values[1]));
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("UPDATE assistant_messages SET request_status = 'complete'")) { state.userMessage.request_status = "complete"; return { rows: [] }; }
    if (sql.includes("UPDATE assistant_messages SET request_status = 'processing'")) { state.userMessage.request_status = "processing"; state.userMessage.updated_at = new Date(); return { rows: [] }; }
    if (sql.includes("UPDATE assistant_conversations")) return { rows: [] };
    if (sql.includes("SET request_status = 'failed'")) { state.userMessage.request_status = "failed"; return { rows: [] }; }
    return { rows: [] };
  };
  return { state, query, connect: async () => ({ query, release() {} }) };
}

describe("assistant conversation persistence", () => {
  it("scopes conversation reads, lists, and deletes by the authenticated owner", async () => {
    const statements = [];
    const database = { query: async (sql, values) => {
      statements.push({ sql, values });
      if (sql.startsWith("DELETE FROM assistant_conversations")) return { rows: [], rowCount: values[1] === user.id ? 1 : 0 };
      if (sql.includes("FROM assistant_conversations WHERE id = $1 AND user_id = $2")) return { rows: values[1] === user.id ? [{ id: conversationId, created_at: new Date(), updated_at: new Date() }] : [] };
      if (sql.includes("FROM assistant_messages") && sql.includes("WHERE conversation_id = $1")) return { rows: [] };
      if (sql.startsWith("SELECT conversation.id")) return { rows: [] };
      return { rows: [{ id: conversationId, created_at: new Date(), updated_at: new Date() }] };
    } };
    const service = createAssistantConversationService({ engine: { respond: async () => ({ answer: "unused", results: [] }) } });
    await service.create(database, user, conversationId);
    await service.list(database, user);
    await service.get(database, user, conversationId);
    assert.equal(await service.remove(database, other, conversationId), false);
    assert.equal(await service.remove(database, user, conversationId), true);
    assert.equal(statements.filter(({ values }) => values?.includes(user.id)).length >= 3, true);
    assert.equal(statements.filter(({ values }) => values?.includes(other.id)).length, 1);
  });

  it("returns only the latest 20 messages by default and exposes a cursor for older pages", async () => {
    const statements = [];
    const rows = Array.from({ length: 21 }, (_, index) => ({
      id: `message-${21 - index}`,
      role: index % 2 === 0 ? "assistant" : "user",
      content: `message ${21 - index}`,
      created_at: new Date(2100000000000 - index * 1000),
      tool_results: [],
    }));
    const database = { query: async (sql, values) => {
      statements.push({ sql, values });
      return sql.includes("assistant_conversations WHERE id")
        ? { rows: [{ id: conversationId, created_at: new Date(), updated_at: new Date() }] }
        : { rows };
    } };
    const service = createAssistantConversationService({ engine: { respond: async () => ({ answer: "unused", results: [] }) } });
    const page = await service.get(database, user, conversationId);
    assert.equal(page.messages.length, 20);
    assert.equal(page.has_more, true);
    assert.equal(page.next_before, page.messages[0].id);
    assert.deepEqual(statements[1].values, [conversationId, 21]);
    assert.match(statements[1].sql, /ORDER BY created_at DESC, id DESC\s+LIMIT \$2/);
  });

  it("retrieves persisted conversation messages and tool results for the exact owned list ID", async () => {
    const assistantResults = [{ tool: "get_cancellation_refund_preview", data: { estimated_additional_refund_amount: "50.00" } }];
    const calls = [];
    const database = { query: async (sql, values) => {
      calls.push({ sql, values });
      if (sql.includes("FROM assistant_conversations WHERE id = $1 AND user_id = $2")) {
        return { rows: values[0] === conversationId && values[1] === user.id ? [{ id: conversationId, created_at: new Date(), updated_at: new Date() }] : [] };
      }
      if (sql.includes("FROM assistant_messages")) return { rows: [
        { id: "55555555-5555-4555-8555-555555555555", role: "assistant", content: "The estimate is INR 50.", tool_results: assistantResults, created_at: new Date() },
        { id: "44444444-4444-4444-8444-444444444444", role: "user", content: "What refund applies?", request_id: requestId, request_status: "complete", created_at: new Date() },
      ] };
      throw new Error(`Unexpected query: ${sql}`);
    } };
    const service = createAssistantConversationService({ engine: { respond: async () => ({ answer: "unused", results: [] }) } });
    const detail = await service.get(database, user, conversationId);
    assert.equal(calls[0].values[0], conversationId);
    assert.equal(calls[0].values[1], user.id);
    assert.equal(calls[1].values[0], conversationId);
    assert.equal(detail.conversation.id, conversationId);
    assert.deepEqual(detail.messages[1].results, assistantResults);
  });

  it("enforces conversation ownership before executing a message", async () => {
    const database = memoryDatabase(user.id);
    let calls = 0;
    const service = createAssistantConversationService({ engine: { respond: async () => { calls += 1; return { answer: "hello", results: [] }; } } });
    await assert.rejects(service.send({ database, user: other, conversationId, requestId, content: "hi" }), { code: "CONVERSATION_NOT_FOUND" });
    assert.equal(calls, 0);
  });

  it("returns CONVERSATION_NOT_FOUND before message writes and preserves existing rows", async () => {
    const database = memoryDatabase(user.id);
    let calls = 0;
    const service = createAssistantConversationService({ engine: { respond: async () => { calls += 1; return { answer: "unused", results: [] }; } } });
    await assert.rejects(service.send({ database, user: other, conversationId, requestId, content: "keep history" }), { code: "CONVERSATION_NOT_FOUND" });
    assert.equal(calls, 0);
    assert.equal(database.state.userMessage, null);
    assert.equal(database.state.assistantMessage, null);
    assert.equal(database.state.statements.some((sql) => /^\s*(?:INSERT|UPDATE|DELETE)\b/i.test(sql)), false);
  });

  it("persists a user/reply pair and returns the stored reply for retries", async () => {
    const database = memoryDatabase();
    let calls = 0;
    const service = createAssistantConversationService({ engine: { respond: async ({ actor, messages }) => { calls += 1; assert.equal(actor.id, user.id); assert.deepEqual(messages, [{ role: "user", content: "hello" }]); return { answer: "Hi there", results: [{ tool: "search_doctors", data: { doctors: [] } }] }; } } });
    const first = await service.send({ database, user, conversationId, requestId, content: "hello" });
    const second = await service.send({ database, user, conversationId, requestId, content: "hello" });
    assert.equal(calls, 1);
    assert.equal(first.user_message.request_status, "complete");
    assert.deepEqual(second.assistant_message.results, [{ tool: "search_doctors", data: { doctors: [] } }]);
    assert.equal(second.replayed, true);
    assert.equal(database.state.userMessage.content, "hello");
  });

  it("persists private cancellation context for a follow-up without exposing IDs in history or model input", async () => {
    const database = memoryDatabase();
    const appointmentId = "77777777-7777-4777-8777-777777777777";
    database.state.priorAssistantMessages = [{
      role: "assistant", content: "I prepared a cancellation proposal.", tool_results: [
        { tool: "__internal_action_context", data: { action_type: "cancel", appointment_id: appointmentId } },
      ],
    }];
    let forwardedContext;
    let engineMessages;
    const service = createAssistantConversationService({ engine: { respond: async ({ previousActionContext, messages }) => {
      forwardedContext = previousActionContext;
      engineMessages = messages;
      return { answer: "Refund preview", results: [], internalActionContext: previousActionContext };
    } } });
    const response = await service.send({ database, user, conversationId, requestId, content: "What refund should I expect for this appointment?" });
    assert.deepEqual(forwardedContext, { action_type: "cancel", appointment_id: appointmentId });
    assert.equal(engineMessages.some((message) => message.actionContext || message.tool_results), false);
    assert.deepEqual(response.assistant_message.results, []);
    assert.equal(JSON.stringify(response).includes(appointmentId), false);
    assert.deepEqual(database.state.assistantMessage.tool_results.at(-1), { tool: "__internal_action_context", data: { action_type: "cancel", appointment_id: appointmentId } });
    assert.deepEqual(messageView(database.state.assistantMessage).results, []);
  });

  it("routes a patient cancellation rejection through the existing proposal dismissal API", async () => {
    const assistantMessageId = "66666666-6666-4666-8666-666666666666";
    const appointmentId = "77777777-7777-4777-8777-777777777777";
    const database = memoryDatabase();
    database.state.priorAssistantMessages = [{
      id: assistantMessageId,
      role: "assistant",
      content: "Cancellation proposal",
      tool_results: [
        { tool: "__internal_action_context", data: { action_type: "cancel", appointment_id: appointmentId } },
        { tool: "__internal_action_context", data: { proposal_evidence: { proposal_succeeded: true, requires_patient_confirmation: true, action_type: "cancel" } } },
      ],
    }];
    const dismissals = [];
    const actionService = { dismiss: async (...args) => { dismissals.push(args); return { status: "dismissed" }; } };
    const service = createAssistantConversationService({
      actionService,
      engine: { respond: async ({ previousActionContext, previousProposal }) => {
        assert.deepEqual(previousActionContext, { action_type: "cancel", appointment_id: appointmentId });
        assert.equal(previousProposal.assistant_message_id, assistantMessageId);
        assert.equal(previousProposal.action_type, "cancel");
        assert.equal(previousProposal.status, "awaiting_preparation");
        return { answer: "Understood. I dismissed the cancellation proposal and won't prepare it again.", results: [], dismissProposal: previousProposal };
      } },
    });
    const result = await service.send({ database, user, conversationId, requestId, content: "Don't cancel it" });
    assert.deepEqual(dismissals, [[user, conversationId, assistantMessageId, "cancel"]]);
    assert.match(result.assistant_message.content, /dismissed the cancellation proposal/i);
  });

  it("persists server-verified proposal evidence privately bound to the owner, conversation, and assistant message", async () => {
    const database = memoryDatabase();
    const availabilityId = "88888888-8888-4888-8888-888888888888";
    const engine = createAssistantConversationService({ engine: { respond: async () => ({
      answer: "I prepared a booking proposal.",
      results: [{ tool: "prepare_booking_action", data: { proposal: { action_type: "book" }, requires_patient_confirmation: true } }],
      internalProposalEvidence: {
        version: 1,
        proposal_succeeded: true,
        requires_patient_confirmation: true,
        tool_name: "prepare_booking_action",
        action_type: "book",
        action_args: { availability_id: availabilityId },
        verified_appointment_id: null,
        verified_availability_id: availabilityId,
      },
    }) } });
    const response = await engine.send({ database, user, conversationId, requestId, content: "Book the selected slot" });
    const privateResult = database.state.assistantMessage.tool_results.find((result) => result?.data?.proposal_evidence)?.data.proposal_evidence;
    assert.deepEqual(privateResult, {
      version: 1,
      proposal_succeeded: true,
      requires_patient_confirmation: true,
      tool_name: "prepare_booking_action",
      action_type: "book",
      action_args: { availability_id: availabilityId },
      verified_appointment_id: null,
      verified_availability_id: availabilityId,
      user_id: user.id,
      conversation_id: conversationId,
      assistant_message_id: database.state.assistantMessage.id,
    });
    assert.equal(JSON.stringify(response).includes(availabilityId), false);
    assert.equal(messageView(database.state.assistantMessage).results.some((result) => result?.data?.proposal_evidence), false);
  });

  it("persists partial cancellation details across turns and resolves the patient's appointment", async () => {
    const fixedNow = Date.parse("2026-11-15T00:00:00.000Z");
    const database = memoryDatabase();
    const appointmentId = "77777777-7777-4777-8777-777777777777";
    const doctorId = "66666666-6666-4666-8666-666666666666";
    const appointment = { id: appointmentId, appointment_id: appointmentId, date: "2027-01-20", start_time: "11:00:00", end_time: "11:30:00", status: "confirmed", doctor: { id: doctorId, name: "Dr. Example Provider" } };
    const otherSameDayAppointment = { ...appointment, id: "88888888-8888-4888-8888-888888888888", appointment_id: "88888888-8888-4888-8888-888888888888", start_time: "12:00:00", end_time: "12:30:00" };
    const calls = [];
    const engineContexts = [];
    const engineUserTexts = [];
    const baseEngine = createConversationEngine({
      now: () => fixedNow,
      provider: { generate: async () => { throw new Error("a pending cancellation clarification should route before Gemini"); } },
      toolExecutor: async ({ name, args }) => {
        calls.push({ name, args });
        if (name === "get_patient_appointments") return { appointments: [appointment, otherSameDayAppointment], has_more: false };
        return { proposal: { action_type: "cancel", action_args: args }, requires_patient_confirmation: true };
      },
    });
    const engine = { respond: async (input) => {
      engineContexts.push(input.previousActionContext);
      engineUserTexts.push(input.messages.filter(({ role }) => role === "user").at(-1)?.content);
      return baseEngine.respond(input);
    } };
    const service = createAssistantConversationService({ engine, now: () => fixedNow });
    const first = await service.send({ database, user, conversationId, requestId, content: "Please cancel my appointment." });
    assert.match(first.assistant_message.content, /identify the appointment by its date and start time/i);
    assert.deepEqual(database.state.assistantMessage.tool_results.at(-1), {
      tool: "__internal_action_context",
      data: { action_type: "cancel_pending", expires_at: new Date(fixedNow + 5 * 60 * 1000).toISOString() },
    });

    // Model a separate request after the persisted assistant turn is reloaded.
    database.state.priorAssistantMessages = [database.state.assistantMessage];
    database.state.userMessage = null;
    database.state.assistantMessage = null;
    const dateClarification = await service.send({
      database, user, conversationId,
      requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      content: "2027-01-20",
    });
    assert.match(dateClarification.assistant_message.content, /multiple matching appointments/i);
    const dateContext = database.state.assistantMessage.tool_results.at(-1).data;
    assert.equal(dateContext.date, "2027-01-20");

    database.state.priorAssistantMessages = [...database.state.priorAssistantMessages, database.state.assistantMessage];
    database.state.userMessage = null;
    database.state.assistantMessage = null;
    const followup = await service.send({
      database, user, conversationId,
      requestId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      content: "Dr Example Provider at 11:00 AM",
    });
    assert.deepEqual(engineContexts, [
      null,
      { action_type: "cancel_pending", expires_at: new Date(fixedNow + 5 * 60 * 1000).toISOString() },
      { action_type: "cancel_pending", expires_at: new Date(fixedNow + 5 * 60 * 1000).toISOString(), date: "2027-01-20" },
    ]);
    assert.equal(engineUserTexts[2], "Dr Example Provider at 11:00 AM");
    assert.deepEqual(calls.map(({ name }) => name), ["get_patient_appointments", "get_patient_appointments", "prepare_cancellation_action"]);
    assert.deepEqual(calls[2].args, { appointment_id: appointmentId });
    assert.match(followup.assistant_message.content, /cancellation proposal.*2027-01-20 at 11:00.*11:30/i);
    const cancellationContext = database.state.assistantMessage.tool_results.find((result) => result?.data?.action_type === "cancel").data;
    assert.equal(cancellationContext.action_type, "cancel");
    assert.equal(cancellationContext.appointment_id, appointmentId);
    const proposalEvidence = database.state.assistantMessage.tool_results.find((result) => result?.data?.proposal_evidence).data.proposal_evidence;
    assert.equal(proposalEvidence.verified_appointment_id, appointmentId);
    assert.equal(JSON.stringify(followup).includes(appointmentId), false);
  });

  it("persists verified appointment and slot references privately for the next turn", async () => {
    const appointmentId = "77777777-7777-4777-8777-777777777777";
    const availabilityId = "88888888-8888-4888-8888-888888888888";
    const doctorId = "66666666-6666-4666-8666-666666666666";
    const firstDatabase = memoryDatabase();
    const firstService = createAssistantConversationService({ engine: { respond: async () => ({
      answer: "Available times are shown.", results: [{ tool: "get_available_slots", data: { slots: [{ start_time: "11:00:00" }] } }],
      internalReferences: { version: 1, reference_timestamps: { appointments: "2026-11-15T00:00:00.000Z", slots: "2026-11-15T00:00:00.000Z", doctors: "2026-11-15T00:00:00.000Z" }, appointments: [{ id: appointmentId, appointment_id: appointmentId, date: "2027-01-07", start_time: "09:00:00", end_time: "09:30:00", status: "confirmed", doctor: { id: doctorId, name: "Dr. Ada Morgan" } }], slots: [{ id: availabilityId, availability_id: availabilityId, date: "2027-01-07", start_time: "11:00:00", end_time: "11:30:00" }], doctors: [{ id: doctorId, name: "Dr. Ada Morgan", specialty: "Cardiology" }], pending_action: "reschedule", pending_appointment_id: appointmentId, pending_target_date: "2027-01-09", history_page: { query: { view: "past", scope: "all", from: "2026-11-02", to: "2026-11-08" }, next_offset: 1200, has_more: true, seen_appointment_ids: [appointmentId] } },
    }) } });
    await firstService.send({ database: firstDatabase, user, conversationId, requestId, content: "Show available times" });
    const privateResult = firstDatabase.state.assistantMessage.tool_results.find(({ tool }) => tool === "__internal_action_context");
    assert.equal(privateResult.data.references.appointments[0].appointment_id, appointmentId);
    assert.equal(privateResult.data.references.slots[0].availability_id, availabilityId);
    assert.deepEqual(privateResult.data.references.doctors[0], { id: doctorId, name: "Dr. Ada Morgan", specialty: "Cardiology" });
    assert.deepEqual(privateResult.data.references.history_page, { query: { view: "past", scope: "all", from: "2026-11-02", to: "2026-11-08" }, next_offset: 1200, has_more: true, seen_appointment_ids: [appointmentId] });
    assert.equal(JSON.stringify(messageView(firstDatabase.state.assistantMessage)).includes(availabilityId), false);

    const secondDatabase = memoryDatabase();
    secondDatabase.state.priorAssistantMessages = [{ role: "assistant", content: "Available times are shown.", tool_results: firstDatabase.state.assistantMessage.tool_results }];
    let forwardedReferences;
    const secondService = createAssistantConversationService({ engine: { respond: async ({ previousReferences, messages }) => {
      forwardedReferences = previousReferences;
      assert.equal(messages.some((message) => JSON.stringify(message).includes(availabilityId)), false);
      return { answer: "You selected 11:00.", results: [], internalReferences: previousReferences };
    } } });
    await secondService.send({ database: secondDatabase, user, conversationId, requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", content: "11" });
    assert.equal(forwardedReferences.slots[0].availability_id, availabilityId);
    assert.equal(forwardedReferences.pending_action, "reschedule");
    assert.equal(forwardedReferences.pending_appointment_id, appointmentId);
    assert.equal(forwardedReferences.pending_target_date, "2027-01-09");
    assert.equal(forwardedReferences.appointments[0].appointment_id, appointmentId);
    assert.equal(forwardedReferences.doctors[0].name, "Dr. Ada Morgan");
    assert.equal(forwardedReferences.history_page.next_offset, 1200);
  });

  it("retains private numbered cancellation choices across clarification turns after reference freshness expires", async () => {
    const nowValue = Date.parse("2026-11-15T00:00:00.000Z");
    const appointmentId = "77777777-7777-4777-8777-777777777777";
    const doctorId = "66666666-6666-4666-8666-666666666666";
    const database = memoryDatabase();
    const firstService = createAssistantConversationService({ now: () => nowValue, engine: { respond: async () => ({
      answer: "Choose an appointment to cancel.", results: [],
      internalReferences: { version: 1, pending_action: "cancel", reference_timestamps: { appointments: new Date(nowValue - 10 * 60 * 1000).toISOString() }, cancellation_choices_at: new Date(nowValue - 10 * 60 * 1000).toISOString(), cancellation_choices: [{ id: appointmentId, appointment_id: appointmentId, date: "2027-01-20", start_time: "11:00:00", end_time: "11:30:00", status: "confirmed", doctor: { id: doctorId, name: "Dr. Ada Morgan" } }], appointments: [{ id: appointmentId, appointment_id: appointmentId, date: "2027-01-20", start_time: "11:00:00", end_time: "11:30:00", status: "confirmed", doctor: { id: doctorId, name: "Dr. Ada Morgan" } }], slots: [], doctors: [] },
    }) } });
    await firstService.send({ database, user, conversationId, requestId, content: "Cancel the second appointment" });
    const privateResults = database.state.assistantMessage.tool_results.find(({ tool }) => tool === "__internal_action_context");
    assert.equal(privateResults.data.references.pending_action, "cancel");
    assert.equal(privateResults.data.references.appointments[0].appointment_id, appointmentId);
    assert.equal(privateResults.data.references.cancellation_choices[0].appointment_id, appointmentId);
    assert.equal(privateResults.data.references.cancellation_choices_at, new Date(nowValue - 10 * 60 * 1000).toISOString());
    assert.equal(JSON.stringify(messageView(database.state.assistantMessage)).includes(appointmentId), false);

    const nextDatabase = memoryDatabase();
    nextDatabase.state.priorAssistantMessages = [{ role: "assistant", content: "Choose an appointment to cancel.", tool_results: database.state.assistantMessage.tool_results }];
    let forwarded;
    const nextService = createAssistantConversationService({ now: () => nowValue + 11 * 60 * 1000, engine: { respond: async ({ previousReferences }) => {
      forwarded = previousReferences;
      return { answer: "Please choose from a refreshed list.", results: [], internalReferences: previousReferences };
    } } });
    await nextService.send({ database: nextDatabase, user, conversationId, requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", content: "Thanks" });
    assert.equal(forwarded.pending_action, "cancel");
    assert.equal(forwarded.appointments[0].appointment_id, appointmentId);
    assert.equal(forwarded.cancellation_choices[0].appointment_id, appointmentId);
  });

  it("supersedes cancellation context when a newer patient-owned appointment becomes the active reference", async () => {
    const cancelledAppointmentId = "77777777-7777-4777-8777-777777777777";
    const activeAppointmentId = "88888888-8888-4888-8888-888888888888";
    const doctorId = "66666666-6666-4666-8666-666666666666";
    const database = memoryDatabase();
    database.state.priorAssistantMessages = [
      { role: "assistant", content: "Cancellation proposal for the earlier visit.", tool_results: [{ tool: "__internal_action_context", data: { action_type: "cancel", appointment_id: cancelledAppointmentId } }] },
      { role: "assistant", content: "Here is the appointment you selected.", tool_results: [{ tool: "__internal_action_context", data: { references: {
        version: 1,
        reference_timestamps: { appointments: "2026-11-15T00:00:00.000Z" },
        appointments: [{ id: activeAppointmentId, appointment_id: activeAppointmentId, date: "2027-01-22", start_time: "13:30:00", end_time: "14:00:00", status: "confirmed", doctor: { id: doctorId, name: "Dr. Bea Stone" } }],
        slots: [], doctors: [],
      } } }] },
    ];
    const previews = [];
    const engine = createConversationEngine({
      now: () => Date.parse("2026-11-15T00:00:00Z"),
      provider: { generate: async () => { throw new Error("verified appointment context should resolve this refund follow-up"); } },
      toolExecutor: async ({ name, args }) => {
        previews.push({ name, args });
        return { original_payment: { amount: "500.00", currency: "INR", status: "paid" }, processed_refund_amount: "0.00", pending_refund_amount: "0.00", estimated_additional_refund_amount: "250.00", currency: "INR", explanation: "" };
      },
    });
    const service = createAssistantConversationService({ engine });
    await service.send({ database, user, conversationId, requestId, content: "What refund should I expect for this appointment?" });
    assert.deepEqual(previews, [{ name: "get_cancellation_refund_preview", args: { appointment_id: activeAppointmentId } }]);
    assert.notEqual(previews[0].args.appointment_id, cancelledAppointmentId);
  });

  it("keeps provider retries inside one idempotent persisted message", async () => {
    const database = memoryDatabase();
    let providerCalls = 0;
    const engine = createConversationEngine({
      provider: { generate: async () => {
        providerCalls += 1;
        if (providerCalls === 1) throw Object.assign(new Error("temporary upstream failure"), { status: 503, retryAfterMs: 0 });
        return { text: "Recovered answer", toolCalls: [] };
      } },
      toolExecutor: async () => ({}),
    });
    const service = createAssistantConversationService({ engine });
    const first = await service.send({ database, user, conversationId, requestId, content: "hello" });
    const retry = await service.send({ database, user, conversationId, requestId, content: "hello" });
    assert.equal(first.assistant_message.content, "Recovered answer");
    assert.equal(retry.replayed, true);
    assert.equal(providerCalls, 2);
    assert.equal(database.state.assistantInsertCount, 1);
  });

  it("marks an oversized Unicode answer failed using PostgreSQL character-count semantics", async () => {
    const database = memoryDatabase();
    const service = createAssistantConversationService({ engine: { respond: async () => ({ answer: "💙".repeat(4001), results: [] }) } });
    await assert.rejects(service.send({ database, user, conversationId, requestId, content: "hello" }), { code: "ASSISTANT_RESPONSE_TOO_LONG" });
    assert.equal(database.state.userMessage.request_status, "failed");
    assert.equal(database.state.assistantInsertCount, 0);

    const exactLimitDatabase = memoryDatabase();
    const exactLimitService = createAssistantConversationService({ engine: { respond: async () => ({ answer: "💙".repeat(4000), results: [] }) } });
    const saved = await exactLimitService.send({ database: exactLimitDatabase, user, conversationId, requestId, content: "hello" });
    assert.equal([...saved.assistant_message.content].length, 4000);
    assert.equal(saved.user_message.request_status, "complete");
  });

  it("reuses a reply committed by an overlapping stale attempt", async () => {
    const database = memoryDatabase();
    let inserts = 0;
    const storedReply = { id: "66666666-6666-4666-8666-666666666666", role: "assistant", content: "Saved result", tool_results: [{ tool: "search_doctors", data: { doctors: [] } }], created_at: new Date() };
    const service = createAssistantConversationService({ engine: { respond: async () => {
      database.state.assistantMessage = storedReply;
      database.state.userMessage = { id: "44444444-4444-4444-8444-444444444444", role: "user", content: "hello", request_id: requestId, request_status: "processing", updated_at: new Date() };
      return { answer: "Late duplicate", results: [] };
    } } });
    const originalInsert = database.query;
    database.query = async (sql, values) => {
      if (sql.includes("INSERT INTO assistant_messages (conversation_id, role, content, reply_to_message_id, tool_results)")) inserts += 1;
      return originalInsert(sql, values);
    };
    const result = await service.send({ database, user, conversationId, requestId, content: "hello" });
    assert.equal(result.assistant_message.content, "Saved result");
    assert.deepEqual(result.assistant_message.results, storedReply.tool_results);
    assert.equal(result.replayed, true);
    assert.equal(inserts, 0);
    assert.ok(database.state.statements.some((sql) => sql.includes("FOR UPDATE") && sql.includes("role = 'user'")));
    assert.equal(database.state.userMessage.request_status, "complete");
  });

  it("includes a same-conversation user-role guard in migration 029", () => {
    const migration = fs.readFileSync(path.join(__dirname, "../migrations/029_assistant_conversations.sql"), "utf8");
    assert.match(migration, /CREATE TRIGGER assistant_messages_reply_user_guard/);
    assert.match(migration, /TG_OP = 'UPDATE' AND NEW\.role IS DISTINCT FROM OLD\.role/);
    assert.match(migration, /referenced\.conversation_id = NEW\.conversation_id/);
    assert.match(migration, /referenced\.role = 'user'/);
  });

  it("rejects reuse of an idempotency key for different content", async () => {
    const database = memoryDatabase();
    database.state.userMessage = { id: "44444444-4444-4444-8444-444444444444", content: "original", request_status: "complete" };
    const service = createAssistantConversationService({ engine: { respond: async () => ({ answer: "ignored", results: [] }) } });
    await assert.rejects(service.send({ database, user, conversationId, requestId, content: "changed" }), AssistantConversationError);
  });
});
