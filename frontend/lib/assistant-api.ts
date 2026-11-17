import { z } from "zod";

const resultSchema = z.object({ tool: z.enum(["get_patient_appointments", "search_doctors", "get_available_slots", "prepare_booking_action", "prepare_reschedule_action", "prepare_cancellation_action", "get_cancellation_refund_preview", "get_patient_payment_history", "get_doctor_schedules", "get_doctor_schedule_exceptions", "get_doctor_schedule_conflicts", "get_doctor_nearest_slots", "get_doctor_appointments", "get_doctor_appointment_statistics", "get_doctor_assisted_reschedule_requests"]), data: z.record(z.string(), z.unknown()), ui_actions: z.array(z.record(z.string(), z.unknown())).optional() });
const messageSchema = z.object({ id: z.string(), role: z.enum(["user", "assistant"]), content: z.string(), created_at: z.string().optional(), request_id: z.string().optional(), request_status: z.string().optional(), results: z.array(resultSchema).optional() });
const conversationSchema = z.object({ id: z.string(), created_at: z.string(), updated_at: z.string(), preview: z.string().nullable().optional() });
const listSchema = z.object({ items: z.array(conversationSchema) });
const detailSchema = z.object({ conversation: conversationSchema, messages: z.array(messageSchema), has_more: z.boolean(), next_before: z.string().nullable() });
const sentSchema = z.object({ user_message: messageSchema, assistant_message: messageSchema, replayed: z.boolean() });
const actionTypeSchema = z.enum(["book", "reschedule", "cancel"]);
const actionIntentSchema = z.object({ id: z.string().uuid(), status: z.enum(["pending", "executing", "checkout_pending", "refund_pending", "completed", "failed", "expired"]), expires_at: z.string(), action_type: actionTypeSchema, summary: z.record(z.string(), z.unknown()).optional() });
const dismissedProposalSchema = z.object({ status: z.literal("dismissed") });
const actionConfirmationSchema = z.object({ status: z.enum(["pending", "executing", "checkout_pending", "refund_pending", "completed", "failed", "expired"]), reason: z.string().optional(), checkout_url: z.string().url().optional(), expires_at: z.string().optional(), appointment: z.record(z.string(), z.unknown()).optional(), cancellation_status: z.string().optional(), refund_status: z.string().optional(), amount: z.string().optional(), currency: z.string().optional(), payment_status: z.string().optional(), replayed: z.boolean().optional() });

export type AssistantResult = z.infer<typeof resultSchema>;
export type StoredAssistantMessage = z.infer<typeof messageSchema>;
export type AssistantConversation = z.infer<typeof conversationSchema>;

export class AssistantApiError extends Error {
  constructor(public readonly status: number, message: string, public readonly code?: string) { super(message); this.name = "AssistantApiError"; }
}

