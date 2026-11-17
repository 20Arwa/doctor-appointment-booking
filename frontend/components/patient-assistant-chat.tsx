"use client";

import { useAuth } from "@clerk/nextjs";
import { ArrowDown, ArrowUp, Bot, CalendarDays, Check, Clock3, History, Info, LoaderCircle, Maximize2, MessageCircle, MessageSquarePlus, Mic, MicOff, Play, RefreshCw, Search, Send, Settings2, Sparkles, Stethoscope, UserRound, VolumeX, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { getDoctorAppointmentPatientId } from "@/lib/profile-api";
import { Button } from "@/components/ui/button";
import { AssistantApiError, confirmAssistantAction, createAssistantConversation, dismissAssistantProposal, getAssistantActionStatus, getAssistantConversation, listAssistantConversations, prepareAssistantAction, sendAssistantMessage, type AssistantActionIntent, type AssistantActionType, type AssistantConversation, type AssistantResult } from "@/lib/assistant-api";
import { assistantActiveConversationStorageKey, assistantMessageDateLabel, assistantMessageTimeLabel, canSendAssistantMessage, chatReducer, getAssistantDisplayContent, getAssistantResultRows, getVisibleAssistantResults, initialChatState, isNearMessageListBottom, isNearMessageListTop, preserveScrollAfterPrepend, resolveAssistantConversationId, restoreDraftAfterFailedSubmission, retryOperation, shouldForceScrollAfterAssistantAction, shouldShowAssistantDateSeparator, shouldShowHistoryRecovery } from "@/lib/assistant-chat-state";
import { isProposalExpired, proposalDescription, proposalStatusFromBackend, proposalTitle, proposalTypeForResult, reconcileActionStatus, type ProposalStatus } from "@/lib/assistant-action-state";
import { useVoiceAssistant } from "@/lib/use-voice-assistant";
import { assistantResponseSpeechText } from "@/lib/assistant-speech";
import { AssistantMarkdown } from "@/components/assistant-markdown";
import { AssistantConversationHistory } from "@/components/assistant-conversation-history";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

function readActiveConversation(audience: "patient" | "doctor", userId: string) {
  try { return window.localStorage.getItem(assistantActiveConversationStorageKey(audience, userId)); } catch { return null; }
}
function rememberActiveConversation(audience: "patient" | "doctor", userId: string, id: string) {
  try { window.localStorage.setItem(assistantActiveConversationStorageKey(audience, userId), id); } catch { /* URL and in-memory state still retain the conversation. */ }
}

function displayTime(value: unknown) {
  if (typeof value !== "string") return "";
  const [hourText, minute] = value.split(":"); const hour = Number(hourText);
  return Number.isFinite(hour) ? `${hour % 12 || 12}:${minute} ${hour >= 12 ? "PM" : "AM"}` : value;
}
function dateLabel(value: unknown) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return "";
  return new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeZone: "Asia/Kolkata" }).format(new Date(`${value}T12:00:00+05:30`));
}
function assistantContentForResults(content: string, results: AssistantResult[]) {
  const visible = getVisibleAssistantResults(content, results);
  if (visible.length === 1 && visible[0].tool === "get_doctor_appointments" && visible[0].data.scope === "nearest"
    && getAssistantResultRows(visible[0]).length === 1) return "Your next confirmed appointment:";
  return getAssistantDisplayContent(content, results);
}

function resultRowHref(result: AssistantResult, index: number, doctorMode: boolean) {
  const item = getAssistantResultRows(result)[index] as Record<string, unknown> | undefined;
  const action = result.ui_actions?.[index];
  if (!item || !action) return null;
  if (doctorMode) {
    if (result.tool === "get_doctor_appointments" && action.type === "appointment" && typeof action.appointment_id === "string") {
      return `/doctor/appointments?appointment=${encodeURIComponent(action.appointment_id)}`;
    }
    if (result.tool === "get_doctor_nearest_slots" && action.type === "schedule_slot"
      && typeof action.availability_id === "string" && typeof item.date === "string" && typeof item.start_time === "string") {
      return `/doctor/availability?date=${encodeURIComponent(item.date)}&time=${encodeURIComponent(item.start_time)}`;
    }
    if (result.tool === "get_doctor_schedule_conflicts" && typeof item.date === "string" && typeof item.start_time === "string") {
      return `/doctor/availability?date=${encodeURIComponent(item.date)}&time=${encodeURIComponent(item.start_time)}`;
    }
    return null;
  }
  if (result.tool === "search_doctors" && action.type === "doctor" && typeof action.doctor_id === "string") {
    return `/patient/doctors/${encodeURIComponent(action.doctor_id)}`;
  }
  if (result.tool === "get_patient_appointments" && action.type === "appointment" && typeof action.appointment_id === "string") {
    return `/patient/appointments?appointment=${encodeURIComponent(action.appointment_id)}`;
  }
  return null;
}

function resultRowActionLabel(result: AssistantResult, doctorMode: boolean) {
  if (doctorMode && result.tool === "get_doctor_nearest_slots") return "View availability";
  if (doctorMode && result.tool === "get_doctor_schedule_conflicts") return "View availability";
  if (!doctorMode && result.tool === "get_available_slots") return "Choose this time";
  if (!doctorMode && result.tool === "search_doctors") return "View doctor";
  return "View appointment";
}

