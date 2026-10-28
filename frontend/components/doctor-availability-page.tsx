"use client";

import { useAuth } from "@clerk/nextjs";
import { CalendarPlus, Clock3, RefreshCw, Trash2 } from "lucide-react";
import { useDashboardProfile } from "@/components/role-application-shell";
import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { createDoctorSlot, deleteDoctorSlot, getDoctorSlots, ProfileApiError, type AvailabilitySlot } from "@/lib/profile-api";

const APPLICATION_TIME_ZONE = "Asia/Kolkata";

const slotFormSchema = z.object({
  date: z.iso.date(),
  start_time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, "Use a 24-hour time in HH:mm format."),
  end_time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, "Use a 24-hour time in HH:mm format."),
}).superRefine(({ start_time, end_time }, context) => {
  if (start_time >= end_time) {
    context.addIssue({ code: "custom", path: ["end_time"], message: "End time must be later than start time." });
  }
});

function todayInApplicationZone() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    year: "numeric", month: "2-digit", day: "2-digit", timeZone: APPLICATION_TIME_ZONE,
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function isFutureSlot(date: string, time: string) {
  const instant = new Date(`${date}T${time}:00+05:30`);
  return !Number.isNaN(instant.getTime()) && instant.getTime() > new Date().getTime();
}

function formatDate(date: string) {
  const [year, month, day] = date.split("-").map(Number);
  return new Intl.DateTimeFormat("en-IN", { dateStyle: "full", timeZone: "UTC" })
    .format(new Date(Date.UTC(year, month - 1, day)));
}

function formatTime(time: string) {
  const [hourText, minute] = time.split(":");
  const hour = Number(hourText);
  return `${hour % 12 || 12}:${minute} ${hour >= 12 ? "PM" : "AM"}`;
}

function apiErrorMessage(error: unknown, fallback: string) {
  if (error instanceof ProfileApiError && error.status === 409) return error.message;
  return error instanceof Error ? error.message : fallback;
}

