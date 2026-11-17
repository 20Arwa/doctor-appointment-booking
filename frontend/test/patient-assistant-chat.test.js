import assert from "node:assert/strict";
import fs from "node:fs";
import Module from "node:module";
import path from "node:path";
import ts from "typescript";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
function loadTs(relativePath) {
  const filename = path.join(projectRoot, relativePath); const loadedModule = new Module(filename);
  loadedModule.filename = filename; loadedModule.paths = Module._nodeModulePaths(path.dirname(filename));
  loadedModule._compile(ts.transpileModule(fs.readFileSync(filename, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, baseUrl: projectRoot, paths: { "@/*": ["./*"] } } }).outputText, filename);
  return loadedModule.exports;
}
const { assistantMessageDateKey, assistantMessageDateLabel, assistantMessageTimeLabel, canSendAssistantMessage, chatReducer, classifyAssistantError, getAssistantDisplayContent, getAssistantResultRows, getVisibleAssistantResults, initialChatState, isNearMessageListBottom, isNearMessageListTop, preserveScrollAfterPrepend, restoreDraftAfterFailedSubmission, shouldShowAssistantDateSeparator, shouldShowHistoryRecovery, retryOperation } = loadTs("lib/assistant-chat-state.ts");
const { AssistantApiError, confirmAssistantAction, dismissAssistantProposal, getAssistantActionStatus, getAssistantConversation, listAssistantConversations, prepareAssistantAction, sendAssistantMessage } = loadTs("lib/assistant-api.ts");
const { confirmationStatus, isProposalExpired, preserveDismissalOnPrepare, proposalDescription, proposalStatusFromBackend, proposalTitle, proposalTypeForResult, reconcileActionStatus } = loadTs("lib/assistant-action-state.ts");

