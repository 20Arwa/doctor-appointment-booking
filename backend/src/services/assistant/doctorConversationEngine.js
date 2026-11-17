const { AssistantError } = require("./conversationEngine");
const { dateReferences, resolveDateReference } = require("./temporalInterpretation");

function dateInTimezone(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function previousWeekRange(date, timeZone) {
  const today = dateInTimezone(date, timeZone);
  const weekday = new Date(`${today}T12:00:00Z`).getUTCDay();
  const mondayOffset = weekday === 0 ? -6 : 1 - weekday;
  const shift = (days) => {
    const shifted = new Date(`${today}T12:00:00Z`);
    shifted.setUTCDate(shifted.getUTCDate() + mondayOffset - 7 + days);
    return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}-${String(shifted.getUTCDate()).padStart(2, "0")}`;
  };
  return { from: shift(0), to: shift(6) };
}

function normalizeStatisticsArguments(text, args, date, timeZone) {
  if (!/\blast week\b/i.test(text)) return args;
  const { from, to } = previousWeekRange(date, timeZone);
  const status = ["confirmed", "completed", "cancelled"].includes(args?.status) ? args.status : undefined;
  return { from, to, ...(status ? { status } : {}) };
}

function normalizeDoctorDateArguments(name, text, args, date, timeZone) {
  if (!["get_doctor_appointments", "get_doctor_schedules", "get_doctor_schedule_exceptions", "get_doctor_schedule_conflicts", "get_doctor_nearest_slots"].includes(name)) return args;
  const references = dateReferences(text);
  if (references.length !== 1) return args;
  const serviceDate = resolveDateReference(references[0], timeZone, date);
  if (!serviceDate) return args;
  const options = {};
  if (name === "get_doctor_nearest_slots") {
    if (["wave", "stream"].includes(args?.mode)) options.mode = args.mode;
  } else {
    if (name === "get_doctor_appointments" && ["confirmed", "completed", "cancelled"].includes(args?.status)) options.status = args.status;
    if (Number.isInteger(args?.limit)) options.limit = args.limit;
  }
  return { ...options, from: serviceDate, to: serviceDate };
}

function isAllAppointmentsForDateRequest(text) {
  return /\b(?:all|every)\b/i.test(text)
    && /\bappointments?\b/i.test(text)
    && dateReferences(text).length === 1
    && !/\b(?:statistics|count|how many|availability|available slots?)\b/i.test(text);
}

function isUpcomingListRequest(text, args, today) {
  if (!/\bappointments?\b/i.test(text) || /\b(?:cancelled|canceled|completed|past|history|previous|last|confirmed)\b/i.test(text)) return false;
  if (/\b(?:upcoming|future)\s+appointments?\b/i.test(text)) return true;
  if (!/\b(?:show|list|display|get|find|what|which)\b/i.test(text)) return false;
  if (args?.day) return args.day === "today" || args.day === "tomorrow";
  const requestedEnd = args?.to || args?.date;
  return typeof requestedEnd === "string" && /^\d{4}-\d{2}-\d{2}$/.test(requestedEnd) && requestedEnd >= today;
}

function createDoctorConversationEngine({ provider, toolExecutor, maxToolCalls = 4, now = () => new Date() }) {
  return {
    async respond({ actor, messages, database, applicationTimezone, tools, systemInstruction, requestId, logger }) {
      if (actor?.role !== "doctor") throw new AssistantError("FORBIDDEN", 403, "This account cannot use the doctor assistant");
      const transcript = messages.slice(-12).map(({ role, content }) => ({ role, content }));
      const results = [];
      const latestUserText = [...messages].reverse().find(({ role }) => role === "user")?.content || "";
      const nextAppointmentRequest = /\bnext\s+appointment\b/i.test(latestUserText);
      const requestNow = now();
      const applicationTimeZone = applicationTimezone || "Asia/Kolkata";
      let calls = 0;
      const requestsSpecificAssistedDetails = /\b(?:details?|alternatives?|suggestions?|more about|information about)\b/i.test(latestUserText)
        || /\b(?:for|about)\s+(?!all\b|each\b|every\b|pending\b|accepted\b|declined\b|expired\b|no\s+alternatives\b)[a-z][\w'-]*/i.test(latestUserText);
      const awaitingPatientResponse = /\b(?:awaiting|waiting\s+(?:on|for)|pending)\s+(?:(?:the|a)\s+)?patient(?:'s)?\s+response\b/i.test(latestUserText);
      if (isAllAppointmentsForDateRequest(latestUserText)) {
        const appointmentDate = resolveDateReference(dateReferences(latestUserText)[0], applicationTimeZone, requestNow);
        if (!appointmentDate) return { answer: "I couldn't resolve that appointment date. Please provide a valid date, including its year.", results: [] };
        try {
          const appointments = [];
          const uiActions = [];
          let offset = 0;
          let hasMore = true;
          for (let pageNumber = 0; hasMore && pageNumber < 1000; pageNumber += 1) {
            const page = await toolExecutor({ name: "get_doctor_appointments", args: { date: appointmentDate, limit: 50, offset }, actor, database, applicationTimezone: applicationTimeZone, now: requestNow });
            const pageAppointments = Array.isArray(page.appointments) ? page.appointments : [];
            appointments.push(...pageAppointments);
            if (Array.isArray(page.ui_actions)) uiActions.push(...page.ui_actions);
            hasMore = page.has_more === true;
            if (!hasMore) break;
            const nextOffset = Number.isInteger(page.next_offset) && page.next_offset > offset ? page.next_offset : offset + pageAppointments.length;
            if (nextOffset <= offset || pageNumber === 999) throw new Error("Appointment pagination did not complete");
            offset = nextOffset;
          }
          return {
            answer: appointments.length
              ? `I found ${appointments.length} appointment${appointments.length === 1 ? "" : "s"} for ${appointmentDate}.`
              : `There are no appointments on ${appointmentDate}.`,
            results: [{ tool: "get_doctor_appointments", data: { date: appointmentDate, appointments, has_more: false, next_offset: null }, ...(uiActions.length ? { ui_actions: uiActions } : {}) }],
          };
        } catch (error) {
          logger?.info?.("doctor_tool_failed", { requestId, category: error?.code || "tool_query_failed" });
          throw new AssistantError("DOCTOR_TOOL_QUERY_FAILED", 503, "I couldn't load the requested appointments. Please try again shortly.");
        }
      }
      const assistedRequestListing = !requestsSpecificAssistedDetails
        && /\b(?:show|list|display|get|find|review|all|what|which)\b/i.test(latestUserText)
        && /\bassisted[\s-]+reschedul(?:e|ing)\s+requests?\b/i.test(latestUserText);
      if (assistedRequestListing) {
        try {
          const items = [];
          let offset = 0;
          let hasMore = true;
          for (let pageNumber = 0; hasMore && pageNumber < 100; pageNumber += 1) {
            const page = await toolExecutor({ name: "get_doctor_assisted_reschedule_requests", args: { ...(awaitingPatientResponse ? { status: "pending_patient" } : {}), limit: 100, offset }, actor, database, applicationTimezone, now: requestNow });
            items.push(...(Array.isArray(page.items) ? page.items : []));
            hasMore = page.has_more === true;
            offset = Number.isInteger(page.next_offset) ? page.next_offset : offset + (Array.isArray(page.items) ? page.items.length : 0);
          }
          return {
            answer: items.length
              ? `I found ${items.length}${hasMore ? " or more" : ""} assisted rescheduling request${items.length === 1 ? "" : "s"}. The list shows each patient, affected appointment, request status, and patient response. Ask about a specific request for its details and saved alternatives.`
              : "There are no assisted rescheduling requests for your appointments.",
            results: [{ tool: "get_doctor_assisted_reschedule_requests", data: { items, has_more: hasMore, next_offset: hasMore ? offset : null } }],
          };
        } catch (error) {
          logger?.info?.("doctor_tool_failed", { requestId, category: error?.code || "tool_query_failed" });
          throw new AssistantError("DOCTOR_TOOL_QUERY_FAILED", 503, "I couldn't load the assisted rescheduling requests. Please try again shortly.");
        }
      }
      const availabilityDateReferences = dateReferences(latestUserText);
      const explicitAvailabilityRequest = /\b(?:availability|available\s+(?:times|slots)|open\s+slots?)\b/i.test(latestUserText);
      if (explicitAvailabilityRequest && availabilityDateReferences.length === 1) {
        const date = resolveDateReference(availabilityDateReferences[0], applicationTimezone || "Asia/Kolkata", requestNow);
        if (!date) return { answer: "I couldn't resolve that calendar date. Please provide a valid date, including its year.", results: [] };
        try {
          const toolNames = ["get_doctor_schedules", "get_doctor_schedule_exceptions", "get_doctor_schedule_conflicts", "get_doctor_nearest_slots"];
          const resultRows = [];
          const normalizedResults = [];
          for (const name of toolNames) {
            const data = await toolExecutor({ name, args: { from: date, to: date }, actor, database, applicationTimezone, now: requestNow });
            const { ui_actions: uiActions, ...modelData } = data;
            resultRows.push({ tool: name, data: modelData, ...(Array.isArray(uiActions) ? { ui_actions: uiActions } : {}) });
            normalizedResults.push(modelData);
          }
          let noticeIncluded = false;
          const results = resultRows.map((result) => {
            if (typeof result.data.notice !== "string") return result;
            if (noticeIncluded) {
              const { notice: _notice, ...data } = result.data;
              return { ...result, data };
            }
            noticeIncluded = true;
            return result;
          });
          const nearest = normalizedResults.at(-1);
          const slots = Array.isArray(nearest.slots) ? nearest.slots : [];
          const pending = Array.isArray(nearest.pending_assisted_reschedules) ? nearest.pending_assisted_reschedules : [];
          const answer = slots.length
            ? `I found ${slots.length} currently available appointment time${slots.length === 1 ? "" : "s"} on ${date}.`
            : `I found no currently available appointment times on ${date}.`;
          const affected = pending.map((item) => `A confirmed appointment at ${item.start_time}–${item.end_time} has an active assisted-rescheduling request awaiting patient response.`).join(" ");
          return { answer: affected ? `${answer} ${affected}` : answer, results };
        } catch (error) {
          logger?.info?.("doctor_tool_failed", { requestId, category: error?.code || "tool_query_failed" });
          throw new AssistantError("DOCTOR_TOOL_QUERY_FAILED", 503, "I couldn't load the requested appointment information. Please try again shortly.");
        }
      }
      const signal = AbortSignal.timeout(35000);
      for (let round = 0; round <= maxToolCalls; round += 1) {
        let completion;
        try { completion = await provider.generate({ messages: transcript, tools, systemInstruction, signal }); }
        catch (error) { throw new AssistantError("ASSISTANT_PROVIDER_UNAVAILABLE", 503, "The assistant is temporarily unavailable", { category: error?.category }); }
        if (!Array.isArray(completion.toolCalls) || completion.toolCalls.length === 0) {
          const answer = String(completion.text || "");
          if ([...answer].length > 4000) throw new AssistantError("ASSISTANT_RESPONSE_TOO_LONG", 502, "The assistant response was too long to save. Please retry your question.");
          const partialList = results.some(({ data }) => data?.has_more === true);
          const partialNotice = "This response contains only the returned page; additional appointments exist beyond this page.";
          const finalAnswer = partialList && !/only the returned page; additional appointments exist beyond this page/i.test(answer)
            ? `${answer}${answer ? "\n\n" : ""}${partialNotice}`
            : answer;
          if ([...finalAnswer].length > 4000) throw new AssistantError("ASSISTANT_RESPONSE_TOO_LONG", 502, "The assistant response was too long to save. Please retry your question.");
          let noticeIncluded = /availability can change; booking is not guaranteed\./i.test(finalAnswer);
          const finalResults = results.map((result) => {
            const notice = result.data?.notice;
            if (typeof notice !== "string") return result;
            if (noticeIncluded) {
              const { notice: _duplicateNotice, ...data } = result.data;
              return { ...result, data };
            }
            noticeIncluded = true;
            return result;
          });
          return { answer: finalAnswer, results: finalResults };
        }
        if (round === maxToolCalls || calls + completion.toolCalls.length > maxToolCalls) {
          throw new AssistantError("TOOL_LIMIT_EXCEEDED", 502, "Please narrow the request and try again");
        }
        transcript.push({ role: "assistant", providerContent: completion.providerContent });
        const toolResults = [];
        for (const call of completion.toolCalls) {
          calls += 1;
          try {
            const isAppointmentList = call.name === "get_doctor_appointments";
            const normalizedDateArgs = normalizeDoctorDateArguments(call.name, latestUserText, call.arguments, requestNow, applicationTimeZone);
            const requestUpcomingList = isAppointmentList && isUpcomingListRequest(latestUserText, normalizedDateArgs, dateInTimezone(requestNow, applicationTimeZone));
            const args = call.name === "get_doctor_appointment_statistics"
              ? normalizeStatisticsArguments(latestUserText, call.arguments, requestNow, applicationTimeZone)
              : isAppointmentList && nextAppointmentRequest
              ? { scope: "nearest", status: "confirmed" }
              : requestUpcomingList
                ? { ...normalizedDateArgs, scope: "upcoming", status: "confirmed" }
                : normalizedDateArgs;
            const data = await toolExecutor({ name: call.name, args, actor, database, applicationTimezone: applicationTimeZone, now: requestNow });
            const { ui_actions: uiActions, ...modelData } = data;
            results.push({ tool: call.name, data: modelData, ...(Array.isArray(uiActions) ? { ui_actions: uiActions } : {}) });
            toolResults.push({ name: call.name, id: call.id, result: modelData });
          } catch (error) {
            logger?.info?.("doctor_tool_failed", { requestId, category: error?.code || "tool_query_failed" });
            throw new AssistantError("DOCTOR_TOOL_QUERY_FAILED", 503, "I couldn't load the requested appointment information. Please try again shortly.");
          }
        }
        transcript.push({ role: "user", toolResults });
      }
      throw new AssistantError("ASSISTANT_PROVIDER_UNAVAILABLE", 503, "The assistant is temporarily unavailable");
    },
  };
}

module.exports = { createDoctorConversationEngine, normalizeDoctorDateArguments, normalizeStatisticsArguments, previousWeekRange };
