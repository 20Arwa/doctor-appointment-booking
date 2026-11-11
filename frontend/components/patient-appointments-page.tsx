"use client";

import { useAuth } from "@clerk/nextjs";
import { CalendarClock, CheckCircle2, RefreshCw, XCircle } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
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
import { notifyError, notifyInAppNotificationsChanged, notifySuccess } from "@/lib/notifications";
import { useAppointmentHistory } from "@/components/use-appointment-history";
import { AppointmentAvailabilityCalendar } from "@/components/appointment-availability-calendar";
import {
  cancelAppointment,
  getAppointment,
  getAppointmentCancellationRefundPreview,
  getPatientAssistedRequest,
  getDoctorSlots,
  confirmPatientAssistedReschedule,
  declinePatientAssistedReschedule,
  ProfileApiError,
  rescheduleAppointment,
  type AvailabilitySlot,
  type AssistedPatientRequest,
  type PatientAppointment,
} from "@/lib/profile-api";

const APPLICATION_TIME_ZONE = "Asia/Kolkata";

class AssistedRescheduleResponseMismatchError extends Error {
  constructor() {
    super("The server returned an appointment that does not match the selected suggestion. Reload its status or contact support before trying again.");
    this.name = "AssistedRescheduleResponseMismatchError";
  }
}

function appointmentInstant(appointment: Pick<PatientAppointment, "date" | "start_time">) {
  const instant = new Date(`${appointment.date}T${appointment.start_time}+05:30`);
  return Number.isNaN(instant.getTime()) ? null : instant;
}

function appointmentEndInstant(appointment: Pick<PatientAppointment, "date" | "end_time">) {
  const instant = new Date(`${appointment.date}T${appointment.end_time}+05:30`);
  return Number.isNaN(instant.getTime()) ? null : instant;
}

const inrFormatter = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 });

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

