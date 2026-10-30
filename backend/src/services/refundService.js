const { AppointmentError } = require("./appointmentService");

function refundPolicyPercentage(appointment, now = Date.now()) {
  const appointmentTime = new Date(`${appointment.date}T${String(appointment.start_time).slice(0, 8)}+05:30`).getTime();
  if (!Number.isFinite(appointmentTime)) return 0;
  const hoursBefore = (appointmentTime - Number(now)) / 3600000;
  if (hoursBefore < 0) return 0;
  if (hoursBefore >= 24) return 100;
  if (hoursBefore >= 6) return 50;
  return 0;
}

function refundPolicyAmount(paymentAmount, appointment, now = Date.now()) {
  const amountPaise = Math.round(Number(paymentAmount) * 100);
  if (!Number.isSafeInteger(amountPaise) || amountPaise <= 0) return 0;
  const percentage = refundPolicyPercentage(appointment, now);
  if (percentage === 100) return amountPaise;
  if (percentage === 50) return Math.round(amountPaise / 2);
  return 0;
}

function createRefundService({ database, stripe, logger = console, now = Date.now }) {
  async function withTransaction(operation) {
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
      throw error;
    } finally { client.release(); }
  }

  async function syncPaymentStatus(client, paymentId) {
    const totals = await client.query(
      `SELECT p.amount::text AS amount,
              COALESCE(SUM(r.amount) FILTER (WHERE r.status = 'processed'), 0)::text AS processed
       FROM payments p LEFT JOIN refunds r ON r.payment_id = p.id
       WHERE p.id = $1 GROUP BY p.id`, [paymentId],
    );
    const row = totals.rows[0];
    if (!row) return;
    const refunded = Number(row.processed);
    const amount = Number(row.amount);
    const status = refunded >= amount ? "refunded" : refunded > 0 ? "partially_refunded" : "captured";
    await client.query("UPDATE payments SET status = $2, updated_at = NOW() WHERE id = $1 AND status IN ('captured', 'partially_refunded', 'refunded')", [paymentId, status]);
  }

  async function updateRefund(refundId, status, providerRefundId = null, event = null) {
    return withTransaction(async (client) => {
      const locked = await client.query(
        `SELECT r.id, r.payment_id, r.status, p.amount::text AS payment_amount
         FROM refunds r JOIN payments p ON p.id = r.payment_id WHERE r.id = $1 FOR UPDATE OF r, p`, [refundId],
      );
      const refund = locked.rows[0];
      if (!refund) return null;
      if (event) {
        const inserted = await client.query(
          `INSERT INTO payment_provider_events (provider, provider_event_id, event_type, refund_id)
           VALUES ('stripe', $1, $2, $3) ON CONFLICT (provider, provider_event_id) DO NOTHING RETURNING id`,
          [event.id, event.type, refundId],
        );
        if (!inserted.rows[0]) return { duplicate: true, id: refundId, status: refund.status };
      }
      const rank = { pending: 0, failed: 1, cancelled: 1, processed: 2 };
      if ((rank[status] ?? 0) > (rank[refund.status] ?? 0) || status === refund.status) {
        await client.query(
          `UPDATE refunds SET status = $2, provider_refund_id = COALESCE(provider_refund_id, $3),
             processed_at = CASE WHEN $2 = 'processed' THEN COALESCE(processed_at, NOW()) ELSE processed_at END,
             updated_at = NOW() WHERE id = $1`, [refundId, status, providerRefundId],
        );
      }
      if (event) await client.query("UPDATE payment_provider_events SET processed_at = NOW() WHERE provider = 'stripe' AND provider_event_id = $1", [event.id]);
      await syncPaymentStatus(client, refund.payment_id);
      const latest = await client.query("SELECT id, amount::text AS amount, currency, status FROM refunds WHERE id = $1", [refundId]);
      return latest.rows[0];
    });
  }

  async function submitRefund(refund) {
    if (!refund) return null;
    if (refund.status !== "pending") return refund;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const result = await stripe.createRefund({
          payment_intent: refund.provider_payment_id,
          amount: Math.round(Number(refund.amount) * 100),
          metadata: { local_refund_id: refund.id, payment_id: refund.payment_id },
        }, refund.idempotency_key);
        const status = result.status === "succeeded" ? "processed"
          : result.status === "failed" ? "failed"
            : result.status === "canceled" ? "cancelled" : "pending";
        return await updateRefund(refund.id, status, result.id);
      } catch (error) {
        const definiteFailure = (Number(error.statusCode) >= 400 && Number(error.statusCode) < 500)
          || error.type === "StripeInvalidRequestError";
        if (definiteFailure) {
          const failed = await updateRefund(refund.id, "failed");
          return failed || { id: refund.id, amount: refund.amount, currency: refund.currency, status: "failed" };
        }
        if (attempt === 0) continue;
        // Both attempts were ambiguous. Keep the same refund and idempotency key for webhook reconciliation or retry.
        logger.error("Stripe refund submission did not complete", { refundId: refund.id, message: error.message });
        return { id: refund.id, amount: refund.amount, currency: refund.currency, status: "pending" };
      }
    }
    return { id: refund.id, amount: refund.amount, currency: refund.currency, status: "pending" };
  }

  async function refundCancelledAppointment(user, appointment) {
    try {
      const planned = await withTransaction(async (client) => {
        const result = await client.query(
          `SELECT p.id AS payment_id, p.status AS payment_status, p.provider, p.provider_payment_id,
                  p.amount::text AS amount, p.currency, p.appointment_id, p.patient_id,
                  a.scheduled_date::text AS date, a.scheduled_start_time::text AS start_time
           FROM appointments a JOIN patients pt ON pt.id = a.patient_id
           LEFT JOIN LATERAL (
             SELECT pay.*, ap.patient_id
             FROM payments pay JOIN appointments ap ON ap.id = pay.appointment_id
             WHERE pay.appointment_id = a.id ORDER BY pay.created_at DESC LIMIT 1
           ) p ON TRUE
           WHERE a.id = $1 AND pt.user_id = $2 FOR UPDATE OF a`, [appointment.id, user.id],
        );
        const payment = result.rows[0];
        if (!payment) return { status: "not_applicable", amount: "0.00", currency: null };
        if (!payment.payment_id) return { status: "not_applicable", amount: "0.00", currency: null };
        if (!["captured", "partially_refunded"].includes(payment.payment_status)) {
          return { status: "not_eligible", amount: "0.00", currency: payment.currency };
        }
        if (payment.provider !== "stripe" || !payment.provider_payment_id) {
          return { status: "pending", amount: "0.00", currency: payment.currency };
        }
        const idempotencyKey = `appointment-cancel:${appointment.id}`;
        const existing = await client.query(
          `SELECT id, payment_id, amount::text AS amount, currency, status, idempotency_key, $2::text AS provider_payment_id
           FROM refunds WHERE idempotency_key = $1`, [idempotencyKey, payment.provider_payment_id],
        );
        if (existing.rows[0]) return existing.rows[0];
        const desiredMinor = refundPolicyAmount(payment.amount, payment, now());
        const refunds = await client.query(
          `SELECT COALESCE(SUM(amount) FILTER (WHERE status = 'processed'), 0)::text AS processed,
                  COALESCE(SUM(amount) FILTER (WHERE status = 'pending'), 0)::text AS pending
           FROM refunds WHERE payment_id = $1`, [payment.payment_id],
        );
        const prior = refunds.rows[0];
        const desired = desiredMinor / 100;
        const remaining = Math.max(0, desired - Number(prior.processed));
        if (remaining <= 0) return { status: Number(prior.processed) ? "processed" : "not_eligible", amount: "0.00", currency: payment.currency };
        const available = Math.max(0, Number(payment.amount) - Number(prior.processed) - Number(prior.pending));
        const amount = Math.min(remaining, available);
        if (amount <= 0) return { status: "pending", amount: "0.00", currency: payment.currency };
        const inserted = await client.query(
          `INSERT INTO refunds (payment_id, provider, amount, currency, status, reason, idempotency_key)
           VALUES ($1, $2, $3, $4, 'pending', 'patient_cancellation', $5)
           RETURNING id, payment_id, amount::text AS amount, currency, status, idempotency_key`,
          [payment.payment_id, payment.provider, amount.toFixed(2), payment.currency, idempotencyKey],
        );
        return { ...inserted.rows[0], provider_payment_id: payment.provider_payment_id };
      });
      if (planned.status === "not_applicable" || planned.status === "not_eligible") return planned;
      const submitted = await submitRefund(planned);
      return { status: submitted?.status || "pending", refund_id: submitted?.id || planned.id, amount: submitted?.amount || planned.amount, currency: submitted?.currency || planned.currency };
    } catch (error) {
      logger.error("Appointment cancellation refund could not be prepared", { appointmentId: appointment.id, message: error.message });
      return {
        status: "pending",
        amount: "0.00",
        currency: null,
        error_code: "REFUND_PREPARATION_FAILED",
      };
    }
  }

  async function previewCancellationRefund(user, appointmentId) {
    if (user.role !== "patient") {
      throw new AppointmentError(403, "FORBIDDEN", "Only patients can preview appointment cancellation refunds");
    }
    const result = await database.query(
      `SELECT a.id, a.status AS appointment_status,
              a.scheduled_date::text AS date, a.scheduled_start_time::text AS start_time,
              p.id AS payment_id, p.status AS payment_status, p.amount::text AS payment_amount,
              p.currency, p.provider, p.provider_payment_id,
              COALESCE(refund_totals.processed, 0)::text AS processed_refunds,
              COALESCE(refund_totals.pending, 0)::text AS pending_refunds
       FROM appointments a
       JOIN patients pt ON pt.id = a.patient_id AND pt.user_id = $2
       LEFT JOIN LATERAL (
         SELECT pay.id, pay.status, pay.amount, pay.currency, pay.provider, pay.provider_payment_id
         FROM payments pay WHERE pay.appointment_id = a.id
         ORDER BY pay.created_at DESC LIMIT 1
       ) p ON TRUE
       LEFT JOIN LATERAL (
         SELECT SUM(r.amount) FILTER (WHERE r.status = 'processed') AS processed,
                SUM(r.amount) FILTER (WHERE r.status = 'pending') AS pending
         FROM refunds r WHERE r.payment_id = p.id
       ) refund_totals ON TRUE
       WHERE a.id = $1`, [appointmentId, user.id],
    );
    const row = result.rows[0];
    if (!row) throw new AppointmentError(404, "APPOINTMENT_NOT_FOUND", "Appointment not found");
    if (row.appointment_status !== "confirmed") {
      throw new AppointmentError(409, "APPOINTMENT_STATE_CONFLICT", "Only confirmed appointments can be cancelled");
    }

    const previewNow = now();
    const refundPercentage = refundPolicyPercentage(row, previewNow);
    const originalPayment = row.payment_id ? {
      amount: row.payment_amount,
      currency: row.currency.trim(),
      status: row.payment_status,
    } : null;
    const paymentEligible = ["captured", "partially_refunded"].includes(row.payment_status)
      && row.provider === "stripe" && Boolean(row.provider_payment_id);
    const targetRefundMinorUnits = paymentEligible
      ? refundPolicyAmount(row.payment_amount, row, previewNow)
      : 0;
    const processedRefundMinorUnits = Math.round(Number(row.processed_refunds) * 100);
    const pendingRefundMinorUnits = Math.round(Number(row.pending_refunds) * 100);
    let estimatedMinorUnits = 0;
    if (paymentEligible) {
      const paymentMinorUnits = Math.round(Number(row.payment_amount) * 100);
      const remainingPolicyAmount = Math.max(0, targetRefundMinorUnits - processedRefundMinorUnits);
      const remainingPaymentAmount = Math.max(0, paymentMinorUnits - processedRefundMinorUnits - pendingRefundMinorUnits);
      estimatedMinorUnits = Math.min(remainingPolicyAmount, remainingPaymentAmount);
    }

    let explanation;
    if (!originalPayment) explanation = "No payment is associated with this appointment.";
    else if (!["captured", "partially_refunded"].includes(row.payment_status)) explanation = "No refund is expected because the payment is not captured.";
    else if (!paymentEligible) explanation = "No refund is expected because the captured payment details are unavailable.";
    else if (estimatedMinorUnits > 0) explanation = "This is an estimate. The backend will recalculate the refund when you confirm cancellation.";
    else if (refundPercentage === 0) explanation = "No refund is expected under the cancellation policy at this time.";
    else if (processedRefundMinorUnits >= targetRefundMinorUnits) explanation = "Previous successful refunds already cover the eligible refund amount.";
    else explanation = "No additional refund is currently available while another refund is pending.";

    return {
      original_payment: originalPayment,
      refund_percentage: refundPercentage,
      estimated_refund_amount: (estimatedMinorUnits / 100).toFixed(2),
      currency: originalPayment?.currency || null,
      refund_expected: estimatedMinorUnits > 0,
      explanation,
    };
  }

  async function processRefundWebhook(event) {
    const object = event.data?.object;
    if (!object?.id) return { ignored: true };
    if (event.type === "charge.refunded") {
      const refunds = object.refunds?.data || [];
      let processed = 0;
      for (const refund of refunds) {
        if (!refund.id) continue;
        const foundRefund = await database.query(
          "SELECT id FROM refunds WHERE id::text = $1 OR provider_refund_id = $2 LIMIT 1",
          [refund.metadata?.local_refund_id || null, refund.id],
        );
        if (!foundRefund.rows[0]) continue;
        const refundStatus = refund.status === "succeeded" ? "processed"
          : refund.status === "failed" ? "failed"
            : refund.status === "canceled" ? "cancelled" : "pending";
        await updateRefund(foundRefund.rows[0].id, refundStatus, refund.id, { id: `${event.id}:${refund.id}`, type: event.type });
        processed += 1;
      }
      return { status: "processed", refunds: processed };
    }
    const localId = object.metadata?.local_refund_id;
    const found = await database.query(
      `SELECT r.id FROM refunds r WHERE ($1::text IS NOT NULL AND r.id::text = $1::text)
         OR r.provider_refund_id = $2 LIMIT 1`, [localId || null, object.id],
    );
    const refundId = found.rows[0]?.id;
    if (!refundId) return { ignored: true };
    const status = object.status === "succeeded" ? "processed"
      : object.status === "failed" ? "failed"
        : object.status === "canceled" ? "cancelled" : "pending";
    return updateRefund(refundId, status, object.id, { id: event.id, type: event.type });
  }

  return { previewCancellationRefund, processRefundWebhook, refundCancelledAppointment };
}

module.exports = { createRefundService, refundPolicyAmount, refundPolicyPercentage };
