"use client";

import { CalendarDays, CalendarRange, Clock3, UserRound } from "lucide-react";
import Link from "next/link";
import { useAuth } from "@clerk/nextjs";
import { useEffect, useMemo, useState } from "react";
import { useDashboardProfile } from "@/components/role-application-shell";
import { PatientDashboardContent } from "@/components/patient-dashboard-content";
import { getAppointments, type PatientAppointment } from "@/lib/profile-api";

const APPLICATION_TIME_ZONE = "Asia/Kolkata";

function appointmentInstant(appointment: Pick<PatientAppointment, "date" | "start_time">) {
  const value = new Date(`${appointment.date}T${appointment.start_time}+05:30`);
  return Number.isNaN(value.getTime()) ? null : value;
}

function applicationDate(value: Date) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: APPLICATION_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(value);
  const values = Object.fromEntries(parts.map(({ type, value: part }) => [type, part]));
  return `${values.year}-${values.month}-${values.day}`;
}

function appointmentLabel(appointment: PatientAppointment) {
  const date = new Date(`${appointment.date}T00:00:00Z`);
  const day = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeZone: "UTC" }).format(date);
  const [hourText, minute] = appointment.start_time.split(":");
  const hour = Number(hourText);
  return `${day} · ${hour % 12 || 12}:${minute} ${hour >= 12 ? "PM" : "AM"} IST`;
}

