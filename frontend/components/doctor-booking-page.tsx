"use client";

import { useAuth } from "@clerk/nextjs";
import { ArrowLeft, CalendarClock, CheckCircle2, ChevronLeft, ChevronRight, RefreshCw, Stethoscope } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { z } from "zod";
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
import { notifyInAppNotificationsChanged, notifySuccess } from "@/lib/notifications";
import { AppShellLoading } from "@/components/app-shell-loading";
import { CheckoutReturnNotice, type CheckoutReturnState } from "@/components/checkout-return-notice";
import { cancelAppointmentPaymentOrder, createAppointmentPaymentOrder, getAppointmentPaymentStatus, getDoctor, getDoctorSlots, ProfileApiError, type AvailabilitySlot, type DirectoryDoctor, type PatientAppointment } from "@/lib/profile-api";
import { formatDateOnly } from "@/lib/date-format";

const APPLICATION_TIME_ZONE = "Asia/Kolkata";
const inrFormatter = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 });

function dateInApplicationZone(date: Date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: APPLICATION_TIME_ZONE,
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function getMonthRange(month: string) {
  const [year, monthNumber] = month.split("-").map(Number);
  const from = month;
  const to = new Date(Date.UTC(year, monthNumber, 0)).toISOString().slice(0, 10);
  return { from, to };
}

function calendarCells(month: string) {
  const [year, monthNumber] = month.split("-").map(Number);
  const firstWeekday = new Date(Date.UTC(year, monthNumber - 1, 1)).getUTCDay();
  const daysInMonth = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  const monthKey = month.slice(0, 7);
  return [...Array.from({ length: firstWeekday }, () => null), ...Array.from({ length: daysInMonth }, (_, index) => `${monthKey}-${String(index + 1).padStart(2, "0")}`)];
}

function formatMonth(month: string) {
  const [year, monthNumber] = month.split("-").map(Number);
  return new Intl.DateTimeFormat("en-IN", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(year, monthNumber - 1, 1)));
}

function shiftMonth(month: string, offset: number) {
  const [year, monthNumber] = month.split("-").map(Number);
  return new Date(Date.UTC(year, monthNumber - 1 + offset, 1)).toISOString().slice(0, 7) + "-01";
}

function applicationDateTime(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: APPLICATION_TIME_ZONE,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return { date: `${values.year}-${values.month}-${values.day}`, time: `${values.hour}:${values.minute}` };
}

function isBookableInMonth(slot: AvailabilitySlot, from: string, to: string, now: { date: string; time: string }) {
  if (slot.mode !== "wave" && slot.mode !== "stream") return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(slot.date) || slot.date < from || slot.date > to) return false;
  if ((slot.capacity ?? 0) <= 0 || (slot.remaining_capacity ?? 0) <= 0) return false;
  return slot.date > now.date || (slot.date === now.date && slot.start_time.slice(0, 5) > now.time);
}

function formatSlotDate(date: string) {
  return formatDateOnly(date);
}

function formatSlotTime(time: string) {
  const [hourText, minute] = time.split(":");
  const hour = Number(hourText);
  return `${hour % 12 || 12}:${minute} ${hour >= 12 ? "PM" : "AM"}`;
}

function formatBookingError(error: unknown) {
  if (error instanceof ProfileApiError && error.code === "DUPLICATE_BOOKING") {
    return "You already have an active booking or pending checkout for this time slot.";
  }
  if (error instanceof ProfileApiError && error.code === "SLOT_CAPACITY_REACHED") {
    return "This availability option has reached capacity. Choose another time with places remaining.";
  }
  if (error instanceof ProfileApiError && error.code === "CHECKOUT_WINDOW_UNAVAILABLE") return error.message;
  if (error instanceof ProfileApiError && error.code === "SLOT_UNAVAILABLE") {
    return "That slot is no longer available. Refresh availability and choose another time.";
  }
  return error instanceof Error ? error.message : "We couldn't complete your booking. Please try again.";
}

