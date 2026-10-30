const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { createApp } = require("../src/app");
const { createStripeService } = require("../src/services/stripeService");
const { createPaymentService, PaymentError } = require("../src/services/paymentService");
const { createPaymentOrderSchema } = require("../src/validators/paymentSchemas");

const userId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const patientId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const availabilityId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const holdId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const paymentId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const appointmentId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const doctorId = "11111111-1111-4111-8111-111111111111";
const otherUserId = "22222222-2222-4222-8222-222222222222";
const sessionId = "cs_test_medrella_123";
const intentId = "pi_test_medrella_123";
const config = { STRIPE_SECRET_KEY: "sk_test_medrella", STRIPE_WEBHOOK_SECRET: "whsec_medrella" };
const patient = { id: userId, role: "patient" };
const slot = { id: availabilityId, doctor_id: doctorId, date: "2099-04-10", start_time: "10:00:00", end_time: "10:30:00", fee: "500.00" };
const appointment = {
  id: appointmentId, status: "confirmed", availability_id: availabilityId,
  date: slot.date, start_time: slot.start_time, end_time: slot.end_time,
  doctor_id: doctorId, doctor_first_name: "Dara", doctor_last_name: "Doctor",
  specialty: "General Practice", patient_id: patientId,
  patient_first_name: "Pia", patient_last_name: "Patient", patient_email: "patient@example.test",
};

function createStripeClient({ createSession = async (params) => ({
  id: sessionId, url: "https://checkout.stripe.com/c/pay/test", amount_total: params.line_items?.[0]?.price_data?.unit_amount ?? 50000,
  currency: "inr", status: "open", expires_at: params.expires_at ?? Math.floor(Date.now() / 1000) + 2100,
}) } = {}) {
  const calls = [];
  return {
    calls,
    checkout: { sessions: {
      async create(params, options) { calls.push({ method: "create", params, options }); return createSession(params, options); },
      async retrieve(id) { calls.push({ method: "retrieve", id }); return { id, url: "https://checkout.stripe.com/c/pay/test", status: "open" }; },
      async expire(id) { calls.push({ method: "expire", id }); return { id, status: "expired", payment_status: "unpaid" }; },
    } },
    webhooks: { constructEvent(raw, signature, secret) {
      calls.push({ method: "constructEvent", raw, signature, secret });
      if (signature !== "stripe-signature") throw new Error("invalid signature");
      return JSON.parse(raw.toString("utf8"));
    } },
  };
}

function createIdempotentStripeClient({ loseFirstResponse = false } = {}) {
  const providerSessions = new Map();
  const stripeClient = createStripeClient({ createSession: async (params, options) => {
    let session = providerSessions.get(options.idempotencyKey);
    if (!session) {
      session = {
        id: sessionId,
        url: "https://checkout.stripe.com/c/pay/test",
        amount_total: params.line_items[0].price_data.unit_amount,
        currency: params.line_items[0].price_data.currency,
        status: "open",
        expires_at: params.expires_at,
      };
      providerSessions.set(options.idempotencyKey, session);
    }
    if (loseFirstResponse) {
      loseFirstResponse = false;
      throw new Error("socket timed out after Stripe created the session");
    }
    return session;
  } });
  return { providerSessions, stripeClient, stripe: createStripeService({ config, stripeClient }) };
}

function createReservationDatabase({ holdExpiresAt = new Date(Date.now() + 40 * 60 * 1000).toISOString(), failPersistOrder = false, slotDeleted = false, competingHold = false } = {}) {
  const state = { payment: null, hold: null, calls: [], holdCount: 0, paymentCount: 0, appointmentCount: 0, competingHold };
  let shouldFailPersistOrder = failPersistOrder;
  const reservationRow = () => state.payment && state.hold ? [{
    id: state.payment.id,
    status: state.payment.status,
    provider_order_id: state.payment.provider_order_id,
    amount: state.payment.amount,
    currency: state.payment.currency,
    expires_at: state.hold.expires_at,
    availability_id: state.hold.availability_id,
    hold_id: state.hold.id,
    doctor_id: doctorId,
  }] : [];
  let advisoryLockTail = Promise.resolve();
  return {
    state,
    async query(sql, values = []) {
      if (sql.includes("p.idempotency_key = $1")) return { rows: state.payment?.idempotency_key === values[0] ? reservationRow() : [] };
      if (sql.includes("FROM payments p JOIN appointment_slot_holds h")) {
        const payment = state.payment;
        const hold = state.hold;
        return { rows: payment && hold && hold.patient_id === values[0] && hold.availability_id === values[1]
          && hold.status === "active" && ["created", "pending", "authorized"].includes(payment.status) ? reservationRow() : [] };
      }
      throw new Error(`Unexpected pool query: ${sql}`);
    },
    async connect() {
      const heldLocks = [];
      return {
        async query(sql, values = []) {
          state.calls.push(sql);
          if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rows: [] };
          if (sql === "SELECT id FROM patients WHERE user_id = $1") return { rows: [{ id: patientId }] };
          if (sql.includes("FOR UPDATE OF av, d")) return { rows: [{ ...slot, deleted_at: slotDeleted ? "2026-10-30T00:00:00.000Z" : null }] };
          if (sql.includes("pg_advisory_xact_lock")) {
            if (heldLocks.length) return { rows: [] };
            const previous = advisoryLockTail;
            let unlock;
            advisoryLockTail = new Promise((resolve) => { unlock = resolve; });
            await previous;
            heldLocks.push(unlock);
            return { rows: [] };
          }
          if (sql.includes("p.idempotency_key = $1")) return { rows: state.payment?.idempotency_key === values[0] ? reservationRow() : [] };
          if (sql.includes("FROM payments p JOIN appointment_slot_holds h")) {
            const payment = state.payment;
            const hold = state.hold;
            return { rows: payment && hold && hold.patient_id === values[0] && hold.availability_id === values[1]
              && hold.status === "active" && ["created", "pending", "authorized"].includes(payment.status) ? reservationRow() : [] };
          }
          if (sql.startsWith("UPDATE payments p SET status = 'expired'")) return { rows: [] };
          if (sql.startsWith("UPDATE appointment_slot_holds h SET status = 'expired'")) return { rows: [] };
          if (sql.includes("FROM appointments a JOIN availability av")) return { rows: [] };
          if (sql.includes("FROM appointment_slot_holds h JOIN availability av")) return { rows: state.competingHold ? [{ id: holdId }] : [] };
          if (sql.startsWith("INSERT INTO appointment_slot_holds")) {
            state.hold = { id: holdId, availability_id: values[0], patient_id: values[1], reason: values[2], status: "active", expires_at: holdExpiresAt };
            state.holdCount += 1;
            return { rows: [{ id: holdId, expires_at: holdExpiresAt }] };
          }
          if (sql.startsWith("INSERT INTO payments")) {
            state.payment = { id: paymentId, slot_hold_id: holdId, amount: "500.00", currency: "INR", status: "created", idempotency_key: values[2] };
            state.paymentCount += 1;
            return { rows: [{ id: paymentId, amount: "500.00", currency: "INR" }] };
          }
          if (sql.startsWith("UPDATE payments SET provider_order_id")) {
            if (shouldFailPersistOrder) { shouldFailPersistOrder = false; throw new Error("database unavailable after Stripe created the session"); }
            Object.assign(state.payment, { provider_order_id: values[1], provider_payment_id: values[2], status: "pending" });
            return { rows: [] };
          }
          if (sql.startsWith("UPDATE payments SET status = $2")) {
            state.payment.status = values[1];
            return { rows: [{ slot_hold_id: state.payment.slot_hold_id }] };
          }
          if (sql.startsWith("UPDATE payments SET status = 'failed'")) { state.payment.status = "failed"; return { rows: [] }; }
          if (sql.startsWith("UPDATE appointment_slot_holds SET status = 'released'")) { state.hold.status = "released"; return { rows: [] }; }
          if (sql.startsWith("UPDATE appointment_slot_holds SET status = $2")) { state.hold.status = values[1]; return { rows: [] }; }
          throw new Error(`Unexpected client query: ${sql}`);
        },
        release() { for (const unlock of heldLocks.reverse()) unlock(); },
      };
    },
  };
}

