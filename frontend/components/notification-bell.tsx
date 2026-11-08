"use client";

import { useAuth } from "@clerk/nextjs";
import { Bell } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { getInAppNotifications, markInAppNotificationRead, ProfileApiError, type InAppNotification } from "@/lib/profile-api";
import { IN_APP_NOTIFICATIONS_CHANGED_EVENT } from "@/lib/notifications";

export function NotificationBell({ role }: { role: "patient" | "doctor" | null }) {
  const { getToken } = useAuth();
  const router = useRouter();
  const [notifications, setNotifications] = useState<InAppNotification[]>([]);
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const inFlightLoad = useRef<Promise<void> | null>(null);
  const refreshQueued = useRef(false);
  const rerunLoad = useRef<() => void>(() => {});
  const load = useCallback((): Promise<void> => {
    if (inFlightLoad.current) {
      refreshQueued.current = true;
      return inFlightLoad.current;
    }
    const execute = async () => {
      do {
        refreshQueued.current = false;
        try {
          const token = await getToken();
          if (!token || !role) return;
          const result = await getInAppNotifications(token, 5);
          setNotifications(result.notifications); setUnread(result.unreadCount); setError(false);
        } catch (cause) { if (!(cause instanceof ProfileApiError && cause.status === 401)) setError(true); }
      } while (refreshQueued.current);
    };
    const trackedRequest = execute().finally(() => {
      inFlightLoad.current = null;
      if (refreshQueued.current) {
        refreshQueued.current = false;
        rerunLoad.current();
      }
    });
    inFlightLoad.current = trackedRequest;
    return trackedRequest;
  }, [getToken, role]);
  useEffect(() => { rerunLoad.current = () => { void load(); }; }, [load]);
  useEffect(() => { const timer = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(timer); }, [load]);
  useEffect(() => {
    const refresh = () => { void load(); };
    const refreshWhenVisible = () => { if (document.visibilityState === "visible") refresh(); };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    window.addEventListener(IN_APP_NOTIFICATIONS_CHANGED_EVENT, refresh);
    const interval = window.setInterval(refresh, 15_000);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
      window.removeEventListener(IN_APP_NOTIFICATIONS_CHANGED_EVENT, refresh);
      window.clearInterval(interval);
    };
  }, [load]);
  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !containerRef.current?.contains(event.target)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);
  async function openNotification(event: React.MouseEvent<HTMLAnchorElement>, item: InAppNotification) {
    event.preventDefault();
    setOpen(false);
    if (!role) return;
    if (!item.read_at) {
      try {
        const token = await getToken();
        if (token) { await markInAppNotificationRead(token, item.id); setUnread((count) => Math.max(0, count - 1)); }
      } catch { /* Navigation remains available if read tracking is temporarily unavailable. */ }
    }
    router.push(`/${role}/appointments?appointment=${encodeURIComponent(item.appointment_id)}`);
  }

  return <div className="relative" ref={containerRef}>
    <button type="button" ref={triggerRef} disabled={!role} aria-label={role ? `Notifications, ${unread} unread` : "Notifications are loading"} aria-expanded={open} onClick={() => { setOpen((value) => !value); if (!open) void load(); }} className="relative flex size-10 items-center justify-center rounded-lg border border-border text-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-wait disabled:opacity-60">
      <Bell aria-hidden="true" className="size-5" />
      {unread > 0 && <span className="absolute -right-1 -top-1 flex min-w-5 items-center justify-center rounded-full bg-primary px-1 text-xs font-semibold text-primary-foreground">{unread > 99 ? "99+" : unread}</span>}
    </button>
    {open && role && <section aria-label="Recent notifications" className="absolute right-0 top-12 z-50 max-h-[min(28rem,calc(100vh-5rem))] w-[min(22rem,calc(100vw-2rem))] overflow-y-auto overscroll-contain rounded-2xl border border-border bg-card p-3 text-card-foreground shadow-xl">
      <div className="flex items-center justify-between px-2 py-1"><h2 className="font-semibold">Notifications</h2><Link onClick={() => setOpen(false)} href={`/${role}/notifications`} className="text-sm text-primary hover:underline">View all notifications</Link></div>
      {error ? <p role="status" className="px-2 py-5 text-sm text-muted-foreground">Notifications are temporarily unavailable.</p> : notifications.length ? <ul className="mt-2 divide-y divide-border">{notifications.map((item) => <li key={item.id}><Link onClick={(event) => void openNotification(event, item)} href={`/${role}/appointments?appointment=${encodeURIComponent(item.appointment_id)}`} className={`block rounded-lg px-2 py-3 hover:bg-muted ${item.read_at ? "" : "bg-secondary/40"}`}><span className="block text-sm font-semibold">{item.title}</span><span className="mt-1 block text-sm text-muted-foreground">{item.message}</span><time className="mt-1 block text-xs text-muted-foreground" dateTime={item.created_at}>{new Date(item.created_at).toLocaleString()}</time></Link></li>)}</ul> : <p className="px-2 py-6 text-center text-sm text-muted-foreground">You’re all caught up.</p>}
    </section>}
  </div>;
}
