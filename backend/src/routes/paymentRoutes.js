const express = require("express");
const { createPaymentController } = require("../controllers/paymentController");
const { requireClerkIdentity, requireLocalUser } = require("../middleware/auth");
const { validate } = require("../middleware/validate");
const { createPaymentOrderSchema, paymentIdParamsSchema } = require("../validators/paymentSchemas");

function createPaymentRoutes({ service, webhook = false }) {
  const router = express.Router();
  const controller = createPaymentController({ service });
  if (webhook) {
    router.post("/", express.raw({ type: "application/json", limit: "1mb" }), controller.webhook);
    return router;
  }
  router.use(requireClerkIdentity, requireLocalUser);
  router.post("/orders", validate(createPaymentOrderSchema, "body"), controller.createOrder);
  router.get("/:id/status", validate(paymentIdParamsSchema, "params"), controller.status);
  router.post("/:id/cancel", validate(paymentIdParamsSchema, "params"), controller.cancel);
  return router;
}

module.exports = createPaymentRoutes;
