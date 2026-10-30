const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { createRefundService } = require("../src/services/refundService");

const appointment = { id: "33333333-3333-4333-8333-333333333333", date: "2099-04-10", start_time: "10:00:00" };
const user = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", role: "patient" };

function refundDatabase(paymentStatus = "captured") {
  const state = { refunds: new Map(), events: new Set(), paymentStatus, inTransaction: false, paymentState: paymentStatus };
  return {
    state,
    async query(sql, values = []) {
      if (sql.includes("FROM refunds r WHERE") || sql.includes("FROM refunds WHERE id::text")) {
        const refund = [...state.refunds.values()].find((item) => item.id === values[0] || item.provider_refund_id === values[1]);
        return { rows: refund ? [{ id: refund.id }] : [] };
      }
      return { rows: [] };
    },
    async connect() {
      return {
        async query(sql, values = []) {
          if (sql === "BEGIN") state.inTransaction = true;
          if (sql === "COMMIT" || sql === "ROLLBACK") state.inTransaction = false;
          if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rows: [] };
          if (sql.startsWith("INSERT INTO payment_provider_events")) {
            if (state.events.has(values[0])) return { rows: [] };
            state.events.add(values[0]);
            return { rows: [{ id: state.events.size }] };
          }
          if (sql.startsWith("UPDATE payment_provider_events")) return { rows: [] };
          if (sql.includes("FROM appointments a JOIN patients pt")) {
            const lateralProjection = sql.match(/SELECT\s+([\s\S]*?)\s+FROM payments pay JOIN appointments ap/i)?.[1] || "";
            if (/pay\.\*\s*,\s*pay\.appointment_id\b/i.test(lateralProjection)) {
              throw new Error('column reference "appointment_id" is ambiguous');
            }
            return { rows: [{
              payment_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", payment_status: state.paymentState,
              provider: "stripe", provider_payment_id: "pi_test_123", amount: "500.00", currency: "INR",
              appointment_id: appointment.id, patient_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
              date: appointment.date, start_time: appointment.start_time,
            }] };
          }
          if (sql.includes("FROM refunds WHERE idempotency_key = $1")) {
            const refund = state.refunds.get(values[0]);
            return { rows: refund ? [{ ...refund, provider_payment_id: values[1] }] : [] };
          }
          if (sql.includes("FROM refunds WHERE payment_id = $1")) {
            const refunds = [...state.refunds.values()];
            return { rows: [{
              processed: refunds.filter((r) => r.status === "processed").reduce((sum, r) => sum + Number(r.amount), 0).toFixed(2),
              pending: refunds.filter((r) => r.status === "pending").reduce((sum, r) => sum + Number(r.amount), 0).toFixed(2),
            }] };
          }
          if (sql.startsWith("INSERT INTO refunds")) {
            const refund = { id: "99999999-9999-4999-8999-999999999999", payment_id: values[0], amount: values[2], currency: values[3], status: "pending", idempotency_key: values[4] };
            state.refunds.set(values[4], refund);
            return { rows: [refund] };
          }
          if (sql.includes("FROM refunds r JOIN payments p")) {
            const refund = [...state.refunds.values()].find((r) => r.id === values[0]);
            return { rows: refund ? [{ ...refund, payment_amount: "500.00" }] : [] };
          }
          if (sql.includes("FROM payments p LEFT JOIN refunds r")) {
            const refunds = [...state.refunds.values()];
            return { rows: [{ amount: "500.00", processed: refunds.filter((r) => r.status === "processed").reduce((sum, r) => sum + Number(r.amount), 0).toFixed(2) }] };
          }
          if (sql.startsWith("UPDATE refunds SET status")) {
            const refund = [...state.refunds.values()].find((r) => r.id === values[0]);
            Object.assign(refund, { status: values[1], provider_refund_id: refund.provider_refund_id || values[2] });
            return { rows: [] };
          }
          if (sql.startsWith("UPDATE payments SET status")) { state.paymentState = values[1]; return { rows: [] }; }
          if (sql.startsWith("SELECT id, amount::text AS amount, currency, status FROM refunds")) {
            const refund = [...state.refunds.values()].find((r) => r.id === values[0]);
            return { rows: [{ id: refund.id, amount: refund.amount, currency: refund.currency, status: refund.status }] };
          }
          throw new Error(`Unexpected query: ${sql}`);
        },
        release() {},
      };
    },
  };
}

