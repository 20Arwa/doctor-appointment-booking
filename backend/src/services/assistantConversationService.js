const DEFAULT_HISTORY_LIMIT = 20;
// This is the bounded model context, independent of UI message-page size.
const MODEL_CONTEXT_LIMIT = 11;
const PROCESSING_STALE_AFTER_SECONDS = 120;

class AssistantConversationError extends Error {
  constructor(code, status, message) { super(message); this.code = code; this.status = status; }
}

function messageView(row) {
  return {
    id: row.id,
    role: row.role,
    content: row.content,
    created_at: row.created_at,
    ...(row.role === "user" ? { request_id: row.request_id, request_status: row.request_status } : { results: row.tool_results || [] }),
  };
}

async function transaction(database, operation) {
  const client = await database.connect();
  try {
    await client.query("BEGIN");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

function createAssistantConversationService({ engine, now = Date.now }) {
  return {
    async create(database, user, conversationId) {
      await database.query(
        "INSERT INTO assistant_conversations (id, user_id) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING",
        [conversationId, user.id],
      );
      const owned = await database.query(
        "SELECT id, created_at, updated_at FROM assistant_conversations WHERE id = $1 AND user_id = $2",
        [conversationId, user.id],
      );
      if (!owned.rows[0]) throw new AssistantConversationError("CONVERSATION_NOT_FOUND", 404, "Conversation not found");
      return { conversation: owned.rows[0] };
    },

    async list(database, user, { limit = 20, offset = 0 } = {}) {
      const result = await database.query(
        `SELECT conversation.id, conversation.created_at, conversation.updated_at,
                latest.content AS preview
         FROM assistant_conversations conversation
         LEFT JOIN LATERAL (
           SELECT content FROM assistant_messages
           WHERE conversation_id = conversation.id AND role = 'user'
           ORDER BY created_at DESC, id DESC LIMIT 1
         ) latest ON TRUE
         WHERE conversation.user_id = $1
         ORDER BY conversation.updated_at DESC, conversation.id DESC
         LIMIT $2 OFFSET $3`,
        [user.id, limit, offset],
      );
      return { items: result.rows, limit, offset };
    },

    async get(database, user, conversationId, { limit = DEFAULT_HISTORY_LIMIT, before } = {}) {
      const owned = await database.query(
        "SELECT id, created_at, updated_at FROM assistant_conversations WHERE id = $1 AND user_id = $2",
        [conversationId, user.id],
      );
      if (!owned.rows[0]) throw new AssistantConversationError("CONVERSATION_NOT_FOUND", 404, "Conversation not found");
      const values = [conversationId, limit + 1];
      let cursor = "";
      if (before) {
        values.push(before);
        cursor = `AND (created_at, id) < (SELECT created_at, id FROM assistant_messages WHERE id = $${values.length} AND conversation_id = $1)`;
      }
      const rows = await database.query(
        `SELECT id, role, content, request_id, request_status, reply_to_message_id,
                tool_results, created_at
         FROM assistant_messages
         WHERE conversation_id = $1 ${cursor}
         ORDER BY created_at DESC, id DESC
         LIMIT $2`,
        values,
      );
      const hasMore = rows.rows.length > limit;
      const items = rows.rows.slice(0, limit).reverse().map(messageView);
      return { conversation: owned.rows[0], messages: items, has_more: hasMore, next_before: hasMore ? items[0]?.id || null : null };
    },

    async remove(database, user, conversationId) {
      const result = await database.query(
        "DELETE FROM assistant_conversations WHERE id = $1 AND user_id = $2 RETURNING id",
        [conversationId, user.id],
      );
      return result.rowCount > 0;
    },

    async send({ database, user, conversationId, requestId, diagnosticRequestId, content, applicationTimezone, logger = console }) {
      const claimed = await transaction(database, async (client) => {
        const conversation = await client.query(
          "SELECT id FROM assistant_conversations WHERE id = $1 AND user_id = $2 FOR UPDATE",
          [conversationId, user.id],
        );
        if (!conversation.rows[0]) throw new AssistantConversationError("CONVERSATION_NOT_FOUND", 404, "Conversation not found");

        const existing = await client.query(
          `SELECT id, content, request_status, updated_at
           FROM assistant_messages WHERE conversation_id = $1 AND role = 'user' AND request_id = $2`,
          [conversationId, requestId],
        );
        let userMessage = existing.rows[0];
        if (userMessage && userMessage.content !== content) {
          throw new AssistantConversationError("IDEMPOTENCY_KEY_REUSED", 409, "This message request ID was already used for different content");
        }
        const pending = await client.query(
          `SELECT id FROM assistant_messages
           WHERE conversation_id = $1 AND role = 'user' AND request_status = 'processing'
             AND request_id <> $2 LIMIT 1`,
          [conversationId, requestId],
        );
        if (pending.rows[0]) return { inProgress: true };
        if (userMessage?.request_status === "complete") {
          const reply = await client.query(
            `SELECT id, role, content, tool_results, created_at
             FROM assistant_messages WHERE reply_to_message_id = $1`,
            [userMessage.id],
          );
          return { replay: true, userMessage, assistantMessage: reply.rows[0] };
        }
        if (userMessage?.request_status === "processing" && now() - new Date(userMessage.updated_at).getTime() < PROCESSING_STALE_AFTER_SECONDS * 1000) {
          return { inProgress: true };
        }
        if (userMessage) {
          await client.query(
            "UPDATE assistant_messages SET request_status = 'processing', updated_at = NOW() WHERE id = $1",
            [userMessage.id],
          );
        } else {
          const inserted = await client.query(
            `INSERT INTO assistant_messages (conversation_id, role, content, request_id, request_status)
             VALUES ($1, 'user', $2, $3, 'processing')
             RETURNING id, role, content, request_id, request_status, created_at`,
            [conversationId, content, requestId],
          );
          userMessage = inserted.rows[0];
        }
        await client.query("UPDATE assistant_conversations SET updated_at = NOW() WHERE id = $1", [conversationId]);
        const prior = await client.query(
          `SELECT role, content FROM assistant_messages
           WHERE conversation_id = $1 AND id <> $2
             AND (role = 'assistant' OR (role = 'user' AND request_status = 'complete'))
           ORDER BY created_at DESC, id DESC LIMIT $3`,
          [conversationId, userMessage.id, MODEL_CONTEXT_LIMIT],
        );
        return { userMessage, context: [...prior.rows].reverse().concat({ role: "user", content }) };
      });

      if (claimed.inProgress) throw new AssistantConversationError("REQUEST_IN_PROGRESS", 409, "This message is still being processed. Retry shortly.");
      if (claimed.replay) {
        return { user_message: messageView({ ...claimed.userMessage, request_status: "complete" }), assistant_message: messageView(claimed.assistantMessage), replayed: true };
      }

      let completion;
      try {
        completion = await engine.respond({
          actor: user,
          messages: claimed.context,
          database,
          applicationTimezone,
          requestId: diagnosticRequestId,
          logger,
        });
      } catch (error) {
        await database.query(
          `UPDATE assistant_messages SET request_status = 'failed', updated_at = NOW()
           WHERE id = $1 AND request_status = 'processing'`,
          [claimed.userMessage.id],
        );
        throw error;
      }

      if (typeof completion?.answer !== "string" || [...completion.answer].length > 4000) {
        const error = new AssistantConversationError("ASSISTANT_RESPONSE_TOO_LONG", 502, "The assistant response was too long to save. Please retry your question.");
        await database.query(
          `UPDATE assistant_messages SET request_status = 'failed', updated_at = NOW()
           WHERE id = $1 AND request_status = 'processing'`,
          [claimed.userMessage.id],
        );
        throw error;
      }

      const completed = await transaction(database, async (client) => {
        const lockedUserMessage = await client.query(
          `SELECT id FROM assistant_messages
           WHERE id = $1 AND conversation_id = $2 AND role = 'user'
           FOR UPDATE`,
          [claimed.userMessage.id, conversationId],
        );
        if (!lockedUserMessage.rows[0]) {
          throw new AssistantConversationError("CONVERSATION_NOT_FOUND", 404, "Conversation not found");
        }
        const existingReply = await client.query(
          `SELECT id, role, content, tool_results, created_at
           FROM assistant_messages
           WHERE reply_to_message_id = $1 AND conversation_id = $2 AND role = 'assistant'`,
          [claimed.userMessage.id, conversationId],
        );
        if (existingReply.rows[0]) {
          await client.query(
            "UPDATE assistant_messages SET request_status = 'complete', updated_at = NOW() WHERE id = $1 AND request_status <> 'complete'",
            [claimed.userMessage.id],
          );
          return { message: existingReply.rows[0], replayed: true };
        }
        const assistant = await client.query(
          `INSERT INTO assistant_messages (conversation_id, role, content, reply_to_message_id, tool_results)
           VALUES ($1, 'assistant', $2, $3, $4::jsonb)
           RETURNING id, role, content, tool_results, created_at`,
          [conversationId, completion.answer, claimed.userMessage.id, JSON.stringify(completion.results || [])],
        );
        await client.query(
          "UPDATE assistant_messages SET request_status = 'complete', updated_at = NOW() WHERE id = $1",
          [claimed.userMessage.id],
        );
        await client.query("UPDATE assistant_conversations SET updated_at = NOW() WHERE id = $1", [conversationId]);
        return { message: assistant.rows[0], replayed: false };
      });
      return {
        user_message: messageView({ ...claimed.userMessage, request_status: "complete" }),
        assistant_message: messageView(completed.message),
        replayed: completed.replayed,
      };
    },
  };
}

module.exports = { AssistantConversationError, createAssistantConversationService, messageView };