export function DoctorAvailabilityPage() {
  const profile = useDashboardProfile();
  const doctorId = profile.profile.id;
  const { getToken } = useAuth();
  const [slots, setSlots] = useState<AvailabilitySlot[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [date, setDate] = useState("");
  const [startTime, setStartTime] = useState("");
  const [endTime, setEndTime] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [activeSlotId, setActiveSlotId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const mutationLock = useRef(false);

  useEffect(() => {
    let active = true;
    void getToken()
      .then((token) => {
        if (!token) throw new Error("Your session could not be verified. Please try again.");
        return getDoctorSlots(token, doctorId, todayInApplicationZone());
      })
      .then((result) => {
        if (active) setSlots(result);
      })
      .catch((error: unknown) => {
        if (active) setLoadError(error instanceof Error ? error.message : "We couldn't load availability.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [doctorId, getToken, refreshKey]);

  function refreshSlots(successMessage?: string) {
    setLoading(true);
    setLoadError(null);
    setActionError(null);
    setNotice(successMessage ?? null);
    setRefreshKey((key) => key + 1);
  }

  async function handleCreate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (mutationLock.current) return;
    setFormError(null);
    setActionError(null);
    setNotice(null);

    const parsed = slotFormSchema.safeParse({ date, start_time: startTime, end_time: endTime });
    if (!parsed.success) {
      setFormError(parsed.error.issues[0]?.message ?? "Check the date and time values.");
      return;
    }
    if (!isFutureSlot(parsed.data.date, parsed.data.start_time)) {
      setFormError("The slot must start in the future in India Standard Time.");
      return;
    }

    mutationLock.current = true;
    setCreating(true);
    try {
      const token = await getToken();
      if (!token) throw new Error("Your session could not be verified. Please sign in again.");
      await createDoctorSlot(token, doctorId, parsed.data);
      setDate("");
      setStartTime("");
      setEndTime("");
      refreshSlots("Availability slot created.");
    } catch (error) {
      setActionError(apiErrorMessage(error, "We couldn't create this slot. Please try again."));
    } finally {
      setCreating(false);
      mutationLock.current = false;
    }
  }

  async function handleDelete(slot: AvailabilitySlot) {
    if (mutationLock.current || !window.confirm(`Delete the slot on ${formatDate(slot.date)} at ${formatTime(slot.start_time)} IST?`)) return;
    mutationLock.current = true;
    setActiveSlotId(slot.id);
    setActionError(null);
    setNotice(null);
    try {
      const token = await getToken();
      if (!token) throw new Error("Your session could not be verified. Please sign in again.");
      await deleteDoctorSlot(token, doctorId, slot.id);
      refreshSlots("Availability slot deleted.");
    } catch (error) {
      if (error instanceof ProfileApiError && error.status === 409) {
        setActionError("This slot is now linked to appointment history and cannot be deleted. The list has been refreshed.");
        refreshSlots();
        setActionError("This slot is now linked to appointment history and cannot be deleted.");
      } else {
        setActionError(apiErrorMessage(error, "We couldn't delete this slot. Please try again."));
      }
    } finally {
      setActiveSlotId(null);
      mutationLock.current = false;
    }
  }

  return (
    <div className="mx-auto max-w-5xl space-y-8">
      <header>
        <p className="text-sm font-semibold uppercase tracking-[0.14em] text-primary">Doctor workspace</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">Manage availability</h1>
        <p className="mt-3 max-w-2xl text-base leading-7 text-muted-foreground">Add individual future appointment slots. All dates and times use India Standard Time.</p>
      </header>

      <section className="rounded-3xl border border-border bg-card p-6 shadow-sm sm:p-8" aria-labelledby="create-slot-title">
        <div className="flex items-center gap-3">
          <span className="flex size-11 items-center justify-center rounded-xl bg-secondary text-secondary-foreground"><CalendarPlus aria-hidden="true" className="size-5" /></span>
          <div>
            <h2 id="create-slot-title" className="text-xl font-semibold text-card-foreground">Add an availability slot</h2>
            <p className="text-sm text-muted-foreground">Create one dated slot at a time. Times use the 24-hour clock.</p>
          </div>
        </div>

        <form className="mt-6 grid gap-4 sm:grid-cols-3" onSubmit={handleCreate}>
          <div>
            <label htmlFor="slot-date" className="mb-2 block text-sm font-medium text-foreground">Date (IST)</label>
            <input id="slot-date" type="date" required value={date} onChange={(event) => setDate(event.target.value)} className="min-h-11 w-full rounded-lg border border-input bg-background px-3 text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring" />
          </div>
          <div>
            <label htmlFor="slot-start" className="mb-2 block text-sm font-medium text-foreground">Start time (IST)</label>
            <input id="slot-start" type="time" required value={startTime} onChange={(event) => setStartTime(event.target.value)} className="min-h-11 w-full rounded-lg border border-input bg-background px-3 text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring" />
          </div>
          <div>
            <label htmlFor="slot-end" className="mb-2 block text-sm font-medium text-foreground">End time (IST)</label>
            <input id="slot-end" type="time" required value={endTime} onChange={(event) => setEndTime(event.target.value)} className="min-h-11 w-full rounded-lg border border-input bg-background px-3 text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring" />
          </div>
          {formError ? <p className="sm:col-span-3 rounded-lg bg-destructive/5 p-3 text-sm text-foreground" role="alert">{formError}</p> : null}
          {actionError ? <p className="sm:col-span-3 rounded-lg bg-destructive/5 p-3 text-sm text-foreground" role="alert">{actionError}</p> : null}
          <div className="sm:col-span-3">
            <button type="submit" disabled={creating} className="inline-flex min-h-11 items-center gap-2 rounded-lg bg-primary px-5 font-semibold text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-60">
              <CalendarPlus aria-hidden="true" className="size-4" /> {creating ? "Creating slot…" : "Create slot"}
            </button>
          </div>
        </form>
      </section>

      <section aria-labelledby="existing-slots-title">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 id="existing-slots-title" className="text-xl font-semibold text-foreground">Upcoming available slots</h2>
            <p className="mt-1 text-sm text-muted-foreground">Booked and past slots are excluded by the availability API.</p>
          </div>
          <button type="button" onClick={() => refreshSlots()} disabled={loading} className="inline-flex min-h-10 items-center gap-2 rounded-lg border border-border px-3 text-sm font-medium text-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-60"><RefreshCw aria-hidden="true" className="size-4" /> Refresh</button>
        </div>

        {notice ? <p className="mt-4 rounded-xl border border-status-confirmed/40 bg-status-confirmed-bg p-4 text-sm text-foreground" role="status">{notice}</p> : null}
        {actionError ? <p className="mt-4 rounded-xl border border-destructive/40 bg-destructive/5 p-4 text-sm text-foreground" role="alert">{actionError}</p> : null}
        {loading ? <p className="mt-4 rounded-xl bg-muted p-5 text-sm text-muted-foreground" role="status">Loading availability…</p> : null}
        {!loading && loadError ? (
          <div className="mt-4 rounded-xl border border-destructive/40 bg-destructive/5 p-5" role="alert">
            <p className="text-sm text-foreground">{loadError}</p>
            <button type="button" onClick={() => refreshSlots()} className="mt-3 inline-flex min-h-10 items-center gap-2 rounded-lg border border-border px-3 text-sm font-medium text-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"><RefreshCw aria-hidden="true" className="size-4" /> Try again</button>
          </div>
        ) : null}
        {!loading && !loadError && slots.length === 0 ? <p className="mt-4 rounded-xl bg-muted p-5 text-sm text-muted-foreground">You have no future unbooked slots. Add a slot above when you are ready.</p> : null}
        {!loading && !loadError && slots.length > 0 ? (
          <ul className="mt-4 grid gap-3 sm:grid-cols-2">
            {slots.map((slot) => (
              <li key={slot.id} className="flex items-center justify-between gap-4 rounded-2xl border border-border bg-card p-4 shadow-sm">
                <div className="flex items-start gap-3">
                  <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-secondary text-secondary-foreground"><Clock3 aria-hidden="true" className="size-5" /></span>
                  <div>
                    <p className="font-medium text-card-foreground">{formatDate(slot.date)}</p>
                    <p className="mt-1 text-sm text-muted-foreground">{formatTime(slot.start_time)}–{formatTime(slot.end_time)} IST</p>
                  </div>
                </div>
                <button type="button" aria-label={`Delete slot on ${formatDate(slot.date)} at ${formatTime(slot.start_time)}`} onClick={() => void handleDelete(slot)} disabled={activeSlotId !== null || creating} className="inline-flex size-10 shrink-0 items-center justify-center rounded-lg text-destructive hover:bg-destructive/5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-50">
                  {activeSlotId === slot.id ? <RefreshCw aria-hidden="true" className="size-4 animate-spin" /> : <Trash2 aria-hidden="true" className="size-4" />}
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </section>
    </div>
  );
}
