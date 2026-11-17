const { AssistantError } = require("./conversationEngine");

function dateInTimezone(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
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
      let calls = 0;
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
          return { answer: finalAnswer, results };
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
            const requestUpcomingList = isAppointmentList && isUpcomingListRequest(latestUserText, call.arguments, dateInTimezone(requestNow, "Asia/Kolkata"));
            const args = isAppointmentList && nextAppointmentRequest
              ? { scope: "nearest", status: "confirmed" }
              : requestUpcomingList
                ? { ...call.arguments, scope: "upcoming", status: "confirmed" }
                : call.arguments;
            const data = await toolExecutor({ name: call.name, args, actor, database, applicationTimezone, now: requestNow });
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

module.exports = { createDoctorConversationEngine };
