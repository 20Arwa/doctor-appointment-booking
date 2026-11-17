const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { createAssistantActionService, AssistantActionError } = require("../src/services/assistantActionService");

const user = { id: "11111111-1111-4111-8111-111111111111", role: "patient" };
const conversationId = "22222222-2222-4222-8222-222222222222";
const messageId = "33333333-3333-4333-8333-333333333333";
const intentId = "44444444-4444-4444-8444-444444444444";
const availabilityId = "55555555-5555-4555-8555-555555555555";

function mockDatabase({ expiry = new Date(Date.now() + 60_000) } = {}) {
  const state = { intent: null, lease: Promise.resolve(), calls: [], slotAvailable: false, toolResults: [] };
  const execute = async (sql, values = []) => {
    state.calls.push({ sql, values });
    if (sql === "BEGIN") {
      let release;
      const prior = state.lease;
      state.lease = new Promise((resolve) => { release = resolve; });
      await prior;
      return { rows: [], release };
    }
    if (sql === "COMMIT" || sql === "ROLLBACK") return { rows: [] };
    if (sql.includes("SELECT av.id, av.doctor_id")) return { rows: state.slotAvailable ? [{ id: availabilityId, doctor_id: "66666666-6666-4666-8666-666666666666", date: "2099-01-01", start_time: "09:00:00", end_time: "09:30:00", mode: "wave", capacity: 2, booking_visibility: "public", deleted_at: null, consultation_fee: "500.005", doctor_first_name: "Dee", doctor_last_name: "Doctor", specialty: "General Practice" }] : [] };
    if (sql.includes("COUNT(DISTINCT reservation.patient_id)")) return { rows: [{ occupied: 0 }] };
    if (sql.includes("UPDATE assistant_action_intents SET status = 'expired'")) {
      if (state.intent?.id === values[0] && new Date(state.intent.expires_at).getTime() <= Date.now()) state.intent.status = "expired";
      return { rows: [], rowCount: state.intent?.status === "expired" ? 1 : 0 };
    }
    if (sql.includes("SELECT m.id, c.user_id, m.tool_results FROM assistant_conversations c")) return { rows: values[1] === user.id && values[0] === conversationId && values[2] === messageId ? [{ id: messageId, user_id: user.id, tool_results: state.toolResults }] : [] };
    if (sql.startsWith("INSERT INTO assistant_action_intents")) {
      state.intent = { id: intentId, user_id: user.id, conversation_id: conversationId, assistant_message_id: messageId, action_type: values[3], action_args: JSON.parse(values[4]), status: "pending", expires_at: expiry, execution_lease_until: null, execution_lease_token: null };
      return { rows: [{ id: intentId, status: "pending", expires_at: expiry }] };
    }
    if (sql.includes("FROM assistant_action_intents") && sql.includes("FOR UPDATE")) {
      return { rows: state.intent && state.intent.id === values[0] && state.intent.user_id === values[1] && state.intent.conversation_id === values[2] ? [{ ...state.intent, is_expired: new Date(state.intent.expires_at).getTime() <= Date.now(), lease_active: Boolean(state.intent.execution_lease_until && new Date(state.intent.execution_lease_until).getTime() > Date.now()) }] : [] };
    }
    if (sql.includes("SET status = 'executing'")) {
      Object.assign(state.intent, { status: "executing", execution_lease_until: new Date(Date.now() + 120_000), execution_lease_token: values[1] });
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("SET status = 'refund_pending'")) {
      if (state.intent.execution_lease_token !== values[1]) return { rows: [], rowCount: 0 };
      state.intent.status = "refund_pending";
      return { rows: [{ id: intentId }], rowCount: 1 };
    }
    if (sql.includes("SET status = 'completed', execution_lease_until = NULL")) {
      if (state.intent.execution_lease_token !== values[1]) return { rows: [], rowCount: 0 };
      Object.assign(state.intent, { status: "completed", execution_lease_until: null, execution_lease_token: null });
      return { rows: [{ id: intentId }], rowCount: 1 };
    }
    if (sql.includes("SET execution_lease_until = clock_timestamp()")) {
      Object.assign(state.intent, { execution_lease_until: new Date(Date.now() + 120_000), execution_lease_token: values[1] });
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("SET status = $3, execution_lease_until = NULL")) {
      if (state.intent.execution_lease_token !== values[1]) return { rows: [], rowCount: 0 };
      Object.assign(state.intent, { status: values[2], execution_lease_until: null, execution_lease_token: null });
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("WHERE id = $1 AND user_id = $2 AND conversation_id = $3")) {
      return { rows: state.intent && state.intent.id === values[0] && state.intent.user_id === values[1] && state.intent.conversation_id === values[2] ? [{ id: intentId, action_type: state.intent.action_type, status: state.intent.status, expires_at: state.intent.expires_at, action_args: state.intent.action_args }] : [] };
    }
    return { rows: [], rowCount: 0 };
  };
  const database = {
    query: execute,
    async connect() {
      let release;
      return { async query(sql, values) {
        const result = await execute(sql, values);
        if (sql === "BEGIN") release = result.release;
        if (sql === "COMMIT" || sql === "ROLLBACK") release?.();
        return result;
      }, release() { release?.(); } };
    },
  };
  return { database, state };
}

