const env = require("../../config/env");
const { AssistantError, createConversationEngine } = require("./conversationEngine");
const { createGeminiProvider } = require("./geminiProvider");
const { executeTool } = require("./toolExecutor");
const { createDoctorConversationEngine } = require("./doctorConversationEngine");
const { getPolicyForActor, getToolsForActor } = require("./toolRegistry");

const provider = createGeminiProvider({ apiKey: env.GEMINI_API_KEY, model: env.GEMINI_MODEL });
const engine = createConversationEngine({ provider, toolExecutor: executeTool });
const doctorEngine = createDoctorConversationEngine({ provider, toolExecutor: executeTool });

module.exports = {
  async respond(input) {
    const policy = getPolicyForActor(input.actor);
    if (!policy) {
      throw new AssistantError("FORBIDDEN", 403, "This account cannot use the assistant");
    }
    const configuration = { ...input, tools: getToolsForActor(input.actor), systemInstruction: policy };
    return input.actor?.role === "doctor" ? doctorEngine.respond(configuration) : engine.respond(configuration);
  },
};
