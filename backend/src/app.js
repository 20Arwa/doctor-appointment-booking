const cors = require("cors");
const express = require("express");
const { clerkMiddleware } = require("@clerk/express");
const { errorHandler, notFoundHandler } = require("./middleware/errorHandlers");
const healthRoutes = require("./routes/healthRoutes");
const userRoutes = require("./routes/userRoutes");
const patientRoutes = require("./routes/patientRoutes");
const doctorRoutes = require("./routes/doctorRoutes");
const appointmentRoutes = require("./routes/appointmentRoutes");
const { getClerkProfile } = require("./middleware/auth");
const env = require("./config/env");
const { createEmailNotificationService } = require("./services/emailNotificationService");
const { createAppointmentReminderService } = require("./services/appointmentReminderService");
const reminderRoutes = require("./routes/reminderRoutes");
const paymentRoutes = require("./routes/paymentRoutes");
const { createStripeService } = require("./services/stripeService");
const { createPaymentService } = require("./services/paymentService");

function createApp({ database, frontendOrigin, applicationTimezone, emailNotificationService = createEmailNotificationService({ config: env }), reminderService, reminderSecret = env.REMINDER_CRON_SECRET, stripeService, paymentService, paymentConfig = env, clerkAuthMiddleware = clerkMiddleware(), clerkProfileResolver = getClerkProfile }) {
  if (!database || typeof database.query !== "function") {
    throw new TypeError("A PostgreSQL database pool is required");
  }

  const app = express();
  const stripe = stripeService || createStripeService({ config: paymentConfig });
  const payments = paymentService || createPaymentService({
    database,
    stripe,
    emailNotificationService,
    frontendOrigin: frontendOrigin || env.FRONTEND_ORIGIN,
    timeZone: applicationTimezone || env.APPLICATION_TIMEZONE || "Asia/Kolkata",
  });

  app.use(cors({ origin: frontendOrigin, credentials: true }));
  app.use("/api/v1/payments/webhook", paymentRoutes({ service: payments, webhook: true }));
  app.use(clerkAuthMiddleware);
  app.use(express.json());
  app.use((_request, response, next) => {
    response.locals.database = database;
    response.locals.paymentService = payments;
    response.locals.clerkProfileResolver = clerkProfileResolver;
    response.locals.applicationTimezone = applicationTimezone;
    response.locals.emailNotificationService = emailNotificationService;
    next();
  });
  app.use("/api/v1", healthRoutes);
  app.use("/api/v1/internal/reminders", reminderRoutes({
    service: reminderService || createAppointmentReminderService({ database, emailNotificationService, timeZone: applicationTimezone || "Asia/Kolkata" }),
    secret: reminderSecret,
  }));
  app.use("/api/v1/payments", paymentRoutes({ service: payments }));
  app.use("/api/v1/users", userRoutes);
  app.use("/api/v1/patients", patientRoutes);
  app.use("/api/v1/doctors", doctorRoutes);
  app.use("/api/v1/appointments", appointmentRoutes);
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

module.exports = { createApp };
