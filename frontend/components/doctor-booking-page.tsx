"use client";

import { useAuth } from "@clerk/nextjs";
import { ArrowLeft, CalendarClock, CheckCircle2, RefreshCw, Stethoscope } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
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
import { cancelAppointmentPaymentOrder, createAppointmentPaymentOrder, getAppointmentPaymentStatus, getDoctor, getDoctorSlots, ProfileApiError, type AvailabilitySlot, type DirectoryDoctor, type PatientAppointment } from "@/lib/profile-api";

const APPLICATION_TIME_ZONE = "Asia/Kolkata";
const BOOKING_WINDOW_DAYS = 30;
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

function getSlotRange() {
  const from = dateInApplicationZone(new Date());
  const [year, month, day] = from.split("-").map(Number);
  const to = new Date(Date.UTC(year, month - 1, day + BOOKING_WINDOW_DAYS)).toISOString().slice(0, 10);
  return { from, to };
}

function slotInstant(slot: Pick<AvailabilitySlot, "date" | "start_time">) {
  const instant = new Date(`${slot.date}T${slot.start_time}+05:30`);
  return Number.isNaN(instant.getTime()) ? null : instant;
}

function formatSlotDate(date: string) {
  const [year, month, day] = date.split("-").map(Number);
  return new Intl.DateTimeFormat("en-IN", {
    dateStyle: "full",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year, month - 1, day)));
}

function formatSlotTime(time: string) {
  const [hourText, minute] = time.split(":");
  const hour = Number(hourText);
  return `${hour % 12 || 12}:${minute} ${hour >= 12 ? "PM" : "AM"}`;
}

function formatBookingError(error: unknown) {
  if (error instanceof ProfileApiError && error.code === "CHECKOUT_WINDOW_UNAVAILABLE") return error.message;
  if (error instanceof ProfileApiError && error.status === 409) {
    return "That slot is no longer available. Refresh availability and choose another time.";
  }
  return error instanceof Error ? error.message : "We couldn't complete your booking. Please try again.";
}

