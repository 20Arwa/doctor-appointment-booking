const { isCancellationRequest, recognizeCanonicalIntent } = require("./intentModel");
const { getTool } = require("./toolRegistry");
const { dateReferenceMatches, dateReferences, hasContradictoryMeridiem, pairedTimeCandidates, partialCalendarDate, resolveDateReference, selectedAppointmentTimes, timeRangeTarget, timeReferences } = require("./temporalInterpretation");
const BOOKING_CONTEXT_VERSION = 1;

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
  if (rows.length === 1 && /\b(?:cancel|reschedule|move|change|book|choose|select)\b[\s\S]{0,30}\b(?:it|this one|that one)\b/i.test(text)) return { row: rows[0] };
  if (rows.length > 1 && /\b(?:cancel|reschedule|move|change)\b[\s\S]{0,30}\b(?:it|this one|that one)\b/i.test(text)) return { ambiguous: true };
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

function displayedSlotSelection(text, slots, requestedTimes, requestedDate) {
  if (!Array.isArray(slots) || !slots.length) return null;
  const numbered = slotChoice(text, slots);
  if (numbered?.length) return numbered.length === 1 ? { row: numbered[0] } : { ambiguous: true };
  const reference = contextualReference(text, slots, "slot|availability option");
  if (reference?.row || reference?.ambiguous) return reference;
  if (requestedTimes.length === 1) {
    const matches = slots.filter((slot) => requestedTimes[0].candidates.includes(String(slot.start_time || "").slice(0, 5))
      && (!requestedDate || slot.date === requestedDate));
    if (matches.length === 1) return { row: matches[0] };
    if (matches.length > 1) return { ambiguous: true };
  }
  const asksToSelect = /\b(?:book|choose|select|take|want)\b/i.test(text)
    && /\b(?:slot|time|appointment|this|that|it)\b/i.test(text);
  if (requestedDate && asksToSelect) {
    const dateMatches = slots.filter((slot) => slot.date === requestedDate);
    if (dateMatches.length === 1) return { row: dateMatches[0] };
    if (dateMatches.length > 1) return { ambiguous: true };
  }
  if (slots.length === 1 && asksToSelect && /\b(?:this|that|it|slot|time)\b/i.test(text)) return { row: slots[0] };
  return null;
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

function displayableTime(value) {
  const [hourText, minute = "00"] = String(value || "").slice(0, 5).split(":");
  const hour = Number(hourText);
  return Number.isInteger(hour) ? `${hour % 12 || 12}:${minute} ${hour >= 12 ? "PM" : "AM"}` : String(value || "");
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
  return String(text || "").match(/\bDr\.?\s*([\p{L}][\p{L}'-]*(?:\s+(?!on\b|for\b|at\b|appointment\b|booking\b|date\b|time\b|available\b|availability\b|slot\b|slots\b|to\b|with\b|jan(?:uary)?\b|feb(?:ruary)?\b|mar(?:ch)?\b|apr(?:il)?\b|may\b|jun(?:e)?\b|jul(?:y)?\b|aug(?:ust)?\b|sep(?:tember)?\b|oct(?:ober)?\b|nov(?:ember)?\b|dec(?:ember)?\b)[\p{L}][\p{L}'-]*)?)/iu)?.[1]?.trim() || null;
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
    async respond({ actor, conversationId = "unknown", messages, database, applicationTimezone, paymentService, previousActionContext, previousProposal, previousReferences, tools = [], systemInstruction = "", requestId = "unknown", logger: requestLogger = logger }) {
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
        ...(referenceIsFresh("slots") && previousReferences?.slot_query && typeof previousReferences.slot_query === "object" ? { slot_query: previousReferences.slot_query } : {}),
        ...(previousReferences?.pending_action === "cancel" ? { pending_action: "cancel" }
          : (referenceIsFresh("slots") || referenceIsFresh("appointments") || previousReferences?.pending_action === "book" && referenceIsFresh("doctors"))
            && (previousReferences?.pending_action === "book" || previousReferences?.pending_action === "reschedule") ? { pending_action: previousReferences.pending_action } : {}),
        ...(referenceIsFresh("appointments") && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(previousReferences?.pending_appointment_id || "") ? { pending_appointment_id: previousReferences.pending_appointment_id } : {}),
        ...(typeof previousReferences?.pending_target_date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(previousReferences.pending_target_date) ? { pending_target_date: previousReferences.pending_target_date } : {}),
        ...(referenceIsFresh("slots") && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(previousReferences?.pending_slot_id || "") ? { pending_slot_id: previousReferences.pending_slot_id } : {}),
        ...(previousReferences?.pending_response === "date_time" || previousReferences?.pending_response === "slot_choice" || previousReferences?.pending_response === "slot_confirmation" ? { pending_response: previousReferences.pending_response } : {}),
        ...(typeof previousReferences?.last_assistant_question === "string" ? { last_assistant_question: previousReferences.last_assistant_question.slice(0, 500) } : {}),
        ...(referenceIsFresh("appointments") && previousReferences?.history_page && typeof previousReferences.history_page === "object" ? { history_page: previousReferences.history_page } : {}),
      };
      // Booking intent and the verified doctor/date survive independently of
      // the short lifetime of availability results.
      let bookingContext = previousReferences?.booking_context?.version === 1
        && previousReferences.booking_context.stage && previousReferences.booking_context.doctor?.id
        ? { ...previousReferences.booking_context, doctor: { ...previousReferences.booking_context.doctor }, displayed_slots: [...(previousReferences.booking_context.displayed_slots || [])] }
        : null;
      let rescheduleContext = previousReferences?.reschedule_context?.version === 1
        ? { ...previousReferences.reschedule_context }
        : null;
      if (rescheduleContext) {
        referenceContext.pending_action = "reschedule";
        referenceContext.pending_target_date = rescheduleContext.target_date;
        referenceContext.pending_appointment_id = rescheduleContext.selected_appointment_id;
      }
      if (bookingContext) {
        referenceContext.pending_action = "book";
        referenceContext.pending_target_date = bookingContext.requested_date || undefined;
        referenceContext.pending_response = ({ awaiting_date_time: "date_time", awaiting_slot_choice: "slot_choice", awaiting_slot_confirmation: "slot_confirmation" })[bookingContext.stage];
        referenceContext.last_assistant_question = bookingContext.pending_question;
        referenceContext.doctors = [bookingContext.doctor];
      } else if (previousReferences?.pending_action === "book" && referenceContext.doctors.length === 1) {
        bookingContext = {
          version: 1, stage: previousReferences.pending_response === "slot_choice" ? "awaiting_slot_choice" : "awaiting_date_time",
          doctor: referenceContext.doctors[0], requested_date: referenceContext.pending_target_date || null,
          displayed_slots: referenceContext.slots.map((slot) => ({ slot_id: slot.availability_id || slot.id, date: slot.date, start_time: slot.start_time, end_time: slot.end_time })).filter((slot) => slot.slot_id && slot.date),
          selected_slot_id: referenceContext.pending_slot_id || null,
          pending_question: referenceContext.last_assistant_question || null,
        };
      }
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
      if (referenceContext.pending_slot_id && !referenceContext.slots.some((slot) => (slot.availability_id || slot.id) === referenceContext.pending_slot_id)) {
        delete referenceContext.pending_slot_id;
        if (referenceContext.pending_response === "slot_confirmation") delete referenceContext.pending_response;
      }
      for (const doctor of referenceContext.doctors) if (doctor.id) resolvedDoctorIds.add(doctor.id);
      let namedDoctorSearch = null;
      const currentUserText = [...messages].reverse().find((message) => message.role === "user")?.content || "";
      const explicitSlotCommand = /^(?:book|reschedule\s+my\s+appointment\s+to)\s+(?:the\s+)?slot\s+(?:number\s+)?\d{1,2}$/i.test(currentUserText.trim());
      const bookThisAppointment = /(?:book|select|choose)/i.test(currentUserText) && /(?:it|this|that)/i.test(currentUserText);
      const currentRequestNamesDoctor = Boolean(requestedDoctorName(currentUserText));
      const requestedTimes = timeReferences(currentUserText);
      const requestedDates = dateReferences(currentUserText);
      const requestedDate = requestedDates.at(-1);
      const resolvedRequestedDateIso = resolveDateReference(requestedDate, applicationTimezone, now());
      const preservedBookingDate = bookingContext?.requested_date
        || (previousReferences?.pending_action === "book" && /^\d{4}-\d{2}-\d{2}$/.test(previousReferences?.pending_target_date || "") ? previousReferences.pending_target_date : null);
      const requestedDateIso = resolvedRequestedDateIso || preservedBookingDate;
      const canonicalIntent = recognizeCanonicalIntent(currentUserText, applicationTimezone, now());
      if (/\b(?:i said|i meant|no,?\s*i said|correction)\b/i.test(currentUserText)) {
        const correctedDate = dateReferences(currentUserText).map((reference) => resolveDateReference(reference, applicationTimezone, now())).find(Boolean);
        if (correctedDate && referenceContext.history_page?.query) {
          canonicalIntent.category = "appointment_history";
          canonicalIntent.historyQuery = { view: "date", scope: "all", from: correctedDate, to: correctedDate };
          canonicalIntent.historyScope = "all_upcoming";
        }
      }
      const refundStatusRequest = canonicalIntent.category === "refund_preview"
        && /\b(?:refund|refunded|refund status|refunds?)\b/i.test(currentUserText)
        && /\b(?:status|processed|pending|received|arrived|where|when|did|has)\b/i.test(currentUserText)
        && !/\b(?:expect|estimate|estimated|if i cancel|cancellation preview)\b/i.test(currentUserText);
      let actionRequest = ({ booking: "book", rescheduling: "reschedule" })[canonicalIntent.category] || null;
      const doctorSearchTopicChange = canonicalIntent.category === "doctor_search"
        && (bookingContext && currentRequestNamesDoctor && !doctorNameContains(bookingContext.doctor.name, requestedDoctorName(currentUserText))
          || !requestedDates.length && !requestedTimes.length && /\b(?:find|search|show me|list)\b[\s\S]{0,30}\b(?:doctor|physician)s?\b/i.test(currentUserText));
      const explicitTopicChange = ["appointment_history", "cancellation", "rescheduling", "refund_preview", "payment_history"].includes(canonicalIntent.category)
        || doctorSearchTopicChange || /\b(?:different question|new topic|ask about something else)\b/i.test(currentUserText);
      if (rescheduleContext && explicitTopicChange && canonicalIntent.category !== "rescheduling") {
        rescheduleContext = null;
        if (referenceContext.pending_action === "reschedule") {
          referenceContext.pending_action = undefined;
          referenceContext.pending_target_date = undefined;
          referenceContext.pending_appointment_id = undefined;
        }
      }
      if (!actionRequest && bookingContext && !explicitTopicChange
        && !/\b(?:start over|new topic|forget (?:this|that) booking|cancel this booking request)\b/i.test(currentUserText)) actionRequest = "book";
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
        if (calls >= 4) {
          const error = new AssistantError("TOOL_LIMIT_EXCEEDED", 502, "I checked the available records, but this request needs another lookup to finish. Please narrow the request and try again.");
          log("tool_execution", error, 0, error.code, input.name, "limit");
          throw error;
        }
        calls += 1;
        log("tool_execution", undefined, 0, undefined, input.name, "started");
        try {
          const result = await withDeadline(toolExecutor(input), signal);
          executedToolResults.set(key, result);
          log("tool_execution", undefined, 0, undefined, input.name, "completed");
          return result;
        } catch (error) {
          log("tool_execution", error, 0, error?.code || error?.category || "tool_failure", input.name, "failed");
          throw error;
        }
      };
      const internalState = () => {
        if (referenceContext.pending_action === "book" && referenceContext.doctors.length === 1) {
          const stage = referenceContext.pending_response === "slot_confirmation" ? "awaiting_slot_confirmation"
            : referenceContext.pending_response === "slot_choice" ? "awaiting_slot_choice" : "awaiting_date_time";
          const activeDate = referenceContext.pending_target_date || bookingContext?.requested_date || null;
          if (bookingContext?.requested_date && activeDate && bookingContext.requested_date !== activeDate) bookingContext.displayed_slots = [];
          const freshSlots = referenceContext.slots.map((slot) => ({ slot_id: slot.availability_id || slot.id, date: slot.date, start_time: slot.start_time, end_time: slot.end_time }))
            .filter((slot) => slot.slot_id && slot.date === activeDate);
          if (freshSlots.length) bookingContext = { ...(bookingContext || {}), displayed_slots: freshSlots };
          bookingContext = {
            version: 1, stage, doctor: referenceContext.doctors[0], requested_date: activeDate,
            displayed_slots: bookingContext?.displayed_slots?.filter((slot) => slot.date === activeDate) || [],
            selected_slot_id: referenceContext.pending_slot_id || null,
            pending_question: referenceContext.last_assistant_question || null,
          };
        } else if (bookingContext && referenceContext.pending_action !== "book") {
          bookingContext = null;
        }
        const appointmentsForPersistence = referenceContext.pending_action === "cancel"
          && !referenceIsFresh("appointments") && !referenceContext.appointments.length
            ? cancellationChoices : referenceContext.appointments;
        return {
          ...(appointmentsForPersistence.length || cancellationChoices.length || referenceContext.slots.length || referenceContext.doctors.length || referenceContext.pending_action || referenceContext.pending_appointment_id || referenceContext.pending_target_date || referenceContext.slot_query || referenceContext.pending_slot_id || referenceContext.pending_response || Object.values(referenceTimestamps).some(Boolean) || bookingContext || rescheduleContext || previousReferences?.booking_context
            ? { internalReferences: { ...referenceContext, appointments: appointmentsForPersistence, ...(cancellationChoices.length ? { cancellation_choices: cancellationChoices, cancellation_choices_at: cancellationChoicesAt } : {}), booking_context: bookingContext, reschedule_context: rescheduleContext, version: 1, reference_timestamps: referenceTimestamps } } : {}),
        };
      };
      const markReferenceFresh = (kind) => { referenceTimestamps[kind] = new Date(now()).toISOString(); };
      const setAssistantQuestion = (answer, expectedResponse, slot) => {
        referenceContext.last_assistant_question = answer.slice(0, 500);
        referenceContext.pending_response = expectedResponse;
        if (slot) referenceContext.pending_slot_id = slot.availability_id || slot.id;
        else if (expectedResponse !== "slot_confirmation") delete referenceContext.pending_slot_id;
      };
      const clearAssistantQuestion = () => {
        delete referenceContext.pending_response;
        delete referenceContext.pending_slot_id;
        delete referenceContext.last_assistant_question;
      };
      const affirmativeReply = /^\s*(?:yes|yeah|yep|yup|okay|ok|sure|please do|go ahead)\b/i.test(currentUserText);
      const cancelBookingFlow = actor.role === "patient" && bookingContext
        && /\b(?:stop|cancel|forget)\s+(?:this|that|the)\s+(?:booking|appointment booking)(?:\s+(?:request|flow))?\b/i.test(currentUserText);
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
      const log = (stage, error, attempt = 0, category, toolName, executionStage, providerMetadata) => {
        const status = Number(error?.providerStatus || error?.status || error?.statusCode || 0);
        const errorCategory = category || error?.category || (status ? `provider_http_${status}` : undefined);
        requestLogger?.info?.(stage, { requestId, conversationId, stateVersion: BOOKING_CONTEXT_VERSION, attempt, elapsedMs: now() - started,
          ...(toolName ? { toolName } : {}), ...(executionStage ? { executionStage } : {}),
          ...(errorCategory ? { category: errorCategory } : {}), ...(status ? { providerStatus: status } : {}),
          ...(typeof providerMetadata?.finishReason === "string" ? { finishReason: providerMetadata.finishReason.slice(0, 40) } : {}),
          ...(Array.isArray(providerMetadata?.outputPartTypes) ? { outputPartTypes: providerMetadata.outputPartTypes.slice(0, 8).map((type) => ["text", "function_call"].includes(type) ? type : "other") } : {}),
          ...(typeof providerMetadata?.hasFinalText === "boolean" ? { hasFinalText: providerMetadata.hasFinalText } : {}),
          ...(Number.isInteger(providerMetadata?.finalTextLength) ? { finalTextLength: providerMetadata.finalTextLength } : {}),
          ...(Number.isInteger(providerMetadata?.pendingToolCalls) ? { pendingToolCalls: providerMetadata.pendingToolCalls } : {}),
          ...(Number.isInteger(providerMetadata?.responseStatus) ? { responseStatus: providerMetadata.responseStatus } : {}),
          ...(typeof providerMetadata?.blockReason === "string" ? { blockReason: providerMetadata.blockReason.slice(0, 40) } : {}) });
      };
      const invalidDate = requestedDates.some((reference) => !resolveDateReference(reference, applicationTimezone, now()));
      const bookingTemporalIntent = actionRequest === "book" || canonicalIntent.category === "availability"
        || Boolean(bookingContext);
      if (hasContradictoryMeridiem(currentUserText)) {
        return { answer: "I heard conflicting AM and PM markers. Which single time did you mean?", results: [], ...internalState() };
      }
      if (invalidDate) {
        return { answer: "I couldn't resolve that calendar date. Please provide a valid date, including its year.", results: [], ...internalState() };
      }
      if (actor.role === "patient" && bookingTemporalIntent && targetTime?.start?.candidates?.length > 1) {
        const [first, second] = targetTime.start.candidates;
        const label = (value) => { const hour = Number(value.slice(0, 2)); return `${hour % 12 || 12}:${value.slice(3, 5)} ${hour >= 12 ? "PM" : "AM"}`; };
        return { answer: `Did you mean ${label(first)} or ${label(second)}? Please specify AM or PM.`, results: [], ...internalState() };
      }
      if (actor.role === "patient" && previousProposal?.action_type === "cancel" && rejectsCancellationProposal(currentUserText)) {
        return {
          answer: "Understood. I dismissed the cancellation proposal and won't prepare it again.",
          results: [],
          dismissProposal: { assistant_message_id: previousProposal.assistant_message_id, action_type: "cancel" },
          ...internalState(),
        };
      }
      if (cancelBookingFlow) {
        referenceContext.pending_action = undefined;
        referenceContext.pending_target_date = undefined;
        referenceContext.slots = [];
        delete referenceContext.slot_query;
        clearAssistantQuestion();
        return { answer: "Understood. I stopped this booking request. No appointment was booked.", results: [], ...internalState() };
      }
      if (actor.role === "patient" && previousProposal?.action_type === "book"
          && (affirmativeReply || requestedDates.length > 0 || requestedTimes.length > 0
            || /\b(?:slot|appointment|booking|book this|book that)\b/i.test(currentUserText))) {
        return {
          answer: "Your booking proposal is ready. Please use the in-app confirmation control to confirm it; replying yes or okay does not book the appointment. To choose a different time, dismiss this proposal first.",
          results: [],
          ...internalState(),
        };
      }
      const incompleteCalendarDate = partialCalendarDate(currentUserText);
      const contextDoctorName = referenceContext.doctors.length === 1 ? referenceContext.doctors[0].name : null;
      const pendingBookingDate = actor.role === "patient" && (bookingContext?.stage === "awaiting_date_time"
        || previousReferences?.pending_response === "date_time" || previousReferences?.pending_action === "book" || actionRequest === "book");
      if (pendingBookingDate && incompleteCalendarDate?.kind === "missing_day") {
        const timeContext = requestedTime ? ` I heard ${displayableTime(requestedTime)} too.` : "";
        return { answer: `I understood ${incompleteCalendarDate.month} ${incompleteCalendarDate.year}, but I still need the day of the month.${timeContext} What day did you mean${contextDoctorName ? ` for ${contextDoctorName}` : ""}?`, results: [], ...internalState() };
      }
      if (pendingBookingDate && incompleteCalendarDate?.kind === "malformed") {
        return { answer: `I couldn't resolve “${currentUserText.trim()}” as a calendar date. Please provide a month, day, and year${contextDoctorName ? ` for ${contextDoctorName}` : ""}.`, results: [], ...internalState() };
      }
      if (/^\s*(?:\d{1,2}|\d{3,4})\s*$/.test(currentUserText)
          && actor.role === "patient" && (bookingContext?.stage === "awaiting_date_time" || previousReferences?.pending_response === "date_time") && !requestedTime) {
        return { answer: `I couldn't identify a date from “${currentUserText.trim()}”. Please give the date as a month, day, and year${contextDoctorName ? ` for ${contextDoctorName}` : ""}.`, results: [], ...internalState() };
      }
      if (refundStatusRequest) {
        const doctorName = requestedDoctorName(currentUserText)?.replace(/[’']s$/i, "");
        const refundTimeCandidates = requestedTimes.length === 1 ? requestedTimes[0].candidates : [];
        const requestedStartTime = refundTimeCandidates.length === 1 ? refundTimeCandidates[0] : null;
        if (!doctorName || !requestedDateIso || !requestedStartTime) {
          return { answer: "Please identify the appointment by the doctor's name, date, and start time so I can check its recorded refund status.", results: [], ...internalState() };
        }
        try {
          const history = await executeTool({ name: "get_patient_refund_history", args: { doctor_name: doctorName, date: requestedDateIso, start_time: requestedStartTime }, actor, database, applicationTimezone, paymentService });
          if (history.matches !== 1) {
            return { answer: history.matches > 1
              ? "More than one appointment matches those details. Please identify the appointment more precisely."
              : "I couldn't find a matching payment or refund record for that appointment in your account.", results: [], ...internalState() };
          }
          if (!history.payments.length) return { answer: `I found your appointment with ${history.appointment.doctor.name} on ${history.appointment.date} at ${displayableTime(history.appointment.start_time)}, but no payment record is associated with it.`, results: [{ tool: "get_patient_refund_history", data: publicToolResult(history) }], ...internalState() };
          const paymentStates = history.payments.filter((payment) => ["captured", "partially_refunded", "refunded"].includes(payment.status));
          const statusPayments = paymentStates.length ? paymentStates : history.payments;
          const paymentStatus = [...new Set(statusPayments.map((payment) => `${payment.status} · ${payment.currency} ${payment.amount}`))].join("; ");
          const refunds = history.payments.flatMap((payment) => (payment.refunds || []).map((refund) => ({ ...refund, currency: refund.currency || payment.currency })));
          const statusText = refunds.length
            ? refunds.map((refund) => `${refund.currency} ${refund.amount} is ${String(refund.status).replaceAll("_", " ")}`).join("; ")
            : "No refund record is associated with that payment";
          return { answer: `For your appointment with ${history.appointment.doctor.name} on ${history.appointment.date} at ${displayableTime(history.appointment.start_time)}, payment status is ${paymentStatus}. ${statusText}.`, results: [{ tool: "get_patient_refund_history", data: publicToolResult(history) }], ...internalState() };
        } catch {
          return { answer: "I couldn't check the recorded refund status just now. Please try again.", results: [], ...internalState() };
        }
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
      const furthestUpcomingRequest = /\b(?:latest|furthest|last)\s+(?:upcoming|future)\s+(?:appointment|visit|booking)\b|\b(?:upcoming|future)\s+(?:latest|furthest|last)\s+(?:appointment|visit|booking)\b/i.test(currentUserText);
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
            const pageOffset = initialOffset + history.next_offset;
            const pageArgs = { ...effectiveHistoryQuery, ...(effectiveHistoryQuery.scope === "all" ? { offset: pageOffset } : {}) };
            const page = await executeTool({ name: "get_patient_appointments", args: pageArgs, actor, database, applicationTimezone, paymentService });
            const pageRows = Array.isArray(page?.appointments) ? page.appointments : [];
            const newRows = pageRows.filter((row) => {
              const id = row.appointment_id || row.id;
              if (!id || seenIds.has(id)) return false;
              seenIds.add(id);
              return true;
            });
            const nextOffset = page?.next_offset;
            const hasValidNextPage = page?.has_more === true && effectiveHistoryQuery.scope === "all"
              && Number.isInteger(nextOffset) && nextOffset > pageOffset && pageRows.length > 0 && newRows.length > 0;
            history = {
              appointments: [...history.appointments, ...newRows],
              has_more: hasValidNextPage,
              next_offset: Number.isInteger(nextOffset) && nextOffset >= pageOffset
                ? nextOffset - initialOffset : history.next_offset + pageRows.length,
            };
            if (!history.has_more || effectiveHistoryQuery.scope !== "all" || !newRows.length) break;
          } catch {
            historyFailed = true;
            break;
          }
        }
        if (effectiveHistoryQuery.view === "upcoming" && effectiveHistoryQuery.scope === "nearest") {
          history.appointments = history.appointments.slice(0, 1);
          history.has_more = false;
        } else if (effectiveHistoryQuery.view === "upcoming" && furthestUpcomingRequest) {
          history.appointments = [...history.appointments].sort((first, second) =>
            `${second.date || ""} ${second.start_time || ""}`.localeCompare(`${first.date || ""} ${first.start_time || ""}`)).slice(0, 1);
          history.has_more = false;
        }
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
        const category = furthestUpcomingRequest ? "latest upcoming appointment"
          : effectiveHistoryQuery.scope === "nearest" ? "next upcoming appointment"
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
            ? history.has_more ? `Here are the next ${referenceContext.appointments.length} ${category}. There are more records; ask me to continue for the next page.` : `Here are the next ${referenceContext.appointments.length} ${category}.`
            : history.has_more ? `Here are ${referenceContext.appointments.length} ${category}. There are more records; ask me to continue for the next page.` : `Here are your ${category}.`
          : `You have no matching ${category}.`;
        const historyResult = { appointments: history.appointments, has_more: history.has_more };
        const uiActions = patientUiActions("get_patient_appointments", historyResult);
        return { answer, results: [{ tool: "get_patient_appointments", data: publicToolResult(historyResult), ...(uiActions.length ? { ui_actions: uiActions } : {}) }], ...internalState() };
      }
      const prepareForExactTarget = async (action, doctor, appointment, expectedAvailabilityId, displayedSlot, targetOverride = null) => {
        const targetDate = displayedSlot?.date || targetOverride?.date || requestedDateIso;
        const targetStartTime = String(displayedSlot?.start_time || "").slice(0, 5);
        const targetCandidates = displayedSlot ? [/^\d{2}:\d{2}$/.test(targetStartTime) ? targetStartTime : null].filter(Boolean)
          : targetOverride?.time ? [targetOverride.time] : targetTime?.start?.candidates || [];
        const expectedEndTimes = displayedSlot ? [String(displayedSlot.end_time || "").slice(0, 5)] : targetTime?.end?.candidates || [];
        if (!targetCandidates.length || !targetDate || !doctor?.id) return { status: "not_applicable" };
        if (targetCandidates.length > 1) return { status: "ambiguous_time" };
        if (action === "book") {
          const existing = await existingConfirmedAppointmentForSlot(doctor.id, targetDate, targetCandidates[0]);
          if (existing.appointment) return { status: "duplicate_booking", appointment: existing.appointment };
          if (existing.uncertain) return { status: "duplicate_check_incomplete" };
        }
        const exactSlotsById = new Map();
        for (const exactStartTime of targetCandidates) {
          const slotQuery = { doctor_id: doctor.id, from: targetDate, to: targetDate, exact_start_time: exactStartTime,
            ...(action === "reschedule" && appointment?.mode ? { mode: appointment.mode } : {}) };
          const availability = await executeTool({ name: "get_available_slots", args: slotQuery, actor, database, applicationTimezone, paymentService });
          for (const slot of Array.isArray(availability?.slots) ? availability.slots : []) {
            if (slot.date !== targetDate || String(slot.start_time).slice(0, 5) !== exactStartTime || (slot.doctor_id || slot.doctor?.id) !== doctor.id) continue;
            if (expectedEndTimes.length && !expectedEndTimes.includes(String(slot.end_time).slice(0, 5))) continue;
            const slotId = slot.availability_id || slot.id;
            if (expectedAvailabilityId && slotId !== expectedAvailabilityId) continue;
            if (slotId) exactSlotsById.set(slotId, slot);
          }
        }
        const exactSlots = [...exactSlotsById.values()];
        referenceContext.slots = exactSlots;
        markReferenceFresh("slots");
        referenceContext.slot_query = { doctor_id: doctor.id, from: targetDate, to: targetDate, exact_start_time: exactSlots.length === 1 ? String(exactSlots[0].start_time).slice(0, 5) : undefined };
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
      const prepareDisplayedActionSlot = async (displayedSlot, action = "book", appointment = null) => {
        const doctorId = displayedSlot?.doctor_id || displayedSlot?.doctor?.id;
        const date = displayedSlot?.date;
        const startTime = String(displayedSlot?.start_time || "").slice(0, 5);
        const displayedId = displayedSlot?.availability_id || displayedSlot?.id;
        const doctorName = displayedSlot?.doctor?.name || referenceContext.doctors.find((doctor) => doctor.id === doctorId)?.name;
        if (!doctorId || !date || !displayedId || !/^\d{2}:\d{2}$/.test(startTime)) {
          return { answer: "I couldn't resolve that displayed appointment time. Please choose one of the current times again.", results: [], ...internalState() };
        }
        if (action === "reschedule" && (!appointment || appointment.status !== "confirmed")) {
          return { answer: "I couldn't verify the confirmed appointment to reschedule. Please identify it again from your appointment list.", results: [], ...internalState() };
        }
        referenceContext.pending_action = action;
        referenceContext.pending_target_date = date;
        referenceContext.pending_slot_id = displayedId;
        referenceContext.pending_response = "slot_confirmation";
        referenceContext.pending_appointment_id = action === "reschedule" ? appointment.appointment_id || appointment.id : undefined;
        const doctor = referenceContext.doctors.find((row) => row.id === doctorId) || displayedSlot.doctor || { id: doctorId, name: doctorName };
        const outcome = await prepareForExactTarget(action, doctor, appointment, displayedId, displayedSlot);
        if (outcome.status === "duplicate_booking") {
          const answer = alreadyBookedReply(outcome.appointment, doctorName);
          setAssistantQuestion(answer, "slot_choice");
          return { answer, results: [], ...internalState() };
        }
        if (outcome.status === "duplicate_check_incomplete") {
          const answer = "I couldn't verify your existing appointments, so I haven't prepared a duplicate booking. Please try again in a moment.";
          setAssistantQuestion(answer, "slot_choice");
          return { answer, results: [], ...internalState() };
        }
        if (outcome.status === "unavailable") {
          const alternatives = await executeTool({ name: "get_available_slots", args: { doctor_id: doctorId, from: date, to: date }, actor, database, applicationTimezone, paymentService });
          referenceContext.slots = Array.isArray(alternatives?.slots) ? alternatives.slots : [];
          referenceContext.slot_query = { doctor_id: doctorId, from: date, to: date };
          referenceContext.pending_action = referenceContext.slots.length ? "book" : undefined;
          delete referenceContext.pending_slot_id;
          const answer = referenceContext.slots.length
            ? `The displayed ${displayableTime(startTime)} option on ${date} is no longer available with ${doctorName || "the selected doctor"}. I refreshed the available times; choose one of these current options.`
            : `The displayed ${displayableTime(startTime)} option on ${date} is no longer available, and I couldn't find other available times that day. Please choose another date.`;
          setAssistantQuestion(answer, referenceContext.slots.length ? "slot_choice" : "date_time");
          markReferenceFresh("slots");
          return { answer, results: [{ tool: "get_available_slots", data: publicToolResult(alternatives), ui_actions: patientUiActions("get_available_slots", alternatives) }], ...internalState() };
        }
        if (outcome.status !== "prepared") {
          const answer = action === "book"
            ? "I couldn't prepare that booking proposal. Your selected doctor and date are still saved; please choose a current time or try again."
            : "I couldn't prepare that rescheduling proposal. Your appointment and target date are still saved; please choose a current time or try again.";
          setAssistantQuestion(answer, "slot_choice");
          return { answer, results: [], ...internalState() };
        }
        referenceContext.pending_action = undefined;
        delete referenceContext.pending_target_date;
        delete referenceContext.pending_appointment_id;
        clearAssistantQuestion();
        const currentSlot = successfulPreparation.slot;
        return {
          answer: preparationReply(action, currentSlot),
          results: publicResults,
          ...(internalProposalEvidence ? { internalProposalEvidence } : {}),
          ...internalState(),
        };
      };
      const prepareDisplayedBookingSlot = (displayedSlot) => prepareDisplayedActionSlot(displayedSlot, "book");
      const availabilityIntent = /\b(?:availability|available|open slots?|time slots?)\b/i.test(currentUserText);
      const namedAvailabilityDoctor = requestedDoctorName(currentUserText);
      const contextualAvailabilityDate = requestedDateIso || referenceContext.pending_target_date
        || (typeof referenceContext.slot_query?.from === "string" ? referenceContext.slot_query.from : null);
      const contextualAvailabilityFollowup = (availabilityIntent || Boolean(requestedDateIso && requestedTime)) && referenceContext.doctors.length === 1
        && (!namedAvailabilityDoctor || doctorNameContains(referenceContext.doctors[0].name, namedAvailabilityDoctor))
        && Boolean(contextualAvailabilityDate)
        && referenceContext.slot_query?.doctor_id === referenceContext.doctors[0].id;
      const explicitAvailabilityTarget = !actionRequest && Boolean(requestedDateIso && requestedTime)
        && (Boolean(namedAvailabilityDoctor) || contextualAvailabilityFollowup)
        && !["cancellation", "rescheduling", "refund_preview", "payment_history", "appointment_history"].includes(canonicalIntent.category);
      const contextualBookingFollowup = Boolean(bookingContext) && referenceContext.doctors.length === 1
        && (!namedAvailabilityDoctor || doctorNameContains(referenceContext.doctors[0].name, namedAvailabilityDoctor))
        && (referenceContext.slots.length === 0 || requestedDateIso && requestedTimes.length > 0 || requestedDateIso && requestedDates.length > 0 || requestedDates.length > 0 && Boolean(namedAvailabilityDoctor));
      const dateOnlyDoctorFollowup = !availabilityIntent && requestedDates.length > 0 && referenceContext.doctors.length === 1
        && !/\b(?:appointment|cancel|reschedul|book|refund)\b/i.test(currentUserText);
      if (actionRequest === "book" && (namedAvailabilityDoctor || contextualBookingFollowup || bookingContext)) {
        const didSearchDoctor = Boolean(namedAvailabilityDoctor && !contextualBookingFollowup);
        const search = didSearchDoctor
          ? await executeTool({ name: "search_doctors", args: { name: namedAvailabilityDoctor }, actor, database, applicationTimezone, paymentService })
          : { doctors: referenceContext.doctors };
        const doctors = Array.isArray(search?.doctors) ? search.doctors : [];
        referenceContext.doctors = doctors;
        markReferenceFresh("doctors");
        if (doctors.length !== 1) {
          const answer = doctors.length ? `More than one doctor matches ${namedAvailabilityDoctor}. Please choose a doctor by name.` : `I could not find an active doctor matching ${namedAvailabilityDoctor}. Please check the doctor name.`;
          return { answer, results: didSearchDoctor ? [{ tool: "search_doctors", data: publicToolResult(search), ui_actions: patientUiActions("search_doctors", search) }] : [], ...internalState() };
        }
        const doctor = doctors[0];
        referenceContext.pending_action = "book";
        const previousTargetDate = bookingContext?.requested_date || referenceContext.pending_target_date || null;
        const dateChanged = Boolean(requestedDateIso && previousTargetDate && requestedDateIso !== previousTargetDate);
        if (dateChanged) {
          referenceContext.slots = [];
          referenceContext.slot_query = undefined;
          delete referenceContext.pending_slot_id;
          bookingContext = { version: 1, stage: "awaiting_date_time", doctor, requested_date: requestedDateIso, displayed_slots: [], selected_slot_id: null, pending_question: null };
        }
        if (requestedDateIso) referenceContext.pending_target_date = requestedDateIso;
        if (!dateChanged && referenceIsFresh("slots") && referenceContext.slots.length) {
          if (referenceContext.pending_response === "slot_confirmation" && referenceContext.pending_slot_id && (affirmativeReply || bookThisAppointment)) {
            const selected = referenceContext.slots.find((slot) => (slot.availability_id || slot.id) === referenceContext.pending_slot_id);
            if (selected) return prepareDisplayedBookingSlot(selected);
          }
          if (referenceContext.pending_response === "slot_choice" && affirmativeReply
              && !bookThisAppointment && requestedTimes.length === 0 && !explicitSlotCommand) {
            const answer = "Please choose one of the displayed appointment times. I won't select or book a time from a general yes or okay.";
            setAssistantQuestion(answer, "slot_choice");
            return { answer, results: [], ...internalState() };
          }
          const selection = displayedSlotSelection(currentUserText, referenceContext.slots, requestedTimes, requestedDateIso);
          if (selection?.row && (referenceContext.pending_response === "slot_choice" || explicitSlotCommand || requestedTimes.length === 1 || bookThisAppointment
              || /\b(?:book|choose|select|take|want)\b/i.test(currentUserText))) {
            return prepareDisplayedBookingSlot(selection.row);
          }
          if (selection?.ambiguous) {
            const answer = "More than one displayed appointment time matches that choice. Please specify its exact time or slot number.";
            setAssistantQuestion(answer, "slot_choice");
            return { answer, results: [], ...internalState() };
          }
        }
        if (bookThisAppointment && requestedDateIso) {
          if (!dateChanged && referenceIsFresh("slots") && referenceContext.slots.length === 1) return prepareDisplayedBookingSlot(referenceContext.slots[0]);
          if (!dateChanged && referenceIsFresh("slots") && referenceContext.slots.length > 1) {
            const answer = "Which displayed appointment time do you mean? Please choose it by its exact time or slot number.";
            setAssistantQuestion(answer, "slot_choice");
            return { answer, results: [{ tool: "get_available_slots", data: publicToolResult({ slots: referenceContext.slots }), ui_actions: patientUiActions("get_available_slots", { slots: referenceContext.slots }) }], ...internalState() };
          }
          if (!dateChanged && bookingContext?.displayed_slots?.length) {
            const refreshed = await executeTool({ name: "get_available_slots", args: { doctor_id: doctor.id, from: requestedDateIso, to: requestedDateIso }, actor, database, applicationTimezone, paymentService });
            referenceContext.slots = Array.isArray(refreshed?.slots) ? refreshed.slots : [];
            referenceContext.slot_query = { doctor_id: doctor.id, from: requestedDateIso, to: requestedDateIso };
            markReferenceFresh("slots");
            const answer = referenceContext.slots.length
              ? `I refreshed the available times with ${doctor.name} for ${requestedDateIso}. Please choose a current option before I prepare a proposal.`
              : `There are no current available times with ${doctor.name} on ${requestedDateIso}. Please choose another date.`;
            setAssistantQuestion(answer, referenceContext.slots.length ? "slot_choice" : "date_time");
            return { answer, results: [{ tool: "get_available_slots", data: publicToolResult(refreshed), ui_actions: patientUiActions("get_available_slots", refreshed) }], ...internalState() };
          }
        }
        if (!requestedDateIso) {
          const askTime = requestedTime ? "What date would you prefer?" : "What date and time would you prefer?";
          const answer = `I can help you book with ${doctor.name}. ${askTime}`;
          setAssistantQuestion(answer, "date_time");
          return {
            answer,
            results: didSearchDoctor ? [{ tool: "search_doctors", data: publicToolResult(search), ui_actions: patientUiActions("search_doctors", search) }] : [],
            ...internalState(),
          };
        }
        if (!requestedTime) {
          if (requestedDate && !dateChanged && requestedDateIso === previousTargetDate && referenceIsFresh("slots") && referenceContext.slots.length === 1) {
            return prepareDisplayedBookingSlot(referenceContext.slots[0]);
          }
          if (requestedDate && !dateChanged && requestedDateIso === previousTargetDate && referenceIsFresh("slots") && referenceContext.slots.length > 1) {
            const selected = referenceContext.pending_slot_id && referenceContext.slots.find((slot) => (slot.availability_id || slot.id) === referenceContext.pending_slot_id);
            const answer = selected
              ? `I still have ${displayableTime(selected.start_time)} selected with ${doctor.name} on ${requestedDateIso}. Would you like me to prepare the booking proposal?`
              : `I still have the available times with ${doctor.name} on ${requestedDateIso}. Choose one of these displayed times.`;
            setAssistantQuestion(answer, selected ? "slot_confirmation" : "slot_choice", selected);
            return { answer, results: [{ tool: "get_available_slots", data: publicToolResult({ slots: referenceContext.slots }), ui_actions: patientUiActions("get_available_slots", { slots: referenceContext.slots }) }], ...internalState() };
          }
          const args = { doctor_id: doctor.id, from: requestedDateIso, to: requestedDateIso };
          const availability = await executeTool({ name: "get_available_slots", args, actor, database, applicationTimezone, paymentService });
          referenceContext.slots = Array.isArray(availability?.slots) ? availability.slots : [];
          referenceContext.slot_query = args;
          referenceContext.pending_target_date = requestedDateIso;
          referenceContext.pending_response = referenceContext.slots.length ? "slot_choice" : "date_time";
          delete referenceContext.pending_slot_id;
          const answer = referenceContext.slots.length
            ? `Here are the available appointment times with ${doctor.name} on ${requestedDateIso}. Choose a time to prepare a booking proposal.`
            : `I could not find available appointment times with ${doctor.name} on ${requestedDateIso}. Please choose another date.`;
          setAssistantQuestion(answer, referenceContext.slots.length ? "slot_choice" : "date_time");
          markReferenceFresh("slots");
          return {
            answer,
            results: [{ tool: "get_available_slots", data: publicToolResult(availability), ui_actions: patientUiActions("get_available_slots", availability) }],
            ...internalState(),
          };
        }
        {
          const previouslyDisplayedExactSlot = referenceContext.slots.find((slot) => (slot.doctor_id || slot.doctor?.id) === doctor.id
            && slot.date === requestedDateIso && String(slot.start_time).slice(0, 5) === requestedTime);
          const expectedAvailabilityId = previouslyDisplayedExactSlot?.availability_id || previouslyDisplayedExactSlot?.id;
          const outcome = await prepareForExactTarget("book", doctor, undefined, expectedAvailabilityId);
          if (outcome.status === "prepared") {
            referenceContext.pending_action = undefined;
            referenceContext.pending_target_date = undefined;
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
                ? previouslyDisplayedExactSlot
                  ? `The displayed ${requestedTimeLabel} option on ${requestedDateIso} is no longer available with ${doctor.name}. I refreshed the available times; choose from these current options to prepare a booking proposal.`
                  : `The requested ${requestedTimeLabel} time is not available with ${doctor.name}. Here are other available times on ${requestedDateIso}. Choose one to prepare a booking proposal.`
                : `The requested ${requestedTimeLabel} time is not available with ${doctor.name}, and I couldn't find other available times on ${requestedDateIso}. Please choose another date.`,
              results: [{ tool: "get_available_slots", data: publicToolResult({ slots: referenceContext.slots }), ui_actions: patientUiActions("get_available_slots", { slots: referenceContext.slots }) }],
              ...internalState(),
            };
          }
          if (outcome.status === "duplicate_booking") return { answer: alreadyBookedReply(outcome.appointment, doctor.name), results: [], ...internalState() };
          if (outcome.status === "duplicate_check_incomplete") return { answer: "I couldn't verify your existing appointments, so I haven't prepared a duplicate booking. Please try again in a moment.", results: [], ...internalState() };
          return { answer: outcome.status === "ambiguous_slot" ? "More than one slot matches that exact time. Please clarify which slot you want." : "I couldn't verify that exact time for booking. Please try another time.", results: [], ...internalState() };
        }
      }
      if (!actionRequest && ((availabilityIntent && (namedAvailabilityDoctor || contextualAvailabilityFollowup)) || dateOnlyDoctorFollowup || explicitAvailabilityTarget)) {
        const useContextDoctor = dateOnlyDoctorFollowup || contextualAvailabilityFollowup;
        const search = useContextDoctor ? { doctors: [referenceContext.doctors[0]] }
          : await executeTool({ name: "search_doctors", args: { name: namedAvailabilityDoctor }, actor, database, applicationTimezone, paymentService });
        const doctors = Array.isArray(search?.doctors) ? search.doctors : [];
        referenceContext.doctors = doctors;
        markReferenceFresh("doctors");
        if (doctors.length !== 1) {
          const answer = doctors.length ? `More than one doctor matches ${namedAvailabilityDoctor}. Please choose a doctor by name.` : `I could not find an active doctor matching ${namedAvailabilityDoctor}. Please check the doctor name.`;
          const results = useContextDoctor ? [] : [{ tool: "search_doctors", data: publicToolResult(search), ui_actions: patientUiActions("search_doctors", search) }];
          return { answer, results, ...internalState() };
        }
        const doctor = doctors[0];
        if (dateOnlyDoctorFollowup) referenceContext.pending_target_date = requestedDateIso;
        if (dateOnlyDoctorFollowup && referenceContext.pending_action === "book"
            && requestedDateIso === previousReferences?.pending_target_date && referenceIsFresh("slots") && referenceContext.slots.length) {
          const selected = referenceContext.pending_slot_id && referenceContext.slots.find((slot) => (slot.availability_id || slot.id) === referenceContext.pending_slot_id);
          const answer = selected
            ? `I still have ${displayableTime(selected.start_time)} selected with ${doctor.name} on ${requestedDateIso}. Would you like me to prepare the booking proposal?`
            : `I still have the available times with ${doctor.name} on ${requestedDateIso}. Choose one of these displayed times.`;
          setAssistantQuestion(answer, selected ? "slot_confirmation" : "slot_choice", selected);
          return { answer, results: [{ tool: "get_available_slots", data: publicToolResult({ slots: referenceContext.slots }), ui_actions: patientUiActions("get_available_slots", { slots: referenceContext.slots }) }], ...internalState() };
        }
        const targetDate = contextualAvailabilityFollowup ? contextualAvailabilityDate : requestedDateIso;
        const args = { doctor_id: doctor.id, ...(targetDate ? { from: targetDate, to: targetDate } : {}), ...(requestedTime ? { exact_start_time: requestedTime } : {}) };
        const availability = await executeTool({ name: "get_available_slots", args, actor, database, applicationTimezone, paymentService });
        let visibleAvailability = availability;
        if (requestedTime && !availability?.slots?.length && targetDate) {
          visibleAvailability = await executeTool({ name: "get_available_slots", args: { doctor_id: doctor.id, from: targetDate, to: targetDate }, actor, database, applicationTimezone, paymentService });
        }
        referenceContext.slots = Array.isArray(visibleAvailability?.slots) ? visibleAvailability.slots : [];
        referenceContext.slot_query = requestedTime && !availability?.slots?.length && targetDate
          ? { doctor_id: doctor.id, from: targetDate, to: targetDate } : args;
        if (targetDate) referenceContext.pending_target_date = targetDate;
        const answer = requestedTime && !availability?.slots?.length
          ? referenceContext.slots.length
            ? `The requested ${displayableTime(requestedTime)} time is unavailable with ${doctor.name} on ${targetDate}. Here are the other available times for that date.`
            : `The requested ${displayableTime(requestedTime)} time is unavailable with ${doctor.name} on ${targetDate}, and there are no other available times that day.`
          : availability.slots?.length ? `Here are the available appointment times with ${doctor.name}${targetDate ? ` on ${targetDate}` : ""}.` : `I could not find available appointment times with ${doctor.name}${targetDate ? ` on ${targetDate}` : " for that date"}.`;
        if (referenceContext.pending_action === "book") setAssistantQuestion(answer, referenceContext.slots.length ? "slot_choice" : "date_time");
        markReferenceFresh("slots");
        const results = [
          ...(!useContextDoctor ? [{ tool: "search_doctors", data: publicToolResult(search), ui_actions: patientUiActions("search_doctors", search) }] : []),
          { tool: "get_available_slots", data: publicToolResult(visibleAvailability), ui_actions: patientUiActions("get_available_slots", visibleAvailability) },
        ];
        return { answer, results, ...internalState() };
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
          const args = { doctor_id: appointment.doctor?.id, from: referenceContext.pending_target_date, to: referenceContext.pending_target_date, ...(appointment.mode ? { mode: appointment.mode } : {}) };
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
        rescheduleContext = {
          version: 1, stage: matches.length > 1 ? "selecting_appointment" : "awaiting_target",
          source_date: sourceDate, target_date: targetDate,
          ...(targetTimeProvided && requestedTime ? { target_time: requestedTime } : {}),
          ...(matches.length === 1 ? { selected_appointment_id: matches[0].appointment_id || matches[0].id } : {}),
          doctor_name: sourceDoctorName,
        };
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
        const args = { doctor_id: targetDoctor?.id, from: targetDate, to: targetDate, ...(appointment.mode ? { mode: appointment.mode } : {}) };
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
      if (actor.role === "patient" && rescheduleContext && actionRequest !== "book"
          && (!explicitTopicChange || canonicalIntent.category === "rescheduling")) {
        if (!referenceContext.appointments.length && !rescheduleContext.selected_appointment_id) {
          const sourcePage = await executeTool({ name: "get_patient_appointments", args: {
            view: "upcoming", scope: "all", from: rescheduleContext.source_date, to: rescheduleContext.source_date,
          }, actor, database, applicationTimezone, paymentService });
          referenceContext.appointments = (sourcePage?.appointments || []).filter((row) => row.status === "confirmed");
          markReferenceFresh("appointments");
        }
        const selected = contextualReference(currentUserText, referenceContext.appointments, "appointment");
        if (selected?.ambiguous) {
          return { answer: "More than one appointment matches that choice. Please identify it by its date and start time.", results: [], ...internalState() };
        }
        const timeIdentifiedRows = !selected?.row && requestedTimes.length
          ? referenceContext.appointments.filter((row) => row.date === rescheduleContext.source_date
            && requestedTimes.some((time) => time.candidates.includes(String(row.start_time || "").slice(0, 5)))) : [];
        const timeIdentifiedAppointment = timeIdentifiedRows.length === 1 ? timeIdentifiedRows[0] : null;
        if (timeIdentifiedRows.length > 1) return { answer: "More than one appointment matches that start time. Please include the appointment date too.", results: [], ...internalState() };
        const selectedAppointment = selected?.row || timeIdentifiedAppointment;
        const selectedId = selectedAppointment?.appointment_id || selectedAppointment?.id || rescheduleContext.selected_appointment_id;
        const datesInTurn = requestedDates.map((reference) => resolveDateReference(reference, applicationTimezone, now())).filter(Boolean);
        if ((requestedDates.length && !datesInTurn.length) || partialCalendarDate(currentUserText)) {
          return { answer: "That date is incomplete or invalid. Please provide a valid target date; I’ll keep the appointment you selected.", results: [], ...internalState() };
        }
        const newlyRequestedTargetDate = datesInTurn.find((date) => date !== rescheduleContext.source_date);
        if (newlyRequestedTargetDate) rescheduleContext.target_date = newlyRequestedTargetDate;
        if (!timeIdentifiedAppointment && requestedTimes.length && (!datesInTurn.length || datesInTurn.some((date) => date !== rescheduleContext.source_date))) {
          if (requestedTime) rescheduleContext.target_time = requestedTime;
        }
        if (!selectedId) {
          rescheduleContext.stage = "selecting_appointment";
          return { answer: "Which appointment on that date do you want to reschedule? Please give its start time.", results: [], ...internalState() };
        }
        const verifyArgs = { view: "upcoming", scope: "all", from: rescheduleContext.source_date, to: rescheduleContext.source_date };
        const verifiedPage = await executeTool({ name: "get_patient_appointments", args: verifyArgs, actor, database, applicationTimezone, paymentService });
        const appointment = (verifiedPage?.appointments || []).find((row) => (row.appointment_id || row.id) === selectedId);
        if (!appointment || appointment.status !== "confirmed") {
          return { answer: "I couldn't verify that confirmed appointment anymore. Please refresh your appointments and identify it again.", results: [], ...internalState() };
        }
        referenceContext.appointments = [appointment];
        referenceContext.pending_appointment_id = selectedId;
        referenceContext.pending_action = "reschedule";
        markReferenceFresh("appointments");
        const mentionedDoctor = requestedDoctorName(currentUserText);
        if (mentionedDoctor && !doctorNameContains(appointment.doctor?.name, mentionedDoctor)) {
          rescheduleContext.selected_appointment_id = selectedId;
          rescheduleContext.stage = "clarifying_doctor";
          return { answer: `The appointment I found is with ${appointment.doctor?.name || "a different doctor"}, not Dr. ${mentionedDoctor}. Did you mean the appointment with ${appointment.doctor?.name || "the doctor shown"}?`, results: [], ...internalState() };
        }
        rescheduleContext.selected_appointment_id = selectedId;
        rescheduleContext.stage = "awaiting_target";
        const targetDate = rescheduleContext.target_date;
        const displayedReplacement = referenceIsFresh("slots")
          ? displayedSlotSelection(currentUserText, referenceContext.slots, requestedTimes, targetDate) : null;
        if (displayedReplacement?.ambiguous) {
          return { answer: "More than one displayed replacement time matches. Please choose a slot number or exact start time.", results: [], ...internalState() };
        }
        if (displayedReplacement?.row && displayedReplacement.row.date === targetDate) {
          return prepareDisplayedActionSlot(displayedReplacement.row, "reschedule", appointment);
        }
        if (rescheduleContext.target_time && targetDate) {
          const outcome = await prepareForExactTarget("reschedule", appointment.doctor, appointment, undefined, undefined,
            { date: targetDate, time: rescheduleContext.target_time });
          if (outcome.status === "prepared") {
            rescheduleContext = null;
            referenceContext.pending_action = undefined;
            referenceContext.pending_appointment_id = undefined;
            return { answer: preparationReply("reschedule", successfulPreparation.slot), results: publicResults, ...(internalProposalEvidence ? { internalProposalEvidence } : {}), ...internalState() };
          }
          if (outcome.status === "unavailable") {
            const args = { doctor_id: appointment.doctor.id, from: targetDate, to: targetDate, ...(appointment.mode ? { mode: appointment.mode } : {}) };
            const alternatives = await executeTool({ name: "get_available_slots", args, actor, database, applicationTimezone, paymentService });
            referenceContext.slots = Array.isArray(alternatives?.slots) ? alternatives.slots : [];
            referenceContext.slot_query = args;
            markReferenceFresh("slots");
            return { answer: referenceContext.slots.length ? `That time is unavailable. Here are current replacement times with ${appointment.doctor.name} on ${targetDate}. Choose one to prepare a proposal.` : `That time is unavailable with ${appointment.doctor.name} on ${targetDate}. Please choose another date or time.`, results: [{ tool: "get_available_slots", data: publicToolResult(alternatives), ui_actions: patientUiActions("get_available_slots", alternatives) }], ...internalState() };
          }
          return { answer: "I couldn't verify that exact replacement time. Please choose one of the current options or clarify the time.", results: [], ...internalState() };
        }
        if (!targetDate) return { answer: `I found your confirmed appointment with ${appointment.doctor.name}. What date would you like to move it to?`, results: [], ...internalState() };
        const args = { doctor_id: appointment.doctor.id, from: targetDate, to: targetDate, ...(appointment.mode ? { mode: appointment.mode } : {}) };
        const availability = await executeTool({ name: "get_available_slots", args, actor, database, applicationTimezone, paymentService });
        referenceContext.slots = Array.isArray(availability?.slots) ? availability.slots : [];
        referenceContext.slot_query = args;
        markReferenceFresh("slots");
        rescheduleContext.stage = "awaiting_target";
        return { answer: referenceContext.slots.length ? `Here are available replacement times with ${appointment.doctor.name} on ${targetDate}. Choose one to prepare a proposal.` : `There are no available replacement times with ${appointment.doctor.name} on ${targetDate}. Please choose another date.`, results: [{ tool: "get_available_slots", data: publicToolResult(availability), ui_actions: patientUiActions("get_available_slots", availability) }], ...internalState() };
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
      if (actor.role === "patient" && (actionRequest === "reschedule" || referenceContext.pending_action === "reschedule")) {
        const selectedReference = contextualReference(currentUserText, referenceContext.appointments, "appointment");
        if (selectedReference?.ambiguous) return { answer: "More than one confirmed appointment matches that reference. Please choose the appointment by its displayed date and time.", results: [], ...internalState() };
        const appointment = selectedReference?.row
          || referenceContext.appointments.find((row) => (row.appointment_id || row.id) === referenceContext.pending_appointment_id)
          || (referenceContext.appointments.length === 1 ? referenceContext.appointments[0] : null);
        const targetName = requestedTargetDoctorName(currentUserText);
        if (appointment && (!targetName || doctorNameContains(appointment.doctor?.name, targetName))) {
          if (appointment.status !== "confirmed") return { answer: "That appointment is no longer eligible for rescheduling. Please refresh your appointment list.", results: [], ...internalState() };
          const existingSlotSelection = referenceIsFresh("slots")
            ? displayedSlotSelection(currentUserText, referenceContext.slots, requestedTimes, requestedDateIso || referenceContext.pending_target_date) : null;
          if (existingSlotSelection?.ambiguous) return { answer: "More than one displayed replacement time matches that choice. Please specify the exact time or slot number.", results: [], ...internalState() };
          if (existingSlotSelection?.row && referenceContext.pending_action === "reschedule") {
            referenceContext.doctors = [appointment.doctor];
            return prepareDisplayedActionSlot(existingSlotSelection.row, "reschedule", appointment);
          }
          const targetDate = requestedDateIso || (referenceContext.pending_action === "reschedule" ? referenceContext.pending_target_date : null);
          if (!targetDate) {
            referenceContext.pending_action = "reschedule";
            referenceContext.pending_appointment_id = appointment.appointment_id || appointment.id;
            return { answer: `I found your confirmed appointment with ${appointment.doctor?.name || "this doctor"}. What date and time would you like instead?`, results: [], ...internalState() };
          }
          referenceContext.pending_action = "reschedule";
          referenceContext.pending_target_date = targetDate;
          referenceContext.pending_appointment_id = appointment.appointment_id || appointment.id;
          const doctor = appointment.doctor;
          if (!doctor?.id) return { answer: "I couldn't verify the doctor for that appointment. Please refresh your appointment list before rescheduling.", results: [], ...internalState() };
          if (!requestedTime) {
            if (referenceIsFresh("slots") && referenceContext.slot_query?.doctor_id === doctor.id
                && referenceContext.slot_query?.from === targetDate && referenceContext.slots.length) {
              return { answer: `Choose a replacement time with ${doctor.name} on ${targetDate}.`, results: [{ tool: "get_available_slots", data: publicToolResult({ slots: referenceContext.slots }), ui_actions: patientUiActions("get_available_slots", { slots: referenceContext.slots }) }], ...internalState() };
            }
            const args = { doctor_id: doctor.id, from: targetDate, to: targetDate, ...(appointment.mode ? { mode: appointment.mode } : {}) };
            const availability = await executeTool({ name: "get_available_slots", args, actor, database, applicationTimezone, paymentService });
            referenceContext.slots = Array.isArray(availability?.slots) ? availability.slots : [];
            referenceContext.slot_query = args;
            markReferenceFresh("slots");
            return { answer: referenceContext.slots.length ? `Here are available replacement times with ${doctor.name} on ${targetDate}. Choose a time to prepare the rescheduling proposal.` : `I couldn't find available replacement times with ${doctor.name} on ${targetDate}. Please choose another date.`, results: [{ tool: "get_available_slots", data: publicToolResult(availability), ui_actions: patientUiActions("get_available_slots", availability) }], ...internalState() };
          }
          const displayedSlot = referenceIsFresh("slots") ? referenceContext.slots.find((slot) => slot.date === targetDate
            && (slot.doctor_id || slot.doctor?.id) === doctor.id
            && requestedTimes.at(-1)?.candidates.includes(String(slot.start_time).slice(0, 5))) : null;
          const outcome = await prepareForExactTarget("reschedule", doctor, appointment,
            displayedSlot?.availability_id || displayedSlot?.id, displayedSlot);
          if (outcome.status === "prepared") {
            referenceContext.pending_action = undefined;
            referenceContext.pending_appointment_id = undefined;
          if (action === "reschedule") rescheduleContext = null;
            return { answer: preparationReply("reschedule", successfulPreparation.slot), results: publicResults, ...(internalProposalEvidence ? { internalProposalEvidence } : {}), ...internalState() };
          }
          if (outcome.status === "unavailable") {
            const alternatives = await executeTool({ name: "get_available_slots", args: { doctor_id: doctor.id, from: targetDate, to: targetDate, ...(appointment.mode ? { mode: appointment.mode } : {}) }, actor, database, applicationTimezone, paymentService });
            referenceContext.slots = Array.isArray(alternatives?.slots) ? alternatives.slots : [];
            referenceContext.slot_query = { doctor_id: doctor.id, from: targetDate, to: targetDate, ...(appointment.mode ? { mode: appointment.mode } : {}) };
            markReferenceFresh("slots");
            return { answer: referenceContext.slots.length ? `That replacement time is no longer available. Here are current options with ${doctor.name} on ${targetDate}; choose one to prepare a proposal.` : `That replacement time is unavailable, and there are no other times with ${doctor.name} on ${targetDate}.`, results: [{ tool: "get_available_slots", data: publicToolResult(alternatives), ui_actions: patientUiActions("get_available_slots", alternatives) }], ...internalState() };
          }
          return { answer: outcome.status === "ambiguous_slot" ? "More than one replacement slot matches that time. Please choose one displayed time." : "I couldn't prepare the rescheduling proposal. Please check the target time and try again.", results: [], ...internalState() };
        }
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
      const displayedSelection = referenceIsFresh("slots")
        ? displayedSlotSelection(currentUserText, referenceContext.slots, requestedTimes, requestedDateIso) : null;
      const selectionAction = referenceContext.pending_action === "reschedule" || actionRequest === "reschedule"
        ? "reschedule"
        : referenceContext.pending_action === "book" || actionRequest === "book" || canonicalIntent.category === "booking"
          || /\b(?:book|choose|select|take|want)\b/i.test(currentUserText) ? "book" : null;
      if (actor.role === "patient" && displayedSelection?.ambiguous) {
        const answer = selectionAction === "reschedule"
          ? "More than one displayed time matches that choice. Please specify the exact time or slot number for the appointment you want to move."
          : "More than one displayed time matches that choice. Please specify the exact time or slot number.";
        if (selectionAction) setAssistantQuestion(answer, "slot_choice");
        return { answer, results: [], ...internalState() };
      }
      if (actor.role === "patient" && displayedSelection?.row && selectionAction) {
        const selectedSlot = displayedSelection.row;
        if (selectionAction === "reschedule") {
          const appointment = referenceContext.appointments.find((row) => (row.appointment_id || row.id) === referenceContext.pending_appointment_id)
            || (referenceContext.appointments.length === 1 ? referenceContext.appointments[0] : null);
          if (!appointment || appointment.status !== "confirmed") {
            return { answer: "Please identify the confirmed appointment you want to reschedule before choosing a replacement time.", results: [], ...internalState() };
          }
          const doctor = selectedSlot.doctor || referenceContext.doctors.find((row) => row.id === selectedSlot.doctor_id);
          if (!doctor?.id) return { answer: "I couldn't verify the doctor for that displayed time. Please refresh the available times and choose again.", results: [], ...internalState() };
          referenceContext.doctors = [doctor];
          return prepareDisplayedActionSlot(selectedSlot, "reschedule", appointment);
        }
        const doctorId = selectedSlot.doctor_id || selectedSlot.doctor?.id;
        const doctor = selectedSlot.doctor || referenceContext.doctors.find((row) => row.id === doctorId);
        if (!doctor?.id) return { answer: "I couldn't verify the doctor for that displayed time. Please refresh the available times and choose again.", results: [], ...internalState() };
        referenceContext.doctors = [doctor];
        return prepareDisplayedBookingSlot(selectedSlot);
      }
      const shortSlotMatches = slotChoice(currentUserText, referenceContext.slots);
      const contextualSlotSelection = contextualReference(currentUserText, referenceContext.slots, "slot|availability option");
      const selectedSlots = shortSlotMatches || (contextualSlotSelection?.row ? [contextualSlotSelection.row] : null);
      if (referenceContext.pending_action === "book" && referenceContext.pending_response === "slot_confirmation"
          && referenceContext.pending_slot_id && (affirmativeReply || bookThisAppointment)) {
        const selected = referenceContext.slots.find((slot) => (slot.availability_id || slot.id) === referenceContext.pending_slot_id);
        if (selected) return prepareDisplayedBookingSlot(selected);
      }
      if (referenceContext.pending_action === "book" && referenceContext.pending_response === "slot_choice" && affirmativeReply
          && !bookThisAppointment && !displayedSelection?.row) {
        return {
          answer: "Please choose one of the displayed appointment times. I won't select or book a time from a general yes or okay.",
          results: [],
          ...internalState(),
        };
      }
      if (referenceContext.pending_action === "book" && bookThisAppointment && referenceContext.slots.length) {
        if (referenceContext.slots.length === 1) return prepareDisplayedBookingSlot(referenceContext.slots[0]);
        return {
          answer: "Which displayed time do you mean? Please select it by its exact time or slot number so I can verify the correct option.",
          results: [],
          ...internalState(),
        };
      }
      const naturalTimeSlotMatches = previousReferences?.pending_action === "book" && requestedTimes.length === 1
        ? referenceContext.slots.filter((slot) => requestedTimes[0].candidates.includes(String(slot.start_time || "").slice(0, 5))
          && (!requestedDateIso || slot.date === requestedDateIso)) : [];
      if (naturalTimeSlotMatches.length > 1) {
        return { answer: "More than one displayed slot matches that time. Please include the date so I can recheck the exact option.", results: [], ...internalState() };
      }
      if (naturalTimeSlotMatches.length === 1) {
        return prepareDisplayedBookingSlot(naturalTimeSlotMatches[0]);
      }
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
          return prepareDisplayedBookingSlot(slot);
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
        const answer = `That matches ${slot.date} at ${displayableTime(slot.start_time)}${slot.doctor?.name ? ` with ${slot.doctor.name}` : ""}. Would you like me to prepare a booking proposal?`;
        if (referenceContext.pending_action === "book") setAssistantQuestion(answer, "slot_confirmation", slot);
        return { answer, results: [{ tool: "get_available_slots", data: publicToolResult({ slots: [slot] }) }], ...internalState() };
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
      if (actor.role === "patient" && bookingContext && !explicitTopicChange
          && !/\b(?:start over|new topic|forget (?:this|that) booking|cancel this booking request)\b/i.test(currentUserText)) {
        const doctorName = bookingContext.doctor?.name || "the selected doctor";
        const dateText = bookingContext.requested_date ? ` on ${bookingContext.requested_date}` : "";
        const answer = bookingContext.stage === "awaiting_date_time"
          ? `I’m still helping you book with ${doctorName}${dateText}. Please provide a complete date and time, or tell me which part you want to clarify.`
          : `I’m still helping you book with ${doctorName}${dateText}. Please choose one of the currently displayed times by its exact time or slot number.`;
        return { answer, results: [], ...internalState() };
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
          log("provider_response", undefined, providerAttempts, undefined, undefined, undefined, completion?.providerMetadata);
          if (!completion || !Array.isArray(completion.toolCalls) || typeof completion.text !== "string") {
            throw new AssistantError("PROVIDER_INVALID_RESPONSE", 502, "The assistant could not produce a response. Please try again.");
          }
          const incompleteFinishReasons = new Set(["MAX_TOKENS", "SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII", "MALFORMED_FUNCTION_CALL", "UNEXPECTED_TOOL_CALL"]);
          const finishReason = completion.providerMetadata?.finishReason;
          if (incompleteFinishReasons.has(finishReason)) {
            const category = `provider_finish_${finishReason.toLowerCase()}`;
            log("provider_incomplete", undefined, providerAttempts, category, undefined, undefined, completion.providerMetadata);
            throw new AssistantError("PROVIDER_INCOMPLETE_RESPONSE", 502, "The assistant response was interrupted before it finished. Please retry.", { category, attempt: providerAttempts });
          }
          if (completion.toolCalls.length === 0) {
            let answer = completion.text.trim();
            if (!answer) {
              log("provider_incomplete", undefined, providerAttempts, "provider_empty_final_text", undefined, undefined, completion.providerMetadata);
              throw new AssistantError("PROVIDER_INCOMPLETE_RESPONSE", 502, "The assistant returned no final text. Please retry your question.", { category: "provider_empty_final_text", attempt: providerAttempts });
            }
            if (unverifiedActionClaim(answer) && !successfulPreparation) {
              answer = "I have not prepared an appointment proposal or created a confirmation intent. Tell me the doctor and exact appointment time you want, or identify the appointment you want to reschedule.";
            } else if (successfulPreparation) {
              answer = preparationReply(successfulPreparation.action, successfulPreparation.slot);
            } else if (/\brefund|refunded|reimburse\b/i.test(currentUserText)) {
              answer = successfulRefundPreview
                ? refundPreviewReply(successfulRefundPreview)
                : "I can't determine a refund amount or processed status yet because I have not checked a specific appointment's payment record. Please identify the appointment by its doctor, date, and time.";
            }
            if (referenceContext.pending_action === "book" && referenceContext.slots.length
                && /\b(?:would you like|shall i|do you want|should i)\b[\s\S]{0,120}\b(?:prepare|book|schedule)\b/i.test(answer)) {
              const questionTimes = timeReferences(answer);
              const matchingQuestionSlots = questionTimes.length === 1
                ? referenceContext.slots.filter((slot) => questionTimes[0].candidates.includes(String(slot.start_time || "").slice(0, 5)))
                : [];
              if (matchingQuestionSlots.length === 1) setAssistantQuestion(answer, "slot_confirmation", matchingQuestionSlots[0]);
              else setAssistantQuestion(answer, "slot_choice");
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
                log("tool_execution", undefined, 0, "invalid_tool_arguments", call.name, "schema_validation");
                const doctor = bookingContext?.doctor?.name;
                const date = bookingContext?.requested_date;
                const answer = bookingContext
                  ? `I couldn't safely verify that booking request${doctor ? ` with ${doctor}` : ""}${date ? ` on ${date}` : ""}. Please clarify the date or choose one of the current times.`
                  : "I couldn't safely interpret the lookup parameters. Please clarify the requested record or time.";
                return { answer, results: publicResults, ...internalState() };
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
              if (call.name === "get_available_slots" && requestedDate && !dateReferenceMatches(requestedDate, call.arguments.from)) {
                results.push({ name: call.name, id: call.id, result: { error: "Use the explicit date supplied by the patient; do not change its year or substitute another date." } });
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
                if (actionRequest === "book" || actionRequest === "reschedule") {
                  referenceContext.pending_action = actionRequest;
                  if (actionRequest === "book" && call.arguments.from === call.arguments.to) referenceContext.pending_target_date = call.arguments.from;
                  if (actionRequest === "book") {
                    delete referenceContext.pending_slot_id;
                    referenceContext.pending_response = result.slots.length ? "slot_choice" : "date_time";
                  }
                }
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
              if (error.code === "INVALID_TOOL_ARGUMENTS") {
                const contextText = bookingContext
                  ? `I couldn't safely verify the booking with ${bookingContext.doctor.name}${bookingContext.requested_date ? ` on ${bookingContext.requested_date}` : ""}. Please clarify the date or time.`
                  : "I couldn't safely validate the lookup. Please clarify the requested details.";
                return { answer: contextText, results: publicResults, ...internalState() };
              }
              if (error.code === "TOOL_LIMIT_EXCEEDED") {
                const doctor = referenceContext.doctors.length === 1 ? referenceContext.doctors[0].name : null;
                const date = referenceContext.pending_target_date;
                return {
                  answer: referenceContext.pending_action === "book" && referenceContext.slots.length
                    ? `I couldn't finish another lookup, but your booking context is saved${doctor ? ` for ${doctor}` : ""}${date ? ` on ${date}` : ""}. Choose one of the displayed available times or ask me to refresh that date.`
                    : "I couldn't finish the remaining lookup. Your existing assistant context is saved; please narrow the request and try again.",
                  results: publicResults,
                  ...internalState(),
                };
              }
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
          if (error.code === "TOOL_LIMIT_EXCEEDED") {
            const doctor = referenceContext.doctors.length === 1 ? referenceContext.doctors[0].name : null;
            const date = referenceContext.pending_target_date;
            return {
              answer: referenceContext.pending_action === "book" && referenceContext.slots.length
                ? `I couldn't finish another lookup, but your booking context is saved${doctor ? ` for ${doctor}` : ""}${date ? ` on ${date}` : ""}. Choose one of the displayed available times or ask me to refresh that date.`
                : "I couldn't finish the remaining lookup. Your existing assistant context is saved; please narrow the request and try again.",
              results: publicResults,
              ...internalState(),
            };
          }
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
