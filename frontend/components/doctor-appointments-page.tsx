"use client";

import { useAuth } from "@clerk/nextjs";
import Link from "next/link";
import { CalendarClock, CheckCircle2, RefreshCw, CalendarPlus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { completeDoctorAppointment, doctorRescheduleAppointment, getDoctorSlots, ProfileApiError, type AvailabilitySlot, type PatientAppointment } from "@/lib/profile-api";
import { notifyError, notifySuccess } from "@/lib/notifications";
import { useAppointmentHistory } from "@/components/use-appointment-history";
import { AppointmentAvailabilityCalendar } from "@/components/appointment-availability-calendar";

function todayInIndia() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date()).map(({ type, value }) => [type, value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function monthRange(month: string) {
  const [year, monthNumber] = month.split("-").map(Number);
  return { from: `${month}-01`, to: new Date(Date.UTC(year, monthNumber, 0)).toISOString().slice(0, 10) };
}

function appointmentInstant(appointment: Pick<PatientAppointment, "date" | "end_time">) {
  const instant = new Date(`${appointment.date}T${appointment.end_time}+05:30`);
  return Number.isNaN(instant.getTime()) ? null : instant;
}

function patientAge(dateOfBirth: string | null | undefined, now: number) {
  if (!dateOfBirth) return null;
  const [year, month, day] = dateOfBirth.split("-").map(Number);
  if (!year || !month || !day) return null;
  const today = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(now)).map(({ type, value }) => [type, Number(value)]));
  if (year > today.year || year === today.year && (month > today.month || month === today.month && day > today.day)) return null;
  return today.year - year - (today.month < month || today.month === month && today.day < day ? 1 : 0);
}

function formatDate(date: string) {
  const [year, month, day] = date.split("-").map(Number);
  return new Intl.DateTimeFormat("en-IN", { dateStyle: "full", timeZone: "UTC" })
    .format(new Date(Date.UTC(year, month - 1, day)));
}

function formatTime(time: string) {
  const [hourText, minute] = time.split(":");
  const hour = Number(hourText);
  return `${hour % 12 || 12}:${minute} ${hour >= 12 ? "PM" : "AM"}`;
}

function statusClasses(status: PatientAppointment["status"]) {
  if (status === "confirmed") return "bg-status-confirmed-bg text-status-confirmed";
  if (status === "cancelled") return "bg-status-cancelled-bg text-status-cancelled";
  return "bg-status-completed-bg text-status-completed";
}

