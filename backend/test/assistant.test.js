const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { createApp } = require("../src/app");
const { assistantChatSchema } = require("../src/validators/assistantSchemas");
const { randomUUID } = require("node:crypto");
const { createConversationEngine } = require("../src/services/assistant/conversationEngine");
const { createGeminiProvider } = require("../src/services/assistant/geminiProvider");

const userId = "11111111-1111-4111-8111-111111111111";
const user = { id: userId, first_name: "Pat", last_name: "Patient", role: "patient", is_active: true };
const conversationId = "55555555-5555-4555-8555-555555555555";

function withServer(app, callback) {
  const server = app.listen(0);
  return new Promise((resolve, reject) => {
    server.once("listening", async () => {
      try { await callback(`http://127.0.0.1:${server.address().port}`); resolve(); }
      catch (error) { reject(error); }
      finally { server.close(); }
    });
  });
}

function testApp({ actor = user, authenticated = true, engine = { respond: async () => ({ answer: "Ready", results: [] }) }, database } = {}) {
  return createApp({
    database: database || { query: async (sql, values = []) => {
      if (sql.includes("FROM users WHERE clerk_user_id")) return { rows: actor ? [actor] : [] };
      if (sql.startsWith("SELECT id, created_at, updated_at FROM assistant_conversations")) return { rows: [{ id: values[0], created_at: "2099-01-01", updated_at: "2099-01-01" }] };
      return { rows: [], rowCount: 1 };
    } },
    frontendOrigin: "http://localhost:3000", applicationTimezone: "Asia/Kolkata", assistantEngine: engine,
    clerkAuthMiddleware: (request, _response, next) => {
      request.auth = Object.assign(() => authenticated ? { isAuthenticated: true, userId: "verified-clerk-id", tokenType: "session_token" } : { isAuthenticated: false, userId: null, tokenType: "session_token" }, { [Symbol.for("@clerk/express.auth")]: true });
      next();
    },
  });
}

