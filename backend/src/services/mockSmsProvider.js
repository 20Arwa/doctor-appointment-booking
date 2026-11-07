function createMockSmsProvider() {
  return {
    name: "mock",
    async send({ to, message, idempotencyKey }) {
      return {
        status: "simulated",
        simulated: true,
        sent: false,
        delivered: false,
        provider: "mock",
        providerMessageId: null,
        recipient: to,
        message,
        idempotencyKey,
      };
    },
  };
}

module.exports = { createMockSmsProvider };