export function DoctorAppointmentsPage() {
  const { getToken } = useAuth();
  const { appointments, setAppointments, loading, error, history, retry, loadMore } = useAppointmentHistory();
  const [currentTime, setCurrentTime] = useState<number | null>(null);
  const [activeAppointment, setActiveAppointment] = useState<string | null>(null);
  const mutationLock = useRef(false);
  const [rescheduleId, setRescheduleId] = useState<string | null>(null);
  const [rescheduleSlots, setRescheduleSlots] = useState<AvailabilitySlot[]>([]);
  const [rescheduleSlotsLoading, setRescheduleSlotsLoading] = useState(false);
  const [rescheduleMonth, setRescheduleMonth] = useState(() => todayInIndia().slice(0, 7));
  const [rescheduleDate, setRescheduleDate] = useState(todayInIndia());
  const [selectedSlotId, setSelectedSlotId] = useState("");
  const [rescheduleError, setRescheduleError] = useState<string | null>(null);

  useEffect(() => {
    const initialTime = window.setTimeout(() => setCurrentTime(Date.now()), 0);
    const timer = window.setInterval(() => setCurrentTime(Date.now()), 30_000);
    return () => { window.clearTimeout(initialTime); window.clearInterval(timer); };
  }, []);

  const now = currentTime ?? 0;
  const scheduled = appointments.filter((appointment) => appointment.status === "confirmed" && (() => {
    const instant = appointmentInstant(appointment);
    return instant !== null && instant.getTime() > now;
  })()).sort((first, second) => (appointmentInstant(first)?.getTime() ?? 0) - (appointmentInstant(second)?.getTime() ?? 0));
  const past = appointments.filter((appointment) => appointment.status !== "cancelled" && (() => {
    const instant = appointmentInstant(appointment);
    return appointment.status === "completed" || instant !== null && instant.getTime() <= now;
  })()).sort((first, second) => (appointmentInstant(second)?.getTime() ?? 0) - (appointmentInstant(first)?.getTime() ?? 0));
  const cancelled = appointments.filter((appointment) => appointment.status === "cancelled")
    .sort((first, second) => (appointmentInstant(second)?.getTime() ?? 0) - (appointmentInstant(first)?.getTime() ?? 0));

  function refreshAppointments() {
    retry();
  }

  function monthSlots(slots: AvailabilitySlot[], appointment: PatientAppointment) {
    return slots.filter((slot) => slot.id !== appointment.availability_id
      && (slot.mode === "wave" || slot.mode === "stream")
      && (slot.remaining_capacity ?? 0) > 0);
  }

  async function loadRescheduleSlots(appointment: PatientAppointment, month: string) {
    setRescheduleSlotsLoading(true);
    setRescheduleError(null);
    try {
      const token = await getToken();
      if (!token) throw new Error("Your session could not be verified. Please sign in again.");
      const range = monthRange(month);
      const slots = await getDoctorSlots(token, appointment.doctor_id, range.from, range.to, appointment.id);
      setRescheduleSlots(monthSlots(slots, appointment));
    } catch (cause) {
      setRescheduleError(cause instanceof Error ? cause.message : "We couldn't load replacement times.");
    } finally { setRescheduleSlotsLoading(false); }
  }

  async function beginReschedule(appointment: PatientAppointment) {
    setRescheduleId(appointment.id);
    setSelectedSlotId("");
    const month = todayInIndia().slice(0, 7);
    setRescheduleMonth(month);
    setRescheduleDate(todayInIndia());
    await loadRescheduleSlots(appointment, month);
  }

  async function changeRescheduleMonth(appointment: PatientAppointment, month: string) {
    setRescheduleMonth(month);
    setRescheduleDate(`${month}-01`);
    setSelectedSlotId("");
    await loadRescheduleSlots(appointment, month);
  }

  async function markComplete(appointment: PatientAppointment) {
    if (mutationLock.current) return;
    mutationLock.current = true;
    setActiveAppointment(appointment.id);
    try {
      const token = await getToken();
      if (!token) throw new Error("Your session could not be verified. Please sign in again.");
      const updated = await completeDoctorAppointment(token, appointment.id);
      setAppointments((current) => current.map((item) => item.id === appointment.id ? updated : item));
      notifySuccess("Appointment marked as completed.", `doctor-complete-${appointment.id}`);
    } catch (cause) {
      const conflict = cause instanceof ProfileApiError && cause.status === 409;
      if (conflict) refreshAppointments();
      notifyError(
        conflict
          ? "This appointment is no longer confirmed. The appointment list is being refreshed."
          : cause instanceof Error ? cause.message : "We couldn't update this appointment. Please try again.",
        `doctor-complete-${appointment.id}`,
      );
    } finally {
      setActiveAppointment(null);
      mutationLock.current = false;
    }
  }

  async function reschedule(appointment: PatientAppointment) {
    if (!selectedSlotId || mutationLock.current) return;
    setRescheduleError(null);
    mutationLock.current = true;
    setActiveAppointment(appointment.id);
    try {
      const token = await getToken();
      if (!token) throw new Error("Your session could not be verified. Please sign in again.");
      const updated = await doctorRescheduleAppointment(token, appointment.id, { availability_id: selectedSlotId });
      setAppointments((current) => current.map((item) => item.id === appointment.id ? updated : item));
      setRescheduleId(null);
      setRescheduleSlots([]); setSelectedSlotId("");
      setRescheduleError(null);
      notifySuccess("Appointment rescheduled.", `doctor-reschedule-${appointment.id}`);
    } catch (cause) {
      if (cause instanceof ProfileApiError && cause.status === 409) {
        setRescheduleError(cause.message);
      } else {
        setRescheduleError(cause instanceof Error ? cause.message : "We couldn't reschedule this appointment.");
      }
    } finally { setActiveAppointment(null); mutationLock.current = false; }
  }

  return (
    <div className="mx-auto max-w-5xl space-y-8">
      <header>
        <p className="text-sm font-semibold uppercase tracking-[0.14em] text-primary">Doctor workspace</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">My appointments</h1>
        <p className="mt-3 max-w-2xl text-base leading-7 text-muted-foreground">Review your scheduled and past appointments.</p>
      </header>

      {loading ? <p className="rounded-2xl bg-muted p-6 text-sm text-muted-foreground" role="status">Loading your appointments…</p> : null}
      {!loading && error ? (
        <section className="rounded-2xl border border-destructive/40 bg-destructive/5 p-6" role="alert">
          <p className="text-sm text-foreground">{error}</p>
          <button type="button" onClick={refreshAppointments} className="mt-4 inline-flex min-h-10 items-center gap-2 rounded-lg border border-border px-4 text-sm font-medium text-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"><RefreshCw aria-hidden="true" className="size-4" /> Try again</button>
        </section>
      ) : null}

      {!loading && !error ? (
        <>
          <AppointmentGroup title="Scheduled appointments" empty="You have no scheduled appointments." appointments={scheduled} now={now} onComplete={markComplete} activeAppointment={activeAppointment} rescheduleId={rescheduleId} rescheduleSlots={rescheduleSlots} rescheduleSlotsLoading={rescheduleSlotsLoading} rescheduleMonth={rescheduleMonth} rescheduleDate={rescheduleDate} selectedSlotId={selectedSlotId} rescheduleError={rescheduleError} onBeginReschedule={beginReschedule} onSelectDate={(date) => { setRescheduleDate(date); setSelectedSlotId(""); }} onShiftMonth={changeRescheduleMonth} onSelectSlot={setSelectedSlotId} onCloseReschedule={() => { setRescheduleId(null); setRescheduleError(null); }} onReschedule={reschedule} />
          <AppointmentGroup title="Past appointments" empty="Your past appointments will appear here." appointments={past} now={now} hasMore={history.past.hasMore} loadingMore={history.past.loading} moreError={history.past.error} onShowMore={() => void loadMore("past")} onComplete={markComplete} activeAppointment={activeAppointment} rescheduleId={rescheduleId} rescheduleSlots={rescheduleSlots} rescheduleSlotsLoading={rescheduleSlotsLoading} rescheduleMonth={rescheduleMonth} rescheduleDate={rescheduleDate} selectedSlotId={selectedSlotId} rescheduleError={rescheduleError} onBeginReschedule={beginReschedule} onSelectDate={(date) => { setRescheduleDate(date); setSelectedSlotId(""); }} onShiftMonth={changeRescheduleMonth} onSelectSlot={setSelectedSlotId} onCloseReschedule={() => { setRescheduleId(null); setRescheduleError(null); }} onReschedule={reschedule} />
          <AppointmentGroup title="Cancelled appointments" empty="You have no cancelled appointments." appointments={cancelled} now={now} hasMore={history.cancelled.hasMore} loadingMore={history.cancelled.loading} moreError={history.cancelled.error} onShowMore={() => void loadMore("cancelled")} onComplete={markComplete} activeAppointment={activeAppointment} rescheduleId={rescheduleId} rescheduleSlots={rescheduleSlots} rescheduleSlotsLoading={rescheduleSlotsLoading} rescheduleMonth={rescheduleMonth} rescheduleDate={rescheduleDate} selectedSlotId={selectedSlotId} rescheduleError={rescheduleError} onBeginReschedule={beginReschedule} onSelectDate={(date) => { setRescheduleDate(date); setSelectedSlotId(""); }} onShiftMonth={changeRescheduleMonth} onSelectSlot={setSelectedSlotId} onCloseReschedule={() => { setRescheduleId(null); setRescheduleError(null); }} onReschedule={reschedule} />
        </>
      ) : null}
    </div>
  );
}

