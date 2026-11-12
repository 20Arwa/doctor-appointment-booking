const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { createApp } = require("../src/app");
const { assistantChatSchema } = require("../src/validators/assistantSchemas");

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

function testApp({ actor = user, authenticated = true, engine = { respond: async () => ({ answer: "Ready", results: [] }) } } = {}) {
  return createApp({
    database: { query: async (sql, values = []) => {
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

describe("patient assistant API security", () => {
  it("requires Clerk identity, onboarding, and the patient role", async () => {
    await withServer(testApp({ authenticated: false }), async (url) => {
      const response = await fetch(`${url}/api/v1/assistant/conversations`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: conversationId }) });
      assert.equal(response.status, 401);
    });
    await withServer(testApp({ actor: { ...user, role: "doctor" } }), async (url) => {
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
