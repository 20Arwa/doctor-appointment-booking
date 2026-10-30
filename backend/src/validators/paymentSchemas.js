const { z } = require("zod");

const createPaymentOrderSchema = z.object({
  availability_id: z.string().uuid(),
  idempotency_key: z.string().uuid(),
  reason: z.string().trim().max(2000).optional(),
}).strict();

const paymentIdParamsSchema = z.object({ id: z.string().uuid() }).strict();

module.exports = { createPaymentOrderSchema, paymentIdParamsSchema };
