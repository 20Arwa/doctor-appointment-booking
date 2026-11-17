const { isCancellationRequest, recognizeCanonicalIntent } = require("./intentModel");
const { getTool } = require("./toolRegistry");
const { dateReferenceMatches, dateReferences, pairedTimeCandidates, resolveDateReference, selectedAppointmentTimes, timeRangeTarget, timeReferences } = require("./temporalInterpretation");

class AssistantError extends Error {
  constructor(code, status, message, metadata = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.category = metadata.category;
    this.providerStatus = metadata.providerStatus;
    this.attempt = metadata.attempt;
  }
}

function withDeadline(promise, signal) {
  if (signal.aborted) return Promise.reject(Object.assign(new Error("Assistant deadline reached"), { name: "TimeoutError" }));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(Object.assign(new Error("Assistant deadline reached"), { name: "TimeoutError" }));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then((value) => { signal.removeEventListener("abort", onAbort); resolve(value); }, (error) => { signal.removeEventListener("abort", onAbort); reject(error); });
  });
}

function waitForRetry(delayMs, signal) {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve(false);
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(true);
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve(false);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function providerStatus(error) {
  return Number(error?.status || error?.statusCode || error?.response?.status);
}

function retryDelayMs(error, retryNumber) {
  const maxDelayMs = 2000;
  const backoffMs = Math.min(maxDelayMs, 250 * (2 ** retryNumber));
  const retryAfterMs = error?.retryAfterMs;
  if (Number.isFinite(retryAfterMs) && retryAfterMs > maxDelayMs) return null;
  return Math.max(backoffMs, Number.isFinite(retryAfterMs) && retryAfterMs >= 0 ? retryAfterMs : 0);
}

function publicToolResult(value) {
  if (Array.isArray(value)) return value.map(publicToolResult);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => key !== "id" && !key.endsWith("_id"))
    .map(([key, nested]) => [key, publicToolResult(nested)]));
}

function patientUiActions(toolName, value) {
  if (toolName === "get_patient_appointments") return (value.appointments || []).map((row) => ({ type: "appointment", appointment_id: row.appointment_id || row.id }));
  if (toolName === "get_available_slots") return (value.slots || []).map((row) => ({ type: "slot", availability_id: row.availability_id || row.id, doctor_id: row.doctor_id || row.doctor?.id }));
  if (toolName === "search_doctors") return (value.doctors || []).map((row) => ({ type: "doctor", doctor_id: row.id }));
  return [];
}

function publicAssistantAnswer(value) {
  return value.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, "").replace(/\s{2,}/g, " ").trim();
}

function toolCacheKey(name, args) {
  return JSON.stringify([name, Object.entries(args || {}).sort(([first], [second]) => first.localeCompare(second))]);
}

function contextualReference(text, rows, noun) {
  const numericChoice = text.trim().match(/^\d{1,2}$/)?.[0];
  if (numericChoice && /appointment/i.test(noun)) return rows[Number(numericChoice) - 1] ? { row: rows[Number(numericChoice) - 1] } : { ambiguous: true };
  const ordinal = text.match(/\b(first|second|third|fourth|fifth)\b/i)?.[1]?.toLowerCase();
  const ordinalIndex = ordinal ? ["first", "second", "third", "fourth", "fifth"].indexOf(ordinal) : null;
  if (ordinalIndex !== null) return rows[ordinalIndex] ? { row: rows[ordinalIndex] } : { ambiguous: true };
  const numbered = text.match(new RegExp(`\\b(?:${noun})\\s+(?:number\\s+)?(\\d{1,2})\\b`, "i"))?.[1];
  if (numbered) return rows[Number(numbered) - 1] ? { row: rows[Number(numbered) - 1] } : { ambiguous: true };
  if (new RegExp(`\\b(?:this|that|the)\\s+(?:${noun})\\b`, "i").test(text)) {
    if (rows.length === 1) return { row: rows[0] };
    if (rows.length > 1) return { ambiguous: true };
  }
  return null;
}

function slotChoice(text, slots) {
  const explicit = text.trim().match(/^(?:book|reschedule\s+my\s+appointment\s+to)\s+(?:the\s+)?slot\s+(?:number\s+)?(\d{1,2})$/i)?.[1];
  if (explicit) {
    const index = Number(explicit) - 1;
    return index >= 0 && index < slots.length ? [slots[index]] : [];
  }
  const value = text.trim().match(/^(\d{1,2})$/)?.[1];
  if (!value || !slots.length) return null;
  const number = Number(value);
  const matches = new Map();
  if (number >= 1 && number <= slots.length) matches.set(slots[number - 1].availability_id || slots[number - 1].id, slots[number - 1]);
  for (const slot of slots) {
    const [hourText, minute = "00"] = String(slot.start_time || "").slice(0, 5).split(":");
    const hour = Number(hourText);
    if (hour === number || (hour % 12 || 12) === number) matches.set(slot.availability_id || slot.id, slot);
  }
  return [...matches.values()];
}

function modelReferenceSummary(context) {
  return {
    appointments: context.appointments.map(({ date, start_time, end_time, status, doctor }) => ({ date, start_time, end_time, status, doctor: doctor?.name })),
    slots: context.slots.map(({ date, start_time, end_time, mode, doctor }) => ({ date, start_time, end_time, mode, doctor: doctor?.name })),
    doctors: context.doctors.map(({ name, specialty }) => ({ name, specialty })),
  };
}

function searchMatchesRequestedTarget(search, requestedTime, requestedDate) {
  if (!requestedTime) return true;
  if (search.args.exact_start_time !== requestedTime || !search.args.from || search.args.from !== search.args.to) return false;
  if (requestedDate && !dateReferenceMatches(requestedDate, search.args.from)) return false;
  return true;
}

function appointmentSelectionIsUnambiguous(rows, selectedId, text, times, dates, targetTime, targetDate) {
  const matches = matchingAppointments(rows, text, times, dates, targetTime, targetDate);
  return matches.length === 1 && (matches[0].appointment_id || matches[0].id) === selectedId;
}

function doctorNameContains(doctorName, candidate) {
  const nameWords = String(doctorName || "").toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
  const candidateWords = String(candidate || "").toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
  return candidateWords.length > 0 && nameWords.some((_, start) => candidateWords.every((word, index) => nameWords[start + index] === word));
}

function requestedDoctorName(text) {
  return String(text || "").match(/\bDr\.?\s*([\p{L}][\p{L}'-]*(?:\s+(?!on\b|for\b|at\b|appointment\b|booking\b|date\b|time\b|available\b|availability\b|slot\b|slots\b|to\b|with\b)[\p{L}][\p{L}'-]*)?)/iu)?.[1]?.trim() || null;
}

function matchingAppointments(rows, text, times, dates, targetTime, targetDate) {
  const identifyingTimes = times.filter(({ index }) => !targetTime || index < targetTime.index);
  const identifyingDates = dates.filter(({ index }) => !targetDate || index < targetDate.index);
  const appointmentTime = targetTime && identifyingTimes.length
    ? selectedAppointmentTimes(text, identifyingTimes) || { start: identifyingTimes[0].candidates }
    : selectedAppointmentTimes(text, identifyingTimes);
  const doctorWords = requestedDoctorName(text)?.toLowerCase().split(/\s+/) || [];
  const doctorCandidates = doctorWords.length > 1 ? [doctorWords.join(" "), doctorWords[0]] : doctorWords;
  const doctorMention = doctorCandidates.find((candidate) => rows.some((row) => doctorNameContains(row.doctor?.name, candidate))) || doctorCandidates[0];
  const hasSelector = identifyingTimes.length > 0 || identifyingDates.length > 0 || Boolean(doctorMention);
  if (!hasSelector) return /\b(?:next|upcoming)\s+appointment\b/i.test(text) ? rows.slice(0, 1) : [];
  return rows.filter((row) => !isCancellationRequest(text) || row.status === "confirmed").filter((row) => {
    const rowTime = String(row.start_time || "").slice(0, 5);
    const rowEndTime = String(row.end_time || "").slice(0, 5);
    const rowDate = row.date;
    const doctorName = String(row.doctor?.name || "").toLowerCase();
    const timeMatches = !identifyingTimes.length
      || Boolean(appointmentTime?.start.includes(rowTime)
        && (!appointmentTime.end || appointmentTime.end.includes(rowEndTime)));
    return timeMatches
      && (!identifyingDates.length || identifyingDates.some((reference) => dateReferenceMatches(reference, rowDate)))
      && (!doctorMention || doctorNameContains(doctorName, doctorMention));
  });
}

function meridiemClarification(rows, times) {
  const selected = times.length === 1 ? times[0].candidates : [];
  if (selected.length !== 2 || rows.length < 2) return null;
  const matchedStarts = new Set(rows.map((row) => String(row.start_time || "").slice(0, 5)));
  if (!selected.every((candidate) => matchedStarts.has(candidate))) return null;
  const labels = selected.map((candidate) => {
    const [hourText, minute] = candidate.split(":");
    const hour = Number(hourText);
    return `${hour % 12 || 12}:${minute} ${hour >= 12 ? "PM" : "AM"}`;
  });
  return `I found appointments at both possible times. Did you mean ${labels.join(" or ")}?`;
}

function requestedDoctorMatches(text, doctorName) {
  const words = requestedDoctorName(text)?.toLowerCase().split(/\s+/) || [];
  if (!words.length) return true;
  const candidates = words.length > 1 ? [words.join(" "), words[0]] : words;
  const normalizedDoctorName = String(doctorName || "").toLowerCase();
  return candidates.some((candidate) => doctorNameContains(normalizedDoctorName, candidate));
}

function requestedTargetDoctorName(text) {
  const nonNameStarts = new Set(["a", "an", "appointment", "book", "booking", "change", "date", "my", "move", "option", "reschedule", "rescheduling", "schedule", "slot", "the", "time", "visit", "jan", "january", "feb", "february", "mar", "march", "apr", "april", "may", "jun", "june", "jul", "july", "aug", "august", "sep", "september", "oct", "october", "nov", "november", "dec", "december"]);
  const candidates = [...String(text).matchAll(/\bto\s+(?:Dr\.?\s+)?([\p{L}][\p{L}'-]*(?:\s+(?!on\b|for\b|at\b|to\b|jan(?:uary)?\b|feb(?:ruary)?\b|mar(?:ch)?\b|apr(?:il)?\b|may\b|jun(?:e)?\b|jul(?:y)?\b|aug(?:ust)?\b|sep(?:tember)?\b|oct(?:ober)?\b|nov(?:ember)?\b|dec(?:ember)?\b)[\p{L}][\p{L}'-]*)?)/giu)];
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const candidate = candidates[index][1].trim();
    if (!nonNameStarts.has(candidate.split(/\s+/)[0].toLowerCase())) return candidate;
  }
  return null;
}

function preparationTypeForTool(name) {
  return ({ prepare_booking_action: "book", prepare_reschedule_action: "reschedule", prepare_cancellation_action: "cancel" })[name];
}

function isSuccessfulProposal(name, args, result) {
  const actionType = preparationTypeForTool(name);
  if (!actionType || result?.requires_patient_confirmation !== true || result.proposal?.action_type !== actionType) return false;
  const proposalArgs = result.proposal.action_args;
  if (!proposalArgs || typeof proposalArgs !== "object") return false;
  const requiredKeys = actionType === "book" ? ["availability_id"] : actionType === "reschedule" ? ["appointment_id", "availability_id"] : ["appointment_id"];
  return requiredKeys.every((key) => proposalArgs[key] === args[key]);
}

function verifiedProposalEvidence(actionType, actionArgs, actor, appointment, slot) {
  const appointmentId = appointment?.appointment_id || appointment?.id;
  const availabilityId = slot?.availability_id || slot?.id;
  if ((actionType === "reschedule" || actionType === "cancel") && !appointmentId) return null;
  if ((actionType === "book" || actionType === "reschedule") && !availabilityId) return null;
  return {
    version: 1,
    proposal_succeeded: true,
    requires_patient_confirmation: true,
    tool_name: actionType === "book" ? "prepare_booking_action"
      : actionType === "reschedule" ? "prepare_reschedule_action" : "prepare_cancellation_action",
    action_type: actionType,
    action_args: actionArgs,
    verified_appointment_id: actionType === "reschedule" || actionType === "cancel" ? appointmentId : null,
    verified_availability_id: actionType === "book" || actionType === "reschedule" ? availabilityId : null,
    user_id: actor.id,
  };
}

function preparationReply(action, slot) {
  const label = action === "book" ? "booking" : action === "reschedule" ? "rescheduling" : "cancellation";
  const time = slot?.start_time
    ? ` at ${String(slot.start_time).slice(0, 5)}${slot.end_time ? `–${String(slot.end_time).slice(0, 5)}` : ""}`
    : "";
  const detail = slot?.date
    ? ` for ${slot.date}${time}${slot.doctor?.name ? ` with ${slot.doctor.name}` : ""}`
    : "";
  const fee = action === "book" && slot?.consultation_fee !== null && slot?.consultation_fee !== undefined && Number.isFinite(Number(slot.consultation_fee))
    ? ` The consultation fee is INR ${Number(slot.consultation_fee).toFixed(2)}.` : "";
  return `I prepared a ${label} proposal${detail}.${fee} It is only a proposal: no confirmation intent has been created and no appointment has been changed.`;
}

function appointmentChoiceDescription(row) {
  return `${row.doctor?.name || "Doctor not available"} on ${row.date} ${String(row.start_time || "").slice(0, 5)}${row.end_time ? ` to ${String(row.end_time).slice(0, 5)}` : ""}${row.status ? ` (${row.status}${row.mode ? `, ${row.mode}` : ""})` : row.mode ? ` (${row.mode})` : ""}`;
}

