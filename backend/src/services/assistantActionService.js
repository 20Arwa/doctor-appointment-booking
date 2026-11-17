const { randomUUID } = require("node:crypto");
const { z } = require("zod");
const appointmentService = require("./appointmentService");
const { stripeMinorUnits } = require("./paymentService");

const actionSchemas = {
  book: z.object({ availability_id: z.uuid(), reason: z.string().trim().max(2000).optional() }).strict(),
  reschedule: z.object({ appointment_id: z.uuid(), availability_id: z.uuid() }).strict(),
  cancel: z.object({ appointment_id: z.uuid() }).strict(),
};

class AssistantActionError extends Error {
  constructor(code, status, message) { super(message); this.code = code; this.status = status; }
}

function fail(code, status, message) { throw new AssistantActionError(code, status, message); }

function sameArguments(first, second) {
  if (!first || !second || typeof first !== "object" || typeof second !== "object" || Array.isArray(first) || Array.isArray(second)) return false;
  const firstKeys = Object.keys(first).sort();
  const secondKeys = Object.keys(second).sort();
  return firstKeys.length === secondKeys.length
    && firstKeys.every((key, index) => key === secondKeys[index] && first[key] === second[key]);
}

function hasVerifiedProposalEvidence(toolResults, userId, conversationId, assistantMessageId, actionType, args) {
  const toolName = ({ book: "prepare_booking_action", reschedule: "prepare_reschedule_action", cancel: "prepare_cancellation_action" })[actionType];
  if (!toolName || !Array.isArray(toolResults)) return false;
  return toolResults.some((result) => {
    const evidence = result?.tool === "__internal_action_context" ? result.data?.proposal_evidence : null;
    if (!evidence || evidence.version !== 1 || evidence.proposal_succeeded !== true
        || evidence.requires_patient_confirmation !== true || evidence.tool_name !== toolName
        || evidence.action_type !== actionType || evidence.user_id !== userId
        || evidence.conversation_id !== conversationId || evidence.assistant_message_id !== assistantMessageId
        || !sameArguments(evidence.action_args, args)) return false;
    if (actionType === "book") return evidence.verified_appointment_id === null && evidence.verified_availability_id === args.availability_id;
    if (actionType === "reschedule") return evidence.verified_appointment_id === args.appointment_id && evidence.verified_availability_id === args.availability_id;
    return evidence.verified_appointment_id === args.appointment_id && evidence.verified_availability_id === null;
  });
}

function isProposalDismissed(toolResults, actionType) {
  return Array.isArray(toolResults) && toolResults.some((result) => result?.tool === "__internal_action_context"
    && result.data?.dismissed_proposals?.[actionType] === true);
}

