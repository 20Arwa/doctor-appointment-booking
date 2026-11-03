"use client";

import { useAuth } from "@clerk/nextjs";
import { CalendarCheck2, CalendarDays, CalendarRange, Clock3, ReceiptText, RefreshCw, UserRound, UsersRound } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useDashboardProfile } from "@/components/role-application-shell";
import { PatientDashboardContent } from "@/components/patient-dashboard-content";
import { getAppointments, type PatientAppointment } from "@/lib/profile-api";

const APPLICATION_TIME_ZONE = "Asia/Kolkata";

function appointmentStart(appointment: Pick<PatientAppointment, "date" | "start_time">) {
  const value = new Date(`${appointment.date}T${appointment.start_time}+05:30`);
  return Number.isNaN(value.getTime()) ? null : value;
}

function applicationDate(value: Date) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: APPLICATION_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(value);
  const values = Object.fromEntries(parts.map(({ type, value: part }) => [type, part]));
  return `${values.year}-${values.month}-${values.day}`;
}

function formatDate(value: Date) {
  return new Intl.DateTimeFormat("en-IN", { dateStyle: "full", timeZone: APPLICATION_TIME_ZONE }).format(value);
}

function formatTime(value: Date) {
  return new Intl.DateTimeFormat("en-IN", { hour: "numeric", minute: "2-digit", timeZone: APPLICATION_TIME_ZONE }).format(value);
}

function appointmentLabel(appointment: PatientAppointment) {
  const instant = appointmentStart(appointment);
  return instant ? `${formatDate(instant)} · ${formatTime(instant)} IST` : "Time unavailable";
}

function appointmentStatusClass(status: PatientAppointment["status"]) {
  if (status === "confirmed") return "bg-status-confirmed-bg text-status-confirmed";
  if (status === "cancelled") return "bg-status-cancelled-bg text-status-cancelled";
  return "bg-status-completed-bg text-status-completed";
}

export function PatientDashboardPage() {
  const profile = useDashboardProfile();
  const name = `${profile.first_name} ${profile.last_name}`.trim();

  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-3 border-b border-border pb-5 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-primary">Patient dashboard</p>
          <h1 className="mt-1.5 text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">Welcome back, {name}</h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground sm:text-base">Your appointments and care details, together in one place.</p>
        </div>
        <span className="inline-flex w-fit items-center gap-2 rounded-full border border-primary/15 bg-primary/5 px-3 py-1.5 text-xs font-medium text-primary"><CalendarCheck2 aria-hidden="true" className="size-4" />Patient workspace</span>
      </header>

      <PatientDashboardContent />

      <section aria-labelledby="patient-shortcuts-title">
        <div className="flex items-end justify-between gap-3">
          <div><p className="text-xs font-semibold uppercase tracking-[0.14em] text-primary">Shortcuts</p><h2 id="patient-shortcuts-title" className="mt-1 text-lg font-semibold text-foreground">Your workspace</h2></div>
        </div>
        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          <ShortcutCard href="/patient/appointments" title="My Appointments" description="View and manage your visits." icon={CalendarDays} />
          <ShortcutCard href="/patient/payments" title="Payment History" description="Review appointment payments." icon={ReceiptText} />
          <ShortcutCard href="/patient/profile" title="Profile" description="Update your profile details." icon={UserRound} />
        </div>
      </section>
    </div>
  );
}

