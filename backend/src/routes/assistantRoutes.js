const express = require("express");
const controller = require("../controllers/assistantController");
const { requireClerkIdentity, requireLocalUser, requireRole } = require("../middleware/auth");
const { assistantRateLimiter } = require("../middleware/assistantRateLimiter");
const { validate } = require("../middleware/validate");
const schemas = require("../validators/assistantConversationSchemas");

const router = express.Router();
router.use(requireClerkIdentity, requireLocalUser, requireRole("patient", "doctor"));
router.post("/conversations", validate(schemas.createConversationSchema, "body"), controller.create);
router.get("/conversations", validate(schemas.listConversationsQuerySchema, "query"), controller.list);
router.get("/conversations/:conversationId", validate(schemas.conversationIdParamsSchema, "params"), validate(schemas.openConversationQuerySchema, "query"), controller.open);
router.delete("/conversations/:conversationId", validate(schemas.conversationIdParamsSchema, "params"), controller.remove);
router.post("/conversations/:conversationId/messages", assistantRateLimiter, validate(schemas.conversationIdParamsSchema, "params"), validate(schemas.sendConversationMessageSchema, "body"), controller.send);
router.post("/conversations/:conversationId/actions", validate(schemas.conversationIdParamsSchema, "params"), validate(schemas.prepareActionSchema, "body"), controller.prepareAction);
router.post("/conversations/:conversationId/actions/dismiss", validate(schemas.conversationIdParamsSchema, "params"), validate(schemas.dismissActionSchema, "body"), controller.dismissAction);
router.get("/conversations/:conversationId/actions/:intentId", validate(schemas.actionIntentParamsSchema, "params"), controller.getActionStatus);
router.post("/conversations/:conversationId/actions/:intentId/confirm", validate(schemas.actionIntentParamsSchema, "params"), controller.confirmAction);

module.exports = router;
