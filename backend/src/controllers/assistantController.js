const { randomUUID } = require("node:crypto");
const assistantEngine = require("../services/assistant");
const { AssistantError } = require("../services/assistant/conversationEngine");
const { AssistantConversationError, createAssistantConversationService } = require("../services/assistantConversationService");
const { AssistantActionError } = require("../services/assistantActionService");

function errorResponse(response, error) {
  if (error instanceof AssistantError || error instanceof AssistantConversationError || error instanceof AssistantActionError
      || (Number.isInteger(error?.status) && typeof error?.code === "string")) {
    return response.status(error.status).json({ error: { code: error.code, message: error.message } });
  }
  return response.status(503).json({ error: { code: "ASSISTANT_UNAVAILABLE", message: "The assistant is temporarily unavailable. Please try again shortly." } });
}

function getService(response) {
  return response.locals.assistantConversationService || createAssistantConversationService({ engine: response.locals.assistantEngine || assistantEngine, actionService: getActionService(response) });
}

function getActionService(response) { return response.locals.assistantActionService; }

function patientOnly(response) {
  return response.locals.user?.role === "patient";
}

function chatActor(response) {
  return ["patient", "doctor"].includes(response.locals.user?.role);
}

async function create(request, response) {
  if (!chatActor(response)) return response.status(403).json({ error: { code: "FORBIDDEN", message: "This account cannot use the assistant" } });
  try { return response.status(201).json(await getService(response).create(response.locals.database, response.locals.user, response.locals.body.id)); }
  catch (error) { return errorResponse(response, error); }
}

async function list(request, response) {
  if (!chatActor(response)) return response.status(403).json({ error: { code: "FORBIDDEN", message: "This account cannot use the assistant" } });
  try { return response.json(await getService(response).list(response.locals.database, response.locals.user, response.locals.query)); }
  catch (error) { return errorResponse(response, error); }
}

async function open(request, response) {
  if (!chatActor(response)) return response.status(403).json({ error: { code: "FORBIDDEN", message: "This account cannot use the assistant" } });
  try { return response.json(await getService(response).get(response.locals.database, response.locals.user, response.locals.params.conversationId, response.locals.query)); }
  catch (error) { return errorResponse(response, error); }
}

async function remove(request, response) {
  if (!chatActor(response)) return response.status(403).json({ error: { code: "FORBIDDEN", message: "This account cannot use the assistant" } });
  try {
    const removed = await getService(response).remove(response.locals.database, response.locals.user, response.locals.params.conversationId);
    return removed ? response.status(204).end() : response.status(404).json({ error: { code: "CONVERSATION_NOT_FOUND", message: "Conversation not found" } });
  } catch (error) { return errorResponse(response, error); }
}