function createPaymentDatabase({ competingBooking = false, slotDeleted = false } = {}) {
  const state = {
    payment: { id: paymentId, provider: "stripe", provider_order_id: sessionId, provider_payment_id: null, amount: "500.00", currency: "INR", status: "pending", appointment_id: null, slot_hold_id: holdId, patient_id: patientId, availability_id: availabilityId, reason: "Review" },
    hold: { id: holdId, status: "active", patient_id: patientId, availability_id: availabilityId },
    appointment: null,
    competingBooking,
    events: new Set(),
    reconciliation: new Map(),
    calls: [],
    sentEmails: [],
  };
  let advisoryLockTail = Promise.resolve();
  const row = () => ({ ...state.payment, hold_id: state.payment.slot_hold_id, hold_status: state.hold?.status, patient_id: patientId, availability_id: state.payment.slot_hold_id ? availabilityId : (state.appointment ? availabilityId : null), reason: "Review" });
  return {
    state,
    async query(sql, values = []) {
      if (sql.includes("WHERE p.provider = 'stripe' AND p.provider_order_id")) return { rows: state.payment.provider_order_id === values[0] ? [row()] : [] };
      if (sql.includes("WHERE p.id = $1 AND COALESCE(h.patient_id, a.patient_id)")) return { rows: values[1] === userId ? [row()] : [] };
      if (sql.includes("FROM payment_capture_reconciliation WHERE payment_id")) return { rows: [...state.reconciliation.values()].filter((item) => item.payment_id === values[0]).map((item) => ({ id: item.id })) };
      if (sql.includes("FROM payment_capture_reconciliation WHERE provider = 'stripe'")) {
        const item = state.reconciliation.get(values[0]);
        return { rows: item ? [{ id: item.id }] : [] };
      }
      if (sql.includes("FROM appointments a JOIN availability av") && sql.includes("WHERE a.id = $1")) return { rows: state.appointment ? [{ ...state.appointment }] : [] };
      throw new Error(`Unexpected pool query: ${sql}`);
    },
    async connect() {
      const heldLocks = [];
      return {
        async query(sql, values = []) {
          state.calls.push(sql);
          if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rows: [] };
          if (sql.includes("FOR UPDATE OF av, d") || (sql.includes("FROM availability av") && sql.includes("FOR UPDATE OF av"))) return { rows: [{ ...slot, deleted_at: slotDeleted ? "2026-10-30T00:00:00.000Z" : null }] };
          if (sql.includes("pg_advisory_xact_lock")) {
            if (heldLocks.length) return { rows: [] };
            const previous = advisoryLockTail;
            let unlock;
            advisoryLockTail = new Promise((resolve) => { unlock = resolve; });
            await previous;
            heldLocks.push(unlock);
            return { rows: [] };
          }
          if (sql.includes("INSERT INTO payment_provider_events")) {
            if (state.events.has(values[0])) return { rows: [] };
            state.events.add(values[0]);
            return { rows: [{ id: state.events.size }] };
          }
          if (sql.includes("UPDATE payment_provider_events SET processed_at")) return { rows: [] };
          if (sql.includes("FOR UPDATE OF p") && sql.includes("FROM payments p")) return { rows: [row()] };
          if (sql.includes("FROM payments WHERE id = $1 FOR UPDATE")) return { rows: [{ status: state.payment.status, appointment_id: state.payment.appointment_id, slot_hold_id: state.payment.slot_hold_id }] };
          if (sql.includes("FROM payments WHERE id = $1 FOR UPDATE")) return { rows: [state.payment] };
          if (sql.includes("SELECT status, provider_payment_id FROM payments")) return { rows: [{ status: state.payment.status, provider_payment_id: state.payment.provider_payment_id }] };
          if (sql.includes("SELECT 1 FROM appointment_slot_holds h") && sql.includes("LIMIT 1")) return { rows: [] };
          if (sql.includes("SELECT 1 FROM appointments other") && sql.includes("LIMIT 1")) return { rows: state.competingBooking ? [{ id: "competing" }] : [] };
          if (sql.startsWith("UPDATE payments SET status = 'captured'")) { state.payment.status = "captured"; state.payment.provider_payment_id = values[1]; return { rows: [{ id: paymentId }] }; }
          if (sql.startsWith("UPDATE payments SET status = $2")) {
            state.payment.status = values[1];
            return { rows: [{ slot_hold_id: state.payment.slot_hold_id }] };
          }
          if (sql.startsWith("UPDATE payments SET status = 'pending'")) { state.payment.status = "pending"; state.payment.provider_payment_id ||= values[1]; return { rows: [] }; }
          if (sql.startsWith("UPDATE payments SET appointment_id")) { state.payment.appointment_id = values[1]; state.payment.slot_hold_id = null; return { rows: [] }; }
          if (sql.startsWith("UPDATE appointment_slot_holds SET status = 'consumed'")) { state.hold.status = "consumed"; return { rows: [] }; }
          if (sql.startsWith("UPDATE appointment_slot_holds SET status = 'expired'")) { state.hold.status = "expired"; return { rows: [] }; }
          if (sql.startsWith("UPDATE appointment_slot_holds SET status = $2")) { state.hold.status = values[1]; return { rows: [] }; }
          if (sql.startsWith("INSERT INTO payment_capture_reconciliation")) {
            const providerPaymentId = values[2];
            if (state.reconciliation.has(providerPaymentId)) return { rows: [] };
            const record = { id: `reconciliation-${state.reconciliation.size + 1}`, payment_id: values[0], provider_payment_id: providerPaymentId, reason: values[6] };
            state.reconciliation.set(providerPaymentId, record);
            return { rows: [{ id: record.id }] };
          }
          if (sql.startsWith("SELECT id FROM payment_capture_reconciliation WHERE provider = 'stripe'")) {
            const record = state.reconciliation.get(values[0]);
            return { rows: record ? [{ id: record.id }] : [] };
          }
          if (sql.startsWith("INSERT INTO appointments")) {
            state.appointment = { ...appointment };
            return { rows: [{ id: appointmentId }] };
          }
          if (sql.includes("FROM appointments a") && sql.includes("WHERE a.id = $1")) return { rows: state.appointment ? [{ ...state.appointment }] : [] };
          throw new Error(`Unexpected client query: ${sql}`);
        },
        release() { for (const unlock of heldLocks.reverse()) unlock(); },
      };
    },
  };
}