describe("appointment cancellation refunds", () => {
  it("uses an unambiguous payment lookup, captured amount, stable idempotency, and submits after commit", async () => {
    const database = refundDatabase();
    const calls = [];
    const service = createRefundService({
      database,
      now: () => Date.parse("2099-04-09T09:00:00+05:30"),
      stripe: { async createRefund(params, key) {
        assert.equal(database.state.inTransaction, false);
        calls.push({ params, key });
        return { id: "re_test_123", status: "succeeded" };
      } },
      logger: { error() {} },
    });
    const result = await service.refundCancelledAppointment(user, appointment);
    assert.equal(result.status, "processed");
    assert.equal(result.amount, "500.00");
    assert.equal(calls[0].params.payment_intent, "pi_test_123");
    assert.equal(calls[0].params.amount, 50000);
    assert.equal(calls[0].key, `appointment-cancel:${appointment.id}`);
    assert.equal(database.state.paymentState, "refunded");
  });

  it("marks refund preparation failures distinctly and does not contact Stripe", async () => {
    const database = refundDatabase();
    database.connect = async () => ({
      async query(sql) {
        if (sql === "BEGIN") return { rows: [] };
        if (sql === "ROLLBACK") return { rows: [] };
        if (sql.includes("FROM appointments a JOIN patients pt")) throw new Error("lookup failed");
        throw new Error(`Unexpected query: ${sql}`);
      },
      release() {},
    });
    let stripeCalls = 0;
    const service = createRefundService({
      database,
      stripe: { async createRefund() { stripeCalls += 1; } },
      logger: { error() {} },
    });

    const result = await service.refundCancelledAppointment(user, appointment);

    assert.deepEqual(result, {
      status: "pending",
      amount: "0.00",
      currency: null,
      error_code: "REFUND_PREPARATION_FAILED",
    });
    assert.equal(database.state.refunds.size, 0);
    assert.equal(stripeCalls, 0);
  });

  it("retries an uncertain submission with the same persisted Stripe idempotency key", async () => {
    const database = refundDatabase();
    const keys = [];
    const service = createRefundService({
      database,
      now: () => Date.parse("2099-04-09T09:00:00+05:30"),
      stripe: { async createRefund(_params, key) {
        keys.push(key);
        if (keys.length <= 2) throw new Error("socket timed out");
        return { id: "re_test_123", status: "succeeded" };
      } },
      logger: { error() {} },
    });
    assert.equal((await service.refundCancelledAppointment(user, appointment)).status, "pending");
    assert.equal((await service.refundCancelledAppointment(user, appointment)).status, "processed");
    assert.deepEqual(keys, [`appointment-cancel:${appointment.id}`, `appointment-cancel:${appointment.id}`, `appointment-cancel:${appointment.id}`]);
    assert.equal(database.state.refunds.size, 1);
  });

  it("does not submit a refund for an uncaptured payment", async () => {
    const database = refundDatabase("failed");
    let calls = 0;
    const service = createRefundService({ database, stripe: { async createRefund() { calls += 1; } }, logger: { error() {} } });
    const result = await service.refundCancelledAppointment(user, appointment);
    assert.equal(result.status, "not_eligible");
    assert.equal(calls, 0);
  });

  it("subtracts prior successful refunds and marks the payment partially refunded", async () => {
    const database = refundDatabase("partially_refunded");
    database.state.refunds.set("prior-refund", {
      id: "88888888-8888-4888-8888-888888888888", payment_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      amount: "100.00", currency: "INR", status: "processed", idempotency_key: "prior-refund",
    });
    let refundedMinor = 0;
    const service = createRefundService({
      database,
      now: () => Date.parse("2099-04-10T03:00:00+05:30"),
      stripe: { async createRefund(params) { refundedMinor = params.amount; return { id: "re_test_456", status: "succeeded" }; } },
      logger: { error() {} },
    });
    const result = await service.refundCancelledAppointment(user, appointment);
    assert.equal(refundedMinor, 15000);
    assert.equal(result.amount, "150.00");
    assert.equal(database.state.paymentState, "partially_refunded");
  });

  it("processes refund webhooks idempotently and does not regress on out-of-order events", async () => {
    const database = refundDatabase();
    const service = createRefundService({
      database,
      now: () => Date.parse("2099-04-09T09:00:00+05:30"),
      stripe: { async createRefund() { throw new Error("timeout"); } },
      logger: { error() {} },
    });
    await service.refundCancelledAppointment(user, appointment);
    const successEvent = {
      id: "evt_refund_success", type: "refund.updated",
      data: { object: { id: "re_test_123", status: "succeeded", metadata: { local_refund_id: "99999999-9999-4999-8999-999999999999" } } },
    };
    assert.equal((await service.processRefundWebhook(successEvent)).status, "processed");
    assert.equal((await service.processRefundWebhook(successEvent)).duplicate, true);
    const oldPendingEvent = {
      id: "evt_refund_created", type: "refund.created",
      data: { object: { id: "re_test_123", status: "pending", metadata: { local_refund_id: "99999999-9999-4999-8999-999999999999" } } },
    };
    assert.equal((await service.processRefundWebhook(oldPendingEvent)).status, "processed");
    assert.equal([...database.state.refunds.values()][0].status, "processed");
    assert.equal(database.state.paymentState, "refunded");
  });
});
