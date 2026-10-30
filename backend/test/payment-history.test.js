const assert = require("node:assert/strict");
const { after, before, describe, it } = require("node:test");
const { createApp } = require("../src/app");
const { createPaymentService } = require("../src/services/paymentService");

const ownerId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const otherPatientId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const paymentId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const paymentWithoutReceiptId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const appointmentId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const doctorId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const intentId = "pi_test_history";

function createFixture() {
  const historyRows = [{
    id: paymentId, amount: "500.00", currency: "INR", status: "partially_refunded", provider: "stripe",
    provider_payment_id: intentId, payment_date: "2026-10-25T08:00:00.000Z", appointment_id: appointmentId,
    appointment_status: "cancelled", appointment_date: "2026-10-26", appointment_start_time: "10:00:00",
    appointment_end_time: "10:30:00", doctor_id: doctorId, doctor_first_name: "Dara", doctor_last_name: "Doctor",
    specialty: "General Practice",
  }, {
    id: paymentWithoutReceiptId, amount: "125.00", currency: "INR", status: "captured", provider: "stripe",
    provider_payment_id: "pi_test_no_receipt", payment_date: "2026-10-24T08:00:00.000Z", appointment_id: null,
    appointment_status: null, appointment_date: null, appointment_start_time: null,
    appointment_end_time: null, doctor_id: null, doctor_first_name: null, doctor_last_name: null, specialty: null,
  }];
  const refunds = [
    { id: "11111111-1111-4111-8111-111111111111", payment_id: paymentId, amount: "250.00", currency: "INR", status: "processed", reason: "patient_cancellation", created_at: "2026-10-25T08:05:00.000Z", processed_at: "2026-10-25T08:06:00.000Z" },
    { id: "22222222-2222-4222-8222-222222222222", payment_id: paymentId, amount: "10.00", currency: "INR", status: "pending", reason: "adjustment", created_at: "2026-10-25T08:10:00.000Z", processed_at: null },
    { id: "33333333-3333-4333-8333-333333333333", payment_id: paymentId, amount: "5.00", currency: "INR", status: "failed", reason: null, created_at: "2026-10-25T08:15:00.000Z", processed_at: null },
  ];
  const databaseCalls = [];
  const database = {
    async query(sql, values = []) {
      databaseCalls.push({ sql, values });
      if (sql.includes("FROM users WHERE clerk_user_id = $1")) {
        if (values[0] === "clerk_owner") return { rows: [{ id: ownerId, first_name: "Pia", last_name: "Patient", email: "pia@example.test", phone: null, role: "patient", is_active: true }] };
        if (values[0] === "clerk_other") return { rows: [{ id: otherPatientId, first_name: "Other", last_name: "Patient", email: "other@example.test", phone: null, role: "patient", is_active: true }] };
        return { rows: [] };
      }
      if (sql.includes("FROM payments p") && sql.includes("patient_owner.user_id = $1")) {
        return { rows: values[0] === ownerId ? historyRows : [] };
      }
      if (sql.includes("FROM refunds WHERE payment_id = ANY")) {
        return { rows: values[0].includes(paymentId) ? refunds : [] };
      }
      throw new Error(`Unexpected database query: ${sql}`);
    },
  };
  const stripeCalls = [];
  const stripe = {
    async retrievePaymentIntent(id) {
      stripeCalls.push(id);
      return {
        id,
        status: "succeeded",
        latest_charge: { receipt_url: id === "pi_test_no_receipt" ? "javascript:alert(1)" : "https://pay.stripe.com/receipts/payment/test-receipt" },
      };
    },
  };
  const paymentService = createPaymentService({ database, stripe, logger: { warn() {}, error() {} } });
  const app = createApp({
    database,
    paymentService,
    frontendOrigin: "http://localhost:3000",
    clerkAuthMiddleware(request, _response, next) {
      const clerkUserId = request.get("x-test-clerk-user") || "clerk_owner";
      request.auth = Object.assign(() => ({ isAuthenticated: true, userId: clerkUserId, tokenType: "session_token" }), { [Symbol.for("@clerk/express.auth")]: true });
      next();
    },
    emailNotificationService: { async sendAppointmentNotification() {} },
  });
  return { app, databaseCalls, stripeCalls };
}

describe("patient payment history API", () => {
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

  it("returns the owner's payment, appointment, refunds, and Stripe receipt", async () => {
    const response = await fetch(`${baseUrl}/api/v1/payments/history`);
    assert.equal(response.status, 200);
    const payments = await response.json();
    const payment = payments.find((item) => item.id === paymentId);
    assert.equal(payment.amount, "500.00");
    assert.equal(payment.currency, "INR");
    assert.equal(payment.status, "partially_refunded");
    assert.equal(payment.appointment.doctor.first_name, "Dara");
    assert.equal(payment.refunds.length, 3);
    assert.equal(payment.refunds[0].status, "processed");
    assert.equal(payment.refunds[1].status, "pending");
    assert.equal(payment.refunds[2].status, "failed");
    assert.equal(payment.receipt_url, "https://pay.stripe.com/receipts/payment/test-receipt");
    const withoutReceipt = payments.find((item) => item.id === paymentWithoutReceiptId);
    assert.equal(withoutReceipt.receipt_url, null);
  });

  it("scopes history to the authenticated patient and does not retrieve another patient's Stripe data", async () => {
    const response = await fetch(`${baseUrl}/api/v1/payments/history`, { headers: { "x-test-clerk-user": "clerk_other" } });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), []);
    assert.deepEqual(fixture.stripeCalls, [intentId, "pi_test_no_receipt"]);
    assert.ok(fixture.databaseCalls.some(({ sql, values }) => sql.includes("patient_owner.user_id = $1") && values[0] === otherPatientId));
  });
});