async function request<T>(token: string, path: string, init: RequestInit, schema: z.ZodType<T>, invalidResponseMessage?: string): Promise<T> {
  const base = process.env.NEXT_PUBLIC_API_URL?.trim().replace(/\/+$/, "");
  if (!base) throw new AssistantApiError(0, "The backend API URL is not configured.");
  let response: Response;
  let timedOut = false;
  const requestController = new AbortController();
  const timeoutId = setTimeout(() => { timedOut = true; requestController.abort(); }, 20_000);
  try {
    response = await fetch(`${base}/api/v1/assistant${path}`, { ...init, signal: requestController.signal, cache: "no-store", headers: { Accept: "application/json", "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...init.headers } });
  } catch {
    clearTimeout(timeoutId);
    if (timedOut) throw new AssistantApiError(408, "This request took too long. Check the conversation status and try again.", "REQUEST_TIMEOUT");
    throw new AssistantApiError(0, "We couldn't reach Medrella. Check your connection and try again.");
  }
  if (response.status === 204) { clearTimeout(timeoutId); return undefined as T; }
  let payload: unknown;
  try { payload = await response.json(); } catch {
    clearTimeout(timeoutId);
    if (timedOut) throw new AssistantApiError(408, "This request took too long. Check the conversation status and try again.", "REQUEST_TIMEOUT");
    throw new AssistantApiError(response.status, "The assistant returned an unexpected response. Please try again.");
  }
  clearTimeout(timeoutId);
  if (!response.ok) {
    const parsed = z.object({ error: z.object({ code: z.string().optional(), message: z.string().optional() }).optional() }).safeParse(payload);
    const code = parsed.success ? parsed.data.error?.code : undefined;
    const safeMessages: Record<string, string> = {
      RATE_LIMITED: "You're sending messages too quickly. Please wait a moment before trying again.",
      CONVERSATION_NOT_FOUND: "This saved conversation couldn't be found. Your visible messages are still here; retry loading the conversation before continuing. No replacement conversation was created.",
      ASSISTANT_DAILY_QUOTA_EXCEEDED: "The AI assistant has reached its current usage limit. Please try again later.",
      ASSISTANT_PROVIDER_RATE_LIMITED: "The AI assistant is receiving too many requests. Please wait a moment and try again.",
      ASSISTANT_PROVIDER_UNAVAILABLE: "The AI assistant is temporarily unavailable. Please try again shortly.",
      ACTION_EXPIRED: "This proposal expired. Ask the assistant to prepare it again.",
      ACTION_ALREADY_HANDLED: "This proposal has already been handled. Refresh the conversation to see its latest status.",
      ACTION_IN_PROGRESS: "This action is still processing. Check its status in a moment.",
      PROPOSAL_NOT_VERIFIED: "This proposal could not be verified. Ask the assistant to prepare it again.",
      INVALID_ACTION: "The proposal details are no longer valid. Ask the assistant to prepare it again.",
      SLOT_UNAVAILABLE: "That appointment time is no longer available. Ask the assistant to find another time.",
      SLOT_CAPACITY_REACHED: "That appointment time has just filled. Ask the assistant to find another time.",
      APPOINTMENT_STATE_CONFLICT: "This appointment has changed and can no longer be updated from this proposal.",
      BOOKING_CONFIRMATION_STALE: "The booking details changed. Ask the assistant to prepare the booking again.",
      BOOKING_ALREADY_EXISTS: "You already have a confirmed appointment with this doctor at that time. No new booking was created.",
    };
    throw new AssistantApiError(response.status, (code && safeMessages[code]) || "The assistant couldn't respond. Please try again.", code);
  }
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    if (path.includes("/messages")) {
      const issues = parsed.error.issues.slice(0, 12).map((issue) => ({
        path: issue.path.filter((part) => typeof part === "string" || typeof part === "number"),
        code: issue.code,
      }));
      try { console.warn("assistant_api_response_rejected", JSON.stringify({ status: response.status, issueCount: parsed.error.issues.length, issues })); }
      catch { /* Diagnostics must not replace the safe client error. */ }
    }
    throw new AssistantApiError(502, invalidResponseMessage || "The assistant returned an incomplete response. Please try again.", "ASSISTANT_RESPONSE_INVALID");
  }
  return parsed.data;
}

export const createAssistantConversation = (token: string, id: string) => request(token, "/conversations", { method: "POST", body: JSON.stringify({ id }) }, z.object({ conversation: conversationSchema }).transform((value) => value.conversation));
export const listAssistantConversations = (token: string) => request(token, "/conversations?limit=50", { method: "GET" }, listSchema);
export const getAssistantConversation = (token: string, id: string, { limit = 20, before }: { limit?: number; before?: string } = {}) => {
  const query = new URLSearchParams({ limit: String(limit) });
  if (before) query.set("before", before);
  return request(token, `/conversations/${encodeURIComponent(id)}?${query.toString()}`, { method: "GET" }, detailSchema, "Saved conversation history could not be read because its response format was not recognized. The selected conversation was kept; retry or choose another saved conversation.");
};
export const deleteAssistantConversation = (token: string, id: string) => request(token, `/conversations/${encodeURIComponent(id)}`, { method: "DELETE" }, z.undefined());
export const sendAssistantMessage = (token: string, conversationId: string, requestId: string, content: string) => request(token, `/conversations/${encodeURIComponent(conversationId)}/messages`, { method: "POST", body: JSON.stringify({ request_id: requestId, content }) }, sentSchema);

export type AssistantActionType = z.infer<typeof actionTypeSchema>;
export type AssistantActionIntent = z.infer<typeof actionIntentSchema>;
export type AssistantActionPrepareResponse = AssistantActionIntent | z.infer<typeof dismissedProposalSchema>;
export type AssistantActionConfirmation = z.infer<typeof actionConfirmationSchema>;
export const prepareAssistantAction = (token: string, conversationId: string, assistantMessageId: string, actionType: AssistantActionType) => request(token, `/conversations/${encodeURIComponent(conversationId)}/actions`, { method: "POST", body: JSON.stringify({ assistant_message_id: assistantMessageId, action_type: actionType }) }, z.union([actionIntentSchema, dismissedProposalSchema]), "The proposal details could not be verified. Please ask the assistant to prepare it again.");
export const dismissAssistantProposal = (token: string, conversationId: string, assistantMessageId: string, actionType: AssistantActionType) => request(token, `/conversations/${encodeURIComponent(conversationId)}/actions/dismiss`, { method: "POST", body: JSON.stringify({ assistant_message_id: assistantMessageId, action_type: actionType }) }, dismissedProposalSchema);
export const getAssistantActionStatus = (token: string, conversationId: string, intentId: string) => request(token, `/conversations/${encodeURIComponent(conversationId)}/actions/${encodeURIComponent(intentId)}`, { method: "GET" }, z.object({ id: z.string().uuid(), action_type: actionTypeSchema, status: actionIntentSchema.shape.status, expires_at: z.string(), summary: z.record(z.string(), z.unknown()).optional() }));
export const confirmAssistantAction = (token: string, conversationId: string, intentId: string) => request(token, `/conversations/${encodeURIComponent(conversationId)}/actions/${encodeURIComponent(intentId)}/confirm`, { method: "POST" }, actionConfirmationSchema);
