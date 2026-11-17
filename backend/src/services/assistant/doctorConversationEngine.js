const { AssistantError } = require("./conversationEngine");

function createDoctorConversationEngine({ provider, toolExecutor, maxToolCalls = 4 }) {
  return {
    async respond({ actor, messages, database, applicationTimezone, tools, systemInstruction, requestId, logger }) {
      if (actor?.role !== "doctor") throw new AssistantError("FORBIDDEN", 403, "This account cannot use the doctor assistant");
      const transcript = messages.slice(-12).map(({ role, content }) => ({ role, content }));
      const results = [];
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
            const data = await toolExecutor({ name: call.name, args: call.arguments, actor, database, applicationTimezone });
            results.push({ tool: call.name, data });
            toolResults.push({ name: call.name, id: call.id, result: data });
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
