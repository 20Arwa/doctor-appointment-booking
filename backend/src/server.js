const env = require("./config/env");
const pool = require("./config/database");
const { createApp } = require("./app");

const app = createApp({ database: pool, frontendOrigin: env.FRONTEND_ORIGIN, applicationTimezone: env.APPLICATION_TIMEZONE });
const server = app.listen(env.PORT, () => {
  console.log(`Express API listening on port ${env.PORT}`);
});

function shutDown() {
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
}

process.on("SIGINT", shutDown);
process.on("SIGTERM", shutDown);
