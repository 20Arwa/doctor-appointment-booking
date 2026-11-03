"use client";

import { useAuth } from "@clerk/nextjs";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, CalendarCheck2, CalendarClock, CalendarDays, Clock3, Mail, Phone, RefreshCw, Stethoscope, UserRound, UsersRound } from "lucide-react";
import { getDoctorPatient, getDoctorPatientAppointmentsPage, type DoctorPatient, type PatientAppointment } from "@/lib/profile-api";

const APPLICATION_TIME_ZONE = "Asia/Kolkata";
const views = ["scheduled", "past", "cancelled"] as const;
type PatientHistoryView = (typeof views)[number];
type HistorySectionState = {
  appointments: PatientAppointment[];
  hasMore: boolean;
  nextOffset: number;
  loading: boolean;
  error: string | null;
};
type HistoryState = Record<PatientHistoryView, HistorySectionState>;

function emptyHistory(loading: boolean): HistoryState {
  return {
    scheduled: { appointments: [], hasMore: false, nextOffset: 0, loading, error: null },
    past: { appointments: [], hasMore: false, nextOffset: 0, loading, error: null },
    cancelled: { appointments: [], hasMore: false, nextOffset: 0, loading, error: null },
  };
}

function appointmentInstant(appointment: Pick<PatientAppointment, "date" | "start_time" | "end_time">, part: "start_time" | "end_time" = "start_time") {
  const instant = new Date(`${appointment.date}T${appointment[part]}+05:30`);
  return Number.isNaN(instant.getTime()) ? null : instant;
}

function patientAge(dateOfBirth: string, now: number) {
  const [birthYear, birthMonth, birthDay] = dateOfBirth.split("-").map(Number);
  const today = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: APPLICATION_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(now)).map(({ type, value }) => [type, Number(value)]));
  return today.year - birthYear - (today.month < birthMonth || today.month === birthMonth && today.day < birthDay ? 1 : 0);
}

function formatDateOnly(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  return new Intl.DateTimeFormat("en-IN", { dateStyle: "long", timeZone: "UTC" }).format(new Date(Date.UTC(year, month - 1, day)));
}

function formatAppointmentDate(instant: Date) {
  return new Intl.DateTimeFormat("en-IN", { dateStyle: "full", timeZone: APPLICATION_TIME_ZONE }).format(instant);
}

function formatAppointmentTime(instant: Date) {
  return new Intl.DateTimeFormat("en-IN", { hour: "numeric", minute: "2-digit", timeZone: APPLICATION_TIME_ZONE }).format(instant);
}

function statusClass(status: PatientAppointment["status"]) {
  if (status === "confirmed") return "bg-status-confirmed-bg text-status-confirmed";
  if (status === "cancelled") return "bg-status-cancelled-bg text-status-cancelled";
  return "bg-status-completed-bg text-status-completed";
}

const sectionTitles: Record<PatientHistoryView, string> = {
  scheduled: "Scheduled appointments",
  past: "Past appointments",
  cancelled: "Cancelled appointments",
};

const emptyMessages: Record<PatientHistoryView, string> = {
  scheduled: "There are no scheduled appointments with this patient.",
  past: "There are no past appointments with this patient.",
  cancelled: "There are no cancelled appointments with this patient.",
};

