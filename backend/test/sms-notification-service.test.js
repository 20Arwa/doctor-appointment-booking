const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { createMockSmsProvider } = require("../src/services/mockSmsProvider");
const { createSmsNotificationService, normalizeSendResult } = require("../src/services/smsNotificationService");

describe("mock SMS provider", () => {
  it("returns an explicit simulated result and never claims a send or delivery", async () => {
    const provider = createMockSmsProvider();
    const result = await provider.send({ to: "+15551234567", message: "Appointment reminder", idempotencyKey: "delivery-key" });

    assert.equal(provider.name, "mock");
    assert.equal(result.status, "simulated");
    assert.equal(result.simulated, true);
    assert.equal(result.sent, false);
    assert.equal(result.delivered, false);
    assert.equal(result.provider, "mock");
    assert.equal(result.recipient, "+15551234567");
    assert.equal(result.message, "Appointment reminder");
    assert.equal(result.idempotencyKey, "delivery-key");
  });

  it("selects the mock provider and returns the normalized result shape", async () => {
    const service = createSmsNotificationService({ config: { SMS_PROVIDER: "mock" } });
    const result = await service.sendSms({ to: "+15551234567", message: "Hello" }, "stable-key");

    assert.deepEqual(result, {
      status: "simulated",
      simulated: true,
      sent: false,
      delivered: false,
      provider: "mock",
      providerMessageId: null,
    });
  });

  it("forwards the stable idempotency key to the provider send method", async () => {
    const providerCalls = [];
    const service = createSmsNotificationService({
      config: { SMS_PROVIDER: "future" },
      provider: { async send(input) { providerCalls.push(input); return { status: "simulated", simulated: true }; } },
    });
    await service.sendSms({ to: "+15551234567", message: "Hello" }, "stable-delivery-key");
    assert.deepEqual(providerCalls, [{ to: "+15551234567", message: "Hello", idempotencyKey: "stable-delivery-key" }]);
  });

  it("normalizes a future provider acceptance without implying delivery", async () => {
    const service = createSmsNotificationService({
      config: { SMS_PROVIDER: "future" },
      provider: { async send() { return { status: "accepted", providerMessageId: "provider-123" }; } },
    });

    assert.deepEqual(await service.sendSms({ to: "+15551234567", message: "Hello" }), {
      status: "accepted",
      simulated: false,
      sent: true,
      delivered: false,
      provider: "future",
      providerMessageId: "provider-123",
    });
  });

  it("maps unknown provider results to a normalized failure", () => {
    assert.deepEqual(normalizeSendResult({ status: "delivered" }, "future"), {
      status: "failed",
      simulated: false,
      sent: false,
      delivered: false,
      provider: "future",
      providerMessageId: null,
    });
  });

  it("rejects unconfigured provider names", () => {
    assert.throws(() => createSmsNotificationService({ config: { SMS_PROVIDER: "unknown" } }), /Unsupported SMS_PROVIDER/);
  });
});
