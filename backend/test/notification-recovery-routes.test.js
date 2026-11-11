const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { createApp } = require("../src/app");

describe("notification delivery recovery endpoint", () => {
  it("requires its internal bearer secret and invokes delivery and appointment outbox recovery", async () => {
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
        claimed: 1,
        retried: 1,
        markedAmbiguous: 0,
        appointmentNotificationOutbox: { claimed: 0, processed: 0, pending: 0 },
        assistedRescheduling: { claimed: 0, dispatched: 0, failed: 0, skipped: 0 },
      });
      assert.equal(runs, 1);
    } finally {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