async function send(request, response) {
  if (!chatActor(response)) return response.status(403).json({ error: { code: "FORBIDDEN", message: "This account cannot use the assistant" } });
  const requestId = randomUUID();
  response.set("X-Request-Id", requestId);
  const started = Date.now();
  const logger = {
    info(stage, details = {}) {
      console.info("assistant_execution", JSON.stringify({
        requestId,
        attempt: Number(details.attempt || 0),
        stage,
        conversationId: request.params.conversationId,
        elapsedMs: Date.now() - started,
        ...(Number.isInteger(details.stateVersion) ? { stateVersion: details.stateVersion } : {}),
        ...(typeof details.toolName === "string" ? { toolName: details.toolName } : {}),
        ...(typeof details.executionStage === "string" ? { executionStage: details.executionStage } : {}),
        ...(typeof details.category === "string" ? { category: details.category } : {}),
        ...(Number.isFinite(details.providerStatus) ? { providerStatus: details.providerStatus } : {}),
        ...(typeof details.finishReason === "string" ? { finishReason: details.finishReason } : {}),
        ...(Array.isArray(details.outputPartTypes) ? { outputPartTypes: details.outputPartTypes } : {}),
        ...(typeof details.hasFinalText === "boolean" ? { hasFinalText: details.hasFinalText } : {}),
        ...(Number.isInteger(details.finalTextLength) ? { finalTextLength: details.finalTextLength } : {}),
        ...(Number.isInteger(details.pendingToolCalls) ? { pendingToolCalls: details.pendingToolCalls } : {}),
        ...(Number.isInteger(details.responseStatus) ? { responseStatus: details.responseStatus } : {}),
        ...(typeof details.blockReason === "string" ? { blockReason: details.blockReason } : {}),
        ...(typeof details.apiResponseValid === "boolean" ? { apiResponseValid: details.apiResponseValid } : {}),
        ...(typeof details.assistantMessagePersisted === "boolean" ? { assistantMessagePersisted: details.assistantMessagePersisted } : {}),
        ...(typeof details.assistantTextPresent === "boolean" ? { assistantTextPresent: details.assistantTextPresent } : {}),
        ...(Number.isInteger(details.assistantTextLength) ? { assistantTextLength: details.assistantTextLength } : {}),
        ...(Number.isInteger(details.assistantResultCount) ? { assistantResultCount: details.assistantResultCount } : {}),
        ...(Array.isArray(details.assistantResultTools) ? { assistantResultTools: details.assistantResultTools } : {}),
      }));
    },
  };
  try {
    const result = await getService(response).send({ database: response.locals.database, user: response.locals.user, conversationId: response.locals.params.conversationId, requestId: response.locals.body.request_id, diagnosticRequestId: requestId, content: response.locals.body.content, applicationTimezone: response.locals.applicationTimezone, paymentService: response.locals.paymentService, logger });
    const userMessage = result?.user_message;
    const assistantMessage = result?.assistant_message;
    logger.info("api_response_ready", {
      apiResponseValid: userMessage?.role === "user" && typeof userMessage.id === "string" && typeof userMessage.content === "string"
        && assistantMessage?.role === "assistant" && typeof assistantMessage.id === "string" && typeof assistantMessage.content === "string"
        && (assistantMessage.results === undefined || Array.isArray(assistantMessage.results)) && typeof result?.replayed === "boolean",
      assistantMessagePersisted: assistantMessage?.role === "assistant" && typeof assistantMessage.id === "string",
      assistantTextPresent: typeof assistantMessage?.content === "string" && assistantMessage.content.length > 0,
      ...(typeof assistantMessage?.content === "string" ? { assistantTextLength: assistantMessage.content.length } : {}),
      assistantResultCount: Array.isArray(assistantMessage?.results) ? assistantMessage.results.length : 0,
      assistantResultTools: Array.isArray(assistantMessage?.results) ? assistantMessage.results.map((item) => item?.tool).filter((tool) => typeof tool === "string").slice(0, 8) : [],
    });
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

async function prepareAction(request, response) {
  if (!patientOnly(response)) return response.status(403).json({ error: { code: "FORBIDDEN", message: "Only patients can prepare appointment actions" } });
  try {
    const { assistant_message_id, action_type, action_args } = response.locals.body;
    const intent = await getActionService(response).prepare(response.locals.user, response.locals.params.conversationId, assistant_message_id, action_type, action_args);
    return response.status(201).json(intent);
  } catch (error) { return errorResponse(response, error); }
}

async function dismissAction(_request, response) {
  if (!patientOnly(response)) return response.status(403).json({ error: { code: "FORBIDDEN", message: "Only patients can dismiss appointment proposals" } });
  try {
    const { assistant_message_id, action_type } = response.locals.body;
    return response.json(await getActionService(response).dismiss(response.locals.user, response.locals.params.conversationId, assistant_message_id, action_type));
  } catch (error) { return errorResponse(response, error); }
}

async function confirmAction(_request, response) {
  if (!patientOnly(response)) return response.status(403).json({ error: { code: "FORBIDDEN", message: "Only patients can confirm appointment actions" } });
  try {
    const { conversationId, intentId } = response.locals.params;
    return response.json(await getActionService(response).confirm(response.locals.user, conversationId, intentId));
  } catch (error) { return errorResponse(response, error); }
}

async function getActionStatus(_request, response) {
  if (!patientOnly(response)) return response.status(403).json({ error: { code: "FORBIDDEN", message: "Only patients can view appointment actions" } });
  try {
    const { conversationId, intentId } = response.locals.params;
    return response.json(await getActionService(response).intentView(response.locals.user, conversationId, intentId));
  } catch (error) { return errorResponse(response, error); }
}

module.exports = { create, list, open, remove, send, prepareAction, dismissAction, confirmAction, getActionStatus };
