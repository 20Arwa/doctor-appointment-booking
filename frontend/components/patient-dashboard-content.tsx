"use client";

import { useAuth } from "@clerk/nextjs";
import { CalendarCheck2, CalendarClock, CalendarDays, CalendarPlus, Clock3, History, RefreshCw, XCircle } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { getAppointments, type PatientAppointment } from "@/lib/profile-api";
import { formatInstantDate } from "@/lib/date-format";

const APPLICATION_TIME_ZONE = "Asia/Kolkata";

function appointmentStart(appointment: PatientAppointment) {
  const instant = new Date(`${appointment.date}T${appointment.start_time}+05:30`);
  return Number.isNaN(instant.getTime()) ? null : instant;
}

function appointmentEnd(appointment: PatientAppointment) {
  const instant = new Date(`${appointment.date}T${appointment.end_time}+05:30`);
  return Number.isNaN(instant.getTime()) ? null : instant;
}

function isUpcoming(appointment: PatientAppointment, now: number) {
  const end = appointmentEnd(appointment);
  return appointment.status === "confirmed" && end !== null && end.getTime() > now;
}

function isPast(appointment: PatientAppointment, now: number) {
  if (appointment.status === "completed") return true;
  const end = appointment.status === "confirmed" ? appointmentEnd(appointment) : null;
  return end !== null && end.getTime() <= now;
}

function getCounts(appointments: PatientAppointment[], now: number) {
  return {
    upcoming: appointments.filter((appointment) => isUpcoming(appointment, now)).length,
    past: appointments.filter((appointment) => isPast(appointment, now)).length,
    cancelled: appointments.filter((appointment) => appointment.status === "cancelled").length,
  };
}

function formatAppointmentDate(instant: Date) {
  return formatInstantDate(instant, APPLICATION_TIME_ZONE);
}

function formatAppointmentTime(instant: Date) {
  return new Intl.DateTimeFormat("en-IN", { hour: "numeric", minute: "2-digit", timeZone: APPLICATION_TIME_ZONE }).format(instant);
}

function appointmentStatusClass(status: PatientAppointment["status"]) {
  if (status === "confirmed") return "bg-status-confirmed-bg text-status-confirmed";
  if (status === "cancelled") return "bg-status-cancelled-bg text-status-cancelled";
  return "bg-status-completed-bg text-status-completed";
}

