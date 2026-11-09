const { createMockSmsProvider } = require("./mockSmsProvider");

const PROVIDER_FACTORIES = Object.freeze({ mock: createMockSmsProvider });
const RESULT_STATUSES = new Set(["accepted", "failed", "simulated"]);
const PROVIDER_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;

function normalizeProviderName(value) {
  if (typeof value !== "string") return null;
  const name = value.trim().toLowerCase();
  return PROVIDER_NAME_PATTERN.test(name) ? name : null;
}

function normalizeSendResult(result, providerName) {
  const status = RESULT_STATUSES.has(result?.status) ? result.status : "failed";
  const simulated = status === "simulated" || result?.simulated === true;
  return {
    status: simulated ? "simulated" : status,
    simulated,
    sent: !simulated && status === "accepted",
    delivered: false,
    provider: providerName,
    providerMessageId: typeof result?.providerMessageId === "string" ? result.providerMessageId : null,
  };
}

function createSmsNotificationService({ config, provider, providerRegistry = PROVIDER_FACTORIES } = {}) {
  const providerName = normalizeProviderName(config?.SMS_PROVIDER || "mock");
  if (!providerName) throw new Error("Unsupported SMS_PROVIDER: provider name must be a normalized identifier");

  const providers = new Map();
  for (const [registeredName, adapterOrFactory] of Object.entries(providerRegistry)) {
    const normalizedName = normalizeProviderName(registeredName);
    if (!normalizedName) throw new Error(`Invalid SMS provider registry name: ${registeredName}`);
    const adapter = typeof adapterOrFactory === "function" ? adapterOrFactory() : adapterOrFactory;
    if (!adapter || typeof adapter.send !== "function") throw new TypeError(`SMS provider adapter '${normalizedName}' must implement send()`);
    providers.set(normalizedName, adapter);
  }
  if (provider) {
    if (typeof provider.send !== "function") throw new TypeError("SMS provider adapter must implement send()");
    providers.set(providerName, provider);
  }
  if (!providers.has(providerName)) throw new Error(`Unsupported SMS_PROVIDER: '${providerName}' has no registered adapter`);

  return {
    providerName,
    hasProvider(name) {
      const normalizedName = normalizeProviderName(name);
      return Boolean(normalizedName && providers.has(normalizedName));
    },
    async sendSms({ to, message }, idempotencyKey, { providerName: requestedProvider = providerName } = {}) {
      const requestedName = normalizeProviderName(requestedProvider);
      const adapter = requestedName && providers.get(requestedName);
      if (!adapter) throw new Error(`Unsupported SMS delivery provider: '${requestedProvider}' has no registered adapter`);
      const result = await adapter.send({ to, message, idempotencyKey });
      return normalizeSendResult(result, requestedName);
    },
  };
}

module.exports = { createSmsNotificationService, normalizeProviderName, normalizeSendResult };