function refundPreviewReply(preview) {
  if (!preview.original_payment) {
    return `${preview.explanation || "No payment record is associated with this appointment."} I can't report processed, pending, or estimated refund amounts without an associated payment record.`;
  }
  const currency = preview.currency || preview.original_payment?.currency || "currency unavailable";
  const original = preview.original_payment
    ? `The recorded payment is ${currency} ${preview.original_payment.amount} (${preview.original_payment.status}).`
    : "There is no recorded payment for this appointment.";
  const estimateNote = "This is an estimate; the final refund is recalculated when you confirm cancellation.";
  const explanation = String(preview.explanation || "").replace(/this is an estimate\.?\s*/ig, "").replace(/estimate only\.?\s*/ig, "").replace(/the backend will recalculate the refund when you confirm cancellation\.?\s*/ig, "").trim();
  return `${original} Recorded processed refunds total ${currency} ${preview.processed_refund_amount || "0.00"}; pending refunds total ${currency} ${preview.pending_refund_amount || "0.00"}. The estimated additional refund is ${currency} ${preview.estimated_additional_refund_amount || "0.00"}. ${estimateNote}${explanation ? ` ${explanation}` : ""}`;
}

function privateCancellationContext(preparation) {
  if (preparation?.action !== "cancel") return undefined;
  const appointmentId = preparation.slot?.appointment_id || preparation.slot?.id;
  return typeof appointmentId === "string" ? { action_type: "cancel", appointment_id: appointmentId } : undefined;
}

function pendingCancellationContext(now, details = {}) {
  return {
    action_type: "cancel_pending",
    expires_at: new Date(now() + 5 * 60 * 1000).toISOString(),
    ...(typeof details.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(details.date) ? { date: details.date } : {}),
    ...(typeof details.time === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(details.time) ? { time: details.time } : {}),
    ...(typeof details.doctor_name === "string" ? { doctor_name: details.doctor_name.slice(0, 120) } : {}),
  };
}

function unverifiedActionClaim(answer) {
  return /\b(?:prepared|booked|scheduled|rescheduled|cancelled|canceled|created)\b[\s\S]{0,100}\b(?:appointment|booking|rescheduling|cancellation|action|intent|proposal)\b/i.test(answer)
    || /\b(?:appointment|booking|rescheduling|cancellation|action|intent|proposal)\b[\s\S]{0,100}\b(?:prepared|booked|scheduled|rescheduled|cancelled|canceled|created|ready|confirmed)\b/i.test(answer)
    || /\b(?:confirmation\s+)?intent\s+(?:was|has been|is)\s+(?:created|prepared|confirmed)\b/i.test(answer);
}

