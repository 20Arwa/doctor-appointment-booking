"use client";

import { useAuth } from "@clerk/nextjs";
import { CalendarPlus, RefreshCw, Trash2, CalendarRange, Sparkles, ChevronLeft, ChevronRight } from "lucide-react";
import { useDashboardProfile } from "@/components/role-application-shell";
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
import { deleteDoctorSlot, getDoctorSlots, ProfileApiError, type AvailabilitySlot, type DoctorSchedule, createDoctorSchedule, createScheduleException, generateDoctorAvailability, getDoctorSchedules, updateDoctorProfile } from "@/lib/profile-api";
import { notifySuccess } from "@/lib/notifications";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const APPLICATION_TIME_ZONE = "Asia/Kolkata";

function todayInApplicationZone() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    year: "numeric", month: "2-digit", day: "2-digit", timeZone: APPLICATION_TIME_ZONE,
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
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

function monthRange(month: string) {
  const [year, monthNumber] = month.split("-").map(Number);
  return { from: month, to: new Date(Date.UTC(year, monthNumber, 0)).toISOString().slice(0, 10) };
}

function calendarCells(month: string) {
  const [year, monthNumber] = month.split("-").map(Number);
  const firstWeekday = new Date(Date.UTC(year, monthNumber - 1, 1)).getUTCDay();
  const daysInMonth = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  const cells: (string | null)[] = [...Array.from({ length: firstWeekday }, () => null), ...Array.from({ length: daysInMonth }, (_, index) => `${month.slice(0, 7)}-${String(index + 1).padStart(2, "0")}`)];
  while (cells.length % 7 !== 0) cells.push(null);
  return cells;
}

function formatMonth(month: string) {
  const [year, monthNumber] = month.split("-").map(Number);
  return new Intl.DateTimeFormat("en-IN", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(year, monthNumber - 1, 1)));
}

function shiftMonth(month: string, offset: number) {
  const [year, monthNumber] = month.split("-").map(Number);
  return `${new Date(Date.UTC(year, monthNumber - 1 + offset, 1)).toISOString().slice(0, 7)}-01`;
}

