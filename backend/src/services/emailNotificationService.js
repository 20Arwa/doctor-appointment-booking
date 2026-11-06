const BREVO_EMAILS_URL = "https://api.brevo.com/v3/smtp/email";
const REQUEST_TIMEOUT_MS = 8000;
const MAX_ATTEMPTS = 2;
const RETRY_DELAY_MS = 200;
const RETRYABLE_STATUSES = new Set([408, 425, 429]);

function configuredValue(value) {
  if (!value || /^(replace_|your_|<|placeholder)/i.test(value.trim())) return null;
  return value.trim();
}

function formatTime(value) {
  return String(value || "").slice(0, 5);
}

function appointmentSubject(action) {
  return { booked: "Appointment confirmed", cancelled: "Appointment cancelled", rescheduled: "Appointment rescheduled" }[action];
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}

function appointmentEmail(action, appointment, recipientType = "patient") {
  const doctor = `Dr. ${[appointment.doctor_first_name, appointment.doctor_last_name].filter(Boolean).join(" ")}`;
  const patient = [appointment.patient_first_name, appointment.patient_last_name].filter(Boolean).join(" ") || "Patient";
  const current = `${appointment.date} at ${formatTime(appointment.start_time)}`;
  const previous = `${appointment.previous_date} at ${formatTime(appointment.previous_start_time)}`;
  let title;
  let message;
  if (recipientType === "doctor") {
    title = action === "booked" ? "New appointment booking" : action === "cancelled" ? "Appointment cancelled" : "Appointment updated";
    message = action === "booked" ? `A patient booked an appointment with you.` : action === "cancelled" ? `A patient cancelled their appointment with you.` : `A patient's appointment with you was rescheduled.`;
  } else {
    title = appointmentSubject(action);
    message = action === "booked" ? `Your appointment with ${doctor} is confirmed.`
      : action === "cancelled" ? `Your appointment with ${doctor} has been cancelled.`
        : `Your appointment with ${doctor} has been rescheduled.`;
  }
  const details = action === "rescheduled" ? `Previous appointment: ${previous}` : null;
  const lines = [message, recipientType === "doctor" ? `Patient: ${patient}` : null, `Doctor: ${doctor}`, `Date: ${appointment.date}`, `Time: ${formatTime(appointment.start_time)}`, details].filter(Boolean);
  const row = (label, value) => `<tr><td style="padding:10px 12px;color:#67465F;font-size:13px;font-weight:600">${label}</td><td style="padding:10px 12px;color:#30252D;font-size:15px;font-weight:700">${escapeHtml(value)}</td></tr>`;
  const htmlContent = `<!doctype html><html><body style="margin:0;background:#f7f3f6;font-family:Arial,sans-serif;color:#30252D"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="padding:24px 12px"><tr><td align="center"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;background:#fff;border-radius:12px;overflow:hidden"><tr><td style="background:#67465F;padding:22px 26px;color:#fff;font-size:20px;font-weight:700">Medrella</td></tr><tr><td style="padding:26px"><h1 style="margin:0 0 12px;font-size:22px;color:#30252D">${escapeHtml(title)}</h1><p style="margin:0 0 18px;line-height:1.5;color:#51454F">${escapeHtml(message)}</p><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border:1px solid #e8dfe7;border-radius:8px">${recipientType === "doctor" ? row("Patient", patient) : ""}${row("Doctor", doctor)}${row("Date", appointment.date)}${row("Time", formatTime(appointment.start_time))}</table>${details ? `<p style="margin:16px 0 0;color:#51454F">${escapeHtml(details)}</p>` : ""}</td></tr></table></td></tr></table></body></html>`;
  return { subject: recipientType === "doctor" ? title : appointmentSubject(action), textContent: lines.join("\n"), htmlContent };
}

function reminderEmail(reminderType, appointment) {
  const doctor = `Dr. ${[appointment.doctor_first_name, appointment.doctor_last_name].filter(Boolean).join(" ")}`;
  const lead = reminderType === "24h" ? "24 hours" : "1 hour";
  const message = `Reminder: your appointment with ${doctor} is in ${lead}.`;
  const htmlContent = `<!doctype html><html><body style="margin:0;background:#f7f3f6;font-family:Arial,sans-serif;color:#30252D"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="padding:24px 12px"><tr><td align="center"><table role="presentation" width="100%" style="max-width:560px;background:#fff;border-radius:12px"><tr><td style="background:#67465F;padding:22px 26px;color:#fff;font-size:20px;font-weight:700">Medrella</td></tr><tr><td style="padding:26px"><h1 style="margin:0 0 14px;font-size:22px">Appointment reminder</h1><p>${escapeHtml(message)}</p><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border:1px solid #e8dfe7;border-radius:8px"><tr><td style="padding:10px 12px;color:#67465F;font-weight:600">Doctor</td><td style="padding:10px 12px;color:#30252D;font-weight:700">${escapeHtml(doctor)}</td></tr><tr><td style="padding:10px 12px;color:#67465F;font-weight:600">Date</td><td style="padding:10px 12px;color:#30252D;font-weight:700">${escapeHtml(appointment.date)}</td></tr><tr><td style="padding:10px 12px;color:#67465F;font-weight:600">Time</td><td style="padding:10px 12px;color:#30252D;font-weight:700">${escapeHtml(formatTime(appointment.start_time))}</td></tr></table></td></tr></table></td></tr></table></body></html>`;
  return { subject: "Appointment reminder", textContent: `${message}\nDoctor: ${doctor}\nDate: ${appointment.date}\nTime: ${formatTime(appointment.start_time)}`, htmlContent };
}