function persistentAssistantDatabase() {
  const conversations = new Map();
  const messages = [];
  const users = new Map([["verified-clerk-id", user], ["booking-patient-1", { ...user, id: "11111111-1111-4111-8111-111111111112" }],
    ["booking-patient-2", { ...user, id: "11111111-1111-4111-8111-111111111113" }], ["booking-patient-3", { ...user, id: "11111111-1111-4111-8111-111111111114" }],
    ["booking-patient-4", { ...user, id: "11111111-1111-4111-8111-111111111115" }], ["booking-patient-5", { ...user, id: "11111111-1111-4111-8111-111111111116" }],
    ["booking-patient-6", { ...user, id: "11111111-1111-4111-8111-111111111117" }], ["booking-patient-7", { ...user, id: "11111111-1111-4111-8111-111111111118" }],
    ["booking-patient-8", { ...user, id: "11111111-1111-4111-8111-111111111119" }]]);
  const query = async (sql, values = []) => {
    if (sql.includes("FROM users WHERE clerk_user_id")) return { rows: [users.get(values[0])].filter(Boolean) };
    if (sql.startsWith("INSERT INTO assistant_conversations")) {
      conversations.set(values[0], conversations.get(values[0]) || { id: values[0], user_id: values[1], created_at: new Date(), updated_at: new Date() });
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("SELECT id, created_at, updated_at FROM assistant_conversations")) {
      const conversation = conversations.get(values[0]);
      return { rows: conversation?.user_id === values[1] ? [conversation] : [] };
    }
    if (sql.includes("FROM assistant_conversations WHERE id = $1 AND user_id = $2")) {
      return { rows: conversations.get(values[0])?.user_id === values[1] ? [{ id: values[0] }] : [] };
    }
    if (sql.includes("FROM assistant_messages WHERE conversation_id = $1 AND role = 'user' AND request_id = $2")) {
      return { rows: messages.filter((message) => message.conversation_id === values[0] && message.role === "user" && message.request_id === values[1]) };
    }
    if (sql.includes("FROM assistant_messages") && sql.includes("FOR UPDATE")) return { rows: messages.some((message) => message.id === values[0]) ? [{ id: values[0] }] : [] };
    if (sql.includes("request_status = 'processing'") && sql.includes("request_id <>")) return { rows: [] };
    if (sql.includes("reply_to_message_id = $1")) return { rows: messages.filter((message) => message.reply_to_message_id === values[0]) };
    if (sql.includes("FROM assistant_messages") && sql.includes("tool_results @>")) {
      const stateMessage = [...messages].reverse().find((message) => message.conversation_id === values[0] && message.role === "assistant"
        && message.tool_results.some((result) => result.tool === "__internal_action_context"));
      return { rows: stateMessage ? [{ tool_results: stateMessage.tool_results }] : [] };
    }
    if (sql.includes("SELECT id, role, content, tool_results, created_at FROM assistant_messages")) {
      return { rows: messages.filter((message) => message.conversation_id === values[0] && message.id !== values[1]
        && (message.role === "assistant" || message.request_status === "complete")).slice(-values[2]).reverse() };
    }
    if (sql.includes("FROM assistant_action_intents")) return { rows: [] };
    if (sql.startsWith("INSERT INTO assistant_messages (conversation_id, role, content, request_id")) {
      const message = { id: randomUUID(), conversation_id: values[0], role: "user", content: values[1], request_id: values[2], request_status: "processing", created_at: new Date(), updated_at: new Date() };
      messages.push(message);
      return { rows: [message] };
    }
    if (sql.startsWith("INSERT INTO assistant_messages (conversation_id, role, content, reply_to_message_id")) {
      const message = { id: randomUUID(), conversation_id: values[0], role: "assistant", content: values[1], reply_to_message_id: values[2], tool_results: JSON.parse(values[3]), created_at: new Date() };
      messages.push(message);
      return { rows: [message] };
    }
    if (sql.includes("SET tool_results = tool_results ||")) {
      const message = messages.find((row) => row.id === values[0]);
      message.tool_results.push(...JSON.parse(values[1]));
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("UPDATE assistant_messages SET request_status")) {
      const message = messages.find((row) => row.id === values[0]);
      if (message) message.request_status = sql.includes("'complete'") ? "complete" : "processing";
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("UPDATE assistant_conversations")) return { rows: [], rowCount: 1 };
    if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [] };
    return { rows: [], rowCount: 1 };
  };
  return { conversations, messages, query, connect: async () => ({ query, release() {} }) };
}

function bookingApiApp(database, { now = () => Date.parse("2026-11-16T12:00:00Z"), appointments = [] } = {}) {
  const doctor = { id: "77777777-7777-4777-8777-777777777777", name: "Dr. James Wilson", specialty: "Cardiology" };
  const slots = new Map();
  const calls = [];
  const engine = createConversationEngine({
    now,
    provider: { generate: async () => { throw new Error("active booking turns must resolve deterministically"); } },
    toolExecutor: async ({ name, args }) => {
      calls.push({ name, args });
      if (name === "search_doctors") return { doctors: [doctor] };
      if (name === "get_patient_appointments") return { appointments: appointments.filter((appointment) => !args.from || appointment.date === args.from), has_more: false };
      if (name === "get_available_slots") {
        if (args.exact_start_time) return { slots: [...slots.values()].filter((slot) => slot.date === args.from && slot.start_time.slice(0, 5) === args.exact_start_time) };
        return { slots: [...slots.values()].filter((slot) => slot.date >= args.from && slot.date <= args.to) };
      }
      if (["prepare_booking_action", "prepare_reschedule_action", "prepare_cancellation_action"].includes(name)) {
        return { proposal: { action_type: ({ prepare_booking_action: "book", prepare_reschedule_action: "reschedule", prepare_cancellation_action: "cancel" })[name], action_args: args }, requires_patient_confirmation: true };
      }
      throw new Error(`Unexpected tool ${name}`);
    },
  });
  const app = createApp({
    database, frontendOrigin: "http://localhost:3000", applicationTimezone: "Asia/Kolkata", assistantEngine: engine,
    clerkAuthMiddleware: (request, _response, next) => {
      request.auth = Object.assign(() => ({ isAuthenticated: true, userId: request.headers["x-test-clerk-id"] || "verified-clerk-id", tokenType: "session_token" }), { [Symbol.for("@clerk/express.auth")]: true });
      next();
    },
  });
  return { app, calls, slots, doctor };
}

