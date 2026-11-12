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
const { chatReducer, getAssistantDisplayContent, getAssistantResultRows, getVisibleAssistantResults, initialChatState, isNearMessageListBottom, isNearMessageListTop, preserveScrollAfterPrepend } = loadTs("lib/assistant-chat-state.ts");
const { getAssistantConversation, sendAssistantMessage } = loadTs("lib/assistant-api.ts");

describe("patient assistant chat", () => {
  it("shows the user turn while loading and appends one response", () => {
    const submitted = chatReducer(initialChatState, { type: "submit", message: { requestId: "r1", role: "user", content: "hello" } });
    assert.equal(submitted.loading, true);
    const completed = chatReducer(submitted, { type: "success", requestId: "r1", user: { role: "user", content: "hello" }, assistant: { role: "assistant", content: "Hi" } });
    assert.equal(completed.loading, false);
    assert.equal(completed.messages.length, 2);
    assert.equal(completed.messages[1].content, "Hi");
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

  it("hides empty result cards and all cards attached to refusal responses", () => {
    const appointment = { date: "2026-11-13", start_time: "10:00", end_time: "13:00", doctor: { name: "Dr. Ali Ahmed" } };
    const populated = { tool: "get_patient_appointments", data: { appointments: [appointment] } };
    const empty = { tool: "get_patient_appointments", data: { appointments: [] } };
    assert.deepEqual(getVisibleAssistantResults("Here is your appointment.", [empty]), []);
    assert.deepEqual(getVisibleAssistantResults("I can’t book, reschedule, or cancel appointments for you.", [populated]), []);
    assert.deepEqual(getVisibleAssistantResults("Here is the appointment you asked about.", [populated]), [populated]);
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
    assert.match(chat, /mx-auto flex w-full max-w-3xl items-end/);
    assert.match(chat, /import \{[^}]*RefreshCw[^}]*\} from "lucide-react"/);
    assert.match(chat, /aria-label="Retry this message"/);
    assert.match(chat, /role="tooltip"[^>]*>Retry this message<\/span>/);
    assert.match(chat, /group-hover:opacity-100 group-focus-within:opacity-100/);
    assert.match(chat, /text-destructive hover:bg-destructive\/10/);
    assert.match(chat, /aria-label="Retry this message"[^\n]*onClick=\{\(\) => void deliver\(message\.requestId!, message\.content\)\}/);
    assert.match(chat, /if \(requestInFlight\.current\) return/);
    assert.match(chat, /<\/div>\s*<\/div>\s*\{message\.failed && message\.requestId \? <div className="mt-1/);
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
