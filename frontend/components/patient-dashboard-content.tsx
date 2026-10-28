"use client";

import { useAuth } from "@clerk/nextjs";
import { CalendarClock, CalendarPlus, RefreshCw } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { getAppointments, type PatientAppointment } from "@/lib/profile-api";

const APPLICATION_TIME_ZONE = "Asia/Kolkata";

function appointmentInstant(appointment: PatientAppointment) {
  const instant = new Date(`${appointment.date}T${appointment.start_time}+05:30`);
  return Number.isNaN(instant.getTime()) ? null : instant;
}

function getNextAppointment(appointments: PatientAppointment[]) {
  const now = new Date();
  return appointments
    .filter((appointment) => appointment.status === "confirmed")
    .map((appointment) => ({ appointment, instant: appointmentInstant(appointment) }))
    .filter((entry): entry is { appointment: PatientAppointment; instant: Date } => entry.instant !== null && entry.instant > now)
    .sort((first, second) => first.instant.getTime() - second.instant.getTime())[0] ?? null;
}

function formatAppointmentDate(instant: Date) {
  return new Intl.DateTimeFormat("en-IN", {
    dateStyle: "full",
    timeZone: APPLICATION_TIME_ZONE,
  }).format(instant);
}

function formatAppointmentTime(instant: Date) {
  return new Intl.DateTimeFormat("en-IN", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: APPLICATION_TIME_ZONE,
  }).format(instant);
}

export function PatientDashboardContent() {
  const { getToken } = useAuth();
  const [appointments, setAppointments] = useState<PatientAppointment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    let active = true;
    void getToken()
      .then((token) => {
        if (!token) throw new Error("Your session could not be verified. Please try again.");
        return getAppointments(token);
      })
      .then((result) => {
        if (active) setAppointments(result);
      })
      .catch((cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : "We couldn't load your appointments. Please try again.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [getToken, retryKey]);

  const next = getNextAppointment(appointments);

  return (
    <div className="space-y-6">
      <section className="rounded-3xl border border-border bg-card p-6 shadow-sm sm:p-9" aria-labelledby="patient-next-step-title">
        <div className="flex flex-col items-start justify-between gap-6 sm:flex-row sm:items-center">
          <div className="max-w-xl">
            <p className="text-sm font-semibold text-primary">Ready when you are</p>
            <h2 id="patient-next-step-title" className="mt-2 text-2xl font-semibold tracking-tight text-card-foreground">Book an appointment</h2>
            <p className="mt-2 leading-7 text-muted-foreground">Explore doctors and find care that works for you.</p>
          </div>
          <Link href="/patient/book-appointment" className="inline-flex min-h-12 shrink-0 items-center justify-center gap-2 rounded-lg bg-primary px-5 py-3 font-semibold text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
            <CalendarPlus aria-hidden="true" className="size-5" /> Book Appointment
          </Link>
        </div>
      </section>

      <section className="rounded-3xl border border-border bg-card p-6 shadow-sm sm:p-8" aria-labelledby="next-appointment-title" aria-live="polite">
        <div className="flex items-center gap-3">
          <span className="flex size-11 items-center justify-center rounded-xl bg-secondary text-secondary-foreground"><CalendarClock aria-hidden="true" className="size-5" /></span>
          <div>
            <h2 id="next-appointment-title" className="text-lg font-semibold text-card-foreground">Next upcoming appointment</h2>
            <p className="text-sm text-muted-foreground">Confirmed appointments are shown in India Standard Time.</p>
          </div>
        </div>

        {loading ? <p className="mt-6 text-sm text-muted-foreground">Loading your appointment…</p> : null}
        {!loading && error ? (
          <div className="mt-6 rounded-xl border border-destructive/40 bg-destructive/5 p-4" role="alert">
            <p className="text-sm text-foreground">{error}</p>
            <button type="button" onClick={() => { setLoading(true); setError(null); setRetryKey((key) => key + 1); }} className="mt-3 inline-flex min-h-10 items-center gap-2 rounded-lg border border-border px-3 text-sm font-medium text-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
              <RefreshCw aria-hidden="true" className="size-4" /> Try again
            </button>
          </div>
        ) : null}
        {!loading && !error && !next ? <p className="mt-6 rounded-xl bg-muted p-4 text-sm leading-6 text-muted-foreground">You have no upcoming confirmed appointments. When you’re ready, browse the doctor directory to plan your next visit.</p> : null}
        {!loading && !error && next ? (
          <div className="mt-6 rounded-2xl border border-border bg-background p-5">
            <p className="font-semibold text-foreground">Dr. {next.appointment.doctor_first_name} {next.appointment.doctor_last_name}</p>
            <p className="mt-1 text-sm text-muted-foreground">{next.appointment.specialty}</p>
            <p className="mt-4 font-medium text-foreground">{formatAppointmentDate(next.instant)}</p>
            <p className="mt-1 text-sm text-muted-foreground">{formatAppointmentTime(next.instant)} IST</p>
          </div>
        ) : null}
      </section>
    </div>
  );
}
