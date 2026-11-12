const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { describe, it } = require("node:test");
const { createAssistantConversationService, AssistantConversationError } = require("../src/services/assistantConversationService");
const { createConversationEngine } = require("../src/services/assistant/conversationEngine");

const user = { id: "11111111-1111-4111-8111-111111111111", role: "patient" };
const other = { id: "99999999-9999-4999-8999-999999999999", role: "patient" };
const conversationId = "22222222-2222-4222-8222-222222222222";
const requestId = "33333333-3333-4333-8333-333333333333";

function memoryDatabase(ownerId = user.id) {
  const state = { userMessage: null, assistantMessage: null, ownerId, values: [], assistantInsertCount: 0, statements: [] };
  const query = async (sql, values = []) => {
    state.statements.push(sql);
    if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [] };
    if (sql.includes("FROM assistant_conversations WHERE id = $1 AND user_id = $2 FOR UPDATE")) return { rows: values[1] === state.ownerId ? [{ id: conversationId }] : [] };
    if (sql.includes("FROM assistant_messages") && sql.includes("FOR UPDATE")) return { rows: state.userMessage?.id === values[0] ? [{ id: values[0] }] : [] };
    if (sql.includes("FROM assistant_messages WHERE conversation_id = $1 AND role = 'user' AND request_id = $2")) return { rows: state.userMessage ? [state.userMessage] : [] };
    if (sql.includes("reply_to_message_id = $1")) return { rows: state.assistantMessage ? [state.assistantMessage] : [] };
    if (sql.includes("INSERT INTO assistant_messages (conversation_id, role, content, request_id, request_status)")) {
      state.userMessage = { id: "44444444-4444-4444-8444-444444444444", role: "user", content: values[1], request_id: values[2], request_status: "processing", updated_at: new Date() };
      return { rows: [state.userMessage] };
    }
    if (sql.includes("SELECT role, content FROM assistant_messages")) return { rows: [] };
    if (sql.includes("INSERT INTO assistant_messages (conversation_id, role, content, reply_to_message_id, tool_results)")) {
      state.assistantInsertCount += 1;
      state.assistantMessage = { id: "55555555-5555-4555-8555-555555555555", role: "assistant", content: values[1], tool_results: JSON.parse(values[3]), created_at: new Date() };
      return { rows: [state.assistantMessage] };
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

  it("enforces conversation ownership before executing a message", async () => {
    const database = memoryDatabase(user.id);
    let calls = 0;
    const service = createAssistantConversationService({ engine: { respond: async () => { calls += 1; return { answer: "hello", results: [] }; } } });
    await assert.rejects(service.send({ database, user: other, conversationId, requestId, content: "hi" }), { code: "CONVERSATION_NOT_FOUND" });
    assert.equal(calls, 0);
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
