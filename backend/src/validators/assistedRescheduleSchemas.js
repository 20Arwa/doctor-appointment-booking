const { z } = require("zod");

const doctorAssistedRequestsQuerySchema = z.object({
  status: z.enum(["pending_patient", "no_alternatives", "accepted", "declined", "expired", "superseded"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).max(1000000).default(0),
}).strict();

const assistedRescheduleRequestParamsSchema = z.object({ requestId: z.uuid() }).strict();
const confirmAssistedRescheduleSchema = z.object({ suggestion_id: z.uuid() }).strict();

module.exports = {
  assistedRescheduleRequestParamsSchema,
  confirmAssistedRescheduleSchema,
  doctorAssistedRequestsQuerySchema,
};
