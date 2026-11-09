"use client";

import { useAuth } from "@clerk/nextjs";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getInAppNotifications, markAllInAppNotificationsRead, markInAppNotificationRead, ProfileApiError, type InAppNotification } from "@/lib/profile-api";
import { notifyInAppNotificationsChanged } from "@/lib/notifications";

export function InAppNotificationsPage({ role }: { role: "patient" | "doctor" }) {
  const { getToken } = useAuth();
  const router = useRouter();
  const [items, setItems] = useState<InAppNotification[]>([]);
  const [unread, setUnread] = useState(0);
  const [total, setTotal] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try { const token = await getToken(); if (!token) return; const result = await getInAppNotifications(token, 5); setItems(result.notifications); setUnread(result.unreadCount); setTotal(result.totalCount); setError(null); }
    catch (cause) { setError(cause instanceof ProfileApiError ? cause.message : "Notifications could not be loaded."); }
  }, [getToken]);
  useEffect(() => { const timer = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(timer); }, [load]);
  async function markOne(item: InAppNotification) {
    if (item.read_at) return;
    const token = await getToken(); if (!token) return;
    setBusy(true);
    try { const updated = await markInAppNotificationRead(token, item.id); setItems((current) => current.map((entry) => entry.id === updated.id ? updated : entry)); setUnread((count) => Math.max(0, count - 1)); notifyInAppNotificationsChanged(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Notification could not be marked read."); }
    finally { setBusy(false); }
  }
  async function markAll() {
    const token = await getToken(); if (!token) return;
    setBusy(true);
    try { const result = await markAllInAppNotificationsRead(token); setItems((current) => current.map((item) => ({ ...item, read_at: item.read_at || new Date().toISOString() }))); setUnread(0); if (result.updated > 0) notifyInAppNotificationsChanged(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Notifications could not be marked read."); }
    finally { setBusy(false); }
  }
  async function loadMore() {
    const token = await getToken(); if (!token) return;
    setLoadingMore(true);
    try { const result = await getInAppNotifications(token, 5, items.length); setItems((current) => [...current, ...result.notifications]); setTotal(result.totalCount); setUnread(result.unreadCount); setError(null); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "More notifications could not be loaded."); }
    finally { setLoadingMore(false); }
  }
  async function openNotification(event: React.MouseEvent<HTMLAnchorElement>, item: InAppNotification) {
    event.preventDefault();
    await markOne(item);
    router.push(`/${role}/appointments?appointment=${encodeURIComponent(item.appointment_id)}`);
  }
  return <section className="mx-auto max-w-3xl" aria-labelledby="notifications-title">
    <div className="flex flex-wrap items-end justify-between gap-4"><div><p className="text-sm font-semibold uppercase tracking-wide text-primary">Your account</p><h1 id="notifications-title" className="mt-2 text-3xl font-semibold tracking-tight">Notifications</h1><p className="mt-2 text-muted-foreground">{unread} unread</p></div><button type="button" disabled={busy || unread === 0} onClick={() => void markAll()} className="min-h-10 rounded-lg border border-border px-4 text-sm font-semibold text-foreground hover:bg-muted disabled:opacity-50">Mark all as read</button></div>
    {error && <p role="alert" className="mt-5 rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">{error}</p>}
    <ul className="mt-6 divide-y divide-border overflow-hidden rounded-2xl border border-border bg-card">{items.map((item) => <li key={item.id}><a onClick={(event) => void openNotification(event, item)} href={`/${role}/appointments?appointment=${encodeURIComponent(item.appointment_id)}`} className={`block p-5 transition-colors hover:bg-muted ${item.read_at ? "" : "bg-secondary/30"}`}><div className="flex items-start justify-between gap-4"><div><h2 className="font-semibold">{item.title}</h2><p className="mt-1 text-sm text-muted-foreground">{item.message}</p></div>{!item.read_at && <span aria-label="Unread" className="mt-2 size-2 shrink-0 rounded-full bg-primary" />}</div><time className="mt-3 block text-xs text-muted-foreground" dateTime={item.created_at}>{new Date(item.created_at).toLocaleString()}</time></a></li>)}</ul>
    {items.length < total && <div className="mt-4 flex justify-center"><button type="button" onClick={() => void loadMore()} disabled={loadingMore} className="inline-flex min-h-11 items-center justify-center rounded-lg border border-border bg-card px-5 text-sm font-semibold text-foreground transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-wait disabled:opacity-60">{loadingMore ? "Loading…" : error ? "Try again" : "Show More"}</button></div>}
    {!error && items.length === 0 && <p className="mt-6 rounded-2xl border border-border bg-card p-10 text-center text-muted-foreground">You have no notifications.</p>}
  </section>;
}
