"use client";

import { useAuth } from "@clerk/nextjs";
import { CalendarClock, Check, ChevronDown, RefreshCw, UserRound, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { AppointmentAvailabilityCalendar } from "@/components/appointment-availability-calendar";
import { QueueStatusBadge } from "@/components/queue-status-badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  checkInReceptionAppointment, getDoctors, getDoctorSlots, getReceptionQueue, markReceptionNoShow,
  rescheduleReceptionAppointment, type AvailabilitySlot, type DirectoryDoctor, type ReceptionQueueEntry,
} from "@/lib/profile-api";
import { formatDateOnly } from "@/lib/date-format";

function todayInIndia() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date()).map(({ type, value }) => [type, value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function formatTime(value: string) {
  const [hourText, minute] = value.split(":");
  const hour = Number(hourText);
  return `${hour % 12 || 12}:${minute} ${hour >= 12 ? "PM" : "AM"}`;
}

export function ReceptionistDashboard() {
  const { getToken } = useAuth();
  const [doctors, setDoctors] = useState<DirectoryDoctor[]>([]);
  const [entries, setEntries] = useState<ReceptionQueueEntry[]>([]);
  const [date, setDate] = useState(todayInIndia);
  const [doctorId, setDoctorId] = useState("all");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionId, setActionId] = useState<string | null>(null);
  const [reschedulingId, setReschedulingId] = useState<string | null>(null);
  const [rescheduleDate, setRescheduleDate] = useState("");
  const [rescheduleMonth, setRescheduleMonth] = useState("");
  const [slots, setSlots] = useState<AvailabilitySlot[]>([]);
  const [selectedSlot, setSelectedSlot] = useState("");
  const [finishedOpen, setFinishedOpen] = useState(false);
  const queueLoadPromise = useRef<Promise<void> | null>(null);
  const actionInFlight = useRef(false);

  const loadDoctors = useCallback(async () => {
    try { setDoctors(await getDoctors()); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "We couldn't load doctors."); }
  }, []);

  const loadQueue = useCallback(async (force = false) => {
    while (queueLoadPromise.current) {
      if (!force) return;
      await queueLoadPromise.current;
    }
    const request = (async () => {
      setLoading(true); setError(null);
      try {
        const token = await getToken();
        if (!token) throw new Error("Your secure sign-in session is not ready. Please sign in again.");
        setEntries(await getReceptionQueue(token, date, doctorId === "all" ? undefined : doctorId));
      } catch (cause) { setError(cause instanceof Error ? cause.message : "We couldn't load the reception queue."); }
      finally { setLoading(false); }
    })();
    queueLoadPromise.current = request;
    try { await request; }
    finally { if (queueLoadPromise.current === request) queueLoadPromise.current = null; }
  }, [date, doctorId, getToken]);

  useEffect(() => { void loadDoctors(); }, [loadDoctors]);
  useEffect(() => { void loadQueue(); }, [loadQueue]);

  useEffect(() => {
    let timer: number | undefined;
    const refreshIfVisible = () => {
      if (document.visibilityState === "visible" && actionId === null && !queueLoadPromise.current && !actionInFlight.current) void loadQueue();
    };
    timer = window.setInterval(refreshIfVisible, 15_000);
    window.addEventListener("focus", refreshIfVisible);
    document.addEventListener("visibilitychange", refreshIfVisible);
    return () => { if (timer !== undefined) window.clearInterval(timer); window.removeEventListener("focus", refreshIfVisible); document.removeEventListener("visibilitychange", refreshIfVisible); };
  }, [actionId, loadQueue]);

  async function runAction(id: string, action: (token: string) => Promise<unknown>) {
    actionInFlight.current = true;
    setActionId(id); setError(null);
    try {
      const token = await getToken();
      if (!token) throw new Error("Your secure sign-in session is not ready. Please sign in again.");
      await action(token);
      await loadQueue(true);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "The appointment action could not be completed."); }
    finally { actionInFlight.current = false; setActionId(null); }
  }

  async function loadSlots(entry: ReceptionQueueEntry, month = rescheduleMonth || todayInIndia().slice(0, 7)) {
    setActionId(entry.appointment_id); setError(null); setSlots([]); setSelectedSlot("");
    try {
      const token = await getToken();
      if (!token) throw new Error("Your secure sign-in session is not ready. Please sign in again.");
      const [year, monthNumber] = month.split("-").map(Number);
      const from = `${month}-01`;
      const to = new Date(Date.UTC(year, monthNumber, 0)).toISOString().slice(0, 10);
      const result = await getDoctorSlots(token, entry.doctor_id, from, to);
      setSlots(result.filter((slot) => (slot.remaining_capacity ?? 0) > 0));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "We couldn't load available times."); }
    finally { setActionId(null); }
  }

  function beginReschedule(entry: ReceptionQueueEntry) {
    const month = todayInIndia().slice(0, 7);
    setReschedulingId(entry.appointment_id); setRescheduleDate(todayInIndia()); setRescheduleMonth(month); setSlots([]); setSelectedSlot("");
    void loadSlots(entry, month);
  }

  async function shiftRescheduleMonth(entry: ReceptionQueueEntry, month: string) {
    setRescheduleMonth(month); setRescheduleDate(`${month}-01`); setSelectedSlot("");
    setActionId(entry.appointment_id); setError(null);
    try {
      const token = await getToken();
      if (!token) throw new Error("Your secure sign-in session is not ready. Please sign in again.");
      const [year, monthNumber] = month.split("-").map(Number);
      const result = await getDoctorSlots(token, entry.doctor_id, `${month}-01`, new Date(Date.UTC(year, monthNumber, 0)).toISOString().slice(0, 10));
      setSlots(result.filter((slot) => (slot.remaining_capacity ?? 0) > 0));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "We couldn't load available times."); }
    finally { setActionId(null); }
  }

  const compareScheduledTime = (first: ReceptionQueueEntry, second: ReceptionQueueEntry) =>
    first.date.localeCompare(second.date) || first.start_time.localeCompare(second.start_time) || first.appointment_id.localeCompare(second.appointment_id);
  const notCheckedInEntries = entries.filter((entry) => entry.status === "not_checked_in").sort(compareScheduledTime);
  const checkedInEntries = entries.filter((entry) => entry.status === "waiting" || entry.status === "in_progress").sort(compareScheduledTime);
  const finishedEntries = entries.filter((entry) => entry.status === "completed" || entry.status === "no_show" || entry.status === "cancelled").sort(compareScheduledTime);

  function renderEntry(entry: ReceptionQueueEntry) {
    const doctor = doctors.find((item) => item.id === entry.doctor_id);
    const pending = actionId === entry.appointment_id;
    const canReschedule = entry.status === "not_checked_in";
    const canCheckInToday = date === todayInIndia() && entry.status === "not_checked_in";
    return (
      <article key={entry.appointment_id} className="rounded-2xl border border-border bg-card p-5 shadow-sm">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="font-semibold text-card-foreground">{entry.patient_first_name} {entry.patient_last_name}</h2>
              <span className="rounded-full bg-secondary px-2.5 py-1 text-xs font-medium text-secondary-foreground">Token {entry.token_number}</span>
              <QueueStatusBadge status={entry.status} />
            </div>
            <p className="mt-2 text-sm text-muted-foreground"><UserRound aria-hidden="true" className="mr-1 inline size-4" /> Dr. {doctor?.first_name ?? entry.doctor_first_name} {doctor?.last_name ?? entry.doctor_last_name}{doctor ? ` · ${doctor.specialty}` : ""}</p>
            <p className="mt-1 text-sm text-muted-foreground">{formatTime(entry.start_time)}–{formatTime(entry.end_time)}</p>
            {entry.checked_in_at ? <p className="mt-1 text-sm text-muted-foreground">Checked in {new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" }).format(new Date(entry.checked_in_at))} IST</p> : null}
          </div>
          <div className="flex flex-wrap gap-2">
            {canCheckInToday ? <Button type="button" className="bg-status-confirmed-bg text-status-confirmed hover:bg-primary hover:text-primary-foreground" onClick={() => void runAction(entry.appointment_id, (token) => checkInReceptionAppointment(token, entry.appointment_id))} disabled={pending}><Check aria-hidden="true" className="size-4" /> Check In</Button> : null}
            {entry.no_show_eligible ? <Button type="button" variant="destructive" onClick={() => void runAction(entry.appointment_id, (token) => markReceptionNoShow(token, entry.appointment_id))} disabled={pending}>No-show</Button> : null}
            {canReschedule ? <Button type="button" variant="secondary" onClick={() => { if (reschedulingId === entry.appointment_id) { setReschedulingId(null); setSlots([]); setSelectedSlot(""); } else beginReschedule(entry); }} disabled={pending}><RefreshCw aria-hidden="true" className="size-4" /> Reschedule</Button> : null}
          </div>
        </div>
        {reschedulingId === entry.appointment_id ? (
          <div className="mt-5 grid gap-3 border-t border-border pt-4">
            <div className="flex items-center justify-between gap-3"><h3 className="font-semibold text-foreground">Reschedule appointment</h3><Button type="button" variant="ghost" size="sm" onClick={() => { setReschedulingId(null); setSlots([]); setSelectedSlot(""); }}><X aria-hidden="true" className="size-4" /> Close</Button></div>
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">Choose an available date, then select a time · IST</p>
              {pending && !slots.length ? <p className="text-sm text-muted-foreground" role="status">Loading availability…</p> : null}
              {!pending && !slots.length ? <p className="text-sm text-muted-foreground">No available dates in this month.</p> : null}
              <AppointmentAvailabilityCalendar slots={slots} month={rescheduleMonth || todayInIndia().slice(0, 7)} selectedDate={rescheduleDate} onSelectDate={(day) => { setRescheduleDate(day); setSelectedSlot(""); }} onShiftMonth={(month) => void shiftRescheduleMonth(entry, month)} />
              {slots.filter((slot) => slot.date === rescheduleDate).length ? <label className="block text-sm font-medium">Available time<Select value={selectedSlot} onValueChange={setSelectedSlot}><SelectTrigger className="mt-1.5"><SelectValue placeholder="Choose a time" /></SelectTrigger><SelectContent>{slots.filter((slot) => slot.date === rescheduleDate).map((slot) => <SelectItem key={slot.id} value={slot.id}>{formatTime(slot.start_time)}–{formatTime(slot.end_time)}</SelectItem>)}</SelectContent></Select></label> : null}
            </div>
            <div className="flex flex-wrap items-end gap-2">
              <Button type="button" variant="outline" onClick={() => { setReschedulingId(null); setSlots([]); setSelectedSlot(""); }}>Cancel</Button>
              {selectedSlot ? <Button type="button" disabled={pending} onClick={() => void runAction(entry.appointment_id, async (token) => {
                await rescheduleReceptionAppointment(token, entry.appointment_id, selectedSlot);
                setReschedulingId(null); setSlots([]);
              })}>Confirm time</Button> : null}
            </div>
          </div>
        ) : null}
      </article>
    );
  }

  return (
    <section aria-labelledby="reception-title" className="space-y-7">
      <div>
        <p className="text-sm font-semibold uppercase tracking-[0.14em] text-primary">Single clinic</p>
        <h1 id="reception-title" className="mt-2 text-3xl font-semibold tracking-tight text-foreground">Reception dashboard</h1>
        <p className="mt-2 text-muted-foreground">Review appointments and queue activity across all doctors.</p>
      </div>

      <div className="grid gap-4 rounded-2xl border border-border bg-card p-5 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
        <div>
          <label htmlFor="reception-date" className="mb-1.5 block text-sm font-medium">Appointment date</label>
          <input id="reception-date" type="date" value={date} onChange={(event) => setDate(event.target.value)} className="min-h-11 w-full rounded-lg border border-input bg-background px-3.5 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring" />
        </div>
        <div>
          <label className="mb-1.5 block text-sm font-medium" id="doctor-filter-label">Doctor</label>
          <Select value={doctorId} onValueChange={setDoctorId}>
            <SelectTrigger aria-labelledby="doctor-filter-label"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All doctors</SelectItem>
              {doctors.map((doctor) => <SelectItem key={doctor.id} value={doctor.id}>Dr. {doctor.first_name} {doctor.last_name} · {doctor.specialty}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <Button type="button" variant="outline" onClick={() => void loadQueue()} disabled={loading}><RefreshCw aria-hidden="true" className="size-4" /> Refresh</Button>
      </div>

      {error ? <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">{error}</p> : null}
      <div className="flex items-center gap-2 text-sm text-muted-foreground"><CalendarClock aria-hidden="true" className="size-4" /> {formatDateOnly(date)} <span aria-hidden="true">·</span> {loading ? "Loading appointments…" : `${entries.length} appointments`}</div>

      {!loading && entries.length === 0 ? <div className="rounded-2xl border border-dashed border-border px-6 py-12 text-center text-muted-foreground">No appointments are in the queue for this date and doctor filter.</div> : null}
      {notCheckedInEntries.length ? <section aria-labelledby="not-checked-in-heading" className="space-y-3"><h2 id="not-checked-in-heading" className="text-lg font-semibold text-foreground">Not checked in</h2>{notCheckedInEntries.map(renderEntry)}</section> : null}
      {checkedInEntries.length ? <section aria-labelledby="checked-in-heading" className="space-y-3"><h2 id="checked-in-heading" className="text-lg font-semibold text-foreground">Waiting and In progress</h2>{checkedInEntries.map(renderEntry)}</section> : null}
      {finishedEntries.length ? <section className="rounded-2xl border border-border bg-card p-4"><button type="button" aria-expanded={finishedOpen} aria-controls="finished-appointments-panel" onClick={() => setFinishedOpen((open) => !open)} className="flex w-full items-center justify-between gap-3 text-left font-semibold text-foreground focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"><span>Past / Finished appointments <span className="ml-1 text-sm font-normal text-muted-foreground">({finishedEntries.length})</span></span><ChevronDown aria-hidden="true" className={`size-5 shrink-0 transition-transform duration-200 motion-reduce:transition-none ${finishedOpen ? "rotate-180" : "rotate-0"}`} /></button><div id="finished-appointments-panel" aria-hidden={!finishedOpen} className={`grid transition-[grid-template-rows,opacity] duration-200 motion-reduce:transition-none ${finishedOpen ? "mt-4 grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"}`}><div className="min-h-0 overflow-hidden"><div className="space-y-3">{finishedEntries.map(renderEntry)}</div></div></div></section> : null}
    </section>
  );
}