export function DoctorBookingPage({ doctorId }: { doctorId: string }) {
  const { getToken } = useAuth();
  const pathname = usePathname();
  const [doctor, setDoctor] = useState<DirectoryDoctor | null>(null);
  const [slots, setSlots] = useState<AvailabilitySlot[]>([]);
  const [selectedSlotId, setSelectedSlotId] = useState("");
  const [reason, setReason] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState(0);
  const [booking, setBooking] = useState(false);
  const [bookingError, setBookingError] = useState<string | null>(null);
  const [bookingDialogOpen, setBookingDialogOpen] = useState(false);
  const [confirmation, setConfirmation] = useState<PatientAppointment | null>(null);
  const [paymentPendingId, setPaymentPendingId] = useState<string | null>(null);
  const [checkingPayment, setCheckingPayment] = useState(false);
  const [, startTransition] = useTransition();
  const submissionInProgress = useRef(false);

  const routeKey = `${pathname}:${doctorId}`;
  const [previousRouteKey, setPreviousRouteKey] = useState(routeKey);
  if (previousRouteKey !== routeKey) {
    setPreviousRouteKey(routeKey);
    setConfirmation(null);
    setBookingDialogOpen(false);
    setSelectedSlotId("");
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
        const { from, to } = getSlotRange();
        const loadedSlots = await getDoctorSlots(token, doctorId, from, to);
        if (active) {
          setDoctor(loadedDoctor);
          setSlots(loadedSlots.filter((slot) => {
            const instant = slotInstant(slot);
            return instant !== null && instant.getTime() > Date.now();
          }));
        }
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
    const query = new URLSearchParams(window.location.search);
    const returnedPaymentId = query.get("payment_id");
    if (!returnedPaymentId) return;
    startTransition(() => setPaymentPendingId(returnedPaymentId));
    if (query.get("checkout") === "cancelled") {
      startTransition(() => setBookingError("Closing the Checkout Session and checking its payment status…"));
      void getToken().then(async (token) => {
        if (token) await cancelAppointmentPaymentOrder(token, returnedPaymentId);
      }).catch(() => {});
    } else if (query.has("session_id")) {
      startTransition(() => setBookingError("Checkout returned to Medrella. Verify the payment status below; the redirect itself does not confirm an appointment."));
    }
  }, [doctorId, getToken, pathname, startTransition]);

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
    setBookingError(null);
    try {
      const token = await getToken();
      if (!token) throw new Error("Your session could not be verified. Please sign in again.");
      const order = await createAppointmentPaymentOrder(token, selectedSlotId, reason.trim() || undefined, crypto.randomUUID());
      setBookingDialogOpen(false);
      setPaymentPendingId(order.payment_id);
      window.location.assign(order.checkout_url);
    } catch (error) {
      setBookingError(formatBookingError(error));
    } finally {
      submissionInProgress.current = false;
      setBooking(false);
    }
  }

  async function checkPaymentStatus() {
    if (!paymentPendingId || checkingPayment) return;
    setCheckingPayment(true);
    try {
      const token = await getToken();
      if (!token) throw new Error("Your session could not be verified. Please sign in again.");
      const status = await getAppointmentPaymentStatus(token, paymentPendingId);
      if (status.appointment) {
        setConfirmation(status.appointment);
        setPaymentPendingId(null);
        setSlots((current) => current.filter((slot) => slot.id !== status.appointment?.availability_id));
        setBookingError(null);
      } else if (status.status === "failed" || status.status === "cancelled" || status.status === "expired") {
        setPaymentPendingId(null);
        setBookingError("This payment attempt did not complete. Select the appointment time again to retry.");
        setRetryKey((key) => key + 1);
      } else if (status.status === "captured") {
        setPaymentPendingId(null);
        setBookingError(`Your payment was received, but the appointment could not be confirmed. Contact Medrella support${status.reconciliation_id ? ` with reference ${status.reconciliation_id}` : ""}.`);
      } else {
        setBookingError("Payment is still being verified. Check again in a few seconds.");
      }
    } catch (error) {
      setBookingError(formatBookingError(error));
    } finally {
      setCheckingPayment(false);
    }
  }

  const selectedSlot = slots.find((slot) => slot.id === selectedSlotId) ?? null;

  function retryLoading() {
    setLoading(true);
    setLoadError(null);
    setBookingError(null);
    setSelectedSlotId("");
    setRetryKey((key) => key + 1);
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

          {paymentPendingId ? (
            <section className="rounded-2xl border border-border bg-card p-5" aria-live="polite">
              <h2 className="font-semibold text-card-foreground">Payment verification pending</h2>
              <p className="mt-2 text-sm text-muted-foreground">We’re waiting for Stripe to confirm the payment. The return redirect does not confirm the appointment; Stripe payment status is checked server-side.</p>
              <Button type="button" className="mt-4" disabled={checkingPayment} onClick={() => void checkPaymentStatus()}>
                {checkingPayment ? "Checking…" : "Check payment status"}
              </Button>
            </section>
          ) : null}

          <section className="rounded-3xl border border-border bg-card p-6 shadow-sm sm:p-8" aria-labelledby="available-times-title">
            <div className="flex items-center gap-3">
              <CalendarClock aria-hidden="true" className="size-5 text-primary" />
              <h2 id="available-times-title" className="text-xl font-semibold text-card-foreground">Available appointment times</h2>
            </div>
            <p className="mt-2 text-sm text-muted-foreground">Showing available times over the next 30 days.</p>

            {slots.length === 0 ? <p className="mt-5 rounded-xl bg-muted p-4 text-sm leading-6 text-muted-foreground">No future times are currently available. Please check again later.</p> : (
              <form className="mt-5 space-y-5" onSubmit={handleBooking}>
                <fieldset>
                  <legend className="mb-3 text-sm font-semibold text-foreground">Choose a time</legend>
                  <div className="grid gap-3 sm:grid-cols-2">
                    {slots.map((slot) => (
                      <label key={slot.id} className={`flex min-h-16 cursor-pointer items-center gap-3 rounded-xl border p-4 transition-colors focus-within:ring-2 focus-within:ring-ring ${selectedSlotId === slot.id ? "border-primary bg-secondary/60" : "border-border bg-background hover:bg-muted/60"}`}>
                        <input className="size-4 accent-primary" type="radio" name="availability" value={slot.id} checked={selectedSlotId === slot.id} onChange={() => { setSelectedSlotId(slot.id); setBookingError(null); }} />
                        <span>
                          <span className="block font-medium text-foreground">{formatSlotDate(slot.date)}</span>
                          <span className="mt-1 block text-sm text-muted-foreground">{formatSlotTime(slot.start_time)}–{formatSlotTime(slot.end_time)} IST</span>
                        </span>
                      </label>
                    ))}
                  </div>
                </fieldset>

                <div>
                  <label htmlFor="appointment-reason" className="mb-2 block text-sm font-medium text-foreground">Reason for visit <span className="font-normal text-muted-foreground">(optional)</span></label>
                  <textarea id="appointment-reason" value={reason} onChange={(event) => setReason(event.target.value)} maxLength={2000} rows={3} className="w-full rounded-xl border border-input bg-background px-3 py-2 text-foreground shadow-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring" placeholder="Share anything you'd like the doctor to know." />
                  <p className="mt-1 text-right text-xs text-muted-foreground">{reason.length}/2000</p>
                </div>

                {bookingError ? (
                  <div className="rounded-xl border border-destructive/40 bg-destructive/5 p-4" role="alert">
                    <p className="text-sm text-foreground">{bookingError}</p>
                    {bookingError.includes("no longer available") ? <button type="button" onClick={retryLoading} className="mt-3 inline-flex min-h-9 items-center gap-2 rounded-lg border border-border px-3 text-sm font-medium text-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"><RefreshCw aria-hidden="true" className="size-4" /> Refresh available times</button> : null}
                  </div>
                ) : null}

                <Button type="submit" size="lg" disabled={!selectedSlotId || booking}>
                  Confirm appointment
                </Button>
              </form>
            )}
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
                    <dd className="mt-1 font-medium text-foreground">{formatSlotDate(selectedSlot.date)} at {formatSlotTime(selectedSlot.start_time)} IST</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Consultation fee</dt>
                    <dd className="mt-1 font-semibold text-foreground">{inrFormatter.format(doctor.consultation_fee)}</dd>
                  </div>
                </dl>
              ) : null}
              <p className="text-sm text-muted-foreground">Pay in Stripe Test Mode. Your selected slot is held for up to 40 minutes while Checkout is in progress.</p>
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
