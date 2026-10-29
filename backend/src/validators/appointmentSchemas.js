const { z } = require("zod");

const appointmentIdParamsSchema = z.object({ id: z.uuid() }).strict();
const appointmentQuerySchema = z.object({
  status: z.enum(["confirmed", "cancelled", "completed"]).optional(),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
}).strict().refine((query) => !query.from || !query.to || query.from <= query.to, {
  path: ["to"],
  message: "to must be on or after from",
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