function createSessionEvent(type, id, overrides = {}) {
  return {
    id,
    type,
    data: { object: {
      id: sessionId,
      client_reference_id: paymentId,
      metadata: { payment_id: paymentId },
      amount_total: 50000,
      currency: "inr",
      status: type === "checkout.session.expired" ? "expired" : "complete",
      payment_status: type === "checkout.session.completed" || type === "checkout.session.async_payment_succeeded" ? "paid" : "unpaid",
      payment_intent: intentId,
      ...overrides,
    } },
  };
}

function createPaymentHttpFixture() {
  const database = createPaymentDatabase();
  const databaseQuery = database.query.bind(database);
  database.query = async (sql, values = []) => {
    if (sql.includes("FROM users WHERE clerk_user_id = $1")) {
      const localId = values[0] === "clerk_owner" ? userId : values[0] === "clerk_other_patient" ? otherUserId : null;
      return { rows: localId ? [{ id: localId, first_name: "Test", last_name: "Patient", email: "patient@example.test", phone: null, role: "patient", is_active: true }] : [] };
    }
    return databaseQuery(sql, values);
  };
  const stripeCalls = [];
  const stripe = {
    async retrieveCheckoutSession(id) { stripeCalls.push(["retrieve", id]); throw new Error("Stripe should not be called for another patient's payment"); },
    async expireCheckoutSession(id) { stripeCalls.push(["expire", id]); throw new Error("Stripe should not be called for another patient's payment"); },
  };
  const paymentService = createPaymentService({ database, stripe, frontendOrigin: "https://medrella.example" });
  const clerkAuthMiddleware = (request, _response, next) => {
    const userIdFromHeader = request.get("x-test-clerk-user") || "clerk_owner";
    request.auth = Object.assign(
      () => ({ isAuthenticated: true, userId: userIdFromHeader, tokenType: "session_token" }),
      { [Symbol.for("@clerk/express.auth")]: true },
    );
    next();
  };
  const app = createApp({
    database,
    paymentService,
    frontendOrigin: "https://medrella.example",
    clerkAuthMiddleware,
    emailNotificationService: { async sendAppointmentNotification() {} },
  });
  return { app, database, stripeCalls };
}

async function withServer(app, operation) {
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  try { await operation(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
}

describe("Stripe webhook HTTP routing", () => {
  it("bypasses Clerk for signature verification while protecting normal payment routes", async () => {
    const databaseCalls = [];
    const database = {
      async query(sql, values = []) {
        databaseCalls.push({ sql, values });
        if (sql.includes("FROM users WHERE clerk_user_id = $1")) return { rows: [] };
        throw new Error(`Unexpected database query: ${sql}`);
      },
    };
    const stripeClient = createStripeClient();
    const paymentService = createPaymentService({
      database,
      stripe: createStripeService({ config, stripeClient }),
      frontendOrigin: "https://medrella.example",
    });
    const clerkAuthMiddleware = (request, response, next) => {
      const clerkUserId = request.get("x-test-clerk-user");
      if (!clerkUserId) {
        return response.status(401).json({ error: { code: "UNAUTHENTICATED", message: "Authentication is required" } });
      }
      request.auth = Object.assign(
        () => ({ isAuthenticated: true, userId: clerkUserId, tokenType: "session_token" }),
        { [Symbol.for("@clerk/express.auth")]: true },
      );
      return next();
    };
    const app = createApp({
      database,
      paymentService,
      frontendOrigin: "https://medrella.example",
      clerkAuthMiddleware,
      emailNotificationService: { async sendAppointmentNotification() {} },
    });

    await withServer(app, async (baseUrl) => {
      const webhookResponse = await fetch(`${baseUrl}/api/v1/payments/webhook`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      assert.equal(webhookResponse.status, 400);
      assert.deepEqual(await webhookResponse.json(), {
        error: { code: "WEBHOOK_SIGNATURE_INVALID", message: "Stripe webhook verification failed" },
      });
      const verificationCall = stripeClient.calls.find((call) => call.method === "constructEvent");
      assert.ok(verificationCall, "the webhook should reach Stripe signature verification");
      assert.ok(Buffer.isBuffer(verificationCall.raw), "the webhook should retain its raw body");
      assert.equal(verificationCall.raw.toString("utf8"), "{}");
      assert.equal(verificationCall.signature, undefined);
      assert.equal(verificationCall.secret, config.STRIPE_WEBHOOK_SECRET);
      assert.deepEqual(databaseCalls, []);

      const unauthenticatedPaymentResponse = await fetch(`${baseUrl}/api/v1/payments/orders`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ availability_id: availabilityId, idempotency_key: paymentId }),
      });
      assert.equal(unauthenticatedPaymentResponse.status, 401);
      assert.deepEqual(await unauthenticatedPaymentResponse.json(), {
        error: { code: "UNAUTHENTICATED", message: "Authentication is required" },
      });
      assert.deepEqual(databaseCalls, []);

      const unprovisionedPaymentResponse = await fetch(`${baseUrl}/api/v1/payments/orders`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-test-clerk-user": "clerk_unprovisioned" },
        body: JSON.stringify({ availability_id: availabilityId, idempotency_key: paymentId }),
      });
      assert.equal(unprovisionedPaymentResponse.status, 404);
      assert.deepEqual(await unprovisionedPaymentResponse.json(), {
        error: { code: "PROFILE_NOT_FOUND", message: "Complete onboarding first" },
      });
      assert.equal(databaseCalls.length, 1);
      assert.match(databaseCalls[0].sql, /FROM users WHERE clerk_user_id = \$1/);
    });
  });
});

