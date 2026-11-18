"use client";

import { useAuth } from "@clerk/nextjs";
import { CalendarClock, Check, RefreshCw, UserRound } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
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
  const [slots, setSlots] = useState<AvailabilitySlot[]>([]);
  const [selectedSlot, setSelectedSlot] = useState("");

  const loadDoctors = useCallback(async () => {
    try { setDoctors(await getDoctors()); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "We couldn't load doctors."); }
  }, []);

  const loadQueue = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const token = await getToken();
      if (!token) throw new Error("Your secure sign-in session is not ready. Please sign in again.");
      setEntries(await getReceptionQueue(token, date, doctorId === "all" ? undefined : doctorId));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "We couldn't load the reception queue."); }
    finally { setLoading(false); }
  }, [date, doctorId, getToken]);

  useEffect(() => { void loadDoctors(); }, [loadDoctors]);
  useEffect(() => { void loadQueue(); }, [loadQueue]);

  async function runAction(id: string, action: (token: string) => Promise<unknown>) {
    setActionId(id); setError(null);
    try {
      const token = await getToken();
      if (!token) throw new Error("Your secure sign-in session is not ready. Please sign in again.");
      await action(token);
      await loadQueue();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "The appointment action could not be completed."); }
    finally { setActionId(null); }
  }

  async function loadSlots(entry: ReceptionQueueEntry) {
    setActionId(entry.appointment_id); setError(null); setSlots([]); setSelectedSlot("");
    try {
      const token = await getToken();
      if (!token) throw new Error("Your secure sign-in session is not ready. Please sign in again.");
      setSlots(await getDoctorSlots(token, entry.doctor_id, rescheduleDate, rescheduleDate, entry.appointment_id));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "We couldn't load available times."); }
    finally { setActionId(null); }
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
      <div className="space-y-3">
        {entries.map((entry) => {
          const doctor = doctors.find((item) => item.id === entry.doctor_id);
          const pending = actionId === entry.appointment_id;
          const canReschedule = !["in_progress", "completed", "cancelled"].includes(entry.status);
          return (
            <article key={entry.appointment_id} className="rounded-2xl border border-border bg-card p-5 shadow-sm">
              <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="font-semibold text-card-foreground">{entry.patient_first_name} {entry.patient_last_name}</h2>
                    <span className="rounded-full bg-secondary px-2.5 py-1 text-xs font-medium text-secondary-foreground">Token {entry.token_number}</span>
                    <span className="rounded-full border border-border px-2.5 py-1 text-xs capitalize text-muted-foreground">{entry.status.replaceAll("_", " ")}</span>
                  </div>
                  <p className="mt-2 text-sm text-muted-foreground"><UserRound aria-hidden="true" className="mr-1 inline size-4" /> Dr. {doctor?.first_name ?? entry.doctor_first_name} {doctor?.last_name ?? entry.doctor_last_name}{doctor ? ` · ${doctor.specialty}` : ""}</p>
                  <p className="mt-1 text-sm text-muted-foreground">{formatTime(entry.start_time)}–{formatTime(entry.end_time)}</p>
                </div>
                <div className="flex flex-wrap gap-2">
                  {entry.status === "not_checked_in" ? <Button type="button" onClick={() => void runAction(entry.appointment_id, (token) => checkInReceptionAppointment(token, entry.appointment_id))} disabled={pending}><Check aria-hidden="true" className="size-4" /> Check In</Button> : null}
                  {entry.status === "not_checked_in" ? <Button type="button" variant="outline" onClick={() => void runAction(entry.appointment_id, (token) => markReceptionNoShow(token, entry.appointment_id))} disabled={pending}>No-show</Button> : null}
                  {canReschedule ? <Button type="button" variant="outline" onClick={() => { setReschedulingId(reschedulingId === entry.appointment_id ? null : entry.appointment_id); setRescheduleDate(""); setSlots([]); setSelectedSlot(""); }} disabled={pending}><RefreshCw aria-hidden="true" className="size-4" /> Reschedule</Button> : null}
                </div>
              </div>
              {reschedulingId === entry.appointment_id ? (
                <div className="mt-5 grid gap-3 border-t border-border pt-4 sm:grid-cols-[1fr_auto]">
                  <div className="space-y-3">
                    <label className="block text-sm font-medium">Choose a new date<input type="date" min={todayInIndia()} value={rescheduleDate} onChange={(event) => { setRescheduleDate(event.target.value); setSlots([]); setSelectedSlot(""); }} className="mt-1.5 min-h-11 w-full rounded-lg border border-input bg-background px-3.5 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring" /></label>
                    {slots.length ? <label className="block text-sm font-medium">Available time<Select value={selectedSlot} onValueChange={setSelectedSlot}><SelectTrigger className="mt-1.5"><SelectValue placeholder="Choose a time" /></SelectTrigger><SelectContent>{slots.map((slot) => <SelectItem key={slot.id} value={slot.id}>{formatTime(slot.start_time)}–{formatTime(slot.end_time)}</SelectItem>)}</SelectContent></Select></label> : null}
                  </div>
                  <div className="flex flex-wrap items-end gap-2">
                    <Button type="button" variant="outline" disabled={!rescheduleDate || pending} onClick={() => void loadSlots(entry)}>Load times</Button>
                    {selectedSlot ? <Button type="button" disabled={pending} onClick={() => void runAction(entry.appointment_id, async (token) => {
                      await rescheduleReceptionAppointment(token, entry.appointment_id, selectedSlot);
                      setReschedulingId(null); setSlots([]);
                    })}>Confirm time</Button> : null}
                  </div>
                </div>
              ) : null}
            </article>
          );
        })}
      </div>
    </section>
  );
}
