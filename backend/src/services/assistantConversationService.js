const DEFAULT_HISTORY_LIMIT = 20;
// This is the bounded model context, independent of UI message-page size.
const MODEL_CONTEXT_LIMIT = 11;
const PROCESSING_STALE_AFTER_SECONDS = 120;
const INTERNAL_ACTION_CONTEXT_TOOL = "__internal_action_context";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function persistableProposalEvidence(value, userId, conversationId, assistantMessageId) {
  const toolNames = { book: "prepare_booking_action", reschedule: "prepare_reschedule_action", cancel: "prepare_cancellation_action" };
  if (!value || value.version !== 1 || value.proposal_succeeded !== true || value.requires_patient_confirmation !== true
      || !Object.hasOwn(toolNames, value.action_type) || value.tool_name !== toolNames[value.action_type]
      || !value.action_args || typeof value.action_args !== "object" || Array.isArray(value.action_args)) return null;
  const appointmentId = value.verified_appointment_id;
  const availabilityId = value.verified_availability_id;
  if (value.action_type === "book" && (availabilityId !== value.action_args.availability_id || appointmentId !== null)) return null;
  if (value.action_type === "reschedule" && (appointmentId !== value.action_args.appointment_id || availabilityId !== value.action_args.availability_id)) return null;
  if (value.action_type === "cancel" && (appointmentId !== value.action_args.appointment_id || availabilityId !== null)) return null;
  if ((appointmentId !== null && !UUID_PATTERN.test(appointmentId)) || (availabilityId !== null && !UUID_PATTERN.test(availabilityId))) return null;
  return {
    version: 1,
    proposal_succeeded: true,
    requires_patient_confirmation: true,
    tool_name: toolNames[value.action_type],
    action_type: value.action_type,
    action_args: value.action_args,
    verified_appointment_id: appointmentId,
    verified_availability_id: availabilityId,
    user_id: userId,
    conversation_id: conversationId,
    assistant_message_id: assistantMessageId,
  };
}

function safeReferenceRows(rows, kind) {
  if (!Array.isArray(rows)) return [];
  return rows.slice(0, 20).filter((row) => row && UUID_PATTERN.test(row.id || "")).map((row) => ({
    id: row.id,
    ...(row.doctor_id && UUID_PATTERN.test(row.doctor_id) ? { doctor_id: row.doctor_id } : {}),
    ...(typeof row.date === "string" ? { date: row.date.slice(0, 10) } : {}),
    ...(typeof row.start_time === "string" ? { start_time: row.start_time.slice(0, 8) } : {}),
    ...(typeof row.end_time === "string" ? { end_time: row.end_time.slice(0, 8) } : {}),
    ...(typeof row.status === "string" ? { status: row.status.slice(0, 24) } : {}),
    ...(kind === "doctor" && typeof row.name === "string" ? { name: row.name.slice(0, 120) } : {}),
    ...(kind === "doctor" && typeof row.specialty === "string" ? { specialty: row.specialty.slice(0, 120) } : {}),
    ...(row.doctor && typeof row.doctor.name === "string" ? { doctor: {
      ...(UUID_PATTERN.test(row.doctor.id || "") ? { id: row.doctor.id } : {}),
      name: row.doctor.name.slice(0, 120),
    } } : {}),
    ...(kind === "appointment" && typeof row.appointment_id === "string" && UUID_PATTERN.test(row.appointment_id) ? { appointment_id: row.appointment_id } : {}),
    ...(kind === "slot" && typeof row.availability_id === "string" && UUID_PATTERN.test(row.availability_id) ? { availability_id: row.availability_id } : {}),
  }));
}

function safeReferences(value) {
  if (!value || typeof value !== "object") return null;
  const page = value.history_page && typeof value.history_page === "object" ? value.history_page : null;
  const pageQuery = page?.query && ["upcoming", "past", "cancelled"].includes(page.query.view)
    && ["all", "nearest", "next_days", "last", "last_completed"].includes(page.query.scope)
    ? {
      view: page.query.view,
      scope: page.query.scope,
      ...(typeof page.query.from === "string" && /^\d{4}-\d{2}-\d{2}$/.test(page.query.from) ? { from: page.query.from } : {}),
      ...(typeof page.query.to === "string" && /^\d{4}-\d{2}-\d{2}$/.test(page.query.to) ? { to: page.query.to } : {}),
      ...(Number.isInteger(page.query.days_ahead) && page.query.days_ahead >= 1 && page.query.days_ahead <= 31 ? { days_ahead: page.query.days_ahead } : {}),
    } : null;
  const historyPage = pageQuery && Number.isInteger(page.next_offset) && page.next_offset >= 0 && page.next_offset <= 100000 && typeof page.has_more === "boolean"
    ? { query: pageQuery, next_offset: page.next_offset, has_more: page.has_more, seen_appointment_ids: Array.isArray(page.seen_appointment_ids) ? page.seen_appointment_ids.filter((id) => UUID_PATTERN.test(id)).slice(-1000) : [] }
    : null;
  return {
    ...(value.version === 1 ? { version: 1 } : {}),
    ...(typeof value.captured_at === "string" && !Number.isNaN(Date.parse(value.captured_at)) ? { captured_at: value.captured_at } : {}),
    ...(value.reference_timestamps && typeof value.reference_timestamps === "object" ? { reference_timestamps: Object.fromEntries(["appointments", "slots", "doctors"].filter((kind) => typeof value.reference_timestamps[kind] === "string" && !Number.isNaN(Date.parse(value.reference_timestamps[kind]))).map((kind) => [kind, value.reference_timestamps[kind]])) } : {}),
    appointments: safeReferenceRows(value.appointments, "appointment"),
    slots: safeReferenceRows(value.slots, "slot"),
    doctors: safeReferenceRows(value.doctors, "doctor"),
    ...(value.slot_query && typeof value.slot_query === "object" ? { slot_query: {
      ...(UUID_PATTERN.test(value.slot_query.doctor_id || "") ? { doctor_id: value.slot_query.doctor_id } : {}),
      ...(typeof value.slot_query.from === "string" ? { from: value.slot_query.from.slice(0, 10) } : {}),
      ...(typeof value.slot_query.to === "string" ? { to: value.slot_query.to.slice(0, 10) } : {}),
      ...(typeof value.slot_query.exact_start_time === "string" ? { exact_start_time: value.slot_query.exact_start_time.slice(0, 5) } : {}),
    } } : {}),
    ...(value.pending_action === "book" || value.pending_action === "reschedule" ? { pending_action: value.pending_action } : {}),
    ...(historyPage ? { history_page: historyPage } : {}),
  };
}

