const { z } = require("zod");

const doctorPatientParamsSchema = z.object({ patientId: z.uuid() }).strict();
const doctorPatientAppointmentsQuerySchema = z.object({
  view: z.enum(["scheduled", "past", "cancelled"]),
  limit: z.coerce.number().int().min(1).max(50).default(5),
  offset: z.coerce.number().int().min(0).max(1000000).default(0),
}).strict();

module.exports = { doctorPatientAppointmentsQuerySchema, doctorPatientParamsSchema };
