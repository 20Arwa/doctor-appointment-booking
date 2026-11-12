const env = require("../../config/env");
const { AssistantError, createConversationEngine } = require("./conversationEngine");
const { createGeminiProvider } = require("./geminiProvider");
const { executeTool } = require("./toolExecutor");
const { getPolicyForActor, getToolsForActor } = require("./toolRegistry");

const engine = createConversationEngine({
  provider: createGeminiProvider({ apiKey: env.GEMINI_API_KEY, model: env.GEMINI_MODEL }),
  toolExecutor: executeTool,
});

module.exports = {
  async respond(input) {
    const policy = getPolicyForActor(input.actor);
    if (!policy) {
      throw new AssistantError("FORBIDDEN", 403, "This account cannot use the assistant");
    }
    return engine.respond({ ...input, tools: getToolsForActor(input.actor), systemInstruction: policy });
  },
};
