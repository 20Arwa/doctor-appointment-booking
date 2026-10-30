const assert = require("node:assert/strict");
const { after, before, describe, it } = require("node:test");
const { createApp } = require("../src/app");
const { createPaymentService } = require("../src/services/paymentService");
const { refundPolicyAmount, refundPolicyPercentage } = require("../src/services/refundService");

const patientUserId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const otherUserId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const patientId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const appointmentId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const appointment = { date: "2099-04-10", start_time: "10:00:00" };
const appointmentInstant = Date.parse("2099-04-10T10:00:00+05:30");

function createFixture({ now = appointmentInstant - 24 * 3600000, appointmentStatus = "confirmed", paymentStatus = "captured", amount = "100.00", processed = "0.00", pending = "0.00", owned = true } = {}) {
  const queries = [];
  let writes = 0;
  let stripeCalls = 0;
  const database = {
    async connect() { throw new Error("Preview must not open a transaction or mutate database state"); },
    async query(sql, values = []) {
      queries.push(sql);
      if (!sql.trimStart().startsWith("SELECT")) writes += 1;
      if (sql.includes("FROM users WHERE clerk_user_id = $1")) {
        const isOwner = values[0] === "clerk_owner";
        return { rows: [{ id: isOwner ? patientUserId : otherUserId, role: "patient", is_active: true }] };
      }
      if (sql.includes("FROM appointments a") && sql.includes("refund_totals")) {
        if (values[0] !== appointmentId || values[1] !== patientUserId || !owned) return { rows: [] };
        return { rows: [{
          id: appointmentId, appointment_status: appointmentStatus,
          date: appointment.date, start_time: appointment.start_time,
          payment_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", payment_status: paymentStatus,
          payment_amount: amount, currency: "INR", provider: "stripe", provider_payment_id: "pi_preview_test",
          processed_refunds: processed, pending_refunds: pending,
        }] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
  };
  const stripe = {
    async createRefund() { stripeCalls += 1; throw new Error("Preview must not create Stripe refunds"); },
    async retrievePaymentIntent() { stripeCalls += 1; throw new Error("Preview must not retrieve Stripe payments"); },
  };
  const paymentService = createPaymentService({ database, stripe, now: () => now, logger: { error() {}, warn() {} } });
  const app = createApp({
    database,
    paymentService,
    frontendOrigin: "http://localhost:3000",
    clerkAuthMiddleware(request, _response, next) {
      const caller = request.get("x-test-clerk-user") || "clerk_owner";
      request.auth = Object.assign(() => ({ isAuthenticated: true, userId: caller, tokenType: "session_token" }), { [Symbol.for("@clerk/express.auth")]: true });
      next();
    },
    emailNotificationService: { async sendAppointmentNotification() {} },
  });
  return { app, paymentService, queries, get writes() { return writes; }, get stripeCalls() { return stripeCalls; } };
}

describe("cancellation refund preview", () => {
  let fixture;
  let server;
  let baseUrl;

  before(async () => {
    fixture = createFixture();
    server = fixture.app.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    if (server) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });

  it("returns a 100% estimate at exactly 24 hours and performs no writes or Stripe calls", async () => {
    const response = await fetch(`${baseUrl}/api/v1/appointments/${appointmentId}/cancellation-preview`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      original_payment: { amount: "100.00", currency: "INR", status: "captured" },
      refund_percentage: 100,
      estimated_refund_amount: "100.00",
      currency: "INR",
      refund_expected: true,
      explanation: "This is an estimate. The backend will recalculate the refund when you confirm cancellation.",
    });
    assert.equal(fixture.writes, 0);
    assert.equal(fixture.stripeCalls, 0);
  });

  it("returns a 50% estimate at exactly 6 hours using the shared policy helpers", async () => {
    const local = createFixture({ now: appointmentInstant - 6 * 3600000, amount: "100.01" });
    assert.equal(refundPolicyPercentage(appointment, appointmentInstant - 6 * 3600000), 50);
    assert.equal(refundPolicyAmount("100.01", appointment, appointmentInstant - 6 * 3600000), 5001);
    const preview = await local.paymentService.previewCancellationRefund({ id: patientUserId, role: "patient" }, appointmentId);
    assert.equal(preview.refund_percentage, 50);
    assert.equal(preview.estimated_refund_amount, "50.01");
    assert.equal(local.writes, 0);
    assert.equal(local.stripeCalls, 0);
  });

  it("subtracts processed refunds and caps the estimate by the remaining captured amount", async () => {
    const local = createFixture({ processed: "70.00", pending: "10.00" });
    const preview = await local.paymentService.previewCancellationRefund({ id: patientUserId, role: "patient" }, appointmentId);
    assert.equal(preview.refund_percentage, 100);
    assert.equal(preview.estimated_refund_amount, "20.00");
    assert.equal(preview.refund_expected, true);
    assert.equal(local.writes, 0);
    assert.equal(local.stripeCalls, 0);
  });

  it("rejects non-owning patients and appointments that are no longer confirmed", async () => {
    const response = await fetch(`${baseUrl}/api/v1/appointments/${appointmentId}/cancellation-preview`, { headers: { "x-test-clerk-user": "clerk_other" } });
    assert.equal(response.status, 404);

    const noLongerEligible = createFixture({ appointmentStatus: "cancelled" });
    await assert.rejects(
      noLongerEligible.paymentService.previewCancellationRefund({ id: patientUserId, role: "patient" }, appointmentId),
      { status: 409, code: "APPOINTMENT_STATE_CONFLICT" },
    );
    await assert.rejects(
      noLongerEligible.paymentService.previewCancellationRefund({ id: otherUserId, role: "patient" }, appointmentId),
      { status: 404, code: "APPOINTMENT_NOT_FOUND" },
    );
  });

  it("reports no refund below six hours and for uncaptured payments", async () => {
    const belowWindow = createFixture({ now: appointmentInstant - 5 * 3600000 });
    const noRefund = await belowWindow.paymentService.previewCancellationRefund({ id: patientUserId, role: "patient" }, appointmentId);
    assert.equal(noRefund.refund_percentage, 0);
    assert.equal(noRefund.estimated_refund_amount, "0.00");
    assert.equal(noRefund.refund_expected, false);

    const pendingPayment = createFixture({ paymentStatus: "pending" });
    const pendingResult = await pendingPayment.paymentService.previewCancellationRefund({ id: patientUserId, role: "patient" }, appointmentId);
    assert.equal(pendingResult.refund_percentage, 100);
    assert.equal(pendingResult.estimated_refund_amount, "0.00");
    assert.equal(pendingResult.refund_expected, false);
    assert.match(pendingResult.explanation, /payment is not captured/);

    assert.equal(refundPolicyPercentage(appointment, appointmentInstant - 5 * 3600000), 0);
    assert.equal(refundPolicyPercentage(appointment, appointmentInstant - 24 * 3600000), 100);
    assert.equal(refundPolicyPercentage(appointment, appointmentInstant - 6 * 3600000), 50);
    assert.equal(belowWindow.writes, 0);
    assert.equal(belowWindow.stripeCalls, 0);
    assert.equal(pendingPayment.writes, 0);
    assert.equal(pendingPayment.stripeCalls, 0);
  });
});
