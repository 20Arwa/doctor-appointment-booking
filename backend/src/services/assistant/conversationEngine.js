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

function createConversationEngine({ provider, toolExecutor, logger = console, now = Date.now, deadlineMs = 35000 }) {
  return {
    async respond({ actor, messages, database, applicationTimezone, tools = [], systemInstruction = "", requestId = "unknown", logger: requestLogger = logger }) {
      // This history is loaded from the server-owned conversation record.
      const transcript = messages.slice(-12).map((message) => ({ ...message }));
      let calls = 0;
      let providerAttempts = 0;
      let providerRetries = 0;
      const usedResults = [];
      const started = now();
      const signal = AbortSignal.timeout(deadlineMs);
      const log = (stage, error, attempt = 0, category) => {
        const status = Number(error?.providerStatus || error?.status || error?.statusCode || 0);
        const errorCategory = category || error?.category || (status ? `provider_http_${status}` : undefined);
        requestLogger?.info?.(stage, { requestId, attempt, elapsedMs: now() - started, ...(errorCategory ? { category: errorCategory } : {}), ...(status ? { providerStatus: status } : {}) });
      };
      log("started");
      try {
        while (calls <= 3) {
          let completion;
          while (true) {
            providerAttempts += 1;
            log("provider_request", undefined, providerAttempts);
            try {
              completion = await withDeadline(provider.generate({ messages: transcript, tools, systemInstruction, signal }), signal);
              break;
            } catch (error) {
              if (!signal.aborted && providerStatus(error) === 503 && providerRetries === 0) {
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
            const answer = completion.text.trim();
            if (!answer) throw new AssistantError("PROVIDER_INVALID_RESPONSE", 502, "The assistant returned an empty response. Please try again.");
            log("completed");
            return { answer, results: usedResults };
          }
          if (calls + completion.toolCalls.length > 3) throw new AssistantError("TOOL_LIMIT_EXCEEDED", 502, "This question needs too many data lookups. Please narrow it and try again.");
          if (completion.toolCalls.some((call) => typeof call.name !== "string" || !call.name || !call.arguments || typeof call.arguments !== "object" || Array.isArray(call.arguments))) {
            throw new AssistantError("INVALID_TOOL_CALL", 502, "The assistant could not safely process that request. Please rephrase it and try again.");
          }
          transcript.push({
            role: "assistant",
            content: completion.text,
            toolCalls: completion.toolCalls,
            providerContent: completion.providerContent,
          });
          const results = [];
          for (const call of completion.toolCalls) {
            calls += 1;
            try {
              log("tool_execution");
              const result = await withDeadline(toolExecutor({ name: call.name, args: call.arguments, actor, database, applicationTimezone }), signal);
              usedResults.push({ tool: call.name, data: result });
              results.push({ name: call.name, id: call.id, result });
            } catch (error) {
              if (signal.aborted) throw error;
              results.push({ name: call.name, id: call.id, result: { error: error.code === "INVALID_TOOL_ARGUMENTS" ? "The lookup arguments were invalid. Ask the patient to clarify." : "The requested data could not be loaded." } });
            }
          }
          transcript.push({ role: "user", toolResults: results });
        }
        throw new AssistantError("TOOL_LIMIT_EXCEEDED", 502, "The assistant could not complete this lookup. Please try again.");
      } catch (error) {
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
        const category = status ? `provider_http_${status}` : error?.category || "provider_error";
        log("provider_error", error, providerAttempts, category);
        if (status === 429) throw new AssistantError("ASSISTANT_RATE_LIMITED", 503, "The assistant is busy right now. Please try again shortly.", { category, providerStatus: status, attempt: providerAttempts });
        if (status === 401 || status === 403) throw new AssistantError("ASSISTANT_CONFIGURATION_ERROR", 503, "The assistant is temporarily unavailable. Please try again shortly.", { category, providerStatus: status, attempt: providerAttempts });
        if (status === 503) throw new AssistantError("ASSISTANT_PROVIDER_UNAVAILABLE", 503, "The assistant provider is temporarily unavailable. Please try again shortly.", { category, providerStatus: status, attempt: providerAttempts });
        if (status === 504) throw new AssistantError("ASSISTANT_PROVIDER_GATEWAY_TIMEOUT", 504, "The assistant provider gateway timed out. Please retry.", { category, providerStatus: status, attempt: providerAttempts });
        throw new AssistantError("ASSISTANT_UNAVAILABLE", 503, "The assistant is temporarily unavailable. Please try again shortly.", { category, providerStatus: status || undefined, attempt: providerAttempts });
      }
    },
  };
}

module.exports = { AssistantError, createConversationEngine };
