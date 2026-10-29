const BREVO_EMAILS_URL = "https://api.brevo.com/v3/smtp/email";

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

function createEmailNotificationService({ config, fetchImpl = globalThis.fetch, logger = console }) {
  return {
    async sendAppointmentNotification(action, appointment) {
      const apiKey = configuredValue(config.BREVO_API_KEY);
      const senderEmail = configuredValue(config.BREVO_SENDER_EMAIL);
      const senderName = configuredValue(config.BREVO_SENDER_NAME);
      if (!apiKey || !senderEmail || !senderName || !appointment.patient_email) return;
      try {
        const response = await fetchImpl(BREVO_EMAILS_URL, {
          method: "POST",
          headers: { "api-key": apiKey, "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({
            sender: { email: senderEmail, name: senderName },
            to: [{ email: appointment.patient_email }],
            subject: appointmentSubject(action),
            textContent: appointmentMessage(action, appointment),
          }),
        });
        if (!response.ok) throw new Error(`Brevo returned HTTP ${response.status}`);
      } catch (error) {
        logger.error(`Appointment ${action} email delivery failed`, { message: error.message });
      }
    },
  };
}

module.exports = { createEmailNotificationService };
