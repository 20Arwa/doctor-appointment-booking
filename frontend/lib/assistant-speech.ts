/** Convert assistant Markdown into concise text for speech synthesis. */
type SpeechResult = { tool: string; data: Record<string, unknown> };

function validSpeechTime(value: unknown): value is string {
  return typeof value === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(value);
}

function spokenDate(yearText: string, monthText: string, dayText: string): string {
  const date = new Date(Date.UTC(Number(yearText), Number(monthText) - 1, Number(dayText)));
  if (date.getUTCFullYear() !== Number(yearText) || date.getUTCMonth() !== Number(monthText) - 1 || date.getUTCDate() !== Number(dayText)) return `${yearText}-${monthText}-${dayText}`;
  return new Intl.DateTimeFormat("en-IN", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(date);
}

export function assistantSpeechText(markdown: string): string {
  const text = markdown
    .replace(/\\([\\`*_{}\[\]()#+\-.!>])/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\((?:<[^>]*>|[^)]*)\)/g, "$1")
    .replace(/\bhttps?:\/\/\S+/gi, "")
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/```[\w-]*\n?|```/g, " "))
    .replace(/`([^`]*)`/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/^\s*[-+*]\s+/gm, "")
    .replace(/[*_~]{1,3}/g, "")
    .replace(/<[^>]*>/g, "")
    .replace(/\|/g, " ")
    .replace(/₹\s*([\d,]+(?:\.\d+)?)/g, "$1 rupees")
    .replace(/\bINR\s*([\d,]+(?:\.\d+)?)/gi, "$1 rupees")
    .replace(/\$\s*([\d,]+(?:\.\d+)?)/g, "$1 dollars")
    .replace(/\bUSD\s*([\d,]+(?:\.\d+)?)/gi, "$1 dollars")
    .replace(/(\d+(?:\.\d+)?)\s*%/g, "$1 percent")
    .replace(/\b(\d{4})-(\d{2})-(\d{2})\b/g, (_match, year: string, month: string, day: string) => spokenDate(year, month, day))
    .replace(/\b(?:(?:Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday)\s*,?\s*)?(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})(?:st|nd|rd|th)?[,]?\s+(\d{4})\b/gi, (_match, monthName: string, day: string, year: string) => {
      const month = String(["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"].indexOf(monthName.toLowerCase()) + 1).padStart(2, "0");
      return spokenDate(year, month, day);
    })
    .replace(/\b(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday)(,\s+\d{1,2}\s+[A-Z][a-z]+\s+\d{4}),\s+\1\b/gi, "$1$2")
    .replace(/\b(\d{1,2}):(\d{2})(?::\d{2})?\b/g, (_match, hourText: string, minute: string) => {
      const hour = Number(hourText);
      if (hour > 23 || Number(minute) > 59) return _match;
      return `${hour % 12 || 12}${minute === "00" ? "" : `:${minute}`} ${hour >= 12 ? "PM" : "AM"}`;
    })
    .replace(/\s*[–—]\s*/g, " to ")
    .replace(/[\t ]+/g, " ")
    .replace(/\s*\n\s*/g, ". ")
    .replace(/\.{2,}/g, ".")
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/([.;!?])(?=\S)/g, "$1 ")
    .trim();
  return text;
}

/** Add the user-visible facts from result cards after their shared chat introduction. */
export function assistantResultCardSpeech(results: SpeechResult[]): string {
  const chunks: string[] = [];
  for (const result of results) {
    if (Array.isArray(result.data.pending_assisted_reschedules)) {
      for (const value of result.data.pending_assisted_reschedules) {
        if (!value || typeof value !== "object") continue;
        const item = value as Record<string, unknown>;
        chunks.push(`Confirmed appointment awaiting assisted rescheduling: ${String(item.date || "")}, ${String(item.start_time || "")} to ${String(item.end_time || "")}, with ${String(item.valid_suggestion_count || 0)} current alternatives`);
      }
    }
    const rows = result.data.appointments || result.data.items || result.data.doctors || result.data.slots
      || result.data.schedules || result.data.exceptions || result.data.conflicts;
    if (!Array.isArray(rows)) continue;
    for (const value of rows) {
      if (!value || typeof value !== "object") continue;
      const item = value as Record<string, unknown>;
      const doctor = item.doctor && typeof item.doctor === "object" ? item.doctor as Record<string, unknown> : undefined;
      const appointment = item.appointment && typeof item.appointment === "object" ? item.appointment as Record<string, unknown> : undefined;
      const paymentDoctor = appointment?.doctor && typeof appointment.doctor === "object" ? appointment.doctor as Record<string, unknown> : undefined;
      const appointmentTime = validSpeechTime(item.start_time) ? item.start_time
        : validSpeechTime(appointment?.start_time) ? appointment.start_time : null;
      const pieces = [
        typeof doctor?.name === "string" ? doctor.name : typeof paymentDoctor?.name === "string" ? paymentDoctor.name : typeof item.name === "string" ? item.name : "",
        typeof item.specialty === "string" ? item.specialty : "",
        typeof item.date === "string" ? item.date : typeof appointment?.date === "string" ? appointment.date : "",
        appointmentTime ? `at ${appointmentTime}${validSpeechTime(item.end_time) ? ` to ${item.end_time}` : validSpeechTime(appointment?.end_time) ? ` to ${appointment.end_time}` : ""}` : "",
        typeof item.status === "string" ? item.status.replaceAll("_", " ") : "",
        typeof item.mode === "string" && item.mode !== "legacy" ? item.mode : "",
        item.source === "private_one_off" ? "private one-off availability" : "",
      ].filter(Boolean);
      if (typeof item.remaining_capacity === "number" && typeof item.capacity === "number") pieces.push(`${item.remaining_capacity} of ${item.capacity} places remaining`);
      if (typeof item.consultation_fee === "number") pieces.push(`Consultation fee INR ${item.consultation_fee}`);
      if (typeof item.amount === "string" || typeof item.amount === "number") pieces.push(`Payment ${String(item.status || "")} ${String(item.currency || "INR")} ${String(item.amount)}`);
      if (Array.isArray(item.periods)) {
        for (const periodValue of item.periods) {
          if (!periodValue || typeof periodValue !== "object") continue;
          const period = periodValue as Record<string, unknown>;
          const weekday = typeof period.weekday === "number" ? ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][period.weekday] : "";
          pieces.push(`${typeof period.service_date === "string" ? period.service_date : weekday}: ${String(period.start_time || "")} to ${String(period.end_time || "")}`);
        }
      }
      if (pieces.length) chunks.push(pieces.join(", "));
    }
  }
  return chunks.join(". ");
}

export function assistantResponseSpeechText(displayText: string, results: SpeechResult[]): string {
  const cardText = assistantResultCardSpeech(results);
  const separator = /[:;,.!?]$/.test(displayText.trim()) ? " " : ". ";
  return assistantSpeechText([displayText, cardText].filter(Boolean).join(separator));
}
