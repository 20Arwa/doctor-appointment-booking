"use client";

import { useAuth } from "@clerk/nextjs";
import { ArrowDown, ArrowUp, CalendarDays, Clock3, LoaderCircle, MessageCircle, RefreshCw, Search, Send, Sparkles, Stethoscope, UserRound } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { AssistantApiError, createAssistantConversation, getAssistantConversation, listAssistantConversations, sendAssistantMessage, type AssistantResult } from "@/lib/assistant-api";
import { chatReducer, getAssistantDisplayContent, getAssistantResultRows, getVisibleAssistantResults, initialChatState, isNearMessageListBottom, isNearMessageListTop, preserveScrollAfterPrepend } from "@/lib/assistant-chat-state";

function displayTime(value: unknown) {
  if (typeof value !== "string") return "";
  const [hourText, minute] = value.split(":"); const hour = Number(hourText);
  return Number.isFinite(hour) ? `${hour % 12 || 12}:${minute} ${hour >= 12 ? "PM" : "AM"}` : value;
}
function dateLabel(value: unknown) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return "";
  return new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeZone: "Asia/Kolkata" }).format(new Date(`${value}T12:00:00+05:30`));
}
function ResultCards({ result }: { result: AssistantResult }) {
  const rows = getAssistantResultRows(result);
  if (!rows.length) return null;
  return <ul className="mt-3 grid gap-2 sm:grid-cols-2">{rows.map((entry, index) => {
    if (!entry || typeof entry !== "object") return null;
    const item = entry as Record<string, unknown>; const doctor = item.doctor as Record<string, unknown> | undefined;
    const title = typeof doctor?.name === "string" ? doctor.name : typeof item.name === "string" ? item.name : result.tool === "get_available_slots" ? "Available appointment" : "Appointment";
    const date = dateLabel(item.date);
    return <li key={`${String(item.id || item.date || item.name)}-${index}`} className="rounded-xl border border-border bg-background p-3 text-sm">
      <p className="font-semibold text-foreground">{title}</p>
      {typeof item.specialty === "string" ? <p className="mt-1 text-muted-foreground">{item.specialty}</p> : null}
      {result.tool === "get_available_slots" && item.mode === "wave" ? <p className="mt-1 font-medium text-foreground">Available slot · Wave</p> : null}
      {result.tool === "get_available_slots" && item.mode === "stream" ? <p className="mt-1 font-medium text-foreground">Available window · Stream</p> : null}
      {result.tool === "get_available_slots" && item.mode === "legacy" ? <p className="mt-1 font-medium text-foreground">Legacy availability · mode unknown</p> : null}
      {date ? <p className="mt-1 flex items-center gap-1 text-muted-foreground"><Clock3 aria-hidden="true" className="size-3.5" />{date} · {displayTime(item.start_time)}–{displayTime(item.end_time)}</p> : null}
      {typeof item.consultation_fee === "number" ? <p className="mt-1 text-xs text-muted-foreground">Consultation fee: ₹{item.consultation_fee.toLocaleString("en-IN")}</p> : null}
      {typeof item.remaining_capacity === "number" && typeof item.capacity === "number" ? <p className="mt-1 text-xs text-muted-foreground">{item.remaining_capacity} of {item.capacity} places remaining{item.mode === "stream" ? " in this window" : " in this slot"}</p> : null}
    </li>;
  })}</ul>;
}
function ResultIcon({ result }: { result: AssistantResult }) { return result.tool === "search_doctors" ? <Stethoscope aria-hidden="true" className="size-4" /> : <CalendarDays aria-hidden="true" className="size-4" />; }