function ResultCards({ result, doctorMode, onSelectSlot, onSelectAppointment }: { result: AssistantResult; doctorMode: boolean; onSelectSlot?: (index: number) => void; onSelectAppointment?: (index: number) => void }) {
  const { getToken } = useAuth();
  const router = useRouter();
  const rows = getAssistantResultRows(result);
  const pendingAssistedReschedules = doctorMode && result.tool === "get_doctor_nearest_slots" && Array.isArray(result.data.pending_assisted_reschedules)
    ? result.data.pending_assisted_reschedules as Record<string, unknown>[] : [];
  const doctorTool = result.tool.startsWith("get_doctor_");
  if (!rows.length && !pendingAssistedReschedules.length) return result.tool === "get_patient_payment_history" ? <p className="mt-2 text-sm text-muted-foreground">No payment records were found.</p> : result.tool === "get_doctor_assisted_reschedule_requests" ? <p className="mt-2 text-sm text-muted-foreground">No assisted rescheduling requests were found.</p> : doctorTool ? <p className="mt-2 text-sm text-muted-foreground">No matching records were found for this range.{typeof result.data.notice === "string" ? ` ${result.data.notice}` : ""}</p> : null;
  return <div>{rows.length ? <ul className={`mt-3 grid w-full gap-2 ${compact ? "grid-cols-1" : "sm:grid-cols-2"}`}>{rows.map((entry, index) => {
    if (!entry || typeof entry !== "object") return null;
    const item = entry as Record<string, unknown>; const doctor = item.doctor as Record<string, unknown> | undefined;
    const paymentAppointment = item.appointment as Record<string, unknown> | undefined;
    const assistedAppointment = result.tool === "get_doctor_assisted_reschedule_requests" ? item.appointment as Record<string, unknown> | undefined : undefined;
    const currentAppointment = result.tool === "get_doctor_assisted_reschedule_requests" ? item.current_appointment as Record<string, unknown> | undefined : undefined;
    const paymentDoctor = paymentAppointment?.doctor as Record<string, unknown> | undefined;
    const title = result.tool === "get_patient_payment_history" && typeof paymentDoctor?.name === "string" ? paymentDoctor.name
      : result.tool === "get_doctor_schedules" ? `${String(item.mode || "Doctor")} schedule`
      : result.tool === "get_doctor_schedule_exceptions" ? String(item.exception_type || "Schedule exception").replaceAll("_", " ")
        : result.tool === "get_doctor_schedule_conflicts" ? "Scheduling conflict"
          : typeof doctor?.name === "string" ? doctor.name : typeof item.name === "string" ? item.name
            : ["get_available_slots", "get_doctor_nearest_slots"].includes(result.tool) ? "Available appointment" : "Appointment";
    const date = dateLabel(item.date);
    const uiAction = result.ui_actions?.[index];
    const appointmentId = doctorMode && result.tool === "get_doctor_appointments" && uiAction?.type === "appointment" && typeof uiAction.appointment_id === "string" ? uiAction.appointment_id : null;
    const rowHref = resultRowHref(result, index, doctorMode);
    const actionAppointmentId = uiAction?.type === "appointment" && typeof uiAction.appointment_id === "string" ? uiAction.appointment_id : null;
    const rowKey = actionAppointmentId ? `appointment-${actionAppointmentId}` : `${String(item.id || item.date || item.name)}-${index}`;
    return <li key={rowKey} className="rounded-xl border border-border bg-background p-3 text-sm">
      <p className="font-semibold text-foreground">{title}</p>
      {typeof item.specialty === "string" ? <p className="mt-1 text-muted-foreground">{item.specialty}</p> : null}
      {["get_available_slots", "get_doctor_nearest_slots"].includes(result.tool) && item.mode === "wave" ? <p className="mt-1 font-medium text-foreground">Available slot · Wave</p> : null}
      {["get_available_slots", "get_doctor_nearest_slots"].includes(result.tool) && item.mode === "stream" ? <p className="mt-1 font-medium text-foreground">Available window · Stream</p> : null}
      {result.tool === "get_available_slots" && item.mode === "legacy" ? <p className="mt-1 font-medium text-foreground">Legacy availability</p> : null}
      {doctorMode && result.tool === "get_doctor_nearest_slots" && item.source === "private_one_off" ? <p className="mt-1 font-medium text-muted-foreground">Private one-off availability</p> : null}
      {date ? <p className="mt-1 flex items-center gap-1 text-muted-foreground"><Clock3 aria-hidden="true" className="size-3.5" />{date} · {displayTime(item.start_time)}–{displayTime(item.end_time)}</p> : null}
      {typeof item.consultation_fee === "number" ? <p className="mt-1 text-xs text-muted-foreground">Consultation fee: ₹{item.consultation_fee.toLocaleString("en-IN")}</p> : null}
      {result.tool === "get_patient_payment_history" ? <>
        <p className="mt-1 text-sm text-muted-foreground">Payment: {String(item.status || "unknown")} · {String(item.currency || "INR")} {String(item.amount || "")}</p>
        {paymentAppointment ? <p className="mt-1 text-xs text-muted-foreground">Appointment{typeof paymentAppointment.date === "string" ? ` · ${dateLabel(paymentAppointment.date)}` : ""}{typeof paymentAppointment.start_time === "string" ? ` at ${displayTime(paymentAppointment.start_time)}` : ""}{typeof paymentDoctor?.name === "string" && !title.includes(paymentDoctor.name) ? ` · ${paymentDoctor.name}` : ""}</p> : null}
        {Array.isArray(item.refunds) ? (item.refunds as Record<string, unknown>[]).map((refund, refundIndex) => <p key={refundIndex} className="mt-1 text-xs text-muted-foreground">Refund: {String(refund.status || "unknown")} · {String(refund.currency || item.currency || "INR")} {String(refund.amount || "")}</p>) : null}
      </> : null}
      {result.tool === "get_doctor_assisted_reschedule_requests" && assistedAppointment ? <>
        <p className="mt-1 text-muted-foreground">Affected appointment · {dateLabel(assistedAppointment.date)} · {displayTime(assistedAppointment.start_time)}–{displayTime(assistedAppointment.end_time)} · {String(item.mode || "Appointment").replaceAll("_", " ")}</p>
        <p className="mt-1 text-muted-foreground">Request status: {String(item.status || "unknown").replaceAll("_", " ")}</p>
        <p className="mt-1 text-muted-foreground">Patient response: {String(item.patient_response || "No response recorded")}</p>
        {currentAppointment && (currentAppointment.date !== assistedAppointment.date || currentAppointment.start_time !== assistedAppointment.start_time || currentAppointment.end_time !== assistedAppointment.end_time) ? <p className="mt-1 text-xs text-muted-foreground">Current appointment: {dateLabel(currentAppointment.date)} · {displayTime(currentAppointment.start_time)}–{displayTime(currentAppointment.end_time)} · {String(currentAppointment.status || "unknown").replaceAll("_", " ")}</p> : null}
      </> : null}
      {typeof item.remaining_capacity === "number" && typeof item.capacity === "number" ? <p className="mt-1 text-xs text-muted-foreground">{item.remaining_capacity} of {item.capacity} places remaining{item.mode === "stream" ? " in this window" : " in this slot"}</p> : null}
      {result.tool === "get_doctor_schedules" ? <>
        {typeof item.recurrence_type === "string" ? <p className="mt-1 text-xs capitalize text-muted-foreground">{item.recurrence_type.replaceAll("_", " ")} · {String(item.visibility || "private")} schedule</p> : null}
        {typeof item.starts_on === "string" || typeof item.ends_on === "string" ? <p className="mt-1 text-xs text-muted-foreground">Active {typeof item.starts_on === "string" ? `from ${dateLabel(item.starts_on)}` : "from its start date"}{typeof item.ends_on === "string" ? ` through ${dateLabel(item.ends_on)}` : " with no end date"}</p> : null}
        {Array.isArray(item.periods) ? <ul className="mt-2 space-y-1 text-xs text-muted-foreground">{(item.periods as Record<string, unknown>[]).slice(0, 14).map((period, periodIndex) => <li key={periodIndex}>{typeof period.service_date === "string" ? dateLabel(period.service_date) : ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][Number(period.weekday)] || "Weekly"}: {displayTime(period.start_time)}–{displayTime(period.end_time)}</li>)}</ul> : null}
      </> : null}
      {result.tool === "get_doctor_schedule_exceptions" && Array.isArray(item.periods) ? <p className="mt-1 text-xs text-muted-foreground">{(item.periods as Record<string, unknown>[]).map((period) => `${displayTime(period.start_time)}–${displayTime(period.end_time)}`).join(", ") || "No hours"}</p> : null}
      {result.tool === "get_doctor_schedule_conflicts" && Array.isArray(item.conflicts) ? <p className="mt-1 text-xs text-muted-foreground">{(item.conflicts as unknown[]).map((conflict) => String(conflict).replaceAll("_", " ")).join(" · ")}</p> : null}
      {result.tool === "get_doctor_schedule_conflicts" && typeof item.occupied === "number" && typeof item.remaining_capacity === "number" && typeof item.capacity === "number" ? <p className="mt-1 text-xs text-muted-foreground">{item.occupied} occupied · {item.remaining_capacity} remaining of {item.capacity}</p> : null}
      {rowHref || appointmentId || (result.tool === "get_available_slots" && onSelectSlot) || (result.tool === "get_patient_appointments" && onSelectAppointment) ? <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-border pt-3">
        {rowHref ? <Link className="text-sm font-medium text-primary underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring" href={rowHref}>{resultRowActionLabel(result, doctorMode)}</Link> : null}
          {result.tool === "get_available_slots" && onSelectSlot ? <button type="button" className="text-sm font-medium text-primary underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring" onClick={() => onSelectSlot(index)}>{resultRowActionLabel(result, doctorMode)}</button> : null}
        {result.tool === "get_patient_appointments" && onSelectAppointment ? <button type="button" className="text-sm font-medium text-primary underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring" onClick={() => onSelectAppointment(index)}>Select appointment</button> : null}
        {appointmentId ? <button type="button" className="text-sm font-medium text-primary underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring" onClick={async () => { try { const token = await getToken(); if (!token) return; const patientId = await getDoctorAppointmentPatientId(token, appointmentId); router.push(`/doctor/patients/${encodeURIComponent(patientId)}`); } catch { router.push(`/doctor/appointments?appointment=${encodeURIComponent(appointmentId)}`); } }}>View patient</button> : null}
      </div> : null}
    </li>;
  })}</ul> : null}{pendingAssistedReschedules.length ? <section aria-label="Assisted rescheduling requests" className="mt-3 rounded-lg border border-border bg-muted/30 p-3">
    <h4 className="text-xs font-semibold text-foreground">Appointments awaiting assisted rescheduling</h4>
    <ul className={`mt-2 grid w-full gap-2 ${compact ? "grid-cols-1" : "sm:grid-cols-2"}`}>{pendingAssistedReschedules.map((item, index) => <li key={`${String(item.date)}-${String(item.start_time)}-${index}`} className="w-full min-w-0 rounded-md border border-border bg-background p-2 text-sm">
      <p className="font-medium text-foreground">{dateLabel(item.date)} · {displayTime(item.start_time)}–{displayTime(item.end_time)}</p>
      <p className="mt-1 text-xs text-muted-foreground">{String(item.mode || "Appointment").replaceAll("_", " ")} · Awaiting patient response · {String(item.valid_suggestion_count || 0)} current alternative{Number(item.valid_suggestion_count) === 1 ? "" : "s"}</p>
    </li>)}</ul>
  </section> : null}{doctorTool && typeof result.data.notice === "string" ? <p className="mt-3 text-xs text-muted-foreground">{result.data.notice}</p> : null}</div>;
}

