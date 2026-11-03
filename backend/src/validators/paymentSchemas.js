const { z } = require("zod");

const createPaymentOrderSchema = z.object({
  availability_id: z.string().uuid(),
  idempotency_key: z.string().uuid(),
  reason: z.string().trim().max(2000).optional(),
}).strict();

const paymentIdParamsSchema = z.object({ id: z.string().uuid() }).strict();
const paymentHistoryQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).optional(),
  offset: z.coerce.number().int().min(0).max(1000000).optional(),
}).strict().refine((query) => query.offset === undefined || query.limit !== undefined, {
  path: ["offset"], message: "offset requires limit",
});

module.exports = { createPaymentOrderSchema, paymentHistoryQuerySchema, paymentIdParamsSchema };
