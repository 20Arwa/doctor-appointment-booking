const { z } = require("zod");
const appointmentQueueParamsSchema = z.object({ appointmentId: z.uuid() }).strict();
const doctorQueueParamsSchema = z.object({ doctorId: z.uuid() }).strict();
const queueQuerySchema = z.object({ date: z.iso.date().optional() }).strict();
const receptionistQueueQuerySchema = z.object({ date: z.iso.date(), doctor_id: z.uuid().optional() }).strict();
module.exports = { appointmentQueueParamsSchema, doctorQueueParamsSchema, queueQuerySchema, receptionistQueueQuerySchema };