function proposalEvidence(actionType, actionArgs, overrides = {}) {
  const appointmentId = actionType === "cancel" || actionType === "reschedule" ? actionArgs.appointment_id : null;
  const availabilityId = actionType === "book" || actionType === "reschedule" ? actionArgs.availability_id : null;
  return {
    tool: "__internal_action_context",
    data: { proposal_evidence: {
      version: 1,
      proposal_succeeded: true,
      requires_patient_confirmation: true,
      tool_name: ({ book: "prepare_booking_action", reschedule: "prepare_reschedule_action", cancel: "prepare_cancellation_action" })[actionType],
      action_type: actionType,
      action_args: actionArgs,
      verified_appointment_id: appointmentId,
      verified_availability_id: availabilityId,
      user_id: user.id,
      conversation_id: conversationId,
      assistant_message_id: messageId,
      ...overrides,
    } },
  };
}

describe("patient assistant action intents", () => {
  it("rejects non-patient actors and invalid or tampered action arguments", async () => {
    const { database, state } = mockDatabase();
    const service = createAssistantActionService({ database, paymentService: {} });
    await assert.rejects(service.prepare({ ...user, role: "doctor" }, conversationId, messageId, "book", { availability_id: availabilityId }), { code: "FORBIDDEN" });
    await assert.rejects(service.prepare(user, conversationId, messageId, "book", { availability_id: availabilityId, patient_id: user.id }), { code: "INVALID_ACTION" });
    assert.equal(state.intent, null);
  });

  it("requires successful persisted proposal evidence matching action, normalized args, and verified record IDs", async () => {
    const cases = [
      { actionType: "book", args: { availability_id: availabilityId, reason: "scheduled follow-up" } },
      { actionType: "reschedule", args: { appointment_id: messageId, availability_id: availabilityId } },
      { actionType: "cancel", args: { appointment_id: messageId } },
    ];
    for (const { actionType, args } of cases) {
      const { database, state } = mockDatabase();
      state.slotAvailable = true;
      state.toolResults = [proposalEvidence(actionType, args)];
      const appointments = {
        async getAppointment() { return { id: messageId, status: "confirmed", date: "2099-01-01", start_time: "09:00:00" }; },
        async countOccupiedPlaces() { return 0; },
      };
      const service = createAssistantActionService({ database, appointments, paymentService: { async previewCancellationRefund() { return { estimated_refund_amount: "0.00" }; } } });
      const intent = await service.prepare(user, conversationId, messageId, actionType, args);
      assert.equal(intent.action_type, actionType);
      assert.equal(state.intent.action_args.availability_id, args.availability_id);
      assert.equal(state.intent.action_args.appointment_id, args.appointment_id);
    }
  });

  it("rejects missing, unrelated, failed, or argument-mismatched proposal evidence", async () => {
    const args = { availability_id: availabilityId };
    const invalidEvidence = [
      [],
      [proposalEvidence("reschedule", { appointment_id: messageId, availability_id: availabilityId })],
      [proposalEvidence("book", args, { proposal_succeeded: false })],
      [proposalEvidence("book", { availability_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" })],
      [proposalEvidence("book", args, { conversation_id: "99999999-9999-4999-8999-999999999999" })],
      [proposalEvidence("book", args, { assistant_message_id: "99999999-9999-4999-8999-999999999999" })],
      [proposalEvidence("book", args, { user_id: "99999999-9999-4999-8999-999999999999" })],
      [proposalEvidence("book", args, { verified_availability_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" })],
    ];
    for (const toolResults of invalidEvidence) {
      const { database, state } = mockDatabase();
      state.slotAvailable = true;
      state.toolResults = toolResults;
      const service = createAssistantActionService({ database, paymentService: {} });
      await assert.rejects(service.prepare(user, conversationId, messageId, "book", args), { code: "PROPOSAL_NOT_VERIFIED" });
      assert.equal(state.intent, null);
    }
  });

  it("expires pending confirmations and prevents replay after completion", async () => {
    const { database, state } = mockDatabase({ expiry: new Date(Date.now() - 1000) });
    state.intent = { id: intentId, user_id: user.id, conversation_id: conversationId, action_type: "book", action_args: { availability_id: availabilityId }, status: "pending", expires_at: new Date(Date.now() - 1000) };
    const service = createAssistantActionService({ database, paymentService: {} });
    await assert.rejects(service.confirm(user, conversationId, intentId), { code: "ACTION_EXPIRED" });
    assert.equal(state.intent.status, "expired");
  });

  it("scopes confirmation lookup to the authenticated owner and conversation", async () => {
    const { database, state } = mockDatabase();
    state.intent = { id: intentId, user_id: user.id, conversation_id: conversationId, action_type: "book", action_args: { availability_id: availabilityId }, status: "pending", expires_at: new Date(Date.now() + 60_000) };
    const service = createAssistantActionService({ database, paymentService: {} });
    await assert.rejects(service.confirm({ ...user, id: "99999999-9999-4999-8999-999999999999" }, conversationId, intentId), { code: "ACTION_NOT_FOUND" });
    await assert.rejects(service.confirm(user, "99999999-9999-4999-8999-999999999999", intentId), { code: "ACTION_NOT_FOUND" });
  });

  it("uses a stable application idempotency key and fenced lease for paid checkout recovery", async () => {
    const { database, state } = mockDatabase();
    const checkouts = [];
    const service = createAssistantActionService({ database, paymentService: { async createCheckoutSession(actor, input) { checkouts.push({ actor, input }); return { checkout_url: "https://checkout.test/session", expires_at: "2099-01-01T00:00:00Z" }; } } });
    state.intent = { id: intentId, user_id: user.id, conversation_id: conversationId, action_type: "book", action_args: { availability_id: availabilityId, prepared_fee_minor: 50000 }, status: "pending", expires_at: new Date(Date.now() + 60_000), execution_lease_until: null, execution_lease_token: null };
    const first = await service.confirm(user, conversationId, intentId);
    assert.equal(first.status, "checkout_pending");
    assert.equal(checkouts[0].input.idempotency_key, intentId);
    assert.equal(checkouts[0].input.availability_id, availabilityId);
    assert.equal(checkouts[0].input.expected_fee_minor, 50000);
    assert.equal(state.intent.status, "checkout_pending");
    await service.confirm(user, conversationId, intentId);
    assert.equal(checkouts.length, 2);
    assert.equal(checkouts[1].input.idempotency_key, checkouts[0].input.idempotency_key);
  });

  it("serializes concurrent confirmation claims and ignores client-supplied action changes", async () => {
    const { database, state } = mockDatabase();
    const checkouts = [];
    const service = createAssistantActionService({ database, paymentService: { async createCheckoutSession(actor, input) { checkouts.push(input); await new Promise((resolve) => setTimeout(resolve, 10)); return { checkout_url: "https://checkout.test/session", expires_at: "2099-01-01T00:00:00Z" }; } } });
    state.intent = { id: intentId, user_id: user.id, conversation_id: conversationId, action_type: "book", action_args: { availability_id: availabilityId, prepared_fee_minor: 50000 }, status: "pending", expires_at: new Date(Date.now() + 60_000), execution_lease_until: null, execution_lease_token: null };
    const outcomes = await Promise.allSettled([
      service.confirm(user, conversationId, intentId, { availability_id: "99999999-9999-4999-8999-999999999999" }),
      service.confirm(user, conversationId, intentId),
    ]);
    assert.equal(outcomes.filter((item) => item.status === "fulfilled").length, 1);
    assert.equal(checkouts.length, 1);
    assert.equal(checkouts[0].availability_id, availabilityId);
  });

  it("marks fee-less legacy confirmations failed instead of starting checkout", async () => {
    const { database, state } = mockDatabase();
    let checkoutCalls = 0;
    const service = createAssistantActionService({ database, paymentService: { async createCheckoutSession() { checkoutCalls += 1; } } });
    state.intent = { id: intentId, user_id: user.id, conversation_id: conversationId, action_type: "book", action_args: { availability_id: availabilityId }, status: "pending", expires_at: new Date(Date.now() + 60_000), execution_lease_until: null, execution_lease_token: null };
    await assert.rejects(service.confirm(user, conversationId, intentId), { code: "BOOKING_CONFIRMATION_STALE" });
    assert.equal(state.intent.status, "failed");
    assert.equal(checkoutCalls, 0);
  });

  it("invalidates a confirmation when the checkout service detects a changed fee", async () => {
    const { database, state } = mockDatabase();
    const service = createAssistantActionService({ database, paymentService: { async createCheckoutSession() { throw Object.assign(new Error("fee changed"), { code: "BOOKING_FEE_CHANGED" }); } } });
    state.intent = { id: intentId, user_id: user.id, conversation_id: conversationId, action_type: "book", action_args: { availability_id: availabilityId, prepared_fee_minor: 50000 }, status: "pending", expires_at: new Date(Date.now() + 60_000), execution_lease_until: null, execution_lease_token: null };
    await assert.rejects(service.confirm(user, conversationId, intentId), { code: "BOOKING_CONFIRMATION_STALE" });
    assert.equal(state.intent.status, "failed");
  });

  it("runs rescheduling and intent completion in the same transaction", async () => {
    const { database, state } = mockDatabase();
    state.intent = { id: intentId, user_id: user.id, conversation_id: conversationId, action_type: "reschedule", action_args: { appointment_id: messageId, availability_id: availabilityId }, status: "pending", expires_at: new Date(Date.now() + 60_000), execution_lease_until: null, execution_lease_token: null };
    let transactionClient;
    const appointments = { async rescheduleAppointment(_db, _user, _zone, _appointmentId, _availabilityId, client, options) { transactionClient = client; assert.equal(options.requirePublic, true); await client.query("MOCK_APPOINTMENT_MUTATION"); return { id: messageId, date: "2099-01-01", start_time: "09:00" }; } };
    const service = createAssistantActionService({ database, paymentService: {}, appointments });
    const result = await service.confirm(user, conversationId, intentId);
    assert.equal(result.status, "completed");
    assert.equal(state.intent.status, "completed");
    assert.ok(transactionClient);
    assert.equal(state.calls.some(({ sql }) => sql === "MOCK_APPOINTMENT_MUTATION"), true);
  });

  it("does not repeat cancellation while recovering a pending refund and preserves a partial payment state", async () => {
    const { database, state } = mockDatabase();
    state.intent = { id: intentId, user_id: user.id, conversation_id: conversationId, action_type: "cancel", action_args: { appointment_id: messageId }, status: "pending", expires_at: new Date(Date.now() + 60_000), execution_lease_until: null, execution_lease_token: null };
    let cancellations = 0;
    let refunds = 0;
    const appointments = {
      async cancelAppointment(_db, _user, appointmentId, client) { cancellations += 1; await client.query("MOCK_CANCEL"); return { id: appointmentId }; },
      async getAppointment(_db, _user, appointmentId) { return { id: appointmentId, status: "cancelled" }; },
    };
    const paymentService = { async refundCancelledAppointment() {
      refunds += 1;
      return refunds === 1
        ? { status: "pending", amount: "50.00", currency: "INR" }
        : { status: "processed", amount: "50.00", currency: "INR", payment_status: "partially_refunded" };
    } };
    const service = createAssistantActionService({ database, paymentService, appointments });
    const first = await service.confirm(user, conversationId, intentId);
    assert.equal(first.status, "refund_pending");
    assert.equal(cancellations, 1);
    const recovered = await service.confirm(user, conversationId, intentId);
    assert.equal(recovered.status, "completed");
    assert.equal(recovered.cancellation_status, "cancelled");
    assert.equal(recovered.refund_status, "processed");
    assert.equal(recovered.payment_status, "partially_refunded");
    assert.equal(cancellations, 1);
    assert.equal(refunds, 2);
  });

  it("does not expose action arguments in status reads", async () => {
    const { database, state } = mockDatabase();
    state.intent = { id: intentId, user_id: user.id, conversation_id: conversationId, action_type: "book", action_args: { availability_id: availabilityId, reason: "sensitive" }, status: "pending", expires_at: new Date(Date.now() + 60_000) };
    const service = createAssistantActionService({ database, paymentService: {} });
    const status = await service.intentView(user, conversationId, intentId);
    assert.equal(status.id, intentId);
    assert.equal("action_args" in status, false);
    assert.equal(JSON.stringify(status).includes("sensitive"), false);
  });

  it("reconciles checkout and refund webhook outcomes through their stable local records", async () => {
    const calls = [];
    const database = { async query(sql, values) { calls.push({ sql, values }); return { rows: [], rowCount: 1 }; } };
    const service = createAssistantActionService({ database, paymentService: {} });
    await service.reconcileCheckout("payment-row-id", "confirmed");
    await service.reconcileRefund("refund-row-id", "processed");
    assert.match(calls[0].sql, /payment\.idempotency_key = intent\.id::text/);
    assert.deepEqual(calls[0].values, ["payment-row-id", "confirmed"]);
    assert.match(calls[1].sql, /refund\.idempotency_key = 'appointment-cancel:'/);
    assert.deepEqual(calls[1].values, ["refund-row-id", "completed"]);
  });

  it("rejects a slot that is no longer visible or bookable during preparation", async () => {
    const { database, state } = mockDatabase();
    state.toolResults = [proposalEvidence("book", { availability_id: availabilityId })];
    const service = createAssistantActionService({ database, paymentService: {} });
    await assert.rejects(service.prepare(user, conversationId, messageId, "book", { availability_id: availabilityId }), { code: "SLOT_UNAVAILABLE" });
    assert.equal(state.intent, null);
  });

  it("stores the normalized booking fee used in the preparation summary", async () => {
    const { database, state } = mockDatabase();
    state.slotAvailable = true;
    state.toolResults = [proposalEvidence("book", { availability_id: availabilityId })];
    const service = createAssistantActionService({ database, paymentService: {} });
    const prepared = await service.prepare(user, conversationId, messageId, "book", { availability_id: availabilityId });
    assert.equal(prepared.summary.consultation_fee, "500.01");
    assert.deepEqual(JSON.parse(state.calls.find(({ sql }) => sql.startsWith("INSERT INTO assistant_action_intents")).values[4]), {
      availability_id: availabilityId,
      prepared_fee_minor: 50001,
    });
  });
});