export function DoctorPatientDetailsPage({ patientId }: { patientId: string }) {
  const { getToken } = useAuth();
  const [patient, setPatient] = useState<DoctorPatient | null>(null);
  const [patientLoading, setPatientLoading] = useState(true);
  const [patientError, setPatientError] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryState>(() => emptyHistory(true));
  const [currentTime, setCurrentTime] = useState<number | null>(null);
  const [retryKey, setRetryKey] = useState(0);
  const loadingViews = useRef(new Set<PatientHistoryView>());

  useEffect(() => {
    let active = true;
    async function load() {
      setPatientLoading(true);
      setPatientError(null);
      setHistory(emptyHistory(true));
      try {
        const token = await getToken();
        if (!token) throw new Error("Your session could not be verified. Please sign in again.");
        const result = await getDoctorPatient(token, patientId);
        if (!active) return;
        setPatient(result);
        setCurrentTime(Date.now());

        const pages = await Promise.allSettled(views.map((view) => getDoctorPatientAppointmentsPage(token, patientId, view, 0)));
        if (!active) return;
        setHistory((state) => {
          const updated = { ...state };
          pages.forEach((page, index) => {
            const view = views[index];
            updated[view] = page.status === "fulfilled"
              ? { appointments: page.value.items, hasMore: page.value.has_more, nextOffset: page.value.next_offset, loading: false, error: null }
              : { ...updated[view], loading: false, error: page.reason instanceof Error ? page.reason.message : "We couldn't load these appointments." };
          });
          return updated;
        });
      } catch (cause) {
        if (active) {
          setPatient(null);
          setPatientError(cause instanceof Error ? cause.message : "We couldn't load this patient.");
          setHistory(emptyHistory(false));
        }
      } finally {
        if (active) setPatientLoading(false);
      }
    }
    void load();
    return () => { active = false; };
  }, [getToken, patientId, retryKey]);

  useEffect(() => {
    const initial = window.setTimeout(() => setCurrentTime(Date.now()), 0);
    const timer = window.setInterval(() => setCurrentTime(Date.now()), 60_000);
    return () => { window.clearTimeout(initial); window.clearInterval(timer); };
  }, []);

  const loadMore = useCallback(async (view: PatientHistoryView) => {
    const current = history[view];
    if ((!current.hasMore && !current.error) || loadingViews.current.has(view)) return;
    loadingViews.current.add(view);
    setHistory((value) => ({ ...value, [view]: { ...value[view], loading: true, error: null } }));
    try {
      const token = await getToken();
      if (!token) throw new Error("Your session could not be verified. Please sign in again.");
      const page = await getDoctorPatientAppointmentsPage(token, patientId, view, current.nextOffset);
      setHistory((value) => {
        const seen = new Set(value[view].appointments.map((appointment) => appointment.id));
        const appended = page.items.filter((appointment) => !seen.has(appointment.id));
        return {
          ...value,
          [view]: {
            appointments: [...value[view].appointments, ...appended],
            hasMore: page.has_more,
            nextOffset: page.next_offset,
            loading: false,
            error: null,
          },
        };
      });
    } catch (cause) {
      setHistory((value) => ({
        ...value,
        [view]: { ...value[view], loading: false, error: cause instanceof Error ? cause.message : "We couldn't load more appointments." },
      }));
    } finally {
      loadingViews.current.delete(view);
    }
  }, [getToken, history, patientId]);

  const retry = () => {
    setPatient(null);
    setPatientLoading(true);
    setPatientError(null);
    setHistory(emptyHistory(true));
    setRetryKey((value) => value + 1);
  };

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <header className="flex flex-col gap-3 border-b border-border pb-5 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <Link href="/doctor/appointments" className="inline-flex min-h-9 items-center gap-2 text-sm font-semibold text-muted-foreground transition-colors hover:text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"><ArrowLeft aria-hidden="true" className="size-4" />Back to appointments</Link>
          <p className="mt-4 text-xs font-semibold uppercase tracking-[0.16em] text-primary">Doctor workspace</p>
          <h1 className="mt-1.5 text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">Patient details</h1>
        </div>
      </header>

      {patientLoading ? <div className="rounded-2xl border border-border bg-card p-6 text-sm text-muted-foreground" role="status">Loading patient details…</div> : null}
      {!patientLoading && patientError ? <div className="rounded-2xl border border-destructive/40 bg-destructive/5 p-5" role="alert"><p className="text-sm text-foreground">{patientError}</p><button type="button" onClick={retry} className="mt-3 inline-flex min-h-10 items-center gap-2 rounded-lg border border-border px-3 text-sm font-medium text-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"><RefreshCw aria-hidden="true" className="size-4" />Try again</button></div> : null}

      {!patientLoading && patient ? (
        <>
          <section className="overflow-hidden rounded-3xl border border-primary/20 bg-card shadow-sm" aria-labelledby="patient-profile-title">
            <div className="flex items-center gap-4 border-b border-border bg-secondary/35 p-5 sm:p-6">
              <span className="flex size-14 shrink-0 items-center justify-center rounded-2xl bg-primary text-primary-foreground shadow-sm"><UserRound aria-hidden="true" className="size-7" /></span>
              <div className="min-w-0"><p className="text-xs font-semibold uppercase tracking-[0.13em] text-primary">Patient profile</p><h2 id="patient-profile-title" className="mt-1 truncate text-2xl font-semibold tracking-tight text-card-foreground">{patient.first_name} {patient.last_name}</h2></div>
            </div>
            <dl className="grid gap-px bg-border sm:grid-cols-2 lg:grid-cols-3">
              <PatientDetail icon={Mail} label="Email" value={patient.email} />
              {patient.phone ? <PatientDetail icon={Phone} label="Phone" value={patient.phone} /> : null}
              {patient.date_of_birth ? <PatientDetail icon={CalendarDays} label="Date of birth" value={`${formatDateOnly(patient.date_of_birth)}${currentTime === null ? "" : ` · Age ${patientAge(patient.date_of_birth, currentTime)}`}`} /> : null}
              {patient.gender ? <PatientDetail icon={UsersRound} label="Gender" value={patient.gender} /> : null}
            </dl>
          </section>

          <div className="flex items-end justify-between gap-3 pt-1">
            <div><p className="text-xs font-semibold uppercase tracking-[0.14em] text-primary">Care together</p><h2 className="mt-1 text-xl font-semibold tracking-tight text-foreground">Appointment history</h2></div>
            <span className="hidden items-center gap-1.5 text-xs font-medium text-muted-foreground sm:inline-flex"><Stethoscope aria-hidden="true" className="size-4 text-primary" />With you</span>
          </div>

          {views.map((view) => <AppointmentHistorySection key={view} view={view} state={history[view]} now={currentTime ?? 0} onShowMore={() => void loadMore(view)} />)}
        </>
      ) : null}
    </div>
  );
}

