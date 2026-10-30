"use client";

import { useAuth } from "@clerk/nextjs";
import { CalendarClock, CheckCircle2, RefreshCw, XCircle } from "lucide-react";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { CancellationRefundEstimate } from "@/components/cancellation-refund-estimate";
import { notifyError, notifySuccess } from "@/lib/notifications";
import {
  cancelAppointment,
  getAppointmentCancellationRefundPreview,
  getAppointments,
  getDoctorSlots,
  ProfileApiError,
  rescheduleAppointment,
  type AvailabilitySlot,
  type PatientAppointment,
} from "@/lib/profile-api";

const APPLICATION_TIME_ZONE = "Asia/Kolkata";
const RESCHEDULE_WINDOW_DAYS = 30;

function appointmentInstant(appointment: Pick<PatientAppointment, "date" | "start_time">) {
  const instant = new Date(`${appointment.date}T${appointment.start_time}+05:30`);
  return Number.isNaN(instant.getTime()) ? null : instant;
}

function appointmentDate(date: string) {
  const [year, month, day] = date.split("-").map(Number);
  return new Intl.DateTimeFormat("en-IN", { dateStyle: "full", timeZone: "UTC" })
    .format(new Date(Date.UTC(year, month - 1, day)));
}

function appointmentTime(time: string) {
  const [hourText, minute] = time.split(":");
  const hour = Number(hourText);
  return `${hour % 12 || 12}:${minute} ${hour >= 12 ? "PM" : "AM"}`;
}

function todayInApplicationZone() {
  const values = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    year: "numeric", month: "2-digit", day: "2-digit", timeZone: APPLICATION_TIME_ZONE,
  }).formatToParts(new Date()).map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function rescheduleRange() {
  const from = todayInApplicationZone();
  const [year, month, day] = from.split("-").map(Number);
  const to = new Date(Date.UTC(year, month - 1, day + RESCHEDULE_WINDOW_DAYS)).toISOString().slice(0, 10);
  return { from, to };
}

function slotDate(slot: AvailabilitySlot) {
  return appointmentDate(slot.date);
}

function statusClasses(status: PatientAppointment["status"]) {
  if (status === "confirmed") return "bg-status-confirmed-bg text-status-confirmed";
  if (status === "cancelled") return "bg-status-cancelled-bg text-status-cancelled";
  return "bg-status-completed-bg text-status-completed";
}

function conflictMessage(error: unknown, fallback: string) {
  if (error instanceof ProfileApiError && error.status === 409) {
    return "This appointment changed before the request completed. Your appointment list is being refreshed.";
  }
  return error instanceof Error ? error.message : fallback;
}

