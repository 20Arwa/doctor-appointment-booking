"use client";

import { useAuth } from "@clerk/nextjs";
import { MessageCircle, Trash2, X } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { AssistantApiError, deleteAssistantConversation, listAssistantConversations, type AssistantConversation } from "@/lib/assistant-api";
import { assistantConversationTitle } from "@/lib/assistant-chat-state";

type AssistantAudience = "patient" | "doctor";
type Props = {
  audience?: AssistantAudience;
  activeConversationId?: string | null;
  refreshKey?: number;
  compact?: boolean;
  onSelectConversation?: (id: string) => void;
  onClose?: () => void;
};

export function AssistantConversationHistory({ audience = "patient", activeConversationId, refreshKey = 0, compact = false, onSelectConversation, onClose }: Props) {
  const { getToken, isLoaded, userId } = useAuth();
  const [items, setItems] = useState<AssistantConversation[]>([]);
  const [itemsOwnerUserId, setItemsOwnerUserId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const requestGeneration = useRef(0);
  const assistantPath = audience === "doctor" ? "/doctor/assistant" : "/patient/assistant";
  const load = useCallback(async () => {
    if (!isLoaded || !userId) return;
    const ownerUserId = userId;
    const generation = ++requestGeneration.current;
    setLoading(true);
    try {
      const token = await getToken();
      if (!isLoaded || userId !== ownerUserId || requestGeneration.current !== generation) return;
      if (!token) throw new AssistantApiError(401, "Sign in again to load chat history.");
      const result = await listAssistantConversations(token);
      if (!isLoaded || userId !== ownerUserId || requestGeneration.current !== generation) return;
      setItems(result.items);
      setItemsOwnerUserId(ownerUserId);
      setError(null);
    } catch (cause) {
      if (isLoaded && userId === ownerUserId && requestGeneration.current === generation) setError(cause instanceof Error ? cause.message : "We couldn't load conversations.");
    }
    finally { if (requestGeneration.current === generation) setLoading(false); }
  }, [getToken, isLoaded, userId]);
  useEffect(() => {
    requestGeneration.current += 1;
    if (!isLoaded || !userId) {
      setLoading(true);
      return;
    }
    const timer = window.setTimeout(() => { void load(); }, 0);
    return () => { window.clearTimeout(timer); requestGeneration.current += 1; };
  }, [isLoaded, load, refreshKey, userId]);

  const visibleItems = isLoaded && userId && itemsOwnerUserId === userId ? items : [];

  async function remove(id: string) {
    if (!isLoaded || !userId || itemsOwnerUserId !== userId) return;
    const ownerUserId = userId;
    const generation = requestGeneration.current;
    try {
      const token = await getToken();
      if (!isLoaded || userId !== ownerUserId || requestGeneration.current !== generation) return;
      if (!token) throw new Error("Sign in again to manage chat history.");
      await deleteAssistantConversation(token, id);
      if (!isLoaded || userId !== ownerUserId || requestGeneration.current !== generation) return;
      setItems((current) => current.filter((item) => item.id !== id));
      if (activeConversationId === id) await load();
    } catch (cause) { if (isLoaded && userId === ownerUserId && requestGeneration.current === generation) setError(cause instanceof Error ? cause.message : "We couldn't delete this conversation."); }
  }

  const title = <div className="flex min-w-0 items-center gap-3">
    <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-secondary text-secondary-foreground"><MessageCircle aria-hidden="true" className="size-4" /></span>
    <div className="min-w-0"><h2 className="truncate font-semibold text-card-foreground">Chat history</h2><p className="text-xs text-muted-foreground">Sorted by recent activity</p></div>
    {onClose ? <Button type="button" variant="ghost" size="icon-sm" className="ml-auto" aria-label="Close chat history" title="Close chat history" onClick={onClose}><X aria-hidden="true" className="size-4" /></Button> : null}
    {!onSelectConversation ? <Link href={assistantPath} className="ml-auto shrink-0 text-sm font-medium text-primary hover:underline">Open assistant</Link> : null}
  </div>;

  return <section aria-label="Assistant chat history" className={compact ? "w-[min(21rem,calc(100vw-2rem))] rounded-xl border border-border bg-popover p-3 text-popover-foreground shadow-xl" : "flex min-h-0 flex-col rounded-2xl border border-border bg-card p-4 shadow-sm"}>
    {title}
    {error ? <div className="mt-3 text-sm text-destructive" role="alert"><p>{error}</p><Button type="button" variant="ghost" size="sm" className="mt-1 px-0" onClick={() => void load()}>Retry</Button></div> : null}
    {loading && !visibleItems.length ? <p className="mt-4 text-sm text-muted-foreground" role="status">Loading conversations…</p> : null}
    {!loading && !error && !visibleItems.length ? <p className="mt-4 text-sm text-muted-foreground">Your conversations will appear here.</p> : null}
    {visibleItems.length ? <ul className={`mt-3 divide-y divide-border overflow-y-auto ${compact ? "max-h-[min(55vh,24rem)]" : "min-h-0 flex-1"}`}>
      {visibleItems.map((item) => <li key={item.id} className="flex items-center gap-1 py-1">
        {onSelectConversation ? <Button type="button" variant="ghost" className={`h-auto min-h-12 min-w-0 flex-1 justify-start whitespace-normal px-2 py-2 text-left ${activeConversationId === item.id ? "bg-secondary text-secondary-foreground" : "text-foreground"}`} aria-current={activeConversationId === item.id ? "true" : undefined} onClick={() => onSelectConversation(item.id)}>
          <span className="block min-w-0 flex-1"><span className="block truncate text-sm font-medium">{assistantConversationTitle(item.preview)}</span><span className="mt-0.5 block text-xs text-muted-foreground">{new Intl.DateTimeFormat("en-IN", { dateStyle: "medium" }).format(new Date(item.updated_at))}</span></span>
        </Button> : <Link href={`${assistantPath}?conversation=${encodeURIComponent(item.id)}`} aria-current={activeConversationId === item.id ? "page" : undefined} className={`min-w-0 flex-1 rounded-md p-2 focus-visible:outline-2 focus-visible:outline-ring ${activeConversationId === item.id ? "bg-secondary text-secondary-foreground" : "text-foreground hover:bg-muted"}`}>
          <span className="block truncate text-sm font-medium">{assistantConversationTitle(item.preview)}</span><span className="mt-0.5 block text-xs text-muted-foreground">{new Intl.DateTimeFormat("en-IN", { dateStyle: "medium" }).format(new Date(item.updated_at))}</span>
        </Link>}
        {!compact && activeConversationId !== item.id ? <Button type="button" variant="ghost" size="icon-sm" aria-label={`Delete ${assistantConversationTitle(item.preview)}`} title="Delete conversation" onClick={() => void remove(item.id)}><Trash2 aria-hidden="true" className="size-4" /></Button> : null}
      </li>)}
    </ul> : null}
  </section>;
}
