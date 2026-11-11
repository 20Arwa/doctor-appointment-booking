const { z } = require("zod");

const time = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
const period = z.object({ weekday: z.number().int().min(0).max(6).optional(), service_date: z.iso.date().optional(), start_time: time, end_time: time })
  .strict().refine((value) => value.end_time > value.start_time, { path: ["end_time"], message: "End time must be after start time" });
const createScheduleSchema = z.object({
  request_id: z.uuid().optional(),
  mode: z.enum(["wave", "stream"]), recurrence_type: z.enum(["weekly", "specific_dates"]),
  visibility: z.enum(["public", "private"]).default("public"), starts_on: z.iso.date().optional(), ends_on: z.iso.date().optional(),
  wave_capacity_per_slot: z.number().int().min(0).max(500).default(0),
  stream_capacity_per_window: z.number().int().min(0).max(500).default(0), periods: z.array(period).min(1).max(100),
}).strict().superRefine((value, context) => {
  if (value.recurrence_type === "weekly" && (!value.starts_on || !value.ends_on || value.ends_on < value.starts_on)) context.addIssue({ code: "custom", path: ["starts_on"], message: "Weekly schedules require a valid start and end date" });
  if (value.recurrence_type === "specific_dates" && value.periods.some((p) => !p.service_date || p.weekday !== undefined)) context.addIssue({ code: "custom", path: ["periods"], message: "Specific date periods require service_date only" });
  if (value.recurrence_type === "weekly" && value.periods.some((p) => p.weekday === undefined || p.service_date !== undefined)) context.addIssue({ code: "custom", path: ["periods"], message: "Weekly periods require weekday only" });
  if ((value.mode === "wave" && (!value.wave_capacity_per_slot || value.stream_capacity_per_window !== 0)) || (value.mode === "stream" && (!value.stream_capacity_per_window || value.wave_capacity_per_slot !== 0))) context.addIssue({ code: "custom", path: ["mode"], message: "Set capacity for the selected mode only" });
});
const scheduleParamsSchema = z.object({ id: z.uuid(), scheduleId: z.uuid() }).strict();
const generateSchema = z.object({ from: z.iso.date(), to: z.iso.date() }).strict().refine((v) => v.from <= v.to, { path: ["to"], message: "to must be on or after from" });
const elasticScheduleSchema = z.object({
  mode: z.enum(["wave", "stream"]),
  expected_updated_at: z.iso.datetime(),
  starts_on: z.iso.date(),
  ends_on: z.iso.date(),
  periods: z.array(z.object({ weekday: z.number().int().min(0).max(6), start_time: time, end_time: time }).strict()
    .refine((value) => value.end_time > value.start_time, { path: ["end_time"], message: "End time must be after start time" }))
    .min(1).max(100),
}).strict().superRefine((value, context) => {
  if (value.starts_on > value.ends_on) {
    context.addIssue({ code: "custom", path: ["ends_on"], message: "End date must be on or after start date" });
  }
  for (let index = 0; index < value.periods.length; index += 1) {
    const candidate = value.periods[index];
    const overlappingIndex = value.periods.findIndex((existing, otherIndex) => otherIndex < index
      && existing.weekday === candidate.weekday
      && existing.start_time < candidate.end_time
      && existing.end_time > candidate.start_time);
    if (overlappingIndex !== -1) {
      context.addIssue({
        code: "custom",
        path: ["periods", index],
        message: `This period overlaps another submitted period on weekday ${candidate.weekday}.`,
      });
    }
  }
});
const exceptionSchema = z.object({ service_date: z.iso.date(), exception_type: z.enum(["day_off", "override", "additional"]), periods: z.array(z.object({ start_time: time, end_time: time }).strict()).max(50).default([]) }).strict()
  .superRefine((v, context) => {
    if (v.exception_type === "day_off" && v.periods.length) context.addIssue({ code: "custom", path: ["periods"], message: "Day off exceptions cannot contain periods" });
    if (v.exception_type !== "day_off" && !v.periods.length) context.addIssue({ code: "custom", path: ["periods"], message: "Override and additional exceptions require periods" });
    for (const [index, periodValue] of v.periods.entries()) if (periodValue.end_time <= periodValue.start_time) context.addIssue({ code: "custom", path: ["periods", index, "end_time"], message: "End time must be after start time" });
  });
module.exports = { createScheduleSchema, elasticScheduleSchema, exceptionSchema, generateSchema, scheduleParamsSchema };