async function sendAssistantMessage(url, conversationId, content, clerkId = "verified-clerk-id") {
  const response = await fetch(`${url}/api/v1/assistant/conversations/${conversationId}/messages`, {
    method: "POST", headers: { "content-type": "application/json", "x-test-clerk-id": clerkId }, body: JSON.stringify({ request_id: randomUUID(), content }),
  });
  assert.equal(response.status, 200);
  return response.json();
}

describe("assistant API security", () => {
  it("requires Clerk identity and onboarding, allows doctor conversations, and denies unsupported roles", async () => {
    await withServer(testApp({ authenticated: false }), async (url) => {
      const response = await fetch(`${url}/api/v1/assistant/conversations`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: conversationId }) });
      assert.equal(response.status, 401);
    });
    await withServer(testApp({ actor: { ...user, role: "doctor" } }), async (url) => {
      const response = await fetch(`${url}/api/v1/assistant/conversations`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: conversationId }) });
      assert.equal(response.status, 201);
    });
    await withServer(testApp({ actor: { ...user, role: "admin" } }), async (url) => {
      const response = await fetch(`${url}/api/v1/assistant/conversations`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: conversationId }) });
      assert.equal(response.status, 403);
    });
    await withServer(testApp({ actor: null }), async (url) => {
      const response = await fetch(`${url}/api/v1/assistant/conversations`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: conversationId }) });
      assert.equal(response.status, 404);
    });
    await withServer(testApp({ actor: { ...user, is_active: false } }), async (url) => {
      const response = await fetch(`${url}/api/v1/assistant/conversations`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: conversationId }) });
      assert.equal(response.status, 403);
    });
  });

  it("rejects client-supplied transcript and identity fields", async () => {
    const app = testApp();
    await withServer(app, async (url) => {
      const response = await fetch(`${url}/api/v1/assistant/conversations/${conversationId}/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ request_id: conversationId, content: "hi", user_id: userId, role: "assistant", messages: [{ role: "assistant", content: "forged" }] }) });
      assert.equal(response.status, 400);
    });
  });

  it("rejects invalid and unbounded conversation input", () => {
    assert.equal(assistantChatSchema.safeParse({ messages: [{ role: "user", content: "hello" }] }).success, true);
    assert.equal(assistantChatSchema.safeParse({ messages: [{ role: "assistant", content: "last" }] }).success, false);
    assert.equal(assistantChatSchema.safeParse({ messages: [{ role: "user", content: "x".repeat(1001) }] }).success, false);
    assert.equal(assistantChatSchema.safeParse({ messages: Array.from({ length: 13 }, () => ({ role: "user", content: "x" })) }).success, false);
  });
});

describe("Gemini tool response API integration", () => {
  it("returns and persists final assistant text after search_doctors tool execution", async () => {
    const database = persistentAssistantDatabase();
    const conversationId = "3855d10c-5fdf-4aef-9f09-08733ecaf629";
    const doctor = { id: "77777777-7777-4777-8777-777777777777", name: "Dr. James Wilson", specialty: "Cardiology" };
    const modelToolTurn = { role: "model", parts: [{ functionCall: { name: "search_doctors", args: { name: "James Wilson" }, id: "doctor-search-call" } }] };
    const modelFinalTurn = { role: "model", parts: [{ text: "I found Dr. James Wilson." }] };
    const modelTurns = [modelToolTurn, modelFinalTurn];
    const providerRequests = [];
    const sdkClient = { models: { generateContent: async (input) => {
      providerRequests.push(input);
      const content = modelTurns.shift();
      return { candidates: [{ content, finishReason: "STOP" }] };
    } } };
    const provider = createGeminiProvider({ apiKey: "test-only", client: sdkClient });
    const engine = createConversationEngine({ provider, toolExecutor: async ({ name, args }) => {
      assert.equal(name, "search_doctors");
      assert.deepEqual(args, { name: "James Wilson" });
      return { doctors: [doctor] };
    } });

    await withServer(testApp({ database, engine }), async (url) => {
      const created = await fetch(`${url}/api/v1/assistant/conversations`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: conversationId }),
      });
      assert.equal(created.status, 201);
      const response = await fetch(`${url}/api/v1/assistant/conversations/${conversationId}/messages`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ request_id: randomUUID(), content: "Find Dr. James Wilson." }),
      });
      assert.equal(response.status, 200);
      const payload = await response.json();
      assert.equal(payload.user_message.request_status, "complete");
      assert.equal(payload.assistant_message.role, "assistant");
      assert.equal(payload.assistant_message.content, "I found Dr. James Wilson.");
      assert.equal(payload.assistant_message.results[0].tool, "search_doctors");
      assert.equal(payload.replayed, false);
    });

    assert.equal(providerRequests.length, 2);
    assert.strictEqual(providerRequests[1].contents[1], modelToolTurn);
    assert.deepEqual(providerRequests[1].contents[2].parts[0].functionResponse, {
      name: "search_doctors", id: "doctor-search-call", response: { doctors: [{ name: "Dr. James Wilson", specialty: "Cardiology" }] },
    });
    const persistedAssistant = database.messages.find((message) => message.role === "assistant");
    assert.equal(persistedAssistant.content, "I found Dr. James Wilson.");
    assert.equal(persistedAssistant.tool_results[0].tool, "search_doctors");
  });
});

describe("patient booking conversation API integration", () => {
  it("restores persisted booking context across real HTTP turns, refreshes expired slots, and binds changed dates correctly", async () => {
    const database = persistentAssistantDatabase();
    let instant = Date.parse("2026-11-16T12:00:00Z");
    const { app, calls, slots, doctor } = bookingApiApp(database, { now: () => instant });
    const slotFor = (date, startTime, suffix) => {
      const id = `88888888-8888-4888-8888-${suffix}`;
      const [hour, minute] = startTime.split(":").map(Number);
      const endMinutes = hour * 60 + minute + 30;
      const endTime = `${String(Math.floor(endMinutes / 60)).padStart(2, "0")}:${String(endMinutes % 60).padStart(2, "0")}`;
      const slot = { id, availability_id: id, doctor_id: doctor.id, doctor, date, start_time: `${startTime}:00`, end_time: `${endTime}:00`, remaining_capacity: 2 };
      slots.set(id, slot);
      return slot;
    };
    const jan15 = slotFor("2027-01-15", "10:00", "000000000001");
    const jan16 = slotFor("2027-01-16", "11:30", "000000000002");
    slotFor("2027-01-20", "12:00", "000000000003");
    const jan21 = slotFor("2027-01-21", "12:00", "000000000004");
    const conversation1 = "55555555-5555-4555-8555-555555555551";
    const conversation2 = "55555555-5555-4555-8555-555555555552";
    const conversation3 = "55555555-5555-4555-8555-555555555553";

    await withServer(app, async (url) => {
      for (const [id, clerkId] of [[conversation1, "booking-patient-1"], [conversation2, "booking-patient-2"], [conversation3, "booking-patient-3"]]) {
        const response = await fetch(`${url}/api/v1/assistant/conversations`, { method: "POST", headers: { "content-type": "application/json", "x-test-clerk-id": clerkId }, body: JSON.stringify({ id }) });
        assert.equal(response.status, 201);
      }

      const first = await sendAssistantMessage(url, conversation1, "I want to book an appointment with Dr. James Wilson.", "booking-patient-1");
      assert.match(first.assistant_message.content, /what date and time/i);
      const persistedDoctor = database.messages.at(-1).tool_results.find((result) => result.tool === "__internal_action_context").data.references.booking_context;
      assert.equal(persistedDoctor.version, 1);
      assert.equal(persistedDoctor.doctor.id, doctor.id);
      const displayed = await sendAssistantMessage(url, conversation1, "January 15, 2027", "booking-patient-1");
      assert.match(displayed.assistant_message.content, /2027-01-15/);
      assert.deepEqual(database.messages.at(-1).tool_results.find((result) => result.tool === "__internal_action_context").data.references.booking_context.displayed_slots.map((slot) => slot.slot_id), [jan15.id]);
      const proposal = await sendAssistantMessage(url, conversation1, "book this", "booking-patient-1");
      assert.match(proposal.assistant_message.content, /proposal/i);
      assert.equal(proposal.assistant_message.results.at(-1).tool, "prepare_booking_action");
      assert.equal(calls.filter((call) => call.name === "search_doctors").length, 1);
      assert.deepEqual(calls.filter((call) => call.name === "prepare_booking_action").map((call) => call.args.availability_id), [jan15.id]);
      assert.equal(database.messages.at(-1).tool_results.find((result) => result.tool === "__internal_action_context").data.references.booking_context, null);

      await sendAssistantMessage(url, conversation2, "Book with Dr. James Wilson", "booking-patient-2");
      await sendAssistantMessage(url, conversation2, "January 16, 2027", "booking-patient-2");
      instant += 3 * 60 * 1000;
      const refreshed = await sendAssistantMessage(url, conversation2, "book this", "booking-patient-2");
      assert.match(refreshed.assistant_message.content, /refreshed the available times/i);
      assert.notEqual(refreshed.assistant_message.results.at(-1)?.tool, "prepare_booking_action");
      const stopped = await sendAssistantMessage(url, conversation2, "Stop this booking request", "booking-patient-2");
      assert.match(stopped.assistant_message.content, /stopped this booking request/i);
      assert.equal(database.messages.at(-1).tool_results.find((result) => result.tool === "__internal_action_context").data.references.booking_context, null);

      const searchCallCount = calls.filter((call) => call.name === "search_doctors").length;
      await sendAssistantMessage(url, conversation3, "Book an appointment with Dr. James Wilson", "booking-patient-3");
      const beforeIncomplete = calls.length;
      const clarification = await sendAssistantMessage(url, conversation3, "January 2027 12 PM", "booking-patient-3");
      assert.match(clarification.assistant_message.content, /day of the month/i);
      assert.equal(calls.length, beforeIncomplete);
      await sendAssistantMessage(url, conversation3, "January 20, 2027", "booking-patient-3");
      const changedDate = await sendAssistantMessage(url, conversation3, "January 21, 2027", "booking-patient-3");
      const currentDisplayedIds = database.messages.at(-1).tool_results.find((result) => result.tool === "__internal_action_context").data.references.booking_context.displayed_slots.map((slot) => slot.slot_id);
      assert.deepEqual(currentDisplayedIds, [jan21.id]);
      assert.equal(changedDate.assistant_message.results.find((result) => result.tool === "get_available_slots").data.slots.some((slot) => slot.date === "2027-01-20"), false);
      const timedProposal = await sendAssistantMessage(url, conversation3, "12:00 PM", "booking-patient-3");
      assert.match(timedProposal.assistant_message.content, /proposal/i);
      assert.equal(calls.filter((call) => call.name === "search_doctors").length, searchCallCount + 1);
      assert.equal(calls.filter((call) => call.name === "prepare_booking_action").at(-1).args.availability_id, jan21.id);
    });
  });

  it("routes natural-language and UI-style booking, cancellation, and rescheduling selections to the same persisted proposal targets", async () => {
    const database = persistentAssistantDatabase();
    const appointment = {
      id: "99999999-9999-4999-8999-999999999991",
      appointment_id: "99999999-9999-4999-8999-999999999991",
      doctor_id: "77777777-7777-4777-8777-777777777777",
      doctor: { id: "77777777-7777-4777-8777-777777777777", name: "Dr. James Wilson", specialty: "Cardiology" },
      date: "2027-01-20", start_time: "09:00:00", end_time: "09:30:00", status: "confirmed",
    };
    const { app, calls, slots, doctor } = bookingApiApp(database, { appointments: [appointment] });
    const slotId = "88888888-8888-4888-8888-000000000021";
    slots.set(slotId, { id: slotId, availability_id: slotId, doctor_id: doctor.id, doctor, date: "2027-01-22", start_time: "11:30:00", end_time: "12:00:00", remaining_capacity: 2 });
    const ids = {
      bookingNatural: "55555555-5555-4555-8555-555555555561",
      bookingButton: "55555555-5555-4555-8555-555555555562",
      cancelNatural: "55555555-5555-4555-8555-555555555563",
      cancelButton: "55555555-5555-4555-8555-555555555564",
      rescheduleNatural: "55555555-5555-4555-8555-555555555565",
      rescheduleButton: "55555555-5555-4555-8555-555555555566",
    };
    const actors = {
      bookingNatural: "booking-patient-4", bookingButton: "booking-patient-4",
      cancelNatural: "booking-patient-5", cancelButton: "booking-patient-5",
      rescheduleNatural: "booking-patient-6", rescheduleButton: "booking-patient-6",
    };
    await withServer(app, async (url) => {
      for (const [key, id] of Object.entries(ids)) {
        const response = await fetch(`${url}/api/v1/assistant/conversations`, { method: "POST", headers: { "content-type": "application/json", "x-test-clerk-id": actors[key] }, body: JSON.stringify({ id }) });
        assert.equal(response.status, 201);
      }

      for (const key of ["bookingNatural", "bookingButton"]) {
        await sendAssistantMessage(url, ids[key], "Book an appointment with Dr. James Wilson", actors[key]);
        await sendAssistantMessage(url, ids[key], "January 22, 2027", actors[key]);
      }
      const naturalChoice = await sendAssistantMessage(url, ids.bookingNatural, "I want the 11:30 AM slot", actors.bookingNatural);
      const naturalFollowup = await sendAssistantMessage(url, ids.bookingNatural, "Book this for me", actors.bookingNatural);
      const naturalProposal = /proposal/i.test(naturalChoice.assistant_message.content) ? naturalChoice : naturalFollowup;
      const buttonProposal = await sendAssistantMessage(url, ids.bookingButton, "Book slot 1", actors.bookingButton);
      assert.match(naturalProposal.assistant_message.content, /proposal/i);
      assert.match(buttonProposal.assistant_message.content, /proposal/i);
      const bookingCalls = calls.filter((call) => call.name === "prepare_booking_action");
      assert.equal(bookingCalls.length, 2);
      assert.deepEqual(bookingCalls.map((call) => call.args.availability_id), [slotId, slotId]);
      const exactBookingValidations = calls.filter((call) => call.name === "get_available_slots" && call.args.exact_start_time === "11:30");
      assert.equal(exactBookingValidations.length, 2);
      assert.equal(calls.filter((call) => call.name === "get_patient_appointments").length, 2);
      assert.equal(naturalProposal.assistant_message.results.at(-1).tool, "prepare_booking_action");
      assert.equal(buttonProposal.assistant_message.results.at(-1).tool, "prepare_booking_action");

      for (const key of ["cancelNatural", "cancelButton"]) {
        await sendAssistantMessage(url, ids[key], "Show my upcoming appointments", actors[key]);
      }
      const cancelNaturalProposal = await sendAssistantMessage(url, ids.cancelNatural, "Cancel this appointment", actors.cancelNatural);
      const cancelButtonProposal = await sendAssistantMessage(url, ids.cancelButton, "Cancel the first appointment", actors.cancelButton);
      assert.match(cancelNaturalProposal.assistant_message.content, /proposal/i);
      assert.match(cancelButtonProposal.assistant_message.content, /proposal/i);
      const cancellationCalls = calls.filter((call) => call.name === "prepare_cancellation_action");
      assert.equal(cancellationCalls.length, 2);
      assert.deepEqual(cancellationCalls.map((call) => call.args.appointment_id), [appointment.id, appointment.id]);

      for (const key of ["rescheduleNatural", "rescheduleButton"]) {
        await sendAssistantMessage(url, ids[key], "Show my upcoming appointments", actors[key]);
        const prompt = key === "rescheduleNatural" ? "Reschedule this appointment" : "Reschedule the first appointment";
        await sendAssistantMessage(url, ids[key], prompt, actors[key]);
        await sendAssistantMessage(url, ids[key], "January 22, 2027", actors[key]);
      }
      const rescheduleNaturalProposal = await sendAssistantMessage(url, ids.rescheduleNatural, "I want the 11:30 AM slot", actors.rescheduleNatural);
      const rescheduleButtonProposal = await sendAssistantMessage(url, ids.rescheduleButton, "Reschedule my appointment to slot 1", actors.rescheduleButton);
      assert.match(rescheduleNaturalProposal.assistant_message.content, /proposal/i);
      assert.match(rescheduleButtonProposal.assistant_message.content, /proposal/i);
      const rescheduleCalls = calls.filter((call) => call.name === "prepare_reschedule_action");
      assert.equal(rescheduleCalls.length, 2);
      assert.deepEqual(rescheduleCalls.map((call) => call.args), [
        { appointment_id: appointment.id, availability_id: slotId },
        { appointment_id: appointment.id, availability_id: slotId },
      ]);
      assert.equal(calls.filter((call) => call.name === "get_available_slots" && call.args.exact_start_time === "11:30").length, 4);
      for (const response of [naturalProposal, buttonProposal, cancelNaturalProposal, cancelButtonProposal, rescheduleNaturalProposal, rescheduleButtonProposal]) {
        assert.equal(response.assistant_message.results.some((result) => result.data?.requires_patient_confirmation), true);
      }
    });
  });

  it("resolves a sole displayed booking slot by reference and asks when multiple slots make the reference ambiguous", async () => {
    const database = persistentAssistantDatabase();
    const { app, calls, slots, doctor } = bookingApiApp(database);
    const soleId = "88888888-8888-4888-8888-000000000031";
    const secondId = "88888888-8888-4888-8888-000000000032";
    const thirdId = "88888888-8888-4888-8888-000000000033";
    slots.set(soleId, { id: soleId, availability_id: soleId, doctor_id: doctor.id, doctor, date: "2027-01-14", start_time: "11:00:00", end_time: "11:30:00", remaining_capacity: 1 });
    slots.set(secondId, { id: secondId, availability_id: secondId, doctor_id: doctor.id, doctor, date: "2027-01-15", start_time: "11:30:00", end_time: "12:00:00", remaining_capacity: 1 });
    slots.set(thirdId, { id: thirdId, availability_id: thirdId, doctor_id: doctor.id, doctor, date: "2027-01-15", start_time: "12:00:00", end_time: "12:30:00", remaining_capacity: 1 });
    const soleConversation = "55555555-5555-4555-8555-555555555571";
    const multipleConversation = "55555555-5555-4555-8555-555555555572";
    await withServer(app, async (url) => {
      for (const [id, actor] of [[soleConversation, "booking-patient-7"], [multipleConversation, "booking-patient-8"]]) {
        const response = await fetch(`${url}/api/v1/assistant/conversations`, { method: "POST", headers: { "content-type": "application/json", "x-test-clerk-id": actor }, body: JSON.stringify({ id }) });
        assert.equal(response.status, 201);
      }
      await sendAssistantMessage(url, soleConversation, "Book with Dr. James Wilson", "booking-patient-7");
      const oneSlot = await sendAssistantMessage(url, soleConversation, "January 14, 2027", "booking-patient-7");
      assert.deepEqual(oneSlot.assistant_message.results.find((result) => result.tool === "get_available_slots").data.slots.map((slot) => slot.start_time.slice(0, 5)), ["11:00"]);
      const soleState = database.messages.at(-1).tool_results.find((result) => result.tool === "__internal_action_context").data.references;
      assert.deepEqual(soleState.booking_context.displayed_slots.map((slot) => slot.slot_id), [soleId]);
      assert.deepEqual(soleState.slots.map((slot) => slot.id), [soleId]);
      const proposal = await sendAssistantMessage(url, soleConversation, "Okay, I want to book it.", "booking-patient-7");
      assert.match(proposal.assistant_message.content, /proposal/i);
      assert.equal(proposal.assistant_message.results.at(-1).tool, "prepare_booking_action");
      assert.equal(calls.filter((call) => call.name === "prepare_booking_action").at(-1).args.availability_id, soleId);
      assert.equal(proposal.assistant_message.results.at(-1).data.requires_patient_confirmation, true);

      await sendAssistantMessage(url, multipleConversation, "Book with Dr. James Wilson", "booking-patient-8");
      const options = await sendAssistantMessage(url, multipleConversation, "January 15, 2027", "booking-patient-8");
      assert.equal(options.assistant_message.results.find((result) => result.tool === "get_available_slots").data.slots.length, 2);
      const clarification = await sendAssistantMessage(url, multipleConversation, "Okay, I want to book it.", "booking-patient-8");
      assert.match(clarification.assistant_message.content, /more than one|specify the exact|slot number/i);
      assert.notEqual(clarification.assistant_message.results.at(-1)?.tool, "prepare_booking_action");
    });
  });

  it("persists rescheduling targets across appointment clarification and handles invalid dates and doctor mismatch", async () => {
    const database = persistentAssistantDatabase();
    const sourceAppointments = [["09:00:00", "09:30:00"], ["10:00:00", "10:30:00"]].map(([time, endTime], index) => ({
      id: `99999999-9999-4999-8999-00000000000${index + 2}`, appointment_id: `99999999-9999-4999-8999-00000000000${index + 2}`,
      doctor_id: "77777777-7777-4777-8777-777777777777", doctor: { id: "77777777-7777-4777-8777-777777777777", name: "Dr. James Wilson", specialty: "Cardiology" },
      date: "2026-12-16", start_time: time, end_time: endTime, status: "confirmed",
    }));
    const { app, calls, slots, doctor } = bookingApiApp(database, { appointments: sourceAppointments });
    const slotId = "88888888-8888-4888-8888-000000000041";
    slots.set(slotId, { id: slotId, availability_id: slotId, doctor_id: doctor.id, doctor, date: "2026-12-20", start_time: "11:30:00", end_time: "12:00:00", remaining_capacity: 1 });
    const conversationId = "55555555-5555-4555-8555-555555555573";
    const mismatchConversation = "55555555-5555-4555-8555-555555555574";
    await withServer(app, async (url) => {
      for (const id of [conversationId, mismatchConversation]) {
        const created = await fetch(`${url}/api/v1/assistant/conversations`, { method: "POST", headers: { "content-type": "application/json", "x-test-clerk-id": "booking-patient-7" }, body: JSON.stringify({ id }) });
        assert.equal(created.status, 201);
      }
      const initial = await sendAssistantMessage(url, conversationId, "Reschedule my appointment with Dr. James Wilson on December 16, 2026 to December 20, 2026 at 11:30 AM.", "booking-patient-7");
      assert.match(initial.assistant_message.content, /choose which appointment/i);
      const persisted = database.messages.at(-1).tool_results.find((result) => result.tool === "__internal_action_context").data.references.reschedule_context;
      assert.equal(persisted.target_date, "2026-12-20");
      assert.equal(persisted.target_time, "11:30");
      const invalidDate = await sendAssistantMessage(url, conversationId, "December 70", "booking-patient-7");
      assert.match(invalidDate.assistant_message.content, /valid date/i);
      const selected = await sendAssistantMessage(url, conversationId, "The 9 AM appointment.", "booking-patient-7");
      assert.match(selected.assistant_message.content, /proposal/i);
      assert.equal(selected.assistant_message.results.at(-1).tool, "prepare_reschedule_action");
      assert.deepEqual(calls.filter((call) => call.name === "prepare_reschedule_action").at(-1).args, { appointment_id: sourceAppointments[0].id, availability_id: slotId });
      assert.equal(selected.assistant_message.results.at(-1).data.requires_patient_confirmation, true);
      assert.equal(calls.filter((call) => call.name === "get_patient_appointments" && call.args.from === "2026-12-16").length, 2);

      await sendAssistantMessage(url, mismatchConversation, "Reschedule my appointment with Dr. James Wilson on December 16, 2026 to December 20, 2026 at 11:30 AM.", "booking-patient-7");
      const mismatch = await sendAssistantMessage(url, mismatchConversation, "Dr. Hannah Cole, the 9 AM appointment", "booking-patient-7");
      assert.match(mismatch.assistant_message.content, /not Dr\. Hannah Cole|different doctor/i);
      assert.notEqual(mismatch.assistant_message.results.at(-1)?.tool, "prepare_reschedule_action");
      const accepted = await sendAssistantMessage(url, mismatchConversation, "Yes", "booking-patient-7");
      assert.match(accepted.assistant_message.content, /proposal/i);
      assert.equal(accepted.assistant_message.results.at(-1).tool, "prepare_reschedule_action");
    });
  });
});
