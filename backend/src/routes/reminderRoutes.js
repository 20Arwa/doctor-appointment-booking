const crypto = require("node:crypto");
const express = require("express");

function createReminderRoutes({ service, secret }) {
  const router = express.Router();
  router.post("/run", async (request, response) => {
    if (!secret) return response.status(503).json({ error: { code: "REMINDER_SCHEDULER_NOT_CONFIGURED", message: "Reminder scheduler is not configured" } });
    const authorization = request.get("authorization") || "";
    const supplied = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
    const expectedBuffer = Buffer.from(secret);
    const suppliedBuffer = Buffer.from(supplied);
    if (expectedBuffer.length !== suppliedBuffer.length || !crypto.timingSafeEqual(expectedBuffer, suppliedBuffer)) {
      return response.status(401).json({ error: { code: "UNAUTHORIZED", message: "Unauthorized" } });
    }
    try {
      return response.status(200).json(await service.run());
    } catch (error) {
      console.error("Appointment reminder scheduler run failed", { message: error.message });
      return response.status(500).json({ error: { code: "REMINDER_SCHEDULER_FAILED", message: "Reminder scheduler run failed" } });
    }
  });
  return router;
}

module.exports = createReminderRoutes;