describe("Stripe Test Mode adapter", () => {
  it("uses the official SDK for hosted Checkout, idempotency, and raw webhook verification", async () => {
    const sdk = createStripeClient();
    const stripe = createStripeService({ config, stripeClient: sdk });
    const params = { mode: "payment" };
    await stripe.createCheckoutSession(params, "idempotent-session");
    assert.equal(sdk.calls[0].options.idempotencyKey, "idempotent-session");
    const raw = Buffer.from('{"id":"evt_test"}');
    const event = stripe.constructWebhookEvent(raw, "stripe-signature");
    assert.equal(event.id, "evt_test");
    assert.equal(sdk.calls[1].raw, raw);
    assert.equal(sdk.calls[1].secret, "whsec_medrella");
  });

  it("rejects live or missing credentials and invalid webhook signatures", async () => {
    await assert.rejects(createStripeService({ config: { ...config, STRIPE_SECRET_KEY: "sk_live_no" } }).createCheckoutSession({}, "key"), { code: "STRIPE_NOT_CONFIGURED" });
    const noWebhook = createStripeService({ config: { STRIPE_SECRET_KEY: config.STRIPE_SECRET_KEY }, stripeClient: createStripeClient() });
    assert.throws(() => noWebhook.constructWebhookEvent(Buffer.from("{}"), "sig"), { code: "STRIPE_WEBHOOK_NOT_CONFIGURED" });
    const stripe = createStripeService({ config, stripeClient: createStripeClient() });
    assert.throws(() => stripe.constructWebhookEvent(Buffer.from("{}"), "bad"), { code: "WEBHOOK_SIGNATURE_INVALID" });
  });
});

