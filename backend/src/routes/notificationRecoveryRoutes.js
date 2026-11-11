const crypto = require("node:crypto");
const express = require("express");

function createNotificationRecoveryRoutes({ service, appointmentNotificationOutboxService, assistedRescheduleService, secret }) {
  const router = express.Router();
  router.post("/run", async (request, response) => {
    if (!secret) return response.status(503).json({ error: { code: "NOTIFICATION_RECOVERY_NOT_CONFIGURED", message: "Notification recovery is not configured" } });
    const authorization = request.get("authorization") || "";
    const supplied = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
    const expectedBuffer = Buffer.from(secret);
    const suppliedBuffer = Buffer.from(supplied);
    if (expectedBuffer.length !== suppliedBuffer.length || !crypto.timingSafeEqual(expectedBuffer, suppliedBuffer)) {
      return response.status(401).json({ error: { code: "UNAUTHORIZED", message: "Unauthorized" } });
    }
    try {
      const deliveries = await service.runRecovery();
      const appointmentNotificationOutbox = await appointmentNotificationOutboxService?.runRecovery?.();
      const assistedRescheduling = await assistedRescheduleService?.run?.();
      return response.status(200).json({ ...deliveries, ...(appointmentNotificationOutbox ? { appointmentNotificationOutbox } : {}), ...(assistedRescheduling ? { assistedRescheduling } : {}) });
    }
    catch (error) {
      console.error("Notification recovery run failed", { message: error.message });
      return response.status(500).json({ error: { code: "NOTIFICATION_RECOVERY_FAILED", message: "Notification recovery run failed" } });
    }
  });
  return router;
}

module.exports = createNotificationRecoveryRoutes;