export function DoctorDashboardPage() {
  const profile = useDashboardProfile();
  const { getToken } = useAuth();
  const [appointments, setAppointments] = useState<PatientAppointment[]>([]);
  const [currentTime, setCurrentTime] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState(0);
  const name = `${profile.first_name} ${profile.last_name}`.trim();

  useEffect(() => {
    let active = true;
    void getToken().then((token) => {
      if (!token) throw new Error("Your session could not be verified. Please try again.");
      return getAppointments(token);
    }).then((result) => {
      if (active) {
        setAppointments(result);
        setCurrentTime(Date.now());
      }
    }).catch((cause: unknown) => {
      if (active) setError(cause instanceof Error ? cause.message : "We couldn't load your appointments.");
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [getToken, retryKey]);

  useEffect(() => {
    const initialTime = window.setTimeout(() => setCurrentTime(Date.now()), 0);
    const interval = window.setInterval(() => setCurrentTime(Date.now()), 30_000);
    return () => { window.clearTimeout(initialTime); window.clearInterval(interval); };
  }, []);

  const now = currentTime ?? 0;
  const today = currentTime === null ? null : applicationDate(new Date(currentTime));
  const currentDateLabel = currentTime === null ? "Today · India Standard Time" : `${formatDate(new Date(currentTime))}`;
  const upcoming = useMemo(() => appointments.filter((appointment) => {
    const instant = appointmentStart(appointment);
    return appointment.status === "confirmed" && instant !== null && instant.getTime() > now;
  }).sort((first, second) => (appointmentStart(first)?.getTime() ?? 0) - (appointmentStart(second)?.getTime() ?? 0)), [appointments, now]);
  const todaysAppointments = useMemo(() => appointments
    .filter((appointment) => appointment.date === today && appointment.status !== "cancelled")
    .sort((first, second) => (appointmentStart(first)?.getTime() ?? 0) - (appointmentStart(second)?.getTime() ?? 0)), [appointments, today]);
  const nextAppointment = upcoming[0] ?? null;

  function retry() {
    setAppointments([]);
    setError(null);
    setLoading(true);
    setCurrentTime(null);
    setRetryKey((key) => key + 1);
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-4 border-b border-border pb-5 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-primary">Doctor dashboard</p>
          <h1 className="mt-1.5 text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">Welcome back, {name}</h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground sm:text-base">Your daily schedule and appointment actions at a glance.</p>
        </div>
        <div className="inline-flex w-fit items-center gap-3 rounded-xl border border-primary/15 bg-primary/5 px-4 py-3">
          <span className="flex size-9 items-center justify-center rounded-lg bg-secondary text-secondary-foreground"><CalendarDays aria-hidden="true" className="size-5" /></span>
          <span><span className="block text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Today</span><span className="block text-sm font-semibold text-foreground">{currentDateLabel}</span></span>
        </div>
      </header>

      {error ? <div className="flex flex-col gap-3 rounded-xl border border-destructive/40 bg-destructive/5 p-4 sm:flex-row sm:items-center sm:justify-between" role="alert"><p className="text-sm text-foreground">{error}</p><button type="button" onClick={retry} className="inline-flex min-h-10 w-fit items-center gap-2 rounded-lg border border-border px-3 text-sm font-medium text-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"><RefreshCw aria-hidden="true" className="size-4" />Try again</button></div> : null}

      <section aria-labelledby="doctor-next-title" className="overflow-hidden rounded-3xl border border-primary/25 bg-card shadow-md shadow-primary/5">
        <div className="flex items-center gap-3 border-b border-border bg-secondary/35 px-5 py-4 sm:px-7">
          <span className="flex size-11 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-sm"><Clock3 aria-hidden="true" className="size-5" /></span>
          <div><p className="text-xs font-semibold uppercase tracking-[0.13em] text-primary">Coming up</p><h2 id="doctor-next-title" className="text-lg font-semibold text-card-foreground sm:text-xl">Next appointment</h2></div>
        </div>
        {loading ? <p className="p-6 text-sm text-muted-foreground" role="status">Loading your schedule…</p> : null}
        {!loading && !error && nextAppointment ? (
          <div className="grid gap-5 p-5 sm:grid-cols-[1fr_auto] sm:items-center sm:p-7">
            <div>
              <p className="text-2xl font-semibold tracking-tight text-foreground">{nextAppointment.patient_first_name} {nextAppointment.patient_last_name}</p>
              <p className="mt-1 text-sm font-medium text-primary">{nextAppointment.specialty}</p>
              <div className="mt-4 flex flex-wrap gap-x-6 gap-y-3 text-sm text-muted-foreground">
                <span className="inline-flex items-center gap-2"><CalendarDays aria-hidden="true" className="size-4 text-primary" />{appointmentStart(nextAppointment) ? formatDate(appointmentStart(nextAppointment)!) : "Date unavailable"}</span>
                <span className="inline-flex items-center gap-2"><Clock3 aria-hidden="true" className="size-4 text-primary" />{appointmentStart(nextAppointment) ? formatTime(appointmentStart(nextAppointment)!) : "Time unavailable"} IST</span>
              </div>
              {nextAppointment.reason ? <p className="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground"><span className="font-medium text-foreground">Reason for visit:</span> {nextAppointment.reason}</p> : null}
              <span className={`mt-4 inline-flex rounded-full px-3 py-1 text-xs font-semibold ${appointmentStatusClass(nextAppointment.status)}`}>Confirmed</span>
            </div>
            <Link href="/doctor/appointments" className="inline-flex min-h-11 items-center justify-center rounded-lg bg-primary px-5 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">Manage appointments</Link>
          </div>
        ) : null}
        {!loading && !error && !nextAppointment ? <div className="flex flex-col items-start gap-4 p-6 sm:flex-row sm:items-center sm:justify-between sm:p-7"><div className="flex items-start gap-4"><span className="flex size-12 shrink-0 items-center justify-center rounded-2xl bg-secondary text-secondary-foreground"><CalendarRange aria-hidden="true" className="size-6" /></span><div><h3 className="font-semibold text-card-foreground">No upcoming appointments</h3><p className="mt-1 text-sm leading-6 text-muted-foreground">Your next confirmed appointment will appear here.</p></div></div><Link href="/doctor/availability" className="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border border-border px-4 text-sm font-semibold text-foreground transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"><CalendarRange aria-hidden="true" className="size-4" />Manage availability</Link></div> : null}
      </section>

      <div className="grid gap-4 lg:grid-cols-[1.4fr_0.6fr]">
        <section aria-labelledby="doctor-today-title" className="rounded-2xl border border-border bg-card p-5 shadow-sm sm:p-6">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-4">
            <div className="flex items-center gap-3"><span className="flex size-10 items-center justify-center rounded-xl bg-secondary text-secondary-foreground"><UsersRound aria-hidden="true" className="size-5" /></span><h2 id="doctor-today-title" className="text-lg font-semibold text-card-foreground">Today’s appointments</h2></div>
            <span className="rounded-full bg-primary/10 px-3 py-1 text-sm font-semibold tabular-nums text-primary">{loading || error ? "—" : todaysAppointments.length}</span>
          </div>
          {loading ? <p className="mt-4 text-sm text-muted-foreground" role="status">Loading today’s schedule…</p> : null}
          {!loading && !error && todaysAppointments.length === 0 ? <div className="mt-4 flex items-start gap-3 rounded-xl bg-muted/70 p-4"><CalendarCheck2 aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-primary" /><div><p className="text-sm font-semibold text-card-foreground">No appointments scheduled today</p><p className="mt-1 text-sm leading-6 text-muted-foreground">Your schedule is clear for today. You can update your available times whenever you’re ready.</p><Link href="/doctor/availability" className="mt-2 inline-flex text-sm font-semibold text-primary underline-offset-4 hover:underline">Manage availability</Link></div></div> : null}
          {!loading && !error && todaysAppointments.length > 0 ? <ul className="divide-y divide-border">{todaysAppointments.map((appointment) => <li key={appointment.id} className="flex flex-wrap items-center justify-between gap-3 py-3.5"><div><p className="font-semibold text-card-foreground">{appointment.patient_first_name} {appointment.patient_last_name}</p><p className="mt-1 text-sm text-muted-foreground">{appointmentLabel(appointment)}</p></div><span className={`rounded-full px-3 py-1 text-xs font-semibold capitalize ${appointmentStatusClass(appointment.status)}`}>{appointment.status}</span></li>)}</ul> : null}
        </section>

        <section aria-labelledby="doctor-upcoming-title" className="flex flex-col rounded-2xl border border-primary/15 bg-primary/5 p-5 shadow-sm sm:p-6">
          <div className="flex items-center gap-3"><span className="flex size-10 items-center justify-center rounded-xl bg-primary text-primary-foreground"><CalendarDays aria-hidden="true" className="size-5" /></span><div><p className="text-xs font-semibold uppercase tracking-wide text-primary">Confirmed</p><h2 id="doctor-upcoming-title" className="font-semibold text-card-foreground">Upcoming appointments</h2></div></div>
          <p className="mt-5 text-4xl font-semibold tabular-nums tracking-tight text-foreground">{loading || error ? "—" : upcoming.length}</p>
          <p className="mt-1 text-sm text-muted-foreground">{loading ? "Loading schedule…" : error ? "Schedule unavailable" : upcoming.length === 1 ? "confirmed visit ahead" : "confirmed visits ahead"}</p>
          <Link href="/doctor/appointments" className="mt-auto inline-flex min-h-10 items-center gap-1 pt-5 text-sm font-semibold text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring">View appointment list <span aria-hidden="true">→</span></Link>
        </section>
      </div>

      <section aria-label="Doctor workspace links" className="grid gap-3 sm:grid-cols-2">
        <ShortcutCard href="/doctor/appointments" title="Appointment management" description="Review, reschedule, or complete visits." icon={CalendarCheck2} />
        <ShortcutCard href="/doctor/availability" title="Manage availability" description="Set the times patients can book." icon={CalendarRange} />
      </section>
    </div>
  );
}

function ShortcutCard({ href, title, description, icon: Icon }: {
  href: string;
  title: string;
  description: string;
  icon: typeof CalendarDays;
}) {
  return (
    <Link href={href} className="group flex min-h-20 items-center gap-4 rounded-2xl border border-border bg-card p-4 shadow-sm transition-colors hover:border-primary/30 hover:bg-secondary/25 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
      <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-secondary text-secondary-foreground transition-colors group-hover:bg-primary group-hover:text-primary-foreground"><Icon aria-hidden="true" className="size-5" /></span>
      <span><span className="block font-semibold text-card-foreground group-hover:text-primary">{title}</span><span className="mt-1 block text-sm leading-5 text-muted-foreground">{description}</span></span>
    </Link>
  );
}
