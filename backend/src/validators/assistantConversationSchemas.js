const { z } = require("zod");

const conversationIdParamsSchema = z.object({ conversationId: z.uuid() }).strict();
const createConversationSchema = z.object({ id: z.uuid() }).strict();
const listConversationsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  offset: z.coerce.number().int().min(0).max(100000).default(0),
}).strict();
const openConversationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(20).default(20),
  before: z.uuid().optional(),
}).strict();
const sendConversationMessageSchema = z.object({
  request_id: z.uuid(),
  content: z.string().trim().min(1).max(1000),
}).strict();

module.exports = {
  conversationIdParamsSchema,
  createConversationSchema,
  listConversationsQuerySchema,
  openConversationQuerySchema,
  sendConversationMessageSchema,
};
