const appointmentService = require("./appointmentService");
const { StripePaymentError } = require("./stripeService");
const { createRefundService } = require("./refundService");

const STRIPE_MIN_CHECKOUT_TTL_SECONDS = 30 * 60;
const CHECKOUT_CREATION_SAFETY_SECONDS = 60;
const HOLD_EXPIRY_SAFETY_SECONDS = 5 * 60;

class PaymentError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function fail(status, code, message) { throw new PaymentError(status, code, message); }

async function withTransaction(database, operation) {
  const client = await database.connect();
  let started = false;
  try {
    await client.query("BEGIN");
    started = true;
    const result = await operation(client);
    await client.query("COMMIT");
    started = false;
    return result;
  } catch (error) {
    if (started) await client.query("ROLLBACK").catch(() => {});
    if (error.code === "23505") fail(409, "PAYMENT_CONFLICT", "A payment or slot reservation already exists");
    throw error;
  } finally {
    client.release();
  }
}

async function lockSlot(client, availabilityId, { requireActive = false } = {}) {
  const result = await client.query(
    `SELECT av.id, av.doctor_id, av.deleted_at, av.date::text AS date, av.start_time::text AS start_time,
            av.end_time::text AS end_time, d.consultation_fee::text AS fee
     FROM availability av JOIN doctors d ON d.id = av.doctor_id
     JOIN users du ON du.id = d.user_id
     WHERE av.id = $1 AND du.is_active = TRUE
     FOR UPDATE OF av, d`,
    [availabilityId],
  );
  if (!result.rows[0]) fail(404, "SLOT_NOT_FOUND", "Availability slot not found");
  if (requireActive && result.rows[0].deleted_at) fail(409, "SLOT_UNAVAILABLE", "Availability slot is no longer available for payment");
  return result.rows[0];
}

async function lockDoctor(client, doctorId) {
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [doctorId]);
}

async function expireHoldsForSchedule(client, doctorId, date) {
  await client.query(
    `UPDATE payments p SET status = 'expired', expired_at = NOW(), updated_at = NOW()
     FROM appointment_slot_holds h JOIN availability av ON av.id = h.availability_id
     WHERE p.slot_hold_id = h.id AND p.provider = 'stripe'
       AND h.status = 'active' AND h.expires_at <= NOW()
       AND p.status IN ('created', 'pending', 'authorized')
       AND av.doctor_id = $1 AND av.date = $2::date`,
    [doctorId, date],
  );
  await client.query(
    `UPDATE appointment_slot_holds h SET status = 'expired', updated_at = NOW()
     FROM availability av
     WHERE av.id = h.availability_id AND h.status = 'active' AND h.expires_at <= NOW()
       AND av.doctor_id = $1 AND av.date = $2::date`,
    [doctorId, date],
  );
}

async function scheduleConflict(client, doctorId, date, startTime, endTime, excludedHoldId) {
  const appointments = await client.query(
    `SELECT 1 FROM appointments a JOIN availability av ON av.id = a.availability_id
     WHERE av.doctor_id = $1 AND a.status = 'confirmed' AND a.scheduled_date = $2::date
       AND a.scheduled_start_time < $4::time AND a.scheduled_end_time > $3::time LIMIT 1`,
    [doctorId, date, startTime, endTime],
  );
  if (appointments.rows[0]) return true;
  const holds = await client.query(
    `SELECT 1 FROM appointment_slot_holds h JOIN availability av ON av.id = h.availability_id
     WHERE av.doctor_id = $1 AND av.date = $2::date AND av.start_time < $4::time
       AND av.end_time > $3::time AND h.status = 'active' AND h.expires_at > NOW()
       AND h.id <> $5 LIMIT 1`,
    [doctorId, date, startTime, endTime, excludedHoldId],
  );
  return Boolean(holds.rows[0]);
}

