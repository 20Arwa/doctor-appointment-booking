import type { AssistantResult } from "@/lib/assistant-api";

export type ChatMessage = { id?: string; requestId?: string; role: "user" | "assistant"; content: string; createdAt?: string; results?: AssistantResult[]; failed?: boolean };
export type ChatState = { messages: ChatMessage[]; loading: boolean; error: string | null; errorCode: string | null; errorSource: "history" | "send" | "saved_conversations" | "new_conversation" | null };
export type ChatAction =
  | { type: "restore"; messages: ChatMessage[] }
  | { type: "prepend"; messages: ChatMessage[] }
  | { type: "submit"; message: ChatMessage }
  | { type: "success"; requestId: string; user: ChatMessage; assistant: ChatMessage }
  | { type: "failure"; requestId: string; message: string; code?: string; source?: ChatState["errorSource"] }
  | { type: "loading"; value: boolean }
  | { type: "clear" };
export const initialChatState: ChatState = { messages: [], loading: false, error: null, errorCode: null, errorSource: null };

export function retryOperation(source: ChatState["errorSource"]): "history" | "send" | "saved_conversations" | "new_conversation" {
  return source || "history";
}

export function canSendAssistantMessage({ ready, loading, draft, historyLoadFailed, hasConversation }: { ready: boolean; loading: boolean; draft: string; historyLoadFailed: boolean; hasConversation: boolean }): boolean {
  return ready && !loading && Boolean(draft.trim()) && !(historyLoadFailed && !hasConversation);
}

export function restoreDraftAfterFailedSubmission(currentDraft: string, submittedContent: string): string {
  return currentDraft.trim() ? currentDraft : submittedContent;
}

export function classifyAssistantError(errorCode: string | null | undefined): "history" | "provider" | "tool" | "budget" | "response" | "authentication" | "rate_limit" | "other" {
  const code = errorCode || "";
  if (["CONVERSATION_NOT_FOUND", "HISTORY_LOAD_FAILED", "CONVERSATION_HISTORY_UNAVAILABLE"].includes(code)) return "history";
  if (code === "TOOL_LIMIT_EXCEEDED") return "budget";
  if (/^TOOL_|^INVALID_TOOL/.test(code)) return "tool";
  if (/^(?:PROVIDER_INVALID_RESPONSE|ASSISTANT_RESPONSE)/.test(code)) return "response";
  if (/^(?:UNAUTHORIZED|FORBIDDEN|AUTHENTICATION_REQUIRED)/.test(code) || code === "401") return "authentication";
  if (/RATE_LIMIT|QUOTA/.test(code)) return "rate_limit";
  if (/^(?:ASSISTANT_|PROVIDER_)/.test(code)) return "provider";
  return "other";
}

export function shouldShowHistoryRecovery(errorCode: string | null | undefined): boolean {
  return classifyAssistantError(errorCode) === "history";
}

export function getAssistantResultRows(result: AssistantResult): unknown[] {
  const rows = result.data.appointments || result.data.doctors || result.data.slots;
  return Array.isArray(rows) ? rows : [];
}

export function isNearMessageListBottom(scrollHeight: number, clientHeight: number, scrollTop: number): boolean {
  return scrollHeight - clientHeight - scrollTop <= 80;
}

export function isNearMessageListTop(scrollTop: number): boolean {
  return scrollTop <= 80;
}

export function getVisibleAssistantResults(content: string, results: AssistantResult[] = []): AssistantResult[] {
  if (/\b(?:I can(?:not|['’]t)|I['’]?m unable|I am unable|I will not|I won['’]?t)\b/i.test(content)) return [];
  const visible = results.filter((result) => getAssistantResultRows(result).some((row) => row !== null && typeof row === "object"));
  if (visible.some((result) => result.tool === "get_available_slots")) return visible.filter((result) => result.tool !== "search_doctors");
  return visible;
}

export function getAssistantDisplayContent(content: string, results: AssistantResult[] = []): string {
  const visible = getVisibleAssistantResults(content, results);
  if (!visible.length) return content;
  if (visible.length === 1 && visible[0].tool === "get_available_slots") {
    const count = getAssistantResultRows(visible[0]).length;
    return `Here are the ${count} earliest available option${count === 1 ? "" : "s"}:`;
  }
  if (visible.length === 1 && visible[0].tool === "get_patient_appointments") {
    const count = getAssistantResultRows(visible[0]).length;
    return count === 1 ? "Here is your appointment:" : "Here are your appointments:";
  }
  if (visible.length === 1 && visible[0].tool === "search_doctors") return "Here are the matching doctors:";
  return "Here are the matching results:";
}

export function preserveScrollAfterPrepend(scrollHeight: number, previousHeight: number, previousTop: number): number {
  return previousTop + scrollHeight - previousHeight;
}

const ASSISTANT_TIME_ZONE = "Asia/Kolkata";
export function assistantMessageDateKey(value?: string): string | null {
  if (!value || Number.isNaN(Date.parse(value))) return null;
  return new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: ASSISTANT_TIME_ZONE }).format(new Date(value));
}
export function assistantMessageDateLabel(value?: string): string {
  if (!value || Number.isNaN(Date.parse(value))) return "";
  return new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeZone: ASSISTANT_TIME_ZONE }).format(new Date(value));
}
export function assistantMessageTimeLabel(value?: string): string {
  if (!value || Number.isNaN(Date.parse(value))) return "";
  return new Intl.DateTimeFormat("en-IN", { hour: "numeric", minute: "2-digit", timeZone: ASSISTANT_TIME_ZONE }).format(new Date(value));
}
export function shouldShowAssistantDateSeparator(messages: ChatMessage[], index: number): boolean {
  const currentDate = assistantMessageDateKey(messages[index]?.createdAt);
  if (!currentDate) return false;
  return index === 0 || assistantMessageDateKey(messages[index - 1]?.createdAt) !== currentDate;
}

function messageIdentity(message: ChatMessage): string {
  return message.role === "user" && message.requestId ? `request:${message.requestId}` : `message:${message.id || message.requestId || `${message.role}:${message.content}`}`;
}

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  if (action.type === "restore") return { messages: action.messages, loading: false, error: null, errorCode: null, errorSource: null };
  if (action.type === "prepend") {
    const existing = new Set(state.messages.map(messageIdentity));
    const older = action.messages.filter((message) => {
      const identity = messageIdentity(message);
      if (existing.has(identity)) return false;
      existing.add(identity);
      return true;
    });
    return { ...state, messages: [...older, ...state.messages] };
  }
  if (action.type === "submit") return { ...state, messages: [...state.messages, action.message], loading: true, error: null, errorCode: null, errorSource: null };
  if (action.type === "success") {
    const user = { ...action.user, failed: false };
    const messages = state.messages.map((message) => message.requestId === action.requestId ? user : message);
    return { messages: [...messages, action.assistant], loading: false, error: null, errorCode: null, errorSource: null };
  }
  if (action.type === "failure") return { messages: state.messages.map((message) => message.requestId === action.requestId ? { ...message, failed: true } : message), loading: false, error: action.message, errorCode: action.code || null, errorSource: action.source || null };
  if (action.type === "loading") return action.value
    ? { ...state, loading: true, error: null, errorCode: null }
    : { ...state, loading: false };
  return initialChatState;
}
