const express = require("express");
const controller = require("../controllers/assistantController");
const { requireClerkIdentity, requireLocalUser } = require("../middleware/auth");
const { assistantRateLimiter } = require("../middleware/assistantRateLimiter");
const { validate } = require("../middleware/validate");
const schemas = require("../validators/assistantConversationSchemas");

const router = express.Router();
router.use(requireClerkIdentity, requireLocalUser);
router.post("/conversations", validate(schemas.createConversationSchema, "body"), controller.create);
router.get("/conversations", validate(schemas.listConversationsQuerySchema, "query"), controller.list);
router.get("/conversations/:conversationId", validate(schemas.conversationIdParamsSchema, "params"), validate(schemas.openConversationQuerySchema, "query"), controller.open);
router.delete("/conversations/:conversationId", validate(schemas.conversationIdParamsSchema, "params"), controller.remove);
router.post("/conversations/:conversationId/messages", assistantRateLimiter, validate(schemas.conversationIdParamsSchema, "params"), validate(schemas.sendConversationMessageSchema, "body"), controller.send);

module.exports = router;
