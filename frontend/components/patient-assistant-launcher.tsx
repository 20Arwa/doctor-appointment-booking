"use client";

import { MessageCircle, X } from "lucide-react";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { PatientAssistantChat } from "@/components/patient-assistant-chat";
import { Button } from "@/components/ui/button";

export function PatientAssistantLauncher() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  if (pathname === "/patient/assistant" || pathname.startsWith("/patient/assistant/")) return null;
  return <>
    {open ? <aside aria-label="Quick assistant" className="fixed bottom-24 right-4 z-40 flex h-[min(36rem,calc(100dvh-8rem))] w-[min(24rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-2xl sm:bottom-24 sm:right-6">
      <PatientAssistantChat compact onClose={() => setOpen(false)} />
    </aside> : null}
    <Button type="button" size="icon" aria-label={open ? "Close assistant" : "Open assistant"} aria-expanded={open} onClick={() => setOpen((value) => !value)} className="fixed bottom-5 right-4 z-40 size-12 rounded-full shadow-lg sm:bottom-6 sm:right-6">
      {open ? <X aria-hidden="true" /> : <MessageCircle aria-hidden="true" />}
    </Button>
  </>;
}
