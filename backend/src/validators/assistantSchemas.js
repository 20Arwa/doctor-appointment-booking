const { z } = require("zod");

const assistantChatSchema = z.object({
  messages: z.array(z.discriminatedUnion("role", [
    z.object({ role: z.literal("user"), content: z.string().trim().min(1).max(1000) }).strict(),
    z.object({ role: z.literal("assistant"), content: z.string().trim().min(1).max(2000) }).strict(),
  ])).min(1).max(12),
}).strict().superRefine(({ messages }, context) => {
  if (messages[messages.length - 1]?.role !== "user") {
    context.addIssue({ code: "custom", path: ["messages"], message: "The final message must be from the patient" });
  }
  if (messages.reduce((total, message) => total + message.content.length, 0) > 6000) {
    context.addIssue({ code: "custom", path: ["messages"], message: "Conversation is too long" });
  }
});

module.exports = { assistantChatSchema };
