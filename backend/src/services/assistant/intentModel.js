const { z } = require("zod");

const canonicalIntentSchema = z.object({
  category: z.enum(["doctor_search", "availability", "booking", "rescheduling", "cancellation", "refund_preview", "appointment_history", "unknown"]),
  historyScope: z.enum(["next_upcoming", "all_upcoming", "past", "last", "last_completed", "cancelled"]).nullable(),
  historyQuery: z.object({
    view: z.enum(["upcoming", "past", "cancelled"]),
    scope: z.enum(["all", "nearest", "next_days", "last", "last_completed"]),
    from: z.string().optional(),
    to: z.string().optional(),
  }).nullable(),
  reference: z.enum(["pronoun", "ordinal", "numeric", "demonstrative", "explicit", "none"]),
  timePrecision: z.enum(["exact", "approximate", "unspecified"]),
  timeInterpretation: z.enum(["explicit", "ambiguous", "none"]),
  sourceTimeCount: z.number().int().nonnegative(),
  targetTimeCount: z.number().int().nonnegative(),
});

function recognizeAppointmentHistory(text, timeZone = "Asia/Kolkata", nowValue = Date.now()) {
  const value = String(text || "").toLowerCase();
  if (!/\b(?:appointment|visit|booking)s?\b/.test(value)) return null;
  if (/\b(?:cancelled|canceled)\b/.test(value)) return { view: "cancelled", scope: "all" };
  if (/\b(?:last|most recent)\b/.test(value) && /\bcompleted\b/.test(value)) return { view: "past", scope: "last_completed" };
  if (/\blast week\b/.test(value)) {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short" }).formatToParts(new Date(nowValue));
    const current = Object.fromEntries(parts.map(({ type, value: part }) => [type, part]));
    const weekday = new Date(`${current.year}-${current.month}-${current.day}T12:00:00Z`).getUTCDay();
    const mondayOffset = weekday === 0 ? -6 : 1 - weekday;
    const shift = (days) => { const date = new Date(Date.UTC(+current.year, +current.month - 1, +current.day + days)); return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`; };
    const monday = shift(mondayOffset - 7);
    return { view: "past", scope: "all", from: monday, to: shift(mondayOffset - 1) };
  }
  if (/\b(?:last|most recent|previous)\b/.test(value)) return { view: "past", scope: "last" };
  if (/\b(?:past|previous|history|before now)\b/.test(value)) return { view: "past", scope: "all" };
  if (/\b(?:next|nearest)\b/.test(value)) return { view: "upcoming", scope: "nearest" };
  if (/\b(?:upcoming|future)\b/.test(value)) return /\bappointment\b(?!s\b)/.test(value) ? { view: "upcoming", scope: "nearest" } : { view: "upcoming", scope: "all" };
  if (/\b(?:all|every|list|show|display)\b/.test(value) && /\b(?:my|upcoming|future)\b/.test(value)) return { view: "upcoming", scope: "all" };
  return null;
}

function isCancellationRequest(value) {
  const requestsCancellation = /^\s*(?:please\s+)?cancel\b/i.test(value)
    || /\b(?:i(?:'d| would| want| need)?|can you|could you|would you|please|help me)[\s\S]{0,35}\bcancel(?:ling)?\b/i.test(value)
    || /\b(?:request|prepare)\s+(?:a\s+)?cancellation\b/i.test(value);
  return requestsCancellation
    && !/\b(?:refund|refunded|reimburse|reimbursement|money back)\b/i.test(value)
    && !/\b(?:policy|policies|fee|window|rules?)\b/i.test(value);
}

function recognizeCanonicalIntent(text, timeZone = "Asia/Kolkata", nowValue = Date.now()) {
  const value = String(text || "");
  const historyQuery = recognizeAppointmentHistory(value, timeZone, nowValue);
  const refundRequest = /\b(?:refund|refunded|reimburse|reimbursement|money back)\b/i.test(value);
  const cancelledHistory = historyQuery?.view === "cancelled";
  const cancellationRequest = isCancellationRequest(value);
  const reschedulingRequest = /\b(?:reschedule|move|change)\b/i.test(value)
    && /\b(?:appointment|booking|it|my|one|first|second|third|this|that)\b/i.test(value);
  const bookingRequest = /\b(?:book|schedule)\b/i.test(value)
    && (/\b(?:appointment|doctor|slot|time)\b/i.test(value) || /\bDr\.?\s+/i.test(value));
  // Mixed requests are routed safely: refund questions are always read-only,
  // cancelled-history wording remains history, and mutations precede generic history.
  const category = refundRequest ? "refund_preview"
      : cancelledHistory ? "appointment_history"
        : cancellationRequest ? "cancellation"
          : reschedulingRequest ? "rescheduling"
            : bookingRequest ? "booking"
              : historyQuery ? "appointment_history"
                : /\b(?:available|availability|slots?)\b/i.test(value) ? "availability"
                  : /\bdoctor|physician\b|\bDr\.?\s+[\p{L}]/iu.test(value) ? "doctor_search" : "unknown";
  const reference = /^\s*\d{1,2}\s*$/.test(value) ? "numeric"
    : /\b(?:first|second|third|fourth|fifth|last)\s+(?:one|appointment|slot|option)\b/i.test(value) ? "ordinal"
      : /\b(?:him|her|them)\b/i.test(value) ? "pronoun"
        : /\b(?:this|that)\s+(?:appointment|slot|doctor|one)\b/i.test(value) ? "demonstrative"
          : category === "unknown" ? "none" : "explicit";
  const times = [...value.matchAll(/\b(?:\d{1,2}(?::\d{2})?\s*[ap]\.?m\.?|(?:[01]?\d|2[0-3]):[0-5]\d)\b/gi)];
  const rangeIndex = value.search(/\b(?:to|until|for)\b|[-–—]/i);
  const model = {
    category,
    historyScope: historyQuery ? (historyQuery.scope === "nearest" ? "next_upcoming" : historyQuery.scope === "all" && historyQuery.view === "upcoming" ? "all_upcoming" : historyQuery.scope === "all" ? (historyQuery.view === "cancelled" ? "cancelled" : "past") : historyQuery.scope) : null,
    historyQuery,
    reference,
    timePrecision: /\b(?:around|about|approximately|roughly|near)\b/i.test(value) ? "approximate" : times.length ? "exact" : "unspecified",
    timeInterpretation: times.length === 0 ? "none" : times.some((match) => /\b(?:1[0-2]|0?[1-9])(?::[0-5]\d)?\b/.test(match[0]) && !/[ap]\.?m\.?/i.test(match[0])) ? "ambiguous" : "explicit",
    sourceTimeCount: category === "rescheduling" && rangeIndex >= 0 ? Math.min(times.length, 1) : 0,
    targetTimeCount: category === "rescheduling" && rangeIndex >= 0 ? Math.max(times.length - 1, 0) : times.length,
  };
  return canonicalIntentSchema.parse(model);
}

module.exports = { canonicalIntentSchema, isCancellationRequest, recognizeAppointmentHistory, recognizeCanonicalIntent };
