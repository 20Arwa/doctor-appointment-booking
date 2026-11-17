function normalizeTimeReference(value) {
  const meridiem = value.match(/\s*([ap])\.?m\.?$/i)?.[1]?.toLowerCase();
  const time = value.replace(/\s*[ap]\.?m\.?$/i, "").trim();
  const [hourText, minute = "00"] = time.split(":");
  let hour = Number(hourText);
  if (meridiem) hour = hour % 12 + (meridiem === "p" ? 12 : 0);
  return `${String(hour).padStart(2, "0")}:${minute}`;
}

function timeInterpretations(value) {
  const normalized = normalizeTimeReference(value);
  if (/\s*[ap]\.?m\.?$/i.test(value)) return [normalized];
  const [hourText, minute] = normalized.split(":");
  const hour = Number(hourText);
  if (hour < 1 || hour > 12) return [normalized];
  return [...new Set([`${String(hour % 12).padStart(2, "0")}:${minute}`, `${String((hour % 12) + 12).padStart(2, "0")}:${minute}`])];
}

function timeReferences(text) {
  const pattern = /\b(?:1[0-2]|0?[1-9])(?::[0-5]\d)?\s*[ap]\.?m\.?(?=\s|$|[-–—.,!?])|\b(?:[01]?\d|2[0-3]):[0-5]\d(?::[0-5]\d)?\b/gi;
  const references = [...text.matchAll(pattern)].map((match) => ({ value: normalizeTimeReference(match[0]), candidates: timeInterpretations(match[0]), explicitMeridiem: /\s*[ap]\.?(?:m)?\.?$/i.test(match[0]), index: match.index, endIndex: match.index + match[0].length }));
  for (const match of text.matchAll(/\b(?:at|around|about|from|to|until)\s+(1[0-2]|0?[1-9])\b(?!\s*(?::\d|[ap]\.?(?:m)\b|jan(?:uary)?\b|feb(?:ruary)?\b|mar(?:ch)?\b|apr(?:il)?\b|may\b|jun(?:e)?\b|jul(?:y)?\b|aug(?:ust)?\b|sep(?:tember)?\b|oct(?:ober)?\b|nov(?:ember)?\b|dec(?:ember)?\b))/gi)) {
    const value = match[1];
    const index = match.index + match[0].lastIndexOf(value);
    if (references.some((reference) => index >= reference.index && index < reference.endIndex)) continue;
    references.push({ value: normalizeTimeReference(value), candidates: timeInterpretations(value), explicitMeridiem: false, index, endIndex: index + value.length });
  }
  return references.sort((first, second) => first.index - second.index);
}

function hasContradictoryMeridiem(text) {
  return /\b(?:1[0-2]|0?[1-9])(?::[0-5]\d)?\s*(?:a\.?m\.?|p\.?m\.?)\s*(?:(?:or|and)\s*)?(?:a\.?m\.?|p\.?m\.?)\b/i.test(String(text || ""));
}

function pairedTimeCandidates(first, second) {
  let start = first.candidates;
  let end = second.candidates;
  const meridiem = (value) => Number(value.slice(0, 2)) >= 12 ? "pm" : "am";
  if (first.explicitMeridiem && !second.explicitMeridiem) end = end.filter((value) => meridiem(value) === meridiem(start[0]));
  if (second.explicitMeridiem && !first.explicitMeridiem) start = start.filter((value) => meridiem(value) === meridiem(end[0]));
  return { start, end };
}

function timeRangeTarget(text, times) {
  for (let index = 0; index < times.length - 1; index += 1) {
    const between = text.slice(times[index].endIndex, times[index + 1].index);
    if (times[index + 1] === times.at(-1) && /^\s*(?:-|–|—|to|until)\s*$/i.test(between)) {
      const candidates = pairedTimeCandidates(times[index], times[index + 1]);
      return { start: { ...times[index], candidates: candidates.start }, end: { ...times[index + 1], candidates: candidates.end } };
    }
  }
  return times.length ? { start: times.at(-1), end: null } : null;
}

function selectedAppointmentTimes(text, refs) {
  for (let index = 0; index < refs.length - 1; index += 1) {
    const between = text.slice(refs[index].endIndex, refs[index + 1].index);
    if (/^\s*(?:-|–|—|to|until)\s*$/i.test(between)) return pairedTimeCandidates(refs[index], refs[index + 1]);
  }
  return refs.length === 1 ? { start: refs[0].candidates } : null;
}

