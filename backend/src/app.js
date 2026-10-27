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

function createApp({ database, frontendOrigin, applicationTimezone, clerkAuthMiddleware = clerkMiddleware(), clerkProfileResolver = getClerkProfile }) {
  if (!database || typeof database.query !== "function") {
    throw new TypeError("A PostgreSQL database pool is required");
  }

  const app = express();

  app.use(clerkAuthMiddleware);
  app.use(cors({ origin: frontendOrigin }));
  app.use(express.json());
  app.use((_request, response, next) => {
    response.locals.database = database;
    response.locals.clerkProfileResolver = clerkProfileResolver;
    response.locals.applicationTimezone = applicationTimezone;
    next();
  });
  app.use("/api/v1", healthRoutes);
  app.use("/api/v1/users", userRoutes);
  app.use("/api/v1/patients", patientRoutes);
  app.use("/api/v1/doctors", doctorRoutes);
  app.use("/api/v1/appointments", appointmentRoutes);
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

module.exports = { createApp };