export function PatientDashboardContent() {
  const { getToken } = useAuth();
  const [appointments, setAppointments] = useState<PatientAppointment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState(0);
  const [now, setNow] = useState<number | null>(null);

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
          setNow(Date.now());
        }
      })
      .catch((cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : "We couldn't load your appointments. Please try again.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [getToken, retryKey]);

  const upcoming = useMemo(() => now === null ? [] : appointments
    .filter((appointment) => appointment.status === "confirmed")
    .map((appointment) => ({ appointment, instant: appointmentStart(appointment), end: appointmentEnd(appointment) }))
    .filter((entry): entry is { appointment: PatientAppointment; instant: Date; end: Date } => entry.instant !== null && entry.end !== null && entry.end.getTime() > now && entry.instant.getTime() > now)
    .sort((first, second) => first.instant.getTime() - second.instant.getTime()), [appointments, now]);
  const next = upcoming[0] ?? null;
  const counts = now === null ? null : getCounts(appointments, now);

  return (
    <div className="space-y-6">
      <section aria-labelledby="patient-overview-title">
        <div className="mb-3 flex items-end justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-primary">Your care at a glance</p>
            <h2 id="patient-overview-title" className="mt-1 text-lg font-semibold tracking-tight text-foreground">Quick overview</h2>
          </div>
          <Link href="/patient/appointments" className="text-sm font-semibold text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring">View appointments</Link>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <OverviewCard label="Upcoming" count={counts?.upcoming} loading={loading} error={Boolean(error)} icon={CalendarClock} tone="confirmed" />
          <OverviewCard label="Past" count={counts?.past} loading={loading} error={Boolean(error)} icon={History} tone="completed" />
          <OverviewCard label="Cancelled" count={counts?.cancelled} loading={loading} error={Boolean(error)} icon={XCircle} tone="cancelled" />
        </div>
      </section>

      <section aria-labelledby="next-appointment-title" aria-live="polite" className="overflow-hidden rounded-3xl border border-primary/20 bg-card shadow-md shadow-primary/5">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-secondary/35 px-5 py-4 sm:px-7">
          <div className="flex items-center gap-3">
            <span className="flex size-10 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-sm"><CalendarCheck2 aria-hidden="true" className="size-5" /></span>
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.13em] text-primary">Your schedule</p>
              <h2 id="next-appointment-title" className="text-lg font-semibold text-card-foreground sm:text-xl">Next upcoming appointment</h2>
            </div>
          </div>
        </div>

        {loading ? <div className="p-6 text-sm text-muted-foreground" role="status">Loading your appointment…</div> : null}
        {!loading && error ? (
          <div className="flex flex-col gap-4 p-6 sm:flex-row sm:items-center sm:justify-between" role="alert">
            <p className="text-sm text-foreground">{error}</p>
            <button type="button" onClick={() => { setLoading(true); setError(null); setNow(null); setRetryKey((key) => key + 1); }} className="inline-flex min-h-10 shrink-0 items-center gap-2 rounded-lg border border-border px-3 text-sm font-medium text-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"><RefreshCw aria-hidden="true" className="size-4" />Try again</button>
          </div>
        ) : null}
        {!loading && !error && next ? (
          <div className="grid gap-5 p-5 sm:grid-cols-[1fr_auto] sm:items-center sm:p-7">
            <div>
              <p className="text-2xl font-semibold tracking-tight text-foreground">Dr. {next.appointment.doctor_first_name} {next.appointment.doctor_last_name}</p>
              <p className="mt-1 text-base font-medium text-primary">{next.appointment.specialty}</p>
              <span className={`mt-3 inline-flex rounded-full px-3 py-1 text-xs font-semibold ${appointmentStatusClass(next.appointment.status)}`}>Confirmed</span>
              <div className="mt-5 flex flex-wrap gap-x-6 gap-y-3 text-sm text-muted-foreground">
                <span className="inline-flex items-center gap-2"><CalendarDays aria-hidden="true" className="size-4 text-primary" />{formatAppointmentDate(next.instant)}</span>
                <span className="inline-flex items-center gap-2"><Clock3 aria-hidden="true" className="size-4 text-primary" />{formatAppointmentTime(next.instant)} IST</span>
              </div>
            </div>
            <Link href="/patient/appointments" className="inline-flex min-h-10 items-center justify-center rounded-lg border border-border px-4 text-sm font-semibold text-foreground transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">Manage appointment</Link>
          </div>
        ) : null}
        {!loading && !error && !next ? (
          <div className="flex flex-col items-start gap-5 p-6 sm:flex-row sm:items-center sm:justify-between sm:p-7">
            <div className="flex items-start gap-4">
              <span className="flex size-12 shrink-0 items-center justify-center rounded-2xl bg-secondary text-secondary-foreground"><CalendarPlus aria-hidden="true" className="size-6" /></span>
              <div><h3 className="font-semibold text-card-foreground">No upcoming appointments</h3><p className="mt-1 max-w-lg text-sm leading-6 text-muted-foreground">When you’re ready, browse doctors and choose a time that works for you.</p></div>
            </div>
            <Link href="/patient/book-appointment" className="inline-flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"><CalendarPlus aria-hidden="true" className="size-4" />Book appointment</Link>
          </div>
        ) : null}
      </section>

      {next ? <Link href="/patient/book-appointment" className="group flex flex-col gap-4 rounded-2xl border border-border bg-primary/5 p-4 transition-colors hover:border-primary/40 hover:bg-primary/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring sm:flex-row sm:items-center sm:justify-between sm:px-5">
        <span className="flex items-center gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-secondary text-secondary-foreground"><CalendarPlus aria-hidden="true" className="size-5" /></span>
          <span><span className="block font-semibold text-card-foreground">Find your next appointment</span><span className="mt-0.5 block text-sm text-muted-foreground">Browse doctors and available times.</span></span>
        </span>
        <span className="inline-flex min-h-10 items-center justify-center rounded-lg bg-primary px-4 text-sm font-semibold text-primary-foreground transition-colors group-hover:bg-primary/90">Book appointment</span>
      </Link> : null}
    </div>
  );
}

function OverviewCard({ label, count, loading, error, icon: Icon, tone }: {
  label: string;
  count?: number;
  loading: boolean;
  error: boolean;
  icon: typeof CalendarDays;
  tone: "confirmed" | "completed" | "cancelled";
}) {
  const toneClasses = {
    confirmed: "bg-status-confirmed-bg text-status-confirmed",
    completed: "bg-status-completed-bg text-status-completed",
    cancelled: "bg-status-cancelled-bg text-status-cancelled",
  }[tone];
  return (
    <div className="flex items-center justify-between rounded-2xl border border-border bg-card px-4 py-3 shadow-sm sm:px-5">
      <div><p className="text-sm font-medium text-muted-foreground">{label}</p><p className="mt-1 text-2xl font-semibold tabular-nums tracking-tight text-card-foreground">{loading ? "…" : error ? "—" : count ?? 0}</p></div>
      <span className={`flex size-10 items-center justify-center rounded-xl ${toneClasses}`}><Icon aria-hidden="true" className="size-5" /></span>
    </div>
  );
}