function dateReferences(text) {
  const references = [];
  for (const match of text.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) references.push({ iso: match[0], index: match.index, endIndex: match.index + match[0].length });
  const months = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
  const pattern = months.map((month) => `${month.slice(0, 3)}(?:${month.slice(3)})?`).join("|");
  for (const [regex, monthIndex, dayIndex, yearIndex] of [
    [new RegExp(`\\b(${pattern})\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b`, "gi"), 1, 2, 3],
    [new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${pattern})(?:,?\\s+(\\d{4}))?\\b`, "gi"), 2, 1, 3],
  ]) {
    for (const match of text.matchAll(regex)) {
      const monthName = match[monthIndex].toLowerCase().slice(0, 3);
      const month = String(months.findIndex((name) => name.startsWith(monthName)) + 1).padStart(2, "0");
      references.push({ month, day: String(Number(match[dayIndex])).padStart(2, "0"), year: match[yearIndex], index: match.index, endIndex: match.index + match[0].length });
    }
  }
  for (const match of text.matchAll(/\b(day after tomorrow|tomorrow|today)\b/gi)) references.push({ relativeDays: match[1].toLowerCase() === "today" ? 0 : match[1].toLowerCase() === "tomorrow" ? 1 : 2, index: match.index, endIndex: match.index + match[0].length });
  const nonOverlapping = [];
  for (const reference of references.sort((first, second) => first.index - second.index || second.endIndex - first.endIndex)) {
    if (!nonOverlapping.some((existing) => reference.index < existing.endIndex && existing.index < reference.endIndex)) nonOverlapping.push(reference);
  }
  return nonOverlapping;
}

function partialCalendarDate(text) {
  const value = String(text || "");
  const months = "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
  const dateFound = dateReferences(value).some((reference) => reference.month && reference.day);
  if (dateFound) return null;
  // Speech recognition can insert filler or substitute short words between a
  // month and its day/year. Treat an unparsed month mention as incomplete so
  // a pending date question can clarify it instead of starting a new search.
  const match = value.match(new RegExp(`\\b(${months})\\b`, "i"));
  if (!match) return null;
  const month = match[1];
  const suffix = value.slice(match.index + match[0].length);
  const yearMatch = suffix.match(/^\s+(\d{4})\b/);
  if (yearMatch && Number(yearMatch[1]) >= 1000 && Number(yearMatch[1]) <= 9999) {
    return { kind: "missing_day", month, year: yearMatch[1] };
  }
  return { kind: "malformed", month, value: value.trim() };
}

function dateReferenceMatches(reference, date) {
  if (!date) return false;
  if (reference.iso) return reference.iso === String(date).slice(0, 10);
  const [year, month, day] = String(date).slice(0, 10).split("-");
  return reference.month === month && reference.day === day && (!reference.year || reference.year === year);
}

function resolveDateReference(reference, timeZone = "Asia/Kolkata", nowValue = Date.now()) {
  if (!reference) return null;
  if (reference.iso) {
    const [year, month, day] = reference.iso.split("-").map(Number);
    const check = new Date(Date.UTC(year, month - 1, day));
    return check.getUTCFullYear() === year && check.getUTCMonth() === month - 1 && check.getUTCDate() === day ? reference.iso : null;
  }
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(nowValue));
  const current = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  if (Number.isInteger(reference.relativeDays)) {
    const date = new Date(Date.UTC(Number(current.year), Number(current.month) - 1, Number(current.day) + reference.relativeDays));
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
  }
  if (reference.year) {
    const year = Number(reference.year), month = Number(reference.month), day = Number(reference.day);
    const check = new Date(Date.UTC(year, month - 1, day));
    return check.getUTCFullYear() === year && check.getUTCMonth() === month - 1 && check.getUTCDate() === day
      ? `${reference.year}-${reference.month}-${reference.day}` : null;
  }
  let year = Number(current.year);
  if (`${year}-${reference.month}-${reference.day}` < `${current.year}-${current.month}-${current.day}`) year += 1;
  const month = Number(reference.month), day = Number(reference.day);
  const check = new Date(Date.UTC(year, month - 1, day));
  return check.getUTCMonth() === month - 1 && check.getUTCDate() === day ? `${year}-${reference.month}-${reference.day}` : null;
}

module.exports = { dateReferenceMatches, dateReferences, hasContradictoryMeridiem, normalizeTimeReference, pairedTimeCandidates, partialCalendarDate, resolveDateReference, selectedAppointmentTimes, timeInterpretations, timeRangeTarget, timeReferences };
