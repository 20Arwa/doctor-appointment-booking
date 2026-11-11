const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const express = require("express");
const { createApp } = require("../src/app");
const createNotificationRecoveryRoutes = require("../src/routes/notificationRecoveryRoutes");

describe("notification delivery recovery endpoint", () => {
  it("requires its internal bearer secret and invokes delivery plus assisted reschedule recovery", async () => {
    let runs = 0;
    const secret = "notification-recovery-test-secret-minimum-32";
    const app = createApp({
      database: { async query() { return { rows: [] }; } },
      frontendOrigin: "http://localhost:3000",
      notificationRecoverySecret: secret,
      notificationDeliveryService: { async sendAppointmentNotification() {}, async runRecovery() { runs += 1; return { claimed: 1, retried: 1, markedAmbiguous: 0 }; } },
      clerkAuthMiddleware: (_request, _response, next) => next(),
    });
    const server = app.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    try {
      const url = `http://127.0.0.1:${server.address().port}/api/v1/internal/notification-deliveries/run`;
      assert.equal((await fetch(url, { method: "POST" })).status, 401);
      assert.equal((await fetch(url, { method: "POST", headers: { authorization: "Bearer wrong-secret" } })).status, 401);
      const response = await fetch(url, { method: "POST", headers: { authorization: `Bearer ${secret}` } });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        claimed: 1, retried: 1, markedAmbiguous: 0,
        appointmentNotificationOutbox: { claimed: 0, processed: 0, pending: 0 },
        inAppNotifications: { recovered: 0 },
        assistedRescheduling: { claimed: 0, dispatched: 0, failed: 0, skipped: 0 },
      });
      assert.equal(runs, 1);
    } finally {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("runs In-App and Assisted recovery even when generic delivery recovery fails", async () => {
    const calls = [];
    const app = express();
    app.use("/run", createNotificationRecoveryRoutes({
      secret: "notification-recovery-test-secret-minimum-32",
      service: { async runRecovery() { calls.push("deliveries"); throw new Error("generic recovery failed"); } },
      appointmentNotificationOutboxService: { async runRecovery() { calls.push("outbox"); return { claimed: 1, processed: 1, pending: 0 }; } },
      inAppNotificationService: { async recoverMissingAppointmentNotifications() { calls.push("in-app"); return { recovered: 2 }; } },
      assistedRescheduleService: { async run() { calls.push("assisted"); return { claimed: 1, dispatched: 1, failed: 0, skipped: 0 }; } },
      logger: { error() {} },
    }));
    const server = app.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    try {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/run/run`, {
        method: "POST", headers: { authorization: "Bearer notification-recovery-test-secret-minimum-32" },
      });
      assert.equal(response.status, 500);
      assert.deepEqual(calls, ["deliveries", "outbox", "in-app", "assisted"]);
      const body = await response.json();
      assert.deepEqual(body.failed_components, ["deliveries"]);
      assert.deepEqual(body.completed.inAppNotifications, { recovered: 2 });
      assert.deepEqual(body.completed.appointmentNotificationOutbox, { claimed: 1, processed: 1, pending: 0 });
      assert.deepEqual(body.completed.assistedRescheduling, { claimed: 1, dispatched: 1, failed: 0, skipped: 0 });
    } finally {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
