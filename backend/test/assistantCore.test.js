const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { getPolicyForActor, getToolsForActor } = require("../src/services/assistant/toolRegistry");
const { executeTool, nextDaysRange, safeAppointment } = require("../src/services/assistant/toolExecutor");
const { createConversationEngine, AssistantError } = require("../src/services/assistant/conversationEngine");
const { createGeminiProvider, readRetryAfterMs } = require("../src/services/assistant/geminiProvider");

const userId = "11111111-1111-4111-8111-111111111111";
const doctorId = "22222222-2222-4222-8222-222222222222";
const user = { id: userId, first_name: "Pat", last_name: "Patient", role: "patient", is_active: true };
describe("patient assistant tools", () => {
  it("registers tools only for patients and validates bounded date ranges", () => {
    assert.equal(getToolsForActor(user).length, 3);
    assert.match(getPolicyForActor(user), /Never guess or invent records/);
    assert.equal(getToolsForActor({ ...user, role: "doctor" }).length, 0);
    assert.equal(getPolicyForActor({ ...user, role: "doctor" }), null);
  });

  it("uses the verified patient user for appointment lookup and projects minimal fields", async () => {
    let queryValues;
    const sensitiveRow = { date: "2099-08-10", start_time: "10:00:00", end_time: "10:30:00", status: "confirmed", doctor_id: doctorId, doctor_first_name: "Dee", doctor_last_name: "Doctor", specialty: "Cardiology", patient_id: "sensitive", reason: "private reason", patient_email: "private@example.test", consultation_fee: "500" };
    const output = await executeTool({ name: "get_patient_appointments", args: { view: "upcoming", scope: "all" }, actor: user, applicationTimezone: "Asia/Kolkata", database: { query: async (_sql, values) => { queryValues = values; return { rows: [sensitiveRow] }; } } });
    assert.equal(queryValues[0], userId);
    assert.deepEqual(queryValues.slice(-2), [21, 0]);
    assert.deepEqual(output.appointments[0], { date: "2099-08-10", start_time: "10:00:00", end_time: "10:30:00", status: "confirmed", doctor: { id: doctorId, name: "Dr. Dee Doctor", specialty: "Cardiology" } });
    assert.equal(JSON.stringify(output).includes("private reason"), false);
    assert.equal(JSON.stringify(output).includes("private@example.test"), false);
    assert.deepEqual(safeAppointment(sensitiveRow), output.appointments[0]);
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
    assert.deepEqual(queryValues, [userId, "Asia/Kolkata", "2026-11-13", "2026-11-15", 21, 0]);
    assert.deepEqual(result.appointments.map(({ date }) => date), ["2026-11-13", "2026-11-14", "2026-11-15"]);
  });

  it("returns empty next-days results when no appointment is inside the requested range", async () => {
    const result = await executeTool({
      name: "get_patient_appointments", args: { view: "upcoming", scope: "next_days", days_ahead: 2 },
      actor: user, applicationTimezone: "Asia/Kolkata", now: new Date("2099-08-10T00:00:00.000Z"),
      database: { query: async () => ({ rows: [{ date: "2099-08-13", start_time: "09:00:00", end_time: "09:30:00", status: "confirmed", doctor_id: doctorId, doctor_first_name: "Dee", doctor_last_name: "Doctor", specialty: "Cardiology" }] }) },
    });
    assert.deepEqual(result, { appointments: [] });
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
    assert.equal(result.appointments.length, 1);
    assert.equal(result.appointments[0].date, "2099-08-10");
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
    assert.match(policy, /For "my next available appointment".*use get_available_slots, never get_patient_appointments/);
    assert.match(availabilityTool.description, /actual bookable availability slots/);
    assert.equal(availabilityTool.schema.safeParse({}).success, true);
    assert.equal(availabilityTool.schema.safeParse({ doctor_id: doctorId }).success, true);
    assert.equal(availabilityTool.schema.safeParse({ doctor_id: doctorId, from: "2099-08-10" }).success, false);
    assert.equal(availabilityTool.schema.safeParse({ doctor_id: doctorId, from: "2099-08-10", to: "2099-08-10" }).success, true);
  });

  it("projects directory and availability records before they reach the model", async () => {
    const doctor = { id: doctorId, first_name: "Dee", last_name: "Doctor", specialty: "Cardiology", bio: "unnecessary biography", consultation_fee: 500, appointment_duration_minutes: 30, created_at: "internal", updated_at: "internal" };
    let doctorSql;
    let doctorValues;
    const directory = await executeTool({ name: "search_doctors", args: { specialty: "cardio" }, actor: user, database: { query: async (sql, values) => { doctorSql = sql; doctorValues = values; return { rows: [doctor] }; } } });
    assert.deepEqual(directory.doctors[0], { id: doctorId, name: "Dr. Dee Doctor", specialty: "Cardiology", consultation_fee: 500, appointment_duration_minutes: 30 });
    assert.match(doctorSql, /LIMIT \$2/);
    assert.deepEqual(doctorValues, ["cardio", 10]);
    assert.equal(JSON.stringify(directory).includes("unnecessary biography"), false);

    const slot = { id: "33333333-3333-4333-8333-333333333333", doctor_id: doctorId, schedule_id: "44444444-4444-4444-8444-444444444444", date: "2099-08-10", start_time: "10:00:00", end_time: "10:30:00", remaining_capacity: 2, hold_status: "active", hold_expires_at: "internal", preserved_reservation_count: 8 };
    let slotsSql;
    let slotsValues;
    const slots = await executeTool({ name: "get_available_slots", args: { doctor_id: doctorId, from: "2099-08-10", to: "2099-08-10" }, actor: user, applicationTimezone: "UTC", database: { query: async (sql, values) => { slotsSql = sql; slotsValues = values; return { rows: [slot] }; } } });
    assert.deepEqual(slots.slots[0], { date: "2099-08-10", start_time: "10:00:00", end_time: "10:30:00", doctor_id: doctorId, remaining_capacity: 2 });
    assert.match(slotsSql, /ORDER BY date, start_time\s+LIMIT \$10/);
    assert.equal(slotsValues.at(-1), 30);
    assert.equal(JSON.stringify(slots).includes("internal"), false);

    let globalAvailabilitySql;
    let globalAvailabilityValues;
    const nextAvailable = await executeTool({ name: "get_available_slots", args: {}, actor: user, applicationTimezone: "UTC", database: { query: async (sql, values) => { globalAvailabilitySql = sql; globalAvailabilityValues = values; return { rows: [slot, { ...slot, date: "2099-08-11" }] }; } } });
    assert.match(globalAvailabilitySql, /WHERE \$1::uuid IS NULL/);
    assert.match(globalAvailabilitySql, /active_user\.is_active = TRUE/);
    assert.match(globalAvailabilitySql, /availability\.booking_visibility = 'public'/);
    assert.equal(globalAvailabilityValues.at(-1), 1);
    assert.equal(nextAvailable.slots.length, 1);
    assert.equal(nextAvailable.slots[0].date, "2099-08-10");
  });
});

