const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { refundPolicyAmount } = require("../src/services/refundService");

describe("patient cancellation refund policy", () => {
  const appointment = { date: "2026-11-01", start_time: "10:00:00" };
  const instant = (hoursBefore) => Date.parse("2026-11-01T10:00:00+05:30") - hoursBefore * 3600000;

  it("refunds the full captured amount at exactly 24 hours and earlier", () => {
    assert.equal(refundPolicyAmount("501.37", appointment, instant(24)), 50137);
    assert.equal(refundPolicyAmount("501.37", appointment, instant(25)), 50137);
  });

  it("refunds half from exactly 6 hours until less than 24 hours", () => {
    assert.equal(refundPolicyAmount("500.00", appointment, instant(6)), 25000);
    assert.equal(refundPolicyAmount("500.00", appointment, instant(23.99)), 25000);
  });

  it("refunds nothing below 6 hours or after the appointment starts", () => {
    assert.equal(refundPolicyAmount("500.00", appointment, instant(5.99)), 0);
    assert.equal(refundPolicyAmount("500.00", appointment, instant(0)), 0);
    assert.equal(refundPolicyAmount("500.00", appointment, instant(-1)), 0);
  });

  it("interprets the scheduled wall time in Asia/Kolkata", () => {
    const scheduled = Date.parse("2026-11-01T10:00:00+05:30");
    assert.equal(refundPolicyAmount("100.00", appointment, scheduled - 24 * 3600000), 10000);
    assert.equal(refundPolicyAmount("100.00", appointment, scheduled - 6 * 3600000), 5000);
  });
});
