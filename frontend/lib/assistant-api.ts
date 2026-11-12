import { z } from "zod";

const resultSchema = z.object({ tool: z.enum(["get_patient_appointments", "search_doctors", "get_available_slots"]), data: z.record(z.string(), z.unknown()) });
const messageSchema = z.object({ id: z.string(), role: z.enum(["user", "assistant"]), content: z.string(), request_id: z.string().optional(), request_status: z.string().optional(), results: z.array(resultSchema).optional() });
const conversationSchema = z.object({ id: z.string(), created_at: z.string(), updated_at: z.string(), preview: z.string().nullable().optional() });
const listSchema = z.object({ items: z.array(conversationSchema) });
const detailSchema = z.object({ conversation: conversationSchema, messages: z.array(messageSchema), has_more: z.boolean(), next_before: z.string().nullable() });
const sentSchema = z.object({ user_message: messageSchema, assistant_message: messageSchema, replayed: z.boolean() });

export type AssistantResult = z.infer<typeof resultSchema>;
export type StoredAssistantMessage = z.infer<typeof messageSchema>;
export type AssistantConversation = z.infer<typeof conversationSchema>;

export class AssistantApiError extends Error {
  constructor(public readonly status: number, message: string) { super(message); this.name = "AssistantApiError"; }
}

async function request<T>(token: string, path: string, init: RequestInit, schema: z.ZodType<T>): Promise<T> {
  const base = process.env.NEXT_PUBLIC_API_URL?.trim().replace(/\/+$/, "");
  if (!base) throw new AssistantApiError(0, "The backend API URL is not configured.");
  let response: Response;
  try {
    response = await fetch(`${base}/api/v1/assistant${path}`, { ...init, cache: "no-store", headers: { Accept: "application/json", "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...init.headers } });
  } catch { throw new AssistantApiError(0, "We couldn't reach Medrella. Check your connection and try again."); }
  if (response.status === 204) return undefined as T;
  let payload: unknown;
  try { payload = await response.json(); } catch { throw new AssistantApiError(response.status, "The assistant returned an unexpected response. Please try again."); }
  if (!response.ok) {
    const parsed = z.object({ error: z.object({ message: z.string().optional() }).optional() }).safeParse(payload);
    throw new AssistantApiError(response.status, parsed.success ? parsed.data.error?.message || "The assistant couldn't respond. Please try again." : "The assistant couldn't respond. Please try again.");
  }
  const parsed = schema.safeParse(payload);
  if (!parsed.success) throw new AssistantApiError(502, "The assistant returned an incomplete response. Please try again.");
  return parsed.data;
}

export const createAssistantConversation = (token: string, id: string) => request(token, "/conversations", { method: "POST", body: JSON.stringify({ id }) }, z.object({ conversation: conversationSchema }).transform((value) => value.conversation));
export const listAssistantConversations = (token: string) => request(token, "/conversations?limit=50", { method: "GET" }, listSchema);
export const getAssistantConversation = (token: string, id: string, { limit = 20, before }: { limit?: number; before?: string } = {}) => {
  const query = new URLSearchParams({ limit: String(limit) });
  if (before) query.set("before", before);
  return request(token, `/conversations/${encodeURIComponent(id)}?${query.toString()}`, { method: "GET" }, detailSchema);
};
export const deleteAssistantConversation = (token: string, id: string) => request(token, `/conversations/${encodeURIComponent(id)}`, { method: "DELETE" }, z.undefined());
export const sendAssistantMessage = (token: string, conversationId: string, requestId: string, content: string) => request(token, `/conversations/${encodeURIComponent(conversationId)}/messages`, { method: "POST", body: JSON.stringify({ request_id: requestId, content }) }, sentSchema);
