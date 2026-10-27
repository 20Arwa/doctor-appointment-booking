const cors = require("cors");
const express = require("express");
const { errorHandler, notFoundHandler } = require("./middleware/errorHandlers");
const healthRoutes = require("./routes/healthRoutes");

function createApp({ database, frontendOrigin }) {
  if (!database || typeof database.query !== "function") {
    throw new TypeError("A PostgreSQL database pool is required");
  }

  const app = express();

  app.use(cors({ origin: frontendOrigin }));
  app.use(express.json());
  app.use((_request, response, next) => {
    response.locals.database = database;
    next();
  });
  app.use("/api/v1", healthRoutes);
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

module.exports = { createApp };
