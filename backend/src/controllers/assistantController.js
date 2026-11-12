const { randomUUID } = require("node:crypto");
const assistantEngine = require("../services/assistant");
const { AssistantError } = require("../services/assistant/conversationEngine");
const { AssistantConversationError, createAssistantConversationService } = require("../services/assistantConversationService");

function errorResponse(response, error) {
  if (error instanceof AssistantError || error instanceof AssistantConversationError) {
    return response.status(error.status).json({ error: { code: error.code, message: error.message } });
  }
  return response.status(503).json({ error: { code: "ASSISTANT_UNAVAILABLE", message: "The assistant is temporarily unavailable. Please try again shortly." } });
}

function getService(response) {
  return response.locals.assistantConversationService || createAssistantConversationService({ engine: response.locals.assistantEngine || assistantEngine });
}

function patientOnly(response) {
  return response.locals.user?.role === "patient";
}

async function create(request, response) {
  if (!patientOnly(response)) return response.status(403).json({ error: { code: "FORBIDDEN", message: "Only patients can use the assistant" } });
  try { return response.status(201).json(await getService(response).create(response.locals.database, response.locals.user, response.locals.body.id)); }
  catch (error) { return errorResponse(response, error); }
}

async function list(request, response) {
  if (!patientOnly(response)) return response.status(403).json({ error: { code: "FORBIDDEN", message: "Only patients can use the assistant" } });
  try { return response.json(await getService(response).list(response.locals.database, response.locals.user, response.locals.query)); }
  catch (error) { return errorResponse(response, error); }
}

async function open(request, response) {
  if (!patientOnly(response)) return response.status(403).json({ error: { code: "FORBIDDEN", message: "Only patients can use the assistant" } });
  try { return response.json(await getService(response).get(response.locals.database, response.locals.user, response.locals.params.conversationId, response.locals.query)); }
  catch (error) { return errorResponse(response, error); }
}

async function remove(request, response) {
  if (!patientOnly(response)) return response.status(403).json({ error: { code: "FORBIDDEN", message: "Only patients can use the assistant" } });
  try {
    const removed = await getService(response).remove(response.locals.database, response.locals.user, response.locals.params.conversationId);
    return removed ? response.status(204).end() : response.status(404).json({ error: { code: "CONVERSATION_NOT_FOUND", message: "Conversation not found" } });
  } catch (error) { return errorResponse(response, error); }
}

async function send(request, response) {
  if (!patientOnly(response)) return response.status(403).json({ error: { code: "FORBIDDEN", message: "Only patients can use the assistant" } });
  const requestId = randomUUID();
  response.set("X-Request-Id", requestId);
  const started = Date.now();
  const logger = {
    info(stage, details = {}) {
      console.info("assistant_execution", JSON.stringify({
        requestId,
        attempt: Number(details.attempt || 0),
        stage,
        elapsedMs: Date.now() - started,
        ...(typeof details.category === "string" ? { category: details.category } : {}),
        ...(Number.isFinite(details.providerStatus) ? { providerStatus: details.providerStatus } : {}),
      }));
    },
  };
  try {
    const result = await getService(response).send({ database: response.locals.database, user: response.locals.user, conversationId: response.locals.params.conversationId, requestId: response.locals.body.request_id, diagnosticRequestId: requestId, content: response.locals.body.content, applicationTimezone: response.locals.applicationTimezone, logger });
    return response.json(result);
  } catch (error) {
    const assistantError = error instanceof AssistantError || error instanceof AssistantConversationError;
    logger.info("request_failed", {
      attempt: assistantError ? error.attempt : 0,
      category: assistantError ? error.category || error.code : "internal_error",
      providerStatus: assistantError ? error.providerStatus : undefined,
    });
    return errorResponse(response, error);
  }
}

module.exports = { create, list, open, remove, send };