function AssistantResultsCta({ results, doctorMode }: { results: AssistantResult[]; doctorMode: boolean }) {
  if (doctorMode) {
    const scheduleResults = results.filter(({ tool }) => ["get_doctor_schedules", "get_doctor_schedule_exceptions", "get_doctor_schedule_conflicts", "get_doctor_nearest_slots"].includes(tool));
    const needsSharedAvailabilityLink = scheduleResults.some((result) => getAssistantResultRows(result).some((_row, index) => !resultRowHref(result, index, true)));
    if (!needsSharedAvailabilityLink) return null;
    const scheduleResult = scheduleResults.find((result) => getAssistantResultRows(result).some((_row, index) => !resultRowHref(result, index, true)))!;
    const item = getAssistantResultRows(scheduleResult).find((_row, index) => !resultRowHref(scheduleResult, index, true)) as Record<string, unknown> | undefined;
    const query = item?.date ? `?date=${encodeURIComponent(String(item.date))}${item.start_time ? `&time=${encodeURIComponent(String(item.start_time))}` : ""}` : "";
    return <Link className="mt-3 inline-block text-sm font-medium text-primary underline" href={`/doctor/availability${query}`}>Open availability</Link>;
  }
  const appointments = results.find(({ tool }) => tool === "get_patient_appointments");
  if (appointments && !getAssistantResultRows(appointments).some((_row, index) => resultRowHref(appointments, index, false))) {
    return <Link className="mt-3 inline-block text-sm font-medium text-primary underline" href="/patient/appointments">Open My Appointments</Link>;
  }
  const paymentHistory = results.find(({ tool }) => tool === "get_patient_payment_history");
  return paymentHistory ? <Link className="mt-3 inline-block text-sm font-medium text-primary underline" href="/patient/payments">View full payment history</Link> : null;
}
function ResultIcon({ result }: { result: AssistantResult }) { return result.tool === "search_doctors" ? <Stethoscope aria-hidden="true" className="size-4" /> : <CalendarDays aria-hidden="true" className="size-4" />; }

function AssistantActionProposal({ result, assistantMessageId, conversationId, getToken }: { result: AssistantResult; assistantMessageId: string; conversationId: string; getToken: () => Promise<string | null>; }) {
  const actionType = proposalTypeForResult(result);
  const [status, setStatus] = useState<ProposalStatus>("loading");
  const [intent, setIntent] = useState<AssistantActionIntent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checkoutUrl, setCheckoutUrl] = useState<string | null>(null);
  const inFlight = useRef(false);
  const dismissed = useRef(false);
  useEffect(() => {
    if (!actionType) return;
    let active = true;
    void (async () => {
      try {
        const token = await getToken();
        if (!token) throw new AssistantApiError(401, "Your secure sign-in session is not ready. Please sign in again.");
        const prepared = await prepareAssistantAction(token, conversationId, assistantMessageId, actionType as AssistantActionType);
        if (!active || dismissed.current) return;
        if (prepared.status === "dismissed") {
          dismissed.current = true;
          setStatus("dismissed");
          return;
        }
        setIntent(prepared);
        const fallbackStatus = proposalStatusFromBackend(prepared.status, prepared.expires_at);
        setStatus(fallbackStatus);
        const latest = await reconcileActionStatus(() => getAssistantActionStatus(token, conversationId, prepared.id), fallbackStatus);
        if (active && !dismissed.current) {
          if (latest.summary) setIntent((current) => current ? { ...current, summary: latest.summary } : current);
          setStatus(latest.status);
        }
      } catch (cause) {
        if (!active || dismissed.current) return;
        setError(cause instanceof Error ? cause.message : "This proposal could not be verified. Ask the assistant to prepare it again.");
        setStatus(cause instanceof AssistantApiError && cause.code === "ACTION_EXPIRED" ? "expired" : "failed");
      }
    })();
    return () => { active = false; };
  }, [actionType, assistantMessageId, conversationId, getToken]);
  useEffect(() => {
    if (!intent || status !== "pending") return;
    const remaining = Math.max(0, Date.parse(intent.expires_at) - Date.now());
    const timer = window.setTimeout(() => setStatus("expired"), remaining);
    return () => window.clearTimeout(timer);
  }, [intent, status]);
  if (!actionType) return null;
  const summary = intent?.summary || {};
  const completedBooking = actionType === "book" && status === "completed";
  const date = dateLabel(summary.date);
  const dateTime = [date, displayTime(summary.start_time)].filter(Boolean).join(" · ");
  const fee = summary.consultation_fee;
  async function confirm() {
    if (!intent || inFlight.current || !actionType) return;
    if (status === "pending" && isProposalExpired(intent.expires_at)) { setStatus("expired"); return; }
    inFlight.current = true;
    setStatus("confirming");
    setError(null);
    try {
      const token = await getToken();
      if (!token) throw new AssistantApiError(401, "Your secure sign-in session is not ready. Please sign in again.");
      const outcome = await confirmAssistantAction(token, conversationId, intent.id);
      const next = proposalStatusFromBackend(outcome.status, outcome.expires_at || intent.expires_at);
      setStatus(next);
      if (outcome.checkout_url) setCheckoutUrl(outcome.checkout_url);
      if (outcome.reason === "duplicate_booking") setError("You already have a confirmed appointment with this doctor at that time. No new booking was created.");
      else if (next === "failed") setError("The action could not be completed. Refresh the proposal and try again.");
      if (next === "expired") setError("This proposal expired. Ask the assistant to prepare it again.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "We couldn't complete this action. Please try again.");
      setStatus("processing");
      const latest = await reconcileActionStatus(async () => {
        const token = await getToken();
        if (!token) throw new Error("Session unavailable");
        return getAssistantActionStatus(token, conversationId, intent.id);
      }, cause instanceof AssistantApiError && cause.code === "ACTION_EXPIRED" ? "expired" : "failed");
      if (latest.summary) setIntent((current) => current ? { ...current, summary: latest.summary } : current);
      setStatus(latest.status);
      if (latest.status === "completed") setError(null);
    } finally { inFlight.current = false; }
  }
  async function dismiss() {
    if (!actionType || inFlight.current || ["loading", "confirming", "dismissing", "checkout_pending", "refund_pending", "completed"].includes(status)) return;
    dismissed.current = true;
    inFlight.current = true;
    setStatus("dismissing");
    setError(null);
    try {
      const token = await getToken();
      if (!token) throw new AssistantApiError(401, "Your secure sign-in session is not ready. Please sign in again.");
      await dismissAssistantProposal(token, conversationId, assistantMessageId, actionType as AssistantActionType);
      setStatus("dismissed");
    } catch (cause) {
      dismissed.current = false;
      setError(cause instanceof Error ? cause.message : "We couldn't dismiss this proposal. Please check its status and try again.");
      if (intent) {
        setStatus("dismissing");
        try {
          const token = await getToken();
          if (!token) throw new Error("Session unavailable");
          const latest = await getAssistantActionStatus(token, conversationId, intent.id);
          setStatus(proposalStatusFromBackend(latest.status, latest.expires_at));
        } catch { setStatus("failed"); }
      } else setStatus("failed");
    } finally { inFlight.current = false; }
  }
  const details = <>
    {typeof summary.doctor === "string" ? <p className="font-medium text-foreground">{summary.doctor}{typeof summary.specialty === "string" ? ` · ${summary.specialty}` : ""}</p> : null}
    {dateTime ? <p className="mt-1 flex items-center gap-1.5 text-sm text-muted-foreground"><Clock3 aria-hidden="true" className="size-3.5" />{dateTime}{typeof summary.end_time === "string" ? `–${displayTime(summary.end_time)}` : ""} IST</p> : null}
    {typeof fee === "string" || typeof fee === "number" ? <p className="mt-1 text-sm text-muted-foreground">Consultation fee: {String(summary.currency || "INR")} {Number(fee).toLocaleString("en-IN")}</p> : null}
    {actionType === "cancel" && (typeof summary.estimated_refund_amount === "string" || typeof summary.estimated_additional_refund_amount === "string") ? <p className="mt-2 text-sm text-muted-foreground">Estimated additional refund: {String(summary.currency || "INR")} {String(summary.estimated_additional_refund_amount || summary.estimated_refund_amount)}. Final refund is recalculated when processed.</p> : null}
    {actionType === "reschedule" && typeof summary.previous_date === "string" ? <p className="mt-2 text-sm text-muted-foreground">Current appointment: {dateLabel(summary.previous_date)}{typeof summary.previous_start_time === "string" ? ` at ${displayTime(summary.previous_start_time)} IST` : ""}</p> : null}
  </>;
  return <section aria-label={proposalTitle(actionType, status)} className="mt-3 w-full max-w-[94%] rounded-xl border border-border bg-card p-4 text-card-foreground shadow-sm sm:max-w-[82%]">
    <div className="flex items-start justify-between gap-3"><div><p className="text-sm font-semibold">{proposalTitle(actionType, status)}</p><p className="mt-1 text-xs text-muted-foreground">{proposalDescription(actionType, status)}</p></div>{completedBooking ? null : <Button type="button" variant="ghost" size="icon-sm" aria-label="Dismiss proposal" onClick={() => void dismiss()} disabled={["loading", "confirming", "dismissing", "checkout_pending", "refund_pending", "completed"].includes(status)}><X aria-hidden="true" className="size-4" /></Button>}</div>
    {status === "loading" ? <p role="status" className="mt-3 flex items-center gap-2 text-sm text-muted-foreground"><LoaderCircle aria-hidden="true" className="size-4 animate-spin" />Verifying proposal details…</p> : null}
    {status !== "loading" && status !== "dismissed" ? <div className="mt-3">{details}</div> : null}
    {error ? <p role="alert" className="mt-3 text-sm text-destructive">{error}</p> : null}
    {status === "pending" ? <div className="mt-4 flex flex-wrap gap-2"><Button type="button" size="sm" disabled={!intent} onClick={() => void confirm()}>Confirm</Button><Button type="button" size="sm" variant="outline" onClick={() => void dismiss()}>Dismiss</Button></div> : null}
    {status === "dismissing" ? <p role="status" className="mt-3 flex items-center gap-2 text-sm text-muted-foreground"><LoaderCircle aria-hidden="true" className="size-4 animate-spin" />Saving dismissal…</p> : null}
    {status === "confirming" ? <p role="status" className="mt-3 flex items-center gap-2 text-sm text-muted-foreground"><LoaderCircle aria-hidden="true" className="size-4 animate-spin" />Confirming with Medrella…</p> : null}
    {status === "processing" ? <p role="status" className="mt-3 text-sm text-muted-foreground">Your confirmation is still processing. Refresh the conversation shortly to see its status.</p> : null}
    {status === "expired" ? <p className="mt-3 text-sm text-muted-foreground">This proposal expired. Ask the assistant to prepare it again.</p> : null}
    {status === "completed" && !completedBooking ? <p role="status" className="mt-3 flex items-center gap-2 text-sm font-medium text-foreground"><Check aria-hidden="true" className="size-4" />{actionType === "cancel" ? "Cancellation confirmed." : "Appointment rescheduled."}</p> : null}
    {status === "checkout_pending" ? <div role="status" className="mt-3"><p className="text-sm font-medium">Payment is required. Your appointment is not confirmed yet.</p>{checkoutUrl ? <Button asChild size="sm" className="mt-3"><a href={checkoutUrl}>Continue to secure checkout</a></Button> : <Button type="button" size="sm" className="mt-3" onClick={() => void confirm()}>Retrieve secure checkout</Button>}</div> : null}
    {status === "refund_pending" ? <p role="status" className="mt-3 text-sm">Cancellation confirmed. Your refund is being processed.</p> : null}
    {status === "dismissed" ? <p className="mt-3 text-xs text-muted-foreground">Proposal dismissed.</p> : null}
  </section>;
}