async function findOwnedPayment(database, paymentId, userId) {
  const result = await database.query(
    `SELECT p.id, p.status, p.provider_order_id, p.provider_payment_id,
            p.amount::text AS amount, p.currency, p.appointment_id, p.slot_hold_id,
            h.id AS hold_id, COALESCE(h.patient_id, a.patient_id) AS patient_id,
            COALESCE(h.availability_id, a.availability_id) AS availability_id,
            h.expires_at, h.status AS hold_status, h.reason
     FROM payments p
     LEFT JOIN appointment_slot_holds h ON h.id = p.slot_hold_id
     LEFT JOIN appointments a ON a.id = p.appointment_id
     WHERE p.id = $1 AND COALESCE(h.patient_id, a.patient_id) =
       (SELECT id FROM patients WHERE user_id = $2)`,
    [paymentId, userId],
  );
  if (!result.rows[0]) fail(404, "PAYMENT_NOT_FOUND", "Payment not found");
  return result.rows[0];
}

function stripeMinorUnits(amount) {
  const minorUnits = Math.round(Number(amount) * 100);
  if (!Number.isSafeInteger(minorUnits) || minorUnits <= 0) fail(409, "PAYMENT_AMOUNT_INVALID", "The consultation fee is not payable");
  return minorUnits;
}

function paymentIntentId(session) {
  return typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id || null;
}

function validateSession(payment, session) {
  if (!session || session.id !== payment.provider_order_id
      || session.client_reference_id !== payment.id
      || session.metadata?.payment_id !== payment.id
      || session.amount_total !== stripeMinorUnits(payment.amount)
      || String(session.currency).toLowerCase() !== payment.currency.toLowerCase()) {
    fail(400, "PAYMENT_DETAILS_MISMATCH", "The Checkout Session does not match this appointment payment");
  }
}

function stripeReceiptUrl(value) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "pay.stripe.com" ? url.toString() : null;
  } catch (_error) {
    return null;
  }
}