export function PatientAppointmentsPage() {
  const { getToken } = useAuth();
  const pathname = usePathname();
  const [appointments, setAppointments] = useState<PatientAppointment[]>([]);
  const [currentTime, setCurrentTime] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [activeRequest, setActiveRequest] = useState<string | null>(null);
  const requestLock = useRef(false);
  const [rescheduleId, setRescheduleId] = useState<string | null>(null);
  const [slots, setSlots] = useState<AvailabilitySlot[]>([]);
  const [slotsLoading, setSlotsLoading] = useState(false);
  const [slotsError, setSlotsError] = useState<string | null>(null);
  const [selectedSlotId, setSelectedSlotId] = useState("");
  const [cancelTarget, setCancelTarget] = useState<PatientAppointment | null>(null);
  const [refundPreview, setRefundPreview] = useState<Awaited<ReturnType<typeof getAppointmentCancellationRefundPreview>> | null>(null);
  const [refundPreviewLoading, setRefundPreviewLoading] = useState(false);
  const [refundPreviewError, setRefundPreviewError] = useState<string | null>(null);

  const [previousPathname, setPreviousPathname] = useState(pathname);
  if (previousPathname !== pathname) {
    setPreviousPathname(pathname);
    setCancelTarget(null);
  }

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
      .catch((error: unknown) => {
        if (active) setLoadError(error instanceof Error ? error.message : "We couldn't load your appointments.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [getToken, refreshKey]);

  useEffect(() => {
    if (!cancelTarget) return;
    let active = true;
    void getToken()
      .then((token) => {
        if (!token) throw new Error("Your session could not be verified. Please try again.");
        return getAppointmentCancellationRefundPreview(token, cancelTarget.id);
      })
      .then((preview) => { if (active) setRefundPreview(preview); })
      .catch((error: unknown) => {
        if (active) setRefundPreviewError(error instanceof Error ? error.message : "The refund estimate is unavailable.");
      })
      .finally(() => { if (active) setRefundPreviewLoading(false); });
    return () => { active = false; };
  }, [cancelTarget, getToken]);

  const now = currentTime ?? 0;
  const ordered = [...appointments].sort((first, second) => {
    const firstInstant = appointmentInstant(first)?.getTime() ?? 0;
    const secondInstant = appointmentInstant(second)?.getTime() ?? 0;
    return secondInstant - firstInstant;
  });
  const upcoming = ordered.filter((appointment) => appointment.status === "confirmed" && (() => {
    const instant = appointmentInstant(appointment);
    return instant !== null && instant.getTime() > now;
  })()).sort((first, second) => (appointmentInstant(first)?.getTime() ?? 0) - (appointmentInstant(second)?.getTime() ?? 0));
  const past = ordered.filter((appointment) => appointment.status !== "cancelled" && (() => {
    const instant = appointmentInstant(appointment);
    return appointment.status === "completed" || instant !== null && instant.getTime() <= now;
  })());
  const cancelled = ordered.filter((appointment) => appointment.status === "cancelled");

  function retryList() {
    setLoading(true);
    setLoadError(null);
    setRefreshKey((key) => key + 1);
  }

  async function beginReschedule(appointment: PatientAppointment) {
    if (requestLock.current) return;
    requestLock.current = true;
    setActiveRequest(`slots:${appointment.id}`);
    setRescheduleId(appointment.id);
    setSlots([]);
    setSelectedSlotId("");
    setSlotsError(null);
    setSlotsLoading(true);
    try {
      const token = await getToken();
      if (!token) throw new Error("Your session could not be verified. Please try again.");
      const { from, to } = rescheduleRange();
      const result = await getDoctorSlots(token, appointment.doctor_id, from, to);
      setSlots(result.filter((slot) => slot.id !== appointment.availability_id));
    } catch (error) {
      setSlotsError(error instanceof Error ? error.message : "We couldn't load replacement times.");
    } finally {
      setSlotsLoading(false);
      setActiveRequest(null);
      requestLock.current = false;
    }
  }

  async function cancel(appointment: PatientAppointment) {
    if (requestLock.current) return;
    requestLock.current = true;
    setActiveRequest(`cancel:${appointment.id}`);
    try {
      const token = await getToken();
      if (!token) throw new Error("Your session could not be verified. Please sign in again.");
      const updated = await cancelAppointment(token, appointment.id);
      setAppointments((current) => current.map((item) => item.id === appointment.id ? updated : item));
      setCancelTarget(null);
      notifySuccess("Appointment cancelled.", `patient-cancel-${appointment.id}`);
      if (rescheduleId === appointment.id) setRescheduleId(null);
    } catch (error) {
      const text = conflictMessage(error, "We couldn't cancel this appointment. Please try again.");
      if (error instanceof ProfileApiError && error.status === 409) retryList();
      notifyError(text, `patient-cancel-${appointment.id}`);
    } finally {
      setActiveRequest(null);
      requestLock.current = false;
    }
  }

  function openCancellationDialog(appointment: PatientAppointment) {
    setRefundPreview(null);
    setRefundPreviewError(null);
    setRefundPreviewLoading(true);
    setCancelTarget(appointment);
  }

  async function confirmReschedule(appointment: PatientAppointment) {
    if (!selectedSlotId || requestLock.current) return;
    requestLock.current = true;
    setActiveRequest(`reschedule:${appointment.id}`);
    try {
      const token = await getToken();
      if (!token) throw new Error("Your session could not be verified. Please sign in again.");
      const replacement = await rescheduleAppointment(token, appointment.id, selectedSlotId);
      setAppointments((current) => [...current.map((item) => item.id === appointment.id ? { ...item, status: "cancelled" as const } : item), replacement]);
      setRescheduleId(null);
      setSlots([]);
      setSelectedSlotId("");
      notifySuccess("Appointment rescheduled. The original booking is shown as cancelled and the replacement is confirmed.", `patient-reschedule-${appointment.id}`);
    } catch (error) {
      const text = conflictMessage(error, "We couldn't reschedule this appointment. Please try again.");
      if (error instanceof ProfileApiError && error.status === 409) {
        setSlotsError("The selected time may no longer be available. Refresh available times and choose another slot.");
        setSelectedSlotId("");
        retryList();
      } else {
        notifyError(text, `patient-reschedule-${appointment.id}`);
      }
    } finally {
      setActiveRequest(null);
      requestLock.current = false;
    }
  }

  return (
    <div className="mx-auto max-w-5xl space-y-8">
      <header>
        <p className="text-sm font-semibold uppercase tracking-[0.14em] text-primary">Patient workspace</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">My appointments</h1>
        <p className="mt-3 max-w-2xl text-base leading-7 text-muted-foreground">Review upcoming and past visits.</p>
      </header>

      {loading ? <p className="rounded-2xl bg-muted p-6 text-sm text-muted-foreground" role="status">Loading your appointments…</p> : null}
      {!loading && loadError ? (
        <section className="rounded-2xl border border-destructive/40 bg-destructive/5 p-6" role="alert">
          <p className="text-sm text-foreground">{loadError}</p>
          <button type="button" onClick={retryList} className="mt-4 inline-flex min-h-10 items-center gap-2 rounded-lg border border-border px-4 text-sm font-medium text-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"><RefreshCw aria-hidden="true" className="size-4" /> Try again</button>
        </section>
      ) : null}

      {!loading && !loadError ? (
        <>
          <AppointmentSection title="Upcoming appointments" empty="You have no upcoming appointments." appointments={upcoming}>
            {(appointment) => <AppointmentCard key={appointment.id} appointment={appointment} activeRequest={activeRequest} rescheduleId={rescheduleId} slots={slots} slotsLoading={slotsLoading} slotsError={slotsError} selectedSlotId={selectedSlotId} onCancel={() => openCancellationDialog(appointment)} onBeginReschedule={() => void beginReschedule(appointment)} onSelectSlot={setSelectedSlotId} onConfirmReschedule={() => void confirmReschedule(appointment)} onCloseReschedule={() => { setRescheduleId(null); setSlotsError(null); }} />}
          </AppointmentSection>
          <AppointmentSection title="Past appointments" empty="Your past appointments will appear here." appointments={past}>
            {(appointment) => <AppointmentCard key={appointment.id} appointment={appointment} activeRequest={activeRequest} rescheduleId={rescheduleId} slots={slots} slotsLoading={slotsLoading} slotsError={slotsError} selectedSlotId={selectedSlotId} onCancel={() => openCancellationDialog(appointment)} onBeginReschedule={() => void beginReschedule(appointment)} onSelectSlot={setSelectedSlotId} onConfirmReschedule={() => void confirmReschedule(appointment)} onCloseReschedule={() => { setRescheduleId(null); setSlotsError(null); }} />}
          </AppointmentSection>
          <AppointmentSection title="Cancelled appointments" empty="You have no cancelled appointments." appointments={cancelled}>
            {(appointment) => <AppointmentCard key={appointment.id} appointment={appointment} activeRequest={activeRequest} rescheduleId={rescheduleId} slots={slots} slotsLoading={slotsLoading} slotsError={slotsError} selectedSlotId={selectedSlotId} onCancel={() => openCancellationDialog(appointment)} onBeginReschedule={() => void beginReschedule(appointment)} onSelectSlot={setSelectedSlotId} onConfirmReschedule={() => void confirmReschedule(appointment)} onCloseReschedule={() => { setRescheduleId(null); setSlotsError(null); }} />}
          </AppointmentSection>
        </>
      ) : null}
      <AlertDialog open={cancelTarget !== null} onOpenChange={(open) => { if (!open && !activeRequest) setCancelTarget(null); }}>
        <AlertDialogContent className="max-w-md rounded-2xl border border-border bg-card p-6 text-card-foreground shadow-xl ring-0 sm:max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel appointment?</AlertDialogTitle>
            <AlertDialogDescription>This will cancel your confirmed appointment. You can review cancelled appointments in the history below.</AlertDialogDescription>
          </AlertDialogHeader>
          <CancellationRefundEstimate preview={refundPreview} loading={refundPreviewLoading} error={refundPreviewError} />
          <AlertDialogFooter className="m-0 flex-row justify-end gap-3 border-0 bg-transparent p-0">
            <AlertDialogCancel disabled={activeRequest?.startsWith("cancel:")}>Keep appointment</AlertDialogCancel>
            <AlertDialogAction variant="destructive" disabled={activeRequest?.startsWith("cancel:")} onClick={(event) => {
              event.preventDefault();
              if (cancelTarget) void cancel(cancelTarget);
            }}>{activeRequest?.startsWith("cancel:") ? "Cancelling…" : "Cancel appointment"}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function AppointmentSection({ title, empty, appointments, children }: {
  title: string;
  empty: string;
  appointments: PatientAppointment[];
  children: (appointment: PatientAppointment) => React.ReactNode;
}) {
  return (
    <section aria-label={title}>
      <h2 className="text-xl font-semibold text-foreground">{title}</h2>
      {appointments.length === 0 ? <p className="mt-4 rounded-xl bg-muted p-5 text-sm text-muted-foreground">{empty}</p> : <ul className="mt-4 space-y-4">{appointments.map(children)}</ul>}
    </section>
  );
}

function AppointmentCard({ appointment, activeRequest, rescheduleId, slots, slotsLoading, slotsError, selectedSlotId, onCancel, onBeginReschedule, onSelectSlot, onConfirmReschedule, onCloseReschedule }: {
  appointment: PatientAppointment;
  activeRequest: string | null;
  rescheduleId: string | null;
  slots: AvailabilitySlot[];
  slotsLoading: boolean;
  slotsError: string | null;
  selectedSlotId: string;
  onCancel: () => void;
  onBeginReschedule: () => void;
  onSelectSlot: (slotId: string) => void;
  onConfirmReschedule: () => void;
  onCloseReschedule: () => void;
}) {
  const instant = appointmentInstant(appointment);
  const isBusy = activeRequest?.endsWith(appointment.id) ?? false;
  const rescheduling = rescheduleId === appointment.id;

  return (
    <li className="rounded-2xl border border-border bg-card p-5 shadow-sm sm:p-6">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
        <div>
          <p className="font-semibold text-card-foreground">Dr. {appointment.doctor_first_name} {appointment.doctor_last_name}</p>
          <p className="mt-1 text-sm text-primary">{appointment.specialty}</p>
          <div className="mt-4 flex items-start gap-2 text-sm text-foreground">
            <CalendarClock aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <span>{appointmentDate(appointment.date)} · {appointmentTime(appointment.start_time)}–{appointmentTime(appointment.end_time)} IST</span>
          </div>
          {appointment.reason ? <p className="mt-3 text-sm leading-6 text-muted-foreground"><span className="font-medium text-foreground">Reason:</span> {appointment.reason}</p> : null}
          <p className="mt-2 text-xs text-muted-foreground">Appointment ID: {appointment.id}</p>
        </div>
        <span className={`inline-flex w-fit rounded-full px-3 py-1 text-xs font-semibold capitalize ${statusClasses(appointment.status)}`}>{appointment.status}</span>
      </div>

      {appointment.status === "confirmed" ? (
        <div className="mt-5 flex flex-wrap gap-3 border-t border-border pt-4">
          <Button type="button" variant="outline" size="compact" disabled={Boolean(activeRequest)} onClick={onBeginReschedule}>
            {activeRequest === `slots:${appointment.id}` ? "Loading times…" : "Reschedule"}
          </Button>
          <Button type="button" variant="destructive" size="compact" disabled={Boolean(activeRequest)} onClick={onCancel}>
            <XCircle aria-hidden="true" className="size-4" /> {activeRequest === `cancel:${appointment.id}` ? "Cancelling…" : "Cancel appointment"}
          </Button>
        </div>
      ) : null}

      {rescheduling ? (
        <div className="mt-5 rounded-xl border border-border bg-background p-4" aria-label="Choose a replacement appointment time">
          <div className="flex items-center justify-between gap-3">
            <h3 className="font-semibold text-foreground">Choose a new time</h3>
            <button type="button" onClick={onCloseReschedule} className="rounded px-2 py-1 text-sm text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">Close</button>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">Available times over the next 30 days · IST</p>
          {slotsLoading ? <p className="mt-4 text-sm text-muted-foreground" role="status">Loading available times…</p> : null}
          {!slotsLoading && slotsError ? <div className="mt-4 rounded-lg bg-destructive/5 p-3" role="alert"><p className="text-sm text-foreground">{slotsError}</p><button type="button" onClick={onBeginReschedule} disabled={Boolean(activeRequest)} className="mt-3 inline-flex min-h-9 items-center gap-2 rounded-lg border border-border px-3 text-sm font-medium text-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-60"><RefreshCw aria-hidden="true" className="size-4" /> Refresh available times</button></div> : null}
          {!slotsLoading && !slotsError && slots.length === 0 ? <p className="mt-4 text-sm text-muted-foreground">No replacement times are available for this doctor.</p> : null}
          {!slotsLoading && slots.length > 0 ? (
            <fieldset className="mt-4 grid gap-2 sm:grid-cols-2">
              <legend className="sr-only">Available replacement times</legend>
              {slots.map((slot) => (
                <label key={slot.id} className={`flex cursor-pointer items-center gap-3 rounded-lg border p-3 text-sm ${selectedSlotId === slot.id ? "border-primary bg-secondary/60" : "border-border hover:bg-muted/60"}`}>
                  <input type="radio" name={`reschedule-${appointment.id}`} value={slot.id} checked={selectedSlotId === slot.id} onChange={() => onSelectSlot(slot.id)} className="size-4 accent-primary" />
                  <span><span className="block font-medium text-foreground">{slotDate(slot)}</span><span className="text-muted-foreground">{appointmentTime(slot.start_time)}–{appointmentTime(slot.end_time)} IST</span></span>
                </label>
              ))}
            </fieldset>
          ) : null}
          <Button type="button" size="compact" disabled={!selectedSlotId || Boolean(activeRequest)} onClick={onConfirmReschedule} className="mt-4">
            {activeRequest === `reschedule:${appointment.id}` ? "Rescheduling…" : <><CheckCircle2 aria-hidden="true" className="size-4" /> Confirm new time</>}
          </Button>
        </div>
      ) : null}
      {isBusy ? <span className="sr-only" role="status">Updating appointment</span> : null}
      {instant === null ? <span className="sr-only">Appointment time could not be interpreted.</span> : null}
    </li>
  );
}