export function DoctorBookingPage({ doctorId }: { doctorId: string }) {
  const { getToken } = useAuth();
  const pathname = usePathname();
  const [doctor, setDoctor] = useState<DirectoryDoctor | null>(null);
  const [slots, setSlots] = useState<AvailabilitySlot[]>([]);
  const [calendarMonth, setCalendarMonth] = useState(() => `${dateInApplicationZone(new Date()).slice(0, 7)}-01`);
  const [selectedDate, setSelectedDate] = useState(() => dateInApplicationZone(new Date()));
  const [selectedSlotId, setSelectedSlotId] = useState("");
  const [reason, setReason] = useState("");
  const [loading, setLoading] = useState(true);
  const [availabilityLoading, setAvailabilityLoading] = useState(true);
  const [availabilityError, setAvailabilityError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState(0);
  const [booking, setBooking] = useState(false);
  const [bookingError, setBookingError] = useState<string | null>(null);
  const [bookingDialogOpen, setBookingDialogOpen] = useState(false);
  const [confirmation, setConfirmation] = useState<PatientAppointment | null>(null);
  const [paymentPendingId, setPaymentPendingId] = useState<string | null>(null);
  const [checkoutReturn, setCheckoutReturn] = useState<CheckoutReturnState>(null);
  const [checkingPayment, setCheckingPayment] = useState(false);
  const [, startTransition] = useTransition();
  const submissionInProgress = useRef(false);
  const bookingErrorRef = useRef<HTMLDivElement>(null);
  const paymentCheckInProgress = useRef(false);
  const availabilityRequestVersion = useRef(0);
  const checkoutReturnProcessed = useRef(false);
  const announcedConfirmation = useRef<string | null>(null);

  const refreshAvailability = useCallback(() => {
    setAvailabilityLoading(true);
    setAvailabilityError(null);
    setRetryKey((key) => key + 1);
  }, []);

  useEffect(() => {
    if (!confirmation || announcedConfirmation.current === confirmation.id) return;
    announcedConfirmation.current = confirmation.id;
    notifyInAppNotificationsChanged();
    notifySuccess("Appointment booked successfully!", `appointment-booked-${confirmation.id}`);
  }, [confirmation]);

  useEffect(() => {
    const handleRefreshAvailability = () => {
      if (document.visibilityState === "visible") {
        refreshAvailability();
      }
    };
    window.addEventListener("focus", handleRefreshAvailability);
    document.addEventListener("visibilitychange", handleRefreshAvailability);
    return () => {
      window.removeEventListener("focus", handleRefreshAvailability);
      document.removeEventListener("visibilitychange", handleRefreshAvailability);
    };
  }, [refreshAvailability]);

  const routeKey = `${pathname}:${doctorId}`;
  const [previousRouteKey, setPreviousRouteKey] = useState(routeKey);
  if (previousRouteKey !== routeKey) {
    setPreviousRouteKey(routeKey);
    setConfirmation(null);
    setBookingDialogOpen(false);
    setSelectedSlotId("");
    setAvailabilityLoading(true);
    setCalendarMonth(`${dateInApplicationZone(new Date()).slice(0, 7)}-01`);
    setSelectedDate(dateInApplicationZone(new Date()));
    setBookingError(null);
    setReason("");
    setLoading(true);
    setLoadError(null);
  }

  useEffect(() => {
    if (!pathname.startsWith("/patient/doctors/")) return;
    let active = true;
    const load = async () => {
      try {
        const token = await getToken();
        if (!token) throw new Error("Your session could not be verified. Please try again.");
        const loadedDoctor = await getDoctor(token, doctorId);
        if (active) setDoctor(loadedDoctor);
      } catch (error) {
        if (active) setLoadError(error instanceof Error ? error.message : "We couldn't load this doctor's details.");
      } finally {
        if (active) setLoading(false);
      }
    };
    void load();
    return () => { active = false; };
  }, [doctorId, getToken, pathname, retryKey]);

  useEffect(() => {
    if (!pathname.startsWith("/patient/doctors/")) return;
    let active = true;
    const requestVersion = ++availabilityRequestVersion.current;
    const isCurrentRequest = () => active && requestVersion === availabilityRequestVersion.current;
    const load = async () => {
      try {
        const token = await getToken();
        if (!token) throw new Error("Your session could not be verified. Please try again.");
        const range = getMonthRange(calendarMonth);
        const result = await getDoctorSlots(token, doctorId, range.from, range.to);
        if (isCurrentRequest()) {
          const now = applicationDateTime();
          const available = result.filter((slot) => isBookableInMonth(slot, range.from, range.to, now));
          setSlots(available);
          setSelectedDate((current) => current >= range.from && current <= range.to ? current : available[0]?.date ?? current);
          setSelectedSlotId((current) => available.some((slot) => slot.id === current) ? current : "");
          setAvailabilityError(null);
        }
      } catch (error) {
        if (isCurrentRequest()) setAvailabilityError(error instanceof Error ? error.message : "We couldn't refresh availability for this month.");
      } finally {
        if (isCurrentRequest()) setAvailabilityLoading(false);
      }
    };
    void load();
    return () => { active = false; };
  }, [calendarMonth, doctorId, getToken, pathname, retryKey]);

  async function handleBooking(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedSlotId || !slots.some((slot) => slot.id === selectedSlotId) || submissionInProgress.current) return;

    setBookingError(null);
    setBookingDialogOpen(true);
  }

  async function confirmBooking() {
    if (!selectedSlotId || submissionInProgress.current) return;

    submissionInProgress.current = true;
    setBooking(true);
    setBookingDialogOpen(false);
    setBookingError(null);
    try {
      const token = await getToken();
      if (!token) throw new Error("Your session could not be verified. Please sign in again.");
      const order = await createAppointmentPaymentOrder(token, selectedSlotId, reason.trim() || undefined, crypto.randomUUID());
      window.location.assign(order.checkout_url);
    } catch (error) {
      setBookingError(formatBookingError(error));
    } finally {
      submissionInProgress.current = false;
      setBooking(false);
    }
  }

  const checkPaymentStatus = useCallback(async (requestedPaymentId: string | null, preserveReturnMessage = false) => {
    if (!requestedPaymentId || paymentCheckInProgress.current) return;
    paymentCheckInProgress.current = true;
    setCheckingPayment(true);
    try {
      const token = await getToken();
      if (!token) throw new Error("Your session could not be verified. Please sign in again.");
      const status = await getAppointmentPaymentStatus(token, requestedPaymentId);
      if (status.appointment) {
        setConfirmation(status.appointment);
        setPaymentPendingId(null);
        setCheckoutReturn(null);
        setSelectedSlotId("");
        setBookingError(null);
        refreshAvailability();
      } else if (status.status === "failed" || status.status === "cancelled" || status.status === "expired") {
        setPaymentPendingId(null);
        setCheckoutReturn("cancelled");
        setBookingError("Payment was not completed. Your appointment is not confirmed. You can choose a time and try again.");
        refreshAvailability();
      } else if (status.status === "captured") {
        setPaymentPendingId(null);
        setCheckoutReturn("captured");
        setBookingError(`Your payment was received, but the appointment could not be confirmed. Contact Medrella support${status.reconciliation_id ? ` with reference ${status.reconciliation_id}` : ""}.`);
        refreshAvailability();
      } else {
        setBookingError(preserveReturnMessage
          ? "You returned from Checkout. Payment is still being verified. Your appointment is not confirmed yet."
          : "Payment is still being verified. Check again in a few seconds.");
        refreshAvailability();
      }
    } catch (error) {
      setBookingError(formatBookingError(error));
    } finally {
      setCheckingPayment(false);
      paymentCheckInProgress.current = false;
    }
  }, [getToken, refreshAvailability]);

  useEffect(() => {
    if (checkoutReturnProcessed.current) return;
    const query = new URLSearchParams(window.location.search);
    const returnedPaymentId = query.get("payment_id");
    if (!returnedPaymentId || !z.string().uuid().safeParse(returnedPaymentId).success) return;
    checkoutReturnProcessed.current = true;
    startTransition(() => setPaymentPendingId(returnedPaymentId));
    if (query.get("checkout") === "cancelled") {
      startTransition(() => {
        setCheckoutReturn("cancelling");
        setBookingError("You returned from Checkout. We’re checking whether payment completed. Your appointment is not confirmed yet.");
      });
      void getToken().then(async (token) => {
        if (!token) throw new Error("Your session could not be verified. Please sign in again.");
        await cancelAppointmentPaymentOrder(token, returnedPaymentId);
        await checkPaymentStatus(returnedPaymentId, true);
      }).catch((error) => {
        setBookingError(error instanceof Error ? error.message : "You returned from Checkout. We couldn't verify payment yet. Your appointment is not confirmed.");
      });
    } else if (query.has("session_id")) {
      startTransition(() => {
        setCheckoutReturn("success");
        setBookingError("Checkout returned to Medrella. We’re verifying payment; this redirect does not confirm an appointment.");
      });
      queueMicrotask(() => void checkPaymentStatus(returnedPaymentId));
    }
  }, [checkPaymentStatus, doctorId, getToken, pathname, startTransition]);

  const selectedSlot = slots.find((slot) => slot.id === selectedSlotId) ?? null;
  const selectedDaySlots = slots.filter((slot) => slot.date === selectedDate);
  const slotsByDate = slots.reduce<Record<string, number>>((counts, slot) => { counts[slot.date] = (counts[slot.date] ?? 0) + 1; return counts; }, {});
  const calendarDates = calendarCells(calendarMonth);
  while (calendarDates.length % 7 !== 0) calendarDates.push(null);
  const todayDate = applicationDateTime().date;
  const todayMonth = `${todayDate.slice(0, 7)}-01`;

  useEffect(() => {
    if (!bookingError || checkoutReturn) return;
    bookingErrorRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    bookingErrorRef.current?.focus({ preventScroll: true });
  }, [bookingError, checkoutReturn]);

  if (booking) return <AppShellLoading message="Redirecting to secure checkout…" />;

  function retryLoading() {
    if (!doctor) setLoading(true);
    if (!doctor) setLoadError(null);
    setBookingError(null);
    refreshAvailability();
    if (!doctor) setRetryKey((key) => key + 1);
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <Link href="/patient/book-appointment" className="inline-flex min-h-10 items-center gap-2 rounded-lg text-sm font-medium text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring">
        <ArrowLeft aria-hidden="true" className="size-4" /> Back to doctor directory
      </Link>

      {loading ? <p className="rounded-2xl bg-muted p-6 text-sm text-muted-foreground" role="status">Loading doctor and available times…</p> : null}

      {!loading && loadError ? (
        <section className="rounded-2xl border border-destructive/40 bg-destructive/5 p-6" role="alert">
          <h1 className="text-xl font-semibold text-foreground">Doctor details unavailable</h1>
          <p className="mt-2 text-sm text-foreground">{loadError}</p>
          <button type="button" onClick={retryLoading} className="mt-4 inline-flex min-h-10 items-center gap-2 rounded-lg border border-border px-4 text-sm font-medium text-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
            <RefreshCw aria-hidden="true" className="size-4" /> Try again
          </button>
        </section>
      ) : null}

      {!loading && !loadError && doctor ? (
        <>
          <section className="rounded-3xl border border-border bg-card p-6 shadow-sm sm:p-8">
            <div className="flex items-start gap-4">
              <span aria-hidden="true" className="flex size-14 shrink-0 items-center justify-center rounded-2xl bg-secondary text-secondary-foreground"><Stethoscope className="size-7" /></span>
              <div>
                <p className="text-sm font-semibold uppercase tracking-[0.14em] text-primary">Doctor profile</p>
                <h1 className="mt-1 text-2xl font-semibold tracking-tight text-card-foreground sm:text-3xl">Dr. {doctor.first_name} {doctor.last_name}</h1>
                <p className="mt-2 font-medium text-primary">{doctor.specialty}</p>
                <p className="mt-2 font-semibold text-foreground">Consultation fee: {inrFormatter.format(doctor.consultation_fee)}</p>
              </div>
            </div>
            {doctor.bio?.trim() ? <p className="mt-6 whitespace-pre-line leading-7 text-muted-foreground">{doctor.bio.trim()}</p> : <p className="mt-6 text-sm text-muted-foreground">No biography is available.</p>}
          </section>

          <CheckoutReturnNotice
            state={checkoutReturn}
            paymentPendingId={paymentPendingId}
            message={bookingError}
            statusAction={paymentPendingId ? (
              <Button type="button" className="mt-4" disabled={checkingPayment} onClick={() => void checkPaymentStatus(paymentPendingId, checkoutReturn === "cancelling")}>
                {checkingPayment ? "Checking…" : "Check payment status"}
              </Button>
            ) : null}
          />
          {confirmation ? (
            <section className="rounded-3xl border border-border bg-card p-6 shadow-sm sm:p-8" aria-live="polite" aria-labelledby="booking-confirmation-title">
              <div className="flex items-center gap-3">
                <CheckCircle2 aria-hidden="true" className="size-7 text-primary" />
                <h2 id="booking-confirmation-title" className="text-xl font-semibold text-card-foreground">Appointment confirmed</h2>
              </div>
              <p className="mt-4 text-foreground">Dr. {confirmation.doctor_first_name} {confirmation.doctor_last_name} · {confirmation.specialty}</p>
              <p className="mt-1 text-sm text-muted-foreground">{formatSlotDate(confirmation.date)} at {formatSlotTime(confirmation.start_time)} IST</p>
              <p className="mt-3 text-sm text-muted-foreground">Confirmation ID: {confirmation.id}</p>
            </section>
          ) : null}
          <section className="rounded-3xl border border-border bg-card p-6 shadow-sm sm:p-8" aria-labelledby="available-times-title">
            <div className="flex items-center gap-3"><CalendarClock aria-hidden="true" className="size-5 text-primary" /><h2 id="available-times-title" className="text-xl font-semibold text-card-foreground">Choose an appointment date</h2></div>
            <p className="mt-2 text-sm text-muted-foreground">Dates with availability are marked in the calendar.</p>
            <div className="mt-5 rounded-2xl border border-border p-4 sm:p-5" aria-label="Appointment availability calendar">
              <div className="flex items-center justify-between gap-3"><button type="button" aria-label="Previous month" disabled={calendarMonth <= todayMonth} onClick={() => { const next = shiftMonth(calendarMonth, -1); setAvailabilityLoading(true); setCalendarMonth(next); setSelectedSlotId(""); setSlots([]); setLoadError(null); }} className="inline-flex size-10 items-center justify-center rounded-lg border border-border hover:bg-muted disabled:opacity-40"><ChevronLeft aria-hidden="true" className="size-4" /></button><h3 className="font-semibold text-foreground" aria-live="polite">{formatMonth(calendarMonth)}</h3><button type="button" aria-label="Next month" onClick={() => { const next = shiftMonth(calendarMonth, 1); setAvailabilityLoading(true); setCalendarMonth(next); setSelectedSlotId(""); setSlots([]); setLoadError(null); }} className="inline-flex size-10 items-center justify-center rounded-lg border border-border hover:bg-muted"><ChevronRight aria-hidden="true" className="size-4" /></button></div>
              <div className="mt-4 grid grid-cols-7 gap-1 text-center text-xs font-medium text-muted-foreground">{["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((day) => <span key={day} className="py-2">{day}</span>)}</div>
              <div className="grid grid-cols-7 justify-items-center gap-1">{calendarDates.map((day, index) => { if (!day) return <span key={`blank-${index}`} aria-hidden="true" className="size-10" />; const count = slotsByDate[day] ?? 0; const selected = day === selectedDate; const today = day === todayDate; const past = day < todayDate; return <button key={day} type="button" disabled={!count || past} aria-label={`${formatSlotDate(day)}${count ? `, ${count} available ${count === 1 ? "option" : "options"}` : ", no availability"}`} aria-pressed={selected} onClick={() => { setSelectedDate(day); setSelectedSlotId(""); setBookingError(null); }} className={`relative flex size-10 flex-col items-center justify-center rounded-lg text-xs transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring ${today ? "ring-2 ring-inset ring-ring" : ""} ${selected ? "bg-primary font-semibold text-primary-foreground" : count ? "bg-secondary/60 font-medium text-secondary-foreground hover:bg-secondary" : "cursor-not-allowed text-muted-foreground/60"}`}><span>{Number(day.slice(-2))}</span>{count ? <span className={`text-[9px] leading-none ${selected ? "text-primary-foreground" : "text-muted-foreground"}`}>{count}</span> : null}</button>; })}</div>
            </div>
            {availabilityLoading ? <p className="mt-4 text-sm text-muted-foreground" role="status">Loading this month’s availability…</p> : null}
            {/* <div className="mt-5 flex flex-wrap items-center gap-2"><h3 className="mr-auto text-base font-semibold text-card-foreground">{formatSlotDate(selectedDate)}</h3><span className="rounded-full bg-secondary/70 px-2.5 py-1 text-xs font-medium text-secondary-foreground">Wave</span><span className="rounded-full bg-muted px-2.5 py-1 text-xs font-medium text-muted-foreground">Stream</span></div> */}
            {availabilityError ? <p className="mt-3 rounded-xl border border-destructive/30 bg-destructive/5 p-3 text-sm text-foreground" role="status">Availability could not be refreshed. Showing the last loaded options.</p> : null}
            {!availabilityLoading && selectedDaySlots.length === 0 ? <p className="mt-3 rounded-xl bg-muted p-4 text-sm leading-6 text-muted-foreground">No availability on this date. Select another marked date or browse a different month.</p> : null}
            {selectedDaySlots.length > 0 ? (
              <form className="mt-4 space-y-5" onSubmit={handleBooking}>
                <fieldset>
                  <legend className="mb-3 text-sm font-semibold text-foreground">Available appointment options</legend>
                  <div className="grid gap-3 sm:grid-cols-2">
                    {selectedDaySlots.map((slot) => (
                      <label key={slot.id} className={`flex min-h-16 cursor-pointer items-center gap-3 rounded-xl border p-4 transition-colors focus-within:ring-2 focus-within:ring-ring ${selectedSlotId === slot.id ? "border-primary bg-secondary/60" : "border-border bg-background hover:bg-muted/60"}`}>
                        <input className="size-4 accent-primary" type="radio" name="availability" value={slot.id} checked={selectedSlotId === slot.id} onChange={() => { setSelectedSlotId(slot.id); setBookingError(null); }} />
                        <span className="min-w-0"><span className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium ${slot.mode === "wave" ? "bg-secondary text-secondary-foreground" : "bg-muted text-muted-foreground"}`}>{slot.mode === "wave" ? "Wave" : "Stream"}</span><span className="mt-1 block text-sm text-muted-foreground">{slot.mode === "stream" ? "Continuous window · " : ""}{formatSlotTime(slot.start_time)}–{formatSlotTime(slot.end_time)} IST</span>{slot.remaining_capacity != null && slot.capacity != null ? <span className="mt-1 block text-xs text-muted-foreground">{slot.remaining_capacity} of {slot.capacity} places remaining{slot.mode === "stream" ? " in this window" : " in this slot"}</span> : null}</span>
                      </label>
                    ))}
                  </div>
                </fieldset>

                <div>
                  <label htmlFor="appointment-reason" className="mb-2 block text-sm font-medium text-foreground">Reason for visit <span className="font-normal text-muted-foreground">(optional)</span></label>
                  <textarea id="appointment-reason" value={reason} onChange={(event) => setReason(event.target.value)} maxLength={2000} rows={3} className="w-full rounded-xl border border-input bg-background px-3 py-2 text-foreground shadow-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring" placeholder="Share anything you'd like the doctor to know." />
                  <p className="mt-1 text-right text-xs text-muted-foreground">{reason.length}/2000</p>
                </div>

                {bookingError && !checkoutReturn ? (
                  <div ref={bookingErrorRef} tabIndex={-1} className="scroll-mt-6 rounded-xl border border-destructive/40 bg-destructive/5 p-4 outline-none focus-visible:ring-2 focus-visible:ring-ring" role="alert" aria-live="assertive">
                    <p className="text-sm text-foreground">{bookingError}</p>
                    {bookingError.includes("no longer available") || bookingError.includes("reached capacity") ? <button type="button" onClick={retryLoading} className="mt-3 inline-flex min-h-9 items-center gap-2 rounded-lg border border-border px-3 text-sm font-medium text-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"><RefreshCw aria-hidden="true" className="size-4" /> Refresh available times</button> : null}
                  </div>
                ) : null}

                <Button type="submit" size="lg" disabled={!selectedSlotId || booking}>
                  Confirm appointment
                </Button>
              </form>
            ) : null}
          </section>

          <AlertDialog open={bookingDialogOpen} onOpenChange={(open) => {
            if (!booking) setBookingDialogOpen(open);
          }}>
            <AlertDialogContent className="max-w-md rounded-2xl border border-border bg-card p-6 text-card-foreground shadow-xl ring-0 sm:max-w-md">
              <AlertDialogHeader>
                <AlertDialogTitle>Confirm appointment?</AlertDialogTitle>
                <AlertDialogDescription>
                  Review your appointment details before confirming.
                </AlertDialogDescription>
              </AlertDialogHeader>
              {selectedSlot ? (
                <dl className="space-y-3 rounded-xl bg-muted p-4 text-sm">
                  <div>
                    <dt className="text-muted-foreground">Doctor</dt>
                    <dd className="mt-1 font-medium text-foreground">Dr. {doctor.first_name} {doctor.last_name}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Appointment time</dt>
                    <dd className="mt-1 font-medium text-foreground">{formatSlotDate(selectedSlot.date)} · {formatSlotTime(selectedSlot.start_time)}–{formatSlotTime(selectedSlot.end_time)} IST</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Consultation fee</dt>
                    <dd className="mt-1 font-semibold text-foreground">{inrFormatter.format(doctor.consultation_fee)}</dd>
                  </div>
                </dl>
              ) : null}
              {/* <p className="text-sm text-muted-foreground">Pay in Stripe Test Mode. Your selected slot is held for up to 40 minutes while Checkout is in progress.</p> */}
              {bookingError ? <p className="text-sm text-destructive" role="alert">{bookingError}</p> : null}
              <AlertDialogFooter className="m-0 flex-row justify-end gap-3 border-0 bg-transparent p-0">
                <AlertDialogCancel disabled={booking}>Go back</AlertDialogCancel>
                <AlertDialogAction disabled={!selectedSlot || booking} onClick={(event) => {
                  event.preventDefault();
                  void confirmBooking();
                }}>{booking ? "Opening checkout…" : `Pay ${inrFormatter.format(doctor.consultation_fee)}`}</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </>
      ) : null}
    </div>
  );
}