function AppointmentGroup({ title, empty, appointments, now, hasMore = false, loadingMore = false, moreError = null, onShowMore, onComplete, activeAppointment, rescheduleId, rescheduleSlots, rescheduleSlotsLoading, rescheduleMonth, rescheduleDate, selectedSlotId, rescheduleError, onBeginReschedule, onSelectDate, onShiftMonth, onSelectSlot, onCloseReschedule, onReschedule }: {
  title: string;
  empty: string;
  appointments: PatientAppointment[];
  now: number;
  hasMore?: boolean;
  loadingMore?: boolean;
  moreError?: string | null;
  onShowMore?: () => void;
  onComplete: (appointment: PatientAppointment) => void;
  activeAppointment: string | null;
  rescheduleId: string | null;
  rescheduleSlots: AvailabilitySlot[];
  rescheduleSlotsLoading: boolean;
  rescheduleMonth: string;
  rescheduleDate: string;
  selectedSlotId: string;
  rescheduleError: string | null;
  onBeginReschedule: (appointment: PatientAppointment) => void;
  onSelectDate: (date: string) => void;
  onShiftMonth: (appointment: PatientAppointment, month: string) => void;
  onSelectSlot: (slotId: string) => void;
  onCloseReschedule: () => void;
  onReschedule: (appointment: PatientAppointment) => void;
}) {
  return (
    <section aria-label={title}>
      <h2 className="text-xl font-semibold text-foreground">{title}</h2>
      {appointments.length === 0 ? <p className="mt-4 rounded-xl bg-muted p-5 text-sm text-muted-foreground">{empty}</p> : (
        <ul className="mt-4 space-y-4">
          {appointments.map((appointment) => (
            (() => {
            const dateSlots = rescheduleSlots.filter((slot) => slot.date === rescheduleDate);
            return (
            <li key={appointment.id} className="rounded-2xl border border-border bg-card p-5 shadow-sm sm:p-6">
              <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
                <div>
                  <p className="font-semibold text-card-foreground"><Link href={`/doctor/patients/${encodeURIComponent(appointment.patient_id)}`} aria-label={`View details for ${appointment.patient_first_name} ${appointment.patient_last_name}`} className="rounded-sm underline-offset-4 hover:text-primary hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">{appointment.patient_first_name} {appointment.patient_last_name}</Link></p>
                  <p className="mt-1 text-sm text-muted-foreground">{[
                    patientAge(appointment.patient_date_of_birth, now) !== null ? `Age ${patientAge(appointment.patient_date_of_birth, now)}` : null,
                    appointment.patient_gender,
                  ].filter(Boolean).join(" · ") || "No patient details provided"}</p>
                  <div className="mt-4 flex items-start gap-2 text-sm text-foreground">
                    <CalendarClock aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                    <span>{formatDate(appointment.date)} · {formatTime(appointment.start_time)}–{formatTime(appointment.end_time)} IST</span>
                  </div>
                  {appointment.mode ? <p className="mt-2 text-sm text-muted-foreground">{appointment.mode === "wave" ? (appointment.appointment_duration_minutes ? `Wave · ${appointment.appointment_duration_minutes}-minute slot` : "Wave") : "Stream · Continuous window"}</p> : null}
                  {appointment.reason ? <p className="mt-3 text-sm leading-6 text-muted-foreground"><span className="font-medium text-foreground">Reason:</span> {appointment.reason}</p> : null}
                  {/* <p className="mt-2 text-xs text-muted-foreground">Appointment ID: {appointment.id}</p> */}
                </div>
                <span className={`inline-flex w-fit rounded-full px-3 py-1 text-xs font-semibold ${statusClasses(appointment.status)}`}>{appointment.status === "confirmed" && (appointmentInstant(appointment)?.getTime() ?? Infinity) <= now ? "Awaiting completion" : appointment.status}</span>
              </div>
            {appointment.status === "confirmed" ? (
              <div className="mt-5 border-t border-border pt-4">
                <div className="flex flex-wrap items-center gap-2.5">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={activeAppointment !== null}
                    onClick={() => { if (rescheduleId === appointment.id) onCloseReschedule(); else onBeginReschedule(appointment); }}
                  >
                    <CalendarPlus aria-hidden="true" className="size-4" />
                    Reschedule
                  </Button>

                  <Button
                    type="button"
                    size="sm"
                    disabled={activeAppointment !== null}
                    onClick={() => onComplete(appointment)}
                    hidden={(appointmentInstant(appointment)?.getTime() ?? Infinity) > now}
                  >
                    <CheckCircle2 aria-hidden="true" className="size-4" />
                    {activeAppointment === appointment.id
                      ? "Updating…"
                      : "Mark as completed"}
                  </Button>
                </div>

                {rescheduleId === appointment.id ? (
                  <div className="mt-3 rounded-xl border border-border bg-background p-4" aria-label="Choose a replacement appointment time">
                    <div className="flex items-center justify-between gap-3"><h3 className="font-semibold text-foreground">Choose a new time</h3><button type="button" onClick={onCloseReschedule} className="rounded px-2 py-1 text-sm text-muted-foreground hover:bg-muted">Close</button></div>
                    <p className="mt-1 text-xs text-muted-foreground">Choose an available date, then select a time · IST</p>
                    {rescheduleSlotsLoading ? <p className="mt-4 text-sm text-muted-foreground" role="status">Loading available times…</p> : null}
                    {!rescheduleSlotsLoading && rescheduleError ? <div className="mt-4 rounded-lg bg-destructive/5 p-3" role="alert"><p className="text-sm text-destructive">{rescheduleError}</p><button type="button" onClick={() => onBeginReschedule(appointment)} className="mt-3 inline-flex min-h-9 items-center gap-2 rounded-lg border border-border px-3 text-sm font-medium text-foreground hover:bg-muted">Refresh available times</button></div> : null}
                    {!rescheduleSlotsLoading && !rescheduleError && rescheduleSlots.length === 0 ? <p className="mt-4 text-sm text-muted-foreground">No replacement times are available for this doctor.</p> : null}
                    {!rescheduleSlotsLoading && !rescheduleError ? <AppointmentAvailabilityCalendar slots={rescheduleSlots} month={rescheduleMonth} selectedDate={rescheduleDate} onSelectDate={onSelectDate} onShiftMonth={(month) => onShiftMonth(appointment, month)} /> : null}
                    {!rescheduleSlotsLoading && !rescheduleError && dateSlots.length > 0 ? <fieldset className="mt-4 grid gap-2 sm:grid-cols-2"><legend className="sr-only">Available replacement times</legend>{dateSlots.map((slot) => <label key={slot.id} className={`flex cursor-pointer items-center gap-3 rounded-lg border p-3 text-sm ${selectedSlotId === slot.id ? "border-primary bg-secondary/60" : "border-border hover:bg-muted/60"}`}><input type="radio" name={`doctor-reschedule-${appointment.id}`} value={slot.id} checked={selectedSlotId === slot.id} onChange={() => onSelectSlot(slot.id)} className="size-4 accent-primary" /><span><span className="block font-medium text-foreground">{slot.mode === "stream" ? "Stream · Continuous window" : appointment.appointment_duration_minutes ? `Wave · ${appointment.appointment_duration_minutes}-minute slot` : "Wave"}</span><span className="text-muted-foreground">{formatTime(slot.start_time)}–{formatTime(slot.end_time)} IST</span><span className="mt-1 block text-xs text-muted-foreground">{slot.remaining_capacity ?? 0} of {slot.capacity ?? 0} places remaining</span></span></label>)}</fieldset> : null}
                    <Button type="button" size="sm" disabled={!selectedSlotId || activeAppointment !== null || rescheduleSlotsLoading} onClick={() => onReschedule(appointment)} className="mt-4">{activeAppointment === appointment.id ? "Updating…" : "Save new time"}</Button>
                  </div>
                ) : null}
              </div>
            ) : null}
            </li>
            );
            })()
          ))}
        </ul>
      )}
      {moreError ? <p className="mt-3 text-sm text-destructive" role="alert">{moreError}</p> : null}
      {hasMore ? <div className="mt-4 flex justify-center"><button type="button" onClick={onShowMore} disabled={loadingMore} className="inline-flex min-h-11 items-center justify-center rounded-lg border border-border bg-card px-5 text-sm font-semibold text-foreground transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-wait disabled:opacity-60">{loadingMore ? "Loading…" : moreError ? "Try again" : "Show More"}</button></div> : null}
    </section>
  );
}
