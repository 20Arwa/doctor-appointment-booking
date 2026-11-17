export function formatDateOnly(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return value;
  const [, yearText, monthText, dayText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return value;
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(date);
}

export function dateNavigationTarget(value: string | null, fallback: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || "");
  const candidate = match ? new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))) : null;
  const valid = Boolean(candidate && candidate.getUTCFullYear() === Number(match?.[1]) && candidate.getUTCMonth() === Number(match?.[2]) - 1 && candidate.getUTCDate() === Number(match?.[3]));
  const date = valid ? value! : fallback;
  return { date, month: `${date.slice(0, 7)}-01` };
}

export function formatInstantDate(value: Date, timeZone = "Asia/Kolkata") {
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone }).format(value);
}