describe("Stripe appointment Checkout", () => {
  it("rejects a new payment hold while another active unexpired Checkout hold exists", async () => {
    const database = createReservationDatabase({ competingHold: true });
    const service = createPaymentService({ database, stripe: {}, frontendOrigin: "https://medrella.example" });
    await assert.rejects(
      service.createCheckoutSession(patient, { availability_id: availabilityId, idempotency_key: paymentId }),
      { code: "SLOT_UNAVAILABLE" },
    );
    assert.equal(database.state.holdCount, 0);
    assert.equal(database.state.paymentCount, 0);
  });

  it("does not create payment holds or Checkout Sessions for soft-deleted availability", async () => {
    const database = createReservationDatabase({ slotDeleted: true });
    let checkoutCalls = 0;
    const service = createPaymentService({
      database,
      stripe: { async createCheckoutSession() { checkoutCalls += 1; } },
      frontendOrigin: "https://medrella.example",
    });
    await assert.rejects(
      service.createCheckoutSession(patient, { availability_id: availabilityId, idempotency_key: paymentId }),
      { code: "SLOT_UNAVAILABLE" },
    );
    assert.equal(database.state.holdCount, 0);
    assert.equal(database.state.paymentCount, 0);
    assert.equal(checkoutCalls, 0);
  });

  it("uses the locked doctor fee, INR minor units, Stripe idempotency, and a buffered slot hold", async () => {
    const database = createReservationDatabase();
    const sdk = createStripeClient();
    const stripe = createStripeService({ config, stripeClient: sdk });
    const service = createPaymentService({ database, stripe, frontendOrigin: "https://medrella.example/", timeZone: "Asia/Kolkata" });
    const input = { availability_id: availabilityId, idempotency_key: paymentId, reason: "Review" };
    assert.equal(createPaymentOrderSchema.safeParse(input).success, true);
    assert.equal(createPaymentOrderSchema.safeParse({ ...input, amount: 1 }).success, false);
    const result = await service.createCheckoutSession(patient, input);
    assert.equal(result.checkout_url, "https://checkout.stripe.com/c/pay/test");
    assert.equal(result.session_id, sessionId);
    assert.deepEqual(Object.keys(result).sort(), ["checkout_url", "expires_at", "payment_id", "session_id"]);
    assert.equal(sdk.calls[0].params.line_items[0].price_data.unit_amount, 50000);
    assert.equal(sdk.calls[0].params.line_items[0].price_data.currency, "inr");
    assert.equal(sdk.calls[0].params.mode, "payment");
    assert.equal(sdk.calls[0].params.expires_at, Math.floor(new Date(database.state.hold.expires_at).getTime() / 1000) - 300);
    assert.equal(sdk.calls[0].params.metadata.payment_id, paymentId);
    assert.equal(sdk.calls[0].options.idempotencyKey, `medrella-payment-${paymentId}`);
    assert.match(sdk.calls[0].params.success_url, /\{CHECKOUT_SESSION_ID\}/);
    assert.ok(database.state.calls.some((sql) => sql.includes("INTERVAL '40 minutes'")));
    assert.equal(database.state.payment.amount, "500.00");
  });

  it("releases a hold after definite Stripe API failure", async () => {
    const database = createReservationDatabase();
    const stripe = { async createCheckoutSession() { const error = new Error("invalid request"); error.statusCode = 400; throw error; } };
    const service = createPaymentService({ database, stripe, frontendOrigin: "https://medrella.example" });
    await assert.rejects(service.createCheckoutSession(patient, { availability_id: availabilityId, idempotency_key: paymentId }), { code: "STRIPE_SESSION_FAILED" });
    assert.equal(database.state.payment.status, "failed");
    assert.equal(database.state.hold.status, "released");
  });

  it("serializes concurrent Checkout attempts for one patient and slot into one reservation and session", async () => {
    const database = createReservationDatabase();
    let checkoutAttempts = 0;
    let releaseCheckout;
    const checkoutBarrier = new Promise((resolve) => { releaseCheckout = resolve; });
    const providerSessions = new Map();
    let providerSessionCreations = 0;
    const stripe = {
      async createCheckoutSession(params, idempotencyKey) {
        checkoutAttempts += 1;
        if (checkoutAttempts === 2) releaseCheckout();
        await checkoutBarrier;
        let session = providerSessions.get(idempotencyKey);
        if (!session) {
          providerSessionCreations += 1;
          session = {
            id: sessionId, url: "https://checkout.stripe.com/c/pay/test",
            amount_total: params.line_items[0].price_data.unit_amount,
            currency: params.line_items[0].price_data.currency, status: "open", expires_at: params.expires_at,
          };
          providerSessions.set(idempotencyKey, session);
        }
        return session;
      },
    };
    const service = createPaymentService({ database, stripe, frontendOrigin: "https://medrella.example" });
    const [first, second] = await Promise.all([
      service.createCheckoutSession(patient, { availability_id: availabilityId, idempotency_key: paymentId }),
      service.createCheckoutSession(patient, { availability_id: availabilityId, idempotency_key: "99999999-9999-4999-8999-999999999999" }),
    ]);

    assert.equal(first.payment_id, second.payment_id);
    assert.equal(first.session_id, second.session_id);
    assert.equal(database.state.holdCount, 1);
    assert.equal(database.state.paymentCount, 1);
    assert.equal(database.state.appointmentCount, 0);
    assert.equal(providerSessionCreations, 1);
    assert.equal(providerSessions.size, 1);
    assert.equal(database.state.hold.status, "active");
    assert.equal(database.state.payment.status, "pending");
  });

  it("starts Checkout at the minimum safe expiry boundary and rejects one second below it", async () => {
    const fixedNow = Date.UTC(2026, 0, 1, 0, 0, 0);
    const minimumDatabase = createReservationDatabase({ holdExpiresAt: new Date(fixedNow + 36 * 60 * 1000).toISOString() });
    const minimumStripe = createStripeClient();
    const minimumService = createPaymentService({ database: minimumDatabase, stripe: createStripeService({ config, stripeClient: minimumStripe }), frontendOrigin: "https://medrella.example", now: () => fixedNow });
    await minimumService.createCheckoutSession(patient, { availability_id: availabilityId, idempotency_key: paymentId });
    assert.equal(minimumStripe.calls[0].params.expires_at, Math.floor(fixedNow / 1000) + 31 * 60);

    const shortDatabase = createReservationDatabase({ holdExpiresAt: new Date(fixedNow + 35 * 60 * 1000 + 59 * 1000).toISOString() });
    const shortStripe = createStripeClient();
    const shortService = createPaymentService({ database: shortDatabase, stripe: createStripeService({ config, stripeClient: shortStripe }), frontendOrigin: "https://medrella.example", now: () => fixedNow });
    await assert.rejects(shortService.createCheckoutSession(patient, { availability_id: availabilityId, idempotency_key: paymentId }), { code: "CHECKOUT_WINDOW_UNAVAILABLE" });
    assert.equal(shortStripe.calls.filter((call) => call.method === "create").length, 0);
    assert.equal(shortDatabase.state.payment.status, "failed");
    assert.equal(shortDatabase.state.hold.status, "released");
  });

  it("retains a bounded hold after ambiguous provider or database failures and retries with the same expiry", async () => {
    const fixedNow = Date.UTC(2026, 0, 1, 0, 0, 0);
    const expiresAt = new Date(fixedNow + 40 * 60 * 1000).toISOString();
    const networkDatabase = createReservationDatabase({ holdExpiresAt: expiresAt });
    const ambiguous = createIdempotentStripeClient({ loseFirstResponse: true });
    const networkService = createPaymentService({ database: networkDatabase, stripe: ambiguous.stripe, frontendOrigin: "https://medrella.example", now: () => fixedNow, logger: { error() {} } });
    const request = { availability_id: availabilityId, idempotency_key: paymentId };
    await assert.rejects(networkService.createCheckoutSession(patient, request), { code: "STRIPE_SESSION_FAILED" });
    assert.equal(networkDatabase.state.payment.status, "created");
    assert.equal(networkDatabase.state.hold.status, "active");
    const recovered = await networkService.createCheckoutSession(patient, request);
    assert.equal(recovered.session_id, sessionId);
    assert.equal(ambiguous.providerSessions.size, 1);
    assert.equal(ambiguous.stripeClient.calls.length, 2);
    assert.equal(ambiguous.stripeClient.calls[0].options.idempotencyKey, ambiguous.stripeClient.calls[1].options.idempotencyKey);
    assert.equal(networkDatabase.state.holdCount, 1);
    assert.equal(networkDatabase.state.paymentCount, 1);
    assert.equal(networkDatabase.state.payment.status, "pending");

    const database = createReservationDatabase({ holdExpiresAt: expiresAt, failPersistOrder: true });
    const persistenceRetry = createIdempotentStripeClient();
    const service = createPaymentService({ database, stripe: persistenceRetry.stripe, frontendOrigin: "https://medrella.example", now: () => fixedNow, logger: { error() {} } });
    await assert.rejects(service.createCheckoutSession(patient, request), { code: "STRIPE_SESSION_FAILED" });
    assert.equal(database.state.payment.status, "created");
    assert.equal(database.state.hold.status, "active");
    assert.equal(persistenceRetry.stripeClient.calls[0].params.expires_at, Math.floor(new Date(expiresAt).getTime() / 1000) - 300);
    const persistedRetry = await service.createCheckoutSession(patient, request);
    assert.equal(persistedRetry.session_id, sessionId);
    assert.equal(persistenceRetry.stripeClient.calls[1].params.expires_at, persistenceRetry.stripeClient.calls[0].params.expires_at);
    assert.equal(persistenceRetry.stripeClient.calls[1].options.idempotencyKey, persistenceRetry.stripeClient.calls[0].options.idempotencyKey);
    assert.equal(persistenceRetry.providerSessions.size, 1);
    assert.equal(database.state.holdCount, 1);
    assert.equal(database.state.paymentCount, 1);
    assert.equal(database.state.payment.status, "pending");
  });

  it("expires a provider session whose returned expiry violates the hold boundary", async () => {
    const fixedNow = Date.UTC(2026, 0, 1, 0, 0, 0);
    const expiresAt = new Date(fixedNow + 40 * 60 * 1000).toISOString();
    const database = createReservationDatabase({ holdExpiresAt: expiresAt });
    const calls = [];
    const stripe = {
      async createCheckoutSession(params) { calls.push(params); return { id: sessionId, url: "https://checkout.stripe.com/test", amount_total: 50000, currency: "inr", status: "open", expires_at: params.expires_at + 1 }; },
      async expireCheckoutSession(id) { calls.push(id); return { id, status: "expired" }; },
    };
    const service = createPaymentService({ database, stripe, frontendOrigin: "https://medrella.example", now: () => fixedNow });
    await assert.rejects(service.createCheckoutSession(patient, { availability_id: availabilityId, idempotency_key: paymentId }), { code: "STRIPE_SESSION_INVALID" });
    assert.equal(calls[1], sessionId);
    assert.equal(database.state.payment.status, "expired");
    assert.equal(database.state.hold.status, "released");
  });
});

