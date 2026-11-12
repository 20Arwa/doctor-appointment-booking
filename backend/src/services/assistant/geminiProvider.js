const { GoogleGenAI } = require("@google/genai");
const GEMINI_REQUEST_TIMEOUT_MS = 30000;

function readRetryAfterMs(headers, now = Date.now) {
  const retryAfterMs = headers.get("retry-after-ms");
  if (retryAfterMs !== null) {
    const value = Number(retryAfterMs);
    if (Number.isFinite(value) && value >= 0) return value;
  }
  const retryAfter = headers.get("retry-after");
  if (!retryAfter) return undefined;
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(retryAfter);
  return Number.isFinite(date) ? Math.max(0, date - now()) : undefined;
}

function createGeminiProvider({ apiKey, model = "gemini-3.8-flash", client } = {}) {
  return {
    requestTimeoutMs: GEMINI_REQUEST_TIMEOUT_MS,
    async generate({ messages, tools, systemInstruction, signal }) {
      if (!apiKey && !client) throw Object.assign(new Error("Assistant provider is not configured"), { status: 503 });
      // The bounded request timeout also sets Gemini's server timeout header.
      let retryAfterMs;
      const fetchWithRetryMetadata = async (...args) => {
        const response = await fetch(...args);
        if (response.status === 503) retryAfterMs = readRetryAfterMs(response.headers);
        return response;
      };
      const ai = client || new GoogleGenAI({ apiKey, httpOptions: { timeout: GEMINI_REQUEST_TIMEOUT_MS, retryOptions: { attempts: 1 }, fetch: fetchWithRetryMetadata } });
      const contents = messages.map((message) => {
        // Function-call turns must be echoed exactly as returned by Gemini,
        // including thought signatures and any additional response parts.
        if (message.providerContent) return message.providerContent;
        if (message.toolResults) return {
          role: "user",
          parts: message.toolResults.map(({ name, id, result }) => ({ functionResponse: { name, id, response: result } })),
        };
        const parts = [];
        if (message.content) parts.push({ text: message.content });
        for (const call of message.toolCalls || []) {
          parts.push({ functionCall: { name: call.name, args: call.arguments, id: call.id } });
        }
        return { role: message.role === "assistant" ? "model" : "user", parts };
      });
      const declarations = tools.map(({ name, description, parameters }) => ({ name, description, parameters }));
      let response;
      try {
        response = await ai.models.generateContent({
          model,
          contents,
          config: {
            systemInstruction,
            maxOutputTokens: 512,
            tools: [{ functionDeclarations: declarations }],
            abortSignal: signal,
          },
        });
      } catch (error) {
        const safe = new Error("Gemini request failed");
        safe.status = error?.status || error?.statusCode;
        safe.category = Number.isFinite(Number(safe.status)) ? "provider_http_error" : error?.name === "AbortError" ? "sdk_timeout" : "provider_error";
        safe.retryAfterMs = Number.isFinite(error?.retryAfterMs) ? error.retryAfterMs : retryAfterMs;
        safe.name = error?.name;
        throw safe;
      }
      const providerContent = response?.candidates?.[0]?.content;
      const candidateParts = providerContent?.parts;
      if (!Array.isArray(candidateParts)) throw new Error("Gemini response did not contain a candidate");
      return {
        text: candidateParts.filter((part) => typeof part.text === "string").map((part) => part.text).join("\n"),
        toolCalls: candidateParts.filter((part) => part.functionCall).map(({ functionCall }) => ({
          name: functionCall.name,
          arguments: functionCall.args,
          id: functionCall.id,
        })),
        providerContent,
      };
    },
  };
}

module.exports = { createGeminiProvider, readRetryAfterMs };
