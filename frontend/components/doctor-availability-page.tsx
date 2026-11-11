"use client";

import { useAuth } from "@clerk/nextjs";
import Link from "next/link";
import { CalendarPlus, RefreshCw, Trash2, CalendarRange, Sparkles, ChevronLeft, ChevronRight, Pencil, X, Eye, Save } from "lucide-react";
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
import { deleteDoctorSlot, getDoctorSlots, ProfileApiError, type AvailabilitySlot, type DoctorSchedule, type ElasticSchedulePreview, type ElasticScheduleInput, createDoctorSchedule, createScheduleException, generateDoctorAvailability, getDoctorSchedules, previewDoctorScheduleUpdate, updateDoctorSchedule, updateDoctorProfile } from "@/lib/profile-api";
import { notifySuccess } from "@/lib/notifications";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { formatDateOnly } from "@/lib/date-format";
import { DateInput } from "@/components/ui/date-input";

const APPLICATION_TIME_ZONE = "Asia/Kolkata";

function todayInApplicationZone() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    year: "numeric", month: "2-digit", day: "2-digit", timeZone: APPLICATION_TIME_ZONE,
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function formatDate(date: string) {
  return formatDateOnly(date);
}

function formatScheduleDate(date: string | null) {
  return date ? formatDateOnly(date) : "Not set";
}