describe("Stripe Checkout webhook and reconciliation", () => {
  it("confirms once, sends one existing Brevo booking email, and ignores repeated/out-of-order success events", async () => {
    const database = createPaymentDatabase();
    const stripe = { constructWebhookEvent(raw, signature) { assert.ok(Buffer.isBuffer(raw)); assert.equal(signature, "stripe-signature"); return JSON.parse(raw.toString("utf8")); } };
    const service = createPaymentService({ database, stripe, timeZone: "Asia/Kolkata", emailNotificationService: { async sendAppointmentNotification(action, item) { database.state.sentEmails.push([action, item.id]); } } });
    const first = await service.processWebhook(Buffer.from(JSON.stringify(createSessionEvent("checkout.session.completed", "evt_complete"))), "stripe-signature");
    assert.equal(first.status, "confirmed");
    assert.equal(database.state.appointment.status, "confirmed");
    assert.equal(database.state.payment.provider_payment_id, intentId);
    assert.equal(database.state.sentEmails.length, 1);
    assert.equal(database.state.calls.filter((sql) => sql.startsWith("INSERT INTO payments")).length, 0);
    assert.deepEqual(await service.processWebhook(Buffer.from(JSON.stringify(createSessionEvent("checkout.session.completed", "evt_complete"))), "stripe-signature"), { duplicate: true });
    const delayedSuccess = await service.processWebhook(Buffer.from(JSON.stringify(createSessionEvent("checkout.session.async_payment_succeeded", "evt_async_success"))), "stripe-signature");
    assert.equal(delayedSuccess.status, "confirmed");
    assert.equal(database.state.sentEmails.length, 1);
    assert.equal(database.state.appointment.status, "confirmed");
    assert.equal(database.state.calls.filter((sql) => sql.startsWith("INSERT INTO payments")).length, 0);
  });

  it("does not confirm an unpaid completed Checkout Session or send its booking email", async () => {
    const database = createPaymentDatabase();
    const stripe = { constructWebhookEvent(raw) { return JSON.parse(raw.toString("utf8")); } };
    const service = createPaymentService({ database, stripe, timeZone: "Asia/Kolkata", emailNotificationService: { async sendAppointmentNotification(action, item) { database.state.sentEmails.push([action, item.id]); } } });
    const unpaid = createSessionEvent("checkout.session.completed", "evt_completed_unpaid", { payment_status: "unpaid" });
    const result = await service.processWebhook(Buffer.from(JSON.stringify(unpaid)), "sig");
    assert.equal(result.status, "pending");
    assert.equal(database.state.payment.status, "pending");
    assert.equal(database.state.appointment, null);
    assert.equal(database.state.sentEmails.length, 0);
    assert.equal(database.state.reconciliation.size, 0);
  });

  it("allows a failed asynchronous attempt to complete later when Stripe reports paid", async () => {
    const database = createPaymentDatabase();
    const stripe = { constructWebhookEvent(raw) { return JSON.parse(raw.toString("utf8")); } };
    const service = createPaymentService({ database, stripe, timeZone: "Asia/Kolkata", emailNotificationService: { async sendAppointmentNotification(action, item) { database.state.sentEmails.push([action, item.id]); } } });
    const failure = createSessionEvent("checkout.session.async_payment_failed", "evt_async_failure");
    assert.equal((await service.processWebhook(Buffer.from(JSON.stringify(failure)), "sig")).status, "failed");
    assert.equal(database.state.payment.status, "failed");
    assert.equal(database.state.hold.status, "released");
    const success = createSessionEvent("checkout.session.async_payment_succeeded", "evt_async_success_after_failure");
    assert.equal((await service.processWebhook(Buffer.from(JSON.stringify(success)), "sig")).status, "confirmed");
    assert.equal(database.state.payment.status, "captured");
    assert.equal(database.state.appointment.status, "confirmed");
    assert.equal(database.state.hold.status, "consumed");
    assert.equal(database.state.sentEmails.length, 1);
    assert.equal(database.state.reconciliation.size, 0);
    assert.equal(database.state.calls.filter((sql) => sql.startsWith("INSERT INTO payments")).length, 0);
  });

  it("does not demote a success after a later asynchronous failure or repeat side effects", async () => {
    const database = createPaymentDatabase();
    const stripe = { constructWebhookEvent(raw) { return JSON.parse(raw.toString("utf8")); } };
    const service = createPaymentService({ database, stripe, timeZone: "Asia/Kolkata", emailNotificationService: { async sendAppointmentNotification(action, item) { database.state.sentEmails.push([action, item.id]); } } });
    const success = createSessionEvent("checkout.session.async_payment_succeeded", "evt_async_success_first");
    assert.equal((await service.processWebhook(Buffer.from(JSON.stringify(success)), "sig")).status, "confirmed");
    const failure = createSessionEvent("checkout.session.async_payment_failed", "evt_async_failure_late");
    assert.equal((await service.processWebhook(Buffer.from(JSON.stringify(failure)), "sig")).status, "captured");
    assert.deepEqual(await service.processWebhook(Buffer.from(JSON.stringify(failure)), "sig"), { duplicate: true });
    await service.processWebhook(Buffer.from(JSON.stringify(success)), "sig");
    assert.equal(database.state.payment.status, "captured");
    assert.equal(database.state.appointment.status, "confirmed");
    assert.equal(database.state.calls.filter((sql) => sql.startsWith("INSERT INTO appointments")).length, 1);
    assert.equal(database.state.events.size, 2);
    assert.equal(database.state.reconciliation.size, 0);
    assert.equal(database.state.sentEmails.length, 1);
    assert.equal(database.state.calls.filter((sql) => sql.startsWith("INSERT INTO payments")).length, 0);
  });

  it("records a distinct captured PaymentIntent once without replacing the original reference or booking twice", async () => {
    const database = createPaymentDatabase();
    database.state.payment.status = "captured";
    database.state.payment.provider_payment_id = intentId;
    database.state.payment.appointment_id = appointmentId;
    database.state.payment.slot_hold_id = null;
    database.state.hold.status = "consumed";
    database.state.appointment = { ...appointment };
    const stripe = { constructWebhookEvent(raw) { return JSON.parse(raw.toString("utf8")); } };
    const service = createPaymentService({ database, stripe, timeZone: "Asia/Kolkata" });
    const second = "pi_test_distinct_capture";
    const first = createSessionEvent("checkout.session.completed", "evt_distinct_1", { payment_intent: second });
    const duplicateType = createSessionEvent("checkout.session.async_payment_succeeded", "evt_distinct_2", { payment_intent: second });
    const result1 = await service.processWebhook(Buffer.from(JSON.stringify(first)), "sig");
    const result2 = await service.processWebhook(Buffer.from(JSON.stringify(duplicateType)), "sig");
    assert.equal(result1.status, "captured_payment_reconciliation_required");
    assert.equal(result2.status, "captured_payment_reconciliation_required");
    assert.equal(result1.reconciliation_id, result2.reconciliation_id);
    assert.equal(database.state.reconciliation.size, 1);
    assert.equal(database.state.payment.provider_payment_id, intentId);
    assert.equal(database.state.appointment.id, appointmentId);
  });

  it("records a paid session for reconciliation when another booking took the expired hold's slot", async () => {
    const database = createPaymentDatabase({ competingBooking: true });
    const stripe = { constructWebhookEvent(raw) { return JSON.parse(raw.toString("utf8")); } };
    const service = createPaymentService({ database, stripe, timeZone: "Asia/Kolkata" });
    const result = await service.processWebhook(Buffer.from(JSON.stringify(createSessionEvent("checkout.session.completed", "evt_late_paid"))), "sig");
    assert.equal(result.status, "captured_slot_unavailable");
    assert.equal(database.state.payment.status, "captured");
    assert.equal(database.state.payment.provider_payment_id, intentId);
    assert.equal(database.state.hold.status, "expired");
    assert.equal(database.state.appointment, null);
    assert.equal([...database.state.reconciliation.values()][0].reason, "slot_unavailable");
  });

  it("expires a hold on Checkout expiration and rejects amount, currency, and session mismatches", async () => {
    const database = createPaymentDatabase();
    const stripe = { constructWebhookEvent(raw) { return JSON.parse(raw.toString("utf8")); } };
    const service = createPaymentService({ database, stripe, timeZone: "Asia/Kolkata" });
    const expired = createSessionEvent("checkout.session.expired", "evt_expired");
    assert.equal((await service.processWebhook(Buffer.from(JSON.stringify(expired)), "sig")).status, "expired");
    assert.equal(database.state.payment.status, "expired");
    assert.equal(database.state.hold.status, "expired");
    const mismatches = [
      createSessionEvent("checkout.session.completed", "evt_bad_amount", { amount_total: 51000 }),
      createSessionEvent("checkout.session.completed", "evt_bad_currency", { currency: "usd" }),
      createSessionEvent("checkout.session.completed", "evt_bad_patient", { metadata: { payment_id: userId } }),
    ];
    for (const event of mismatches) {
      const code = event.data.object.metadata.payment_id === paymentId ? "PAYMENT_DETAILS_MISMATCH" : "PAYMENT_SESSION_MISMATCH";
      await assert.rejects(service.processWebhook(Buffer.from(JSON.stringify(event)), "sig"), { code });
    }
    assert.deepEqual(await service.processWebhook(Buffer.from(JSON.stringify(createSessionEvent("checkout.session.completed", "evt_bad_session", { id: "cs_test_wrong" }))), "sig"), { ignored: true });
  });

  it("serializes concurrent webhook deliveries for one payment", async () => {
    const database = createPaymentDatabase();
    const stripe = { constructWebhookEvent(raw) { return JSON.parse(raw.toString("utf8")); } };
    const service = createPaymentService({ database, stripe, timeZone: "Asia/Kolkata" });
    const body1 = Buffer.from(JSON.stringify(createSessionEvent("checkout.session.completed", "evt_concurrent_1")));
    const body2 = Buffer.from(JSON.stringify(createSessionEvent("checkout.session.async_payment_succeeded", "evt_concurrent_2")));
    const [first, second] = await Promise.all([service.processWebhook(body1, "sig"), service.processWebhook(body2, "sig")]);
    assert.equal(first.status, "confirmed");
    assert.equal(second.status, "confirmed");
    assert.equal(database.state.appointment.id, appointmentId);
    assert.equal(database.state.calls.filter((sql) => sql.startsWith("INSERT INTO appointments")).length, 1);
  });

  it("denies another patient payment status and cancellation requests without changing payment or appointment data", async () => {
    const { app, database, stripeCalls } = createPaymentHttpFixture();
    database.state.payment.status = "captured";
    database.state.payment.appointment_id = appointmentId;
    database.state.payment.slot_hold_id = null;
    database.state.hold.status = "consumed";
    database.state.appointment = { ...appointment };
    database.state.hold.status = "consumed";
    const before = {
      payment: { ...database.state.payment },
      appointment: { ...database.state.appointment },
      hold: { ...database.state.hold },
      calls: database.state.calls.length,
      events: database.state.events.size,
      reconciliations: database.state.reconciliation.size,
    };

    await withServer(app, async (url) => {
      for (const [method, path] of [
        ["GET", `/api/v1/payments/${paymentId}/status`],
        ["POST", `/api/v1/payments/${paymentId}/cancel`],
      ]) {
        const response = await fetch(`${url}${path}`, { method, headers: { "x-test-clerk-user": "clerk_other_patient" } });
        assert.equal(response.status, 404);
        assert.deepEqual(await response.json(), { error: { code: "PAYMENT_NOT_FOUND", message: "Payment not found" } });
      }
    });

    assert.deepEqual(database.state.payment, before.payment);
    assert.deepEqual(database.state.appointment, before.appointment);
    assert.deepEqual(database.state.hold, before.hold);
    assert.equal(database.state.calls.length, before.calls);
    assert.equal(database.state.events.size, before.events);
    assert.equal(database.state.reconciliation.size, before.reconciliations);
    assert.deepEqual(stripeCalls, []);
  });

  it("leaves payment state intact when Stripe retrieval fails, then recovers from a later successful retrieval", async () => {
    const database = createPaymentDatabase();
    let retrieveCount = 0;
    const stripe = {
      async retrieveCheckoutSession(id) {
        retrieveCount += 1;
        assert.equal(id, sessionId);
        if (retrieveCount === 1) throw new Error("Stripe request timed out");
        const session = createSessionEvent("checkout.session.completed", "not-used").data.object;
        session.status = "open";
        session.payment_status = "unpaid";
        return session;
      },
    };
    const service = createPaymentService({ database, stripe, timeZone: "Asia/Kolkata" });
    const before = { payment: { ...database.state.payment }, hold: { ...database.state.hold }, appointment: database.state.appointment };
    await assert.rejects(service.getPaymentStatus(patient, paymentId), /Stripe request timed out/);
    assert.deepEqual(database.state.payment, before.payment);
    assert.deepEqual(database.state.hold, before.hold);
    assert.equal(database.state.appointment, before.appointment);

    const status = await service.getPaymentStatus(patient, paymentId);
    assert.equal(status.status, "pending");
    assert.equal(database.state.payment.status, "pending");
    assert.equal(database.state.appointment, null);
    assert.equal(retrieveCount, 2);
  });

  it("falls back to retrieval when session expiration fails and leaves an open session pending", async () => {
    const database = createPaymentDatabase();
    const calls = [];
    const stripe = {
      async expireCheckoutSession(id) { calls.push(["expire", id]); throw new Error("Stripe expiration request failed"); },
      async retrieveCheckoutSession(id) {
        calls.push(["retrieve", id]);
        const session = createSessionEvent("checkout.session.completed", "not-used").data.object;
        session.status = "open";
        session.payment_status = "unpaid";
        return session;
      },
    };
    const service = createPaymentService({ database, stripe, timeZone: "Asia/Kolkata" });
    const before = { payment: { ...database.state.payment }, hold: { ...database.state.hold }, calls: database.state.calls.length };
    assert.deepEqual(await service.cancelCheckoutSession(patient, paymentId), { status: "pending" });
    assert.deepEqual(calls, [["expire", sessionId], ["retrieve", sessionId]]);
    assert.deepEqual(database.state.payment, before.payment);
    assert.deepEqual(database.state.hold, before.hold);
    assert.equal(database.state.calls.length, before.calls);
    assert.equal(database.state.appointment, null);
  });

  it("never cancels or releases a payment hold after successful capture", async () => {
    const database = createPaymentDatabase();
    database.state.payment.status = "captured";
    database.state.payment.appointment_id = appointmentId;
    database.state.payment.slot_hold_id = null;
    database.state.hold.status = "consumed";
    database.state.appointment = { ...appointment };
    const stripeCalls = [];
    const stripe = {
      async expireCheckoutSession(id) { stripeCalls.push(["expire", id]); throw new Error("must not expire captured payment"); },
      async retrieveCheckoutSession(id) { stripeCalls.push(["retrieve", id]); throw new Error("must not retrieve captured payment"); },
    };
    const service = createPaymentService({ database, stripe, timeZone: "Asia/Kolkata" });
    const before = { ...database.state.payment };
    assert.deepEqual(await service.cancelCheckoutSession(patient, paymentId), { status: "captured" });
    assert.deepEqual(database.state.payment, before);
    assert.equal(database.state.appointment.status, "confirmed");
    assert.equal(database.state.hold.status, "consumed");
    assert.deepEqual(stripeCalls, []);
  });

  it("does not mutate payment data when both Stripe expiration and fallback retrieval fail", async () => {
    const database = createPaymentDatabase();
    const stripe = {
      async expireCheckoutSession() { throw new Error("expiration unavailable"); },
      async retrieveCheckoutSession() { throw new Error("retrieval unavailable"); },
    };
    const service = createPaymentService({ database, stripe, timeZone: "Asia/Kolkata" });
    const before = { payment: { ...database.state.payment }, hold: { ...database.state.hold }, calls: database.state.calls.length };
    await assert.rejects(service.cancelCheckoutSession(patient, paymentId), /retrieval unavailable/);
    assert.deepEqual(database.state.payment, before.payment);
    assert.deepEqual(database.state.hold, before.hold);
    assert.equal(database.state.calls.length, before.calls);
    assert.equal(database.state.appointment, null);
  });

  it("limits payment lookup to the owning patient and requires the patient role", async () => {
    const database = createPaymentDatabase();
    const service = createPaymentService({ database, stripe: {}, frontendOrigin: "https://medrella.example" });
    await assert.rejects(service.getPaymentStatus({ id: "other-user", role: "patient" }, paymentId), { code: "PAYMENT_NOT_FOUND" });
    await assert.rejects(service.createCheckoutSession({ id: userId, role: "doctor" }, {}), { code: "FORBIDDEN" });
  });
});
