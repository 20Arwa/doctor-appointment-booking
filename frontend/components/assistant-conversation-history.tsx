"use client";

import { useAuth } from "@clerk/nextjs";
import { MessageCircle, Trash2 } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { AssistantApiError, deleteAssistantConversation, listAssistantConversations, type AssistantConversation } from "@/lib/assistant-api";

export function AssistantConversationHistory() {
  const { getToken } = useAuth();
  const [items, setItems] = useState<AssistantConversation[]>([]);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try { const token = await getToken(); if (!token) throw new AssistantApiError(401, "Sign in again to load chat history."); setItems((await listAssistantConversations(token)).items); setError(null); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "We couldn't load conversations."); }
  }, [getToken]);
  useEffect(() => { const timer = window.setTimeout(() => { void load(); }, 0); return () => window.clearTimeout(timer); }, [load]);
  async function remove(id: string) {
    try { const token = await getToken(); if (!token) throw new Error("Sign in again to manage chat history."); await deleteAssistantConversation(token, id); setItems((current) => current.filter((item) => item.id !== id)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "We couldn't delete this conversation."); }
  }
  return <section aria-labelledby="assistant-history-title" className="rounded-2xl border border-border bg-card p-5 shadow-sm sm:p-6">
    <div className="flex items-center gap-3"><span className="flex size-10 items-center justify-center rounded-xl bg-secondary text-secondary-foreground"><MessageCircle aria-hidden="true" className="size-5" /></span><div><h2 id="assistant-history-title" className="font-semibold text-card-foreground">Assistant conversations</h2><p className="text-sm text-muted-foreground">Your recent chats, available across devices.</p></div><Link href="/patient/assistant" className="ml-auto text-sm font-medium text-primary hover:underline">Open assistant</Link></div>
    {error ? <p role="alert" className="mt-4 text-sm text-destructive">{error} <button type="button" className="underline" onClick={() => void load()}>Retry</button></p> : null}
    {!error && !items.length ? <p className="mt-4 text-sm text-muted-foreground">Your conversations will appear here.</p> : null}
    <ul className="mt-4 divide-y divide-border">{items.map((item) => <li key={item.id} className="flex items-center gap-3 py-3"><Link href={`/patient/assistant?conversation=${encodeURIComponent(item.id)}`} className="min-w-0 flex-1 rounded-md focus-visible:outline-2 focus-visible:outline-ring"><span className="block truncate text-sm font-medium text-foreground">{item.preview || "New conversation"}</span><span className="mt-1 block text-xs text-muted-foreground">{new Intl.DateTimeFormat("en-IN", { dateStyle: "medium" }).format(new Date(item.updated_at))}</span></Link><Button type="button" variant="ghost" size="icon" aria-label="Delete conversation" onClick={() => void remove(item.id)}><Trash2 aria-hidden="true" className="size-4" /></Button></li>)}</ul>
  </section>;
}