function isTransientNetworkError(error) {
  return error?.name === "AbortError" || error?.name === "TimeoutError" || error instanceof TypeError;
}

function createEmailNotificationService({
  config,
  fetchImpl = globalThis.fetch,
  logger = console,
  timeoutMs = REQUEST_TIMEOUT_MS,
  maxAttempts = MAX_ATTEMPTS,
  retryDelayMs = RETRY_DELAY_MS,
  delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
}) {
  async function sendEmail({ subject, textContent, htmlContent, to, sender, appointment, idempotencyKey, maxAttemptsOverride }) {
    const apiKey = configuredValue(config.BREVO_API_KEY);
    const senderEmail = configuredValue(sender?.email || config.BREVO_SENDER_EMAIL);
    const senderName = configuredValue(sender?.name || config.BREVO_SENDER_NAME);
    if (!apiKey || !senderEmail || !senderName) return { sent: false, skipped: true, reason: "missing_configuration", attempts: 0 };
    const recipient = to || appointment?.patient_email;
    if (!recipient) return { sent: false, skipped: true, reason: "missing_recipient", attempts: 0 };

    let failure = "network";
    let status;
    let ambiguous = false;
    let attempts = 0;
    const attemptLimit = Number.isInteger(maxAttemptsOverride) && maxAttemptsOverride > 0
      ? Math.min(maxAttempts, maxAttemptsOverride)
      : maxAttempts;
    for (let attempt = 1; attempt <= attemptLimit; attempt += 1) {
      attempts = attempt;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(BREVO_EMAILS_URL, {
          method: "POST",
          headers: { "api-key": apiKey, "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({
            sender: { email: senderEmail, name: senderName },
            to: [{ email: recipient }],
            ...(idempotencyKey ? { headers: { idempotencyKey } } : {}),
            subject,
            textContent,
            ...(typeof htmlContent === "string" ? { htmlContent } : {}),
          }),
          signal: controller.signal,
        });
        if (response.ok) {
          let providerMessageId = null;
          try {
            const body = await response.json();
            if (typeof body?.messageId === "string" && body.messageId.length <= 255) providerMessageId = body.messageId;
          } catch (_error) {
            // Provider acceptance remains successful even when its optional response body is unavailable.
          }
          return { sent: true, attempts, providerMessageId, ...(Number.isInteger(response.status) ? { status: response.status } : {}) };
        }

        status = response.status;
        if (status === 400) {
          try {
            const body = await response.json();
            ambiguous = body?.code === "duplicate_parameter" || body?.code === "duplicateParameter";
          } catch (_error) {
            // The provider error body is optional; do not expose it in logs or responses.
          }
        }
        const retryable = RETRYABLE_STATUSES.has(status) || status >= 500;
        failure = "provider_error";
        if (!retryable || attempt === attemptLimit) break;
      } catch (error) {
        failure = error?.name === "AbortError" || error?.name === "TimeoutError" ? "timeout" : "network_error";
        if (!isTransientNetworkError(error) || attempt === attemptLimit) break;
      } finally {
        clearTimeout(timeout);
      }
      await delay(retryDelayMs);
    }

    // Never log provider bodies, raw exception messages, recipients, or request data.
    logger.error("Brevo email delivery failed", { failure, ...(status ? { status } : {}), attempts });
    const permanent = failure === "provider_error" && !RETRYABLE_STATUSES.has(status) && status < 500;
    return { sent: false, error: true, reason: failure, attempts, ambiguous, permanent, ...(status ? { status } : {}) };
  }

  return {
    async sendAppointmentReminder(reminderType, appointment) {
      return sendEmail({ ...reminderEmail(reminderType, appointment), appointment });
    },
    async sendAppointmentNotification(action, appointment, recipientType = "patient") {
      return sendEmail({ ...appointmentEmail(action, appointment, recipientType), appointment, to: recipientType === "doctor" ? appointment.doctor_email : appointment.patient_email });
    },
    createNotificationPayload(action, appointment, recipientType = "patient") {
      const template = appointmentEmail(action, appointment, recipientType);
      return {
        to: (recipientType === "doctor" ? appointment.doctor_email : appointment.patient_email) || null,
        ...template,
        sender: {
          email: configuredValue(config.BREVO_SENDER_EMAIL),
          name: configuredValue(config.BREVO_SENDER_NAME),
        },
      };
    },
    async sendNotificationPayload(payload, idempotencyKey, options = {}) {
      return sendEmail({ ...payload, idempotencyKey, maxAttemptsOverride: options.maxAttempts });
    },
  };
}

module.exports = { createEmailNotificationService };
