"use client";

import { useAuth } from "@clerk/nextjs";
import { CalendarClock, CheckCircle2, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { completeDoctorAppointment, getAppointments, ProfileApiError, type PatientAppointment } from "@/lib/profile-api";
import { notifyError, notifySuccess } from "@/lib/notifications";

function appointmentInstant(appointment: Pick<PatientAppointment, "date" | "start_time">) {
  const instant = new Date(`${appointment.date}T${appointment.start_time}+05:30`);
  return Number.isNaN(instant.getTime()) ? null : instant;
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
  const [appointments, setAppointments] = useState<PatientAppointment[]>([]);
  const [currentTime, setCurrentTime] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [activeAppointment, setActiveAppointment] = useState<string | null>(null);
  const mutationLock = useRef(false);

  useEffect(() => {
    let active = true;
    void getToken()
      .then((token) => {
        if (!token) throw new Error("Your session could not be verified. Please try again.");
        return getAppointments(token);
      })
      .then((result) => {
        if (active) {
          setAppointments(result);
          setCurrentTime(Date.now());
        }
      })
      .catch((cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : "We couldn't load your appointments.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [getToken, refreshKey]);

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
    setLoading(true);
    setError(null);
    setRefreshKey((key) => key + 1);
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
          <AppointmentGroup title="Scheduled appointments" empty="You have no scheduled appointments." appointments={scheduled} onComplete={markComplete} activeAppointment={activeAppointment} />
          <AppointmentGroup title="Past appointments" empty="Your past appointments will appear here." appointments={past} onComplete={markComplete} activeAppointment={activeAppointment} />
          <AppointmentGroup title="Cancelled appointments" empty="You have no cancelled appointments." appointments={cancelled} onComplete={markComplete} activeAppointment={activeAppointment} />
        </>
      ) : null}
    </div>
  );
}

function AppointmentGroup({ title, empty, appointments, onComplete, activeAppointment }: {
  title: string;
  empty: string;
  appointments: PatientAppointment[];
  onComplete: (appointment: PatientAppointment) => void;
  activeAppointment: string | null;
}) {
  return (
    <section aria-label={title}>
      <h2 className="text-xl font-semibold text-foreground">{title}</h2>
      {appointments.length === 0 ? <p className="mt-4 rounded-xl bg-muted p-5 text-sm text-muted-foreground">{empty}</p> : (
        <ul className="mt-4 space-y-4">
          {appointments.map((appointment) => (
            <li key={appointment.id} className="rounded-2xl border border-border bg-card p-5 shadow-sm sm:p-6">
              <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
                <div>
                  <p className="font-semibold text-card-foreground">{appointment.patient_first_name} {appointment.patient_last_name}</p>
                  <div className="mt-4 flex items-start gap-2 text-sm text-foreground">
                    <CalendarClock aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                    <span>{formatDate(appointment.date)} · {formatTime(appointment.start_time)}–{formatTime(appointment.end_time)} IST</span>
                  </div>
                  {appointment.reason ? <p className="mt-3 text-sm leading-6 text-muted-foreground"><span className="font-medium text-foreground">Reason:</span> {appointment.reason}</p> : null}
                  <p className="mt-2 text-xs text-muted-foreground">Appointment ID: {appointment.id}</p>
                </div>
                <span className={`inline-flex w-fit rounded-full px-3 py-1 text-xs font-semibold capitalize ${statusClasses(appointment.status)}`}>{appointment.status}</span>
              </div>
              {appointment.status === "confirmed" ? (
                <div className="mt-5 border-t border-border pt-4">
                  <Button type="button" size="sm" disabled={activeAppointment !== null} onClick={() => onComplete(appointment)}>
                    <CheckCircle2 aria-hidden="true" className="size-4" />
                    {activeAppointment === appointment.id ? "Updating…" : "Mark as completed"}
                  </Button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
