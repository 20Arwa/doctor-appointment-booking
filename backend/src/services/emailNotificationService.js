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

function appointmentMessage(action, appointment) {
  const doctor = `Dr. ${[appointment.doctor_first_name, appointment.doctor_last_name].filter(Boolean).join(" ")}`;
  const current = `${appointment.date} at ${formatTime(appointment.start_time)}`;
  if (action === "booked") return `Your appointment with ${doctor} is confirmed for ${current}.`;
  if (action === "cancelled") return `Your appointment with ${doctor} on ${current} has been cancelled.`;
  const previous = `${appointment.previous_date} at ${formatTime(appointment.previous_start_time)}`;
  return `Your appointment with ${doctor} has been rescheduled from ${previous} to ${current}.`;
}

function reminderMessage(reminderType, appointment) {
  const doctor = `Dr. ${[appointment.doctor_first_name, appointment.doctor_last_name].filter(Boolean).join(" ")}`;
  const current = `${appointment.date} at ${formatTime(appointment.start_time)}`;
  const lead = reminderType === "24h" ? "24 hours" : "1 hour";
  return `Reminder: your appointment with ${doctor} is in ${lead}, on ${current}.`;
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
  async function sendEmail({ subject, textContent, to, sender, appointment, idempotencyKey, maxAttemptsOverride }) {
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
      return sendEmail({ subject: "Appointment reminder", textContent: reminderMessage(reminderType, appointment), appointment });
    },
    async sendAppointmentNotification(action, appointment) {
      return sendEmail({ subject: appointmentSubject(action), textContent: appointmentMessage(action, appointment), appointment });
    },
    createNotificationPayload(action, appointment) {
      return {
        to: appointment.patient_email || null,
        subject: appointmentSubject(action),
        textContent: appointmentMessage(action, appointment),
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