function monthRange(month: string) {
  const [year, monthNumber] = month.split("-").map(Number);
  return { from: month, to: new Date(Date.UTC(year, monthNumber, 0)).toISOString().slice(0, 10) };
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
  const router = useRouter();
  const searchParams = useSearchParams();
  const appointmentFromNotification = searchParams.get("appointment");
  const { appointments, setAppointments, loading, error: loadError, history, retry: retryAppointments, loadMore } = useAppointmentHistory();
  const requestedNotificationAppointment = useRef<string | null>(null);
  const notificationRequestInFlight = useRef<{ appointmentId: string } | null>(null);
  const pendingNotificationScroll = useRef<string | null>(null);
  const assistedSectionRef = useRef<HTMLElement | null>(null);
  const [notificationFocusId, setNotificationFocusId] = useState<string | null>(null);
  const [currentTime, setCurrentTime] = useState<number | null>(null);
  const [activeRequest, setActiveRequest] = useState<string | null>(null);
  const requestLock = useRef(false);
  const [rescheduleId, setRescheduleId] = useState<string | null>(null);
  const [slots, setSlots] = useState<AvailabilitySlot[]>([]);
  const [slotsLoading, setSlotsLoading] = useState(false);
  const [slotsError, setSlotsError] = useState<string | null>(null);
  const [selectedSlotId, setSelectedSlotId] = useState("");
  const [rescheduleMonth, setRescheduleMonth] = useState(() => todayInApplicationZone().slice(0, 7));
  const [rescheduleDate, setRescheduleDate] = useState(todayInApplicationZone());
  const [cancelTarget, setCancelTarget] = useState<PatientAppointment | null>(null);
  const [refundPreview, setRefundPreview] = useState<Awaited<ReturnType<typeof getAppointmentCancellationRefundPreview>> | null>(null);
  const [refundPreviewLoading, setRefundPreviewLoading] = useState(false);
  const [refundPreviewError, setRefundPreviewError] = useState<string | null>(null);
  const [assistedRequest, setAssistedRequest] = useState<AssistedPatientRequest | null>(null);
  const [assistedSlots, setAssistedSlots] = useState<AvailabilitySlot[]>([]);
  const [assistedLoading, setAssistedLoading] = useState(false);
  const [assistedError, setAssistedError] = useState<string | null>(null);
  const [selectedAssistedSuggestion, setSelectedAssistedSuggestion] = useState<string>("");
  const [assistedDialog, setAssistedDialog] = useState<"confirm" | "decline" | null>(null);
  const [assistedTargetAppointmentId, setAssistedTargetAppointmentId] = useState<string | null>(null);
  const [assistedReload, setAssistedReload] = useState(0);
  const [assistedStale, setAssistedStale] = useState(false);

  const [previousPathname, setPreviousPathname] = useState(pathname);
  if (previousPathname !== pathname) {
    setPreviousPathname(pathname);
    setCancelTarget(null);
  }
  const assistedTargetAppointment = appointments.find((appointment) => appointment.id === assistedTargetAppointmentId) ?? null;

  useEffect(() => {
    const initialTime = window.setTimeout(() => setCurrentTime(Date.now()), 0);
    const timer = window.setInterval(() => setCurrentTime(Date.now()), 30_000);
    return () => { window.clearTimeout(initialTime); window.clearInterval(timer); };
  }, []);

  useEffect(() => {
    if (!appointmentFromNotification) {
      requestedNotificationAppointment.current = null;
      return;
    }
    if (loading) return;
    if (requestedNotificationAppointment.current === appointmentFromNotification
      || notificationRequestInFlight.current?.appointmentId === appointmentFromNotification) return;
    const request = { appointmentId: appointmentFromNotification };
    notificationRequestInFlight.current = request;
    let active = true;
    void (async () => {
      try {
        const token = await getToken();
        if (!token) throw new Error("Your session could not be verified. Please sign in again.");
        const appointment = await getAppointment(token, appointmentFromNotification);
        if (!active) return;
        setAssistedLoading(true);
        setAssistedTargetAppointmentId(appointment.id);
        requestedNotificationAppointment.current = appointmentFromNotification;
        pendingNotificationScroll.current = appointment.id;
        setAppointments((current) => current.some((item) => item.id === appointment.id)
          ? current.map((item) => item.id === appointment.id ? appointment : item)
          : [...current, appointment]);
      } catch { /* The authorized appointment route remains the source of truth. */ }
      finally {
        if (notificationRequestInFlight.current === request) notificationRequestInFlight.current = null;
      }
    })();
    return () => {
      active = false;
      if (notificationRequestInFlight.current === request) notificationRequestInFlight.current = null;
    };
  }, [appointmentFromNotification, getToken, loading, setAppointments]);

  useEffect(() => {
    if (!assistedTargetAppointmentId) return;
    let active = true;
    const timer = window.setTimeout(() => {
      setAssistedLoading(true);
      setAssistedError(null);
      void (async () => {
        try {
          const token = await getToken();
          if (!token) throw new Error("Your session could not be verified. Please sign in again.");
          const request = await getPatientAssistedRequest(token, assistedTargetAppointmentId);
          if (!active) return;
          setAssistedRequest(request);
          setAssistedSlots([]);
          setSelectedAssistedSuggestion("");
          setAssistedStale(request.status === "pending_patient" && request.appointment_status !== "confirmed");
          if (request.status === "pending_patient" && request.appointment_status === "confirmed" && assistedTargetAppointment) {
            const dates = request.suggestions.map((suggestion) => suggestion.date).sort();
            if (dates.length) {
              const live = await getDoctorSlots(token, assistedTargetAppointment.doctor_id, dates[0], dates[dates.length - 1]);
              if (!active) return;
              setAssistedSlots(live.filter((slot) => !slot.reservation_only && (slot.remaining_capacity ?? 0) > 0
                && request.suggestions.some((suggestion) => suggestion.availability_id === slot.id
                  && suggestion.mode === slot.mode && suggestion.date === slot.date
                  && suggestion.start_time.slice(0, 8) === slot.start_time.slice(0, 8)
                  && suggestion.end_time.slice(0, 8) === slot.end_time.slice(0, 8))));
              setRescheduleDate(dates[0]);
              setRescheduleMonth(dates[0].slice(0, 7));
            }
          }
        } catch (requestError) {
          if (!active) return;
          if (requestError instanceof ProfileApiError && requestError.status === 404) setAssistedRequest(null);
          else setAssistedError(requestError instanceof Error ? requestError.message : "We couldn't load the assisted rescheduling request.");
        } finally { if (active) setAssistedLoading(false); }
      })();
    }, 0);
    return () => { active = false; window.clearTimeout(timer); };
  }, [assistedTargetAppointmentId, assistedTargetAppointment, getToken, assistedReload]);

  useEffect(() => {
    const appointmentId = pendingNotificationScroll.current;
    if (!appointmentId || !appointments.some((appointment) => appointment.id === appointmentId)) return;
    if (assistedTargetAppointmentId === appointmentId && assistedLoading) return;
    const currentUrl = new URL(window.location.href);
    if (currentUrl.searchParams.get("appointment") !== appointmentId) return;
    const hasSavedAssistedSuggestions = assistedTargetAppointmentId === appointmentId
      && assistedRequest?.appointment_id === appointmentId
      && assistedRequest.status === "pending_patient"
      && assistedRequest.suggestions.length > 0;
    if (hasSavedAssistedSuggestions) {
      const section = assistedSectionRef.current;
      if (!section) return;
      const stickyHeader = document.querySelector<HTMLElement>("header.sticky");
      const headerOffset = stickyHeader?.getBoundingClientRect().height ?? 64;
      const sectionTop = section.getBoundingClientRect().top + window.scrollY;
      window.scrollTo({ top: Math.max(0, sectionTop - headerOffset - 16), behavior: "smooth" });
    } else {
      const card = document.getElementById(`appointment-${appointmentId}`);
      if (!card) return;
      card.scrollIntoView({ block: "center" });
    }
    setNotificationFocusId(appointmentId);
    pendingNotificationScroll.current = null;
    currentUrl.searchParams.delete("appointment");
    router.replace(`${currentUrl.pathname}${currentUrl.search}${currentUrl.hash}`, { scroll: false });
  }, [appointments, assistedTargetAppointmentId, assistedLoading, assistedRequest, loadError, loading, router]);

  function clearNotificationFocus() {
    pendingNotificationScroll.current = null;
    setNotificationFocusId(null);
  }

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
    const instant = appointmentEndInstant(appointment);
    return instant !== null && instant.getTime() > now;
  })()).sort((first, second) => (appointmentInstant(first)?.getTime() ?? 0) - (appointmentInstant(second)?.getTime() ?? 0));
  const past = ordered.filter((appointment) => appointment.status !== "cancelled" && (() => {
    const endInstant = appointmentEndInstant(appointment);
    return appointment.status === "completed" || endInstant !== null && endInstant.getTime() <= now;
  })());
  const cancelled = ordered.filter((appointment) => appointment.status === "cancelled");

  function retryList() {
    clearNotificationFocus();
    retryAppointments();
  }

  async function beginReschedule(appointment: PatientAppointment) {
    clearNotificationFocus();
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
      const month = todayInApplicationZone().slice(0, 7);
      setRescheduleMonth(month);
      setRescheduleDate(todayInApplicationZone());
      const { from, to } = monthRange(`${month}-01`);
      const result = await getDoctorSlots(token, appointment.doctor_id, from, to);
      setSlots(result.filter((slot) => slot.id !== appointment.availability_id && (slot.mode === "wave" || slot.mode === "stream") && (slot.remaining_capacity ?? 0) > 0));
    } catch (error) {
      setSlotsError(error instanceof Error ? error.message : "We couldn't load replacement times.");
    } finally {
      setSlotsLoading(false);
      setActiveRequest(null);
      requestLock.current = false;
    }
  }

  async function changeRescheduleMonth(appointment: PatientAppointment, nextMonth: string) {
    setRescheduleMonth(nextMonth);
    setRescheduleDate(`${nextMonth}-01`);
    setSelectedSlotId("");
    setSlotsLoading(true);
    setSlotsError(null);
    try {
      const token = await getToken();
      if (!token) throw new Error("Your session could not be verified. Please try again.");
      const { from, to } = monthRange(`${nextMonth}-01`);
      const result = await getDoctorSlots(token, appointment.doctor_id, from, to);
      setSlots(result.filter((slot) => slot.id !== appointment.availability_id && (slot.mode === "wave" || slot.mode === "stream") && (slot.remaining_capacity ?? 0) > 0));
    } catch (error) {
      setSlotsError(error instanceof Error ? error.message : "We couldn't load replacement times.");
    } finally { setSlotsLoading(false); }
  }

  async function cancel(appointment: PatientAppointment) {
    clearNotificationFocus();
    if (requestLock.current) return;
    requestLock.current = true;
    setActiveRequest(`cancel:${appointment.id}`);
    try {
      const token = await getToken();
      if (!token) throw new Error("Your session could not be verified. Please sign in again.");
      const updated = await cancelAppointment(token, appointment.id);
      notifyInAppNotificationsChanged();
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
    clearNotificationFocus();
    setRefundPreview(null);
    setRefundPreviewError(null);
    setRefundPreviewLoading(true);
    setCancelTarget(appointment);
  }

  async function confirmReschedule(appointment: PatientAppointment) {
    if (!selectedSlotId || requestLock.current) return;
    clearNotificationFocus();
    requestLock.current = true;
    setActiveRequest(`reschedule:${appointment.id}`);
    try {
      const token = await getToken();
      if (!token) throw new Error("Your session could not be verified. Please sign in again.");
      const replacement = await rescheduleAppointment(token, appointment.id, selectedSlotId);
      notifyInAppNotificationsChanged();
      setAppointments((current) => [...current.map((item) => item.id === appointment.id ? { ...item, status: "cancelled" as const } : item), replacement]);
      if (assistedTargetAppointmentId === appointment.id || assistedRequest?.appointment_id === appointment.id) {
        setAssistedTargetAppointmentId(appointment.id);
        setAssistedRequest((current) => current?.appointment_id === appointment.id ? { ...current, status: "superseded" } : current);
        setAssistedSlots([]);
        setSelectedAssistedSuggestion("");
        setAssistedReload((value) => value + 1);
      }
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

  async function confirmAssistedReschedule(appointment: PatientAppointment) {
    if (!assistedRequest || !selectedAssistedSuggestion || requestLock.current) return;
    requestLock.current = true;
    setActiveRequest(`assisted:${appointment.id}`);
    try {
      const token = await getToken();
      if (!token) throw new Error("Your session could not be verified. Please sign in again.");
      const updated = await confirmPatientAssistedReschedule(token, assistedRequest.id, selectedAssistedSuggestion);
      const selectedSuggestion = assistedRequest.suggestions.find((suggestion) => suggestion.id === selectedAssistedSuggestion);
      const matchesSuggestion = selectedSuggestion
        && updated.availability_id === selectedSuggestion.availability_id
        && updated.mode === selectedSuggestion.mode
        && updated.date === selectedSuggestion.date
        && updated.start_time.slice(0, 8) === selectedSuggestion.start_time.slice(0, 8)
        && updated.end_time.slice(0, 8) === selectedSuggestion.end_time.slice(0, 8);
      if (!matchesSuggestion) {
        throw new AssistedRescheduleResponseMismatchError();
      }
      setAppointments((current) => current.map((item) => item.id === updated.id ? updated : item));
      setAssistedRequest({ ...assistedRequest, status: "accepted" });
      setAssistedStale(false);
      setAssistedDialog(null);
      notifyInAppNotificationsChanged();
      notifySuccess("Your appointment time has been updated.", `assisted-reschedule-${assistedRequest.id}`);
    } catch (cause) {
      const stale = cause instanceof ProfileApiError && cause.code === "ASSISTED_RESCHEDULE_REQUEST_STALE";
      const expired = cause instanceof ProfileApiError && cause.code === "ASSISTED_RESCHEDULE_REQUEST_EXPIRED";
      const declined = cause instanceof ProfileApiError && cause.code === "ASSISTED_RESCHEDULE_REQUEST_DECLINED";
      const superseded = cause instanceof ProfileApiError && cause.code === "ASSISTED_RESCHEDULE_REQUEST_SUPERSEDED";
      const closed = cause instanceof ProfileApiError && cause.code === "ASSISTED_RESCHEDULE_REQUEST_CLOSED";
      const requestConflict = cause instanceof ProfileApiError && cause.code === "ASSISTED_RESCHEDULE_REQUEST_CONFLICT";
      const acceptedStateConflict = cause instanceof ProfileApiError && cause.code === "ASSISTED_RESCHEDULE_ACCEPTED_STATE_CONFLICT";
      const responseMismatch = cause instanceof AssistedRescheduleResponseMismatchError;
      const unavailable = cause instanceof ProfileApiError && cause.status === 409
        && !expired && !stale && !declined && !superseded && !closed && !requestConflict && !acceptedStateConflict;
      setAssistedError(expired ? "This request expired when the original appointment was due to start. Its suggestions can no longer be confirmed."
        : stale ? "This request no longer matches the appointment. Its saved suggestions are no longer selectable."
          : declined ? "You already declined this assisted rescheduling request."
            : superseded ? "A newer schedule change replaced this request."
              : closed ? "This request is no longer open. Reload the appointment to see its current status."
                : responseMismatch ? "The server returned an appointment that does not match the selected suggestion. Reload its status or contact support before trying again."
                  : acceptedStateConflict ? "The request is marked accepted, but the appointment does not match the selected time. Reload its status or contact support before trying again."
                  : requestConflict ? "The request changed while confirmation was processing. Reload it before trying again."
                  : unavailable ? "That time is no longer available. Review current options before trying again."
                    : cause instanceof Error ? cause.message : "We couldn't confirm this time.");
      if (expired) { setAssistedRequest({ ...assistedRequest, status: "expired" }); setAssistedSlots([]); setSelectedAssistedSuggestion(""); }
      if (declined || superseded) {
        setAssistedRequest({ ...assistedRequest, status: declined ? "declined" : "superseded" });
        setAssistedSlots([]);
        setSelectedAssistedSuggestion("");
      }
      if (closed || requestConflict || acceptedStateConflict || responseMismatch) {
        setAssistedSlots([]);
        setSelectedAssistedSuggestion("");
        setAssistedReload((value) => value + 1);
      }
      if (stale) setAssistedStale(true);
      if (unavailable && !expired && !stale) {
        setSelectedAssistedSuggestion("");
        try {
          const token = await getToken();
          const dates = assistedRequest.suggestions.map((suggestion) => suggestion.date).sort();
          if (token && dates.length) {
            const live = await getDoctorSlots(token, appointment.doctor_id, dates[0], dates[dates.length - 1]);
            setAssistedSlots(live.filter((slot) => !slot.reservation_only && (slot.remaining_capacity ?? 0) > 0
              && assistedRequest.suggestions.some((suggestion) => suggestion.availability_id === slot.id && suggestion.mode === slot.mode
                && suggestion.date === slot.date && suggestion.start_time.slice(0, 8) === slot.start_time.slice(0, 8)
                && suggestion.end_time.slice(0, 8) === slot.end_time.slice(0, 8))));
            setAssistedError(null);
          }
        } catch (availabilityError) {
          setAssistedSlots([]);
          setAssistedError(availabilityError instanceof Error ? availabilityError.message : "We couldn't refresh saved suggestions.");
        }
      }
    } finally { setAssistedDialog(null); setActiveRequest(null); requestLock.current = false; }
  }

  async function declineAssistedReschedule() {
    if (!assistedRequest || requestLock.current) return;
    requestLock.current = true;
    setActiveRequest(`assisted-decline:${assistedRequest.appointment_id}`);
    try {
      const token = await getToken();
      if (!token) throw new Error("Your session could not be verified. Please sign in again.");
      await declinePatientAssistedReschedule(token, assistedRequest.id);
      setAssistedRequest({ ...assistedRequest, status: "declined" });
      notifySuccess("You declined the suggested schedule change.", `assisted-decline-${assistedRequest.id}`);
    } catch (cause) {
      setAssistedError(cause instanceof Error ? cause.message : "We couldn't decline this request.");
    } finally { setAssistedDialog(null); setActiveRequest(null); requestLock.current = false; }
  }

  return (
    <div className="mx-auto max-w-5xl space-y-8">
      <header>
        <p className="text-sm font-semibold uppercase tracking-[0.14em] text-primary">Patient workspace</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">My appointments</h1>
        <p className="mt-3 max-w-2xl text-base leading-7 text-muted-foreground">Review upcoming and past visits.</p>
      </header>

      {(appointmentFromNotification || assistedTargetAppointmentId || assistedRequest) ? <section ref={assistedSectionRef} className="rounded-2xl border border-border bg-card p-5 shadow-sm sm:p-6" aria-labelledby="assisted-request-heading">
        <h2 id="assisted-request-heading" className="text-xl font-semibold text-foreground">Suggested appointment change</h2>
        {assistedLoading ? <p className="mt-3 text-sm text-muted-foreground" role="status">Checking for an assisted rescheduling request…</p> : null}
        {!assistedLoading && assistedError ? <div className="mt-3 rounded-lg bg-destructive/5 p-3" role="alert"><p className="text-sm text-destructive">{assistedError}</p><button type="button" onClick={() => { requestedNotificationAppointment.current = null; setAssistedError(null); setAssistedReload((value) => value + 1); }} className="mt-2 text-sm font-medium text-primary underline">Reload this appointment</button></div> : null}
        {!assistedLoading && !assistedError && (!assistedRequest || assistedRequest.appointment_id !== (appointmentFromNotification || assistedTargetAppointmentId)) ? <p className="mt-3 text-sm text-muted-foreground">There is no assisted rescheduling request for this appointment.</p> : null}
        {!assistedLoading && assistedRequest && assistedRequest.appointment_id === (appointmentFromNotification || assistedTargetAppointmentId) ? <>
          <p className="mt-2 text-sm text-muted-foreground">Dr. {assistedRequest.doctor_first_name} {assistedRequest.doctor_last_name} suggested a schedule change for your {appointmentDate(assistedRequest.previous_date)} appointment. You must choose and confirm a new time; it will not change automatically.</p>
          {assistedRequest.status === "pending_patient" && assistedRequest.appointment_status === "confirmed" && !assistedStale ? <>
            {assistedError ? null : assistedSlots.length ? <fieldset className="mt-4 grid gap-2 sm:grid-cols-2"><legend className="mb-2 text-sm font-medium text-foreground">Available saved suggestions</legend>{assistedRequest.suggestions.map((suggestion) => {
              const liveSlot = assistedSlots.find((slot) => slot.id === suggestion.availability_id);
              if (!liveSlot) return null;
              return <label key={suggestion.id} className={`flex cursor-pointer items-center gap-3 rounded-lg border p-3 text-sm ${selectedAssistedSuggestion === suggestion.id ? "border-primary bg-secondary/60" : "border-border hover:bg-muted/60"}`}><input type="radio" name={`assisted-${assistedRequest.id}`} value={suggestion.id} checked={selectedAssistedSuggestion === suggestion.id} onChange={() => setSelectedAssistedSuggestion(suggestion.id)} className="size-4 accent-primary" /><span><span className="block font-medium text-foreground">{appointmentDate(suggestion.date)} · {suggestion.mode === "wave" ? "Wave" : "Stream"}</span><span className="text-muted-foreground">{appointmentTime(suggestion.start_time)}–{appointmentTime(suggestion.end_time)} IST</span><span className="mt-1 block text-xs text-muted-foreground">{liveSlot.remaining_capacity} places currently available</span></span></label>;
            })}</fieldset> : <p className="mt-4 rounded-lg bg-muted p-3 text-sm text-muted-foreground">The saved suggestions are no longer showing available capacity. You can use regular Reschedule below to check current availability.</p>}
            <div className="mt-4 flex flex-wrap gap-3">{assistedSlots.length > 0 ? <Button type="button" disabled={!selectedAssistedSuggestion || Boolean(activeRequest)} onClick={() => setAssistedDialog("confirm")}>Choose and confirm this time</Button> : null}<Button type="button" variant="outline" disabled={Boolean(activeRequest)} onClick={() => setAssistedDialog("decline")}>Decline suggestions</Button></div>
          </> : <p className="mt-4 rounded-lg bg-muted p-3 text-sm text-muted-foreground">{assistedRequest.status === "superseded" ? "This request was superseded because the appointment was rescheduled." : assistedStale || assistedRequest.appointment_status !== "confirmed" ? "This appointment is no longer confirmed or no longer matches this request, so its suggestions cannot be booked." : assistedRequest.status === "no_alternatives" ? "No alternatives were available when the schedule changed." : assistedRequest.status === "accepted" ? "You accepted a suggested time. The appointment has been updated." : assistedRequest.status === "declined" ? "You declined this request." : assistedRequest.status === "expired" ? "This request expired when the original appointment was due to start. Check current availability before making any changes." : "This request is no longer active. Check current availability before making any changes."}</p>}
        </> : null}
      </section> : null}

      <AlertDialog open={assistedDialog !== null} onOpenChange={(open) => { if (!open && !activeRequest) setAssistedDialog(null); }}>
        <AlertDialogContent className="max-w-md rounded-2xl border border-border bg-card p-6 text-card-foreground shadow-xl ring-0 sm:max-w-md">
          <AlertDialogHeader><AlertDialogTitle>{assistedDialog === "decline" ? "Decline suggested times?" : "Confirm this new appointment time?"}</AlertDialogTitle><AlertDialogDescription>{assistedDialog === "decline" ? "You can still use the regular rescheduling options later." : "Your existing appointment will be moved to the selected time. Your appointment history will remain associated with this booking."}</AlertDialogDescription></AlertDialogHeader>
          <AlertDialogFooter className="m-0 flex-row justify-end gap-3 border-0 bg-transparent p-0"><AlertDialogCancel disabled={Boolean(activeRequest)}>Go back</AlertDialogCancel><AlertDialogAction disabled={Boolean(activeRequest)} onClick={(event) => { event.preventDefault(); const target = appointments.find((item) => item.id === assistedRequest?.appointment_id); if (assistedDialog === "decline") void declineAssistedReschedule(); else if (target) void confirmAssistedReschedule(target); }}>{activeRequest?.startsWith("assisted") ? "Saving…" : assistedDialog === "decline" ? "Decline request" : "Confirm new time"}</AlertDialogAction></AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

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
            {(appointment) => <AppointmentCard key={appointment.id} appointment={appointment} highlighted={notificationFocusId === appointment.id} isPast={(appointmentEndInstant(appointment)?.getTime() ?? Infinity) <= now} activeRequest={activeRequest} rescheduleId={rescheduleId} slots={slots} slotsLoading={slotsLoading} slotsError={slotsError} selectedSlotId={selectedSlotId} calendarMonth={rescheduleMonth} selectedDate={rescheduleDate} onSelectDate={(date) => { setRescheduleDate(date); setSelectedSlotId(""); }} onShiftMonth={(month) => void changeRescheduleMonth(appointment, month)} onCancel={() => openCancellationDialog(appointment)} onBeginReschedule={() => void beginReschedule(appointment)} onSelectSlot={setSelectedSlotId} onConfirmReschedule={() => void confirmReschedule(appointment)} onCloseReschedule={() => { setRescheduleId(null); setSlotsError(null); }} />}
          </AppointmentSection>
          <AppointmentSection title="Past appointments" empty="Your past appointments will appear here." appointments={past} hasMore={history.past.hasMore} loadingMore={history.past.loading} moreError={history.past.error} onShowMore={() => void loadMore("past")}>
            {(appointment) => <AppointmentCard key={appointment.id} appointment={appointment} highlighted={notificationFocusId === appointment.id} isPast={(appointmentEndInstant(appointment)?.getTime() ?? Infinity) <= now} activeRequest={activeRequest} rescheduleId={rescheduleId} slots={slots} slotsLoading={slotsLoading} slotsError={slotsError} selectedSlotId={selectedSlotId} calendarMonth={rescheduleMonth} selectedDate={rescheduleDate} onSelectDate={(date) => { setRescheduleDate(date); setSelectedSlotId(""); }} onShiftMonth={(month) => void changeRescheduleMonth(appointment, month)} onCancel={() => openCancellationDialog(appointment)} onBeginReschedule={() => void beginReschedule(appointment)} onSelectSlot={setSelectedSlotId} onConfirmReschedule={() => void confirmReschedule(appointment)} onCloseReschedule={() => { setRescheduleId(null); setSlotsError(null); }} />}
          </AppointmentSection>
          <AppointmentSection title="Cancelled appointments" empty="You have no cancelled appointments." appointments={cancelled} hasMore={history.cancelled.hasMore} loadingMore={history.cancelled.loading} moreError={history.cancelled.error} onShowMore={() => void loadMore("cancelled")}>
            {(appointment) => <AppointmentCard key={appointment.id} appointment={appointment} highlighted={notificationFocusId === appointment.id} isPast={(appointmentEndInstant(appointment)?.getTime() ?? Infinity) <= now} activeRequest={activeRequest} rescheduleId={rescheduleId} slots={slots} slotsLoading={slotsLoading} slotsError={slotsError} selectedSlotId={selectedSlotId} calendarMonth={rescheduleMonth} selectedDate={rescheduleDate} onSelectDate={(date) => { setRescheduleDate(date); setSelectedSlotId(""); }} onShiftMonth={(month) => void changeRescheduleMonth(appointment, month)} onCancel={() => openCancellationDialog(appointment)} onBeginReschedule={() => void beginReschedule(appointment)} onSelectSlot={setSelectedSlotId} onConfirmReschedule={() => void confirmReschedule(appointment)} onCloseReschedule={() => { setRescheduleId(null); setSlotsError(null); }} />}
          </AppointmentSection>
        </>
      ) : null}
      <AlertDialog open={cancelTarget !== null} onOpenChange={(open) => { if (!open && !activeRequest) setCancelTarget(null); }}>
        <AlertDialogContent className="max-w-md rounded-2xl border border-border bg-card p-6 text-card-foreground shadow-xl ring-0 sm:max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel appointment?</AlertDialogTitle>
            <AlertDialogDescription>This will cancel your confirmed appointment.</AlertDialogDescription>
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

function AppointmentSection({ title, empty, appointments, children, hasMore = false, loadingMore = false, moreError = null, onShowMore }: {
  title: string;
  empty: string;
  appointments: PatientAppointment[];
  children: (appointment: PatientAppointment) => React.ReactNode;
  hasMore?: boolean;
  loadingMore?: boolean;
  moreError?: string | null;
  onShowMore?: () => void;
}) {
  return (
    <section aria-label={title}>
      <h2 className="text-xl font-semibold text-foreground">{title}</h2>
      {appointments.length === 0 ? <p className="mt-4 rounded-xl bg-muted p-5 text-sm text-muted-foreground">{empty}</p> : <ul className="mt-4 space-y-4">{appointments.map(children)}</ul>}
      {moreError ? <p className="mt-3 text-sm text-destructive" role="alert">{moreError}</p> : null}
      {hasMore ? <div className="mt-4 flex justify-center"><button type="button" onClick={onShowMore} disabled={loadingMore} className="inline-flex min-h-11 items-center justify-center rounded-lg border border-border bg-card px-5 text-sm font-semibold text-foreground transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-wait disabled:opacity-60">{loadingMore ? "Loading…" : moreError ? "Try again" : "Show More"}</button></div> : null}
    </section>
  );
}

function AppointmentCard({ appointment, highlighted, isPast, activeRequest, rescheduleId, slots, slotsLoading, slotsError, selectedSlotId, calendarMonth, selectedDate, onSelectDate, onShiftMonth, onCancel, onBeginReschedule, onSelectSlot, onConfirmReschedule, onCloseReschedule }: {
  appointment: PatientAppointment;
  highlighted: boolean;
  isPast: boolean;
  activeRequest: string | null;
  rescheduleId: string | null;
  slots: AvailabilitySlot[];
  slotsLoading: boolean;
  slotsError: string | null;
  selectedSlotId: string;
  calendarMonth: string;
  selectedDate: string;
  onSelectDate: (date: string) => void;
  onShiftMonth: (month: string) => void;
  onCancel: () => void;
  onBeginReschedule: () => void;
  onSelectSlot: (slotId: string) => void;
  onConfirmReschedule: () => void;
  onCloseReschedule: () => void;
}) {
  const isBusy = activeRequest?.endsWith(appointment.id) ?? false;
  const rescheduling = rescheduleId === appointment.id;
  const dateSlots = slots.filter((slot) => slot.date === selectedDate);

  return (
    <li id={`appointment-${appointment.id}`} className={`rounded-2xl border bg-card p-5 shadow-sm sm:p-6 ${highlighted ? "border-primary" : "border-border"}`}>
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
        <div>
          <p className="font-semibold text-card-foreground">Dr. {appointment.doctor_first_name} {appointment.doctor_last_name}</p>
          <p className="mt-1 text-sm text-primary">{appointment.specialty}</p>
          <div className="mt-4 flex items-start gap-2 text-sm text-foreground">
            <CalendarClock aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <span>{appointmentDate(appointment.date)} · {appointmentTime(appointment.start_time)}–{appointmentTime(appointment.end_time)} IST</span>
          </div>
          {appointment.mode ? <p className="mt-2 text-sm text-muted-foreground">{appointment.mode === "wave" ? `Wave · ${Math.round((new Date(`1970-01-01T${appointment.end_time}Z`).getTime() - new Date(`1970-01-01T${appointment.start_time}Z`).getTime()) / 60_000)} minutes` : "Stream · continuous window"}</p> : null}
          {appointment.reason ? <p className="mt-3 text-sm leading-6 text-muted-foreground"><span className="font-medium text-foreground">Reason:</span> {appointment.reason}</p> : null}
          {/* <p className="mt-2 text-xs text-muted-foreground">Appointment ID: {appointment.id}</p> */}
        </div>
        <span className={`inline-flex w-fit rounded-full px-3 py-1 text-xs font-semibold ${statusClasses(appointment.status)}`}>{appointment.status === "confirmed" && isPast ? "Awaiting completion" : appointment.status}</span>
      </div>

      <p className="mt-3 text-sm text-muted-foreground">Consultation fee: {appointment.consultation_fee != null ? inrFormatter.format(Number(appointment.consultation_fee)) : "Unavailable"}</p>

      {appointment.status === "confirmed" && !isPast ? (
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
          <p className="mt-1 text-xs text-muted-foreground">Choose an available date, then select a time · IST</p>
          {slotsLoading ? <p className="mt-4 text-sm text-muted-foreground" role="status">Loading available times…</p> : null}
          {!slotsLoading && slotsError ? <div className="mt-4 rounded-lg bg-destructive/5 p-3" role="alert"><p className="text-sm text-foreground">{slotsError}</p><button type="button" onClick={onBeginReschedule} disabled={Boolean(activeRequest)} className="mt-3 inline-flex min-h-9 items-center gap-2 rounded-lg border border-border px-3 text-sm font-medium text-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-60"><RefreshCw aria-hidden="true" className="size-4" /> Refresh available times</button></div> : null}
          {!slotsLoading && !slotsError && slots.length === 0 ? <p className="mt-4 text-sm text-muted-foreground">No replacement times are available for this doctor.</p> : null}
          {!slotsLoading && !slotsError ? <AppointmentAvailabilityCalendar slots={slots} month={calendarMonth} selectedDate={selectedDate} onSelectDate={onSelectDate} onShiftMonth={onShiftMonth} /> : null}
          {!slotsLoading && !slotsError && dateSlots.length > 0 ? <fieldset className="mt-4 grid gap-2 sm:grid-cols-2"><legend className="sr-only">Available replacement times</legend>{dateSlots.map((slot) => <label key={slot.id} className={`flex cursor-pointer items-center gap-3 rounded-lg border p-3 text-sm ${selectedSlotId === slot.id ? "border-primary bg-secondary/60" : "border-border hover:bg-muted/60"}`}><input type="radio" name={`reschedule-${appointment.id}`} value={slot.id} checked={selectedSlotId === slot.id} onChange={() => onSelectSlot(slot.id)} className="size-4 accent-primary" /><span><span className="block font-medium text-foreground">{slot.mode === "stream" ? "Stream · continuous window" : "Wave"}</span><span className="text-muted-foreground">{appointmentTime(slot.start_time)}–{appointmentTime(slot.end_time)} IST</span><span className="mt-1 block text-xs text-muted-foreground">{slot.remaining_capacity ?? 0} of {slot.capacity ?? 0} places remaining</span></span></label>)}</fieldset> : null}
          <Button type="button" size="compact" disabled={!selectedSlotId || Boolean(activeRequest)} onClick={onConfirmReschedule} className="mt-4">
            {activeRequest === `reschedule:${appointment.id}` ? "Rescheduling…" : <><CheckCircle2 aria-hidden="true" className="size-4" /> Confirm new time</>}
          </Button>
        </div>
      ) : null}
      {isBusy ? <span className="sr-only" role="status">Updating appointment</span> : null}
      {!appointmentEndInstant(appointment) ? <span className="sr-only">Appointment time could not be interpreted.</span> : null}
    </li>
  );
}