async function transaction(database, operation) {
  const client = await database.connect();
  try {
    await client.query("BEGIN");
    const value = await operation(client);
    await client.query("COMMIT");
    return value;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally { client.release(); }
}

function createAssistantActionService({ database, paymentService, appointments = appointmentService, timeZone = "Asia/Kolkata" }) {
  async function hasConfirmedBookingForSlot(client, user, availabilityId) {
    const result = await client.query(
      `SELECT 1
       FROM appointments existing
       JOIN patients patient ON patient.id = existing.patient_id
       JOIN availability booked_slot ON booked_slot.id = existing.availability_id
       JOIN availability selected_slot ON selected_slot.id = $2
       WHERE patient.user_id = $1 AND existing.status = 'confirmed'
         AND booked_slot.doctor_id = selected_slot.doctor_id
         AND existing.scheduled_date = selected_slot.date
         AND existing.scheduled_start_time = selected_slot.start_time
       LIMIT 1`,
      [user.id, availabilityId],
    );
    return Boolean(result.rows[0]);
  }

  async function validateSlot(client, availabilityId, patientUser = null) {
    const result = await client.query(
      `SELECT av.id, av.doctor_id, av.date::text AS date,
              av.start_time::text AS start_time, av.end_time::text AS end_time,
              av.mode, av.capacity, av.booking_visibility, av.deleted_at,
              d.consultation_fee::text AS consultation_fee,
              du.first_name AS doctor_first_name, du.last_name AS doctor_last_name,
              d.specialty
       FROM availability av JOIN doctors d ON d.id = av.doctor_id
       JOIN users du ON du.id = d.user_id
       WHERE av.id = $1 AND du.is_active = TRUE`, [availabilityId],
    );
    const slot = result.rows[0];
    if (!slot || slot.deleted_at || slot.booking_visibility !== "public") fail("SLOT_UNAVAILABLE", 409, "This slot is no longer available");
    if (patientUser && await hasConfirmedBookingForSlot(client, patientUser, availabilityId)) {
      fail("BOOKING_ALREADY_EXISTS", 409, "You already have a confirmed appointment with this doctor at that time.");
    }
    const occupied = await appointments.countOccupiedPlaces(client, availabilityId);
    if (occupied >= Number(slot.capacity || 1)) fail("SLOT_CAPACITY_REACHED", 409, "This slot has reached capacity");
    return { ...slot, remaining_capacity: Number(slot.capacity || 1) - occupied };
  }

  async function verifiedMessage(user, conversationId, assistantMessageId, actionType, rawArgs, client = database) {
    const schema = actionSchemas[actionType];
    const supplied = rawArgs === undefined ? null : schema?.safeParse(rawArgs);
    if (rawArgs !== undefined && !supplied?.success) fail("INVALID_ACTION", 400, "Action details are invalid");
    const conversation = await client.query(
      `SELECT m.id, c.user_id, m.tool_results FROM assistant_conversations c
       JOIN assistant_messages m ON m.conversation_id = c.id
       WHERE c.id = $1 AND c.user_id = $2 AND m.id = $3 AND m.role = 'assistant'${client !== database ? " FOR UPDATE OF m" : ""}`,
      [conversationId, user.id, assistantMessageId],
    );
    if (!conversation.rows[0]) fail("CONVERSATION_NOT_FOUND", 404, "Assistant message not found");
    const evidence = (conversation.rows[0].tool_results || []).find((result) => {
      const proposal = result?.tool === "__internal_action_context" ? result.data?.proposal_evidence : null;
      return proposal?.version === 1 && proposal.proposal_succeeded === true
        && proposal.requires_patient_confirmation === true && proposal.action_type === actionType
        && proposal.user_id === user.id && proposal.conversation_id === conversationId
        && proposal.assistant_message_id === assistantMessageId;
    })?.data?.proposal_evidence;
    if (!evidence || (supplied && !sameArguments(supplied.data, evidence.action_args))
        || conversation.rows[0].user_id !== user.id
        || !hasVerifiedProposalEvidence(conversation.rows[0].tool_results, user.id, conversationId, assistantMessageId, actionType, evidence.action_args)) {
      fail("PROPOSAL_NOT_VERIFIED", 409, "This assistant message does not contain a matching verified proposal");
    }
    const parsed = schema?.safeParse(evidence.action_args);
    if (!parsed?.success) fail("INVALID_ACTION", 400, "Action details are invalid");
    return { row: conversation.rows[0], evidence, args: parsed.data };
  }

  async function existingIntent(user, conversationId, assistantMessageId, actionType, client = database) {
    const result = await client.query(
      `SELECT id, action_type, status, expires_at, action_args
       FROM assistant_action_intents
       WHERE user_id = $1 AND conversation_id = $2 AND assistant_message_id = $3 AND action_type = $4
       ORDER BY created_at DESC LIMIT 1${client !== database ? " FOR UPDATE" : ""}`,
      [user.id, conversationId, assistantMessageId, actionType],
    );
    return result.rows[0] || null;
  }

  function intentProposalView(intent) {
    const args = intent.action_args || {};
    const { __assistant_summary: summary, ..._privateArgs } = args;
    return { id: intent.id, action_type: intent.action_type, status: intent.status, expires_at: intent.expires_at, ...(summary && typeof summary === "object" ? { summary } : {}) };
  }

  async function prepare(user, conversationId, assistantMessageId, actionType, rawArgs) {
    if (user.role !== "patient") fail("FORBIDDEN", 403, "Only patients can prepare appointment actions");
    const { row, args } = await verifiedMessage(user, conversationId, assistantMessageId, actionType, rawArgs);
    if (isProposalDismissed(row.tool_results, actionType)) return { status: "dismissed" };
    const previous = await existingIntent(user, conversationId, assistantMessageId, actionType);
    if (previous) return intentProposalView(previous);
    let summary;
    let storedArgs = args;
    if (actionType === "book") {
      const slot = await validateSlot(database, args.availability_id, user);
      const preparedFeeMinor = stripeMinorUnits(slot.consultation_fee);
      storedArgs = { ...args, prepared_fee_minor: preparedFeeMinor };
      summary = { date: slot.date, start_time: slot.start_time, end_time: slot.end_time, doctor: `Dr. ${slot.doctor_first_name} ${slot.doctor_last_name}`.trim(), specialty: slot.specialty, consultation_fee: (preparedFeeMinor / 100).toFixed(2), currency: "INR", mode: slot.mode || "legacy", capacity: Number(slot.capacity || 1), remaining_capacity: slot.remaining_capacity };
    } else if (actionType === "reschedule") {
      const appointment = await appointments.getAppointment(database, user, args.appointment_id);
      if (appointment.status !== "confirmed") fail("APPOINTMENT_STATE_CONFLICT", 409, "Only confirmed appointments can be rescheduled");
      const slot = await validateSlot(database, args.availability_id);
      summary = { previous_date: appointment.date, previous_start_time: appointment.start_time, date: slot.date, start_time: slot.start_time, end_time: slot.end_time, doctor: `Dr. ${slot.doctor_first_name} ${slot.doctor_last_name}`.trim(), specialty: slot.specialty, consultation_fee: slot.consultation_fee, currency: "INR", mode: slot.mode || "legacy", capacity: Number(slot.capacity || 1), remaining_capacity: slot.remaining_capacity };
    } else {
      const appointment = await appointments.getAppointment(database, user, args.appointment_id);
      if (appointment.status !== "confirmed") fail("APPOINTMENT_STATE_CONFLICT", 409, "Only confirmed appointments can be cancelled");
      const refund = await paymentService.previewCancellationRefund(user, args.appointment_id);
      summary = {
        ...refund,
        date: appointment.date,
        start_time: appointment.start_time,
        end_time: appointment.end_time,
        ...(appointment.doctor_first_name || appointment.doctor_last_name ? { doctor: `Dr. ${appointment.doctor_first_name || ""} ${appointment.doctor_last_name || ""}`.trim() } : {}),
        specialty: appointment.specialty,
        consultation_fee: appointment.consultation_fee,
        currency: appointment.consultation_currency || "INR",
      };
    }
    return transaction(database, async (client) => {
      const locked = await verifiedMessage(user, conversationId, assistantMessageId, actionType, rawArgs, client);
      if (isProposalDismissed(locked.row.tool_results, actionType)) return { status: "dismissed" };
      const alreadyPrepared = await existingIntent(user, conversationId, assistantMessageId, actionType, client);
      if (alreadyPrepared) return intentProposalView(alreadyPrepared);
      const inserted = await client.query(
        `INSERT INTO assistant_action_intents
           (user_id, conversation_id, assistant_message_id, action_type, action_args, expires_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, NOW() + INTERVAL '5 minutes')
         RETURNING id, status, expires_at`,
        [user.id, conversationId, assistantMessageId, actionType, JSON.stringify({ ...storedArgs, __assistant_summary: summary })],
      );
      return { ...inserted.rows[0], action_type: actionType, summary };
    });
  }

  async function dismiss(user, conversationId, assistantMessageId, actionType) {
    if (user.role !== "patient") fail("FORBIDDEN", 403, "Only patients can dismiss appointment proposals");
    return transaction(database, async (client) => {
      const verified = await verifiedMessage(user, conversationId, assistantMessageId, actionType, undefined, client);
      if (isProposalDismissed(verified.row.tool_results, actionType)) return { status: "dismissed" };
      const intents = await client.query(
        `SELECT id, status FROM assistant_action_intents
         WHERE user_id = $1 AND conversation_id = $2 AND assistant_message_id = $3 AND action_type = $4
         FOR UPDATE`,
        [user.id, conversationId, assistantMessageId, actionType],
      );
      if (intents.rows.some((intent) => !["pending", "expired", "failed"].includes(intent.status))) {
        fail("ACTION_ALREADY_HANDLED", 409, "This action has already been handled");
      }
      if (intents.rows.some((intent) => intent.status === "pending")) {
        await client.query(
          `UPDATE assistant_action_intents SET status = 'expired', execution_lease_until = NULL, execution_lease_token = NULL
           WHERE user_id = $1 AND conversation_id = $2 AND assistant_message_id = $3 AND action_type = $4 AND status = 'pending'`,
          [user.id, conversationId, assistantMessageId, actionType],
        );
      }
      await client.query(
        `UPDATE assistant_messages
         SET tool_results = tool_results || $2::jsonb
         WHERE id = $1 AND conversation_id = $3 AND role = 'assistant'`,
        [assistantMessageId, JSON.stringify([{ tool: "__internal_action_context", data: { dismissed_proposals: { [actionType]: true } } }]), conversationId],
      );
      return { status: "dismissed" };
    });
  }

  async function intentView(user, conversationId, intentId) {
    await database.query(
      `UPDATE assistant_action_intents SET status = 'expired'
       WHERE id = $1 AND user_id = $2 AND conversation_id = $3
         AND status = 'pending' AND expires_at <= NOW()`, [intentId, user.id, conversationId],
    );
    const result = await database.query(
      `SELECT id, action_type, status, expires_at, action_args
       FROM assistant_action_intents
       WHERE id = $1 AND user_id = $2 AND conversation_id = $3`,
      [intentId, user.id, conversationId],
    );
    if (!result.rows[0]) fail("ACTION_NOT_FOUND", 404, "Action confirmation not found");
    const { action_args: storedArgs, ...view } = result.rows[0];
    const { __assistant_summary: summary, ..._args } = storedArgs || {};
    if (summary && typeof summary === "object") view.summary = summary;
    if (view.action_type === "cancel") {
      const outcome = await database.query(
        `SELECT appointment.status AS cancellation_status,
                refund.status AS refund_status, refund.amount::text AS refund_amount,
                refund.currency, payment.status AS payment_status
         FROM appointments appointment
         JOIN patients patient ON patient.id = appointment.patient_id AND patient.user_id = $1
         LEFT JOIN refunds refund
           ON refund.idempotency_key = 'appointment-cancel:' || appointment.id::text
         LEFT JOIN payments payment ON payment.id = refund.payment_id
         WHERE appointment.id = $2`, [user.id, _args.appointment_id],
      );
      if (outcome.rows[0]) Object.assign(view, outcome.rows[0]);
    }
    return view;
  }

  async function claim(client, user, conversationId, intentId, token) {
    const result = await client.query(
      `SELECT id, action_type, action_args, status, expires_at,
              expires_at <= clock_timestamp() AS is_expired,
              execution_lease_until > clock_timestamp() AS lease_active,
              execution_lease_until, execution_lease_token
       FROM assistant_action_intents
       WHERE id = $1 AND user_id = $2 AND conversation_id = $3
       FOR UPDATE`, [intentId, user.id, conversationId],
    );
    const intent = result.rows[0];
    if (!intent) fail("ACTION_NOT_FOUND", 404, "Action confirmation not found");
    if (intent.status === "pending" && intent.is_expired) {
      await client.query("UPDATE assistant_action_intents SET status = 'expired' WHERE id = $1", [intentId]);
      return { ...intent, status: "expired" };
    }
    if (intent.status === "pending") {
      await client.query(
        `UPDATE assistant_action_intents
        SET status = 'executing', execution_lease_until = clock_timestamp() + INTERVAL '2 minutes', execution_lease_token = $2
         WHERE id = $1`, [intentId, token],
      );
      return intent;
    }
    if (["checkout_pending", "refund_pending", "executing"].includes(intent.status)) {
      if (intent.lease_active) fail("ACTION_IN_PROGRESS", 409, "This action is already being processed");
      await client.query(
        `UPDATE assistant_action_intents
         SET execution_lease_until = clock_timestamp() + INTERVAL '2 minutes', execution_lease_token = $2
         WHERE id = $1`, [intentId, token],
      );
      return intent;
    }
    fail("ACTION_ALREADY_HANDLED", 409, "This action has already been handled");
  }

  async function releaseToState(intentId, token, status) {
    const updated = await database.query(
      `UPDATE assistant_action_intents
       SET status = $3, execution_lease_until = NULL, execution_lease_token = NULL
       WHERE id = $1 AND execution_lease_token = $2`, [intentId, token, status],
    );
    if (!updated.rowCount) {
      const latest = await database.query("SELECT status FROM assistant_action_intents WHERE id = $1", [intentId]);
      if (latest.rows[0]?.status === status) return status;
      if (["completed", "failed", "expired"].includes(latest.rows[0]?.status)) return latest.rows[0].status;
      fail("ACTION_LEASE_LOST", 409, "The action lease changed; retry to retrieve its status");
    }
    return status;
  }

  async function finishRefund(user, intent, token) {
    const appointment = await appointments.getAppointment(database, user, intent.action_args.appointment_id).catch(() => null);
    const refund = await paymentService.refundCancelledAppointment(user, appointment || { id: intent.action_args.appointment_id });
    if (refund.status === "pending") {
      const nextState = await releaseToState(intent.id, token, "refund_pending");
      return { status: nextState, cancellation_status: "cancelled", refund_status: nextState === "refund_pending" ? "pending" : refund.status, amount: refund.amount, currency: refund.currency, payment_status: refund.payment_status };
    }
    const failed = ["failed", "cancelled"].includes(refund.status);
    const nextState = await releaseToState(intent.id, token, failed ? "failed" : "completed");
    return { status: nextState, cancellation_status: "cancelled", refund_status: refund.status, amount: refund.amount, currency: refund.currency, payment_status: refund.payment_status };
  }

  async function confirm(user, conversationId, intentId) {
    if (user.role !== "patient") fail("FORBIDDEN", 403, "Only patients can confirm appointment actions");
    const token = randomUUID();
    const current = await intentView(user, conversationId, intentId);
    if (current.status === "completed") return { status: "completed", replayed: true };
    if (current.status === "expired") fail("ACTION_EXPIRED", 409, "This confirmation has expired");
    let intent;
    if (current.action_type === "cancel") {
      intent = await transaction(database, async (client) => {
        const row = await claim(client, user, conversationId, intentId, token);
        if (row.status !== "pending") return row;
        const appointment = await appointments.cancelAppointment(database, user, row.action_args.appointment_id, client);
        const consumed = await client.query(
          `UPDATE assistant_action_intents
           SET status = 'refund_pending'
           WHERE id = $1 AND execution_lease_token = $2 RETURNING id`, [intentId, token],
        );
        if (!consumed.rows[0]) fail("ACTION_LEASE_LOST", 409, "The action lease changed; retry to retrieve its status");
        return { ...row, status: "refund_pending", appointment };
      });
    }
    if (!intent && current.action_type === "reschedule") {
      const appointment = await transaction(database, async (client) => {
        const row = await claim(client, user, conversationId, intentId, token);
        if (row.status !== "pending") fail("ACTION_ALREADY_HANDLED", 409, "This action is already being processed");
        const result = await appointments.rescheduleAppointment(database, user, timeZone, row.action_args.appointment_id, row.action_args.availability_id, client, { requirePublic: true });
        const consumed = await client.query(
          `UPDATE assistant_action_intents SET status = 'completed', execution_lease_until = NULL, execution_lease_token = NULL
           WHERE id = $1 AND execution_lease_token = $2 RETURNING id`, [intentId, token],
        );
        if (!consumed.rows[0]) fail("ACTION_LEASE_LOST", 409, "The action lease changed; retry to retrieve its status");
        return result;
      });
      return { status: "completed", appointment: { id: appointment.id, date: appointment.date, start_time: appointment.start_time } };
    }
    if (current.action_type === "book") {
      intent = await transaction(database, async (client) => {
        const row = await claim(client, user, conversationId, intentId, token);
        if (row.status !== "pending" && row.status !== "executing") return row;
        if (await hasConfirmedBookingForSlot(client, user, row.action_args.availability_id)) {
          const failed = await client.query(
            `UPDATE assistant_action_intents
             SET status = 'failed', execution_lease_until = NULL, execution_lease_token = NULL
             WHERE id = $1 AND execution_lease_token = $2 RETURNING id`, [intentId, token],
          );
          if (!failed.rows[0]) fail("ACTION_LEASE_LOST", 409, "The action lease changed; retry to retrieve its status");
          return { ...row, status: "failed", reason: "duplicate_booking" };
        }
        return row;
      });
      if (intent.reason === "duplicate_booking") return { status: "failed", reason: "duplicate_booking" };
      if (intent.status === "expired") fail("ACTION_EXPIRED", 409, "This confirmation has expired");
      if (!["pending", "executing", "checkout_pending"].includes(intent.status)) return { status: intent.status };
      if (!Number.isSafeInteger(intent.action_args.prepared_fee_minor)) {
        await releaseToState(intent.id, token, "failed");
        fail("BOOKING_CONFIRMATION_STALE", 409, "The booking details changed. Prepare and confirm the appointment again.");
      }
      let checkout;
      try {
        checkout = await paymentService.createCheckoutSession(user, {
          availability_id: intent.action_args.availability_id,
          idempotency_key: intent.id,
          reason: intent.action_args.reason,
          expected_fee_minor: intent.action_args.prepared_fee_minor,
        });
      } catch (error) {
        if (error.code === "BOOKING_FEE_CHANGED") {
          await releaseToState(intent.id, token, "failed");
          fail("BOOKING_CONFIRMATION_STALE", 409, "The consultation fee changed. Prepare and confirm the appointment again.");
        }
        throw error;
      }
      const state = await releaseToState(intent.id, token, "checkout_pending");
      if (state !== "checkout_pending") return { status: state };
      return { status: "checkout_pending", checkout_url: checkout.checkout_url, expires_at: checkout.expires_at };
    }
    if (intent.action_type === "cancel" && ["refund_pending", "executing"].includes(intent.status)) return finishRefund(user, intent, token);
    return { status: intent.status };
  }

  async function reconcileCheckout(paymentId, outcome) {
    const result = await database.query(
      `UPDATE assistant_action_intents intent
       SET status = CASE
             WHEN $2 = 'confirmed' THEN 'completed'
             WHEN $2 IN ('failed', 'cancelled', 'expired', 'captured_slot_unavailable') THEN 'failed'
             ELSE 'checkout_pending'
           END,
           execution_lease_until = CASE WHEN $2 IN ('pending', 'authorized') THEN execution_lease_until ELSE NULL END,
           execution_lease_token = CASE WHEN $2 IN ('pending', 'authorized') THEN execution_lease_token ELSE NULL END
       FROM payments payment
       WHERE payment.id = $1 AND payment.idempotency_key = intent.id::text
         AND intent.action_type = 'book' AND intent.status IN ('executing', 'checkout_pending')
       RETURNING intent.id`, [paymentId, outcome],
    );
    return result.rowCount;
  }

  async function reconcileRefund(refundId, outcome) {
    const nextStatus = outcome === "processed" ? "completed"
      : ["failed", "cancelled"].includes(outcome) ? "failed" : "refund_pending";
    const result = await database.query(
      `UPDATE assistant_action_intents intent
       SET status = $2,
           execution_lease_until = CASE WHEN $2 = 'refund_pending' THEN execution_lease_until ELSE NULL END,
           execution_lease_token = CASE WHEN $2 = 'refund_pending' THEN execution_lease_token ELSE NULL END
       FROM refunds refund
       WHERE refund.id = $1 AND intent.action_type = 'cancel'
         AND (intent.status = 'refund_pending' OR ($2 = 'completed' AND intent.status = 'failed'))
         AND refund.idempotency_key = 'appointment-cancel:' || (intent.action_args->>'appointment_id')
       RETURNING intent.id`, [refundId, nextStatus],
    );
    return result.rowCount;
  }

  return { confirm, dismiss, intentView, prepare, reconcileCheckout, reconcileRefund };
}

module.exports = { AssistantActionError, createAssistantActionService };