class AssistantConversationError extends Error {
  constructor(code, status, message) { super(message); this.code = code; this.status = status; }
}

function messageView(row) {
  return {
    id: row.id,
    role: row.role,
    content: row.content,
    created_at: row.created_at,
    ...(row.role === "user" ? { request_id: row.request_id, request_status: row.request_status } : { results: (row.tool_results || []).filter((result) => result?.tool !== INTERNAL_ACTION_CONTEXT_TOOL) }),
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

    async send({ database, user, conversationId, requestId, diagnosticRequestId, content, applicationTimezone, paymentService, logger = console }) {
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
          `SELECT role, content, tool_results FROM assistant_messages
           WHERE conversation_id = $1 AND id <> $2
             AND (role = 'assistant' OR (role = 'user' AND request_status = 'complete'))
           ORDER BY created_at DESC, id DESC LIMIT $3`,
          [conversationId, userMessage.id, MODEL_CONTEXT_LIMIT],
        );
        const priorMessages = [...prior.rows].reverse();
        let previousActionContext = null;
        let previousReferences = null;
        for (const message of priorMessages) {
          if (message.role !== "assistant" || !Array.isArray(message.tool_results)) continue;
          const contextResult = message.tool_results.find((result) => result?.tool === INTERNAL_ACTION_CONTEXT_TOOL);
          const context = contextResult?.data;
          if (context?.action_type === "cancel" && UUID_PATTERN.test(context.appointment_id || "")) {
            previousActionContext = { action_type: "cancel", appointment_id: context.appointment_id };
          }
          if (context?.action_type === "cancel_pending") {
            const expiresAt = Date.parse(context.expires_at || "");
            if (Number.isFinite(expiresAt) && expiresAt > now() && expiresAt <= now() + 6 * 60 * 1000) {
              previousActionContext = { action_type: "cancel_pending", expires_at: new Date(expiresAt).toISOString() };
            }
          }
          const references = safeReferences(context?.references);
          if (references && (references.version === 1 || references.appointments.length || references.slots.length || references.doctors.length)) {
            previousReferences = references;
            if (references.appointments.length && context?.action_type !== "cancel" && context?.action_type !== "cancel_pending") previousActionContext = null;
          }
        }
        return { userMessage, previousActionContext, previousReferences, context: priorMessages.map(({ role, content: priorContent }) => ({ role, content: priorContent })).concat({ role: "user", content }) };
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
          paymentService,
          previousActionContext: claimed.previousActionContext,
          previousReferences: claimed.previousReferences,
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
        const storedToolResults = [...(completion.results || [])];
        const exactCancellationContext = completion.internalActionContext?.action_type === "cancel"
          && UUID_PATTERN.test(completion.internalActionContext.appointment_id || "");
        const pendingCancellationExpiry = Date.parse(completion.internalActionContext?.expires_at || "");
        const pendingCancellationContext = completion.internalActionContext?.action_type === "cancel_pending"
          && Number.isFinite(pendingCancellationExpiry)
          && pendingCancellationExpiry > now()
          && pendingCancellationExpiry <= now() + 6 * 60 * 1000;
        if (exactCancellationContext || pendingCancellationContext || completion.internalReferences) {
          storedToolResults.push({ tool: INTERNAL_ACTION_CONTEXT_TOOL, data: {
            ...(exactCancellationContext
              ? completion.internalActionContext : {}),
            ...(pendingCancellationContext
              ? { action_type: "cancel_pending", expires_at: new Date(pendingCancellationExpiry).toISOString() } : {}),
            ...(completion.internalReferences ? { references: safeReferences(completion.internalReferences) } : {}),
          } });
        }
        const assistant = await client.query(
          `INSERT INTO assistant_messages (conversation_id, role, content, reply_to_message_id, tool_results)
           VALUES ($1, 'assistant', $2, $3, $4::jsonb)
           RETURNING id, role, content, tool_results, created_at`,
          [conversationId, completion.answer, claimed.userMessage.id, JSON.stringify(storedToolResults)],
        );
        const proposalEvidence = persistableProposalEvidence(
          completion.internalProposalEvidence,
          user.id,
          conversationId,
          assistant.rows[0].id,
        );
        if (proposalEvidence) {
          const evidenceWrite = await client.query(
            `UPDATE assistant_messages
             SET tool_results = tool_results || $2::jsonb
             WHERE id = $1 AND conversation_id = $3 AND role = 'assistant'`,
            [assistant.rows[0].id, JSON.stringify([{ tool: INTERNAL_ACTION_CONTEXT_TOOL, data: { proposal_evidence: proposalEvidence } }]), conversationId],
          );
          if (evidenceWrite.rowCount === 0) throw new AssistantConversationError("PROPOSAL_EVIDENCE_NOT_PERSISTED", 500, "The assistant proposal could not be safely saved");
        }
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