describe("assistant conversation and Gemini adapter errors", () => {
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
    await assert.rejects(engine.respond({ actor: user, messages: [{ role: "user", content: "hello" }] }), (error) => error.code === "ASSISTANT_PROVIDER_UNAVAILABLE" && error.status === 503);
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

  it("maps provider rate limits without exposing provider details", async () => {
    const engine = createConversationEngine({ provider: { generate: async () => { throw Object.assign(new Error("private provider payload"), { status: 429 }); } }, toolExecutor: async () => ({}) });
    await assert.rejects(engine.respond({ actor: user, messages: [{ role: "user", content: "hi" }] }), (error) => error instanceof AssistantError && error.status === 503 && !error.message.includes("private"));
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
    await engine.respond({ actor: user, messages: [{ role: "assistant", content: "Previous answer" }, { role: "user", content: "What is my next appointment?" }] });
    assert.deepEqual(providerMessages, [{ role: "assistant", content: "Previous answer" }, { role: "user", content: "What is my next appointment?" }]);
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
      parts: [{ functionResponse: { name: "search_doctors", id: "function-call-1", response: toolOutput } }],
    });
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
    await assert.rejects(provider.generate({ messages: [], tools: [], systemInstruction: "", signal: AbortSignal.timeout(1000) }), (error) => error.status === 504 && error.category === "provider_http_error" && error.name !== "AbortError");
  });
});