function formatHoldExpiry(value: string) {
  const expiresAt = new Date(value);
  if (Number.isNaN(expiresAt.getTime())) return null;
  return new Intl.DateTimeFormat("en-IN", {
    dateStyle: "medium", timeStyle: "short", timeZone: APPLICATION_TIME_ZONE,
  }).format(expiresAt);
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
  const [schedules, setSchedules] = useState<DoctorSchedule[]>([]);
  const [scheduleLoading, setScheduleLoading] = useState(true);
  const [scheduleLoadError, setScheduleLoadError] = useState<string | null>(null);
  const [schedulesError, setSchedulesError] = useState<string | null>(null);
  const [availabilityRecoveryNeeded, setAvailabilityRecoveryNeeded] = useState<Record<string, boolean>>({});
  const [generationConflicts, setGenerationConflicts] = useState<Record<string, { date: string; start_time: string; end_time: string; reason: string }[]>>({});
  const [scheduleBusy, setScheduleBusy] = useState(false);
  const [scheduleMessage, setScheduleMessage] = useState<string | null>(null);
  const [mode, setMode] = useState<"wave" | "stream">("wave");
  const [startsOn, setStartsOn] = useState(todayInApplicationZone());
  const [endsOn, setEndsOn] = useState("");
  const [weekdays, setWeekdays] = useState<number[]>([1]);
  const [scheduleStart, setScheduleStart] = useState("09:00");
  const [scheduleEnd, setScheduleEnd] = useState("17:00");
  const [waveCapacity, setWaveCapacity] = useState("1");
  const [streamCapacity, setStreamCapacity] = useState("1");
  const [duration, setDuration] = useState(String(profile.profile.appointment_duration_minutes ?? 30));
  const [exceptionTypes, setExceptionTypes] = useState<Record<string, "day_off" | "override" | "additional">>({});
  const [recentExceptions, setRecentExceptions] = useState<{ scheduleId: string; date: string; type: string }[]>([]);
  const scheduleRefs = useRef<Record<string, HTMLElement | null>>({});
  const scheduleMutationLock = useRef(false);
  const pendingScheduleRequest = useRef<{ id: string; signature: string } | null>(null);
  const [generationErrors, setGenerationErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [scheduleRefreshKey, setScheduleRefreshKey] = useState(0);
  const [calendarMonth, setCalendarMonth] = useState(() => `${todayInApplicationZone().slice(0, 7)}-01`);
  const [selectedDate, setSelectedDate] = useState(todayInApplicationZone());
  const [activeSlotId, setActiveSlotId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<AvailabilitySlot | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const mutationLock = useRef(false);

  useEffect(() => {
    const refreshAvailability = () => {
      if (document.visibilityState === "visible") {
        setLoading(true);
        setRefreshKey((key) => key + 1);
      }
    };
    window.addEventListener("focus", refreshAvailability);
    document.addEventListener("visibilitychange", refreshAvailability);
    return () => {
      window.removeEventListener("focus", refreshAvailability);
      document.removeEventListener("visibilitychange", refreshAvailability);
    };
  }, []);

  useEffect(() => {
    let active = true;
    void getToken()
      .then((token) => {
        if (!token) throw new Error("Your session could not be verified. Please try again.");
        return getDoctorSchedules(token, doctorId).then((result) => ({ token, result }));
      })
      .then(({ token, result }) => {
        if (!active) return;
        setSchedules(result);
        setScheduleLoadError(null);
        void (async () => {
          const needsRecovery: Record<string, boolean> = {};
          const recoveryErrors: Record<string, string> = {};
          const conflicts: typeof generationConflicts = {};
          let generatedAny = false;
          await Promise.all(result.filter((schedule) => schedule.active).map(async (schedule) => {
            if (!schedule.starts_on || !schedule.ends_on) { needsRecovery[schedule.id] = true; return; }
            const from = schedule.starts_on < todayInApplicationZone() ? todayInApplicationZone() : schedule.starts_on;
            if (from > schedule.ends_on) { needsRecovery[schedule.id] = false; return; }
            try {
              const generation = await generateDoctorAvailability(token, doctorId, schedule.id, from, schedule.ends_on);
              needsRecovery[schedule.id] = false;
              if (generation.skipped_conflict_details?.length) conflicts[schedule.id] = generation.skipped_conflict_details;
              generatedAny ||= (generation.mode === "stream" ? generation.generated_windows ?? 0 : generation.generated_slots ?? 0) > 0;
            } catch (error) {
              needsRecovery[schedule.id] = true;
              recoveryErrors[schedule.id] = apiErrorMessage(error, "We couldn't check this schedule's availability.");
            }
          }));
          if (active) {
            setAvailabilityRecoveryNeeded(needsRecovery);
            setGenerationConflicts(conflicts);
            setGenerationErrors(recoveryErrors);
            if (generatedAny) setRefreshKey((key) => key + 1);
          }
        })();
      })
      .catch((error: unknown) => { if (active) setScheduleLoadError(error instanceof Error ? error.message : "We couldn't load saved schedules."); })
      .finally(() => {
        if (active) setScheduleLoading(false);
      });
    return () => { active = false; };
  }, [doctorId, getToken, scheduleRefreshKey]);

  useEffect(() => {
    let active = true;
    void getToken()
      .then((token) => {
        if (!token) throw new Error("Your session could not be verified. Please try again.");
        const range = monthRange(calendarMonth);
        return getDoctorSlots(token, doctorId, range.from, range.to).then((result) => ({ result, range }));
      })
      .then(({ result, range }) => {
        if (!active) return;
        const generated = result.filter((slot) => slot.mode === "wave" || slot.mode === "stream");
        setSlots(generated);
        setSelectedDate((current) => current >= range.from && current <= range.to ? current : generated[0]?.date ?? current);
        setLoadError(null);
      })
      .catch((error: unknown) => { if (active) setLoadError(error instanceof Error ? error.message : "We couldn't load generated availability."); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [calendarMonth, doctorId, getToken, refreshKey]);

  const weekdaysLabels = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  async function submitSchedule(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setScheduleMessage(null); setSchedulesError(null);
    if (scheduleMutationLock.current) return;
    const count = Number(mode === "wave" ? waveCapacity : streamCapacity); const durationValue = Number(duration);
    if (mode === "wave" && (!Number.isInteger(durationValue) || durationValue < 5 || durationValue > 240)) { setSchedulesError("Appointment duration must be between 5 and 240 minutes."); return; }
    if (!Number.isInteger(count) || count < 1 || count > 500) { setSchedulesError("Capacity must be between 1 and 500."); return; }
    if (scheduleStart >= scheduleEnd) { setSchedulesError("End time must be after start time."); return; }
    if (!endsOn || startsOn > endsOn || weekdays.length === 0) { setSchedulesError("Choose a valid date range and at least one weekday."); return; }
    scheduleMutationLock.current = true;
    setScheduleBusy(true);
    try {
      const token = await getToken(); if (!token) throw new Error("Your session could not be verified. Please sign in again.");
      if (mode === "wave") await updateDoctorProfile(token, doctorId, { appointment_duration_minutes: durationValue });
      const scheduleDetails = { mode, recurrence_type: "weekly" as const, visibility: "public" as const, starts_on: startsOn, ends_on: endsOn, wave_capacity_per_slot: mode === "wave" ? count : 0, stream_capacity_per_window: mode === "stream" ? count : 0, periods: weekdays.map((weekday) => ({ weekday, start_time: scheduleStart, end_time: scheduleEnd })) };
      const signature = JSON.stringify(scheduleDetails);
      const requestId = pendingScheduleRequest.current?.signature === signature ? pendingScheduleRequest.current.id : crypto.randomUUID();
      pendingScheduleRequest.current = { id: requestId, signature };
      const payload = { request_id: requestId, ...scheduleDetails };
      const created = await createDoctorSchedule(token, doctorId, payload);
      pendingScheduleRequest.current = null;
      setScheduleLoadError(null);
      setSchedules((current) => current.some((schedule) => schedule.id === created.id) ? current : [created, ...current]);
      try {
        const generated = await generateDoctorAvailability(token, doctorId, created.id, startsOn, endsOn);
        const count = generated.mode === "stream" ? generated.generated_windows : generated.generated_slots;
        const noun = generated.mode === "stream" ? "window" : "slot";
        setGenerationErrors((current) => { const next = { ...current }; delete next[created.id]; return next; });
        const skipped = generated.skipped_conflicts ?? 0;
        setAvailabilityRecoveryNeeded((current) => ({ ...current, [created.id]: false }));
        setGenerationConflicts((current) => ({ ...current, [created.id]: generated.skipped_conflict_details ?? [] }));
        setScheduleMessage(`Schedule saved and ${count} availability ${noun}${count === 1 ? " was" : "s were"} generated.${skipped ? ` ${skipped} overlapping existing availability option${skipped === 1 ? " was" : "s were"} preserved and skipped.` : ""}`);
        setCalendarMonth(`${startsOn.slice(0, 7)}-01`); setSelectedDate(startsOn); setLoading(true); setLoadError(null); setRefreshKey((key) => key + 1);
      } catch (generationError) {
        const message = apiErrorMessage(generationError, "We couldn't generate availability.");
        setGenerationErrors((current) => ({ ...current, [created.id]: message }));
        setAvailabilityRecoveryNeeded((current) => ({ ...current, [created.id]: true }));
        setSchedulesError(`The schedule was saved, but availability generation failed: ${message} You can retry from the saved schedule.`);
      }
      requestAnimationFrame(() => {
        scheduleRefs.current[created.id]?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "center" });
      });
    } catch (error) { setSchedulesError(apiErrorMessage(error, "We couldn't save this schedule.")); }
    finally { setScheduleBusy(false); scheduleMutationLock.current = false; }
  }

  async function generateSchedule(schedule: DoctorSchedule, requestedFrom?: string, requestedTo?: string) {
    setScheduleBusy(true); setSchedulesError(null); setScheduleMessage(null);
    const hasSavedRange = Boolean(schedule.starts_on && schedule.ends_on);
    const from = hasSavedRange ? (schedule.starts_on! < todayInApplicationZone() ? todayInApplicationZone() : schedule.starts_on!) : requestedFrom ?? "";
    const to = hasSavedRange ? schedule.ends_on! : requestedTo ?? "";
    if (!from || !to || from > to) { setSchedulesError("Choose a valid future generation date range within this schedule."); setScheduleBusy(false); return; }
    try { const token = await getToken(); if (!token) throw new Error("Your session could not be verified. Please sign in again."); const result = await generateDoctorAvailability(token, doctorId, schedule.id, from, to); const count = result.mode === "stream" ? result.generated_windows : result.generated_slots; const noun = result.mode === "stream" ? "window" : "slot"; const skipped = result.skipped_conflicts ?? 0; setScheduleMessage(`${count} availability ${noun}${count === 1 ? " was" : "s were"} generated.${skipped ? ` ${skipped} overlapping existing availability option${skipped === 1 ? " was" : "s were"} preserved and skipped.` : ""}`); setAvailabilityRecoveryNeeded((current) => ({ ...current, [schedule.id]: false })); setGenerationConflicts((current) => ({ ...current, [schedule.id]: result.skipped_conflict_details ?? [] })); setGenerationErrors((current) => { const next = { ...current }; delete next[schedule.id]; return next; }); setCalendarMonth(`${from.slice(0, 7)}-01`); setSelectedDate(from); setLoading(true); setLoadError(null); setRefreshKey((key) => key + 1); }
    catch (error) { const message = apiErrorMessage(error, "We couldn't generate availability."); setAvailabilityRecoveryNeeded((current) => ({ ...current, [schedule.id]: true })); setGenerationErrors((current) => ({ ...current, [schedule.id]: message })); setSchedulesError(message); }
    finally { setScheduleBusy(false); }
  }

  async function submitException(event: React.FormEvent<HTMLFormElement>, scheduleId: string) {
    event.preventDefault(); setSchedulesError(null); setScheduleMessage(null);
    const form = new FormData(event.currentTarget);
    const serviceDate = String(form.get("exception_date") ?? "");
    const exceptionType = exceptionTypes[scheduleId] ?? "day_off";
    const exceptionStart = String(form.get("exception_start") ?? "09:00");
    const exceptionEnd = String(form.get("exception_end") ?? "17:00");
    if (!serviceDate) { setSchedulesError("Choose a date for the schedule exception."); return; }
    if (exceptionType !== "day_off" && exceptionStart >= exceptionEnd) { setSchedulesError("Exception end time must be after its start time."); return; }
    setScheduleBusy(true);
    try { const token = await getToken(); if (!token) throw new Error("Your session could not be verified. Please sign in again."); const result = await createScheduleException(token, doctorId, scheduleId, { service_date: serviceDate, exception_type: exceptionType, periods: exceptionType === "day_off" ? [] : [{ start_time: exceptionStart, end_time: exceptionEnd }] }); setRecentExceptions((current) => [{ scheduleId, date: serviceDate, type: exceptionType }, ...current]); const skipped = result.generation?.skipped_conflicts ?? 0; setScheduleMessage(`Date exception saved and availability updated.${skipped ? ` ${skipped} overlapping existing availability option${skipped === 1 ? " was" : "s were"} preserved and skipped.` : ""}`); setCalendarMonth(`${serviceDate.slice(0, 7)}-01`); setSelectedDate(serviceDate); setLoading(true); setLoadError(null); setRefreshKey((key) => key + 1); }
    catch (error) { setSchedulesError(apiErrorMessage(error, "We couldn't save this date exception.")); }
    finally { setScheduleBusy(false); }
  }

  function refreshSlots() {
    setLoading(true);
    setScheduleLoading(true);
    setLoadError(null);
    setScheduleLoadError(null);
    setRefreshKey((key) => key + 1);
    setScheduleRefreshKey((key) => key + 1);
  }

  const availabilityCounts = slots.reduce<Record<string, number>>((counts, slot) => { counts[slot.date] = (counts[slot.date] ?? 0) + 1; return counts; }, {});
  const selectedDateSlots = slots.filter((slot) => slot.date === selectedDate);
  const calendarDates = calendarCells(calendarMonth);
  const currentMonth = `${todayInApplicationZone().slice(0, 7)}-01`;

  async function handleDelete(slot: AvailabilitySlot) {
    if (mutationLock.current) return;
    mutationLock.current = true;
    setActiveSlotId(slot.id);
    setDeleteError(null);
    try {
      const token = await getToken();
      if (!token) throw new Error("Your session could not be verified. Please sign in again.");
      await deleteDoctorSlot(token, doctorId, slot.id);
      setDeleteTarget(null);
      refreshSlots();
      notifySuccess("Availability slot removed from active availability.", `availability-delete-${slot.id}`);
    } catch (error) {
      if (error instanceof ProfileApiError && error.status === 409) {
        refreshSlots();
        setDeleteError(`${error.message} The availability list is being refreshed.`);
      } else {
        setDeleteError(apiErrorMessage(error, "We couldn't delete this slot. Please try again."));
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
        <p className="mt-3 max-w-2xl text-base leading-7 text-muted-foreground">Set Wave appointment slots or continuous Stream booking windows.</p>
      </header>

      <section className="rounded-3xl border border-border bg-card p-6 shadow-sm sm:p-8" aria-labelledby="weekly-schedule-title">
        <div className="flex items-center gap-3"><span className="flex size-11 items-center justify-center rounded-xl bg-secondary text-secondary-foreground"><CalendarRange aria-hidden="true" className="size-5" /></span><div><h2 id="weekly-schedule-title" className="text-xl font-semibold text-card-foreground">Weekly schedule</h2><p className="text-sm text-muted-foreground">{mode === "wave" ? "Wave creates duration-sized slots with capacity per slot." : "Stream creates one continuous window with total capacity."}</p></div></div>
          <form className="mt-6 grid gap-4 sm:grid-cols-2" onSubmit={submitSchedule}>
          <div><label htmlFor="allocation-mode" className="text-sm font-medium">Allocation mode</label><Select value={mode} onValueChange={(value) => setMode(value as typeof mode)}><SelectTrigger className="mt-2" id="allocation-mode"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="wave">Wave (capacity per slot)</SelectItem><SelectItem value="stream">Stream (capacity per window)</SelectItem></SelectContent></Select></div>
          <label className="text-sm font-medium">{mode === "wave" ? "Capacity per Wave slot" : "Total capacity for this Stream window"}<input type="number" min="1" max="500" required value={mode === "wave" ? waveCapacity : streamCapacity} onChange={(e) => mode === "wave" ? setWaveCapacity(e.target.value) : setStreamCapacity(e.target.value)} className="mt-2 min-h-11 w-full rounded-lg border border-input bg-background px-3" /></label>
          {mode === "wave" && <label className="text-sm font-medium">Appointment duration (minutes)<input type="number" min="5" max="240" step="1" required value={duration} onChange={(e) => setDuration(e.target.value)} className="mt-2 min-h-11 w-full rounded-lg border border-input bg-background px-3" /></label>}
          <div className="sm:col-span-2 grid gap-4 sm:grid-cols-2">
            <label className="text-sm font-medium">Starts on<input type="date" required min={todayInApplicationZone()} value={startsOn} onChange={(e) => setStartsOn(e.target.value)} className="mt-2 min-h-11 w-full rounded-lg border border-input bg-background px-3" /></label>
            <label className="text-sm font-medium">Ends on<input type="date" required min={startsOn} value={endsOn} onChange={(e) => setEndsOn(e.target.value)} className="mt-2 min-h-11 w-full rounded-lg border border-input bg-background px-3" /></label>
          </div>
          <fieldset className="sm:col-span-2"><legend className="mb-2 text-sm font-medium">Available weekdays</legend><div className="flex flex-wrap gap-3">{weekdaysLabels.map((label, day) => <label key={label} className="inline-flex items-center gap-2 text-sm"><input type="checkbox" checked={weekdays.includes(day)} onChange={(e) => setWeekdays((current) => e.target.checked ? [...current, day].sort() : current.filter((value) => value !== day))} className="size-4 accent-primary" />{label}</label>)}</div></fieldset>
          <label className="text-sm font-medium">Start time (IST)<input type="time" required value={scheduleStart} onChange={(e) => setScheduleStart(e.target.value)} className="mt-2 min-h-11 w-full rounded-lg border border-input bg-background px-3" /></label>
          <label className="text-sm font-medium">End time (IST)<input type="time" required value={scheduleEnd} onChange={(e) => setScheduleEnd(e.target.value)} className="mt-2 min-h-11 w-full rounded-lg border border-input bg-background px-3" /></label>
          {schedulesError ? <p className="sm:col-span-2 rounded-lg bg-destructive/5 p-3 text-sm" role="alert">{schedulesError}</p> : null}
          <div className="sm:col-span-2"><button type="submit" disabled={scheduleBusy} className="inline-flex min-h-11 items-center gap-2 rounded-lg bg-primary px-5 font-semibold text-primary-foreground hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-60"><CalendarPlus aria-hidden="true" className="size-4" />{scheduleBusy ? "Saving schedule…" : "Save schedule"}</button></div>
        </form>
      </section>


      <section className="space-y-4" aria-labelledby="saved-schedules-title"><div><h2 id="saved-schedules-title" className="text-xl font-semibold text-foreground">Saved schedules</h2><p className="mt-1 text-sm text-muted-foreground">Schedules automatically open Wave slots or Stream windows for their date range. Add optional date exceptions as needed.</p></div>
        {scheduleMessage ? <p className="rounded-xl border border-primary/20 bg-secondary/50 p-4 text-sm font-medium text-foreground" role="status">{scheduleMessage}</p> : null}
        {scheduleLoading ? <p className="rounded-xl bg-muted p-4 text-sm text-muted-foreground" role="status">Loading saved schedules…</p> : null}
        {!scheduleLoading && scheduleLoadError ? <div className="rounded-xl border border-destructive/40 bg-destructive/5 p-4" role="alert"><p className="text-sm text-foreground">Saved schedules could not be loaded: {scheduleLoadError}</p><button type="button" onClick={() => refreshSlots()} className="mt-3 inline-flex min-h-9 items-center gap-2 rounded-lg border border-border px-3 text-sm font-medium hover:bg-muted"><RefreshCw aria-hidden="true" className="size-4" />Retry</button></div> : null}
        {!scheduleLoading && !scheduleLoadError && schedules.length === 0 ? <p className="rounded-xl bg-muted p-4 text-sm text-muted-foreground">No schedules have been saved for this doctor yet.</p> : null}
        {schedules.map((schedule) => { const exceptionType = exceptionTypes[schedule.id] ?? "day_off"; const workingPeriods = schedule.periods.filter((period) => period.weekday != null).sort((a, b) => (a.weekday ?? 0) - (b.weekday ?? 0)); return <article ref={(element) => { scheduleRefs.current[schedule.id] = element; }} key={schedule.id} className="scroll-mt-6 rounded-2xl border border-border bg-card p-5 shadow-sm"><div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="font-semibold text-card-foreground">{schedule.recurrence_type === "weekly" ? "Weekly schedule" : "Date-specific schedule"}</h3><p className="mt-1 text-sm font-medium text-primary">{schedule.mode === "wave" ? `Wave · ${schedule.wave_capacity_per_slot} places per slot` : `Stream · ${schedule.stream_capacity_per_window} total places per window`}</p></div><span className="rounded-full bg-muted px-3 py-1 text-xs font-medium text-muted-foreground">{generationErrors[schedule.id] ? "Generation failed" : availabilityRecoveryNeeded[schedule.id] ? "Needs recovery" : schedule.active ? "Active" : "Inactive"}</span></div>
          <div className="mt-4 divide-y divide-border rounded-xl border border-border">{workingPeriods.map((period) => <div key={`${period.weekday}-${period.start_time}`} className="flex items-center justify-between gap-3 px-4 py-3 text-sm"><span className="font-medium text-foreground">{period.weekday == null ? period.service_date : weekdaysLabels[period.weekday]}</span><span className="text-muted-foreground">{period.start_time.slice(0,5)}–{period.end_time.slice(0,5)} IST</span></div>)}{workingPeriods.length === 0 ? schedule.periods.map((period) => <div key={`${period.service_date}-${period.start_time}`} className="flex items-center justify-between gap-3 px-4 py-3 text-sm"><span className="font-medium text-foreground">{period.service_date}</span><span className="text-muted-foreground">{period.start_time.slice(0,5)}–{period.end_time.slice(0,5)} IST</span></div>) : null}</div>
          {availabilityRecoveryNeeded[schedule.id] && schedule.active ? <form className="mt-4 flex flex-wrap items-end gap-3 border-t border-border pt-4" onSubmit={(event) => { event.preventDefault(); const data = new FormData(event.currentTarget); void generateSchedule(schedule, String(data.get("recovery-from") ?? ""), String(data.get("recovery-to") ?? "")); }}>
            {!schedule.starts_on || !schedule.ends_on ? <><label className="text-sm font-medium">Recovery starts on<input name="recovery-from" type="date" required min={todayInApplicationZone()} defaultValue={todayInApplicationZone()} className="mt-1 min-h-11 rounded-lg border border-input bg-background px-3" /></label><label className="text-sm font-medium">Recovery ends on<input name="recovery-to" type="date" required min={todayInApplicationZone()} defaultValue={schedule.ends_on ?? ""} className="mt-1 min-h-11 rounded-lg border border-input bg-background px-3" /></label></> : <p className="mr-auto text-sm text-muted-foreground">Use saved range {schedule.starts_on} to {schedule.ends_on}; only remaining future availability will be generated.</p>}
            <button type="submit" disabled={scheduleBusy} className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-border bg-background px-4 font-semibold text-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-60"><Sparkles aria-hidden="true" className="size-4" />Recover missing availability</button>
          </form> : null}
          {generationErrors[schedule.id] ? <p className="mt-3 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm" role="alert">Availability generation failed: {generationErrors[schedule.id]}</p> : null}
          {generationConflicts[schedule.id]?.map((conflict, index) => <p key={`${conflict.date}-${conflict.start_time}-${index}`} className="mt-3 rounded-lg border border-border bg-muted/50 p-3 text-sm text-muted-foreground">Availability on {formatDate(conflict.date)} at {formatTime(conflict.start_time)}–{formatTime(conflict.end_time)} IST was preserved and skipped because it overlaps {conflict.reason}. No retry is offered because changing that row could affect existing booking history.</p>)}
          <form className="mt-4 grid gap-4 border-t border-border pt-4 sm:grid-cols-2" onSubmit={(e) => void submitException(e, schedule.id)}><div className="sm:col-span-2"><p className="text-sm font-semibold text-foreground">Date exception</p><p className="mt-1 text-sm text-muted-foreground">Adjust this schedule for one date.</p></div><label className="text-sm font-medium">Exception date<input name="exception_date" type="date" required min={todayInApplicationZone()} className="mt-1 min-h-11 w-full rounded-lg border border-input bg-background px-3" /></label><div><label htmlFor={`exception-type-${schedule.id}`} className="text-sm font-medium">Change hours</label><Select value={exceptionType} onValueChange={(value) => setExceptionTypes((current) => ({ ...current, [schedule.id]: value as typeof exceptionType }))}><SelectTrigger className="mt-1" id={`exception-type-${schedule.id}`}><SelectValue /></SelectTrigger><SelectContent><SelectItem value="day_off">Day off</SelectItem><SelectItem value="override">Override hours</SelectItem><SelectItem value="additional">Add hours</SelectItem></SelectContent></Select></div>{exceptionType !== "day_off" ? <><label className="text-sm font-medium">Start time<input name="exception_start" type="time" required defaultValue="09:00" className="mt-1 min-h-11 w-full rounded-lg border border-input bg-background px-3" /></label><label className="text-sm font-medium">End time<input name="exception_end" type="time" required defaultValue="17:00" className="mt-1 min-h-11 w-full rounded-lg border border-input bg-background px-3" /></label></> : null}<div className="sm:col-span-2"><button type="submit" disabled={scheduleBusy || !schedule.active} className="inline-flex min-h-11 items-center justify-center rounded-lg border border-primary bg-background px-4 font-semibold text-primary transition-colors hover:bg-primary hover:text-primary-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-60">{scheduleBusy ? "Saving…" : "Save date exception"}</button></div></form>
          {recentExceptions.filter((entry) => entry.scheduleId === schedule.id).map((entry) => <p key={`${entry.date}-${entry.type}`} className="mt-2 text-sm text-muted-foreground">{entry.date}: {entry.type.replace("_", " ")}</p>)}
        </article>; })}
      </section>

      <section aria-labelledby="existing-slots-title">
        <div className="flex flex-wrap items-end justify-between gap-3"><div><h2 id="existing-slots-title" className="text-xl font-semibold text-foreground">Generated availability</h2><p className="mt-1 text-sm text-muted-foreground">Choose a date to review its Wave slots or Stream windows.</p></div><button type="button" onClick={() => refreshSlots()} disabled={loading} className="inline-flex min-h-10 items-center gap-2 rounded-lg border border-border px-3 text-sm font-medium text-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-60"><RefreshCw aria-hidden="true" className="size-4" />Refresh</button></div>
        {loading ? <p className="mt-4 rounded-xl bg-muted p-5 text-sm text-muted-foreground" role="status">Loading generated availability...</p> : null}
        {!loading && loadError ? <div className="mt-4 rounded-xl border border-destructive/40 bg-destructive/5 p-5" role="alert"><p className="text-sm text-foreground">{loadError}</p><button type="button" onClick={() => refreshSlots()} className="mt-3 inline-flex min-h-10 items-center gap-2 rounded-lg border border-border px-3 text-sm font-medium text-foreground hover:bg-muted"><RefreshCw aria-hidden="true" className="size-4" />Try again</button></div> : null}
        {!loading && !loadError ? <div className="mt-4 rounded-2xl border border-border bg-card p-4 shadow-sm sm:p-6">
          <div className="flex items-center justify-between gap-3"><button type="button" aria-label="Previous month" disabled={calendarMonth <= currentMonth} onClick={() => { const next = shiftMonth(calendarMonth, -1); setCalendarMonth(next); setLoading(true); setSlots([]); setLoadError(null); }} className="inline-flex size-10 items-center justify-center rounded-lg border border-border hover:bg-muted disabled:opacity-40"><ChevronLeft aria-hidden="true" className="size-4" /></button><h3 className="font-semibold text-foreground" aria-live="polite">{formatMonth(calendarMonth)}</h3><button type="button" aria-label="Next month" onClick={() => { const next = shiftMonth(calendarMonth, 1); setCalendarMonth(next); setLoading(true); setSlots([]); setLoadError(null); }} className="inline-flex size-10 items-center justify-center rounded-lg border border-border hover:bg-muted"><ChevronRight aria-hidden="true" className="size-4" /></button></div>
          <div className="mt-4 grid grid-cols-7 gap-1 text-center text-xs font-medium text-muted-foreground">{["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((day) => <span key={day} className="py-2">{day}</span>)}</div>
          <div className="grid grid-cols-7 justify-items-center gap-1">{calendarDates.map((day, index) => { if (!day) return <span key={"blank-" + index} aria-hidden="true" className="size-10" />; const count = availabilityCounts[day] ?? 0; const selected = day === selectedDate; const today = day === todayInApplicationZone(); return <button key={day} type="button" aria-label={formatDate(day) + (count ? ", " + count + " generated options" : ", no generated availability")} aria-pressed={selected} onClick={() => setSelectedDate(day)} className={`flex size-10 flex-col items-center justify-center rounded-lg text-xs transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring ${today ? "ring-2 ring-inset ring-ring" : ""} ${selected ? "bg-primary font-semibold text-primary-foreground" : count ? "bg-secondary/60 font-medium text-secondary-foreground hover:bg-secondary" : "text-muted-foreground hover:bg-muted"}`}><span>{Number(day.slice(-2))}</span>{count ? <span className="text-[9px] leading-none text-muted-foreground">{count}</span> : null}</button>; })}</div>
          <div className="mt-5 border-t border-border pt-4"><h3 className="font-semibold text-card-foreground">{formatDate(selectedDate)}</h3>{selectedDateSlots.length === 0 ? <p className="mt-2 text-sm text-muted-foreground">No generated availability on this date.</p> : <ul className="mt-3 divide-y divide-border">{selectedDateSlots.map((slot) => <li key={slot.id} className="flex items-center justify-between gap-4 py-3"><div><span className="inline-flex rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">{slot.mode === "wave" ? "Wave" : "Stream"}</span><p className="mt-1 text-sm text-muted-foreground">{slot.mode === "stream" ? "Continuous window · " : ""}{formatTime(slot.start_time)}–{formatTime(slot.end_time)} IST</p>{slot.capacity != null && slot.remaining_capacity != null ? <p className="mt-1 text-xs text-muted-foreground">{slot.remaining_capacity === 0 ? "Full" : `${slot.remaining_capacity} of ${slot.capacity} places remaining${slot.mode === "stream" ? " in this window" : " in this slot"}`}</p> : null}{slot.hold_status === "active" && slot.hold_expires_at ? <p className="mt-1 text-xs text-primary">Payment hold until {formatHoldExpiry(slot.hold_expires_at)} IST</p> : null}</div><button type="button" aria-label={`Delete ${slot.mode} availability on ${formatDate(slot.date)} at ${formatTime(slot.start_time)}`} onClick={() => { setDeleteError(null); setDeleteTarget(slot); }} disabled={activeSlotId !== null} className="inline-flex size-10 shrink-0 items-center justify-center rounded-lg text-destructive hover:bg-destructive/5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-50">{activeSlotId === slot.id ? <RefreshCw aria-hidden="true" className="size-4 animate-spin" /> : <Trash2 aria-hidden="true" className="size-4" />}</button></li>)}</ul>}</div>
        </div> : null}
      </section>      <AlertDialog open={deleteTarget !== null} onOpenChange={(open) => {
        if (!open && activeSlotId === null) {
          setDeleteTarget(null);
          setDeleteError(null);
        }
      }}>
        <AlertDialogContent className="max-w-md rounded-2xl border border-border bg-card p-6 text-card-foreground shadow-xl ring-0 sm:max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete availability slot?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget ? `Delete the slot on ${formatDate(deleteTarget.date)} at ${formatTime(deleteTarget.start_time)} IST? This slot will no longer be available for booking.` : "This availability slot will be removed."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {deleteError ? <p className="rounded-lg bg-destructive/5 p-3 text-sm text-foreground" role="alert">{deleteError}</p> : null}
          <AlertDialogFooter className="m-0 flex-row justify-end gap-3 border-0 bg-transparent p-0">
            <AlertDialogCancel disabled={activeSlotId !== null}>Keep slot</AlertDialogCancel>
            <AlertDialogAction variant="destructive" disabled={activeSlotId !== null} onClick={(event) => {
              event.preventDefault();
              if (deleteTarget) void handleDelete(deleteTarget);
            }}>{activeSlotId !== null ? "Deleting slot…" : "Delete slot"}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
