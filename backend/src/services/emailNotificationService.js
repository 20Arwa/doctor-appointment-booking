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
  async function sendEmail({ subject, textContent, appointment }) {
    const apiKey = configuredValue(config.BREVO_API_KEY);
    const senderEmail = configuredValue(config.BREVO_SENDER_EMAIL);
    const senderName = configuredValue(config.BREVO_SENDER_NAME);
    if (!apiKey || !senderEmail || !senderName) return { sent: false, skipped: true, reason: "missing_configuration" };
    if (!appointment.patient_email) return { sent: false, skipped: true, reason: "missing_recipient" };

    let failure = "network";
    let status;
    let attempts = 0;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      attempts = attempt;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(BREVO_EMAILS_URL, {
          method: "POST",
          headers: { "api-key": apiKey, "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({
            sender: { email: senderEmail, name: senderName },
            to: [{ email: appointment.patient_email }],
            subject,
            textContent,
          }),
          signal: controller.signal,
        });
        if (response.ok) return { sent: true };

        status = response.status;
        const retryable = RETRYABLE_STATUSES.has(status) || status >= 500;
        failure = "provider_error";
        if (!retryable || attempt === maxAttempts) break;
      } catch (error) {
        failure = error?.name === "AbortError" || error?.name === "TimeoutError" ? "timeout" : "network_error";
        if (!isTransientNetworkError(error) || attempt === maxAttempts) break;
      } finally {
        clearTimeout(timeout);
      }
      await delay(retryDelayMs);
    }

    // Never log provider bodies, raw exception messages, recipients, or request data.
    logger.error("Brevo email delivery failed", { failure, ...(status ? { status } : {}), attempts });
    return { sent: false, error: true, reason: failure, ...(status ? { status } : {}) };
  }

  return {
    async sendAppointmentReminder(reminderType, appointment) {
      return sendEmail({ subject: "Appointment reminder", textContent: reminderMessage(reminderType, appointment), appointment });
    },
    async sendAppointmentNotification(action, appointment) {
      return sendEmail({ subject: appointmentSubject(action), textContent: appointmentMessage(action, appointment), appointment });
    },
  };
}

module.exports = { createEmailNotificationService };
