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
const { chatReducer, getAssistantResultRows, initialChatState, isNearMessageListBottom, preserveScrollAfterPrepend } = loadTs("lib/assistant-chat-state.ts");
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

  it("auto-scrolls only near the bottom and preserves position after older messages are prepended", () => {
    assert.equal(isNearMessageListBottom(1000, 400, 540), true);
    assert.equal(isNearMessageListBottom(1000, 400, 400), false);
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
    assert.match(chat, /className="min-h-0 flex-1 space-y-4 overflow-y-auto/);
    assert.match(chat, /sticky bottom-0 z-10 shrink-0 border-t/);
    assert.match(chat, /h-\[calc\(100dvh-4rem\)\] min-h-0/);
    assert.match(chat, /history\.hasMore \|\| history\.loadingOlder \|\| history\.olderError/);
    assert.match(chat, /Load older messages/);
    assert.match(chat, /prependAnchor\.current = \{ scrollHeight: container\.scrollHeight, scrollTop: container\.scrollTop \}/);
    assert.match(chat, /isNearMessageListBottom\(element\.scrollHeight, element\.clientHeight, element\.scrollTop\)/);
  });
});