export function PatientAssistantChat({ compact = false, onClose }: { compact?: boolean; onClose?: () => void }) {
  const { getToken } = useAuth();
  const [state, dispatch] = useReducer(chatReducer, initialChatState);
  const [draft, setDraft] = useState("");
  const [ready, setReady] = useState(false);
  const [history, setHistory] = useState({ hasMore: false, nextBefore: null as string | null, loadingOlder: false, olderError: null as string | null, reachedStart: false });
  const [nearTop, setNearTop] = useState(false);
  const [nearLatest, setNearLatest] = useState(true);
  const conversationId = useRef<string | null>(null);
  const requestInFlight = useRef(false);
  const olderLoadInFlight = useRef(false);
  const messageList = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);
  const prependAnchor = useRef<{ scrollHeight: number; scrollTop: number } | null>(null);

  useLayoutEffect(() => {
    const container = messageList.current;
    if (!container) return;
    if (prependAnchor.current) {
      const anchor = prependAnchor.current;
      container.scrollTop = preserveScrollAfterPrepend(container.scrollHeight, anchor.scrollHeight, anchor.scrollTop);
      prependAnchor.current = null;
    } else if (nearBottom.current) {
      container.scrollTop = container.scrollHeight;
    }
  }, [state.messages]);

  const loadConversation = useCallback(async () => {
    dispatch({ type: "loading", value: true });
    try {
      const token = await getToken();
      if (!token) throw new AssistantApiError(401, "Your secure sign-in session is not ready. Please sign in again.");
      const requested = new URLSearchParams(window.location.search).get("conversation");
      const id = requested || (await listAssistantConversations(token)).items[0]?.id;
      if (id) {
        const stored = await getAssistantConversation(token, id, { limit: 20 });
        conversationId.current = stored.conversation.id;
        dispatch({ type: "restore", messages: stored.messages.map((message) => ({ id: message.id, requestId: message.request_id, role: message.role, content: message.content, results: message.results, failed: message.request_status === "failed" })) });
        setHistory({ hasMore: stored.has_more, nextBefore: stored.next_before, loadingOlder: false, olderError: null, reachedStart: false });
      }
    } catch (error) { dispatch({ type: "failure", requestId: "load", message: error instanceof Error ? error.message : "We couldn't load this conversation." }); }
    finally { setReady(true); dispatch({ type: "loading", value: false }); }
  }, [getToken]);
  useEffect(() => { const timer = window.setTimeout(() => { void loadConversation(); }, 0); return () => window.clearTimeout(timer); }, [loadConversation]);

  const loadOlderMessages = useCallback(async () => {
    if (!history.hasMore || !history.nextBefore || history.loadingOlder || olderLoadInFlight.current || !conversationId.current) return;
    olderLoadInFlight.current = true;
    setHistory((current) => ({ ...current, loadingOlder: true, olderError: null }));
    try {
      const token = await getToken();
      if (!token) throw new AssistantApiError(401, "Your secure sign-in session is not ready. Please sign in again.");
      const container = messageList.current;
      const page = await getAssistantConversation(token, conversationId.current, { limit: 20, before: history.nextBefore });
      if (container) prependAnchor.current = { scrollHeight: container.scrollHeight, scrollTop: container.scrollTop };
      dispatch({ type: "prepend", messages: page.messages.map((message) => ({ id: message.id, requestId: message.request_id, role: message.role, content: message.content, results: message.results, failed: message.request_status === "failed" })) });
      setHistory({ hasMore: page.has_more, nextBefore: page.next_before, loadingOlder: false, olderError: null, reachedStart: !page.has_more });
    } catch (error) {
      prependAnchor.current = null;
      setHistory((current) => ({ ...current, loadingOlder: false, olderError: error instanceof Error ? error.message : "Older messages couldn't be loaded. Please try again." }));
    } finally {
      olderLoadInFlight.current = false;
    }
  }, [getToken, history.hasMore, history.loadingOlder, history.nextBefore]);

  const deliver = useCallback(async (requestId: string, content: string) => {
    if (requestInFlight.current) return;
    requestInFlight.current = true;
    dispatch({ type: "loading", value: true });
    try {
      const token = await getToken();
      if (!token) throw new AssistantApiError(401, "Your secure sign-in session is not ready. Please sign in again.");
      if (!conversationId.current) {
        const id = crypto.randomUUID(); conversationId.current = id; await createAssistantConversation(token, id);
        if (!compact) window.history.replaceState(null, "", `/patient/assistant?conversation=${id}`);
      }
      const reply = await sendAssistantMessage(token, conversationId.current, requestId, content);
      dispatch({ type: "success", requestId, user: { id: reply.user_message.id, requestId, role: "user", content }, assistant: { id: reply.assistant_message.id, role: "assistant", content: reply.assistant_message.content, results: reply.assistant_message.results || [] } });
    } catch (error) { dispatch({ type: "failure", requestId, message: error instanceof Error ? error.message : "We couldn't get a reply. Please try again." }); }
    finally { requestInFlight.current = false; }
  }, [compact, getToken]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const content = draft.trim(); if (!content || state.loading || requestInFlight.current || !ready) return;
    const requestId = crypto.randomUUID(); dispatch({ type: "submit", message: { requestId, role: "user", content } }); setDraft(""); void deliver(requestId, content);
  }
  const retry = () => { const failed = [...state.messages].reverse().find((item) => item.failed && item.requestId); if (failed) void deliver(failed.requestId!, failed.content); else void loadConversation(); };
  const content = <>
    <header className={`flex items-center gap-3 ${compact ? "px-4 py-3" : "mb-5"}`}>
      <span className="flex size-10 items-center justify-center rounded-2xl bg-secondary text-secondary-foreground"><MessageCircle aria-hidden="true" className="size-5" /></span>
      <div className="min-w-0 flex-1"><p className="text-sm font-medium text-primary">Medrella Assistant</p><h1 className="text-xl font-semibold tracking-tight text-foreground">How can I help?</h1></div>
      {compact ? <><Link href="/patient/assistant" className="text-xs font-medium text-primary hover:underline">Full assistant</Link><Button type="button" variant="ghost" size="sm" onClick={onClose} aria-label="Close assistant">Close</Button></> : null}
    </header>
    <section aria-label="Assistant conversation" aria-live="polite" className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
      <div className="relative min-h-0 flex-1">
      <div ref={messageList} onScroll={(event) => { const element = event.currentTarget; const top = isNearMessageListTop(element.scrollTop); const bottom = isNearMessageListBottom(element.scrollHeight, element.clientHeight, element.scrollTop); nearBottom.current = bottom; setNearTop(top); setNearLatest(bottom); }} className="absolute inset-0 space-y-4 overflow-y-auto overscroll-contain p-4 pb-20 sm:p-5 sm:pb-20">
        {history.hasMore && nearTop ? <div className="flex flex-col gap-1 border-b border-border pb-2"><Button type="button" variant="ghost" size="sm" className="h-8 gap-2 px-2 text-muted-foreground hover:text-foreground" disabled={history.loadingOlder} onClick={() => void loadOlderMessages()}><ArrowUp aria-hidden="true" className="size-4" />{history.loadingOlder ? "Loading older messages…" : "Load older messages"}</Button>{history.olderError ? <p role="alert" className="px-2 text-xs text-destructive">{history.olderError}</p> : null}</div> : null}
        {state.messages.length === 0 ? <div className="mx-auto flex min-h-64 max-w-lg flex-col items-center justify-center text-center">
          <span className="flex size-12 items-center justify-center rounded-full bg-secondary text-secondary-foreground"><Sparkles aria-hidden="true" className="size-5" /></span>
          <h2 className="mt-4 text-lg font-semibold text-card-foreground">Your care, easier to navigate</h2>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">Ask about your upcoming or previous appointments, find a doctor, or check available appointment times.</p>
          <p className="mt-4 flex items-center gap-2 text-xs text-muted-foreground"><Search aria-hidden="true" className="size-3.5" /> For example: “Find a cardiologist”</p>
        </div> : state.messages.map((message, index) => <article key={message.id || message.requestId || `${message.role}-${index}`} className={`flex flex-col ${message.role === "user" ? "items-end" : "items-start"}`}>
          <div className={`flex max-w-[94%] items-end gap-2 sm:max-w-[82%] ${message.role === "user" ? "flex-row-reverse" : ""}`}>
          {message.role === "user" ? <span aria-label="Patient" className="mb-1 flex size-8 shrink-0 items-center justify-center rounded-full border border-border bg-secondary text-secondary-foreground"><UserRound aria-hidden="true" className="size-4" /></span> : null}
          <div className={`min-w-0 rounded-2xl p-3 ${message.role === "user" ? "rounded-br-md bg-primary text-primary-foreground" : "rounded-bl-md border border-border bg-background text-foreground"}`}>
            {message.role === "assistant" ? <p className="mb-1 text-xs font-semibold opacity-75">Medrella Assistant</p> : null}<p className="whitespace-pre-wrap text-sm leading-6">{message.role === "assistant" ? getAssistantDisplayContent(message.content, message.results) : message.content}</p>
            {message.role === "assistant" ? getVisibleAssistantResults(message.content, message.results).map((result, index) => <section key={`${result.tool}-${index}`} className="mt-3 rounded-xl border border-border bg-card p-3 text-card-foreground"><h3 className="flex items-center gap-2 text-xs font-semibold"><ResultIcon result={result} />{result.tool === "search_doctors" ? "Doctors" : result.tool === "get_available_slots" ? "Available times" : "Appointments"}</h3><ResultCards result={result} /></section>) : null}
          </div>
          </div>
          {message.failed && message.requestId ? <div className="mt-1 flex w-full justify-end pr-10">
            <span className="group relative inline-flex">
              <Button type="button" variant="ghost" size="icon-sm" className="text-destructive hover:bg-destructive/10 hover:text-destructive focus-visible:ring-destructive" aria-label="Retry this message" aria-describedby={`retry-tooltip-${message.requestId}`} disabled={state.loading} onClick={() => void deliver(message.requestId!, message.content)}>
                <RefreshCw aria-hidden="true" className="size-3.5" />
              </Button>
              <span id={`retry-tooltip-${message.requestId}`} role="tooltip" className="pointer-events-none absolute bottom-full right-0 z-10 mb-1 whitespace-nowrap rounded-md bg-popover px-2 py-1 text-xs text-popover-foreground opacity-0 shadow-md transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">Retry this message</span>
            </span>
          </div> : null}
        </article>)}
        {state.loading && state.messages.length ? <div className="flex items-center gap-2 text-sm text-muted-foreground" role="status"><LoaderCircle aria-hidden="true" className="size-4 animate-spin" />Checking that for you…</div> : null}
      </div>
      {!nearLatest && state.messages.length ? <Button type="button" variant="outline" size="icon" className="absolute bottom-4 right-4 z-20 rounded-full border border-border bg-background text-foreground shadow-lg hover:bg-muted" aria-label="Scroll to latest messages" onClick={() => { const element = messageList.current; if (element) element.scrollTo({ top: element.scrollHeight, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" }); }}><ArrowDown aria-hidden="true" className="size-4" /></Button> : null}
      </div>
      {state.error ? <div role="alert" className="mx-3 mb-2 flex items-center justify-between gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-foreground"><span>{state.error}</span><Button type="button" variant="default" size="sm" disabled={state.loading} onClick={retry}>Retry</Button></div> : null}
      {state.loading && !state.messages.length ? <div className="flex items-center gap-2 px-4 pb-2 text-xs text-muted-foreground" role="status"><LoaderCircle aria-hidden="true" className="size-4 animate-spin" />Loading your conversation…</div> : null}
      <form onSubmit={submit} className="sticky bottom-0 z-10 shrink-0 border-t border-border bg-card p-3">
        <label htmlFor={compact ? "assistant-panel-message" : "assistant-message"} className="sr-only">Message Medrella Assistant</label>
        <div className="mx-auto flex w-full items-end gap-2 rounded-2xl border border-input bg-background p-2 focus-within:ring-2 focus-within:ring-ring">
          <textarea id={compact ? "assistant-panel-message" : "assistant-message"} value={draft} onChange={(event) => setDraft(event.target.value.slice(0, 1000))} maxLength={1000} rows={1} placeholder="Ask about appointments, doctors, or available times…" className="max-h-28 min-h-10 flex-1 resize-y bg-transparent px-2 py-2 text-sm text-foreground outline-none placeholder:text-muted-foreground" onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} />
          <Button type="submit" size="icon" aria-label="Send message" disabled={!ready || state.loading || !draft.trim()}><Send aria-hidden="true" /></Button>
        </div>
      </form>
    </section>
  </>;
  return compact ? <div className="flex h-full min-h-0 flex-col">{content}</div> : <main className="-mx-5 -my-7 flex h-[calc(100dvh-4rem)] min-h-0 w-[calc(100%+2.5rem)] flex-col px-4 py-3 sm:-mx-7 sm:-my-9 sm:w-[calc(100%+3.5rem)] sm:px-6 sm:py-4 lg:-mx-10 lg:-my-11 lg:w-[calc(100%+5rem)] lg:px-8">{content}</main>;
}