describe("patient assistant chat", () => {
  it("formats message timestamps in Asia/Kolkata and separates only the first message of each day", () => {
    const messages = [
      { role: "user", content: "first", createdAt: "2026-04-10T19:00:00.000Z" },
      { role: "assistant", content: "reply", createdAt: "2026-04-10T19:30:00.000Z" },
      { role: "user", content: "next day", createdAt: "2026-04-11T19:00:00.000Z" },
    ];
    assert.equal(assistantMessageDateKey(messages[0].createdAt), "2026-04-11");
    assert.equal(assistantMessageTimeLabel(messages[0].createdAt), "12:30 am");
    assert.match(assistantMessageDateLabel(messages[0].createdAt), /11 Apr 2026/);
    assert.deepEqual(messages.map((_, index) => shouldShowAssistantDateSeparator(messages, index)), [true, false, true]);
  });

  it("starts New Chat through explicit conversation creation without deleting saved conversations", () => {
    const chat = fs.readFileSync(path.join(projectRoot, "components/patient-assistant-chat.tsx"), "utf8");
    const start = chat.indexOf("const startNewConversation = useCallback");
    const end = chat.indexOf("const findSavedConversations", start);
    const implementation = chat.slice(start, end);
    assert.match(chat, /MessageSquarePlus[\s\S]*New Chat/);
    assert.match(implementation, /createAssistantConversation\(token, id\)/);
    assert.match(implementation, /dispatch\(\{ type: "clear" \}\)/);
    assert.doesNotMatch(implementation, /deleteAssistantConversation|DELETE/);
  });

  it("shows saved-history recovery controls only for conversation/history failures", () => {
    for (const code of ["CONVERSATION_NOT_FOUND", "HISTORY_LOAD_FAILED", "CONVERSATION_HISTORY_UNAVAILABLE"]) assert.equal(shouldShowHistoryRecovery(code), true);
    for (const code of ["ASSISTANT_UNAVAILABLE", "TOOL_LIMIT_EXCEEDED", "TOOL_QUERY_FAILED", "ASSISTANT_RESPONSE_INVALID", "UNAUTHORIZED", "RATE_LIMITED"]) assert.equal(shouldShowHistoryRecovery(code), false);
    assert.equal(shouldShowHistoryRecovery(null), false);
    assert.equal(classifyAssistantError("ASSISTANT_UNAVAILABLE"), "provider");
    assert.equal(classifyAssistantError("TOOL_QUERY_FAILED"), "tool");
    assert.equal(classifyAssistantError("TOOL_LIMIT_EXCEEDED"), "budget");
    assert.equal(classifyAssistantError("PROVIDER_INVALID_RESPONSE"), "response");
    assert.equal(classifyAssistantError("UNAUTHORIZED"), "authentication");
    assert.equal(classifyAssistantError("ASSISTANT_PROVIDER_RATE_LIMITED"), "rate_limit");
  });

  it("clears a history failure after a successful send and retries the later send rather than history", () => {
    const historyFailure = chatReducer(initialChatState, { type: "failure", requestId: "history", message: "History unavailable", code: "HISTORY_LOAD_FAILED", source: "history" });
    assert.equal(retryOperation(historyFailure.errorSource), "history");
    const submitted = chatReducer(historyFailure, { type: "submit", message: { requestId: "send-1", role: "user", content: "Ask assistant" } });
    const recovered = chatReducer(submitted, { type: "success", requestId: "send-1", user: { requestId: "send-1", role: "user", content: "Ask assistant" }, assistant: { role: "assistant", content: "Recovered" } });
    assert.equal(recovered.errorSource, null);
    const failedSend = chatReducer(recovered, { type: "submit", message: { requestId: "send-2", role: "user", content: "Another question" } });
    const sendFailure = chatReducer(failedSend, { type: "failure", requestId: "send-2", message: "Provider unavailable", code: "ASSISTANT_UNAVAILABLE", source: "send" });
    assert.equal(retryOperation(sendFailure.errorSource), "send");
    assert.equal(shouldShowHistoryRecovery(sendFailure.errorCode), false);
    assert.equal(sendFailure.messages.filter((message) => message.role === "user").length, 2);
  });
  it("accepts all supported preparation-only action result names from the assistant API", async () => {
    const previousFetch = global.fetch;
    const previousUrl = process.env.NEXT_PUBLIC_API_URL;
    process.env.NEXT_PUBLIC_API_URL = "https://api.example.test";
    try {
      for (const tool of ["prepare_booking_action", "prepare_reschedule_action", "prepare_cancellation_action"]) {
        global.fetch = async () => ({
          status: 200,
          ok: true,
          async json() {
            return {
              user_message: { id: "user-message", role: "user", content: "Do this", request_id: "request", request_status: "complete" },
              assistant_message: { id: "assistant-message", role: "assistant", content: "Prepared", results: [{ tool, data: { requires_patient_confirmation: true } }] },
              replayed: false,
            };
          },
        });
        const result = await sendAssistantMessage("token", "conversation", "request", "Do this");
        assert.equal(result.assistant_message.results[0].tool, tool);
      }
    } finally {
      global.fetch = previousFetch;
      if (previousUrl === undefined) delete process.env.NEXT_PUBLIC_API_URL;
      else process.env.NEXT_PUBLIC_API_URL = previousUrl;
    }
  });

  it("recognizes only verified booking, cancellation, and rescheduling proposal results", () => {
    const cases = [
      ["prepare_booking_action", "book", "Booking proposal"],
      ["prepare_cancellation_action", "cancel", "Cancellation proposal"],
      ["prepare_reschedule_action", "reschedule", "Rescheduling proposal"],
    ];
    for (const [tool, action, title] of cases) {
      const result = { tool, data: { requires_patient_confirmation: true, proposal: { action_type: action, action_args: {} } } };
      assert.equal(proposalTypeForResult(result), action);
      assert.equal(proposalTitle(action), title);
    }
    assert.equal(proposalTypeForResult({ tool: "prepare_booking_action", data: { proposal: { action_type: "cancel" }, requires_patient_confirmation: true } }), null);
    assert.equal(proposalTypeForResult({ tool: "prepare_booking_action", data: { proposal: { action_type: "book" }, requires_patient_confirmation: false } }), null);
  });

  it("represents action confirmation outcomes without claiming booking before backend completion", () => {
    assert.equal(confirmationStatus("completed"), "completed");
    assert.equal(confirmationStatus("checkout_pending"), "checkout_pending");
    assert.equal(confirmationStatus("refund_pending"), "refund_pending");
    assert.equal(confirmationStatus("executing"), "failed");
    assert.equal(proposalStatusFromBackend("completed", "2099-01-01T00:00:00Z"), "completed");
    assert.equal(proposalStatusFromBackend("checkout_pending", "2000-01-01T00:00:00Z"), "checkout_pending");
    assert.equal(proposalStatusFromBackend("expired", "2099-01-01T00:00:00Z"), "expired");
    assert.equal(isProposalExpired("2026-11-15T12:00:00Z", Date.parse("2026-11-15T12:00:01Z")), true);
    assert.equal(isProposalExpired("2026-11-15T12:00:00Z", Date.parse("2026-11-15T11:59:59Z")), false);
    assert.equal(isProposalExpired("not-a-date"), true);
    const component = fs.readFileSync(path.join(projectRoot, "components/patient-assistant-chat.tsx"), "utf8");
    assert.match(component, /Confirm/);
    assert.match(component, /Dismiss/);
    assert.match(component, /Your appointment is not confirmed yet/);
    assert.match(component, /if \(!intent \|\| inFlight\.current/);
    assert.match(component, /status === "pending" && isProposalExpired\(intent\.expires_at\)/);
  });

  it("shows confirmation-specific copy and no proposal controls for a backend-completed booking", () => {
    const completed = proposalStatusFromBackend("completed", "2099-01-01T00:00:00Z");
    assert.equal(completed, "completed");
    assert.equal(proposalTitle("book", completed), "Booking confirmed");
    assert.equal(proposalDescription("book", completed), "Your appointment has been successfully confirmed.");
    assert.equal(proposalTitle("book", "pending"), "Booking proposal");
    const component = fs.readFileSync(path.join(projectRoot, "components/patient-assistant-chat.tsx"), "utf8");
    assert.match(component, /const completedBooking = actionType === "book" && status === "completed"/);
    assert.match(component, /\{completedBooking \? null : <Button[^>]*aria-label="Dismiss proposal"/);
    assert.match(component, /\{status === "pending" \? <div/);
    assert.match(component, /onClick=\{\(\) => void confirm\(\)\}>Confirm/);
    assert.match(component, /status === "completed" && !completedBooking/);
  });

  it("does not let a late prepare response revive a dismissing or dismissed card", () => {
    const future = "2099-01-01T00:00:00Z";
    assert.equal(preserveDismissalOnPrepare("dismissing", "pending", future), "dismissing");
    assert.equal(preserveDismissalOnPrepare("dismissed", "pending", future), "dismissed");
    const component = fs.readFileSync(path.join(projectRoot, "components/patient-assistant-chat.tsx"), "utf8");
    assert.match(component, /if \(!active \|\| dismissed\.current\) return/);
    assert.match(component, /await dismissAssistantProposal\(/);
  });

  it("keeps a backend dismissal after the conversation is reopened", async () => {
    const previousFetch = global.fetch;
    const previousUrl = process.env.NEXT_PUBLIC_API_URL;
    const calls = [];
    process.env.NEXT_PUBLIC_API_URL = "https://api.example.test";
    global.fetch = async (url, options) => {
      calls.push({ url, options });
      return new Response(JSON.stringify({ status: "dismissed" }), { status: 200, headers: { "content-type": "application/json" } });
    };
    try {
      const dismissed = await dismissAssistantProposal("token", "conversation", "assistant-message", "cancel");
      const reopened = await prepareAssistantAction("token", "conversation", "assistant-message", "cancel");
      assert.equal(dismissed.status, "dismissed");
      assert.equal(reopened.status, "dismissed");
      assert.deepEqual(JSON.parse(calls[0].options.body), { assistant_message_id: "assistant-message", action_type: "cancel" });
      assert.equal(calls[0].url.endsWith("/actions/dismiss"), true);
    } finally {
      global.fetch = previousFetch;
      if (previousUrl === undefined) delete process.env.NEXT_PUBLIC_API_URL;
      else process.env.NEXT_PUBLIC_API_URL = previousUrl;
    }
  });

  it("recovers a completed booking from status after checkout and checks status after confirm network failure", async () => {
    const now = Date.now();
    const restoredCheckout = await reconcileActionStatus(async () => ({ status: "checkout_pending", expires_at: new Date(now - 1000).toISOString() }), "failed", now);
    assert.equal(restoredCheckout.status, "checkout_pending");

    const previousFetch = global.fetch;
    const previousUrl = process.env.NEXT_PUBLIC_API_URL;
    process.env.NEXT_PUBLIC_API_URL = "https://api.example.test";
    global.fetch = async () => new Response(JSON.stringify({ id: "44444444-4444-4444-8444-444444444444", action_type: "book", status: "completed", expires_at: new Date(now - 1000).toISOString(), summary: { doctor: "Dr. Dee Doctor" } }), { status: 200, headers: { "content-type": "application/json" } });
    try {
      const completed = await reconcileActionStatus(() => getAssistantActionStatus("token", "conversation", "44444444-4444-4444-8444-444444444444"), "checkout_pending", now);
      assert.equal(completed.status, "completed");
      assert.deepEqual(completed.summary, { doctor: "Dr. Dee Doctor" });
    } catch (error) {
      global.fetch = previousFetch;
      if (previousUrl === undefined) delete process.env.NEXT_PUBLIC_API_URL;
      else process.env.NEXT_PUBLIC_API_URL = previousUrl;
      throw error;
    }
    let calls = 0;
    global.fetch = async () => {
      calls += 1;
      if (calls === 1) throw new Error("connection reset");
      return new Response(JSON.stringify({ id: "44444444-4444-4444-8444-444444444444", action_type: "book", status: "pending", expires_at: new Date(now + 60000).toISOString() }), { status: 200, headers: { "content-type": "application/json" } });
    };
    try {
      await assert.rejects(confirmAssistantAction("token", "conversation", "44444444-4444-4444-8444-444444444444"), AssistantApiError);
      const recovered = await reconcileActionStatus(() => getAssistantActionStatus("token", "conversation", "44444444-4444-4444-8444-444444444444"), "failed", now);
      assert.equal(recovered.status, "pending");
      assert.equal(calls, 2);
    } finally {
      global.fetch = previousFetch;
      if (previousUrl === undefined) delete process.env.NEXT_PUBLIC_API_URL;
      else process.env.NEXT_PUBLIC_API_URL = previousUrl;
    }
    const component = fs.readFileSync(path.join(projectRoot, "components/patient-assistant-chat.tsx"), "utf8");
    assert.match(component, /reconcileActionStatus\(async \(\) =>/);
  });

  it("prepares proposals without sending record IDs and accepts checkout-pending confirmation", async () => {
    const previousFetch = global.fetch;
    const previousUrl = process.env.NEXT_PUBLIC_API_URL;
    const calls = [];
    process.env.NEXT_PUBLIC_API_URL = "https://api.example.test";
    global.fetch = async (url, options) => {
      calls.push({ url, options });
      if (options.method === "POST" && !url.endsWith("/confirm")) return new Response(JSON.stringify({ id: "44444444-4444-4444-8444-444444444444", action_type: "book", status: "pending", expires_at: "2099-01-01T00:00:00Z", summary: { doctor: "Dr. Dee Doctor", date: "2099-01-01", start_time: "09:00", consultation_fee: "500.00", currency: "INR" } }), { status: 201, headers: { "content-type": "application/json" } });
      return new Response(JSON.stringify({ status: "checkout_pending", checkout_url: "https://checkout.example.test/session" }), { status: 200, headers: { "content-type": "application/json" } });
    };
    try {
      const prepared = await prepareAssistantAction("token", "22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333", "book");
      const requestBody = JSON.parse(calls[0].options.body);
      assert.deepEqual(requestBody, { assistant_message_id: "33333333-3333-4333-8333-333333333333", action_type: "book" });
      assert.equal(prepared.summary.doctor, "Dr. Dee Doctor");
      const confirmed = await confirmAssistantAction("token", "22222222-2222-4222-8222-222222222222", prepared.id);
      assert.equal(confirmed.status, "checkout_pending");
      assert.equal(confirmed.checkout_url, "https://checkout.example.test/session");
      assert.equal(calls[1].options.method, "POST");
    } finally {
      global.fetch = previousFetch;
      if (previousUrl === undefined) delete process.env.NEXT_PUBLIC_API_URL;
      else process.env.NEXT_PUBLIC_API_URL = previousUrl;
    }
  });

  it("surfaces expired action API responses with their stable code", async () => {
    const previousFetch = global.fetch;
    const previousUrl = process.env.NEXT_PUBLIC_API_URL;
    process.env.NEXT_PUBLIC_API_URL = "https://api.example.test";
    global.fetch = async () => new Response(JSON.stringify({ error: { code: "ACTION_EXPIRED", message: "expired" } }), { status: 409, headers: { "content-type": "application/json" } });
    try {
      await assert.rejects(confirmAssistantAction("token", "conversation", "intent"), (error) => error instanceof AssistantApiError && error.code === "ACTION_EXPIRED" && /expired/i.test(error.message));
    } finally {
      global.fetch = previousFetch;
      if (previousUrl === undefined) delete process.env.NEXT_PUBLIC_API_URL;
      else process.env.NEXT_PUBLIC_API_URL = previousUrl;
    }
  });

  it("shows the user turn while loading and appends one response", () => {
    const submitted = chatReducer(initialChatState, { type: "submit", message: { requestId: "r1", role: "user", content: "hello" } });
    assert.equal(submitted.loading, true);
    const completed = chatReducer(submitted, { type: "success", requestId: "r1", user: { role: "user", content: "hello" }, assistant: { role: "assistant", content: "Hi" } });
    assert.equal(completed.loading, false);
    assert.equal(completed.messages.length, 2);
    assert.equal(completed.messages[1].content, "Hi");
  });

  it("clears the composer immediately after appending and restores a failed submission draft", () => {
    const chat = fs.readFileSync(path.join(projectRoot, "components/patient-assistant-chat.tsx"), "utf8");
    const submitStart = chat.indexOf("function submit(event:");
    const appendUser = chat.indexOf('dispatch({ type: "submit", message:', submitStart);
    const clearDraft = chat.indexOf('setDraft((current) => current.trim() === content ? "" : current)', submitStart);
    const deliverRequest = chat.indexOf("void deliver(requestId, content)", submitStart);
    assert.ok(submitStart >= 0 && appendUser < clearDraft && clearDraft < deliverRequest);
    assert.equal(restoreDraftAfterFailedSubmission("", "Submitted message"), "Submitted message");
    assert.equal(restoreDraftAfterFailedSubmission("A newer draft", "Submitted message"), "A newer draft");
    assert.match(chat, /setDraft\(\(current\) => restoreDraftAfterFailedSubmission\(current, content\)\)/);
  });

  it("accepts complete doctor-search and availability tool results from the assistant API", async () => {
    const previousFetch = global.fetch;
    const previousUrl = process.env.NEXT_PUBLIC_API_URL;
    process.env.NEXT_PUBLIC_API_URL = "https://api.example.test";
    global.fetch = async () => ({
      status: 200, ok: true,
      async json() { return {
        user_message: { id: "u", role: "user", content: "Show availability for him", request_id: "r", request_status: "complete" },
        assistant_message: { id: "a", role: "assistant", content: "Here are available times.", results: [
          { tool: "search_doctors", data: { doctors: [{ name: "Dr. Ali Ahmed", specialty: "Cardiology" }] } },
          { tool: "get_available_slots", data: { slots: [{ date: "2027-01-06", start_time: "10:00:00", end_time: "10:30:00", doctor: { name: "Dr. Ali Ahmed" } }] } },
          { tool: "get_doctor_schedules", data: { schedules: [{ mode: "wave" }], notice: "Point-in-time view." } },
          { tool: "get_doctor_schedule_exceptions", data: { exceptions: [{ date: "2027-01-07" }], notice: "Point-in-time view." } },
          { tool: "get_doctor_schedule_conflicts", data: { conflicts: [{ date: "2027-01-07", conflicts: ["payment_hold"] }], notice: "Point-in-time view." } },
          { tool: "get_doctor_nearest_slots", data: { slots: [{ date: "2027-01-08", mode: "stream" }], notice: "Point-in-time view." } },
        ] },
        replayed: false,
      }; },
    });
    try {
      const response = await sendAssistantMessage("token", "conversation", "r", "Show availability for him");
      assert.deepEqual(response.assistant_message.results.map(({ tool }) => tool), ["search_doctors", "get_available_slots", "get_doctor_schedules", "get_doctor_schedule_exceptions", "get_doctor_schedule_conflicts", "get_doctor_nearest_slots"]);
    } finally {
      global.fetch = previousFetch;
      if (previousUrl === undefined) delete process.env.NEXT_PUBLIC_API_URL;
      else process.env.NEXT_PUBLIC_API_URL = previousUrl;
    }
  });

  it("keeps one failed user message so retry does not duplicate it", () => {
    const submitted = chatReducer(initialChatState, { type: "submit", message: { requestId: "stable-key", role: "user", content: "Find a doctor" } });
    const failed = chatReducer(submitted, { type: "failure", requestId: "stable-key", message: "Network unavailable" });
    const retried = chatReducer(failed, { type: "success", requestId: "stable-key", user: { role: "user", content: "Find a doctor" }, assistant: { role: "assistant", content: "Found doctors" } });
    assert.equal(failed.messages.length, 1);
    assert.equal(failed.messages[0].failed, true);
    assert.equal(retried.messages.filter((item) => item.role === "user").length, 1);
    assert.equal(retried.messages[0].failed, false);
  });

  it("preserves the visible transcript when a conversation send fails", () => {
    const history = chatReducer(initialChatState, { type: "restore", messages: [
      { id: "saved-user", role: "user", content: "Earlier question" },
      { id: "saved-assistant", role: "assistant", content: "Earlier answer" },
    ] });
    const submitted = chatReducer(history, { type: "submit", message: { requestId: "request-2", role: "user", content: "New question" } });
    const failed = chatReducer(submitted, { type: "failure", requestId: "request-2", message: "Conversation not found" });
    assert.deepEqual(failed.messages.map(({ content }) => content), ["Earlier question", "Earlier answer", "New question"]);
    assert.equal(failed.messages[2].failed, true);
    assert.equal(failed.error, "Conversation not found");
    const settled = chatReducer(failed, { type: "loading", value: false });
    assert.equal(settled.error, "Conversation not found");
    assert.deepEqual(settled.messages, failed.messages);
  });

  it("enables sending after history failure only when the existing conversation ID is retained", () => {
    assert.equal(canSendAssistantMessage({ ready: false, loading: false, draft: "hello", historyLoadFailed: true, hasConversation: true }), false);
    assert.equal(canSendAssistantMessage({ ready: true, loading: false, draft: "hello", historyLoadFailed: true, hasConversation: true }), true);
    assert.equal(canSendAssistantMessage({ ready: true, loading: false, draft: "hello", historyLoadFailed: true, hasConversation: false }), false);
    assert.equal(canSendAssistantMessage({ ready: true, loading: true, draft: "hello", historyLoadFailed: false, hasConversation: true }), false);
  });

  it("renders only the filtered appointment rows returned by the backend", () => {
    const filteredAppointment = { date: "2099-08-10", start_time: "10:00:00", end_time: "10:30:00", doctor: { name: "Dr. Dee Doctor" } };
    const assistant = {
      role: "assistant",
      content: "Your next appointment is on 10 August.",
      results: [{ tool: "get_patient_appointments", data: { appointments: [filteredAppointment] } }],
    };
    const submitted = chatReducer(initialChatState, { type: "submit", message: { requestId: "r1", role: "user", content: "When is my next appointment?" } });
    const state = chatReducer(submitted, { type: "success", requestId: "r1", user: { role: "user", content: "When is my next appointment?" }, assistant });
    const rows = getAssistantResultRows(state.messages[1].results[0]);
    const component = fs.readFileSync(path.join(projectRoot, "components/patient-assistant-chat.tsx"), "utf8");
    assert.deepEqual(rows, [filteredAppointment]);
    assert.match(component, /const rows = getAssistantResultRows\(result\)/);
    assert.equal(rows.length, 1);
  });

  it("renders up to five availability results with mode-specific capacity wording", () => {
    const slots = [
      { date: "2099-08-10", start_time: "10:00:00", end_time: "10:30:00", mode: "wave", capacity: 4, remaining_capacity: 2, doctor_id: "d1", doctor: { name: "Dr. Dee Doctor" }, specialty: "Cardiology", consultation_fee: 500 },
      { date: "2099-08-10", start_time: "11:00:00", end_time: "13:00:00", mode: "stream", capacity: 8, remaining_capacity: 3, doctor_id: "d2", doctor: { name: "Dr. Ada Doctor" }, specialty: "Neurology", consultation_fee: 700 },
      { date: "2099-08-09", start_time: "09:00:00", end_time: "09:30:00", mode: "legacy", capacity: 1, remaining_capacity: 1, doctor_id: "d3", doctor: { name: "Dr. Lee Doctor" }, specialty: "General Practice", consultation_fee: 300 },
    ];
    const component = fs.readFileSync(path.join(projectRoot, "components/patient-assistant-chat.tsx"), "utf8");
    assert.equal(getAssistantResultRows({ tool: "get_available_slots", data: { slots } }).length, 3);
    assert.match(component, /Available slot · Wave/);
    assert.match(component, /Available window · Stream/);
    assert.match(component, /remaining_capacity.*capacity/);
    assert.match(component, /in this window/);
    assert.match(component, /in this slot/);
    assert.match(component, /Legacy availability · mode unknown/);
  });

  it("renders doctor schedule, exception, conflict, and nearest-slot result shapes", () => {
    const results = [
      { tool: "get_doctor_schedules", data: { schedules: [{ mode: "wave", recurrence_type: "weekly", visibility: "public", periods: [{ weekday: 1, start_time: "09:00", end_time: "12:00" }] }], notice: "Point-in-time view." } },
      { tool: "get_doctor_schedule_exceptions", data: { exceptions: [{ date: "2027-02-01", exception_type: "day_off", periods: [] }], notice: "Point-in-time view." } },
      { tool: "get_doctor_schedule_conflicts", data: { conflicts: [{ date: "2027-02-01", start_time: "09:00", end_time: "09:30", mode: "wave", capacity: 2, occupied: 2, remaining_capacity: 0, conflicts: ["confirmed_appointment", "payment_hold"] }], notice: "Point-in-time view." } },
      { tool: "get_doctor_nearest_slots", data: { slots: [{ date: "2027-02-02", start_time: "10:00", end_time: "10:30", mode: "wave", capacity: 3, remaining_capacity: 1 }], notice: "Point-in-time view." } },
    ];
    const component = fs.readFileSync(path.join(projectRoot, "components/patient-assistant-chat.tsx"), "utf8");
    assert.deepEqual(results.map((result) => getAssistantResultRows(result).length), [1, 1, 1, 1]);
    for (const label of ["Scheduling conflicts", "Schedule exceptions", "Available times", "Available slot · Wave", "No matching records were found", "result.data.notice"]) assert.ok(component.includes(label));
    for (const tool of ["get_doctor_schedules", "get_doctor_schedule_exceptions", "get_doctor_schedule_conflicts", "get_doctor_nearest_slots"]) assert.ok(component.includes(tool));
    assert.match(getAssistantDisplayContent("Schedule details", results.slice(0, 1)), /matching results/i);
  });

  it("wires doctor navigation and mode while keeping patient behavior and action cards isolated", () => {
    const chat = fs.readFileSync(path.join(projectRoot, "components/patient-assistant-chat.tsx"), "utf8");
    const page = fs.readFileSync(path.join(projectRoot, "app/doctor/assistant/page.tsx"), "utf8");
    const shell = fs.readFileSync(path.join(projectRoot, "components/role-application-shell.tsx"), "utf8");
    const dashboard = fs.readFileSync(path.join(projectRoot, "components/dashboard-pages.tsx"), "utf8");
    const launcher = fs.readFileSync(path.join(projectRoot, "components/patient-assistant-launcher.tsx"), "utf8");
    assert.match(page, /PatientAssistantChat audience="doctor"/);
    assert.match(shell, /label: "AI Assistant", href: "\/doctor\/assistant"/);
    assert.match(dashboard, /href="\/doctor\/assistant" title="Doctor AI Assistant"/);
    assert.match(chat, /audience = "patient"/);
    assert.match(chat, /audience === "doctor" \? "\/doctor\/assistant" : "\/patient\/assistant"/);
    assert.match(chat, /!doctorMode && message\.role === "assistant"[\s\S]*proposalTypeForResult/);
    assert.match(launcher, /PatientAssistantChat compact/);
    assert.match(launcher, /pathname === "\/patient\/assistant" \|\| pathname\.startsWith\("\/patient\/assistant\/"\)/);
    assert.match(shell, /requiredRole === "patient" \? <PatientAssistantLauncher/);
  });

  it("hides empty result cards and all cards attached to refusal responses", () => {
    const appointment = { date: "2026-11-13", start_time: "10:00", end_time: "13:00", doctor: { name: "Dr. Ali Ahmed" } };
    const populated = { tool: "get_patient_appointments", data: { appointments: [appointment] } };
    const empty = { tool: "get_patient_appointments", data: { appointments: [] } };
    assert.deepEqual(getVisibleAssistantResults("Here is your appointment.", [empty]), []);
    assert.deepEqual(getVisibleAssistantResults("I can’t book, reschedule, or cancel appointments for you.", [populated]), []);
    assert.deepEqual(getVisibleAssistantResults("Here is the appointment you asked about.", [populated]), [populated]);
  });

  it("does not render appointment cards for a refund-only assistant result", () => {
    const refund = { tool: "get_cancellation_refund_preview", data: { original_payment: { amount: "500.00", currency: "INR", status: "partially_refunded" }, processed_refund_amount: "100.00", pending_refund_amount: "25.00", estimated_additional_refund_amount: "125.00" } };
    assert.deepEqual(getAssistantResultRows(refund), []);
    assert.deepEqual(getVisibleAssistantResults("Here is the verified refund preview.", [refund]), []);
  });

  it("replaces verbose result narration with one contextual sentence and suppresses duplicate doctor cards", () => {
    const appointments = { tool: "get_patient_appointments", data: { appointments: [{ date: "2026-11-13", start_time: "10:00", end_time: "13:00", doctor: { name: "Dr. Ali Ahmed" } }] } };
    const doctors = { tool: "search_doctors", data: { doctors: [{ name: "Dr. Ali Ahmed", specialty: "General Practice" }] } };
    const slots = { tool: "get_available_slots", data: { slots: Array.from({ length: 5 }, (_, index) => ({ date: `2026-11-${13 + index}`, start_time: "10:00", end_time: "13:00", mode: "stream" })) } };
    assert.equal(getAssistantDisplayContent("Your appointment with Dr. Ali Ahmed is November 13 from 10 AM to 1 PM.", [appointments]), "Here is your appointment:");
    assert.equal(getAssistantDisplayContent("I found five slots: ...details repeated...", [doctors, slots]), "Here are the 5 earliest available options:");
    assert.equal(getVisibleAssistantResults("Here are options.", [doctors, slots]).length, 1);
    assert.equal(getAssistantDisplayContent("Thanks for explaining how availability works.", []), "Thanks for explaining how availability works.");
  });

  it("keeps result cards on the assistant message for their own turn only", () => {
    const prior = { id: "prior-a", role: "assistant", content: "Your appointment is tomorrow.", results: [{ tool: "get_patient_appointments", data: { appointments: [{ doctor: { name: "Dr. Ali Ahmed" } }] } }] };
    const state = chatReducer({ ...initialChatState, messages: [prior] }, { type: "success", requestId: "request-2", user: { requestId: "request-2", role: "user", content: "Show me another patient's appointments." }, assistant: { id: "current-a", role: "assistant", content: "I cannot show another patient's appointments.", results: [] } });
    assert.equal(state.messages[1].results.length, 0);
    assert.equal(getVisibleAssistantResults(state.messages[1].content, state.messages[1].results).length, 0);
    assert.equal(getVisibleAssistantResults(state.messages[0].content, state.messages[0].results).length, 1);
  });

  it("auto-scrolls only near the bottom and preserves position after older messages are prepended", () => {
    assert.equal(isNearMessageListBottom(1000, 400, 540), true);
    assert.equal(isNearMessageListBottom(1000, 400, 400), false);
    assert.equal(isNearMessageListTop(40), true);
    assert.equal(isNearMessageListTop(120), false);
    assert.equal(preserveScrollAfterPrepend(1600, 1200, 20), 420);
    const current = chatReducer(initialChatState, { type: "restore", messages: [
      { id: "user-id", requestId: "stable-request", role: "user", content: "Recent question" },
      { id: "assistant-id", role: "assistant", content: "Recent answer" },
    ] });
    const prepended = chatReducer(current, { type: "prepend", messages: [
      { id: "older-id", role: "assistant", content: "Older answer" },
      { id: "duplicate-user", requestId: "stable-request", role: "user", content: "Recent question" },
    ] });
    assert.deepEqual(prepended.messages.map((message) => message.id), ["older-id", "user-id", "assistant-id"]);
  });

  it("requests 20 older messages using the before cursor", async () => {
    const originalFetch = globalThis.fetch; const originalApiUrl = process.env.NEXT_PUBLIC_API_URL;
    let requestUrl; process.env.NEXT_PUBLIC_API_URL = "https://api.example.test";
    globalThis.fetch = async (url) => {
      requestUrl = String(url);
      return new Response(JSON.stringify({ conversation: { id: "conversation", created_at: "2026-01-01", updated_at: "2026-01-02" }, messages: [], has_more: false, next_before: null }), { status: 200, headers: { "content-type": "application/json" } });
    };
    try {
      await getAssistantConversation("session", "conversation", { limit: 20, before: "older-cursor" });
      assert.match(requestUrl, /\?limit=20&before=older-cursor$/);
    } finally { globalThis.fetch = originalFetch; if (originalApiUrl === undefined) delete process.env.NEXT_PUBLIC_API_URL; else process.env.NEXT_PUBLIC_API_URL = originalApiUrl; }
  });

  it("opens the exact listed conversation and accepts persisted refund-preview tool results", async () => {
    const originalFetch = globalThis.fetch; const originalApiUrl = process.env.NEXT_PUBLIC_API_URL;
    const conversationId = "22222222-2222-4222-8222-222222222222";
    const calls = [];
    process.env.NEXT_PUBLIC_API_URL = "https://api.example.test";
    globalThis.fetch = async (url) => {
      calls.push(String(url));
      if (calls.length === 1) return new Response(JSON.stringify({ items: [{ id: conversationId, created_at: "2027-01-20T00:00:00.000Z", updated_at: "2027-01-20T00:01:00.000Z", preview: "What refund applies?" }], limit: 50, offset: 0 }), { status: 200, headers: { "content-type": "application/json" } });
      return new Response(JSON.stringify({
        conversation: { id: conversationId, created_at: "2027-01-20T00:00:00.000Z", updated_at: "2027-01-20T00:01:00.000Z" },
        messages: [{ id: "assistant-message", role: "assistant", content: "The estimate is INR 50.", created_at: "2027-01-20T00:01:00.000Z", results: [{ tool: "get_cancellation_refund_preview", data: { estimated_additional_refund_amount: "50.00" } }] }],
        has_more: false,
        next_before: null,
      }), { status: 200, headers: { "content-type": "application/json" } });
    };
    try {
      const listed = await listAssistantConversations("session");
      const selected = listed.items[0].id;
      const detail = await getAssistantConversation("session", selected);
      assert.equal(selected, conversationId);
      assert.match(calls[1], new RegExp(`/conversations/${conversationId}\\?limit=20$`));
      assert.equal(detail.conversation.id, conversationId);
      assert.equal(detail.messages[0].results[0].tool, "get_cancellation_refund_preview");
    } finally { globalThis.fetch = originalFetch; if (originalApiUrl === undefined) delete process.env.NEXT_PUBLIC_API_URL; else process.env.NEXT_PUBLIC_API_URL = originalApiUrl; }
  });

  it("returns a specific, non-destructive error when saved history cannot be parsed", async () => {
    const originalFetch = globalThis.fetch; const originalApiUrl = process.env.NEXT_PUBLIC_API_URL;
    process.env.NEXT_PUBLIC_API_URL = "https://api.example.test";
    globalThis.fetch = async () => new Response(JSON.stringify({ conversation: {}, messages: [], has_more: false, next_before: null }), { status: 200, headers: { "content-type": "application/json" } });
    try {
      await assert.rejects(getAssistantConversation("session", "22222222-2222-4222-8222-222222222222"), (error) => error.code === "ASSISTANT_RESPONSE_INVALID" && /selected conversation was kept/.test(error.message));
    } finally { globalThis.fetch = originalFetch; if (originalApiUrl === undefined) delete process.env.NEXT_PUBLIC_API_URL; else process.env.NEXT_PUBLIC_API_URL = originalApiUrl; }
  });

  it("sends an idempotency key and conversation ID to the persistent message route", async () => {
    const originalFetch = globalThis.fetch; const originalApiUrl = process.env.NEXT_PUBLIC_API_URL;
    let request; process.env.NEXT_PUBLIC_API_URL = "https://api.example.test/";
    globalThis.fetch = async (url, init) => {
      request = { url, init };
      return new Response(JSON.stringify({ user_message: { id: "u", role: "user", content: "hello", request_id: "same-request" }, assistant_message: { id: "a", role: "assistant", content: "Hi", results: [] }, replayed: true }), { status: 200, headers: { "content-type": "application/json" } });
    };
    try {
      const result = await sendAssistantMessage("session", "conversation", "same-request", "hello");
      assert.equal(request.url, "https://api.example.test/api/v1/assistant/conversations/conversation/messages");
      assert.equal(request.init.headers.Authorization, "Bearer session");
      assert.deepEqual(JSON.parse(request.init.body), { request_id: "same-request", content: "hello" });
      assert.equal(result.assistant_message.content, "Hi");
    } finally { globalThis.fetch = originalFetch; if (originalApiUrl === undefined) delete process.env.NEXT_PUBLIC_API_URL; else process.env.NEXT_PUBLIC_API_URL = originalApiUrl; }
  });

  it("maps stable assistant error codes to safe English messages", async () => {
    const originalFetch = globalThis.fetch; const originalApiUrl = process.env.NEXT_PUBLIC_API_URL;
    process.env.NEXT_PUBLIC_API_URL = "https://api.example.test";
    globalThis.fetch = async () => new Response(JSON.stringify({ error: { code: "RATE_LIMITED", message: "raw server detail" } }), { status: 429, headers: { "content-type": "application/json" } });
    try {
      await assert.rejects(sendAssistantMessage("session", "conversation", "request", "hello"), (error) => error.code === "RATE_LIMITED" && error.message === "You're sending messages too quickly. Please wait a moment before trying again.");
    } finally { globalThis.fetch = originalFetch; if (originalApiUrl === undefined) delete process.env.NEXT_PUBLIC_API_URL; else process.env.NEXT_PUBLIC_API_URL = originalApiUrl; }
  });

  it("explains conversation-not-found without suggesting replacement or clearing visible history", async () => {
    const originalFetch = globalThis.fetch; const originalApiUrl = process.env.NEXT_PUBLIC_API_URL;
    process.env.NEXT_PUBLIC_API_URL = "https://api.example.test";
    globalThis.fetch = async () => new Response(JSON.stringify({ error: { code: "CONVERSATION_NOT_FOUND", message: "Conversation not found" } }), { status: 404, headers: { "content-type": "application/json" } });
    try {
      await assert.rejects(sendAssistantMessage("session", "missing-conversation", "request", "hello"), (error) => error.code === "CONVERSATION_NOT_FOUND" && /visible messages are still here/.test(error.message) && /No replacement conversation was created/.test(error.message));
    } finally { globalThis.fetch = originalFetch; if (originalApiUrl === undefined) delete process.env.NEXT_PUBLIC_API_URL; else process.env.NEXT_PUBLIC_API_URL = originalApiUrl; }
  });

  it("retains the requested conversation, restores send readiness, and offers explicit new-chat recovery", () => {
    const chat = fs.readFileSync(path.join(projectRoot, "components/patient-assistant-chat.tsx"), "utf8");
    const state = fs.readFileSync(path.join(projectRoot, "lib/assistant-chat-state.ts"), "utf8");
    const retainedReference = chat.indexOf("conversationId.current = id;");
    const historyLookup = chat.indexOf("await getAssistantConversation(token, id");
    const createConversation = chat.indexOf("await createAssistantConversation(token, id)");
    const assignAfterCreate = chat.indexOf("conversationId.current = id;", createConversation);
    assert.ok(retainedReference >= 0 && retainedReference < historyLookup);
    assert.ok(createConversation >= 0 && assignAfterCreate > createConversation);
    assert.match(chat, /finally \{ setReady\(true\)/);
    assert.match(chat, /retryOperation\(state\.errorSource\)/);
    const submitHandler = chat.slice(chat.indexOf("function submit("), chat.indexOf("const retry ="));
    assert.ok(submitHandler.indexOf('dispatch({ type: "submit"') < submitHandler.indexOf('setDraft((current) => current.trim() === content ? "" : current)'));
    assert.ok(submitHandler.indexOf('setDraft((current) => current.trim() === content ? "" : current)') < submitHandler.indexOf("void deliver(requestId, content)"));
    assert.match(chat, /restoreDraftAfterFailedSubmission\(current, content\)/);
    assert.match(state, /historyLoadFailed && !hasConversation/);
    assert.match(chat, /Start new conversation/);
    assert.match(chat, /Find saved conversations/);
  });

  it("offers saved-history recovery without switching IDs until the selected history loads", () => {
    const chat = fs.readFileSync(path.join(projectRoot, "components/patient-assistant-chat.tsx"), "utf8");
    const recoveryStart = chat.indexOf("const openSavedConversation = useCallback");
    const fetchSelectedHistory = chat.indexOf("await getAssistantConversation(token, id", recoveryStart);
    const switchReference = chat.indexOf("conversationId.current = stored.conversation.id", recoveryStart);
    assert.ok(recoveryStart >= 0 && fetchSelectedHistory > recoveryStart);
    assert.ok(switchReference > fetchSelectedHistory);
    assert.match(chat, /recoveryTargetId\.current = id;/);
    assert.match(chat, /operation === "history" && recoveryTargetId\.current/);
    assert.match(chat, /const saved = await listAssistantConversations\(token\)/);
    assert.match(chat, /setRecoveryConversations\(saved.items\)/);
  });

  it("reuses the same chat implementation in the full page and floating panel", () => {
    const chat = fs.readFileSync(path.join(projectRoot, "components/patient-assistant-chat.tsx"), "utf8");
    const launcher = fs.readFileSync(path.join(projectRoot, "components/patient-assistant-launcher.tsx"), "utf8");
    const shell = fs.readFileSync(path.join(projectRoot, "components/role-application-shell.tsx"), "utf8");
    assert.match(chat, /export function PatientAssistantChat/);
    assert.match(launcher, /<PatientAssistantChat compact/);
    assert.match(shell, /requiredRole === "patient" \? <PatientAssistantLauncher/);
  });

  it("places an accessible red retry icon outside the failed bubble and bounds the composer", () => {
    const chat = fs.readFileSync(path.join(projectRoot, "components/patient-assistant-chat.tsx"), "utf8");
    assert.match(chat, /UserRound/);
    assert.doesNotMatch(chat, /message\.role === "user" \? "You"/);
    assert.match(chat, /mx-auto flex w-full items-end/);
    assert.match(chat, /import \{[^}]*RefreshCw[^}]*\} from "lucide-react"/);
    assert.match(chat, /aria-label="Retry this message"/);
    assert.match(chat, /role="tooltip"[^>]*>Retry this message<\/span>/);
    assert.match(chat, /group-hover:opacity-100 group-focus-within:opacity-100/);
    assert.match(chat, /text-destructive hover:bg-destructive\/10/);
    assert.match(chat, /aria-label="Retry this message"[^\n]*onClick=\{\(\) => void deliver\(message\.requestId!, message\.content\)\}/);
    assert.match(chat, /if \(requestInFlight\.current\) return/);
    assert.match(chat, /<\/div>\s*<\/div>\s*<time[\s\S]*?<\/time>\s*\{message\.failed && message\.requestId \? <div className="mt-1/);
    assert.match(chat, /Your care, easier to navigate/);
  });

  it("keeps the composer visible and the message list independently scrollable", () => {
    const chat = fs.readFileSync(path.join(projectRoot, "components/patient-assistant-chat.tsx"), "utf8");
    assert.match(chat, /className="absolute inset-0 space-y-4 overflow-y-auto/);
    assert.match(chat, /sticky bottom-0 z-10 shrink-0 border-t/);
    assert.match(chat, /h-\[calc\(100dvh-4rem\)\] min-h-0/);
    assert.match(chat, /history\.hasMore && nearTop/);
    assert.match(chat, /border-b border-border pb-2/);
    assert.match(chat, /ArrowUp/);
    assert.match(chat, /Load older messages/);
    assert.match(chat, /Scroll to latest messages/);
    assert.match(chat, /absolute bottom-4 right-4/);
    assert.match(chat, /element\.scrollTo\(\{ top: element\.scrollHeight, behavior:/);
    assert.match(chat, /prefers-reduced-motion: reduce/);
    assert.match(chat, /prependAnchor\.current = \{ scrollHeight: container\.scrollHeight, scrollTop: container\.scrollTop \}/);
    assert.match(chat, /isNearMessageListBottom\(element\.scrollHeight, element\.clientHeight, element\.scrollTop\)/);
  });
});