export function PatientDashboardPage() {
  const profile = useDashboardProfile();
  const name = `${profile.first_name} ${profile.last_name}`.trim();

  return (
    <div className="space-y-8">
      <header>
        <p className="text-sm font-semibold uppercase tracking-[0.14em] text-primary">Patient dashboard</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">Welcome back, {name}</h1>
        <p className="mt-3 max-w-2xl text-base leading-7 text-muted-foreground">Your appointment workspace is ready. Find a doctor and keep your care plans organized in one place.</p>
      </header>

      <PatientDashboardContent />

      <section aria-labelledby="patient-shortcuts-title">
        <h2 id="patient-shortcuts-title" className="text-lg font-semibold text-foreground">Quick links</h2>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <ShortcutCard href="/patient/appointments" title="My Appointments" description="View your appointment workspace." icon={CalendarDays} />
          <ShortcutCard href="/patient/profile" title="Profile" description="View your profile section." icon={UserRound} />
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
  const name = `${profile.first_name} ${profile.last_name}`.trim();

  useEffect(() => {
    let active = true;
    void getToken().then((token) => {
      if (!token) throw new Error("Your session could not be verified. Please try again.");
      return getAppointments(token);
    }).then((result) => { if (active) { setAppointments(result); setCurrentTime(Date.now()); } })
      .catch((cause: unknown) => { if (active) setError(cause instanceof Error ? cause.message : "We couldn't load your appointments."); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [getToken]);

  const today = applicationDate(new Date());
  const now = currentTime ?? 0;
  const upcoming = useMemo(() => appointments.filter((appointment) => {
    const instant = appointmentInstant(appointment);
    return appointment.status === "confirmed" && instant !== null && instant.getTime() > now;
  }).sort((first, second) => (appointmentInstant(first)?.getTime() ?? 0) - (appointmentInstant(second)?.getTime() ?? 0)), [appointments, now]);
  const todaysAppointments = upcoming.filter((appointment) => appointment.date === today);
  const nextAppointment = upcoming[0];

  return (
    <div className="space-y-8">
      <header>
        <p className="text-sm font-semibold uppercase tracking-[0.14em] text-primary">Doctor dashboard</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">Welcome back, {name}</h1>
        <p className="mt-3 max-w-2xl text-base leading-7 text-muted-foreground">Here is your schedule at a glance, including today’s visits and your next appointment.</p>
      </header>

      {error ? <p className="rounded-xl border border-destructive/40 bg-destructive/5 p-4 text-sm" role="alert">{error}</p> : null}
      <section aria-labelledby="doctor-today-title" className="rounded-2xl border border-border bg-card p-5 shadow-sm sm:p-6">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div><p className="text-sm font-semibold uppercase tracking-wide text-primary">{new Intl.DateTimeFormat("en-IN", { dateStyle: "full", timeZone: APPLICATION_TIME_ZONE }).format(new Date())}</p><h2 id="doctor-today-title" className="mt-1 text-xl font-semibold text-card-foreground">Today’s appointments</h2></div>
          <p className="text-sm text-muted-foreground">{loading ? "Loading schedule…" : error ? "Schedule unavailable" : `${todaysAppointments.length} ${todaysAppointments.length === 1 ? "appointment" : "appointments"}`}</p>
        </div>
        {!loading && !error && todaysAppointments.length === 0 ? <p className="mt-4 rounded-xl bg-muted p-4 text-sm text-muted-foreground">No confirmed appointments are scheduled for today.</p> : null}
        {todaysAppointments.length > 0 ? <ul className="mt-4 divide-y divide-border">{todaysAppointments.map((appointment) => <li key={appointment.id} className="flex flex-wrap items-center justify-between gap-3 py-3"><div><p className="font-medium text-card-foreground">{appointment.patient_first_name} {appointment.patient_last_name}</p><p className="mt-1 text-sm text-muted-foreground">{appointmentLabel(appointment)}</p></div><span className="rounded-full bg-status-confirmed-bg px-3 py-1 text-xs font-semibold text-status-confirmed">Confirmed</span></li>)}</ul> : null}
      </section>
      <section aria-labelledby="doctor-next-title" className="grid gap-4 sm:grid-cols-2">
        <div className="rounded-2xl border border-border bg-card p-5 shadow-sm"><div className="flex items-center gap-2 text-primary"><CalendarDays aria-hidden="true" className="size-5" /><h2 className="font-semibold text-card-foreground">Upcoming appointments</h2></div><p className="mt-3 text-3xl font-semibold text-foreground">{loading || error ? "—" : upcoming.length}</p><Link href="/doctor/appointments" className="mt-3 inline-flex text-sm font-semibold text-primary underline-offset-4 hover:underline">View appointment list</Link></div>
        <div className="rounded-2xl border border-border bg-card p-5 shadow-sm"><div className="flex items-center gap-2 text-primary"><Clock3 aria-hidden="true" className="size-5" /><h2 id="doctor-next-title" className="font-semibold text-card-foreground">Next appointment</h2></div>{loading ? <p className="mt-3 text-sm text-muted-foreground">Loading schedule…</p> : error ? <p className="mt-3 text-sm text-muted-foreground">Appointment details are unavailable.</p> : nextAppointment ? <><p className="mt-3 font-semibold text-foreground">{nextAppointment.patient_first_name} {nextAppointment.patient_last_name}</p><p className="mt-1 text-sm text-muted-foreground">{appointmentLabel(nextAppointment)}</p></> : <p className="mt-3 text-sm text-muted-foreground">No upcoming confirmed appointments.</p>}</div>
      </section>
      <section aria-label="Doctor workspace links" className="flex flex-wrap gap-3">
        <Link href="/doctor/availability" className="inline-flex min-h-10 items-center gap-2 rounded-lg border border-border px-4 text-sm font-semibold text-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"><CalendarRange aria-hidden="true" className="size-4" /> Manage availability</Link>
        <Link href="/doctor/profile" className="inline-flex min-h-10 items-center gap-2 rounded-lg border border-border px-4 text-sm font-semibold text-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"><UserRound aria-hidden="true" className="size-4" /> Profile</Link>
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
    <Link href={href} className="group flex min-h-32 items-start gap-4 rounded-2xl border border-border bg-card p-5 shadow-sm transition-colors hover:bg-muted/50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
      <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-secondary text-secondary-foreground"><Icon aria-hidden="true" className="size-5" /></span>
      <span>
        <span className="block font-semibold text-card-foreground group-hover:text-primary">{title}</span>
        <span className="mt-1 block text-sm leading-6 text-muted-foreground">{description}</span>
      </span>
    </Link>
  );
}
