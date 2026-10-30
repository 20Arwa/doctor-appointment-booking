const { PaymentError } = require("../services/paymentService");
const { StripePaymentError } = require("../services/stripeService");

function createPaymentController({ service }) {
  async function handle(operation, request, response, next) {
    try { return await operation(request, response); }
    catch (error) {
      if (error instanceof PaymentError || error instanceof StripePaymentError) {
        return response.status(error.status).json({ error: { code: error.code || "PAYMENT_PROVIDER_ERROR", message: error.message } });
      }
      return next(error);
    }
  }

  return {
    createOrder(request, response, next) {
      return handle(async () => response.status(201).json(await service.createCheckoutSession(response.locals.user, response.locals.body)), request, response, next);
    },
    status(request, response, next) {
      return handle(async () => response.status(200).json(await service.getPaymentStatus(response.locals.user, response.locals.params.id)), request, response, next);
    },
    history(request, response, next) {
      return handle(async () => response.status(200).json(await service.getPaymentHistory(response.locals.user)), request, response, next);
    },
    cancel(request, response, next) {
      return handle(async () => response.status(200).json(await service.cancelCheckoutSession(response.locals.user, response.locals.params.id)), request, response, next);
    },
    webhook(request, response, next) {
      return handle(async () => {
        const result = await service.processWebhook(request.body, request.get("stripe-signature"));
        return response.status(200).json(result);
      }, request, response, next);
    },
  };
}

module.exports = { createPaymentController };
