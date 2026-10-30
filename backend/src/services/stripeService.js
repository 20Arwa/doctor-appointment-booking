const Stripe = require("stripe");

class StripePaymentError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function createStripeService({ config, stripeClient }) {
  let client = stripeClient;

  function requireSecret() {
    if (!config.STRIPE_SECRET_KEY?.startsWith("sk_test_")) {
      throw new StripePaymentError(503, "STRIPE_NOT_CONFIGURED", "Stripe Test Mode is not configured");
    }
    return config.STRIPE_SECRET_KEY;
  }

  function getClient() {
    if (!client) client = new Stripe(requireSecret());
    return client;
  }

  return {
    async createCheckoutSession(params, idempotencyKey) {
      return getClient().checkout.sessions.create(params, { idempotencyKey });
    },
    async retrieveCheckoutSession(sessionId) {
      return getClient().checkout.sessions.retrieve(sessionId);
    },
    async expireCheckoutSession(sessionId) {
      return getClient().checkout.sessions.expire(sessionId);
    },
    constructWebhookEvent(rawBody, signature) {
      const secret = config.STRIPE_WEBHOOK_SECRET;
      if (!secret?.startsWith("whsec_")) {
        throw new StripePaymentError(503, "STRIPE_WEBHOOK_NOT_CONFIGURED", "Stripe webhook verification is not configured");
      }
      const stripe = getClient();
      try {
        return stripe.webhooks.constructEvent(rawBody, signature, secret);
      } catch (_error) {
        throw new StripePaymentError(400, "WEBHOOK_SIGNATURE_INVALID", "Stripe webhook verification failed");
      }
    },
  };
}

module.exports = { StripePaymentError, createStripeService };