function PatientDetail({ icon: Icon, label, value }: { icon: typeof UserRound; label: string; value: string }) {
  return <div className="flex items-start gap-3 bg-card p-4 sm:p-5"><span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg bg-secondary text-secondary-foreground"><Icon aria-hidden="true" className="size-4" /></span><div className="min-w-0"><dt className="text-xs font-medium text-muted-foreground">{label}</dt><dd className="mt-1 break-words text-sm font-medium text-card-foreground">{value}</dd></div></div>;
}

function AppointmentHistorySection({ view, state, now, onShowMore }: { view: PatientHistoryView; state: HistorySectionState; now: number; onShowMore: () => void }) {
  return (
    <section aria-labelledby={`patient-history-${view}`} className="rounded-2xl border border-border bg-card p-5 shadow-sm sm:p-6">
      <div className="flex items-center gap-3">
        <span className="flex size-10 items-center justify-center rounded-xl bg-secondary text-secondary-foreground">{view === "scheduled" ? <CalendarClock aria-hidden="true" className="size-5" /> : view === "past" ? <CalendarCheck2 aria-hidden="true" className="size-5" /> : <CalendarDays aria-hidden="true" className="size-5" />}</span>
        <h3 id={`patient-history-${view}`} className="text-lg font-semibold text-card-foreground">{sectionTitles[view]}</h3>
      </div>
      {state.loading && state.appointments.length === 0 ? <p className="mt-4 text-sm text-muted-foreground" role="status">Loading appointments…</p> : null}
      {state.error && state.appointments.length === 0 ? <div className="mt-4 rounded-xl border border-destructive/30 bg-destructive/5 p-4" role="alert"><p className="text-sm text-foreground">{state.error}</p><button type="button" onClick={onShowMore} className="mt-3 inline-flex min-h-9 items-center gap-2 text-sm font-semibold text-primary hover:underline"><RefreshCw aria-hidden="true" className="size-4" />Try again</button></div> : null}
      {!state.loading && !state.error && state.appointments.length === 0 ? <p className="mt-4 rounded-xl bg-muted/70 p-4 text-sm text-muted-foreground">{emptyMessages[view]}</p> : null}
      {state.appointments.length > 0 ? <ul className="mt-4 divide-y divide-border">{state.appointments.map((appointment) => {
        const instant = appointmentInstant(appointment);
        const endInstant = appointmentInstant(appointment, "end_time");
        const hasEnded = (appointmentInstant(appointment, "end_time")?.getTime() ?? Infinity) <= now;
        const statusLabel = appointment.status === "confirmed" && view === "past" && hasEnded ? "Awaiting completion" : appointment.status;
        const fee = appointment.consultation_fee ? new Intl.NumberFormat("en-IN", { style: "currency", currency: appointment.consultation_currency ?? "INR", maximumFractionDigits: 0 }).format(Number(appointment.consultation_fee)) : null;
        return <li key={appointment.id} className="flex flex-col gap-3 py-4 first:pt-1 last:pb-1 sm:flex-row sm:items-start sm:justify-between"><div><p className="font-semibold text-card-foreground">{instant ? formatAppointmentDate(instant) : appointment.date}</p><p className="mt-1 inline-flex items-center gap-2 text-sm text-muted-foreground"><Clock3 aria-hidden="true" className="size-4 text-primary" />{instant ? formatAppointmentTime(instant) : appointment.start_time.slice(0, 5)}–{endInstant ? formatAppointmentTime(endInstant) : appointment.end_time.slice(0, 5)} IST</p>{appointment.reason ? <p className="mt-2 text-sm leading-6 text-muted-foreground"><span className="font-medium text-foreground">Reason:</span> {appointment.reason}</p> : null}{fee ? <p className="mt-2 text-sm font-medium text-foreground">Consultation fee: {fee}</p> : null}</div><span className={`inline-flex w-fit rounded-full px-3 py-1 text-xs font-semibold capitalize ${statusClass(appointment.status)}`}>{statusLabel}</span></li>;
      })}</ul> : null}
      {state.error && state.appointments.length > 0 ? <p className="mt-3 text-sm text-destructive" role="alert">{state.error}</p> : null}
      {state.hasMore || state.error && state.appointments.length > 0 ? <div className="mt-4 flex justify-center"><button type="button" onClick={onShowMore} disabled={state.loading} className="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border border-border bg-background px-4 text-sm font-semibold text-foreground transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-wait disabled:opacity-60">{state.loading ? <><RefreshCw aria-hidden="true" className="size-4 animate-spin motion-reduce:animate-none" />Loading…</> : state.error ? "Try again" : "Show More"}</button></div> : null}
    </section>
  );
}