function rejectsCancellationProposal(text) {
  return /\b(?:don't|do not)\s+(?:want\s+to\s+)?(?:cancel|proceed|go ahead|do it|do that)\b/i.test(text)
    || /\b(?:never|stop)\s+(?:cancel|proceed|go ahead|do it|do that)\b/i.test(text)
    || /\b(?:i\s+)?changed\s+my\s+mind\b/i.test(text)
    || /\b(?:never mind|forget it|not anymore|no thanks|keep the appointment|leave the appointment)\b/i.test(text)
    || /^\s*(?:no|nope|nah)\b/i.test(text);
}

function createConversationEngine({ provider, toolExecutor, logger = console, now = Date.now, deadlineMs = 35000 }) {
  return {
    async respond({ actor, messages, database, applicationTimezone, paymentService, previousActionContext, previousProposal, previousReferences, tools = [], systemInstruction = "", requestId = "unknown", logger: requestLogger = logger }) {
      // This history is loaded from the server-owned conversation record.
      const transcript = messages.slice(-12).map((message) => ({ ...message }));
      let calls = 0;
      let modelRounds = 0;
      let providerAttempts = 0;
      let providerRetries = 0;
      const publicResults = [];
      const referenceTimestamps = { ...(previousReferences?.reference_timestamps || {}) };
      const referenceIsFresh = (kind) => {
        const capturedAt = referenceTimestamps[kind] || previousReferences?.captured_at;
        if (previousReferences?.version !== 1 || !capturedAt) return false;
        const age = now() - Date.parse(capturedAt);
        const maxAge = kind === "slots" ? 2 * 60 * 1000 : kind === "appointments" ? 5 * 60 * 1000 : 24 * 60 * 60 * 1000;
        return Number.isFinite(age) && age >= 0 && age <= maxAge;
      };
      const referenceContext = {
        appointments: referenceIsFresh("appointments") && Array.isArray(previousReferences?.appointments) ? previousReferences.appointments : [],
        slots: referenceIsFresh("slots") && Array.isArray(previousReferences?.slots) ? previousReferences.slots : [],
        doctors: referenceIsFresh("doctors") && Array.isArray(previousReferences?.doctors) ? previousReferences.doctors : [],
        ...(previousReferences?.pending_action === "cancel" ? { pending_action: "cancel" }
          : (referenceIsFresh("slots") || referenceIsFresh("appointments")) && (previousReferences?.pending_action === "book" || previousReferences?.pending_action === "reschedule") ? { pending_action: previousReferences.pending_action } : {}),
        ...(referenceIsFresh("appointments") && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(previousReferences?.pending_appointment_id || "") ? { pending_appointment_id: previousReferences.pending_appointment_id } : {}),
        ...(typeof previousReferences?.pending_target_date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(previousReferences.pending_target_date) ? { pending_target_date: previousReferences.pending_target_date } : {}),
        ...(referenceIsFresh("appointments") && previousReferences?.history_page && typeof previousReferences.history_page === "object" ? { history_page: previousReferences.history_page } : {}),
      };
      // Keep the numbered cancellation list separate from general appointment
      // history, which may replace `appointments` on a later conversation turn.
      let cancellationChoices = Array.isArray(previousReferences?.cancellation_choices) ? previousReferences.cancellation_choices
        : Array.isArray(previousReferences?.appointments) ? previousReferences.appointments : [];
      let cancellationChoicesAt = previousReferences?.cancellation_choices_at
        || referenceTimestamps.appointments;
      const cancellationChoicesAreFresh = () => {
        if (!cancellationChoicesAt) return false;
        const age = now() - Date.parse(cancellationChoicesAt);
        return Number.isFinite(age) && age >= 0 && age <= 5 * 60 * 1000;
      };
      const resolvedDoctorIds = new Set();
      const ambiguousDoctorIds = new Map();
      const ownedAppointments = new Map();
      const availabilitySlots = new Map();
      const appointmentResultTurns = new Map();
      const availabilityResultTurns = new Map();
      const appointmentSources = new Map();
      const availabilitySources = new Map();
      let latestAppointmentSearch = null;
      if (referenceContext.appointments.length) {
        const source = { turn: 0, rows: referenceContext.appointments };
        latestAppointmentSearch = source;
        for (const appointment of referenceContext.appointments) {
          const id = appointment.appointment_id || appointment.id;
          if (id) { ownedAppointments.set(id, appointment); appointmentResultTurns.set(id, 0); appointmentSources.set(id, source); }
        }
      }
      if (referenceContext.slots.length) {
        const source = { turn: 0, args: referenceContext.slot_query || {}, slots: referenceContext.slots };
        for (const slot of referenceContext.slots) {
          const id = slot.availability_id || slot.id;
          if (id) { availabilitySlots.set(id, slot); availabilityResultTurns.set(id, 0); availabilitySources.set(id, source); }
        }
      }
      for (const doctor of referenceContext.doctors) if (doctor.id) resolvedDoctorIds.add(doctor.id);
      let namedDoctorSearch = null;
      const currentUserText = [...messages].reverse().find((message) => message.role === "user")?.content || "";
      const explicitSlotCommand = /^(?:book|reschedule\s+my\s+appointment\s+to)\s+(?:the\s+)?slot\s+(?:number\s+)?\d{1,2}$/i.test(currentUserText.trim());
      const currentRequestNamesDoctor = Boolean(requestedDoctorName(currentUserText));
      const requestedTimes = timeReferences(currentUserText);
      const requestedDates = dateReferences(currentUserText);
      const requestedDate = requestedDates.at(-1);
      const requestedDateIso = resolveDateReference(requestedDate, applicationTimezone, now());
      const canonicalIntent = recognizeCanonicalIntent(currentUserText, applicationTimezone, now());
      if (/\b(?:i said|i meant|no,?\s*i said|correction)\b/i.test(currentUserText)) {
        const correctedDate = dateReferences(currentUserText).map((reference) => resolveDateReference(reference, applicationTimezone, now())).find(Boolean);
        if (correctedDate && referenceContext.history_page?.query) {
          canonicalIntent.category = "appointment_history";
          canonicalIntent.historyQuery = { view: "date", scope: "all", from: correctedDate, to: correctedDate };
          canonicalIntent.historyScope = "all_upcoming";
        }
      }
      const actionRequest = ({ booking: "book", rescheduling: "reschedule" })[canonicalIntent.category] || null;
      let targetTime = timeRangeTarget(currentUserText, requestedTimes);
      if (actionRequest === "reschedule" && requestedTimes.length >= 2) {
        const fromTo = currentUserText.slice(requestedTimes[0].endIndex, requestedTimes[1].index);
        const prefix = currentUserText.slice(0, requestedTimes[0].index);
        if (/\bfrom\s*$/i.test(prefix) && /^\s*to\s*$/i.test(fromTo)) targetTime = { start: requestedTimes[1], end: null };
      }
      const requestedTime = targetTime?.start.value;
      const requestedEndTime = targetTime?.end?.value;
      const appointmentListRequest = /\b(?:show|list|display|view)\b[\s\S]{0,60}\b(?:my\s+)?(?:upcoming\s+)?appointments\b/i.test(currentUserText)
        || /\b(?:my\s+)?upcoming\s+appointments\b/i.test(currentUserText);
      let toolTurn = 0;
      let successfulPreparation = null;
      let internalProposalEvidence = null;
      let successfulRefundPreview = null;
      const pendingCancellation = previousActionContext?.action_type === "cancel_pending";
      const pendingCancellationSelection = previousReferences?.pending_action === "cancel";
      const cancellationChoiceText = /^\s*\d{1,2}\s*$|\b(?:first|second|third|fourth|fifth)\s+(?:appointment|one)\b|\bappointment\s+(?:number\s+)?\d+\b|\b(?:this|that)\s+appointment\b/i.test(currentUserText);
      const cancellationDetailsFollowup = requestedDates.length > 0 || requestedTimes.length > 0 || currentRequestNamesDoctor;
      const cancellationClarification = (pendingCancellation
        && !actionRequest
        && canonicalIntent.category !== "appointment_history"
        && canonicalIntent.category !== "refund_preview")
        || (pendingCancellationSelection && !actionRequest && canonicalIntent.category !== "appointment_history"
          && canonicalIntent.category !== "refund_preview" && (cancellationChoiceText || cancellationDetailsFollowup));
      const cancellationRequest = canonicalIntent.category === "cancellation" || cancellationClarification;
      const priorCancellationDetails = pendingCancellation ? previousActionContext : {};
      const cancellationDate = requestedDateIso || priorCancellationDetails.date || null;
      const cancellationTime = requestedTime || priorCancellationDetails.time || null;
      const cancellationDoctorName = requestedDoctorName(currentUserText)
        || priorCancellationDetails.doctor_name || null;
      const pendingCancellationForTurn = () => pendingCancellationContext(now, {
        date: cancellationDate,
        time: canonicalIntent.timeInterpretation === "explicit" || !requestedTime ? cancellationTime : priorCancellationDetails.time,
        doctor_name: cancellationDoctorName,
      });
      let exactActionCandidates = [];
      let exactActionOutcome = null;
      const started = now();
      const signal = AbortSignal.timeout(deadlineMs);
      const executedToolResults = new Map();
      const executeTool = async (input) => {
        const key = toolCacheKey(input.name, input.args);
        if (executedToolResults.has(key)) return executedToolResults.get(key);
        if (calls >= 4) throw new AssistantError("TOOL_LIMIT_EXCEEDED", 502, "I checked the available records, but this request needs another lookup to finish. Please narrow the request and try again.");
        calls += 1;
        const result = await withDeadline(toolExecutor(input), signal);
        executedToolResults.set(key, result);
        return result;
      };
      const internalState = () => {
        const appointmentsForPersistence = referenceContext.pending_action === "cancel"
          && !referenceIsFresh("appointments") && !referenceContext.appointments.length
          ? cancellationChoices : referenceContext.appointments;
        return {
          ...(appointmentsForPersistence.length || cancellationChoices.length || referenceContext.slots.length || referenceContext.doctors.length || referenceContext.pending_action || referenceContext.pending_appointment_id || Object.values(referenceTimestamps).some(Boolean)
            ? { internalReferences: { ...referenceContext, appointments: appointmentsForPersistence, ...(cancellationChoices.length ? { cancellation_choices: cancellationChoices, cancellation_choices_at: cancellationChoicesAt } : {}), version: 1, reference_timestamps: referenceTimestamps } } : {}),
        };
      };
      const markReferenceFresh = (kind) => { referenceTimestamps[kind] = new Date(now()).toISOString(); };
      const checkedBookingTargets = new Map();
      const existingConfirmedAppointmentForSlot = async (doctorId, date, startTime) => {
        if (actor.role !== "patient" || !doctorId || !date || !startTime) return { appointment: null };
        const normalizedStart = String(startTime).slice(0, 5);
        const key = `${doctorId}|${date}|${normalizedStart}`;
        if (checkedBookingTargets.has(key)) return checkedBookingTargets.get(key);
        const page = await executeTool({
          name: "get_patient_appointments",
          args: { view: "upcoming", scope: "all", from: date, to: date },
          actor, database, applicationTimezone, paymentService,
        });
        const appointments = Array.isArray(page?.appointments) ? page.appointments : [];
        const match = appointments.find((appointment) => appointment.status === "confirmed"
          && appointment.doctor?.id === doctorId
          && appointment.date === date
          && String(appointment.start_time).slice(0, 5) === normalizedStart);
        const result = { appointment: match || null, uncertain: !match && page?.has_more === true };
        checkedBookingTargets.set(key, result);
        return result;
      };
      const alreadyBookedReply = (appointment, doctorName) => `You already have a confirmed appointment${doctorName ? ` with ${doctorName}` : ""} on ${appointment.date} at ${String(appointment.start_time).slice(0, 5)}. I haven't prepared another booking proposal.`;
      const assistantContextInstruction = referenceContext.appointments.length || referenceContext.slots.length || referenceContext.doctors.length
        ? `${systemInstruction}\nVerified recent results: ${JSON.stringify(modelReferenceSummary(referenceContext))}. Resolve follow-up references only against these returned records. Ask for clarification when ambiguous. Never search for a doctor using a numeric or pronoun-only reply, and never invent record IDs.`
        : systemInstruction;
      const log = (stage, error, attempt = 0, category) => {
        const status = Number(error?.providerStatus || error?.status || error?.statusCode || 0);
        const errorCategory = category || error?.category || (status ? `provider_http_${status}` : undefined);
        requestLogger?.info?.(stage, { requestId, attempt, elapsedMs: now() - started, ...(errorCategory ? { category: errorCategory } : {}), ...(status ? { providerStatus: status } : {}) });
      };
      if (actor.role === "patient" && previousProposal?.action_type === "cancel" && rejectsCancellationProposal(currentUserText)) {
        return {
          answer: "Understood. I dismissed the cancellation proposal and won't prepare it again.",
          results: [],
          dismissProposal: { assistant_message_id: previousProposal.assistant_message_id, action_type: "cancel" },
          ...internalState(),
        };
      }
      const isRefundFollowup = canonicalIntent.category === "refund_preview"
        && /\b(?:this|that)\s+(?:appointment|visit|booking)\b/i.test(currentUserText);
      if (isRefundFollowup) {
        const appointmentReference = contextualReference(currentUserText, referenceContext.appointments, "appointment");
        if (appointmentReference?.ambiguous) {
          return { answer: "More than one recent appointment could be the one you mean. Please identify it by doctor, date, and time.", results: [], ...internalState() };
        }
        const hasRecentAppointmentReferences = referenceContext.appointments.length > 0;
        const referencedAppointment = appointmentReference?.row;
        const appointmentId = referencedAppointment
          ? (referencedAppointment.appointment_id || referencedAppointment.id)
          : !hasRecentAppointmentReferences && previousActionContext?.action_type === "cancel" ? previousActionContext.appointment_id : null;
        const activeActionContext = referencedAppointment ? undefined : previousActionContext;
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(appointmentId || "")) {
          return { answer: "Which appointment do you mean? Please identify it by doctor, date, and time so I can check its payment and refund preview.", results: [] };
        }
        try {
          const preview = await executeTool({
            name: "get_cancellation_refund_preview",
            args: { appointment_id: appointmentId },
            actor,
            database,
            applicationTimezone,
            paymentService,
          });
          return {
            answer: refundPreviewReply(preview),
            results: [{ tool: "get_cancellation_refund_preview", data: publicToolResult(preview) }],
            ...(activeActionContext ? { internalActionContext: activeActionContext } : {}),
            ...internalState(),
          };
        } catch (error) {
          const answer = error?.code === "APPOINTMENT_NOT_FOUND"
            ? "I couldn't verify that appointment in your account, so I can't calculate its refund preview. Please identify the appointment again by doctor, date, and time."
            : error?.code === "APPOINTMENT_STATE_CONFLICT"
              ? "That appointment is no longer confirmed, so the cancellation refund preview is no longer available."
              : "I couldn't calculate the refund preview from the current appointment and payment records. No refund amount or processed status can be confirmed.";
          return { answer, results: [], ...(activeActionContext ? { internalActionContext: activeActionContext } : {}), ...internalState() };
        }
      }
      if (!explicitSlotCommand && (actionRequest || cancellationRequest) && canonicalIntent.timePrecision === "approximate") {
        return {
          answer: "Please give the exact appointment start time so I can check the correct slot or appointment.",
          results: [],
          ...(pendingCancellation ? { internalActionContext: pendingCancellationForTurn() } : {}),
          ...internalState(),
        };
      }
      if (!explicitSlotCommand && (actionRequest === "book" || actionRequest === "reschedule" || cancellationRequest) && targetTime?.start?.candidates?.length > 1) {
        const labels = targetTime.start.candidates.map((time) => {
          const [hour, minute] = time.split(":").map(Number);
          return `${hour % 12 || 12}:${String(minute).padStart(2, "0")} ${hour >= 12 ? "PM" : "AM"}`;
        });
        return {
          answer: `Did you mean ${labels.join(" or ")}? Please clarify before I prepare a proposal.`,
          results: [],
          ...(pendingCancellation ? { internalActionContext: pendingCancellationForTurn() } : {}),
          ...internalState(),
        };
      }
      const historyContinuation = /^\s*(?:(?:please|can you|could you|would you)\s+)*(?:continue(?:\s+(?:to\s+)?(?:the\s+)?(?:next page|list|history|appointments))?|(?:(?:show|give|load|fetch)\s+(?:(?:me|us)\s+)?(?:the\s+)?(?:next page|more appointments|more results))|next page|show more|more appointments|more results|keep going)\b/i.test(currentUserText);
      if (cancellationChoices.length
        && /\b(?:which|what)\b[\s\S]{0,50}\b(?:appointment|one)\b[\s\S]{0,40}\b(?:latest|most recent|newest|last)\b/i.test(currentUserText)) {
        const latestChoice = cancellationChoices
          .map((row, index) => ({ row, index }))
          .sort((left, right) => `${right.row.date || ""} ${right.row.start_time || ""}`.localeCompare(`${left.row.date || ""} ${left.row.start_time || ""}`))[0];
        return {
          answer: latestChoice
            ? `The latest appointment in the displayed list is number ${latestChoice.index + 1}: ${appointmentChoiceDescription(latestChoice.row)}.`
            : "I don't have the displayed appointment choices available. Please ask me to show your upcoming appointments again.",
          results: [],
          ...internalState(),
        };
      }
      const historyQuery = canonicalIntent.category === "appointment_history" ? canonicalIntent.historyQuery : null;
      const refundHistoryQuery = canonicalIntent.historyQuery;
      const resolvedHistoryQuery = historyContinuation ? referenceContext.history_page?.query : historyQuery;
      if (historyContinuation && (!resolvedHistoryQuery || !referenceContext.history_page)) {
        return { answer: "I don't have a recent appointment-history page to continue. Please ask for the appointment list again.", results: [], ...internalState() };
      }
      if (historyContinuation && referenceContext.history_page.has_more === false) {
        return { answer: "There are no more appointment pages in that list.", results: [], ...internalState() };
      }
      if (canonicalIntent.category === "payment_history") {
        try {
          const history = await executeTool({ name: "get_patient_payment_history", args: {}, actor, database, applicationTimezone, paymentService });
          const items = Array.isArray(history?.items) ? history.items : [];
          return {
            answer: items.length ? `Here are your ${items.length} most recent payment and refund records${history.has_more ? ". Ask me to show more for earlier records." : "."}` : "There are no payment records in your history.",
            results: [{ tool: "get_patient_payment_history", data: publicToolResult(history) }],
            ...internalState(),
          };
        } catch {
          return { answer: "I couldn't load your payment history just now. Please try again.", results: [], ...internalState() };
        }
      }
      if (canonicalIntent.category === "refund_preview" && (refundHistoryQuery || /\b(?:appointment|visit|booking)\b/i.test(currentUserText))) {
        const explicitTarget = /\bDr\.?\s+[\p{L}]/iu.test(currentUserText) || dateReferences(currentUserText).length > 0;
        const scopedDates = requestedDateIso ? { from: requestedDateIso, to: requestedDateIso } : {};
        const refundQueries = explicitTarget
          ? ["upcoming", "past"].map((view) => ({ view, scope: "all", ...scopedDates }))
          : [refundHistoryQuery || { view: "past", scope: "all" }];
        const rowsById = new Map();
        let incompleteLookup = false;
        for (const refundQuery of refundQueries) {
          const page = await executeTool({ name: "get_patient_appointments", args: refundQuery, actor, database, applicationTimezone, paymentService });
          incompleteLookup ||= page?.has_more === true;
          for (const row of Array.isArray(page?.appointments) ? page.appointments : []) {
            const id = row.appointment_id || row.id;
            if (id) rowsById.set(id, row);
          }
        }
        const rows = [...rowsById.values()];
        const matches = explicitTarget ? matchingAppointments(rows, currentUserText, requestedTimes, requestedDates, undefined, undefined) : rows;
        if (matches.length !== 1 || incompleteLookup) {
          return {
            answer: matches.length > 1 || incompleteLookup
              ? "Multiple appointments could match that refund request, or the matching records could not be fully checked. Please identify it by doctor, date, and time."
              : "I couldn't find a verified appointment to check. Please identify it by doctor, date, and time.",
            results: [], ...internalState(),
          };
        }
        const appointmentId = matches[0].appointment_id || matches[0].id;
        const preview = await executeTool({ name: "get_cancellation_refund_preview", args: { appointment_id: appointmentId }, actor, database, applicationTimezone, paymentService });
        return { answer: refundPreviewReply(preview), results: [{ tool: "get_cancellation_refund_preview", data: publicToolResult(preview) }], ...internalState() };
      }
      const effectiveHistoryQuery = historyContinuation ? resolvedHistoryQuery : historyQuery;
      if (effectiveHistoryQuery) {
        let history = { appointments: [], has_more: false, next_offset: 0 };
        let historyFailed = false;
        const priorPage = historyContinuation ? referenceContext.history_page : null;
        const initialOffset = priorPage?.next_offset || 0;
        const seenIds = new Set(priorPage?.seen_appointment_ids || []);
        for (let pageCount = 0; pageCount < 4; pageCount += 1) {
          try {
            const pageArgs = { ...effectiveHistoryQuery, ...(effectiveHistoryQuery.scope === "all" ? { offset: initialOffset + history.next_offset } : {}) };
            const page = await executeTool({ name: "get_patient_appointments", args: pageArgs, actor, database, applicationTimezone, paymentService });
            const newRows = (Array.isArray(page?.appointments) ? page.appointments : []).filter((row) => {
              const id = row.appointment_id || row.id;
              if (!id || seenIds.has(id)) return false;
              seenIds.add(id);
              return true;
            });
            history = {
              appointments: [...history.appointments, ...newRows],
              has_more: page?.has_more === true,
              next_offset: history.next_offset + (Array.isArray(page?.appointments) ? page.appointments.length : 0),
            };
            if (!history.has_more || effectiveHistoryQuery.scope !== "all" || !newRows.length) break;
          } catch {
            historyFailed = true;
            break;
          }
        }
        if (historyFailed) history.has_more = true;
        referenceContext.appointments = Array.isArray(history?.appointments) ? history.appointments : [];
        referenceContext.slots = [];
        referenceContext.doctors = [];
        markReferenceFresh("appointments");
        delete referenceTimestamps.slots;
        delete referenceTimestamps.doctors;
        referenceContext.history_page = { query: effectiveHistoryQuery, next_offset: initialOffset + history.next_offset, has_more: history.has_more, seen_appointment_ids: [...seenIds].slice(-1000) };
        markReferenceFresh("appointments");
        if (appointmentListRequest && history.appointments.length) {
          cancellationChoices = history.appointments;
          cancellationChoicesAt = new Date(now()).toISOString();
        }
        const category = effectiveHistoryQuery.scope === "nearest" ? "next upcoming appointment"
          : effectiveHistoryQuery.scope === "last" ? "most recent past appointment"
            : effectiveHistoryQuery.scope === "last_completed" ? "most recently completed appointment"
              : effectiveHistoryQuery.view === "date" ? `appointments on ${effectiveHistoryQuery.from}`
            : effectiveHistoryQuery.view === "cancelled" ? "cancelled appointments"
                : effectiveHistoryQuery.view === "past" ? "past appointments" : "upcoming appointments";
        const answer = historyContinuation && !referenceContext.appointments.length && !historyFailed
          ? "There are no more appointment pages in that list."
          : historyFailed && !referenceContext.appointments.length
          ? `I could not load your ${category} just now. Please retry the request.`
          : referenceContext.appointments.length
          ? historyContinuation
            ? history.has_more || historyFailed ? `Here are the next ${referenceContext.appointments.length} ${category}. There are more records; ask me to continue for the next page.` : `Here are the next ${referenceContext.appointments.length} ${category}.`
            : history.has_more || historyFailed ? `Here are ${referenceContext.appointments.length} ${category}. There are more records; ask me to continue for the next page.` : `Here are your ${category}.`
          : `You have no matching ${category}.`;
        const historyResult = { appointments: history.appointments, has_more: history.has_more };
        const uiActions = patientUiActions("get_patient_appointments", historyResult);
        return { answer, results: [{ tool: "get_patient_appointments", data: publicToolResult(historyResult), ...(uiActions.length ? { ui_actions: uiActions } : {}) }], ...internalState() };
      }
      const prepareForExactTarget = async (action, doctor, appointment) => {
        const targetCandidates = targetTime?.start?.candidates || [];
        if (!targetCandidates.length || !requestedDateIso || !doctor?.id) return { status: "not_applicable" };
        if (targetCandidates.length > 1) return { status: "ambiguous_time" };
        if (action === "book") {
          const existing = await existingConfirmedAppointmentForSlot(doctor.id, requestedDateIso, targetCandidates[0]);
          if (existing.appointment) return { status: "duplicate_booking", appointment: existing.appointment };
          if (existing.uncertain) return { status: "duplicate_check_incomplete" };
        }
        const exactSlotsById = new Map();
        for (const exactStartTime of targetCandidates) {
          const slotQuery = { doctor_id: doctor.id, from: requestedDateIso, to: requestedDateIso, exact_start_time: exactStartTime };
          const availability = await executeTool({ name: "get_available_slots", args: slotQuery, actor, database, applicationTimezone, paymentService });
          for (const slot of Array.isArray(availability?.slots) ? availability.slots : []) {
            if (slot.date !== requestedDateIso || String(slot.start_time).slice(0, 5) !== exactStartTime || slot.doctor_id !== doctor.id) continue;
            if (targetTime.end && !targetTime.end.candidates.includes(String(slot.end_time).slice(0, 5))) continue;
            const slotId = slot.availability_id || slot.id;
            if (slotId) exactSlotsById.set(slotId, slot);
          }
        }
        const exactSlots = [...exactSlotsById.values()];
        referenceContext.slots = exactSlots;
        markReferenceFresh("slots");
        referenceContext.slot_query = { doctor_id: doctor.id, from: requestedDateIso, to: requestedDateIso, exact_start_time: exactSlots.length === 1 ? String(exactSlots[0].start_time).slice(0, 5) : undefined };
        referenceContext.doctors = [doctor];
        markReferenceFresh("doctors");
        if (exactSlots.length === 0) return { status: "unavailable" };
        if (exactSlots.length !== 1) return { status: "ambiguous_slot" };
        const slot = exactSlots[0];
        const slotId = slot.availability_id || slot.id;
        if (!slotId) return { status: "unavailable" };
        const actionTool = action === "book" ? "prepare_booking_action" : "prepare_reschedule_action";
        const actionArgs = action === "book"
          ? { availability_id: slotId }
          : { appointment_id: appointment.appointment_id || appointment.id, availability_id: slotId };
        const proposal = await executeTool({ name: actionTool, args: actionArgs, actor, database, applicationTimezone, paymentService });
        if (!isSuccessfulProposal(actionTool, actionArgs, proposal)) return { status: "prepare_failed" };
        const result = { ...proposal, persisted_intent_created: false };
        publicResults.push({ tool: actionTool, data: publicToolResult(result) });
        successfulPreparation = { action, slot };
        internalProposalEvidence = verifiedProposalEvidence(
          action,
          actionArgs,
          actor,
          appointment,
          slot,
        );
        if (!internalProposalEvidence) return { status: "prepare_failed" };
        return { status: "prepared" };
      };
      const availabilityIntent = /\b(?:availability|available|open slots?|time slots?)\b/i.test(currentUserText);
      const namedAvailabilityDoctor = requestedDoctorName(currentUserText);
      const dateOnlyDoctorFollowup = !availabilityIntent && requestedDates.length > 0 && referenceContext.doctors.length === 1
        && !/\b(?:appointment|cancel|reschedul|book|refund)\b/i.test(currentUserText);
      if (actionRequest === "book" && namedAvailabilityDoctor && requestedDateIso) {
        const search = await executeTool({ name: "search_doctors", args: { name: namedAvailabilityDoctor }, actor, database, applicationTimezone, paymentService });
        const doctors = Array.isArray(search?.doctors) ? search.doctors : [];
        referenceContext.doctors = doctors;
        markReferenceFresh("doctors");
        if (doctors.length !== 1) {
          const answer = doctors.length ? `More than one doctor matches ${namedAvailabilityDoctor}. Please choose a doctor by name.` : `I could not find an active doctor matching ${namedAvailabilityDoctor}. Please check the doctor name.`;
          return { answer, results: [{ tool: "search_doctors", data: publicToolResult(search), ui_actions: patientUiActions("search_doctors", search) }], ...internalState() };
        }
        const doctor = doctors[0];
        if (requestedTime) {
          const outcome = await prepareForExactTarget("book", doctor);
          if (outcome.status === "prepared") {
            referenceContext.pending_action = undefined;
            return { answer: preparationReply("book", successfulPreparation.slot), results: publicResults, ...(internalProposalEvidence ? { internalProposalEvidence } : {}), ...internalState() };
          }
          if (outcome.status === "unavailable") {
            const [hourText, minute] = requestedTime.split(":");
            const hour = Number(hourText);
            const requestedTimeLabel = `${hour % 12 || 12}:${minute} ${hour >= 12 ? "PM" : "AM"}`;
            const alternatives = await executeTool({ name: "get_available_slots", args: { doctor_id: doctor.id, from: requestedDateIso, to: requestedDateIso }, actor, database, applicationTimezone, paymentService });
            referenceContext.slots = Array.isArray(alternatives?.slots) ? alternatives.slots : [];
            referenceContext.slot_query = { doctor_id: doctor.id, from: requestedDateIso, to: requestedDateIso };
            referenceContext.pending_action = referenceContext.slots.length ? "book" : undefined;
            markReferenceFresh("slots");
            return {
              answer: referenceContext.slots.length
                ? `The requested ${requestedTimeLabel} time is not available with ${doctor.name}. Here are other available times on ${requestedDateIso}. Choose one to prepare a booking proposal.`
                : `The requested ${requestedTimeLabel} time is not available with ${doctor.name}, and I couldn't find other available times on ${requestedDateIso}. Please choose another date.`,
              results: [{ tool: "get_available_slots", data: publicToolResult({ slots: referenceContext.slots }), ui_actions: patientUiActions("get_available_slots", { slots: referenceContext.slots }) }],
              ...internalState(),
            };
          }
          if (outcome.status === "duplicate_booking") return { answer: alreadyBookedReply(outcome.appointment, doctor.name), results: [], ...internalState() };
          if (outcome.status === "duplicate_check_incomplete") return { answer: "I couldn't verify your existing appointments, so I haven't prepared a duplicate booking. Please try again in a moment.", results: [], ...internalState() };
          return { answer: outcome.status === "ambiguous_slot" ? "More than one slot matches that exact time. Please clarify which slot you want." : "I couldn't verify that exact time for booking. Please try another time.", results: [], ...internalState() };
        }
        const args = { doctor_id: doctor.id, from: requestedDateIso, to: requestedDateIso };
        const availability = await executeTool({ name: "get_available_slots", args, actor, database, applicationTimezone, paymentService });
        referenceContext.slots = Array.isArray(availability?.slots) ? availability.slots : [];
        referenceContext.slot_query = args;
        referenceContext.pending_action = referenceContext.slots.length ? "book" : undefined;
        markReferenceFresh("slots");
        const slots = { slots: referenceContext.slots };
        return {
          answer: referenceContext.slots.length ? `Here are the available appointment times with ${doctor.name}. Choose one by its displayed time and I can prepare a booking proposal.` : `I could not find available appointment times with ${doctor.name} for that date.`,
          results: [{ tool: "get_available_slots", data: publicToolResult(slots), ui_actions: patientUiActions("get_available_slots", slots) }],
          ...internalState(),
        };
      }
      if (!actionRequest && ((availabilityIntent && namedAvailabilityDoctor) || dateOnlyDoctorFollowup)) {
        const search = dateOnlyDoctorFollowup ? { doctors: [referenceContext.doctors[0]] }
          : await executeTool({ name: "search_doctors", args: { name: namedAvailabilityDoctor }, actor, database, applicationTimezone, paymentService });
        const doctors = Array.isArray(search?.doctors) ? search.doctors : [];
        referenceContext.doctors = doctors;
        markReferenceFresh("doctors");
        if (doctors.length !== 1) {
          const answer = doctors.length ? `More than one doctor matches ${namedAvailabilityDoctor}. Please choose a doctor by name.` : `I could not find an active doctor matching ${namedAvailabilityDoctor}. Please check the doctor name.`;
          const results = dateOnlyDoctorFollowup ? [] : [{ tool: "search_doctors", data: publicToolResult(search), ui_actions: patientUiActions("search_doctors", search) }];
          return { answer, results, ...internalState() };
        }
        const doctor = doctors[0];
        const args = { doctor_id: doctor.id, ...(requestedDateIso ? { from: requestedDateIso, to: requestedDateIso } : {}), ...(requestedTime ? { exact_start_time: requestedTime } : {}) };
        const availability = await executeTool({ name: "get_available_slots", args, actor, database, applicationTimezone, paymentService });
        referenceContext.slots = Array.isArray(availability?.slots) ? availability.slots : [];
        referenceContext.slot_query = args;
        markReferenceFresh("slots");
        const results = [
          ...(!dateOnlyDoctorFollowup ? [{ tool: "search_doctors", data: publicToolResult(search), ui_actions: patientUiActions("search_doctors", search) }] : []),
          { tool: "get_available_slots", data: publicToolResult(availability), ui_actions: patientUiActions("get_available_slots", availability) },
        ];
        return { answer: availability.slots?.length ? `Here are the available appointment times with ${doctor.name}.` : `I could not find available appointment times with ${doctor.name} for that date.`, results, ...internalState() };
      }
      if (cancellationRequest) {
        const choicesForSelection = cancellationChoices.length
          ? cancellationChoices
          : referenceContext.appointments;
        const selectedReference = contextualReference(currentUserText, choicesForSelection, "appointment");
        if (selectedReference?.ambiguous) {
          if (cancellationChoices.length && !cancellationChoicesAreFresh()) {
            const page = await executeTool({ name: "get_patient_appointments", args: { view: "upcoming", scope: "all" }, actor, database, applicationTimezone, paymentService });
            const refreshedChoices = (Array.isArray(page?.appointments) ? page.appointments : []).filter((row) => row.status === "confirmed");
            referenceContext.appointments = refreshedChoices;
            referenceContext.pending_action = refreshedChoices.length ? "cancel" : undefined;
            cancellationChoices = refreshedChoices;
            cancellationChoicesAt = new Date(now()).toISOString();
            markReferenceFresh("appointments");
            if (!refreshedChoices.length) return { answer: "Those appointment choices expired. I refreshed your upcoming appointments but found no confirmed appointments to cancel.", results: [], ...internalState() };
            return { answer: "Those appointment choices expired, so I refreshed your upcoming appointments. Choose again from this current list.", results: [{ tool: "get_patient_appointments", data: publicToolResult({ appointments: refreshedChoices }), ui_actions: patientUiActions("get_patient_appointments", { appointments: refreshedChoices }) }], ...internalState() };
          }
          if (!choicesForSelection.length && cancellationChoiceText) {
            const page = await executeTool({ name: "get_patient_appointments", args: { view: "upcoming", scope: "all" }, actor, database, applicationTimezone, paymentService });
            const refreshedChoices = (Array.isArray(page?.appointments) ? page.appointments : []).filter((row) => row.status === "confirmed");
            referenceContext.appointments = refreshedChoices;
            referenceContext.pending_action = refreshedChoices.length ? "cancel" : undefined;
            cancellationChoices = refreshedChoices;
            cancellationChoicesAt = new Date(now()).toISOString();
            markReferenceFresh("appointments");
            if (!refreshedChoices.length) return { answer: "I couldn't find confirmed upcoming appointments to cancel. Please ask for your current appointment list.", results: [], ...internalState() };
            return { answer: "I couldn't verify the old numbered choice, so I refreshed your upcoming appointments. Choose again from this current list.", results: [{ tool: "get_patient_appointments", data: publicToolResult({ appointments: refreshedChoices }), ui_actions: patientUiActions("get_patient_appointments", { appointments: refreshedChoices }) }], ...internalState() };
          }
          return { answer: "Which of the displayed appointments do you want to cancel? Choose one by its number.", results: [], internalActionContext: pendingCancellationForTurn(), ...internalState() };
        }
        if (!selectedReference && !choicesForSelection.length && cancellationChoiceText) {
          const page = await executeTool({ name: "get_patient_appointments", args: { view: "upcoming", scope: "all" }, actor, database, applicationTimezone, paymentService });
          const refreshedChoices = (Array.isArray(page?.appointments) ? page.appointments : []).filter((row) => row.status === "confirmed");
          referenceContext.appointments = refreshedChoices;
          referenceContext.pending_action = refreshedChoices.length ? "cancel" : undefined;
          cancellationChoices = refreshedChoices;
          cancellationChoicesAt = new Date(now()).toISOString();
          markReferenceFresh("appointments");
          if (!refreshedChoices.length) return { answer: "I couldn't find confirmed upcoming appointments to cancel. Please ask for your current appointment list.", results: [], ...internalState() };
          return { answer: "I couldn't verify the old numbered choice, so I refreshed your upcoming appointments. Choose again from this current list.", results: [{ tool: "get_patient_appointments", data: publicToolResult({ appointments: refreshedChoices }), ui_actions: patientUiActions("get_patient_appointments", { appointments: refreshedChoices }) }], ...internalState() };
        }
        let appointment = selectedReference?.row || null;
        let matches = appointment ? [appointment] : [];
        let appointmentPage = null;
        if (appointment && cancellationChoices.length && !cancellationChoicesAreFresh()) {
          const previousChoice = appointment;
          appointmentPage = await executeTool({
            name: "get_patient_appointments",
            args: { view: "upcoming", scope: "all", ...(previousChoice.date ? { from: previousChoice.date, to: previousChoice.date } : {}) },
            actor, database, applicationTimezone, paymentService,
          });
          const refreshedRows = Array.isArray(appointmentPage?.appointments) ? appointmentPage.appointments : [];
          const confirmedRows = refreshedRows.filter((row) => row.status === "confirmed");
          const sameDoctorRows = previousChoice.doctor?.id
            ? confirmedRows.filter((row) => row.doctor?.id === previousChoice.doctor.id)
            : confirmedRows;
          const refreshedChoices = sameDoctorRows.length ? sameDoctorRows : confirmedRows;
          referenceContext.appointments = refreshedChoices;
          referenceContext.pending_action = refreshedChoices.length ? "cancel" : undefined;
          markReferenceFresh("appointments");
          cancellationChoices = refreshedChoices;
          cancellationChoicesAt = new Date(now()).toISOString();
          const refreshedActionContext = pendingCancellationContext(now, {
            date: previousChoice.date,
            time: typeof previousChoice.start_time === "string" ? previousChoice.start_time.slice(0, 5) : undefined,
            doctor_name: previousChoice.doctor?.name,
          });
          if (!refreshedChoices.length) {
            return { answer: `That numbered choice expired. I refreshed your appointments for ${previousChoice.date || "the upcoming period"}, but found no confirmed appointment there. Please ask for the current appointment list.`, results: [], internalActionContext: refreshedActionContext, ...internalState() };
          }
          return {
            answer: `That numbered choice expired, so I refreshed your upcoming appointments. Choose the appointment you want to cancel from this current list of ${refreshedChoices.length}.`,
            results: [{ tool: "get_patient_appointments", data: publicToolResult({ appointments: refreshedChoices }), ui_actions: patientUiActions("get_patient_appointments", { appointments: refreshedChoices }) }],
            internalActionContext: refreshedActionContext,
            ...internalState(),
          };
        }
        if (!appointment) {
          if (!cancellationDate && !cancellationTime && !cancellationDoctorName) {
            return { answer: "Please identify the appointment by its date and start time so I can find the correct patient-owned appointment.", results: [], internalActionContext: pendingCancellationForTurn(), ...internalState() };
          }
          appointmentPage = await executeTool({
            name: "get_patient_appointments",
            args: { view: "upcoming", scope: "all", ...(cancellationDate ? { from: cancellationDate, to: cancellationDate } : {}) },
            actor, database, applicationTimezone, paymentService,
          });
          const rows = Array.isArray(appointmentPage?.appointments) ? appointmentPage.appointments : [];
          referenceContext.appointments = rows;
          markReferenceFresh("appointments");
          const cancellationText = [currentUserText, cancellationDoctorName, cancellationDate, cancellationTime].filter(Boolean).join(" ");
          const cancellationTimes = requestedTimes.length ? requestedTimes : cancellationTime ? timeReferences(cancellationTime) : [];
          const cancellationDates = requestedDates.length ? requestedDates : cancellationDate ? dateReferences(cancellationDate) : [];
          matches = matchingAppointments(rows, cancellationText, cancellationTimes, cancellationDates, undefined, undefined);
          if (matches.length !== 1 || appointmentPage.has_more === true) {
            if (matches.length > 1) {
              referenceContext.appointments = matches;
              referenceContext.pending_action = "cancel";
              cancellationChoices = matches;
              cancellationChoicesAt = new Date(now()).toISOString();
              const selectionAnswer = `I found multiple matching appointments that are confirmed (${matches.length}): ${matches.map(appointmentChoiceDescription).join("; ")}. Choose the appointment you want to cancel.`;
              return { answer: selectionAnswer, results: [{ tool: "get_patient_appointments", data: publicToolResult({ appointments: matches }), ui_actions: patientUiActions("get_patient_appointments", { appointments: matches }) }], internalActionContext: pendingCancellationForTurn(), ...internalState() };
            }
            const answer = appointmentPage.has_more === true
              ? "I found more upcoming appointments than I can verify in one request. Please add the doctor's name or appointment date."
              : cancellationDoctorName && cancellationDate && cancellationTime
                ? `I couldn't find a confirmed appointment matching Dr. ${cancellationDoctorName} on ${cancellationDate} at ${cancellationTime}.`
                : cancellationDoctorName && cancellationDate
                  ? `I couldn't find a confirmed appointment matching Dr. ${cancellationDoctorName} on ${cancellationDate}.`
                  : cancellationDoctorName && cancellationTime
                    ? `I couldn't find a confirmed appointment matching Dr. ${cancellationDoctorName} at ${cancellationTime}.`
                    : "I couldn't find one confirmed appointment matching those details.";
            return { answer, results: [], internalActionContext: pendingCancellationForTurn(), ...internalState() };
          }
          appointment = matches[0];
        }
        if (appointment.status !== "confirmed") return { answer: "That appointment is no longer confirmed and cannot be cancelled. Please refresh your appointment list.", results: [], ...internalState() };
        const appointmentId = appointment.appointment_id || appointment.id;
        const args = { appointment_id: appointmentId };
        const proposal = await executeTool({ name: "prepare_cancellation_action", args, actor, database, applicationTimezone, paymentService });
        if (!isSuccessfulProposal("prepare_cancellation_action", args, proposal)) {
          return { answer: "I couldn't prepare the cancellation proposal because the appointment is no longer eligible. Please refresh your appointment list and try again.", results: [], ...internalState() };
        }
        const result = { ...proposal, persisted_intent_created: false };
        successfulPreparation = { action: "cancel", slot: appointment };
        referenceContext.pending_action = undefined;
        return {
          answer: preparationReply("cancel", appointment),
          results: [{ tool: "prepare_cancellation_action", data: publicToolResult(result) }],
          ...(privateCancellationContext(successfulPreparation) ? { internalActionContext: privateCancellationContext(successfulPreparation) } : {}),
          internalProposalEvidence: verifiedProposalEvidence("cancel", args, actor, appointment, null),
          ...internalState(),
        };
      }
      const explicitTargetDoctorName = actionRequest === "reschedule" ? requestedTargetDoctorName(currentUserText) : null;
      if (actionRequest === "reschedule" && referenceContext.pending_action === "reschedule" && referenceContext.pending_target_date) {
        const selectedAppointment = contextualReference(currentUserText, referenceContext.appointments, "appointment");
        if (selectedAppointment?.ambiguous) return { answer: "Which of the displayed appointments do you want to reschedule? Choose one by its number.", results: [], ...internalState() };
        if (selectedAppointment?.row) {
          const appointment = selectedAppointment.row;
          if (appointment.status !== "confirmed") return { answer: "That appointment is no longer eligible for rescheduling. Please refresh your appointment list.", results: [], ...internalState() };
          const args = { doctor_id: appointment.doctor?.id, from: referenceContext.pending_target_date, to: referenceContext.pending_target_date };
          if (!args.doctor_id) return { answer: "I couldn't verify the doctor for that appointment. Please refresh your appointment list and try again.", results: [], ...internalState() };
          const availability = await executeTool({ name: "get_available_slots", args, actor, database, applicationTimezone, paymentService });
          referenceContext.slots = Array.isArray(availability?.slots) ? availability.slots : [];
          referenceContext.slot_query = args;
          referenceContext.pending_appointment_id = appointment.appointment_id || appointment.id;
          referenceContext.pending_action = referenceContext.slots.length ? "reschedule" : undefined;
          markReferenceFresh("slots");
          return { answer: referenceContext.slots.length ? `Here are available times to reschedule with ${appointment.doctor.name} on ${referenceContext.pending_target_date}. Choose a time to prepare the rescheduling proposal.` : `I couldn't find available times with ${appointment.doctor.name} on ${referenceContext.pending_target_date}. Please choose another date.`, results: [{ tool: "get_available_slots", data: publicToolResult(availability), ui_actions: patientUiActions("get_available_slots", availability) }], ...internalState() };
        }
      }
      const sourceDoctorName = requestedDoctorName(currentUserText);
      if (actionRequest === "reschedule" && sourceDoctorName && requestedDates.length >= 2) {
        const sourceDate = resolveDateReference(requestedDates[0], applicationTimezone, now());
        const targetDate = requestedDateIso;
        const targetDateReference = requestedDates.at(-1);
        const targetTimeProvided = requestedTimes.some((reference) => reference.index > targetDateReference.index);
        const sourceMatchTargetTime = targetTimeProvided ? targetTime : null;
        const sourcePage = await executeTool({ name: "get_patient_appointments", args: { view: "upcoming", scope: "all", from: sourceDate, to: sourceDate }, actor, database, applicationTimezone, paymentService });
        const sourceRows = Array.isArray(sourcePage?.appointments) ? sourcePage.appointments : [];
        const matches = matchingAppointments(sourceRows, currentUserText, requestedTimes, requestedDates, sourceMatchTargetTime, requestedDate)
          .filter((appointment) => appointment.status === "confirmed");
        referenceContext.appointments = matches;
        markReferenceFresh("appointments");
        referenceContext.pending_action = "reschedule";
        referenceContext.pending_target_date = targetDate;
        if (matches.length !== 1 || sourcePage?.has_more === true) {
          const answer = matches.length > 1
            ? `I found ${matches.length} confirmed appointments matching Dr. ${sourceDoctorName} on ${sourceDate}. Choose which appointment you want to reschedule.`
            : "I couldn't verify one confirmed appointment matching that doctor and date. Please provide its exact start time.";
          return {
            answer,
            results: matches.length ? [{ tool: "get_patient_appointments", data: publicToolResult({ appointments: matches }), ui_actions: patientUiActions("get_patient_appointments", { appointments: matches }) }] : [],
            ...internalState(),
          };
        }
        const appointment = matches[0];
        referenceContext.pending_appointment_id = appointment.appointment_id || appointment.id;
        let targetDoctor = appointment.doctor;
        if (explicitTargetDoctorName && !doctorNameContains(targetDoctor?.name, explicitTargetDoctorName)) {
          const doctorSearch = await executeTool({ name: "search_doctors", args: { name: explicitTargetDoctorName }, actor, database, applicationTimezone, paymentService });
          const doctors = Array.isArray(doctorSearch?.doctors) ? doctorSearch.doctors : [];
          if (doctors.length !== 1) return { answer: doctors.length ? `More than one doctor matches ${explicitTargetDoctorName}. Please choose a doctor by name.` : `I could not find an active doctor matching ${explicitTargetDoctorName}.`, results: [{ tool: "search_doctors", data: publicToolResult(doctorSearch), ui_actions: patientUiActions("search_doctors", doctorSearch) }], ...internalState() };
          targetDoctor = doctors[0];
        }
        if (targetTimeProvided && requestedTime) {
          const outcome = await prepareForExactTarget("reschedule", targetDoctor, appointment);
          if (outcome.status === "prepared") {
            referenceContext.pending_action = undefined;
            return { answer: preparationReply("reschedule", successfulPreparation.slot), results: publicResults, ...(internalProposalEvidence ? { internalProposalEvidence } : {}), ...internalState() };
          }
          if (outcome.status !== "not_applicable") return { answer: outcome.status === "unavailable" ? "That exact target time is no longer available. Please choose another time." : "I couldn't prepare that rescheduling proposal. Please check the target date and time.", results: [], ...internalState() };
        }
        const args = { doctor_id: targetDoctor?.id, from: targetDate, to: targetDate };
        const availability = await executeTool({ name: "get_available_slots", args, actor, database, applicationTimezone, paymentService });
        referenceContext.slots = Array.isArray(availability?.slots) ? availability.slots : [];
        referenceContext.slot_query = args;
        referenceContext.pending_action = referenceContext.slots.length ? "reschedule" : undefined;
        markReferenceFresh("slots");
        return {
          answer: referenceContext.slots.length ? `Here are available times to reschedule your appointment with ${targetDoctor.name} on ${targetDate}. Choose a time to prepare the rescheduling proposal.` : `I couldn't find available times with ${targetDoctor.name} on ${targetDate}. Please choose another date.`,
          results: [{ tool: "get_available_slots", data: publicToolResult(availability), ui_actions: patientUiActions("get_available_slots", availability) }],
          ...internalState(),
        };
      }
      const targetDateOnlyDoctorReschedule = actionRequest === "reschedule" && sourceDoctorName
        && requestedDates.length === 1 && requestedTimes.length === 0
        && /\bto\s+(?:the\s+)?(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|\d{1,2}\b)/i.test(currentUserText);
      if (actionRequest === "reschedule" && sourceDoctorName
          && ((requestedDates.length === 0 && requestedTimes.length === 0) || targetDateOnlyDoctorReschedule)) {
        const page = await executeTool({ name: "get_patient_appointments", args: { view: "upcoming", scope: "all" }, actor, database, applicationTimezone, paymentService });
        const matches = (Array.isArray(page?.appointments) ? page.appointments : [])
          .filter((appointment) => appointment.status === "confirmed" && doctorNameContains(appointment.doctor?.name, sourceDoctorName));
        referenceContext.appointments = matches;
        markReferenceFresh("appointments");
        referenceContext.pending_target_date = targetDateOnlyDoctorReschedule ? requestedDateIso : undefined;
        referenceContext.pending_action = targetDateOnlyDoctorReschedule && matches.length ? "reschedule" : undefined;
        referenceContext.pending_appointment_id = matches.length === 1 ? (matches[0].appointment_id || matches[0].id) : undefined;
        const answer = matches.length
          ? `I found ${matches.length} confirmed upcoming appointment${matches.length === 1 ? "" : "s"} with Dr. ${sourceDoctorName}. Choose the appointment you want to reschedule${targetDateOnlyDoctorReschedule ? ` to ${requestedDateIso}` : ", then tell me the target date and time"}.`
          : `I couldn't find a confirmed upcoming appointment with Dr. ${sourceDoctorName}.`;
        return { answer, results: matches.length ? [{ tool: "get_patient_appointments", data: publicToolResult({ appointments: matches }), ui_actions: patientUiActions("get_patient_appointments", { appointments: matches }) }] : [], ...internalState() };
      }
      if (actionRequest === "reschedule" && explicitTargetDoctorName) {
        let sourceAppointment = null;
        const selectedReference = contextualReference(currentUserText, referenceContext.appointments, "appointment");
        if (selectedReference?.ambiguous) {
          return { answer: "Which of the appointments shown do you want to reschedule? Please choose one by its displayed date and time.", results: [], ...internalState() };
        }
        sourceAppointment = selectedReference?.row || null;
        if (!sourceAppointment) {
          const sourceDateReference = requestedDates.find((reference) => !requestedDate || reference !== requestedDate) || requestedDate;
          const sourceDateIso = resolveDateReference(sourceDateReference, applicationTimezone, now());
          if (!sourceDateIso || !requestedTime || !requestedDateIso) {
            return { answer: "Please identify the existing appointment and provide the target doctor's name, date, and exact start time.", results: [], ...internalState() };
          }
          const appointmentPage = await executeTool({
            name: "get_patient_appointments",
            args: { view: "upcoming", scope: "all", from: sourceDateIso, to: sourceDateIso },
            actor, database, applicationTimezone, paymentService,
          });
          const rows = Array.isArray(appointmentPage?.appointments) ? appointmentPage.appointments : [];
          referenceContext.appointments = rows;
          markReferenceFresh("appointments");
          const matches = matchingAppointments(rows, currentUserText, requestedTimes, requestedDates, requestedTime, requestedDate);
          if (matches.length !== 1 || appointmentPage.has_more === true) {
            const answer = matches.length > 1
              ? `More than one existing appointment could match: ${matches.map(appointmentChoiceDescription).join("; ")}. Which one do you want to move?`
              : "I couldn't verify one eligible appointment matching those source details. Please identify its doctor, date, and start time.";
            return { answer, results: [], ...internalState() };
          }
          sourceAppointment = matches[0];
        }
        if (sourceAppointment.status !== "confirmed") {
          return { answer: "That appointment is no longer eligible for rescheduling. Please refresh your appointment list.", results: [], ...internalState() };
        }
        if (!requestedTime || !requestedDateIso) {
          return { answer: "Please provide the target date and exact start time for the reschedule.", results: [], ...internalState() };
        }
        let targetDoctor;
        if (doctorNameContains(sourceAppointment.doctor?.name, explicitTargetDoctorName)) {
          targetDoctor = sourceAppointment.doctor;
        } else {
          const search = await executeTool({ name: "search_doctors", args: { name: explicitTargetDoctorName }, actor, database, applicationTimezone, paymentService });
          const doctors = Array.isArray(search?.doctors) ? search.doctors : [];
          referenceContext.doctors = doctors;
          markReferenceFresh("doctors");
          if (doctors.length !== 1) {
            return {
              answer: doctors.length > 1
                ? `More than one doctor matches ${explicitTargetDoctorName}: ${doctors.map((doctor) => doctor.name).join(", ")}. Which doctor do you mean?`
                : `I could not find an active doctor matching ${explicitTargetDoctorName}. Please check the target doctor's name.`,
              results: [], ...internalState(),
            };
          }
          targetDoctor = doctors[0];
        }
        const outcome = await prepareForExactTarget("reschedule", targetDoctor, sourceAppointment);
        if (outcome.status !== "prepared") {
          return {
            answer: outcome.status === "unavailable"
              ? "That exact date and time is unavailable with the selected doctor. Please choose another time."
              : outcome.status === "ambiguous_slot"
                ? "More than one slot matches that exact date and time. Please clarify which option you want."
                : "I couldn't prepare the rescheduling proposal. Please refresh the appointment and availability details, then try again.",
            results: [], ...internalState(),
          };
        }
        referenceContext.pending_action = undefined;
        return {
          answer: preparationReply("reschedule", successfulPreparation.slot),
          results: publicResults,
          ...(internalProposalEvidence ? { internalProposalEvidence } : {}),
          ...internalState(),
        };
      }
      const shortSlotMatches = slotChoice(currentUserText, referenceContext.slots);
      const contextualSlotSelection = contextualReference(currentUserText, referenceContext.slots, "slot|availability option");
      const selectedSlots = shortSlotMatches || (contextualSlotSelection?.row ? [contextualSlotSelection.row] : null);
      const isExplicitSlotChoice = /^(?:book|reschedule\s+my\s+appointment\s+to)\s+(?:the\s+)?slot\s+(?:number\s+)?\d{1,2}$/i.test(currentUserText.trim());
      if ((/^\s*\d{1,2}\s*$/.test(currentUserText) || isExplicitSlotChoice) && !selectedSlots?.length) {
        return { answer: "I don't have a recent displayed slot list to resolve that number against. Please ask me to check current availability again.", results: [], ...internalState() };
      }
      if (((/^\s*\d{1,2}\s*$/.test(currentUserText) || isExplicitSlotChoice || contextualSlotSelection) && selectedSlots) || contextualSlotSelection?.ambiguous) {
        if (contextualSlotSelection?.ambiguous || selectedSlots.length > 1) {
          return { answer: "More than one displayed slot could match that choice. Please choose one by its exact displayed time.", results: [], ...internalState() };
        }
        const slot = selectedSlots[0];
        if (referenceContext.pending_action === "book" || (isExplicitSlotChoice && actionRequest === "book" && /^book\s+slot\b/i.test(currentUserText.trim()))) {
          const existing = await existingConfirmedAppointmentForSlot(slot.doctor_id || slot.doctor?.id, slot.date, slot.start_time);
          if (existing.appointment) return { answer: alreadyBookedReply(existing.appointment, slot.doctor?.name), results: [], ...internalState() };
          if (existing.uncertain) return { answer: "I couldn't verify your existing appointments, so I haven't prepared a duplicate booking. Please try again in a moment.", results: [], ...internalState() };
          const args = { availability_id: slot.availability_id || slot.id };
          const proposal = await executeTool({ name: "prepare_booking_action", args, actor, database, applicationTimezone, paymentService });
          if (isSuccessfulProposal("prepare_booking_action", args, proposal)) {
            referenceContext.pending_action = undefined;
            const result = { ...proposal, persisted_intent_created: false };
            return {
              answer: preparationReply("book", slot),
              results: [{ tool: "prepare_booking_action", data: publicToolResult(result) }],
              internalProposalEvidence: verifiedProposalEvidence("book", args, actor, null, slot),
              ...internalState(),
            };
          }
        }
        if (referenceContext.pending_action === "reschedule") {
          const appointment = referenceContext.appointments.find((row) => (row.appointment_id || row.id) === referenceContext.pending_appointment_id);
          if (!appointment || appointment.status !== "confirmed") {
            return { answer: "I couldn't verify one confirmed appointment to reschedule. Please identify the appointment again before choosing a time.", results: [], ...internalState() };
          }
          const args = { appointment_id: appointment.appointment_id || appointment.id, availability_id: slot.availability_id || slot.id };
          const proposal = await executeTool({ name: "prepare_reschedule_action", args, actor, database, applicationTimezone, paymentService });
          if (isSuccessfulProposal("prepare_reschedule_action", args, proposal)) {
            referenceContext.pending_action = undefined;
            referenceContext.pending_appointment_id = undefined;
            const result = { ...proposal, persisted_intent_created: false };
            return {
              answer: preparationReply("reschedule", slot),
              results: [{ tool: "prepare_reschedule_action", data: publicToolResult(result) }],
              internalProposalEvidence: verifiedProposalEvidence("reschedule", args, actor, appointment, slot),
              ...internalState(),
            };
          }
        }
        return { answer: `That matches ${slot.date} at ${String(slot.start_time).slice(0, 5)}–${String(slot.end_time || "").slice(0, 5)}${slot.doctor?.name ? ` with ${slot.doctor.name}` : ""}. Would you like me to prepare a booking proposal?`, results: [{ tool: "get_available_slots", data: publicToolResult({ slots: [slot] }) }], ...internalState() };
      }
      const doctorPronounReference = /\b(?:him|her|them|that doctor|this doctor)\b/i.test(currentUserText);
      if (doctorPronounReference && /\b(?:availability|available|slots?|appointments?)\b/i.test(currentUserText)) {
        if (referenceContext.doctors.length !== 1) {
          const answer = referenceContext.doctors.length > 1
            ? `Which doctor do you mean: ${referenceContext.doctors.map((doctor) => doctor.name).filter(Boolean).join(", ")}?`
            : "Which doctor do you mean? Please name the doctor so I can check current availability.";
          return { answer, results: [], ...internalState() };
        }
        const doctor = referenceContext.doctors[0];
        const args = { doctor_id: doctor.id };
        if (requestedDateIso) { args.from = requestedDateIso; args.to = requestedDateIso; }
        if (requestedTime) args.exact_start_time = requestedTime;
        const availability = await executeTool({ name: "get_available_slots", args, actor, database, applicationTimezone, paymentService });
        referenceContext.slots = Array.isArray(availability?.slots) ? availability.slots : [];
        markReferenceFresh("slots");
        referenceContext.slot_query = args;
        const count = referenceContext.slots.length;
        const answer = count
          ? `Here are ${count} available option${count === 1 ? "" : "s"}${doctor.name ? ` with ${doctor.name}` : ""}.`
          : `I couldn't find available appointment options${doctor.name ? ` with ${doctor.name}` : ""} for that request.`;
        return { answer, results: [{ tool: "get_available_slots", data: publicToolResult(availability) }], ...internalState() };
      }
      if (actionRequest === "reschedule" && (/\b(?:this|that)\s+appointment\b/i.test(currentUserText) || /\b(?:first|second|third|fourth|fifth)\s+one\b/i.test(currentUserText))) {
        const selection = contextualReference(currentUserText, referenceContext.appointments, "appointment");
        if (selection?.ambiguous) return { answer: "Which of the appointments shown do you want to reschedule? Please choose one by its displayed date and time.", results: [], ...internalState() };
        const appointment = selection?.row;
        const targetDoctorName = requestedTargetDoctorName(currentUserText);
        if (!appointment) return { answer: "I couldn't resolve that appointment from your recent appointment results. Please show your upcoming appointments or identify this one by its doctor, date, and time.", results: [], ...internalState() };
        if (!targetDoctorName || !requestedTime || !requestedDateIso) return { answer: "Please specify the target doctor's name and exact date and start time for the reschedule.", results: [], ...internalState() };
        if (appointment && targetDoctorName && requestedTime && requestedDateIso) {
          if (appointment.status !== "confirmed") return { answer: "That appointment is no longer eligible for rescheduling. Please refresh your appointment list.", results: [], ...internalState() };
          let doctors;
          if (doctorNameContains(appointment.doctor?.name, targetDoctorName)) doctors = [appointment.doctor];
          else {
            const search = await executeTool({ name: "search_doctors", args: { name: targetDoctorName }, actor, database, applicationTimezone, paymentService });
            doctors = Array.isArray(search?.doctors) ? search.doctors : [];
            referenceContext.doctors = doctors;
            markReferenceFresh("doctors");
            if (doctors.length > 1) return { answer: `More than one doctor matches that name: ${doctors.map((doctor) => doctor.name).join(", ")}. Which doctor do you mean?`, results: [{ tool: "search_doctors", data: publicToolResult(search) }], ...internalState() };
            if (!doctors.length) return { answer: "I could not find an active doctor matching that name. Please check the doctor name.", results: [{ tool: "search_doctors", data: publicToolResult(search) }], ...internalState() };
          }
          const outcome = await prepareForExactTarget("reschedule", doctors[0], appointment);
          if (outcome.status === "prepared") {
            referenceContext.pending_action = undefined;
            return {
              answer: preparationReply("reschedule", successfulPreparation.slot),
              results: publicResults,
              ...(internalProposalEvidence ? { internalProposalEvidence } : {}),
              ...internalState(),
            };
          }
          const message = outcome.status === "unavailable" ? "That exact date and time is unavailable with the selected doctor. Please choose another time." : outcome.status === "ambiguous_slot" ? "More than one slot matches that exact time. Please clarify which slot you want." : "I could not prepare the rescheduling proposal. Please try again.";
          return { answer: message, results: [], ...internalState() };
        }
      }
      log("started");
      try {
        while (modelRounds < 4) {
          let completion;
          while (true) {
            if (modelRounds >= 4) break;
            modelRounds += 1;
            providerAttempts += 1;
            log("provider_request", undefined, providerAttempts);
            try {
              completion = await withDeadline(provider.generate({ messages: transcript, tools, systemInstruction: assistantContextInstruction, signal }), signal);
              break;
            } catch (error) {
              if (!signal.aborted && providerStatus(error) === 503 && providerRetries === 0 && modelRounds < 4) {
                const delayMs = retryDelayMs(error, providerRetries);
                const remainingMs = deadlineMs - (now() - started);
                // Leave enough time for the bounded provider HTTP attempt and a small deadline margin.
                const providerTimeoutMs = Number(provider.requestTimeoutMs) || 0;
                if (delayMs !== null && remainingMs > delayMs + providerTimeoutMs + 100) {
                  providerRetries += 1;
                  log("provider_retry", error, providerAttempts + 1, "provider_http_503");
                  if (await waitForRetry(delayMs, signal)) continue;
                }
              }
              if (!signal.aborted && (error?.name === "AbortError" || error?.name === "TimeoutError")) {
                log("provider_error", error, providerAttempts, "sdk_timeout");
                throw new AssistantError("ASSISTANT_SDK_TIMEOUT", 504, "The assistant provider request timed out. Please retry.", { category: "sdk_timeout", attempt: providerAttempts });
              }
              throw error;
            }
          }
          log("provider_response", undefined, providerAttempts);
          if (!completion || !Array.isArray(completion.toolCalls) || typeof completion.text !== "string") {
            throw new AssistantError("PROVIDER_INVALID_RESPONSE", 502, "The assistant could not produce a response. Please try again.");
          }
          if (completion.toolCalls.length === 0) {
            let answer = completion.text.trim();
            if (!answer) throw new AssistantError("PROVIDER_INVALID_RESPONSE", 502, "The assistant returned an empty response. Please try again.");
            if (unverifiedActionClaim(answer) && !successfulPreparation) {
              answer = "I have not prepared an appointment proposal or created a confirmation intent. Tell me the doctor and exact appointment time you want, or identify the appointment you want to reschedule.";
            } else if (successfulPreparation) {
              answer = preparationReply(successfulPreparation.action, successfulPreparation.slot);
            } else if (/\brefund|refunded|reimburse\b/i.test(currentUserText)) {
              answer = successfulRefundPreview
                ? refundPreviewReply(successfulRefundPreview)
                : "I can't determine a refund amount or processed status yet because I have not checked a specific appointment's payment record. Please identify the appointment by its doctor, date, and time.";
            }
            log("completed");
            return { answer: publicAssistantAnswer(answer), results: publicResults, ...internalState() };
          }
          if (completion.toolCalls.some((call) => typeof call.name !== "string" || !call.name || !call.arguments || typeof call.arguments !== "object" || Array.isArray(call.arguments))) {
            throw new AssistantError("INVALID_TOOL_CALL", 502, "The assistant could not safely process that request. Please rephrase it and try again.");
          }
          toolTurn += 1;
          const doctorSearchInBatch = completion.toolCalls.some((call) => call.name === "search_doctors");
          const namedDoctorSearchInBatch = completion.toolCalls.some((call) => call.name === "search_doctors" && typeof call.arguments.name === "string");
          transcript.push({
            role: "assistant",
            content: completion.text,
            toolCalls: completion.toolCalls,
            providerContent: completion.providerContent,
          });
          const results = [];
          let preparedActionForTurn = null;
          for (const call of completion.toolCalls) {
            try {
              const definition = getTool(call.name, actor);
              if (!definition || !definition.schema.safeParse(call.arguments).success) {
                results.push({ name: call.name, id: call.id, result: { error: "The tool name or arguments were not accepted. Recheck the returned records and ask for clarification." } });
                continue;
              }
              const cachedKey = toolCacheKey(call.name, call.arguments);
              if (executedToolResults.has(cachedKey)) {
                results.push({ name: call.name, id: call.id, result: publicToolResult(executedToolResults.get(cachedKey)) });
                continue;
              }
              if (call.name === "get_available_slots" && call.arguments.doctor_id) {
                const candidates = ambiguousDoctorIds.get(call.arguments.doctor_id);
                if (doctorSearchInBatch) {
                  results.push({ name: call.name, id: call.id, result: { error: "Resolve the doctor in a separate search turn before checking availability." } });
                  continue;
                }
                if (candidates) {
                  results.push({ name: call.name, id: call.id, result: { error: "Multiple doctors matched; ask the patient to clarify.", clarification_candidates: candidates } });
                  continue;
                }
                const patientAppointmentDoctor = [...ownedAppointments.values()].some((appointment) => appointment.doctor?.id === call.arguments.doctor_id
                  && appointmentResultTurns.get(appointment.appointment_id || appointment.id) < toolTurn
                  && requestedDoctorMatches(currentUserText, appointment.doctor?.name));
                if (!resolvedDoctorIds.has(call.arguments.doctor_id) && !patientAppointmentDoctor) {
                  results.push({ name: call.name, id: call.id, result: { error: "Search for and uniquely resolve this doctor before checking availability." } });
                  continue;
                }
              }
              if (call.name === "get_available_slots" && namedDoctorSearchInBatch) {
                results.push({ name: call.name, id: call.id, result: { error: "Resolve the named doctor in a separate search turn before checking availability." } });
                continue;
              }
              if (call.name === "get_available_slots" && namedDoctorSearch?.status === "ambiguous") {
                results.push({ name: call.name, id: call.id, result: { error: "Multiple doctors matched; ask the patient to clarify.", clarification_candidates: namedDoctorSearch.doctors } });
                continue;
              }
              if (call.name === "get_available_slots" && namedDoctorSearch?.status === "no_match") {
                results.push({ name: call.name, id: call.id, result: { error: "No doctor matched the name in the current request; do not search general availability." } });
                continue;
              }
              if (call.name === "get_available_slots" && requestedTime && !searchMatchesRequestedTarget({ args: call.arguments }, requestedTime, requestedDate)) {
                results.push({ name: call.name, id: call.id, result: { error: "Search the exact date and start time requested before preparing an action." } });
                continue;
              }
              const patientAppointmentDoctor = call.name === "get_available_slots" && [...ownedAppointments.values()].some((appointment) => appointment.doctor?.id === call.arguments.doctor_id
                && requestedDoctorMatches(currentUserText, appointment.doctor?.name));
              if (call.name === "get_available_slots" && currentRequestNamesDoctor && !namedDoctorSearch && !patientAppointmentDoctor) {
                results.push({ name: call.name, id: call.id, result: { error: "Search the named doctor in the current request before checking availability." } });
                continue;
              }
              if (call.name === "get_available_slots" && namedDoctorSearch?.status === "unique" && !patientAppointmentDoctor && !call.arguments.doctor_id) {
                results.push({ name: call.name, id: call.id, result: { error: "Use the uniquely matched doctor ID for this availability search." } });
                continue;
              }
              if (call.name === "get_available_slots" && namedDoctorSearch?.status === "unique" && !patientAppointmentDoctor && call.arguments.doctor_id !== namedDoctorSearch.doctors[0]?.id) {
                results.push({ name: call.name, id: call.id, result: { error: "Use the doctor ID returned by the current name search." } });
                continue;
              }
              if (call.name === "prepare_booking_action" || call.name === "prepare_reschedule_action") {
                const slotId = call.arguments.availability_id;
                const slot = availabilitySlots.get(slotId);
                const expectedAction = call.name === "prepare_booking_action" ? "book" : "reschedule";
                if (!slot || availabilityResultTurns.get(slotId) >= toolTurn) {
                  results.push({ name: call.name, id: call.id, result: { error: "First look up and select a specific available slot." } });
                  continue;
                }
                if (expectedAction === "book") {
                  const existing = await existingConfirmedAppointmentForSlot(slot.doctor_id || slot.doctor?.id, slot.date, slot.start_time);
                  if (existing.appointment) {
                    exactActionOutcome = "duplicate_booking";
                    exactActionCandidates = [existing.appointment];
                    continue;
                  }
                  if (existing.uncertain) {
                    exactActionOutcome = "duplicate_check_incomplete";
                    continue;
                  }
                }
                const slotSearch = availabilitySources.get(slotId);
                if (!slotSearch || (requestedTime && !searchMatchesRequestedTarget(slotSearch, requestedTime, requestedDate))) {
                  results.push({ name: call.name, id: call.id, result: { error: "The selected slot does not match the exact date and time requested. Ask the patient to choose or clarify." } });
                  continue;
                }
                if (requestedTime) {
                  const exactMatches = slotSearch.slots.filter((candidate) => candidate.date === slotSearch.args.from
                    && String(candidate.start_time).slice(0, 5) === requestedTime
                    && (!requestedEndTime || String(candidate.end_time).slice(0, 5) === requestedEndTime));
                  if (exactMatches.length !== 1 || (exactMatches[0].availability_id || exactMatches[0].id) !== slotId) {
                    results.push({ name: call.name, id: call.id, result: { error: "The exact requested time is unavailable or ambiguous. Ask the patient to choose another time." } });
                    continue;
                  }
                }
                if (expectedAction === "reschedule") {
                  const appointmentId = call.arguments.appointment_id;
                  const appointment = ownedAppointments.get(appointmentId);
                  if (!appointment || appointmentResultTurns.get(appointmentId) >= toolTurn) {
                    results.push({ name: call.name, id: call.id, result: { error: "First look up an existing appointment owned by this patient." } });
                    continue;
                  }
                  const appointmentSearch = appointmentSources.get(appointmentId);
                  if (!appointmentSearch || !appointmentSelectionIsUnambiguous(appointmentSearch.rows, appointmentId, currentUserText, requestedTimes, requestedDates, requestedTime, requestedDate)) {
                    results.push({ name: call.name, id: call.id, result: { error: "The appointment is ambiguous. Ask the patient which appointment they want to change." } });
                    continue;
                  }
                  if (requestedEndTime && String(slot.end_time).slice(0, 5) !== requestedEndTime) {
                    results.push({ name: call.name, id: call.id, result: { error: "The selected slot does not match the exact requested end time." } });
                    continue;
                  }
                if (requestedDateIso && (slot.date !== requestedDateIso || slotSearch.args.from !== requestedDateIso || slotSearch.args.to !== requestedDateIso)) {
                  results.push({ name: call.name, id: call.id, result: { error: "The selected target slot does not match the requested date." } });
                  continue;
                }
                  const targetDoctorName = requestedTargetDoctorName(currentUserText);
                  const verifiedSameDoctor = appointment.doctor?.id === slot.doctor_id
                    && slotSearch.args.doctor_id === appointment.doctor.id;
                  const verifiedCrossDoctor = Boolean(targetDoctorName
                    && namedDoctorSearch?.status === "unique"
                    && namedDoctorSearch.doctors[0]?.id === slot.doctor_id
                    && slotSearch.args.doctor_id === slot.doctor_id
                    && doctorNameContains(namedDoctorSearch.doctors[0]?.name, targetDoctorName));
                  if (!verifiedSameDoctor && !verifiedCrossDoctor) {
                    results.push({ name: call.name, id: call.id, result: { error: "The target doctor and availability must be independently verified before rescheduling." } });
                    continue;
                  }
                }
              }
              if (call.name === "prepare_cancellation_action") {
                const appointmentId = call.arguments.appointment_id;
                const appointment = ownedAppointments.get(appointmentId);
                const appointmentSearch = appointmentSources.get(appointmentId);
                if (!cancellationRequest || !appointment || appointmentResultTurns.get(appointmentId) >= toolTurn || !appointmentSearch || !appointmentSelectionIsUnambiguous(appointmentSearch.rows, appointmentId, currentUserText, requestedTimes, requestedDates, undefined, undefined)) {
                  results.push({ name: call.name, id: call.id, result: { error: "First identify one specific appointment owned by this patient." } });
                  continue;
                }
              }
              if (call.name === "get_cancellation_refund_preview") {
                const appointmentId = call.arguments.appointment_id;
                if (!ownedAppointments.has(appointmentId) || appointmentResultTurns.get(appointmentId) >= toolTurn) {
                  results.push({ name: call.name, id: call.id, result: { error: "First look up the specific appointment in the authenticated patient's appointment list." } });
                  continue;
                }
              }
              log("tool_execution");
              if (call.name === "search_doctors" && call.arguments?.name) namedDoctorSearch = { status: "pending", doctors: [] };
              const result = await executeTool({
                name: call.name,
                args: call.arguments,
                actor,
                database,
                applicationTimezone,
                paymentService,
                ...(call.name === "get_patient_appointments" && (cancellationRequest || appointmentListRequest) ? { appointmentScopeOverride: "all" } : {}),
              });
              if (call.name === "search_doctors" && Array.isArray(result?.doctors)) {
                referenceContext.doctors = result.doctors;
                markReferenceFresh("doctors");
                if (call.arguments?.name) namedDoctorSearch = { status: result.doctors.length === 0 ? "no_match" : result.doctors.length > 1 ? "ambiguous" : "unique", doctors: result.doctors };
                if (result.doctors.length === 1) {
                  resolvedDoctorIds.add(result.doctors[0].id);
                  ambiguousDoctorIds.delete(result.doctors[0].id);
                } else if (result.doctors.length > 1) {
                  for (const doctor of result.doctors) ambiguousDoctorIds.set(doctor.id, result.doctors);
                }
              }
              if (call.name === "get_patient_appointments" && Array.isArray(result?.appointments)) {
                const rows = result.appointments;
                referenceContext.appointments = rows;
                markReferenceFresh("appointments");
                const source = { turn: toolTurn, rows };
                latestAppointmentSearch = source;
                for (const appointment of rows) {
                  const id = appointment.appointment_id || appointment.id;
                  if (id) { ownedAppointments.set(id, appointment); appointmentResultTurns.set(id, toolTurn); appointmentSources.set(id, source); }
                }
                if (cancellationRequest) {
                  const matches = matchingAppointments(rows, currentUserText, requestedTimes, requestedDates, undefined, undefined);
                  if (matches.length === 1) {
                    const appointment = matches[0];
                    const appointmentId = appointment.appointment_id || appointment.id;
                    const args = { appointment_id: appointmentId };
                    const proposal = await executeTool({ name: "prepare_cancellation_action", args, actor, database, applicationTimezone, paymentService });
                    if (isSuccessfulProposal("prepare_cancellation_action", args, proposal)) {
                      const result = { ...proposal, persisted_intent_created: false };
                      publicResults.push({ tool: "prepare_cancellation_action", data: publicToolResult(result) });
                      successfulPreparation = { action: "cancel", slot: appointment };
                      preparedActionForTurn = "cancel";
                      internalProposalEvidence = verifiedProposalEvidence("cancel", args, actor, appointment, null);
                    } else exactActionOutcome = "prepare_failed";
                  } else {
                    exactActionOutcome = matches.length > 1 ? "appointment_ambiguous" : "appointment_not_found";
                    exactActionCandidates = matches;
                  }
                }
                if (actionRequest === "reschedule") {
                  const sourceMatches = matchingAppointments(rows, currentUserText, requestedTimes, requestedDates, requestedTime, requestedDate)
                    .filter((appointment) => appointment.status === "confirmed");
                  if (sourceMatches.length === 1) referenceContext.pending_appointment_id = sourceMatches[0].appointment_id || sourceMatches[0].id;
                  else if (rows.filter((appointment) => appointment.status === "confirmed").length === 1 && requestedDates.length === 0 && requestedTimes.length === 0) {
                    referenceContext.pending_appointment_id = rows.find((appointment) => appointment.status === "confirmed").appointment_id || rows.find((appointment) => appointment.status === "confirmed").id;
                  }
                }
                if (actionRequest === "reschedule" && requestedTime && requestedDateIso) {
                  const matches = matchingAppointments(rows, currentUserText, requestedTimes, requestedDates, requestedTime, requestedDate);
                  if (matches.length !== 1) {
                    exactActionOutcome = "appointment_ambiguous";
                  } else if (!matches[0].doctor?.id) {
                    exactActionOutcome = "appointment_ambiguous";
                  } else {
                    const sourceAppointment = matches[0];
                    const targetName = requestedTargetDoctorName(currentUserText);
                    if (targetName && !doctorNameContains(sourceAppointment.doctor.name, targetName)) {
                      // Preserve the patient-scoped source result for Gemini, then require
                      // a separate target-doctor search and availability result before prepare.
                      exactActionOutcome = null;
                    } else {
                      const outcome = await prepareForExactTarget("reschedule", sourceAppointment.doctor, sourceAppointment);
                      exactActionOutcome = outcome.status === "prepared" ? null : outcome.status;
                      if (outcome.status === "prepared") preparedActionForTurn = "reschedule";
                    }
                  }
                }
              }
              if (call.name === "search_doctors" && Array.isArray(result?.doctors) && actionRequest === "book"
                  && requestedTime && requestedDateIso && currentRequestNamesDoctor && result.doctors.length === 1
                  && requestedDoctorMatches(currentUserText, result.doctors[0].name)) {
                const outcome = await prepareForExactTarget("book", result.doctors[0]);
                exactActionOutcome = outcome.status === "prepared" ? null : outcome.status;
                if (outcome.status === "prepared") preparedActionForTurn = "book";
              }
              if (call.name === "get_available_slots" && Array.isArray(result?.slots)) {
                referenceContext.slots = result.slots;
                markReferenceFresh("slots");
                referenceContext.slot_query = call.arguments;
                if (actionRequest === "book" || actionRequest === "reschedule") referenceContext.pending_action = actionRequest;
                const source = { turn: toolTurn, args: call.arguments, slots: result.slots };
                for (const slot of result.slots) {
                  const id = slot.availability_id || slot.id;
                  if (id) { availabilitySlots.set(id, slot); availabilityResultTurns.set(id, toolTurn); availabilitySources.set(id, source); }
                }
                const exactRequest = Boolean(actionRequest && requestedTime && requestedDate
                  && searchMatchesRequestedTarget(source, requestedTime, requestedDate));
                const exactMatches = exactRequest ? result.slots.filter((slot) => slot.date === source.args.from
                  && String(slot.start_time).slice(0, 5) === requestedTime
                  && (!requestedEndTime || String(slot.end_time).slice(0, 5) === requestedEndTime)) : [];
                if (exactRequest && actionRequest === "book" && exactMatches.length === 0 && call.arguments.doctor_id) {
                  const existing = await existingConfirmedAppointmentForSlot(call.arguments.doctor_id, requestedDateIso, requestedTime);
                  if (existing.appointment) {
                    exactActionOutcome = "duplicate_booking";
                    exactActionCandidates = [existing.appointment];
                  } else if (existing.uncertain) exactActionOutcome = "duplicate_check_incomplete";
                }
                if (exactMatches.length === 1 && (exactMatches[0].availability_id || exactMatches[0].id)) {
                  const selectedSlot = exactMatches[0];
                  let prepareArgs;
                  let crossDoctorNeedsModelPreparation = false;
                  if (actionRequest === "book" && namedDoctorSearch?.status === "unique"
                      && namedDoctorSearch.doctors[0]?.id === selectedSlot.doctor_id) {
                    prepareArgs = { availability_id: selectedSlot.availability_id || selectedSlot.id };
                  } else if (actionRequest === "reschedule" && latestAppointmentSearch) {
                    const matches = matchingAppointments(latestAppointmentSearch.rows, currentUserText, requestedTimes, requestedDates, requestedTime, requestedDate);
                    const appointment = matches.length === 1 ? matches[0] : null;
                    const targetName = requestedTargetDoctorName(currentUserText);
                    const selectedDoctor = namedDoctorSearch?.status === "unique" && namedDoctorSearch.doctors[0]?.id === selectedSlot.doctor_id
                      ? namedDoctorSearch.doctors[0] : referenceContext.doctors.find((doctor) => doctor.id === selectedSlot.doctor_id);
                    const sameDoctorTarget = !targetName && appointment?.doctor?.id === selectedSlot.doctor_id && source.args.doctor_id === appointment.doctor.id;
                    const explicitTarget = targetName && selectedDoctor && doctorNameContains(selectedDoctor.name, targetName);
                    if (appointment && (sameDoctorTarget || explicitTarget)) {
                      prepareArgs = { appointment_id: appointment.appointment_id || appointment.id, availability_id: selectedSlot.availability_id || selectedSlot.id };
                      crossDoctorNeedsModelPreparation = Boolean(explicitTarget && appointment.doctor?.id !== selectedSlot.doctor_id);
                    }
                  }
                if (prepareArgs && !crossDoctorNeedsModelPreparation) {
                    const actionTool = actionRequest === "book" ? "prepare_booking_action" : "prepare_reschedule_action";
                    const proposal = await executeTool({ name: actionTool, args: prepareArgs, actor, database, applicationTimezone, paymentService });
                    if (isSuccessfulProposal(actionTool, prepareArgs, proposal)) {
                      const resultWithIntentState = { ...proposal, persisted_intent_created: false };
                      publicResults.push({ tool: actionTool, data: publicToolResult(resultWithIntentState) });
                      preparedActionForTurn = actionRequest;
                      successfulPreparation = { action: actionRequest, slot: selectedSlot };
                      internalProposalEvidence = verifiedProposalEvidence(
                        actionRequest,
                        prepareArgs,
                        actor,
                        actionRequest === "reschedule" ? appointment : null,
                        selectedSlot,
                      );
                    }
                  }
                }
              }
              if (preparationTypeForTool(call.name) && isSuccessfulProposal(call.name, call.arguments, result)) {
                const actionType = preparationTypeForTool(call.name);
                const normalizedArgs = definition.schema.parse(call.arguments);
                const appointment = actionType === "cancel" || actionType === "reschedule"
                  ? ownedAppointments.get(normalizedArgs.appointment_id) : null;
                const slot = actionType === "book" || actionType === "reschedule"
                  ? availabilitySlots.get(normalizedArgs.availability_id) : null;
                const evidence = verifiedProposalEvidence(actionType, normalizedArgs, actor, appointment, slot);
                if (evidence) {
                  result.persisted_intent_created = false;
                  successfulPreparation = { action: actionType, slot: actionType === "cancel" ? appointment : slot };
                  internalProposalEvidence = evidence;
                  preparedActionForTurn = actionType;
                } else {
                  result.error = "The prepared proposal could not be bound to verified patient records.";
                }
              }
              if (call.name === "get_cancellation_refund_preview" && result && !result.error) successfulRefundPreview = result;
              const uiActions = patientUiActions(call.name, result);
              publicResults.push({ tool: call.name, data: publicToolResult(result), ...(uiActions.length ? { ui_actions: uiActions } : {}) });
              results.push({ name: call.name, id: call.id, result: publicToolResult(result) });
            } catch (error) {
              if (signal.aborted) throw error;
              results.push({ name: call.name, id: call.id, result: { error: error.code === "INVALID_TOOL_ARGUMENTS" ? "The lookup arguments were invalid. Ask the patient to clarify." : error.code === "TOOL_LIMIT_EXCEEDED" ? "The lookup budget was reached. Use the verified results already returned and ask the patient to narrow any remaining request." : "The requested data could not be loaded." } });
            }
          }
          transcript.push({ role: "user", toolResults: results });
          if (preparedActionForTurn) {
            if (successfulPreparation) {
              const actionTool = preparedActionForTurn === "book" ? "prepare_booking_action" : preparedActionForTurn === "reschedule" ? "prepare_reschedule_action" : "prepare_cancellation_action";
              for (let index = publicResults.length - 1; index >= 0; index -= 1) {
                if (publicResults[index].tool !== actionTool) publicResults.splice(index, 1);
              }
              if (!publicResults.some(({ tool }) => tool === actionTool)) {
                const proposalResult = results.find(({ name }) => name === actionTool)?.result;
                if (proposalResult) publicResults.push({ tool: actionTool, data: publicToolResult({ ...proposalResult, persisted_intent_created: false }) });
              }
              const internalActionContext = privateCancellationContext(successfulPreparation);
              return {
                answer: preparationReply(successfulPreparation.action, successfulPreparation.slot),
                results: publicResults,
                ...(internalActionContext ? { internalActionContext } : {}),
                ...(internalProposalEvidence ? { internalProposalEvidence } : {}),
              };
            }
          }
          if (exactActionOutcome) {
            const answer = exactActionOutcome === "duplicate_booking"
              ? alreadyBookedReply(exactActionCandidates[0], exactActionCandidates[0]?.doctor?.name)
              : exactActionOutcome === "duplicate_check_incomplete"
                ? "I couldn't verify your existing appointments, so I haven't prepared a duplicate booking. Please try again in a moment."
              : exactActionOutcome === "unavailable"
              ? "That exact date and time is not available. Please choose another time."
              : exactActionOutcome === "ambiguous_slot"
                ? "More than one slot matches that exact date and time. Please clarify which option you want."
                : exactActionOutcome === "appointment_ambiguous"
                  ? exactActionCandidates.length
                    ? (meridiemClarification(exactActionCandidates, requestedTimes)
                      || `I found multiple matching appointments: ${exactActionCandidates.map(appointmentChoiceDescription).join("; ")}. Please choose which appointment you mean.`)
                    : "I could not identify one specific appointment to change. Please choose or clarify the existing appointment."
                  : exactActionOutcome === "appointment_not_found"
                    ? "I could not find a matching appointment in your appointments. Please check the doctor, date, and time."
                    : exactActionOutcome === "doctor_ambiguous"
                      ? `More than one target doctor matches. Please choose one: ${exactActionCandidates.map((doctor) => doctor.name).join(", ")}.`
                      : exactActionOutcome === "doctor_not_found"
                        ? "I could not find an active doctor matching the requested target. Please check the doctor's name."
                  : "I could not prepare that appointment proposal. Please try again or choose another time.";
            return { answer, results: [], ...internalState() };
          }
        }
        if (publicResults.length) {
          return { answer: "I could not complete every lookup within the request limit. The results below are the records I verified; please narrow the remaining request to continue.", results: publicResults, ...internalState() };
        }
        throw new AssistantError("TOOL_LIMIT_EXCEEDED", 502, "The assistant could not complete this lookup. Please try again.");
      } catch (error) {
        if (publicResults.length) {
          const answer = successfulRefundPreview
            ? refundPreviewReply(successfulRefundPreview)
            : "I checked the verified records shown below, but the assistant could not finish the rest of the request. You can retry or narrow the remaining question.";
          return { answer, results: publicResults, ...internalState() };
        }
        if (error instanceof AssistantError) {
          if (!Number.isFinite(error.attempt)) error.attempt = providerAttempts;
          if (!error.category) error.category = error.code;
          throw error;
        }
        if (signal.aborted) {
          log("execution_deadline", error, providerAttempts, "application_deadline");
          throw new AssistantError("ASSISTANT_TIMEOUT", 504, "The assistant took too long to respond. Please try again.", { category: "application_deadline", attempt: providerAttempts });
        }
        const status = providerStatus(error);
        const category = error?.category || (status ? `provider_http_${status}` : "provider_error");
        log("provider_error", error, providerAttempts, category);
        if (status === 429 && category === "provider_daily_quota_exceeded") throw new AssistantError("ASSISTANT_DAILY_QUOTA_EXCEEDED", 503, "The AI assistant has reached its current usage limit. Please try again later.", { category, providerStatus: status, attempt: providerAttempts });
        if (status === 429) throw new AssistantError("ASSISTANT_PROVIDER_RATE_LIMITED", 503, "The AI assistant is receiving too many requests. Please wait a moment and try again.", { category, providerStatus: status, attempt: providerAttempts });
        if (status === 401 || status === 403) throw new AssistantError("ASSISTANT_CONFIGURATION_ERROR", 503, "The assistant is temporarily unavailable. Please try again shortly.", { category, providerStatus: status, attempt: providerAttempts });
        if (status === 503) throw new AssistantError("ASSISTANT_PROVIDER_UNAVAILABLE", 503, "The AI assistant is temporarily unavailable. Please try again shortly.", { category, providerStatus: status, attempt: providerAttempts });
        if (status === 504) throw new AssistantError("ASSISTANT_PROVIDER_GATEWAY_TIMEOUT", 504, "The assistant provider gateway timed out. Please retry.", { category, providerStatus: status, attempt: providerAttempts });
        throw new AssistantError("ASSISTANT_UNAVAILABLE", 503, "The assistant is temporarily unavailable. Please try again shortly.", { category, providerStatus: status || undefined, attempt: providerAttempts });
      }
    },
  };
}

module.exports = { AssistantError, createConversationEngine, pairedTimeCandidates, patientUiActions, publicToolResult, selectedAppointmentTimes, timeRangeTarget, timeReferences };