export function PatientAssistantChat({ compact = false, onClose, audience = "patient", speechLocale = "en-IN", speechVoiceName }: { compact?: boolean; onClose?: () => void; audience?: "patient" | "doctor"; speechLocale?: string; speechVoiceName?: string }) {
  const assistantPath = audience === "doctor" ? "/doctor/assistant" : "/patient/assistant";
  const doctorMode = audience === "doctor";
  const { getToken, isLoaded, userId } = useAuth();
  const currentClerkUserId = userId || null;
  const currentClerkUserIdRef = useRef(currentClerkUserId);
  currentClerkUserIdRef.current = currentClerkUserId;
  const loadedUserIdRef = useRef<string | null>(null);
  const authGeneration = useRef(0);
  const [state, dispatch] = useReducer(chatReducer, initialChatState);
  const [draft, setDraft] = useState("");
  const [ready, setReady] = useState(false);
  const [historyLoadFailed, setHistoryLoadFailed] = useState(false);
  const [recoveryConversations, setRecoveryConversations] = useState<AssistantConversation[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyRevision, setHistoryRevision] = useState(0);
  const [history, setHistory] = useState({ hasMore: false, nextBefore: null as string | null, loadingOlder: false, olderError: null as string | null, reachedStart: false });
  const [nearTop, setNearTop] = useState(false);
  const [nearLatest, setNearLatest] = useState(true);
  const voiceEnabledRef = useRef(false);
  const [voiceSettingsOpen, setVoiceSettingsOpen] = useState(false);
  const [privacyNoticeOpen, setPrivacyNoticeOpen] = useState(false);
  const voiceSubmitRef = useRef<(transcript: string) => void>(() => {});
  const voice = useVoiceAssistant((transcript) => voiceSubmitRef.current(transcript), speechLocale, speechVoiceName);
  useEffect(() => {
    voiceEnabledRef.current = voice.sessionActive;
  }, [voice.sessionActive]);
  const pauseVoiceForResponse = voice.pauseForResponse;
  const resumeVoiceAfterResponse = voice.resumeAfterResponse;
  const speakVoiceResponse = voice.speak;
  const stopVoiceSpeaking = voice.stopSpeaking;
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { setPrivacyNoticeOpen(false); setVoiceSettingsOpen(false); setHistoryOpen(false); }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => { document.removeEventListener("keydown", onKeyDown); };
  }, []);
  const conversationId = useRef<string | null>(null);
  const recoveryTargetId = useRef<string | null>(null);
  const requestInFlight = useRef(false);
  const olderLoadInFlight = useRef(false);
  const authReloadNeeded = useRef(false);
  const messageList = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);
  const prependAnchor = useRef<{ scrollHeight: number; scrollTop: number } | null>(null);
  const scrollAfterAssistantAction = useRef(false);

  useLayoutEffect(() => {
    const container = messageList.current;
    if (!container) return;
    if (prependAnchor.current) {
      const anchor = prependAnchor.current;
      container.scrollTop = preserveScrollAfterPrepend(container.scrollHeight, anchor.scrollHeight, anchor.scrollTop);
      prependAnchor.current = null;
      return;
    }
    if (shouldForceScrollAfterAssistantAction(scrollAfterAssistantAction.current, state.messages.at(-1)?.role, false)) {
      scrollAfterAssistantAction.current = false;
      container.scrollTop = container.scrollHeight;
      nearBottom.current = true;
      setNearLatest(true);
    } else if (nearBottom.current) {
      container.scrollTop = container.scrollHeight;
    }
  }, [state.messages]);

  const isCurrentSession = useCallback((ownerUserId: string, generation: number) => isLoaded
    && userId === ownerUserId
    && currentClerkUserIdRef.current === ownerUserId
    && loadedUserIdRef.current === ownerUserId
    && authGeneration.current === generation, [isLoaded, userId]);

  const loadConversation = useCallback(async (ownerUserId = userId, generation = authGeneration.current) => {
    if (!ownerUserId || !isCurrentSession(ownerUserId, generation)) return;
    dispatch({ type: "loading", value: true });
    try {
      const token = await getToken();
      if (!isCurrentSession(ownerUserId, generation)) return;
      if (!token) throw new AssistantApiError(401, "Your secure sign-in session is not ready. Please sign in again.");
      const requested = new URLSearchParams(window.location.search).get("conversation");
      const savedConversations = await listAssistantConversations(token);
      if (!isCurrentSession(ownerUserId, generation)) return;
      const remembered = readActiveConversation(audience, ownerUserId);
      const id = resolveAssistantConversationId(requested, remembered, savedConversations.items);
      if (id) {
        conversationId.current = id;
        let stored: Awaited<ReturnType<typeof getAssistantConversation>>;
        try {
          stored = await getAssistantConversation(token, id, { limit: 20 });
        } catch (error) {
          if (!(error instanceof AssistantApiError) || error.code !== "CONVERSATION_NOT_FOUND" || !remembered || remembered === id) throw error;
          stored = await getAssistantConversation(token, remembered, { limit: 20 });
        }
        if (!isCurrentSession(ownerUserId, generation)) return;
        conversationId.current = stored.conversation.id;
        rememberActiveConversation(audience, ownerUserId, stored.conversation.id);
        if (!compact && requested !== stored.conversation.id) window.history.replaceState(null, "", `${assistantPath}?conversation=${encodeURIComponent(stored.conversation.id)}`);
        dispatch({ type: "restore", messages: stored.messages.map((message) => ({ id: message.id, requestId: message.request_id, role: message.role, content: message.content, createdAt: message.created_at, results: message.results, failed: message.request_status === "failed" })) });
        setHistory({ hasMore: stored.has_more, nextBefore: stored.next_before, loadingOlder: false, olderError: null, reachedStart: false });
      }
      if (!isCurrentSession(ownerUserId, generation)) return;
      setHistoryLoadFailed(false);
    } catch (error) {
      if (!isCurrentSession(ownerUserId, generation)) return;
      conversationId.current = null;
      setHistoryLoadFailed(true);
      dispatch({ type: "failure", requestId: "load", message: error instanceof Error ? error.message : "We couldn't load this conversation.", code: error instanceof AssistantApiError ? error.code || "HISTORY_LOAD_FAILED" : "HISTORY_LOAD_FAILED", source: "history" });
    }
    finally {
      if (isCurrentSession(ownerUserId, generation)) {
        setReady(true);
        dispatch({ type: "loading", value: false });
      }
    }
  }, [assistantPath, audience, compact, getToken, isCurrentSession, userId]);

  useLayoutEffect(() => {
    if (!isLoaded) {
      if (!authReloadNeeded.current) {
        authReloadNeeded.current = true;
        const previousUserId = loadedUserIdRef.current;
        loadedUserIdRef.current = null;
        authGeneration.current += 1;
        conversationId.current = null;
        recoveryTargetId.current = null;
        requestInFlight.current = false;
        olderLoadInFlight.current = false;
        voice.stop();
        voiceEnabledRef.current = false;
        dispatch({ type: "clear" });
        setDraft("");
        setHistoryLoadFailed(false);
        setRecoveryConversations([]);
        setHistory({ hasMore: false, nextBefore: null, loadingOlder: false, olderError: null, reachedStart: false });
        if (previousUserId) {
          const url = new URL(window.location.href);
          if (url.searchParams.has("conversation")) {
            url.searchParams.delete("conversation");
            window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
          }
        }
      }
      setReady(false);
      return;
    }
    const nextUserId = userId || null;
    if (loadedUserIdRef.current === nextUserId && !authReloadNeeded.current) return;
    authReloadNeeded.current = false;
    const previousUserId = loadedUserIdRef.current;
    loadedUserIdRef.current = nextUserId;
    const generation = ++authGeneration.current;
    conversationId.current = null;
    recoveryTargetId.current = null;
    requestInFlight.current = false;
    olderLoadInFlight.current = false;
    prependAnchor.current = null;
    voice.stop();
    voiceEnabledRef.current = false;
    dispatch({ type: "clear" });
    setDraft("");
    setHistoryLoadFailed(false);
    setRecoveryConversations([]);
    setHistoryOpen(false);
    setHistoryRevision(0);
    setHistory({ hasMore: false, nextBefore: null, loadingOlder: false, olderError: null, reachedStart: false });
    setReady(false);
    if (previousUserId && nextUserId !== previousUserId) {
      const url = new URL(window.location.href);
      if (url.searchParams.has("conversation")) {
        url.searchParams.delete("conversation");
        window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
      }
    }
    if (nextUserId) void loadConversation(nextUserId, generation);
  }, [isLoaded, loadConversation, userId, voice.stop]);

  const loadOlderMessages = useCallback(async () => {
    const ownerUserId = userId;
    const generation = authGeneration.current;
    const activeConversationId = conversationId.current;
    if (!ownerUserId || !isCurrentSession(ownerUserId, generation) || !history.hasMore || !history.nextBefore || history.loadingOlder || olderLoadInFlight.current || !activeConversationId) return;
    olderLoadInFlight.current = true;
    setHistory((current) => ({ ...current, loadingOlder: true, olderError: null }));
    try {
      const token = await getToken();
      if (!isCurrentSession(ownerUserId, generation)) return;
      if (!token) throw new AssistantApiError(401, "Your secure sign-in session is not ready. Please sign in again.");
      const container = messageList.current;
      const page = await getAssistantConversation(token, activeConversationId, { limit: 20, before: history.nextBefore });
      if (!isCurrentSession(ownerUserId, generation)) return;
      if (container) prependAnchor.current = { scrollHeight: container.scrollHeight, scrollTop: container.scrollTop };
      dispatch({ type: "prepend", messages: page.messages.map((message) => ({ id: message.id, requestId: message.request_id, role: message.role, content: message.content, createdAt: message.created_at, results: message.results, failed: message.request_status === "failed" })) });
      setHistory({ hasMore: page.has_more, nextBefore: page.next_before, loadingOlder: false, olderError: null, reachedStart: !page.has_more });
    } catch (error) {
      if (isCurrentSession(ownerUserId, generation)) {
        prependAnchor.current = null;
        setHistory((current) => ({ ...current, loadingOlder: false, olderError: error instanceof Error ? error.message : "Older messages couldn't be loaded. Please try again." }));
      }
    } finally {
      if (isCurrentSession(ownerUserId, generation)) olderLoadInFlight.current = false;
    }
  }, [getToken, history.hasMore, history.loadingOlder, history.nextBefore, isCurrentSession, userId]);

  const deliver = useCallback(async (requestId: string, content: string) => {
    const ownerUserId = userId;
    const generation = authGeneration.current;
    if (requestInFlight.current) return;
    if (!ownerUserId || !isCurrentSession(ownerUserId, generation)) return;
    requestInFlight.current = true;
    const voiceSessionForReply = voiceEnabledRef.current;
    if (voiceSessionForReply) pauseVoiceForResponse();
    dispatch({ type: "loading", value: true });
    try {
      const token = await getToken();
      if (!isCurrentSession(ownerUserId, generation)) return;
      if (!token) throw new AssistantApiError(401, "Your secure sign-in session is not ready. Please sign in again.");
      if (!conversationId.current) {
        const id = crypto.randomUUID(); await createAssistantConversation(token, id);
        if (!isCurrentSession(ownerUserId, generation)) return;
        conversationId.current = id;
        rememberActiveConversation(audience, ownerUserId, id);
        if (!compact) window.history.replaceState(null, "", `${assistantPath}?conversation=${id}`);
      }
      if (!isCurrentSession(ownerUserId, generation) || !conversationId.current) return;
      const reply = await sendAssistantMessage(token, conversationId.current, requestId, content);
      if (!isCurrentSession(ownerUserId, generation)) return;
      setHistoryLoadFailed(false);
      dispatch({ type: "success", requestId, user: { id: reply.user_message.id, requestId, role: "user", content, createdAt: reply.user_message.created_at || new Date().toISOString() }, assistant: { id: reply.assistant_message.id, role: "assistant", content: reply.assistant_message.content, createdAt: reply.assistant_message.created_at || new Date().toISOString(), results: reply.assistant_message.results || [] } });
      setHistoryRevision((revision) => revision + 1);
      if (voiceSessionForReply && voiceEnabledRef.current) {
        const visibleResults = getVisibleAssistantResults(reply.assistant_message.content, reply.assistant_message.results || []);
        const visibleText = assistantContentForResults(reply.assistant_message.content, reply.assistant_message.results || []);
        speakVoiceResponse(assistantResponseSpeechText(visibleText, visibleResults));
      }
    } catch (error) { if (isCurrentSession(ownerUserId, generation)) { scrollAfterAssistantAction.current = false; setDraft((current) => restoreDraftAfterFailedSubmission(current, content)); dispatch({ type: "failure", requestId, message: error instanceof Error ? error.message : "We couldn't get a reply. Please try again.", code: error instanceof AssistantApiError ? error.code : undefined, source: "send" }); if (voiceSessionForReply && voiceEnabledRef.current) resumeVoiceAfterResponse(); } }
    finally { if (isCurrentSession(ownerUserId, generation)) requestInFlight.current = false; }
  }, [assistantPath, audience, compact, getToken, isCurrentSession, pauseVoiceForResponse, resumeVoiceAfterResponse, speakVoiceResponse, userId]);

  const startNewConversation = useCallback(async () => {
    const ownerUserId = userId;
    const generation = authGeneration.current;
    if (!ownerUserId || !isCurrentSession(ownerUserId, generation) || requestInFlight.current) return;
    requestInFlight.current = true;
    dispatch({ type: "loading", value: true });
    try {
      const token = await getToken();
      if (!isCurrentSession(ownerUserId, generation)) return;
      if (!token) throw new AssistantApiError(401, "Your secure sign-in session is not ready. Please sign in again.");
      const id = crypto.randomUUID();
      await createAssistantConversation(token, id);
      if (!isCurrentSession(ownerUserId, generation)) return;
      conversationId.current = id;
      rememberActiveConversation(audience, ownerUserId, id);
      recoveryTargetId.current = null;
      setHistoryLoadFailed(false);
      setHistory({ hasMore: false, nextBefore: null, loadingOlder: false, olderError: null, reachedStart: false });
      setRecoveryConversations([]);
      dispatch({ type: "clear" });
      setHistoryRevision((revision) => revision + 1);
      setHistoryOpen(false);
      if (!compact) window.history.replaceState(null, "", `${assistantPath}?conversation=${id}`);
    } catch (error) {
      if (isCurrentSession(ownerUserId, generation)) dispatch({ type: "failure", requestId: "start-new", message: error instanceof Error ? error.message : "A new conversation couldn't be started.", code: error instanceof AssistantApiError ? error.code : undefined, source: "new_conversation" });
    } finally {
      if (isCurrentSession(ownerUserId, generation)) {
        requestInFlight.current = false;
        dispatch({ type: "loading", value: false });
      }
    }
  }, [assistantPath, audience, compact, getToken, isCurrentSession, userId]);

  const findSavedConversations = useCallback(async () => {
    const ownerUserId = userId;
    const generation = authGeneration.current;
    if (!ownerUserId || !isCurrentSession(ownerUserId, generation) || requestInFlight.current) return;
    requestInFlight.current = true;
    dispatch({ type: "loading", value: true });
    try {
      const token = await getToken();
      if (!isCurrentSession(ownerUserId, generation)) return;
      if (!token) throw new AssistantApiError(401, "Your secure sign-in session is not ready. Please sign in again.");
      const saved = await listAssistantConversations(token);
      if (!isCurrentSession(ownerUserId, generation)) return;
      setRecoveryConversations(saved.items);
      if (!saved.items.length) dispatch({ type: "failure", requestId: "recover", message: "No saved conversations were returned for this account. You can retry loading or explicitly start a new conversation.", source: "saved_conversations" });
    } catch (error) {
      if (isCurrentSession(ownerUserId, generation)) dispatch({ type: "failure", requestId: "recover", message: error instanceof Error ? error.message : "Saved conversations couldn't be loaded.", code: error instanceof AssistantApiError ? error.code : undefined, source: "saved_conversations" });
    } finally {
      if (isCurrentSession(ownerUserId, generation)) {
        requestInFlight.current = false;
        dispatch({ type: "loading", value: false });
      }
    }
  }, [getToken, isCurrentSession, userId]);

  const openSavedConversation = useCallback(async (id: string) => {
    const ownerUserId = userId;
    const generation = authGeneration.current;
    if (!ownerUserId || !isCurrentSession(ownerUserId, generation) || requestInFlight.current) return;
    recoveryTargetId.current = id;
    requestInFlight.current = true;
    dispatch({ type: "loading", value: true });
    try {
      const token = await getToken();
      if (!isCurrentSession(ownerUserId, generation)) return;
      if (!token) throw new AssistantApiError(401, "Your secure sign-in session is not ready. Please sign in again.");
      const stored = await getAssistantConversation(token, id, { limit: 20 });
      if (!isCurrentSession(ownerUserId, generation)) return;
      conversationId.current = stored.conversation.id;
      rememberActiveConversation(audience, ownerUserId, stored.conversation.id);
      recoveryTargetId.current = null;
      dispatch({ type: "restore", messages: stored.messages.map((message) => ({ id: message.id, requestId: message.request_id, role: message.role, content: message.content, createdAt: message.created_at, results: message.results, failed: message.request_status === "failed" })) });
      setHistory({ hasMore: stored.has_more, nextBefore: stored.next_before, loadingOlder: false, olderError: null, reachedStart: false });
      setHistoryLoadFailed(false);
      setRecoveryConversations([]);
      setHistoryRevision((revision) => revision + 1);
      setHistoryOpen(!compact);
      if (!compact) window.history.replaceState(null, "", `${assistantPath}?conversation=${stored.conversation.id}`);
    } catch (error) {
      if (isCurrentSession(ownerUserId, generation)) dispatch({ type: "failure", requestId: "recover", message: error instanceof Error ? error.message : "The saved conversation couldn't be opened.", code: error instanceof AssistantApiError ? error.code || "HISTORY_LOAD_FAILED" : "HISTORY_LOAD_FAILED", source: "history" });
    } finally {
      if (isCurrentSession(ownerUserId, generation)) {
        requestInFlight.current = false;
        dispatch({ type: "loading", value: false });
      }
    }
  }, [assistantPath, audience, compact, getToken, isCurrentSession, userId]);

  useEffect(() => {
    if (!isLoaded || !userId) return;
    const key = assistantActiveConversationStorageKey(audience, userId);
    const onStorage = (event: StorageEvent) => {
      if (event.key === key && event.newValue && event.newValue !== conversationId.current && isCurrentSession(userId, authGeneration.current)) {
        void openSavedConversation(event.newValue);
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [audience, isCurrentSession, isLoaded, openSavedConversation, userId]);

  const assistantReady = ready && isLoaded && Boolean(userId) && loadedUserIdRef.current === userId;

  function submitContent(value: string) {
    const content = value.trim(); if (!canSendAssistantMessage({ ready: assistantReady, loading: state.loading || requestInFlight.current, draft: content, historyLoadFailed, hasConversation: Boolean(conversationId.current) })) return;
    const failed = [...state.messages].reverse().find((item) => item.role === "user" && item.failed && item.content === content && item.requestId);
    if (failed?.requestId) { setDraft(""); void deliver(failed.requestId, content); return; }
    const requestId = crypto.randomUUID(); dispatch({ type: "submit", message: { requestId, role: "user", content } }); setDraft((current) => current.trim() === content ? "" : current); void deliver(requestId, content);
  }
  voiceSubmitRef.current = (transcript) => { if (!requestInFlight.current && !state.loading) submitContent(transcript); };
  function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); submitContent(draft); }
  const toggleVoice = () => {
    if (!voice.sessionActive) { voiceEnabledRef.current = true; voice.start(); return; }
    if (voice.status === "listening") { voice.stop(); voiceEnabledRef.current = false; return; }
    if (voice.status !== "speaking") voice.resumeAfterResponse();
  };
  const selectSlot = (index: number, action: "book" | "reschedule") => {
    const content = action === "reschedule" ? `Reschedule my appointment to slot ${index + 1}` : `Book slot ${index + 1}`;
    if (state.loading || requestInFlight.current) return;
    scrollAfterAssistantAction.current = true;
    const requestId = crypto.randomUUID();
    dispatch({ type: "submit", message: { requestId, role: "user", content } });
    void deliver(requestId, content);
  };
  const selectAppointment = (index: number, action: "cancel" | "reschedule") => {
    const ordinal = ["first", "second", "third", "fourth", "fifth"][index];
    if (state.loading || requestInFlight.current) return;
    const content = ordinal
      ? action === "cancel" ? `Cancel the ${ordinal} appointment` : `Reschedule my ${ordinal} appointment`
      : action === "cancel" ? `Cancel appointment number ${index + 1}` : `Reschedule appointment number ${index + 1}`;
    scrollAfterAssistantAction.current = true;
    const requestId = crypto.randomUUID();
    dispatch({ type: "submit", message: { requestId, role: "user", content } });
    void deliver(requestId, content);
  };
  const retry = () => {
    const operation = retryOperation(state.errorSource);
    if (operation === "history" && recoveryTargetId.current) { void openSavedConversation(recoveryTargetId.current); return; }
    if (operation === "history") { void loadConversation(); return; }
    if (operation === "saved_conversations") { void findSavedConversations(); return; }
    if (operation === "new_conversation") { void startNewConversation(); return; }
    const failed = [...state.messages].reverse().find((item) => item.failed && item.requestId);
    if (failed) { setDraft((current) => current === failed.content ? "" : current); void deliver(failed.requestId!, failed.content); } else void loadConversation();
  };
  const historyPanel = <AssistantConversationHistory audience={audience} activeConversationId={conversationId.current} refreshKey={historyRevision} compact={compact} onClose={() => setHistoryOpen(false)} onSelectConversation={(id) => void openSavedConversation(id)} />;
  const content = <>
    <header className={compact ? "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 gap-y-2 px-3 py-3 sm:px-4" : "relative flex items-center gap-2 sm:gap-3 mb-5 shrink-0"}>
      <div className={`flex min-w-0 items-center gap-2 sm:gap-3 ${compact ? "" : "flex-1"}`}>
        <span className="flex size-10 shrink-0 items-center justify-center rounded-2xl bg-secondary text-secondary-foreground"><MessageCircle aria-hidden="true" className="size-5" /></span>
        <div className="min-w-0 flex-1"><p className="text-sm font-medium text-primary">Medrella Assistant</p><h1 className="truncate text-xl font-semibold tracking-tight text-foreground">{doctorMode ? "Doctor AI Assistant" : "How can I help?"}</h1></div>
      </div>
      {compact ? <div role="group" aria-label="Assistant window controls" className="flex shrink-0 items-center gap-1 rounded-lg border border-border bg-muted/40 p-1">
        <Button asChild variant="ghost" size="icon-sm" aria-label="Expand to full assistant" title="Expand to full assistant"><Link href={`${assistantPath}${conversationId.current ? `?conversation=${encodeURIComponent(conversationId.current)}` : ""}`} onClick={() => { voice.stop(); voiceEnabledRef.current = false; onClose?.(); }}><Maximize2 aria-hidden="true" /></Link></Button>
        <Button type="button" variant="ghost" size="icon-sm" onClick={() => { voice.stop(); voiceEnabledRef.current = false; onClose?.(); }} aria-label="Close assistant" title="Close assistant"><X aria-hidden="true" /></Button>
      </div> : null}
      <div className={compact ? "col-span-2 flex min-w-0 flex-wrap items-center justify-end gap-1 border-t border-border/70 pt-2" : "ml-auto flex items-center gap-1"}>
        <Button type="button" variant="outline" size="sm" className="shrink-0 gap-2" disabled={state.loading || requestInFlight.current} onClick={() => void startNewConversation()}><MessageSquarePlus aria-hidden="true" className="size-4" />New Chat</Button>
        <Button type="button" variant="ghost" size="icon" aria-label="Chat history" title="Chat history" aria-expanded={historyOpen} onClick={() => { setHistoryOpen((open) => !open); setVoiceSettingsOpen(false); setPrivacyNoticeOpen(false); }}><History aria-hidden="true" /></Button>
        <Popover open={voiceSettingsOpen} onOpenChange={(open) => { setVoiceSettingsOpen(open); if (open) setHistoryOpen(false); }}>
          <PopoverTrigger asChild><Button type="button" variant="ghost" size="icon" aria-label="Voice settings" title="Voice settings" aria-expanded={voiceSettingsOpen}><Settings2 aria-hidden="true" /></Button></PopoverTrigger>
          <PopoverContent align="end" side="bottom" sideOffset={privacyNoticeOpen ? 168 : 8} className="max-h-[min(70dvh,32rem)] w-[min(18rem,calc(100vw-1.5rem))] overflow-y-auto p-3">
            <label htmlFor={`${compact ? "assistant-panel" : "assistant"}-voice-select`} className="text-xs font-medium">English speaking voice</label>
            <Select value={voice.selectedVoiceName || "default"} onValueChange={(value) => voice.selectVoice(value === "default" ? "" : value)}>
              <SelectTrigger id={`${compact ? "assistant-panel" : "assistant"}-voice-select`} size="sm" className="mt-1"><SelectValue /></SelectTrigger>
              <SelectContent className="max-h-[min(18rem,50dvh)] w-[var(--radix-select-trigger-width)] max-w-[calc(100vw-2rem)]">
                <SelectItem value="default">Default browser voice</SelectItem>
                {voice.availableVoices.map((availableVoice) => <SelectItem key={`${availableVoice.name}-${availableVoice.lang}`} value={availableVoice.name}>{availableVoice.name} ({availableVoice.lang})</SelectItem>)}
              </SelectContent>
            </Select>
            <Button type="button" variant="outline" size="sm" className="mt-2 w-full gap-2" disabled={voice.synthesisSupported === false} onClick={voice.preview}><Play aria-hidden="true" className="size-3.5" />Preview voice</Button><p className="mt-2 text-xs text-muted-foreground">Your voice choice is saved on this device. If no voices are listed, the browser default is used.</p>
          </PopoverContent>
        </Popover>
        <Popover open={privacyNoticeOpen} onOpenChange={(open) => { setPrivacyNoticeOpen(open); if (open) setHistoryOpen(false); }}>
          <PopoverTrigger asChild><Button type="button" variant="ghost" size="icon" aria-label="Voice privacy information" title="Voice privacy information" aria-expanded={privacyNoticeOpen}><Info aria-hidden="true" /></Button></PopoverTrigger>
          <PopoverContent align="end" side="bottom" sideOffset={voiceSettingsOpen ? 168 : 8} className="max-h-[min(70dvh,32rem)] w-[min(20rem,calc(100vw-1.5rem))] overflow-y-auto p-3">
            <p className="text-xs leading-5">Your browser's speech recognition converts microphone speech into text. Medrella receives the transcript when it is submitted as a chat message, and saves it with the conversation.</p>
          </PopoverContent>
        </Popover>
      </div>
    </header>
    <section aria-label="Assistant conversation" aria-live="polite" className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
      <div className="relative min-h-0 flex-1">
      <div ref={messageList} onScroll={(event) => { const element = event.currentTarget; const top = isNearMessageListTop(element.scrollTop); const bottom = isNearMessageListBottom(element.scrollHeight, element.clientHeight, element.scrollTop); nearBottom.current = bottom; setNearTop(top); setNearLatest(bottom); }} className={`absolute inset-0 space-y-4 overscroll-contain p-4 sm:p-5 ${state.messages.length ? "overflow-y-auto" : "flex flex-col justify-center overflow-hidden"}`}>
        {history.hasMore && nearTop ? <div className="flex flex-col gap-1 border-b border-border pb-2"><Button type="button" variant="ghost" size="sm" className="h-8 gap-2 px-2 text-muted-foreground hover:text-foreground" disabled={history.loadingOlder} onClick={() => void loadOlderMessages()}><ArrowUp aria-hidden="true" className="size-4" />{history.loadingOlder ? "Loading older messages…" : "Load older messages"}</Button>{history.olderError ? <p role="alert" className="px-2 text-xs text-destructive">{history.olderError}</p> : null}</div> : null}
        {state.messages.length === 0 ? <div className="mx-auto flex w-full max-w-lg flex-col items-center justify-center text-center">
          <span className="flex size-12 items-center justify-center rounded-full bg-secondary text-secondary-foreground"><Sparkles aria-hidden="true" className="size-5" /></span>
          <h2 className="mt-4 text-lg font-semibold text-card-foreground">{doctorMode ? "Your schedule, easier to manage" : "Your care, easier to navigate"}</h2>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">{doctorMode ? "Ask about your schedules, exceptions, conflicts, or nearest available slots." : "Ask about your upcoming or previous appointments, find a doctor, or check available appointment times."}</p>
          <p className="mt-4 flex items-center gap-2 text-xs text-muted-foreground"><Search aria-hidden="true" className="size-3.5" /> {doctorMode ? "For example: ‘What open times do I have this week?’" : "For example: ‘Find a cardiologist’"}</p>
        </div> : state.messages.map((message, index) => <article key={message.id || message.requestId || `${message.role}-${index}`} className={`flex flex-col ${message.role === "user" ? "items-end" : "items-start"}`}>
          {shouldShowAssistantDateSeparator(state.messages, index) && message.createdAt ? <div className="my-1 flex w-full items-center gap-3 text-xs text-muted-foreground" role="separator"><span className="h-px flex-1 bg-border" /><span>{assistantMessageDateLabel(message.createdAt)}</span><span className="h-px flex-1 bg-border" /></div> : null}
          <div className={`flex max-w-[94%] items-end gap-2 sm:max-w-[82%] ${message.role === "user" ? "flex-row-reverse" : ""}`}>
          {message.role === "assistant" ? <span aria-label="AI assistant" className="mb-1 flex size-8 shrink-0 items-center justify-center rounded-full border border-border bg-secondary text-secondary-foreground"><Bot aria-hidden="true" className="size-4" /></span> : <span aria-label={doctorMode ? "Doctor" : "Patient"} className="mb-1 flex size-8 shrink-0 items-center justify-center rounded-full border border-border bg-secondary text-secondary-foreground"><UserRound aria-hidden="true" className="size-4" /></span>}
          <div className={`min-w-0 rounded-2xl p-3 ${message.role === "user" ? "rounded-br-md bg-primary text-primary-foreground" : "rounded-bl-md border border-border/80 bg-muted/40 text-foreground shadow-sm"}`}>
            {message.role === "assistant" ? <><p className="mb-1 text-xs font-semibold opacity-75">Medrella Assistant</p><div className="text-sm leading-6"><AssistantMarkdown content={assistantContentForResults(message.content, message.results || [])} /></div></> : <p className="whitespace-pre-wrap text-sm leading-6">{message.content}</p>}
          {message.role === "assistant" ? <>{getVisibleAssistantResults(message.content, message.results).map((result, index) => {
            const cancellationSelection = /choose the appointment you want to cancel/i.test(message.content);
            const rescheduleSelection = /choose which appointment you want to reschedule/i.test(message.content);
            const pendingAction = cancellationSelection ? "cancel" : rescheduleSelection ? "reschedule" : null;
            const slotAction = /reschedul/i.test(message.content) ? "reschedule" : "book";
            return <section key={`${result.tool}-${index}`} className="mt-3 rounded-xl border border-border/80 bg-card/80 p-3 text-card-foreground shadow-sm"><h3 className="flex items-center gap-2 text-xs font-semibold"><ResultIcon result={result} />{result.tool === "search_doctors" ? "Doctors" : result.tool === "get_available_slots" || result.tool === "get_doctor_nearest_slots" ? "Available times" : result.tool === "get_doctor_schedules" ? "Schedules" : result.tool === "get_doctor_schedule_exceptions" ? "Schedule exceptions" : result.tool === "get_doctor_schedule_conflicts" ? "Scheduling conflicts" : result.tool === "get_doctor_assisted_reschedule_requests" ? "Assisted rescheduling requests" : result.tool === "get_patient_payment_history" ? "Payment history" : "Appointments"}</h3><ResultCards result={result} doctorMode={doctorMode} compact={compact} onSelectSlot={!doctorMode && result.tool === "get_available_slots" ? (rowIndex) => selectSlot(rowIndex, slotAction) : undefined} onSelectAppointment={!doctorMode && pendingAction && result.tool === "get_patient_appointments" ? (rowIndex) => selectAppointment(rowIndex, pendingAction) : undefined} /></section>;
          })}<AssistantResultsCta results={getVisibleAssistantResults(message.content, message.results)} doctorMode={doctorMode} /></> : null}
          </div>
          </div>
          <time className={`mt-1 px-10 text-xs text-muted-foreground ${message.role === "user" ? "text-right" : "text-left"}`} dateTime={message.createdAt}>{assistantMessageTimeLabel(message.createdAt)}</time>
          {message.failed && message.requestId ? <div className="mt-1 flex w-full justify-end pr-10">
            <span className="group relative inline-flex">
              <Button type="button" variant="ghost" size="icon-sm" className="text-destructive hover:bg-destructive/10 hover:text-destructive focus-visible:ring-destructive" aria-label="Retry this message" aria-describedby={`retry-tooltip-${message.requestId}`} disabled={state.loading} onClick={() => void deliver(message.requestId!, message.content)}>
                <RefreshCw aria-hidden="true" className="size-3.5" />
              </Button>
              <span id={`retry-tooltip-${message.requestId}`} role="tooltip" className="pointer-events-none absolute bottom-full right-0 z-10 mb-1 whitespace-nowrap rounded-md bg-popover px-2 py-1 text-xs text-popover-foreground opacity-0 shadow-md transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">Retry this message</span>
            </span>
          </div> : null}
          {!doctorMode && message.role === "assistant" && message.id && conversationId.current ? message.results?.map((result, resultIndex) => proposalTypeForResult(result) ? <AssistantActionProposal key={`${message.id}-${result.tool}-${resultIndex}`} result={result} assistantMessageId={message.id!} conversationId={conversationId.current!} getToken={getToken} /> : null) : null}
        </article>)}
        {state.loading && state.messages.length ? <div className="flex items-center gap-2 text-sm text-muted-foreground" role="status"><LoaderCircle aria-hidden="true" className="size-4 animate-spin" />Checking that for you…</div> : null}
      </div>
      {!nearLatest && state.messages.length ? <Button type="button" variant="outline" size="icon" className="absolute bottom-4 right-4 z-20 rounded-full border border-border bg-background text-foreground shadow-lg hover:bg-muted" aria-label="Scroll to latest messages" onClick={() => { const element = messageList.current; if (element) element.scrollTo({ top: element.scrollHeight, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" }); }}><ArrowDown aria-hidden="true" className="size-4" /></Button> : null}
      </div>
      {state.error ? <div role="alert" className="mx-3 mb-2 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-foreground"><span className="min-w-0 flex-1">{state.error}</span><div className="flex shrink-0 gap-2"><Button type="button" variant="default" size="sm" disabled={state.loading} onClick={retry}>Retry</Button>{shouldShowHistoryRecovery(state.errorCode) ? <><Button type="button" variant="outline" size="sm" disabled={state.loading} onClick={() => void findSavedConversations()}>Find saved conversations</Button><Button type="button" variant="outline" size="sm" disabled={state.loading} onClick={() => void startNewConversation()}>Start new conversation</Button></> : null}</div></div> : null}
      {recoveryConversations.length ? <ul aria-label="Saved conversations" className="mx-3 mb-2 flex max-h-40 flex-col gap-1 overflow-y-auto rounded-lg border border-border bg-background p-2">{recoveryConversations.map((conversation) => <li key={conversation.id}><Button type="button" variant="ghost" size="sm" className="h-auto w-full justify-start whitespace-normal text-left" disabled={state.loading} onClick={() => void openSavedConversation(conversation.id)}>{conversation.preview || "Conversation without messages"}</Button></li>)}</ul> : null}
      {state.loading && !state.messages.length ? <div className="flex items-center gap-2 px-4 pb-2 text-xs text-muted-foreground" role="status"><LoaderCircle aria-hidden="true" className="size-4 animate-spin" />Loading your conversation…</div> : null}
      <form onSubmit={submit} className="sticky bottom-0 z-10 shrink-0 border-t border-border bg-card p-3">
        <label htmlFor={compact ? "assistant-panel-message" : "assistant-message"} className="sr-only">Message Medrella Assistant</label>
        <div className="mb-1 flex min-h-7 flex-wrap items-center justify-between gap-x-2 gap-y-1">
          {voice.status !== "stopped" ? <span className="text-xs text-muted-foreground" role="status" aria-live="polite">{voice.status === "listening" ? <><span aria-hidden="true" className="mr-1.5 inline-block size-2 animate-pulse rounded-full bg-primary" />{voice.statusMessage || "Listening"}{voice.synthesisSupported === false ? " · Spoken replies unavailable; text remains visible" : ""}</> : voice.status === "processing" ? "Waiting for the assistant…" : voice.status === "speaking" ? "Speaking response" : voice.statusMessage || (voice.status === "unsupported" ? "Speech recognition is unavailable; text chat is available." : "Voice is unavailable; continue by typing.")}</span> : null}
          <span className="ml-auto" />
        </div>
        <div className="mx-auto grid w-full grid-cols-[minmax(0,1fr)_auto_auto] items-end gap-2 rounded-2xl border border-input bg-background p-2 focus-within:ring-2 focus-within:ring-ring">
          <textarea id={compact ? "assistant-panel-message" : "assistant-message"} value={draft} onChange={(event) => setDraft(event.target.value.slice(0, 1000))} maxLength={1000} rows={1} placeholder={doctorMode ? "Ask about your schedule, exceptions, or availability…" : "Ask about appointments, doctors, or available times…"} className="max-h-28 min-h-10 min-w-0 resize-y bg-transparent px-2 py-2 text-sm text-foreground outline-none placeholder:text-muted-foreground" onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} />
          <span className="flex shrink-0 items-center gap-1">
            {voice.status === "speaking" ? <Button type="button" variant="ghost" size="icon" aria-label="Stop speaking" title="Stop speaking" onClick={stopVoiceSpeaking}><VolumeX aria-hidden="true" /></Button> : null}
            <Button type="button" variant={voice.status === "listening" ? "default" : "ghost"} size="icon" className={voice.status === "listening" ? "shrink-0 text-primary-foreground" : "shrink-0"} aria-label={!voice.sessionActive ? "Start voice input" : voice.status === "listening" ? "Stop listening" : voice.status === "speaking" ? "Voice input paused while Medrella is speaking" : "Resume voice input"} title={!voice.sessionActive ? "Start voice input" : voice.status === "listening" ? "Stop listening" : voice.status === "speaking" ? "Voice input pauses while Medrella is speaking" : "Resume voice input"} aria-pressed={voice.status === "listening"} disabled={voice.status === "speaking"} onClick={toggleVoice}>{voice.status === "listening" ? <MicOff aria-hidden="true" className="size-4" /> : <Mic aria-hidden="true" className="size-4" />}</Button>
          </span>
          <Button type="submit" size="icon" className="shrink-0" aria-label="Send message" disabled={!canSendAssistantMessage({ ready: assistantReady, loading: state.loading, draft, historyLoadFailed, hasConversation: Boolean(conversationId.current) })}><Send aria-hidden="true" /></Button>
        </div>
      </form>
    </section>
  </>;
  return compact ? <div className="relative flex h-full min-h-0 flex-col">{content}{historyOpen ? <div className="absolute inset-0 z-40 flex bg-background/70 p-3 pt-16 backdrop-blur-[2px]" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setHistoryOpen(false); }}><div className="flex min-h-0 w-full flex-col items-end">{historyPanel}</div></div> : null}</div> : <div className="relative mb-4 flex min-h-0 min-w-0 flex-1">
    <div className={`grid min-h-0 min-w-0 flex-1 gap-4 ${historyOpen ? "lg:grid-cols-[minmax(0,1fr)_17rem] xl:grid-cols-[minmax(0,1fr)_19rem]" : "lg:grid-cols-1"}`}>
      <div className="flex min-h-0 min-w-0 flex-col">{content}</div>
      {historyOpen ? <aside className="fixed inset-0 z-40 flex bg-background/70 p-3 pt-20 backdrop-blur-[2px] lg:static lg:inset-auto lg:z-auto lg:min-h-0 lg:bg-transparent lg:p-0 lg:pt-0 lg:backdrop-blur-none" aria-label="Conversation history" onMouseDown={(event) => { if (event.target === event.currentTarget) setHistoryOpen(false); }}><div className="flex min-h-0 w-full flex-col">{historyPanel}</div></aside> : null}
    </div>
  </div>;
}
