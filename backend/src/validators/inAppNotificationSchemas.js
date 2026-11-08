const { z } = require("zod");

const notificationIdParamsSchema = z.object({ id: z.uuid() }).strict();
const notificationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  offset: z.coerce.number().int().min(0).max(1000000).default(0),
}).strict();

module.exports = { notificationIdParamsSchema, notificationQuerySchema };
