"use client";

import { MessageCircle } from "lucide-react";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { PatientAssistantChat } from "@/components/patient-assistant-chat";
import { Button } from "@/components/ui/button";

export function PatientAssistantLauncher({ audience = "patient" }: { audience?: "patient" | "doctor" }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const closeTimer = useRef<number | null>(null);
  const assistantPath = audience === "doctor" ? "/doctor/assistant" : "/patient/assistant";
  useEffect(() => () => { if (closeTimer.current !== null) window.clearTimeout(closeTimer.current); }, []);
  const dismissPanel = () => {
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    setClosing(true);
    closeTimer.current = window.setTimeout(() => {
      setOpen(false);
      setClosing(false);
      closeTimer.current = null;
    }, 180);
  };
  if (pathname === assistantPath || pathname.startsWith(`${assistantPath}/`)) return null;
  return <>
    {open ? <aside aria-label={audience === "doctor" ? "Doctor AI Assistant" : "Patient AI Assistant"} className={`fixed inset-0 z-40 flex h-dvh w-full flex-col overflow-hidden border border-border/80 bg-card shadow-2xl ring-1 ring-border/50 motion-reduce:animate-none ${closing ? "motion-safe:animate-out motion-safe:fade-out motion-safe:zoom-out-95 motion-safe:slide-out-to-bottom-2 motion-safe:duration-150 pointer-events-none" : "motion-safe:animate-in motion-safe:fade-in motion-safe:zoom-in-95 motion-safe:slide-in-from-bottom-2 motion-safe:duration-200"} sm:inset-auto sm:bottom-16 sm:right-6 sm:h-[min(42rem,calc(100dvh-8rem))] sm:w-[min(31rem,calc(100vw-3rem))] sm:rounded-2xl`}>
      <PatientAssistantChat compact audience={audience} onClose={dismissPanel} />
    </aside> : null}
    <Button type="button" size="icon" aria-label={open ? "Close assistant panel" : "Open assistant"} aria-expanded={open} onClick={() => {
      if (!open) { setClosing(false); setOpen(true); }
      else dismissPanel();
    }} className={`fixed bottom-5 right-4 z-50 size-12 rounded-full shadow-lg sm:bottom-6 sm:right-6 ${open ? "hidden" : "flex"}`}>
      <MessageCircle aria-hidden="true" />
    </Button>
  </>;
}
