const crypto = require("node:crypto");
const express = require("express");

function createNotificationRecoveryRoutes({ service, appointmentNotificationOutboxService, assistedRescheduleService, inAppNotificationService, secret, logger = console }) {
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
      const results = {};
      const failures = [];
      for (const [name, run] of [
        ["deliveries", () => service.runRecovery()],
        ["appointmentNotificationOutbox", () => appointmentNotificationOutboxService?.runRecovery?.()],
        ["inAppNotifications", () => inAppNotificationService?.recoverMissingAppointmentNotifications?.()],
        ["assistedRescheduling", () => assistedRescheduleService?.run()],
      ]) {
        try {
          const result = await run();
          if (result !== undefined) results[name] = result;
        } catch (_error) {
          failures.push(name);
          logger.error("Notification recovery component failed", { component: name });
        }
      }
      if (failures.length) {
        return response.status(500).json({
          error: { code: "NOTIFICATION_RECOVERY_FAILED", message: "One or more notification recovery components failed" },
          completed: results,
          failed_components: failures,
        });
      }
      const { deliveries = {}, appointmentNotificationOutbox, inAppNotifications, assistedRescheduling } = results;
      return response.status(200).json({
        ...deliveries,
        ...(appointmentNotificationOutbox ? { appointmentNotificationOutbox } : {}),
        ...(inAppNotifications ? { inAppNotifications } : {}),
        ...(assistedRescheduling ? { assistedRescheduling } : {}),
      });
    }
    catch (_error) { return response.status(500).json({ error: { code: "NOTIFICATION_RECOVERY_FAILED", message: "Notification recovery run failed" } }); }
  });
  return router;
}

module.exports = createNotificationRecoveryRoutes;