function groupByDate<T extends { date: string }>(items: T[]) {
  return items.reduce<Record<string, T[]>>((groups, item) => {
    (groups[item.date] ??= []).push(item);
    return groups;
  }, {});
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
  const [mode, setMode] = useState<"wave" | "stream">("wave");
  const [editingScheduleId, setEditingScheduleId] = useState<string | null>(null);
  const [editStartsOn, setEditStartsOn] = useState("");
  const [editEndsOn, setEditEndsOn] = useState("");
  const [editWeekdays, setEditWeekdays] = useState<number[]>([]);
  const [editStart, setEditStart] = useState("09:00");
  const [editEnd, setEditEnd] = useState("17:00");
  const [schedulePreview, setSchedulePreview] = useState<ElasticSchedulePreview | null>(null);
  const [schedulePreviewInput, setSchedulePreviewInput] = useState<ElasticScheduleInput | null>(null);
  const [scheduleEditError, setScheduleEditError] = useState<string | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
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
    event.preventDefault(); setSchedulesError(null);
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
        notifySuccess(`Schedule saved and ${count} availability ${noun}${count === 1 ? " was" : "s were"} generated.${skipped ? ` ${skipped} overlapping existing availability option${skipped === 1 ? " was" : "s were"} preserved and skipped.` : ""}`, `schedule-created-${created.id}`);
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
    setScheduleBusy(true); setSchedulesError(null);
    const hasSavedRange = Boolean(schedule.starts_on && schedule.ends_on);
    const from = hasSavedRange ? (schedule.starts_on! < todayInApplicationZone() ? todayInApplicationZone() : schedule.starts_on!) : requestedFrom ?? "";
    const to = hasSavedRange ? schedule.ends_on! : requestedTo ?? "";
    if (!from || !to || from > to) { setSchedulesError("Choose a valid future generation date range within this schedule."); setScheduleBusy(false); return; }
    try { const token = await getToken(); if (!token) throw new Error("Your session could not be verified. Please sign in again."); const result = await generateDoctorAvailability(token, doctorId, schedule.id, from, to); const count = result.mode === "stream" ? result.generated_windows : result.generated_slots; const noun = result.mode === "stream" ? "window" : "slot"; const skipped = result.skipped_conflicts ?? 0; notifySuccess(`${count} availability ${noun}${count === 1 ? " was" : "s were"} generated.${skipped ? ` ${skipped} overlapping existing availability option${skipped === 1 ? " was" : "s were"} preserved and skipped.` : ""}`, `schedule-recovery-${schedule.id}`); setAvailabilityRecoveryNeeded((current) => ({ ...current, [schedule.id]: false })); setGenerationConflicts((current) => ({ ...current, [schedule.id]: result.skipped_conflict_details ?? [] })); setGenerationErrors((current) => { const next = { ...current }; delete next[schedule.id]; return next; }); setCalendarMonth(`${from.slice(0, 7)}-01`); setSelectedDate(from); setLoading(true); setLoadError(null); setRefreshKey((key) => key + 1); }
    catch (error) { const message = apiErrorMessage(error, "We couldn't generate availability."); setAvailabilityRecoveryNeeded((current) => ({ ...current, [schedule.id]: true })); setGenerationErrors((current) => ({ ...current, [schedule.id]: message })); setSchedulesError(message); }
    finally { setScheduleBusy(false); }
  }

  async function submitException(event: React.FormEvent<HTMLFormElement>, scheduleId: string) {
    event.preventDefault(); setSchedulesError(null);
    const form = new FormData(event.currentTarget);
    const serviceDate = String(form.get("exception_date") ?? "");
    const exceptionType = exceptionTypes[scheduleId] ?? "day_off";
    const exceptionStart = String(form.get("exception_start") ?? "09:00");
    const exceptionEnd = String(form.get("exception_end") ?? "17:00");
    if (!serviceDate) { setSchedulesError("Choose a date for the schedule exception."); return; }
    if (exceptionType !== "day_off" && exceptionStart >= exceptionEnd) { setSchedulesError("Exception end time must be after its start time."); return; }
    setScheduleBusy(true);
    try { const token = await getToken(); if (!token) throw new Error("Your session could not be verified. Please sign in again."); const result = await createScheduleException(token, doctorId, scheduleId, { service_date: serviceDate, exception_type: exceptionType, periods: exceptionType === "day_off" ? [] : [{ start_time: exceptionStart, end_time: exceptionEnd }] }); setRecentExceptions((current) => [{ scheduleId, date: serviceDate, type: exceptionType }, ...current]); const skipped = result.generation?.skipped_conflicts ?? 0; notifySuccess(`Date exception saved and availability updated.${skipped ? ` ${skipped} overlapping existing availability option${skipped === 1 ? " was" : "s were"} preserved and skipped.` : ""}`, `schedule-exception-${result.id}`); setCalendarMonth(`${serviceDate.slice(0, 7)}-01`); setSelectedDate(serviceDate); setLoading(true); setLoadError(null); setRefreshKey((key) => key + 1); }
    catch (error) { setSchedulesError(apiErrorMessage(error, "We couldn't save this date exception.")); }
    finally { setScheduleBusy(false); }
  }

  function beginScheduleEdit(schedule: DoctorSchedule) {
    const weeklyPeriods = schedule.periods.filter((period) => period.weekday != null);
    setEditingScheduleId(schedule.id);
    setEditStartsOn(schedule.starts_on ?? todayInApplicationZone());
    setEditEndsOn(schedule.ends_on ?? todayInApplicationZone());
    setEditWeekdays(weeklyPeriods.map((period) => period.weekday!).sort((a, b) => a - b));
    setEditStart(weeklyPeriods[0]?.start_time.slice(0, 5) ?? "09:00");
    setEditEnd(weeklyPeriods[0]?.end_time.slice(0, 5) ?? "17:00");
    setSchedulePreview(null);
    setSchedulePreviewInput(null);
    setScheduleEditError(null);
    setSchedulesError(null);
  }

  function cancelScheduleEdit() {
    setEditingScheduleId(null);
    setSchedulePreview(null);
    setSchedulePreviewInput(null);
    setScheduleEditError(null);
  }

  function scheduleEditInput(schedule: DoctorSchedule): ElasticScheduleInput | null {
    if (!schedule.updated_at) { setScheduleEditError("This schedule has no version timestamp. Refresh schedules before editing."); return null; }
    if (!editStartsOn || !editEndsOn || editStartsOn > editEndsOn || editWeekdays.length === 0 || editStart >= editEnd) {
      setScheduleEditError("Choose a valid date range, at least one weekday, and an end time after the start time."); return null;
    }
    return {
      mode: schedule.mode,
      expected_updated_at: schedule.updated_at,
      starts_on: editStartsOn,
      ends_on: editEndsOn,
      periods: editWeekdays.map((weekday) => ({ weekday, start_time: editStart, end_time: editEnd })),
    };
  }

  async function reviewScheduleEdit(schedule: DoctorSchedule) {
    setScheduleEditError(null);
    setSchedulePreview(null);
    setSchedulePreviewInput(null);
    const input = scheduleEditInput(schedule);
    if (!input) return;
    setPreviewBusy(true);
    try {
      const token = await getToken();
      if (!token) throw new Error("Your session could not be verified. Please sign in again.");
      const preview = await previewDoctorScheduleUpdate(token, doctorId, schedule.id, input);
      setSchedulePreview(preview);
      setSchedulePreviewInput({ ...input, expected_updated_at: preview.schedule_updated_at });
    } catch (error) {
      setScheduleEditError(apiErrorMessage(error, "We couldn't preview these schedule changes."));
    } finally { setPreviewBusy(false); }
  }

  async function saveScheduleEdit(schedule: DoctorSchedule) {
    setScheduleEditError(null);
    const input = scheduleEditInput(schedule);
    if (!input) return;
    const reviewedInput = schedulePreviewInput;
    if (!schedulePreview || schedulePreview.schedule_id !== schedule.id || !reviewedInput) { setScheduleEditError("Review these changes before saving."); return; }
    if (JSON.stringify({ ...input, expected_updated_at: "" }) !== JSON.stringify({ ...reviewedInput, expected_updated_at: "" })) {
      setSchedulePreview(null); setSchedulePreviewInput(null); setScheduleEditError("The draft changed after preview. Review the latest changes before saving."); return;
    }
    if (!schedulePreview.can_update) { setScheduleEditError("Resolve the saved schedule conflicts shown in the preview before saving."); return; }
    if (scheduleMutationLock.current) return;
    scheduleMutationLock.current = true;
    setScheduleBusy(true);
    try {
      const token = await getToken();
      if (!token) throw new Error("Your session could not be verified. Please sign in again.");
      const cardTop = scheduleRefs.current[schedule.id]?.getBoundingClientRect().top ?? null;
      const result = await updateDoctorSchedule(token, doctorId, schedule.id, { ...input, expected_updated_at: reviewedInput.expected_updated_at });
      const updateCounts = [
        result.added_count ? `${result.added_count} added` : null,
        result.resized_count ? `${result.resized_count} Stream windows expanded` : null,
        result.removed_count ? `${result.removed_count} removed` : null,
        result.unchanged_count ? `${result.unchanged_count} unchanged` : null,
        result.blocked_availability.length ? `${result.blocked_availability.length} skipped due to conflicts` : null,
      ].filter((value): value is string => value !== null);
      notifySuccess(`Schedule updated.${updateCounts.length ? ` ${updateCounts.join(", ")}.` : ""}`, `schedule-update-${schedule.id}`);
      setEditingScheduleId(null);
      setSchedulePreview(null);
      setSchedulePreviewInput(null);
      setScheduleLoadError(null);
      setCalendarMonth(`${editStartsOn.slice(0, 7)}-01`);
      setSelectedDate(editStartsOn);
      setLoading(true);
      setLoadError(null);
      setRefreshKey((key) => key + 1);
      try {
        setSchedules(await getDoctorSchedules(token, doctorId));
        setScheduleLoadError(null);
        if (cardTop !== null) {
          await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
          const refreshedTop = scheduleRefs.current[schedule.id]?.getBoundingClientRect().top;
          if (refreshedTop !== undefined) window.scrollBy({ top: refreshedTop - cardTop, behavior: "instant" as ScrollBehavior });
        }
      } catch (refreshError) {
        setScheduleLoadError(apiErrorMessage(refreshError, "The update succeeded, but saved schedules could not be refreshed."));
      }
    } catch (error) {
      if (error instanceof ProfileApiError && error.status === 409) {
        setSchedulePreview(null);
        setSchedulePreviewInput(null);
      }
      if (error instanceof ProfileApiError && error.code === "SCHEDULE_CHANGE_PROTECTED_APPOINTMENT") {
        const protectedAppointment = error.protectedAppointments[0];
        const count = error.protectedAppointments.length;
        setScheduleEditError(protectedAppointment
          ? `Cannot save this schedule change because it affects a confirmed appointment starting within six hours: ${formatDate(protectedAppointment.date)} at ${formatTime(protectedAppointment.start_time)} IST${count > 1 ? ` (${count} protected appointments)` : ""}.`
          : error.message);
        return;
      }
      setScheduleEditError(apiErrorMessage(error, "We couldn't update this schedule."));
    } finally { scheduleMutationLock.current = false; setScheduleBusy(false); }
  }

  function refreshSlots() {
    setLoading(true);
    setScheduleLoading(true);
    setLoadError(null);
    setScheduleLoadError(null);
    setRefreshKey((key) => key + 1);
    setScheduleRefreshKey((key) => key + 1);
  }

  const availabilityCounts = slots.reduce<Record<string, number>>((counts, slot) => {
    if (!slot.reservation_only) counts[slot.date] = (counts[slot.date] ?? 0) + 1;
    return counts;
  }, {});
  const reservationCounts = slots.reduce<Record<string, number>>((counts, slot) => {
    if (slot.reservation_only) counts[slot.date] = (counts[slot.date] ?? 0) + 1;
    return counts;
  }, {});
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
        setDeleteError(error.message);
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
        <details className="mt-5 rounded-xl border border-border p-4">
          <summary className="cursor-pointer list-none rounded-lg px-3 py-2 font-semibold text-foreground transition-colors hover:bg-muted/70 active:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">Add weekly schedule</summary>
          <form className="mt-5 grid gap-4 sm:grid-cols-2" onSubmit={submitSchedule}>
          <div><label htmlFor="allocation-mode" className="text-sm font-medium">Allocation mode</label><Select value={mode} onValueChange={(value) => setMode(value as typeof mode)}><SelectTrigger className="mt-2" id="allocation-mode"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="wave">Wave (capacity per slot)</SelectItem><SelectItem value="stream">Stream (capacity per window)</SelectItem></SelectContent></Select></div>
          <label className="text-sm font-medium">{mode === "wave" ? "Capacity per Wave slot" : "Total capacity for this Stream window"}<input type="number" min="1" max="500" required value={mode === "wave" ? waveCapacity : streamCapacity} onChange={(e) => mode === "wave" ? setWaveCapacity(e.target.value) : setStreamCapacity(e.target.value)} className="mt-2 min-h-11 w-full rounded-lg border border-input bg-background px-3" /></label>
          {mode === "wave" && <label className="text-sm font-medium">Appointment duration (minutes)<input type="number" min="5" max="240" step="1" required value={duration} onChange={(e) => setDuration(e.target.value)} className="mt-2 min-h-11 w-full rounded-lg border border-input bg-background px-3" /></label>}
          <div className="sm:col-span-2 grid gap-4 sm:grid-cols-2">
            <label className="text-sm font-medium">Starts on<DateInput placeholder="Select start date" required min={todayInApplicationZone()} value={startsOn} onChange={setStartsOn} className="mt-2" /></label>
            <label className="text-sm font-medium">Ends on<DateInput placeholder="Select end date" required min={startsOn} value={endsOn} onChange={setEndsOn} className="mt-2" /></label>
          </div>
          <fieldset className="sm:col-span-2"><legend className="mb-2 text-sm font-medium">Available weekdays</legend><div className="flex flex-wrap gap-3">{weekdaysLabels.map((label, day) => <label key={label} className="inline-flex items-center gap-2 text-sm"><input type="checkbox" checked={weekdays.includes(day)} onChange={(e) => setWeekdays((current) => e.target.checked ? [...current, day].sort() : current.filter((value) => value !== day))} className="size-4 accent-primary" />{label}</label>)}</div></fieldset>
          <label className="text-sm font-medium">Start time (IST)<input type="time" required value={scheduleStart} onChange={(e) => setScheduleStart(e.target.value)} className="mt-2 min-h-11 w-full rounded-lg border border-input bg-background px-3" /></label>
          <label className="text-sm font-medium">End time (IST)<input type="time" required value={scheduleEnd} onChange={(e) => setScheduleEnd(e.target.value)} className="mt-2 min-h-11 w-full rounded-lg border border-input bg-background px-3" /></label>
          {schedulesError ? <p className="sm:col-span-2 rounded-lg bg-destructive/5 p-3 text-sm" role="alert">{schedulesError}</p> : null}
          <div className="sm:col-span-2"><button type="submit" disabled={scheduleBusy} className="inline-flex min-h-11 items-center gap-2 rounded-lg bg-primary px-5 font-semibold text-primary-foreground hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-60"><CalendarPlus aria-hidden="true" className="size-4" />{scheduleBusy ? "Saving schedule…" : "Save schedule"}</button></div>
          </form>
        </details>
      </section>


      <section className="space-y-4" aria-labelledby="saved-schedules-title"><div><h2 id="saved-schedules-title" className="text-xl font-semibold text-foreground">Saved schedules</h2><p className="mt-1 text-sm text-muted-foreground">Schedules automatically open Wave slots or Stream windows for their date range. Add optional date exceptions as needed.</p></div>
        {scheduleLoading ? <p className="rounded-xl bg-muted p-4 text-sm text-muted-foreground" role="status">Loading saved schedules…</p> : null}
        {!scheduleLoading && scheduleLoadError ? <div className="rounded-xl border border-destructive/40 bg-destructive/5 p-4" role="alert"><p className="text-sm text-foreground">Saved schedules could not be loaded: {scheduleLoadError}</p><button type="button" onClick={() => refreshSlots()} className="mt-3 inline-flex min-h-9 items-center gap-2 rounded-lg border border-border px-3 text-sm font-medium hover:bg-muted"><RefreshCw aria-hidden="true" className="size-4" />Retry</button></div> : null}
        {!scheduleLoading && !scheduleLoadError && schedules.length === 0 ? <p className="rounded-xl bg-muted p-4 text-sm text-muted-foreground">No schedules have been saved for this doctor yet.</p> : null}
        {schedules.map((schedule) => { const exceptionType = exceptionTypes[schedule.id] ?? "day_off"; const workingPeriods = schedule.periods.filter((period) => period.weekday != null).sort((a, b) => (a.weekday ?? 0) - (b.weekday ?? 0)); const periodDates = schedule.periods.map((period) => period.service_date).filter((date): date is string => Boolean(date)).sort(); const rangeStart = schedule.starts_on ?? periodDates[0] ?? null; const rangeEnd = schedule.ends_on ?? periodDates[periodDates.length - 1] ?? null; return <article ref={(element) => { scheduleRefs.current[schedule.id] = element; }} key={schedule.id} className="scroll-mt-6 rounded-2xl border border-border bg-card p-5 shadow-sm"><div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="font-semibold text-card-foreground">{schedule.recurrence_type === "weekly" ? "Weekly schedule" : "Date-specific schedule"}</h3><p className="mt-1 text-sm font-medium text-primary">{schedule.mode === "wave" ? `Wave · ${schedule.wave_capacity_per_slot} places per slot` : `Stream · ${schedule.stream_capacity_per_window} total places per window`}</p></div><span className="rounded-full bg-muted px-3 py-1 text-xs font-medium text-muted-foreground">{generationErrors[schedule.id] ? "Generation failed" : availabilityRecoveryNeeded[schedule.id] ? "Needs recovery" : schedule.active ? "Active" : "Inactive"}</span></div>
          <dl className="mt-4 grid gap-3 rounded-xl bg-muted/50 p-4 text-sm sm:grid-cols-2"><div><dt className="font-medium text-muted-foreground">Start Date</dt><dd className="mt-1 font-semibold text-foreground">{formatScheduleDate(rangeStart)}</dd></div><div><dt className="font-medium text-muted-foreground">End Date</dt><dd className="mt-1 font-semibold text-foreground">{formatScheduleDate(rangeEnd)}</dd></div></dl>
          <div className="mt-4 divide-y divide-border rounded-xl border border-border">{workingPeriods.map((period) => <div key={`${period.weekday}-${period.start_time}`} className="flex items-center justify-between gap-3 px-4 py-3 text-sm"><span className="font-medium text-foreground">{period.weekday == null ? period.service_date : weekdaysLabels[period.weekday]}</span><span className="text-muted-foreground">{period.start_time.slice(0,5)}–{period.end_time.slice(0,5)} IST</span></div>)}{workingPeriods.length === 0 ? schedule.periods.map((period) => <div key={`${period.service_date}-${period.start_time}`} className="flex items-center justify-between gap-3 px-4 py-3 text-sm"><span className="font-medium text-foreground">{period.service_date}</span><span className="text-muted-foreground">{period.start_time.slice(0,5)}–{period.end_time.slice(0,5)} IST</span></div>) : null}</div>
          {schedule.recurrence_type === "weekly" && schedule.active ? <div className="mt-4">
            {editingScheduleId !== schedule.id ? <button type="button" onClick={() => beginScheduleEdit(schedule)} disabled={scheduleBusy || previewBusy} className="inline-flex min-h-10 items-center gap-2 rounded-lg border border-border px-3 text-sm font-semibold text-foreground hover:bg-muted disabled:opacity-60"><Pencil aria-hidden="true" className="size-4" />Edit schedule</button> : <div className="rounded-xl border border-border p-4">
              <p className="text-sm font-semibold text-foreground">Edit weekly hours</p><p className="mt-1 text-xs text-muted-foreground">Mode and capacity stay the same: {schedule.mode === "wave" ? `${schedule.wave_capacity_per_slot} places per slot` : `${schedule.stream_capacity_per_window} places per window`}.</p>
              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                <label className="text-sm font-medium">Starts on<DateInput placeholder="Select start date" required disabled={previewBusy || scheduleBusy} value={editStartsOn} onChange={(date) => { setEditStartsOn(date); setSchedulePreview(null); setSchedulePreviewInput(null); }} className="mt-1" /></label>
                <label className="text-sm font-medium">Ends on<DateInput placeholder="Select end date" required min={editStartsOn} disabled={previewBusy || scheduleBusy} value={editEndsOn} onChange={(date) => { setEditEndsOn(date); setSchedulePreview(null); setSchedulePreviewInput(null); }} className="mt-1" /></label>
                <fieldset className="sm:col-span-2"><legend className="mb-2 text-sm font-medium">Available weekdays</legend><div className="flex flex-wrap gap-3">{weekdaysLabels.map((label, day) => <label key={label} className="inline-flex items-center gap-2 text-sm"><input type="checkbox" disabled={previewBusy || scheduleBusy} checked={editWeekdays.includes(day)} onChange={(event) => { setEditWeekdays((current) => event.target.checked ? [...current, day].sort() : current.filter((value) => value !== day)); setSchedulePreview(null); setSchedulePreviewInput(null); }} className="size-4 accent-primary" />{label}</label>)}</div></fieldset>
                <label className="text-sm font-medium">Start time (IST)<input type="time" required disabled={previewBusy || scheduleBusy} value={editStart} onChange={(event) => { setEditStart(event.target.value); setSchedulePreview(null); setSchedulePreviewInput(null); }} className="mt-1 min-h-11 w-full rounded-lg border border-input bg-background px-3" /></label>
                <label className="text-sm font-medium">End time (IST)<input type="time" required disabled={previewBusy || scheduleBusy} value={editEnd} onChange={(event) => { setEditEnd(event.target.value); setSchedulePreview(null); setSchedulePreviewInput(null); }} className="mt-1 min-h-11 w-full rounded-lg border border-input bg-background px-3" /></label>
              </div>
              {schedulePreview?.schedule_id === schedule.id ? <div className="mt-4 space-y-3 rounded-lg bg-muted/50 p-4" aria-live="polite">
                <div><h4 className="font-semibold text-foreground">Change preview</h4><p className="mt-1 text-sm text-muted-foreground">Affected date range: {formatScheduleDate(editStartsOn)} – {formatScheduleDate(editEndsOn)}.</p>{schedulePreview.wave_appointment_duration_minutes ? <p className="mt-1 text-sm text-muted-foreground">Wave slots use your current appointment duration of {schedulePreview.wave_appointment_duration_minutes} minutes.</p> : null}<p className="mt-1 text-sm text-muted-foreground">{schedulePreview.added_availability.length} added, {schedulePreview.resized_availability.length} expanded, {schedulePreview.removed_availability.length} removed, {schedulePreview.unchanged_count} unchanged. Date exceptions will be preserved.</p></div>
                {!schedulePreview.can_update ? <p className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-foreground">Another active saved schedule overlaps these weekly hours. Resolve the conflict before saving.</p> : null}
                {schedulePreview.saved_schedule_period_conflicts.map((conflict, index) => <p key={`${conflict.existing_schedule_id}-${index}`} className="text-sm text-foreground">Conflict: proposed {weekdaysLabels[conflict.weekday]} {conflict.proposed_start_time}–{conflict.proposed_end_time} overlaps another saved schedule ({conflict.existing_start_time}–{conflict.existing_end_time}).</p>)}
                <section className="rounded-lg border border-border p-3" aria-labelledby={`attention-${schedule.id}`}><h5 id={`attention-${schedule.id}`} className="text-sm font-semibold text-foreground">Appointments requiring attention ({schedulePreview.affected_appointments.length})</h5>{schedulePreview.affected_appointments.length ? <ul className="mt-2 space-y-2 text-sm text-muted-foreground">{schedulePreview.affected_appointments.map((appointment) => <li key={appointment.id} className="flex flex-wrap items-center justify-between gap-2"><span>{formatDate(appointment.date)} · {formatTime(appointment.start_time)}–{formatTime(appointment.end_time)} IST · Confirmed</span><Link href={`/doctor/appointments?appointment=${encodeURIComponent(appointment.id)}`} className="font-semibold text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">Open appointment</Link></li>)}</ul> : <p className="mt-1 text-xs text-muted-foreground">No confirmed appointments fall outside the proposed weekly hours.</p>}</section>
                {schedulePreview.active_payment_holds.length ? <section className="rounded-lg border border-border p-3" aria-label="Active payment holds"><h5 className="text-sm font-semibold text-foreground">Active payment holds ({schedulePreview.active_payment_holds.length})</h5><ul className="mt-2 space-y-1 text-sm text-muted-foreground">{schedulePreview.active_payment_holds.map((hold) => <li key={hold.id}>{formatDate(hold.date)} · {formatTime(hold.start_time)}–{formatTime(hold.end_time)} IST · Expires {formatHoldExpiry(hold.expires_at) ?? "soon"}</li>)}</ul></section> : null}
                {schedulePreview.active_allocations.length ? <section className="rounded-lg border border-border p-3" aria-label="Active availability allocations"><h5 className="text-sm font-semibold text-foreground">Active allocations ({schedulePreview.active_allocations.length})</h5><ul className="mt-2 space-y-1 text-sm text-muted-foreground">{schedulePreview.active_allocations.map((allocation) => <li key={allocation.id}>{formatDate(allocation.date)} · {formatTime(allocation.start_time)}–{formatTime(allocation.end_time)} IST · {allocation.status}</li>)}</ul></section> : null}
                <details className="rounded-lg border border-border p-3"><summary className="cursor-pointer text-sm font-medium text-foreground">View slot-level details</summary>
                {schedulePreview.added_availability.length ? <div className="mt-3"><p className="text-sm font-medium text-foreground">Added availability</p><div className="mt-1 space-y-2 text-sm text-muted-foreground">{Object.entries(groupByDate(schedulePreview.added_availability)).map(([date, items]) => <p key={date}><span className="font-medium text-foreground">{formatDate(date)}:</span> {items.map((item) => `${formatTime(item.start_time)}–${formatTime(item.end_time)}`).join(", ")} IST</p>)}</div></div> : <p className="mt-3 text-sm text-muted-foreground">No availability additions.</p>}
                {schedulePreview.resized_availability.length ? <div className="mt-3"><p className="text-sm font-medium text-foreground">Expanded Stream windows</p><div className="mt-1 space-y-2 text-sm text-muted-foreground">{schedulePreview.resized_availability.map((item) => <p key={item.availability_id}><span className="font-medium text-foreground">{formatDate(item.date)}:</span> {formatTime(item.previous_start_time)}?{formatTime(item.previous_end_time)} expanded to {formatTime(item.start_time)}?{formatTime(item.end_time)} IST. Existing allocation capacity is retained.</p>)}</div></div> : null}{schedulePreview.removed_availability.length ? <div className="mt-3"><p className="text-sm font-medium text-foreground">Removed availability; existing reservations remain</p><div className="mt-1 space-y-2 text-sm text-muted-foreground">{Object.entries(groupByDate(schedulePreview.removed_availability)).map(([date, items]) => <p key={date}><span className="font-medium text-foreground">{formatDate(date)}:</span> {items.map((item) => `${formatTime(item.start_time)}–${formatTime(item.end_time)}${item.has_confirmed_appointment ? " (confirmed appointment preserved)" : ""}${item.has_active_payment_hold ? " (payment hold preserved)" : ""}${item.has_active_allocation ? " (allocation preserved)" : ""}`).join(", ")} IST</p>)}</div></div> : null}
                {schedulePreview.blocked_availability.length ? <div className="mt-3"><p className="text-sm font-medium text-foreground">New availability skipped because of conflicts or active reservations</p><div className="mt-1 space-y-2 text-sm text-muted-foreground">{Object.entries(groupByDate(schedulePreview.blocked_availability)).map(([date, items]) => <p key={date}><span className="font-medium text-foreground">{formatDate(date)}:</span> {items.map((item) => `${formatTime(item.start_time)}–${formatTime(item.end_time)} (${item.reasons.map((reason) => reason.replaceAll("_", " ")).join(", ")})`).join("; ")} IST</p>)}</div></div> : null}
                </details>
              </div> : null}
              {scheduleEditError ? <p className="mt-4 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-foreground" role="alert">{scheduleEditError}</p> : null}
              {!schedulePreview || schedulePreview.schedule_id !== schedule.id ? <p className="mt-3 text-xs text-muted-foreground">Review Changes is required to enable Save.</p> : null}
              <div className="mt-4 flex flex-wrap gap-2"><button type="button" onClick={() => void reviewScheduleEdit(schedule)} disabled={previewBusy || scheduleBusy} className="inline-flex min-h-10 items-center gap-2 rounded-lg border border-border px-3 text-sm font-semibold text-foreground hover:bg-muted disabled:opacity-60"><Eye aria-hidden="true" className="size-4" />{previewBusy ? "Reviewing…" : "Review changes"}</button><button type="button" onClick={() => void saveScheduleEdit(schedule)} disabled={scheduleBusy || previewBusy || !schedulePreview || schedulePreview.schedule_id !== schedule.id || !schedulePreview.can_update} className="inline-flex min-h-10 items-center gap-2 rounded-lg bg-primary px-3 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-60"><Save aria-hidden="true" className="size-4" />{scheduleBusy ? "Saving…" : "Save changes"}</button><button type="button" onClick={cancelScheduleEdit} disabled={scheduleBusy || previewBusy} className="inline-flex min-h-10 items-center gap-2 rounded-lg border border-border px-3 text-sm font-semibold text-foreground hover:bg-muted disabled:opacity-60"><X aria-hidden="true" className="size-4" />Cancel</button></div>
            </div>}
          </div> : null}
          {availabilityRecoveryNeeded[schedule.id] && schedule.active ? <form className="mt-4 flex flex-wrap items-end gap-3 border-t border-border pt-4" onSubmit={(event) => { event.preventDefault(); const data = new FormData(event.currentTarget); void generateSchedule(schedule, String(data.get("recovery-from") ?? ""), String(data.get("recovery-to") ?? "")); }}>
            {!schedule.starts_on || !schedule.ends_on ? <><label className="text-sm font-medium">Recovery starts on<DateInput name="recovery-from" required min={todayInApplicationZone()} defaultValue={todayInApplicationZone()} className="mt-1" /></label><label className="text-sm font-medium">Recovery ends on<DateInput name="recovery-to" required min={todayInApplicationZone()} defaultValue={schedule.ends_on ?? ""} className="mt-1" /></label></> : <p className="mr-auto text-sm text-muted-foreground">Use saved range {schedule.starts_on} to {schedule.ends_on}; only remaining future availability will be generated.</p>}
            <button type="submit" disabled={scheduleBusy} className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-border bg-background px-4 font-semibold text-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-60"><Sparkles aria-hidden="true" className="size-4" />Recover missing availability</button>
          </form> : null}
          {generationErrors[schedule.id] ? <p className="mt-3 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm" role="alert">Availability generation failed: {generationErrors[schedule.id]}</p> : null}
          {generationConflicts[schedule.id]?.map((conflict, index) => <p key={`${conflict.date}-${conflict.start_time}-${index}`} className="mt-3 rounded-lg border border-border bg-muted/50 p-3 text-sm text-muted-foreground">Availability on {formatDate(conflict.date)} at {formatTime(conflict.start_time)}–{formatTime(conflict.end_time)} IST was preserved and skipped because it overlaps {conflict.reason}. No retry is offered because changing that row could affect existing booking history.</p>)}
          <details className="mt-4 border-t border-border pt-4"><summary className="cursor-pointer text-sm font-semibold text-foreground">Date exceptions</summary><form className="mt-4 grid gap-4 sm:grid-cols-2" onSubmit={(e) => void submitException(e, schedule.id)}><div className="sm:col-span-2"><p className="text-sm text-muted-foreground">Adjust this schedule for one date.</p></div><label className="text-sm font-medium">Exception date<DateInput name="exception_date" required min={todayInApplicationZone()} className="mt-1" /></label><div><label htmlFor={`exception-type-${schedule.id}`} className="text-sm font-medium">Change hours</label><Select value={exceptionType} onValueChange={(value) => setExceptionTypes((current) => ({ ...current, [schedule.id]: value as typeof exceptionType }))}><SelectTrigger className="mt-1" id={`exception-type-${schedule.id}`}><SelectValue /></SelectTrigger><SelectContent><SelectItem value="day_off">Day off</SelectItem><SelectItem value="override">Override hours</SelectItem><SelectItem value="additional">Add hours</SelectItem></SelectContent></Select></div>{exceptionType !== "day_off" ? <><label className="text-sm font-medium">Start time<input name="exception_start" type="time" required defaultValue="09:00" className="mt-1 min-h-11 w-full rounded-lg border border-input bg-background px-3" /></label><label className="text-sm font-medium">End time<input name="exception_end" type="time" required defaultValue="17:00" className="mt-1 min-h-11 w-full rounded-lg border border-input bg-background px-3" /></label></> : null}<div className="sm:col-span-2"><button type="submit" disabled={scheduleBusy || !schedule.active} className="inline-flex min-h-11 items-center justify-center rounded-lg border border-primary bg-background px-4 font-semibold text-primary transition-colors hover:bg-primary hover:text-primary-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-60">{scheduleBusy ? "Saving…" : "Save date exception"}</button></div></form></details>
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
          <div className="grid grid-cols-7 justify-items-center gap-1">{calendarDates.map((day, index) => { if (!day) return <span key={"blank-" + index} aria-hidden="true" className="size-10" />; const count = availabilityCounts[day] ?? 0; const reservations = reservationCounts[day] ?? 0; const selected = day === selectedDate; const today = day === todayInApplicationZone(); const label = `${formatDate(day)}, ${count ? `${count} bookable availability option${count === 1 ? "" : "s"}` : "no bookable availability"}${reservations ? `, ${reservations} reservation-only row${reservations === 1 ? "" : "s"}` : ""}`; return <button key={day} type="button" aria-label={label} aria-pressed={selected} onClick={() => setSelectedDate(day)} className={`flex size-10 flex-col items-center justify-center rounded-lg text-xs transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring ${today ? "ring-2 ring-inset ring-ring" : ""} ${selected ? "bg-primary font-semibold text-primary-foreground" : count ? "bg-secondary/60 font-medium text-secondary-foreground hover:bg-secondary" : "text-muted-foreground hover:bg-muted"}`}><span>{Number(day.slice(-2))}</span><span className="flex min-h-2 items-center gap-0.5 text-[9px] leading-none" aria-hidden="true">{count ? count : ""}{reservations ? <span className="rounded-sm bg-muted px-0.5 text-[8px]">R{reservations > 1 ? reservations : ""}</span> : null}</span></button>; })}</div>
          <div className="mt-5 border-t border-border pt-4"><h3 className="font-semibold text-card-foreground">{formatDate(selectedDate)}</h3>{selectedDateSlots.length === 0 ? <p className="mt-2 text-sm text-muted-foreground">No availability or reservations on this date.</p> : <ul className="mt-3 divide-y divide-border">{selectedDateSlots.map((slot) => <li key={slot.id} className="flex items-center justify-between gap-4 py-3"><div><span className="inline-flex rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">{slot.reservation_only ? "Reservation" : slot.mode === "wave" ? "Wave" : "Stream"}</span><p className="mt-1 text-sm text-muted-foreground">{slot.mode === "stream" ? "Continuous window · " : ""}{formatTime(slot.start_time)}–{formatTime(slot.end_time)} IST</p>{slot.reservation_only ? <p className="mt-1 text-xs text-muted-foreground">{slot.preserved_reservation_count ?? 1} existing booking{(slot.preserved_reservation_count ?? 1) === 1 ? "" : "s"} preserved. Not available for new bookings.</p> : slot.capacity != null && slot.remaining_capacity != null ? <p className="mt-1 text-xs text-muted-foreground">{slot.remaining_capacity} / {slot.capacity} places available</p> : null}</div>{!slot.reservation_only ? <button type="button" aria-label={`Remove availability on ${formatDate(slot.date)} at ${formatTime(slot.start_time)}`} onClick={() => { setDeleteError(null); setDeleteTarget(slot); }} disabled={activeSlotId !== null} className="inline-flex size-10 shrink-0 items-center justify-center rounded-lg text-destructive hover:bg-destructive/5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-50">{activeSlotId === slot.id ? <RefreshCw aria-hidden="true" className="size-4 animate-spin" /> : <Trash2 aria-hidden="true" className="size-4" />}</button> : null}</li>)}</ul>}</div>
        </div> : null}
      </section>      <AlertDialog open={deleteTarget !== null} onOpenChange={(open) => {
        if (!open && activeSlotId === null) {
          setDeleteTarget(null);
          setDeleteError(null);
        }
      }}>
        <AlertDialogContent className="max-w-md rounded-2xl border border-border bg-card p-6 text-card-foreground shadow-xl ring-0 sm:max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle>Remove this availability?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget ? `Only ${formatDate(deleteTarget.date)} at ${formatTime(deleteTarget.start_time)} IST is affected. The weekly schedule and other dates stay unchanged. Confirmed appointments remain preserved as reservations.` : "Only the selected date and time will be affected."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {deleteError ? <p className="rounded-lg bg-destructive/5 p-3 text-sm text-foreground" role="alert">{deleteError}</p> : null}
          <AlertDialogFooter className="m-0 flex-row justify-end gap-3 border-0 bg-transparent p-0">
            <AlertDialogCancel disabled={activeSlotId !== null}>Keep availability</AlertDialogCancel>
            <AlertDialogAction variant="destructive" disabled={activeSlotId !== null} onClick={(event) => {
              event.preventDefault();
              if (deleteTarget) void handleDelete(deleteTarget);
            }}>{activeSlotId !== null ? "Removing availability…" : "Remove availability"}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
