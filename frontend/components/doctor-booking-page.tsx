"use client";

import { useAuth } from "@clerk/nextjs";
import { ArrowLeft, CalendarClock, CheckCircle2, RefreshCw, Stethoscope } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { createAppointment, getDoctor, getDoctorSlots, ProfileApiError, type AvailabilitySlot, type DirectoryDoctor, type PatientAppointment } from "@/lib/profile-api";

const APPLICATION_TIME_ZONE = "Asia/Kolkata";
const BOOKING_WINDOW_DAYS = 30;

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
  if (error instanceof ProfileApiError && error.status === 409) {
    return "That slot is no longer available. Refresh availability and choose another time.";
  }
  return error instanceof Error ? error.message : "We couldn't complete your booking. Please try again.";
}

export function DoctorBookingPage({ doctorId }: { doctorId: string }) {
  const { getToken } = useAuth();
  const [doctor, setDoctor] = useState<DirectoryDoctor | null>(null);
  const [slots, setSlots] = useState<AvailabilitySlot[]>([]);
  const [selectedSlotId, setSelectedSlotId] = useState("");
  const [reason, setReason] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState(0);
  const [booking, setBooking] = useState(false);
  const [bookingError, setBookingError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<PatientAppointment | null>(null);
  const submissionInProgress = useRef(false);

  useEffect(() => {
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
  }, [doctorId, getToken, retryKey]);

  async function handleBooking(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedSlotId || submissionInProgress.current) return;

    submissionInProgress.current = true;
    setBooking(true);
    setBookingError(null);
    try {
      const token = await getToken();
      if (!token) throw new Error("Your session could not be verified. Please sign in again.");
      const created = await createAppointment(token, selectedSlotId, reason.trim() || undefined);
      setConfirmation(created);
      setSelectedSlotId("");
    } catch (error) {
      setBookingError(formatBookingError(error));
    } finally {
      submissionInProgress.current = false;
      setBooking(false);
    }
  }

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

          <section className="rounded-3xl border border-border bg-card p-6 shadow-sm sm:p-8" aria-labelledby="available-times-title">
            <div className="flex items-center gap-3">
              <CalendarClock aria-hidden="true" className="size-5 text-primary" />
              <h2 id="available-times-title" className="text-xl font-semibold text-card-foreground">Available appointment times</h2>
            </div>
            <p className="mt-2 text-sm text-muted-foreground">Showing available times over the next 30 days in India Standard Time.</p>

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

                <button type="submit" disabled={!selectedSlotId || booking} className="inline-flex min-h-12 items-center justify-center gap-2 rounded-lg bg-primary px-5 py-3 font-semibold text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-60">
                  {booking ? "Booking…" : "Confirm appointment"}
                </button>
              </form>
            )}
          </section>
        </>
      ) : null}
    </div>
  );
}