function createPaymentService({ database, stripe, emailNotificationService, frontendOrigin, timeZone = "Asia/Kolkata", logger = console, now = Date.now }) {
  const refundService = createRefundService({ database, stripe, logger, now });
  async function closePaymentWithoutSession(reservation, status = "failed") {
    await withTransaction(database, async (client) => {
      const closed = await client.query(
        `UPDATE payments SET status = $2,
           failed_at = CASE WHEN $2 = 'failed' THEN COALESCE(failed_at, NOW()) ELSE failed_at END,
           expired_at = CASE WHEN $2 = 'expired' THEN COALESCE(expired_at, NOW()) ELSE expired_at END,
           updated_at = NOW()
         WHERE id = $1 AND provider_order_id IS NULL AND status IN ('created', 'pending')
         RETURNING slot_hold_id`,
        [reservation.id, status],
      );
      if (closed.rows[0]?.slot_hold_id) {
        await client.query("UPDATE appointment_slot_holds SET status = 'released', updated_at = NOW() WHERE id = $1 AND status = 'active'", [closed.rows[0].slot_hold_id]);
      }
    });
  }

  async function createCheckoutSession(user, input) {
    if (user.role !== "patient") fail(403, "FORBIDDEN", "Only patients can pay for appointments");
    const reservation = await withTransaction(database, async (client) => {
      const patientResult = await client.query("SELECT id FROM patients WHERE user_id = $1", [user.id]);
      const patientId = patientResult.rows[0]?.id;
      if (!patientId) fail(403, "PATIENT_PROFILE_REQUIRED", "An existing patient profile is required to book appointments");
      const slot = await lockSlot(client, input.availability_id, { requireActive: true });
      await lockDoctor(client, slot.doctor_id);
      await expireHoldsForSchedule(client, slot.doctor_id, slot.date);

      const prior = await client.query(
        `SELECT p.id, p.status, p.provider_order_id, p.amount::text AS amount, p.currency,
                h.expires_at, h.availability_id, h.id AS hold_id, av.doctor_id
         FROM payments p
         LEFT JOIN appointment_slot_holds h ON h.id = p.slot_hold_id
         LEFT JOIN appointments a ON a.id = p.appointment_id
         LEFT JOIN availability av ON av.id = h.availability_id
         WHERE p.provider = 'stripe' AND p.idempotency_key = $1
           AND COALESCE(h.patient_id, a.patient_id) = $2
         FOR UPDATE OF p`,
        [input.idempotency_key, patientId],
      );
      if (prior.rows[0]) {
        if (["failed", "cancelled", "expired", "captured", "partially_refunded", "refunded"].includes(prior.rows[0].status)) fail(409, "PAYMENT_ATTEMPT_CLOSED", "Start a new payment attempt for this appointment");
        if (prior.rows[0].availability_id !== input.availability_id) fail(409, "IDEMPOTENCY_KEY_REUSED", "This payment key belongs to a different slot");
        return { ...prior.rows[0], reused: true };
      }

      const existing = await client.query(
        `SELECT p.id, p.status, p.provider_order_id, p.amount::text AS amount, p.currency,
                h.expires_at, h.availability_id, h.id AS hold_id, av.doctor_id
         FROM payments p JOIN appointment_slot_holds h ON h.id = p.slot_hold_id
         JOIN availability av ON av.id = h.availability_id
         WHERE p.provider = 'stripe' AND h.patient_id = $1 AND h.availability_id = $2
           AND h.status = 'active' AND h.expires_at > NOW()
           AND p.status IN ('created', 'pending', 'authorized')
         ORDER BY p.created_at DESC LIMIT 1 FOR UPDATE OF p`,
        [patientId, input.availability_id],
      );
      if (existing.rows[0]) return { ...existing.rows[0], reused: true };

      const slotDateTime = new Date(`${slot.date}T${String(slot.start_time).slice(0, 8)}+05:30`);
      if (Number.isNaN(slotDateTime.getTime()) || slotDateTime <= new Date()) fail(409, "SLOT_UNAVAILABLE", "Availability slot is no longer bookable");
      const amount = stripeMinorUnits(slot.fee);
      if (await scheduleConflict(client, slot.doctor_id, slot.date, slot.start_time, slot.end_time, "00000000-0000-0000-0000-000000000000")) {
        fail(409, "SLOT_UNAVAILABLE", "The selected appointment time is already booked or reserved");
      }

      const hold = await client.query(
        `INSERT INTO appointment_slot_holds (availability_id, patient_id, status, expires_at, reason)
         VALUES ($1, $2, 'active', NOW() + INTERVAL '40 minutes', $3)
         RETURNING id, expires_at`,
        [input.availability_id, patientId, input.reason ?? null],
      );
      const payment = await client.query(
        `INSERT INTO payments (slot_hold_id, provider, amount, currency, status, idempotency_key)
         VALUES ($1, 'stripe', $2::numeric / 100, 'INR', 'created', $3)
         RETURNING id, amount::text AS amount, currency`,
        [hold.rows[0].id, amount, input.idempotency_key],
      );
      return { ...payment.rows[0], hold_id: hold.rows[0].id, expires_at: hold.rows[0].expires_at, availability_id: input.availability_id, doctor_id: slot.doctor_id, reused: false };
    });

    let session;
    try {
      if (reservation.provider_order_id) {
        session = await stripe.retrieveCheckoutSession(reservation.provider_order_id);
        validateSession(reservation, session);
        if (session.status !== "open") {
          if (session.status === "expired") await processSession(reservation, session, null);
          fail(409, "PAYMENT_SESSION_CLOSED", "This Checkout Session is no longer open");
        }
      } else {
        const amount = stripeMinorUnits(reservation.amount);
        const holdExpiresAt = Math.floor(new Date(reservation.expires_at).getTime() / 1000);
        const sessionExpiresAt = holdExpiresAt - HOLD_EXPIRY_SAFETY_SECONDS;
        const secondsUntilSessionExpiry = sessionExpiresAt - Math.ceil(now() / 1000);
        if (!Number.isFinite(holdExpiresAt) || secondsUntilSessionExpiry < STRIPE_MIN_CHECKOUT_TTL_SECONDS + CHECKOUT_CREATION_SAFETY_SECONDS) {
          // A reused order without a persisted Stripe ID may follow an ambiguous provider request.
          // Keep that hold until its fixed session expiry; close only a known-unstarted reservation.
          if (secondsUntilSessionExpiry <= 0) await closePaymentWithoutSession(reservation, "expired");
          else if (!reservation.reused) await closePaymentWithoutSession(reservation);
          fail(409, "CHECKOUT_WINDOW_UNAVAILABLE", "This appointment slot no longer has enough safe time to start Checkout. Refresh availability and choose another time.");
        }
        session = await stripe.createCheckoutSession({
          mode: "payment",
          line_items: [{
            price_data: {
              currency: reservation.currency.toLowerCase(),
              product_data: { name: "Doctor consultation appointment" },
              unit_amount: amount,
            },
            quantity: 1,
          }],
          client_reference_id: reservation.id,
          metadata: { payment_id: reservation.id },
          payment_intent_data: { metadata: { payment_id: reservation.id } },
          expires_at: sessionExpiresAt,
          success_url: `${frontendOrigin.replace(/\/+$/, "")}/patient/doctors/${encodeURIComponent(reservation.doctor_id)}?payment_id=${reservation.id}&session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${frontendOrigin.replace(/\/+$/, "")}/patient/doctors/${encodeURIComponent(reservation.doctor_id)}?payment_id=${reservation.id}&checkout=cancelled`,
        }, `medrella-payment-${reservation.id}`);
        if (!session.id || !session.url || !session.expires_at || session.status !== "open"
            || session.expires_at > sessionExpiresAt
            || session.expires_at - Math.ceil(now() / 1000) < STRIPE_MIN_CHECKOUT_TTL_SECONDS
            || session.amount_total !== amount || String(session.currency).toLowerCase() !== reservation.currency.toLowerCase()) {
          let sessionClosed = !session.id;
          if (session.id && session.status === "open") {
            try { sessionClosed = (await stripe.expireCheckoutSession(session.id)).status === "expired"; }
            catch (_error) { /* The fixed hold expiry bounds any uncertain live session. */ }
          }
          if (session?.status === "expired" || sessionClosed) await closePaymentWithoutSession(reservation, "expired");
          fail(502, "STRIPE_SESSION_INVALID", "Stripe returned an invalid Checkout Session");
        }
        await withTransaction(database, async (client) => {
          await client.query(
            `UPDATE payments SET provider_order_id = $2, provider_payment_id = $3,
               status = 'pending', updated_at = NOW()
             WHERE id = $1 AND status IN ('created', 'pending')`,
            [reservation.id, session.id, paymentIntentId(session)],
          );
        });
      }
      if (!session?.url) fail(502, "STRIPE_SESSION_INVALID", "Stripe did not return a Checkout URL");
    } catch (error) {
      if (error instanceof PaymentError) throw error;
      // Network errors and provider 5xx responses are ambiguous; retain the finite hold for retry.
      const definiteNoSession = error instanceof StripePaymentError
        || (Number(error.statusCode) >= 400 && Number(error.statusCode) < 500);
      if (definiteNoSession && !reservation.reused) await closePaymentWithoutSession(reservation);
      if (error.status === 503 && error.code) fail(error.status, error.code, error.message);
      logger.error("Stripe Checkout Session creation failed", { paymentId: reservation.id, message: error.message });
      fail(502, "STRIPE_SESSION_FAILED", "Stripe could not create the Checkout Session. Retry the same slot shortly.");
    }

    return {
      payment_id: reservation.id,
      session_id: session.id,
      checkout_url: session.url,
      expires_at: new Date(session.expires_at * 1000).toISOString(),
    };
  }

  async function recordReconciliation(client, payment, session, eventId, reason) {
    const paymentIntent = paymentIntentId(session);
    if (!paymentIntent) fail(400, "PAYMENT_INTENT_MISSING", "Stripe did not provide a PaymentIntent for this captured session");
    const inserted = await client.query(
      `INSERT INTO payment_capture_reconciliation
         (payment_id, provider, provider_order_id, provider_payment_id, amount, currency, provider_event_id, reason)
       VALUES ($1, 'stripe', $2, $3, $4::numeric / 100, $5, $6, $7)
       ON CONFLICT (provider, provider_payment_id) DO NOTHING RETURNING id`,
      [payment.id, session.id, paymentIntent, session.amount_total, String(session.currency).toUpperCase(), eventId, reason],
    );
    if (inserted.rows[0]) return inserted.rows[0].id;
    return (await client.query(
      "SELECT id FROM payment_capture_reconciliation WHERE provider = 'stripe' AND provider_payment_id = $1",
      [paymentIntent],
    )).rows[0]?.id;
  }

  async function confirmPaidSession(paymentSnapshot, session, event) {
    return withTransaction(database, async (client) => {
      const slot = await lockSlot(client, paymentSnapshot.availability_id);
      await lockDoctor(client, slot.doctor_id);
      if (event) {
        const inserted = await client.query(
          `INSERT INTO payment_provider_events (provider, provider_event_id, event_type, payment_id)
           VALUES ('stripe', $1, $2, $3) ON CONFLICT (provider, provider_event_id) DO NOTHING RETURNING id`,
          [event.id, event.type, paymentSnapshot.id],
        );
        if (!inserted.rows[0]) return { duplicate: true };
      }
      const result = await client.query(
        `SELECT p.id, p.status, p.provider_order_id, p.provider_payment_id, p.amount::text AS amount,
                p.currency, p.appointment_id, p.slot_hold_id, h.patient_id,
                h.availability_id, h.reason, h.status AS hold_status
         FROM payments p LEFT JOIN appointment_slot_holds h ON h.id = p.slot_hold_id
         WHERE p.id = $1 FOR UPDATE OF p`,
        [paymentSnapshot.id],
      );
      const current = result.rows[0];
      if (!current) fail(404, "PAYMENT_NOT_FOUND", "Payment not found");
      validateSession(current, session);
      const intent = paymentIntentId(session);
      if (!intent) fail(400, "PAYMENT_INTENT_MISSING", "Stripe did not provide a PaymentIntent for this paid session");

      if ((current.status === "captured" || current.appointment_id)
          && current.provider_payment_id && current.provider_payment_id !== intent) {
        const reconciliationId = await recordReconciliation(client, current, session, event?.id ?? null, "additional_capture");
        if (event) await client.query("UPDATE payment_provider_events SET processed_at = NOW() WHERE provider = 'stripe' AND provider_event_id = $1", [event.id]);
        return { status: "captured_payment_reconciliation_required", reconciliation_id: reconciliationId };
      }
      if (current.provider_payment_id && current.provider_payment_id !== intent) {
        fail(409, "PAYMENT_INTENT_MISMATCH", "The Checkout Session PaymentIntent does not match this payment");
      }
      if (current.appointment_id) {
        if (event) await client.query("UPDATE payment_provider_events SET processed_at = NOW() WHERE provider = 'stripe' AND provider_event_id = $1", [event.id]);
        const appointment = await appointmentService.readAppointmentDetails(client, current.appointment_id);
        return { status: "confirmed", appointment, created: false };
      }

      await client.query(
        `UPDATE payments SET status = 'captured', provider_payment_id = COALESCE(provider_payment_id, $2),
           captured_at = COALESCE(captured_at, NOW()), updated_at = NOW()
         WHERE id = $1`,
        [current.id, intent],
      );
      const appointment = await appointmentService.createPaymentAppointment(client, {
        availabilityId: current.availability_id,
        patientId: current.patient_id,
        reason: current.reason,
        holdId: current.slot_hold_id,
        timeZone,
      }).catch(async (error) => {
        if (!(error instanceof appointmentService.AppointmentError) || error.code !== "SLOT_UNAVAILABLE") throw error;
        await client.query("UPDATE appointment_slot_holds SET status = 'expired', updated_at = NOW() WHERE id = $1 AND status = 'active'", [current.slot_hold_id]);
        const reconciliationId = await recordReconciliation(client, current, session, event?.id ?? null, "slot_unavailable");
        if (event) await client.query("UPDATE payment_provider_events SET processed_at = NOW() WHERE provider = 'stripe' AND provider_event_id = $1", [event.id]);
        return { status: "captured_slot_unavailable", reconciliation_id: reconciliationId };
      });
      if (appointment?.status === "captured_slot_unavailable") return appointment;
      await client.query("UPDATE payments SET appointment_id = $2, slot_hold_id = NULL, updated_at = NOW() WHERE id = $1", [current.id, appointment.id]);
      await client.query("UPDATE appointment_slot_holds SET status = 'consumed', updated_at = NOW() WHERE id = $1", [current.slot_hold_id]);
      if (event) await client.query("UPDATE payment_provider_events SET processed_at = NOW() WHERE provider = 'stripe' AND provider_event_id = $1", [event.id]);
      return { status: "confirmed", appointment, created: true };
    });
  }

  async function notifyNewAppointment(result) {
    if (!result?.created || !result.appointment || !emailNotificationService) return result;
    try { await emailNotificationService.sendAppointmentNotification("booked", result.appointment); }
    catch (error) { logger.error("Paid appointment confirmation email failed", { appointmentId: result.appointment.id, message: error.message }); }
    return result;
  }

  async function markSessionFailure(payment, session, event, status) {
    return withTransaction(database, async (client) => {
      const slot = await lockSlot(client, payment.availability_id);
      await lockDoctor(client, slot.doctor_id);
      if (event) {
        const inserted = await client.query(
          `INSERT INTO payment_provider_events (provider, provider_event_id, event_type, payment_id)
           VALUES ('stripe', $1, $2, $3) ON CONFLICT (provider, provider_event_id) DO NOTHING RETURNING id`,
          [event.id, event.type, payment.id],
        );
        if (!inserted.rows[0]) return { duplicate: true };
      }
      const locked = await client.query("SELECT status, appointment_id, slot_hold_id FROM payments WHERE id = $1 FOR UPDATE", [payment.id]);
      if (!locked.rows[0]) fail(404, "PAYMENT_NOT_FOUND", "Payment not found");
      if (!locked.rows[0].appointment_id && locked.rows[0].status !== "captured") {
        const update = await client.query(
          `UPDATE payments SET status = $2,
             failed_at = CASE WHEN $2 = 'failed' THEN COALESCE(failed_at, NOW()) ELSE failed_at END,
             expired_at = CASE WHEN $2 = 'expired' THEN COALESCE(expired_at, NOW()) ELSE expired_at END,
             cancelled_at = CASE WHEN $2 = 'cancelled' THEN COALESCE(cancelled_at, NOW()) ELSE cancelled_at END,
             updated_at = NOW()
           WHERE id = $1 AND status IN ('created', 'pending', 'authorized') RETURNING slot_hold_id`,
          [payment.id, status],
        );
        if (update.rows[0]) {
          await client.query("UPDATE appointment_slot_holds SET status = $2, updated_at = NOW() WHERE id = $1 AND status = 'active'", [update.rows[0].slot_hold_id, status === "expired" ? "expired" : "released"]);
        }
      }
      if (event) await client.query("UPDATE payment_provider_events SET processed_at = NOW() WHERE provider = 'stripe' AND provider_event_id = $1", [event.id]);
      return { status: locked.rows[0].status === "captured" ? "captured" : status };
    });
  }

  async function markPending(payment, session, event) {
    return withTransaction(database, async (client) => {
      const slot = await lockSlot(client, payment.availability_id);
      await lockDoctor(client, slot.doctor_id);
      if (event) {
        const inserted = await client.query(
          `INSERT INTO payment_provider_events (provider, provider_event_id, event_type, payment_id)
           VALUES ('stripe', $1, $2, $3) ON CONFLICT (provider, provider_event_id) DO NOTHING RETURNING id`,
          [event.id, event.type, payment.id],
        );
        if (!inserted.rows[0]) return { duplicate: true };
      }
      const locked = await client.query("SELECT status, provider_payment_id FROM payments WHERE id = $1 FOR UPDATE", [payment.id]);
      const current = locked.rows[0];
      if (!current) fail(404, "PAYMENT_NOT_FOUND", "Payment not found");
      const intent = paymentIntentId(session);
      if (intent && current.provider_payment_id && current.provider_payment_id !== intent) fail(409, "PAYMENT_INTENT_MISMATCH", "The Checkout Session PaymentIntent does not match this payment");
      if (current && ["created", "pending", "authorized"].includes(current.status)) {
        await client.query("UPDATE payments SET status = 'pending', provider_payment_id = COALESCE(provider_payment_id, $2), updated_at = NOW() WHERE id = $1", [payment.id, intent]);
      }
      if (event) await client.query("UPDATE payment_provider_events SET processed_at = NOW() WHERE provider = 'stripe' AND provider_event_id = $1", [event.id]);
      return { status: current?.status === "captured" ? "captured" : "pending" };
    });
  }

  async function processSession(payment, session, event) {
    validateSession(payment, session);
    if (session.payment_status === "paid") {
      const result = await confirmPaidSession(payment, session, event);
      return notifyNewAppointment(result);
    }
    if (session.status === "expired") return markSessionFailure(payment, session, event, "expired");
    if (event?.type === "checkout.session.expired") return markSessionFailure(payment, session, event, "expired");
    if (event?.type === "checkout.session.async_payment_failed") return markSessionFailure(payment, session, event, "failed");
    return markPending(payment, session, event);
  }

  async function paymentBySession(database, sessionId) {
    const result = await database.query(
      `SELECT p.id, p.status, p.provider_order_id, p.provider_payment_id,
              p.amount::text AS amount, p.currency, p.appointment_id, p.slot_hold_id,
              h.id AS hold_id, COALESCE(h.patient_id, a.patient_id) AS patient_id,
              COALESCE(h.availability_id, a.availability_id) AS availability_id,
              h.expires_at, h.status AS hold_status, h.reason
       FROM payments p LEFT JOIN appointment_slot_holds h ON h.id = p.slot_hold_id
       LEFT JOIN appointments a ON a.id = p.appointment_id
       WHERE p.provider = 'stripe' AND p.provider_order_id = $1`,
      [sessionId],
    );
    return result.rows[0] || null;
  }

  async function processWebhook(rawBody, signature) {
    let event;
    try { event = stripe.constructWebhookEvent(rawBody, signature); }
    catch (error) {
      if (error instanceof PaymentError) throw error;
      if (error.status === 503 && error.code) fail(error.status, error.code, error.message);
      fail(400, "WEBHOOK_SIGNATURE_INVALID", "Stripe webhook verification failed");
    }
    if (["refund.created", "refund.updated", "refund.failed", "charge.refund.updated", "charge.refunded"].includes(event.type)) {
      return refundService.processRefundWebhook(event);
    }
    if (!["checkout.session.completed", "checkout.session.async_payment_succeeded", "checkout.session.async_payment_failed", "checkout.session.expired"].includes(event.type)) {
      return { ignored: true };
    }
    const session = event.data?.object;
    if (!session?.id) return { ignored: true };
    const payment = await paymentBySession(database, session.id);
    if (!payment) return { ignored: true };
    if (session.metadata?.payment_id !== payment.id || session.client_reference_id !== payment.id) {
      fail(400, "PAYMENT_SESSION_MISMATCH", "The Stripe Checkout Session does not match this payment");
    }
    const result = await processSession(payment, session, { id: event.id, type: event.type });
    if (result.duplicate) return result;
    return { status: result.status, reconciliation_id: result.reconciliation_id };
  }

  async function retrieveAndProcess(payment) {
    if (!payment.provider_order_id) return null;
    const session = await stripe.retrieveCheckoutSession(payment.provider_order_id);
    validateSession(payment, session);
    return processSession(payment, session, null);
  }

  async function getPaymentStatus(user, paymentId) {
    if (user.role !== "patient") fail(403, "FORBIDDEN", "Only patients can view appointment payment status");
    let payment = await findOwnedPayment(database, paymentId, user.id);
    if (payment.provider_order_id) {
      await retrieveAndProcess(payment);
      payment = await findOwnedPayment(database, paymentId, user.id);
    } else if (payment.hold_id && !payment.appointment_id && payment.expires_at && new Date(payment.expires_at) <= new Date()) {
      await markSessionFailure(payment, null, null, "expired");
      payment = await findOwnedPayment(database, paymentId, user.id);
    }
    const appointmentDetails = payment.appointment_id
      ? await appointmentService.getAppointment(database, user, payment.appointment_id)
      : null;
    const reconciliation = await database.query(
      "SELECT id FROM payment_capture_reconciliation WHERE payment_id = $1 AND status = 'unresolved' ORDER BY created_at LIMIT 1",
      [payment.id],
    );
    const { patient_email: _patientEmail, ...appointment } = appointmentDetails || {};
    return { status: payment.status, appointment: appointmentDetails ? appointment : null, reconciliation_id: reconciliation.rows[0]?.id || null };
  }

  async function getPaymentHistory(user) {
    if (user.role !== "patient") fail(403, "FORBIDDEN", "Only patients can view payment history");
    const result = await database.query(
      `SELECT p.id, p.amount::text AS amount, p.currency, p.status, p.provider,
              p.provider_payment_id, p.created_at, p.captured_at,
              COALESCE(p.captured_at, p.created_at) AS payment_date,
              a.id AS appointment_id, a.status AS appointment_status,
              COALESCE(a.scheduled_date::text, av.date::text) AS appointment_date,
              COALESCE(a.scheduled_start_time::text, av.start_time::text) AS appointment_start_time,
              COALESCE(a.scheduled_end_time::text, av.end_time::text) AS appointment_end_time,
              d.id AS doctor_id, du.first_name AS doctor_first_name,
              du.last_name AS doctor_last_name, d.specialty
       FROM payments p
       LEFT JOIN appointments a ON a.id = p.appointment_id
       LEFT JOIN appointment_slot_holds h ON h.id = p.slot_hold_id
       JOIN patients patient_owner ON patient_owner.user_id = $1
         AND patient_owner.id = COALESCE(a.patient_id, h.patient_id)
       LEFT JOIN availability av ON av.id = COALESCE(a.availability_id, h.availability_id)
       LEFT JOIN doctors d ON d.id = av.doctor_id
       LEFT JOIN users du ON du.id = d.user_id
       ORDER BY COALESCE(p.captured_at, p.created_at) DESC, p.id`, [user.id],
    );
    const paymentIds = result.rows.map((payment) => payment.id);
    const refundRows = paymentIds.length
      ? (await database.query(
        `SELECT id, payment_id, amount::text AS amount, currency, status, reason,
                created_at, processed_at
         FROM refunds WHERE payment_id = ANY($1::uuid[]) ORDER BY created_at DESC, id`, [paymentIds],
      )).rows
      : [];
    const refundsByPayment = new Map();
    for (const refund of refundRows) {
      const list = refundsByPayment.get(refund.payment_id) || [];
      list.push(refund);
      refundsByPayment.set(refund.payment_id, list);
    }
    return Promise.all(result.rows.map(async (payment) => {
      let receiptUrl = null;
      if (["captured", "partially_refunded", "refunded"].includes(payment.status)
        && payment.provider === "stripe" && payment.provider_payment_id) {
        try {
          const intent = await stripe.retrievePaymentIntent(payment.provider_payment_id);
          const charge = typeof intent?.latest_charge === "object" ? intent.latest_charge : null;
          if (intent?.id === payment.provider_payment_id && intent.status === "succeeded") {
            receiptUrl = stripeReceiptUrl(charge?.receipt_url);
          }
        } catch (error) {
          logger.warn?.("Stripe receipt lookup failed", { paymentId: payment.id, message: error.message });
        }
      }
      const appointment = payment.appointment_id ? {
        id: payment.appointment_id,
        status: payment.appointment_status,
        date: payment.appointment_date,
        start_time: payment.appointment_start_time,
        end_time: payment.appointment_end_time,
        doctor: payment.doctor_id ? {
          id: payment.doctor_id,
          first_name: payment.doctor_first_name,
          last_name: payment.doctor_last_name,
          specialty: payment.specialty,
        } : null,
      } : (payment.appointment_date && payment.doctor_id ? {
        date: payment.appointment_date,
        start_time: payment.appointment_start_time,
        end_time: payment.appointment_end_time,
        doctor: {
          id: payment.doctor_id,
          first_name: payment.doctor_first_name,
          last_name: payment.doctor_last_name,
          specialty: payment.specialty,
        },
      } : null);
      return {
        id: payment.id,
        amount: payment.amount,
        currency: payment.currency.trim(),
        status: payment.status,
        date: payment.payment_date,
        receipt_url: receiptUrl,
        appointment,
        refunds: refundsByPayment.get(payment.id) || [],
      };
    }));
  }

  async function cancelCheckoutSession(user, paymentId) {
    if (user.role !== "patient") fail(403, "FORBIDDEN", "Only patients can cancel appointment payments");
    const payment = await findOwnedPayment(database, paymentId, user.id);
    if (payment.appointment_id || payment.status === "captured") return { status: payment.status };
    if (!payment.provider_order_id) return { status: "pending" };
    let session;
    try {
      session = await stripe.expireCheckoutSession(payment.provider_order_id);
    } catch (_error) {
      session = await stripe.retrieveCheckoutSession(payment.provider_order_id);
    }
    validateSession(payment, session);
    if (session.payment_status === "paid") {
      const result = await processSession(payment, session, null);
      return { status: result.status };
    }
    if (session.status !== "expired") return { status: "pending" };
    return markSessionFailure(payment, session, null, "cancelled");
  }

  return {
    cancelCheckoutSession,
    createCheckoutSession,
    getPaymentHistory,
    getPaymentStatus,
    previewCancellationRefund: refundService.previewCancellationRefund,
    processWebhook,
    refundCancelledAppointment: refundService.refundCancelledAppointment,
  };
}

module.exports = { PaymentError, createPaymentService };
