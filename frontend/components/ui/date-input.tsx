"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";

function parseDate(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const [, year, month, day] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  return date.getUTCFullYear() === Number(year) && date.getUTCMonth() === Number(month) - 1
    && date.getUTCDate() === Number(day) ? date : null;
}

export function formatDateInput(value: string) {
  const date = parseDate(value);
  return date ? new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(date) : "";
}

function parseDisplayDate(value: string) {
  const match = /^(\d{1,2}) ([A-Za-z]{3}) (\d{4})$/.exec(value.trim());
  if (!match) return null;
  const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
    .findIndex((name) => name.toLowerCase() === match[2].toLowerCase()) + 1;
  if (month < 1) return null;
  const date = `${match[3]}-${String(month).padStart(2, "0")}-${String(Number(match[1])).padStart(2, "0")}`;
  return parseDate(date) ? date : null;
}

function todayInApplicationZone() {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(new Date());
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function shiftMonth(value: string, amount: number) {
  const [year, month] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1 + amount, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

function monthWithinBounds(value: string, min?: string, max?: string) {
  const fallback = parseDate(min ?? "") ? min! : parseDate(max ?? "") ? max! : todayInApplicationZone();
  const selected = parseDate(value) ? value : fallback;
  let month = `${selected.slice(0, 7)}-01`;
  const minMonth = min && parseDate(min) ? `${min.slice(0, 7)}-01` : null;
  const maxMonth = max && parseDate(max) ? `${max.slice(0, 7)}-01` : null;
  if (minMonth && month < minMonth) month = minMonth;
  if (maxMonth && month > maxMonth) month = maxMonth;
  return month;
}

export type DateInputProps = {
  id?: string;
  name?: string;
  value?: string;
  defaultValue?: string;
  onChange?: (value: string) => void;
  min?: string;
  max?: string;
  required?: boolean;
  disabled?: boolean;
  className?: string;
  placeholder?: string;
  "aria-invalid"?: boolean;
  "aria-describedby"?: string;
};

export function DateInput({ id, name, value, defaultValue = "", onChange, min, max, required, disabled, className, placeholder = "Select date", ...aria }: DateInputProps) {
  const [internalValue, setInternalValue] = useState(defaultValue);
  const [draftOverride, setDraftOverride] = useState<{ sourceValue: string; text: string } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const currentValue = value ?? internalValue;
  const draft = draftOverride?.sourceValue === currentValue ? draftOverride.text : formatDateInput(currentValue);
  const initialMonth = currentValue || min || todayInApplicationZone();
  const [visibleMonth, setVisibleMonth] = useState(`${initialMonth.slice(0, 7)}-01`);
  const visibleRangeKey = `${currentValue}\u0000${min ?? ""}\u0000${max ?? ""}`;
  const [synchronizedRangeKey, setSynchronizedRangeKey] = useState(visibleRangeKey);
  if (synchronizedRangeKey !== visibleRangeKey) {
    setSynchronizedRangeKey(visibleRangeKey);
    setVisibleMonth(monthWithinBounds(currentValue || min || todayInApplicationZone(), min, max));
  }
  const parsedMonth = parseDate(visibleMonth) ?? parseDate(todayInApplicationZone())!;
  const year = parsedMonth.getUTCFullYear();
  const month = parsedMonth.getUTCMonth();
  const firstWeekday = new Date(Date.UTC(year, month, 1)).getUTCDay();
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const dates = useMemo(() => Array.from({ length: firstWeekday + daysInMonth }, (_, index) =>
    index < firstWeekday ? null : `${year}-${String(month + 1).padStart(2, "0")}-${String(index - firstWeekday + 1).padStart(2, "0")}`),
  [daysInMonth, firstWeekday, month, year]);
  const minMonth = min?.slice(0, 7);
  const maxMonth = max?.slice(0, 7);
  const monthLabel = new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric", timeZone: "UTC" })
    .format(new Date(Date.UTC(year, month, 1)));

  useEffect(() => {
    const parsed = parseDisplayDate(draft);
    const outsideRange = parsed && ((min && parsed < min) || (max && parsed > max));
    inputRef.current?.setCustomValidity(outsideRange ? "Choose a date within the allowed range." : "");
  }, [draft, max, min]);

  function selectDate(date: string) {
    if ((min && date < min) || (max && date > max)) return;
    if (value === undefined) setInternalValue(date);
    setDraftOverride(null);
    onChange?.(date);
    setOpen(false);
  }

  return (
    <div className="relative">
      <input type="hidden" name={name} value={draft === formatDateInput(currentValue) ? currentValue : ""} />
      <div className={`flex items-stretch ${className ?? ""}`}>
      <input ref={inputRef} id={id} type="text" inputMode="text" autoComplete="off" pattern="[0-9]{1,2} [A-Za-z]{3} [0-9]{4}" required={required} disabled={disabled} placeholder={placeholder}
        value={draft} aria-required={required} aria-haspopup="dialog"
        aria-invalid={aria["aria-invalid"]} aria-describedby={aria["aria-describedby"]}
        onChange={(event) => {
          const nextDraft = event.target.value;
          setDraftOverride({ sourceValue: currentValue, text: nextDraft });
          const parsed = parseDisplayDate(nextDraft);
          const withinRange = parsed && (!min || parsed >= min) && (!max || parsed <= max);
          if (withinRange) {
            if (value === undefined) setInternalValue(parsed!);
            setDraftOverride(null);
            onChange?.(parsed!);
          }
        }}
        className="h-11 min-w-0 flex-1 rounded-l-lg border border-input bg-background px-3 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground" />
      <button type="button" disabled={disabled} aria-label="Open date picker" aria-haspopup="dialog" aria-expanded={open}
        onClick={() => setOpen((isOpen) => !isOpen)}
        className="inline-flex h-11 shrink-0 items-center justify-center rounded-r-lg border border-l-0 border-input bg-background px-3 text-muted-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:bg-muted">
        <CalendarDays aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
      </button>
      </div>
      {open ? <div role="dialog" aria-label="Choose a date" className="absolute z-50 mt-2 w-72 rounded-xl border border-border bg-popover p-3 text-popover-foreground shadow-lg">
        <div className="mb-3 flex items-center justify-between gap-2">
          <button type="button" aria-label="Previous month" disabled={Boolean(minMonth && visibleMonth <= `${minMonth}-01`)} onClick={() => setVisibleMonth((current) => shiftMonth(current, -1))} className="inline-flex size-8 items-center justify-center rounded-md hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-40"><ChevronLeft aria-hidden="true" className="size-4" /></button>
          <p className="text-sm font-semibold">{monthLabel}</p>
          <button type="button" aria-label="Next month" disabled={Boolean(maxMonth && visibleMonth >= `${maxMonth}-01`)} onClick={() => setVisibleMonth((current) => shiftMonth(current, 1))} className="inline-flex size-8 items-center justify-center rounded-md hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-40"><ChevronRight aria-hidden="true" className="size-4" /></button>
        </div>
        <div className="grid grid-cols-7 gap-1 text-center text-xs text-muted-foreground" aria-hidden="true">{["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"].map((day) => <span key={day} className="py-1">{day}</span>)}</div>
        <div className="grid grid-cols-7 gap-1">{dates.map((date, index) => date ? <button key={date} type="button" aria-label={formatDateInput(date)} aria-pressed={date === currentValue} disabled={disabled || Boolean((min && date < min) || (max && date > max))} onClick={() => selectDate(date)} className={`size-8 rounded-md text-xs hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-30 ${date === currentValue ? "bg-primary font-semibold text-primary-foreground hover:bg-primary" : "text-foreground"}`}>{Number(date.slice(-2))}</button> : <span key={`blank-${index}`} aria-hidden="true" className="size-8" />)}</div>
      </div> : null}
    </div>
  );
}
