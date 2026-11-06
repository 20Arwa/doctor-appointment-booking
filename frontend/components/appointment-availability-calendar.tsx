"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import type { AvailabilitySlot } from "@/lib/profile-api";

function monthDays(month: string) {
  const [year, monthNumber] = month.split("-").map(Number);
  const offset = new Date(Date.UTC(year, monthNumber - 1, 1)).getUTCDay();
  const days = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  const cells: (string | null)[] = [...Array.from({ length: offset }, () => null), ...Array.from({ length: days }, (_, index) => `${month}-${String(index + 1).padStart(2, "0")}`)];
  while (cells.length % 7) cells.push(null);
  return cells;
}

function todayInIndia() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date()).map(({ type, value }) => [type, value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function formatDate(date: string) {
  const [year, month, day] = date.split("-").map(Number);
  return new Intl.DateTimeFormat("en-IN", { dateStyle: "full", timeZone: "UTC" }).format(new Date(Date.UTC(year, month - 1, day)));
}

function formatMonth(month: string) {
  const [year, monthNumber] = month.split("-").map(Number);
  return new Intl.DateTimeFormat("en-IN", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(year, monthNumber - 1, 1)));
}

function shiftMonth(month: string, offset: number) {
  const [year, monthNumber] = month.split("-").map(Number);
  return new Date(Date.UTC(year, monthNumber - 1 + offset, 1)).toISOString().slice(0, 7);
}

export function AppointmentAvailabilityCalendar({ slots, month, selectedDate, onSelectDate, onShiftMonth }: {
  slots: AvailabilitySlot[];
  month: string;
  selectedDate: string;
  onSelectDate: (date: string) => void;
  onShiftMonth: (month: string) => void;
}) {
  const counts = new Map<string, number>();
  for (const slot of slots) counts.set(slot.date, (counts.get(slot.date) ?? 0) + 1);
  const today = todayInIndia();
  const todayMonth = today.slice(0, 7);
  return (
    <div className="mt-4 rounded-xl border border-border p-3" aria-label="Appointment availability calendar">
      <div className="flex items-center justify-between">
        <button type="button" aria-label="Previous month" disabled={month <= todayMonth} onClick={() => onShiftMonth(shiftMonth(month, -1))} className="rounded-lg p-2 hover:bg-muted disabled:opacity-40"><ChevronLeft aria-hidden="true" className="size-4" /></button>
        <h4 className="font-semibold text-foreground" aria-live="polite">{formatMonth(month)}</h4>
        <button type="button" aria-label="Next month" onClick={() => onShiftMonth(shiftMonth(month, 1))} className="rounded-lg p-2 hover:bg-muted"><ChevronRight aria-hidden="true" className="size-4" /></button>
      </div>
      <div className="mt-2 grid grid-cols-7 text-center text-xs text-muted-foreground">{["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((day) => <span key={day} className="py-2">{day}</span>)}</div>
      <div className="grid grid-cols-7 justify-items-center gap-1">{monthDays(month).map((day, index) => {
        if (!day) return <span key={`blank-${index}`} className="size-10" aria-hidden="true" />;
        const count = counts.get(day) ?? 0;
        const selected = day === selectedDate;
        return <button key={day} type="button" disabled={count === 0 || day < today} aria-pressed={selected} aria-label={`${formatDate(day)}${count ? `, ${count} available ${count === 1 ? "option" : "options"}` : ", unavailable"}`} onClick={() => onSelectDate(day)} className={`flex size-10 flex-col items-center justify-center rounded-lg text-xs disabled:cursor-not-allowed disabled:text-muted-foreground/50 ${selected ? "bg-primary font-semibold text-primary-foreground" : count ? "bg-secondary/60 font-medium text-secondary-foreground hover:bg-secondary" : ""}`}><span>{Number(day.slice(-2))}</span>{count ? <span className="text-[9px] leading-none">{count}</span> : null}</button>;
      })}</div>
    </div>
  );
}
