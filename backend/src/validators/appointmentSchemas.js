const { z } = require("zod");

const appointmentIdParamsSchema = z.object({ id: z.uuid() }).strict();
const appointmentQuerySchema = z.object({
  status: z.enum(["confirmed", "cancelled", "completed"]).optional(),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  view: z.enum(["upcoming", "past", "cancelled"]).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
  offset: z.coerce.number().int().min(0).max(1000000).optional(),
}).strict().refine((query) => !query.from || !query.to || query.from <= query.to, {
  path: ["to"],
  message: "to must be on or after from",
}).refine((query) => !query.limit || query.view === "past" || query.view === "cancelled", {
  path: ["view"], message: "limit is supported only for past or cancelled appointment views",
}).refine((query) => query.view !== "past" && query.view !== "cancelled" || query.limit !== undefined, {
  path: ["limit"], message: "limit is required for paginated appointment views",
}).refine((query) => query.offset === undefined || query.limit !== undefined, {
  path: ["offset"], message: "offset requires limit",
}).refine((query) => !query.status || !query.view, {
  path: ["view"], message: "status and view cannot be combined",
});

const createAppointmentSchema = z.object({
  availability_id: z.uuid(),
  reason: z.string().trim().max(2000).nullable().optional(),
}).strict();
const rescheduleAppointmentSchema = z.union([
  z.object({ availability_id: z.uuid() }).strict(),
  z.object({ date: z.iso.date(), start_time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM"), end_time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM") }).strict()
    .refine((value) => value.end_time > value.start_time, { path: ["end_time"], message: "End time must be after start time" }),
]);

module.exports = {
  appointmentIdParamsSchema,
  appointmentQuerySchema,
  createAppointmentSchema,
  rescheduleAppointmentSchema,
};
