const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { describe, it } = require("node:test");
const { createApp } = require("../src/app");
const { localDateTime, slotStartsInFuture } = require("../src/utils/schedulingTime");
const { slotsBodySchema, slotQuerySchema } = require("../src/validators/availabilitySchemas");

const userId = "11111111-1111-4111-8111-111111111111";
const doctorId = "22222222-2222-4222-8222-222222222222";
const otherDoctorId = "33333333-3333-4333-8333-333333333333";
const user = {
  id: userId,
  first_name: "Ari",
  last_name: "Doctor",
  email: "ari@example.com",
  phone: null,
  role: "doctor",
  is_active: true,
};

function createDatabase({ initialSlots = [], appointmentReferences = [], paymentHoldReferences = [], holdForeignKeyRaceReferences = [], currentUser = user } = {}) {
  const slots = initialSlots.map((slot, index) => ({
    id: slot.id || `44444444-4444-4444-8444-${String(index + 1).padStart(12, "0")}`,
    doctor_id: slot.doctor_id || doctorId,
    date: slot.date,
    start_time: slot.start_time,
    end_time: slot.end_time,
    created_at: "2099-01-01T00:00:00.000Z",
    updated_at: "2099-01-01T00:00:00.000Z",
    deleted_at: slot.deleted_at || null,
  }));
  const lockTails = new Map();

  const database = {
    slots,
    lockQueries: [],
    availabilityQueries: [],
    appointmentQueries: [],
    holdQueries: [],
    deleteQueries: [],
    async query(sql, values = []) {
      if (sql.includes("FROM users WHERE clerk_user_id")) return { rows: [currentUser] };
      if (sql === "SELECT id FROM doctors WHERE user_id = $1") {
        return { rows: values[0] === currentUser.id && currentUser.role === "doctor" ? [{ id: doctorId }] : [] };
      }
      if (sql.startsWith("SELECT availability.id, availability.doctor_id, availability.date::text AS date")) {
        database.availabilityQueries.push(sql);
        const [requestedDoctorId, currentDate, currentTime, _timezone, from, to] = values;
        const doctorManagementView = currentUser.role === "doctor" && requestedDoctorId === doctorId;
        return { rows: slots.filter((slot) => slot.doctor_id === requestedDoctorId
          && !slot.deleted_at
          && (slot.date > currentDate || (slot.date === currentDate && slot.start_time > currentTime))
          && (!from || slot.date >= from) && (!to || slot.date <= to)
          && !appointmentReferences.some((reference) => typeof reference !== "string"
            && reference.id === slot.id && reference.status === "confirmed" && reference.ends_at > Date.now())
          && (doctorManagementView || !paymentHoldReferences.some((reference) => typeof reference !== "string"
            && reference.id === slot.id && reference.status === "active" && new Date(reference.expires_at).getTime() > Date.now())))
          .map((slot) => {
            const activeHold = paymentHoldReferences.find((reference) => typeof reference !== "string"
              && reference.id === slot.id && reference.status === "active" && new Date(reference.expires_at).getTime() > Date.now());
            return { ...slot, hold_status: doctorManagementView ? activeHold?.status ?? null : null,
              hold_expires_at: doctorManagementView ? activeHold?.expires_at ?? null : null };
          }) };
      }
      throw new Error(`Unexpected test query: ${sql}`);
    },
    async connect() {
      let staged = [];
      let releaseLocks = [];
      let ownsLock = false;
      let pendingDeleteId = null;
      let pendingSoftDeleteId = null;
      return {
        async query(sql, values = []) {
          if (sql === "BEGIN") return { rows: [] };
          if (sql.startsWith("SELECT id FROM availability WHERE id = $1 AND doctor_id = $2 AND deleted_at IS NULL FOR UPDATE")) {
            const [slotId, requestedDoctorId] = values;
            return { rows: slots.some((slot) => slot.id === slotId && slot.doctor_id === requestedDoctorId && !slot.deleted_at) ? [{ id: slotId }] : [] };
          }
          if (sql.startsWith("SELECT pg_advisory_xact_lock")) {
            database.lockQueries.push(values);
            const lockKey = values.join(":");
            const previous = lockTails.get(lockKey) || Promise.resolve();
            let release;
            lockTails.set(lockKey, new Promise((resolve) => { release = resolve; }));
            await previous;
            ownsLock = true;
            releaseLocks.push(release);
            return { rows: [] };
          }
          if (sql.startsWith("SELECT date::text AS date")) {
            const [requestedDoctorId, dates] = values;
            return { rows: slots.filter((slot) => slot.doctor_id === requestedDoctorId && !slot.deleted_at && dates.includes(slot.date)) };
          }
          if (sql.startsWith("SELECT 1 FROM appointments") && sql.includes("status = 'confirmed'")) {
            database.appointmentQueries.push(sql);
            const active = appointmentReferences.some((reference) => typeof reference !== "string" && reference.id === values[0]
              && reference.status === "confirmed" && reference.ends_at > Date.now());
            return { rows: active ? [{ exists: 1 }] : [] };
          }
          if (sql.startsWith("SELECT 1 FROM appointment_slot_holds") && sql.includes("status = 'active'")) {
            database.holdQueries.push(sql);
            return { rows: paymentHoldReferences.some((reference) => typeof reference !== "string" && reference.id === values[0]
              && reference.status === "active" && reference.expires_at > Date.now()) ? [{ exists: 1 }] : [] };
          }
          if (sql.startsWith("SELECT EXISTS (SELECT 1 FROM appointments")) {
            const referenced = appointmentReferences.some((reference) => (typeof reference === "string" ? reference : reference.id) === values[0])
              || paymentHoldReferences.some((reference) => (typeof reference === "string" ? reference : reference.id) === values[0]);
            return { rows: [{ referenced }] };
          }
          if (sql.startsWith("UPDATE availability SET deleted_at")) {
            pendingSoftDeleteId = values[0];
            return { rows: [{ id: values[0] }] };
          }
          if (sql.startsWith("DELETE FROM availability")) {
            const [slotId, requestedDoctorId] = values;
            database.deleteQueries.push(sql);
            if (holdForeignKeyRaceReferences.includes(slotId)) {
              const error = new Error("foreign key conflict from appointment_slot_holds");
              error.code = "23001";
              error.constraint = "appointment_slot_holds_availability_id_fkey";
              throw error;
            }
            const slot = slots.find((item) => item.id === slotId && item.doctor_id === requestedDoctorId && !item.deleted_at);
            if (!slot) return { rows: [] };
            pendingDeleteId = slotId;
            return { rows: [{ id: slotId }] };
          }
          if (sql.startsWith("INSERT INTO availability")) {
            for (let index = 0; index < values.length; index += 4) {
              staged.push({
                id: `55555555-5555-4555-8555-${String(slots.length + staged.length + 1).padStart(12, "0")}`,
                doctor_id: values[index],
                date: values[index + 1],
                start_time: values[index + 2],
                end_time: values[index + 3],
                created_at: "2099-01-01T00:00:00.000Z",
                updated_at: "2099-01-01T00:00:00.000Z",
                deleted_at: null,
              });
            }
            return { rows: staged };
          }
          if (sql === "COMMIT") {
            slots.push(...staged);
            staged = [];
            if (pendingDeleteId) {
              const index = slots.findIndex((slot) => slot.id === pendingDeleteId);
              if (index >= 0) slots.splice(index, 1);
              pendingDeleteId = null;
            }
            if (pendingSoftDeleteId) {
              const slot = slots.find((item) => item.id === pendingSoftDeleteId);
              if (slot) slot.deleted_at = "2026-10-30T00:00:00.000Z";
              pendingSoftDeleteId = null;
            }
            for (const release of releaseLocks) release();
            releaseLocks = [];
            ownsLock = false;
            return { rows: [] };
          }
          if (sql === "ROLLBACK") {
            staged = [];
            pendingDeleteId = null;
            pendingSoftDeleteId = null;
            for (const release of releaseLocks) release();
            releaseLocks = [];
            ownsLock = false;
            return { rows: [] };
          }
          throw new Error(`Unexpected transaction query: ${sql}`);
        },
        release() {
          if (ownsLock) for (const release of releaseLocks) release();
        },
      };
    },
  };
  return database;
}

function createTestApp({ database, currentUser = user, authenticated = true, applicationTimezone = "UTC" } = {}) {
  database ||= createDatabase({ currentUser });
  return {
    app: createApp({
      database,
      applicationTimezone,
      frontendOrigin: "http://localhost:3000",
      clerkAuthMiddleware: (request, _response, next) => {
        request.auth = Object.assign(
          () => authenticated
            ? { isAuthenticated: true, userId: "user_clerk_verified", tokenType: "session_token" }
            : { isAuthenticated: false, userId: null, tokenType: "session_token" },
          { [Symbol.for("@clerk/express.auth")]: true },
        );
        next();
      },
    }),
    database,
  };
}

async function withServer(app, callback) {
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  try { await callback(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
}

function slot(date, start_time = "10:00", end_time = "10:30") {
  return { date, start_time, end_time };
}

describe("availability validation", () => {
  it("interprets dates and future slots in Asia/Kolkata independent of the host timezone", () => {
    const indiaNow = localDateTime("Asia/Kolkata", new Date("2026-01-01T18:45:00.000Z"));
    assert.deepEqual(indiaNow, { date: "2026-01-02", time: "00:15" });
    assert.equal(slotStartsInFuture(slot("2026-01-02", "00:30", "01:00"), indiaNow), true);
    assert.equal(slotStartsInFuture(slot("2026-01-02", "00:15", "00:45"), indiaNow), false);
    assert.equal(slotStartsInFuture(slot("2026-01-01", "23:59", "23:59"), indiaNow), false);
  });

  it("accepts a valid batch and rejects invalid dates, times, ordering, duplicates, and overlaps", () => {
    assert.equal(slotsBodySchema.safeParse({ slots: [slot("2099-04-10"), slot("2099-04-10", "10:30", "11:00")] }).success, true);
    assert.equal(slotsBodySchema.safeParse({ slots: [slot("2099-02-30")] }).success, false);
    assert.equal(slotsBodySchema.safeParse({ slots: [slot("2099-04-10", "25:00", "25:30")] }).success, false);
    assert.equal(slotsBodySchema.safeParse({ slots: [slot("2099-04-10", "10:30", "10:30")] }).success, false);
    assert.equal(slotsBodySchema.safeParse({ slots: [slot("2099-04-10"), slot("2099-04-10")] }).success, false);
    assert.equal(slotsBodySchema.safeParse({ slots: [slot("2099-04-10"), slot("2099-04-10", "10:15", "10:45")] }).success, false);
  });

  it("validates query dates, unknown parameters, and date range ordering", () => {
    assert.equal(slotQuerySchema.safeParse({ from: "2099-04-01", to: "2099-04-02" }).success, true);
    assert.equal(slotQuerySchema.safeParse({ from: "2099-02-30" }).success, false);
    assert.equal(slotQuerySchema.safeParse({ from: "2099-04-03", to: "2099-04-02" }).success, false);
    assert.equal(slotQuerySchema.safeParse({ unused: "true" }).success, false);
  });

  it("confirms the new migration follows Phase 1", () => {
    const migrationFiles = fs.readdirSync(path.join(__dirname, "..", "migrations")).filter((file) => file.endsWith(".sql")).sort();
    assert.deepEqual(migrationFiles.slice(0, 3), ["001_users_patients_doctors.sql", "002_doctor_availability.sql", "003_appointments.sql"]);
    assert.equal(migrationFiles.length, 11);
    assert.match(migrationFiles[3], /^004_.*\.sql$/);
    assert.equal(migrationFiles[4], "005_appointment_schedule_snapshot.sql");
    assert.equal(migrationFiles[5], "006_doctor_consultation_fee.sql");
    assert.equal(migrationFiles[6], "007_appointment_reminders.sql");
    assert.equal(migrationFiles[7], "008_payment_refund_schema.sql");
    assert.equal(migrationFiles[8], "009_payment_booking_reason.sql");
    assert.equal(migrationFiles[9], "010_payment_capture_reconciliation.sql");
    assert.equal(migrationFiles[10], "011_availability_soft_delete.sql");
    const sql = fs.readFileSync(path.join(__dirname, "..", "migrations", "002_doctor_availability.sql"), "utf8");
    assert.match(sql, /CREATE TABLE availability/i);
    assert.match(sql, /doctor_id UUID NOT NULL REFERENCES doctors\(id\) ON DELETE RESTRICT/i);
    assert.match(sql, /CHECK \(end_time > start_time\)/i);
    assert.match(sql, /UNIQUE INDEX availability_doctor_date_start_unique\s+ON availability \(doctor_id, date, start_time\)/i);
    assert.match(sql, /CREATE INDEX availability_date_idx ON availability \(date\)/i);
    const softDeleteSql = fs.readFileSync(path.join(__dirname, "..", "migrations", "011_availability_soft_delete.sql"), "utf8");
    assert.match(softDeleteSql, /ADD COLUMN deleted_at TIMESTAMPTZ/i);
    assert.match(softDeleteSql, /WHERE deleted_at IS NULL/i);
    assert.doesNotMatch(softDeleteSql, /ON DELETE CASCADE|DROP TABLE/i);
  });
});

describe("availability endpoints", () => {
  it("creates a valid slot batch and retrieves upcoming slots by date range", async () => {
    const { app, database } = createTestApp();
    await withServer(app, async (url) => {
      const created = await fetch(`${url}/api/v1/doctors/${doctorId}/slots`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ slots: [slot("2099-04-10"), slot("2099-04-10", "11:00", "11:30")] }),
      });
      assert.equal(created.status, 201);
      assert.equal((await created.json()).length, 2);
      assert.equal(database.slots.length, 2);
      assert.equal(database.lockQueries.length, 1);

      const response = await fetch(`${url}/api/v1/doctors/${doctorId}/slots?from=2099-04-10&to=2099-04-10`);
      assert.equal(response.status, 200);
      assert.equal((await response.json()).length, 2);
      assert.match(database.availabilityQueries[0], /NOT EXISTS[\s\S]*FROM appointments/);
    });
  });

  it("shows an active Checkout hold in the owning doctor's availability view with its expiry", async () => {
    const slotId = "44444444-4444-4444-8444-000000000021";
    const expiresAt = "2099-04-10T10:02:00.000Z";
    const database = createDatabase({
      initialSlots: [{ id: slotId, date: "2099-04-10", start_time: "10:00", end_time: "10:30" }],
      appointmentReferences: ["cancelled-1", "cancelled-2", "cancelled-3"].map((id) => ({ id: slotId, appointment_id: id, status: "cancelled", ends_at: 0 })),
      paymentHoldReferences: [{ id: slotId, status: "active", expires_at: expiresAt }],
    });
    const { app } = createTestApp({ database });
    await withServer(app, async (url) => {
      const response = await fetch(`${url}/api/v1/doctors/${doctorId}/slots?from=2099-04-10&to=2099-04-10`);
      assert.equal(response.status, 200);
      const rows = await response.json();
      assert.equal(rows.length, 1);
      assert.equal(rows[0].hold_status, "active");
      assert.equal(rows[0].hold_expires_at, expiresAt);
      assert.equal(rows[0].deleted_at, null);
      assert.equal(rows[0].status, undefined, "a payment hold is not represented as an appointment status");
      assert.match(database.availabilityQueries[0], /hold\.status = 'active' AND hold\.expires_at > NOW\(\)/);
    });
  });

  it("keeps active unexpired holds out of patient availability but ignores expired and released holds", async () => {
    const activeId = "44444444-4444-4444-8444-000000000022";
    const expiredId = "44444444-4444-4444-8444-000000000023";
    const releasedId = "44444444-4444-4444-8444-000000000024";
    const slots = [activeId, expiredId, releasedId].map((id) => ({ id, date: "2099-04-10", start_time: "10:00", end_time: "10:30" }));
    const holds = [
      { id: activeId, status: "active", expires_at: "2099-04-10T10:02:00.000Z" },
      { id: expiredId, status: "active", expires_at: "2000-01-01T00:00:00.000Z" },
      { id: releasedId, status: "released", expires_at: "2099-04-10T10:02:00.000Z" },
    ];
    const database = createDatabase({ initialSlots: slots, paymentHoldReferences: holds, currentUser: { ...user, role: "patient" } });
    const { app } = createTestApp({ database, currentUser: { ...user, role: "patient" } });
    await withServer(app, async (url) => {
      const response = await fetch(`${url}/api/v1/doctors/${doctorId}/slots?from=2099-04-10&to=2099-04-10`);
      assert.equal(response.status, 200);
      const rows = await response.json();
      assert.deepEqual(rows.map((row) => row.id).sort(), [expiredId, releasedId]);
      assert.ok(rows.every((row) => row.hold_status === null));
      assert.match(database.availabilityQueries[0], /AND payment_hold\.id IS NULL/);
    });
  });

  it("keeps the slot visible to its doctor after an active hold expires without cleanup", async () => {
    const slotId = "44444444-4444-4444-8444-000000000025";
    const database = createDatabase({
      initialSlots: [{ id: slotId, date: "2099-04-10", start_time: "10:00", end_time: "10:30" }],
      paymentHoldReferences: [{ id: slotId, status: "active", expires_at: "2000-01-01T00:00:00.000Z" }],
    });
    const { app } = createTestApp({ database });
    await withServer(app, async (url) => {
      const response = await fetch(`${url}/api/v1/doctors/${doctorId}/slots?from=2099-04-10&to=2099-04-10`);
      assert.equal(response.status, 200);
      const rows = await response.json();
      assert.equal(rows.length, 1);
      assert.equal(rows[0].id, slotId);
      assert.equal(rows[0].hold_status, null);
      assert.equal(rows[0].hold_expires_at, null);
    });
  });

  it("rejects past slots, invalid IDs and query parameters, and missing timezone configuration", async () => {
    const { app } = createTestApp();
    await withServer(app, async (url) => {
      const past = await fetch(`${url}/api/v1/doctors/${doctorId}/slots`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ slots: [slot("2000-01-01")] }),
      });
      assert.equal(past.status, 400);
      assert.equal((await fetch(`${url}/api/v1/doctors/not-a-uuid/slots`)).status, 400);
      assert.equal((await fetch(`${url}/api/v1/doctors/${doctorId}/slots?from=nope`)).status, 400);
    });
    const unconfigured = createTestApp({ applicationTimezone: null });
    await withServer(unconfigured.app, async (url) => {
      const response = await fetch(`${url}/api/v1/doctors/${doctorId}/slots`);
      assert.equal(response.status, 503);
      assert.equal((await response.json()).error.code, "TIMEZONE_NOT_CONFIGURED");
    });
  });

  it("rejects whole batches that overlap saved slots or contain invalid inputs", async () => {
    const existing = { date: "2099-04-10", start_time: "10:00", end_time: "10:30" };
    const { app, database } = createTestApp({ database: createDatabase({ initialSlots: [existing] }) });
    await withServer(app, async (url) => {
      const invalid = await fetch(`${url}/api/v1/doctors/${doctorId}/slots`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ slots: [slot("2099-04-10", "11:00", "11:30"), slot("2099-04-10", "10:15", "10:45")] }),
      });
      assert.equal(invalid.status, 409);
      assert.equal(database.slots.length, 1);
      const malformed = await fetch(`${url}/api/v1/doctors/${doctorId}/slots`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ slots: [slot("2099-04-10", "12:00", "11:00")] }),
      });
      assert.equal(malformed.status, 400);
    });
  });

  it("requires an authenticated active doctor and restricts writes to their own doctor profile", async () => {
    const unauthenticated = createTestApp({ authenticated: false });
    await withServer(unauthenticated.app, async (url) => {
      assert.equal((await fetch(`${url}/api/v1/doctors/${doctorId}/slots`)).status, 401);
      const response = await fetch(`${url}/api/v1/doctors/${doctorId}/slots`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ slots: [slot("2099-04-10")] }) });
      assert.equal(response.status, 401);
    });
    const patient = createTestApp({ currentUser: { ...user, role: "patient" } });
    await withServer(patient.app, async (url) => {
      const response = await fetch(`${url}/api/v1/doctors/${doctorId}/slots`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ slots: [slot("2099-04-10")] }) });
      assert.equal(response.status, 403);
    });
    const inactive = createTestApp({ currentUser: { ...user, is_active: false } });
    await withServer(inactive.app, async (url) => {
      const response = await fetch(`${url}/api/v1/doctors/${doctorId}/slots`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ slots: [slot("2099-04-10")] }) });
      assert.equal(response.status, 403);
      assert.equal((await response.json()).error.code, "ACCOUNT_INACTIVE");
    });
    const anotherDoctor = createTestApp();
    await withServer(anotherDoctor.app, async (url) => {
      const response = await fetch(`${url}/api/v1/doctors/${otherDoctorId}/slots`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ slots: [slot("2099-04-10")] }) });
      assert.equal(response.status, 403);
    });
  });

  it("hard-deletes unreferenced slots and soft-deletes historical appointment or hold references", async () => {
    const slotId = "44444444-4444-4444-8444-000000000001";
    const deletableDb = createDatabase({ initialSlots: [{ id: slotId, date: "2099-04-10", start_time: "10:00", end_time: "10:30" }] });
    const { app } = createTestApp({ database: deletableDb });
    await withServer(app, async (url) => {
      const missing = await fetch(`${url}/api/v1/doctors/${doctorId}/slots/66666666-6666-4666-8666-666666666666`, { method: "DELETE" });
      assert.equal(missing.status, 404);
      const deleted = await fetch(`${url}/api/v1/doctors/${doctorId}/slots/${slotId}`, { method: "DELETE" });
      assert.equal(deleted.status, 204);
      assert.equal(deletableDb.slots.length, 0);
      assert.ok(deletableDb.lockQueries.some((values) => values.length === 1 && values[0] === doctorId));
    });

    const referencedId = "44444444-4444-4444-8444-000000000002";
    const historicalCases = [
      { name: "past confirmed appointment", appointments: [{ id: referencedId, status: "confirmed", ends_at: Date.parse("2000-01-01T00:00:00Z") }] },
      { name: "cancelled appointment", appointments: [{ id: referencedId, status: "cancelled", ends_at: Date.parse("2099-04-10T10:30:00Z") }] },
      { name: "expired hold", holds: [{ id: referencedId, status: "expired", expires_at: 0 }] },
      { name: "released hold", holds: [{ id: referencedId, status: "released", expires_at: Date.now() + 60_000 }] },
    ];
    for (const [index, entry] of historicalCases.entries()) {
      const slotIdForCase = `44444444-4444-4444-8444-${String(index + 2).padStart(12, "0")}`;
      const database = createDatabase({
        initialSlots: [{ id: slotIdForCase, date: "2099-04-10", start_time: "10:00", end_time: "10:30" }],
        appointmentReferences: (entry.appointments || []).map((item) => ({ ...item, id: slotIdForCase })),
        paymentHoldReferences: (entry.holds || []).map((item) => ({ ...item, id: slotIdForCase })),
      });
      const test = createTestApp({ database });
      await withServer(test.app, async (url) => {
        const response = await fetch(`${url}/api/v1/doctors/${doctorId}/slots/${slotIdForCase}`, { method: "DELETE" });
        assert.equal(response.status, 204, entry.name);
        assert.equal(database.slots.length, 1);
        assert.ok(database.slots[0].deleted_at);
        const listed = await fetch(`${url}/api/v1/doctors/${doctorId}/slots?from=2099-04-10&to=2099-04-10`);
        assert.deepEqual(await listed.json(), []);
      });
    }

    const racedHoldId = "44444444-4444-4444-8444-000000000004";
    const racedHoldDb = createDatabase({
      initialSlots: [{ id: racedHoldId, date: "2099-04-10", start_time: "10:00", end_time: "10:30" }],
      holdForeignKeyRaceReferences: [racedHoldId],
    });
    const racedHold = createTestApp({ database: racedHoldDb });
    await withServer(racedHold.app, async (url) => {
      const response = await fetch(`${url}/api/v1/doctors/${doctorId}/slots/${racedHoldId}`, { method: "DELETE" });
      assert.equal(response.status, 409);
      assert.equal((await response.json()).error.code, "SLOT_IN_USE");
      assert.equal(racedHoldDb.slots.length, 1);
    });

    const anotherOwner = createTestApp();
    await withServer(anotherOwner.app, async (url) => {
      const response = await fetch(`${url}/api/v1/doctors/${otherDoctorId}/slots/${slotId}`, { method: "DELETE" });
      assert.equal(response.status, 403);
    });
  });

  it("rejects future confirmed appointments and active unexpired holds", async () => {
    const cases = [
      { id: "44444444-4444-4444-8444-000000000011", appointments: [{ id: "x", status: "confirmed", ends_at: Date.parse("2099-04-10T10:30:00Z") }] },
      { id: "44444444-4444-4444-8444-000000000012", holds: [{ id: "x", status: "active", expires_at: Date.now() + 60_000 }] },
    ];
    for (const entry of cases) {
      const database = createDatabase({
        initialSlots: [{ id: entry.id, date: "2099-04-10", start_time: "10:00", end_time: "10:30" }],
        appointmentReferences: (entry.appointments || []).map((item) => ({ ...item, id: entry.id })),
        paymentHoldReferences: (entry.holds || []).map((item) => ({ ...item, id: entry.id })),
      });
      const test = createTestApp({ database });
      await withServer(test.app, async (url) => {
        const response = await fetch(`${url}/api/v1/doctors/${doctorId}/slots/${entry.id}`, { method: "DELETE" });
        assert.equal(response.status, 409);
        assert.equal((await response.json()).error.code, "SLOT_IN_USE");
        assert.equal(database.slots[0].deleted_at, null);
      });
    }
  });

  it("allows recreating a previously soft-deleted time slot", async () => {
    const slotId = "44444444-4444-4444-8444-000000000013";
    const database = createDatabase({
      initialSlots: [{ id: slotId, date: "2099-04-10", start_time: "10:00", end_time: "10:30" }],
      appointmentReferences: [{ id: slotId, status: "cancelled", ends_at: 0 }],
    });
    const test = createTestApp({ database });
    await withServer(test.app, async (url) => {
      assert.equal((await fetch(`${url}/api/v1/doctors/${doctorId}/slots/${slotId}`, { method: "DELETE" })).status, 204);
      const response = await fetch(`${url}/api/v1/doctors/${doctorId}/slots`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ slots: [slot("2099-04-10", "10:00", "10:30")] }),
      });
      assert.equal(response.status, 201);
      assert.equal(database.slots.length, 2);
      assert.ok(database.slots[0].deleted_at);
      assert.equal(database.slots[1].deleted_at, null);
    });
  });

  it("serializes concurrent historical-slot removal and same-time availability creation", async () => {
    const slotId = "44444444-4444-4444-8444-000000000014";
    const database = createDatabase({
      initialSlots: [{ id: slotId, date: "2099-04-10", start_time: "10:00", end_time: "10:30" }],
      appointmentReferences: [{ id: slotId, status: "cancelled", ends_at: 0 }],
    });
    const test = createTestApp({ database });
    await withServer(test.app, async (url) => {
      const remove = fetch(`${url}/api/v1/doctors/${doctorId}/slots/${slotId}`, { method: "DELETE" });
      const create = fetch(`${url}/api/v1/doctors/${doctorId}/slots`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ slots: [slot("2099-04-10", "10:00", "10:30")] }),
      });
      const [removed, created] = await Promise.all([remove, create]);
      assert.equal(removed.status, 204);
      assert.ok([201, 409].includes(created.status));
      assert.ok(database.slots.filter((item) => !item.deleted_at).length <= 1);
    });
  });

  it("serializes concurrent overlapping creates for the same doctor and date", async () => {
    const { app, database } = createTestApp();
    await withServer(app, async (url) => {
      const create = (start_time, end_time) => fetch(`${url}/api/v1/doctors/${doctorId}/slots`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ slots: [slot("2099-04-10", start_time, end_time)] }),
      });
      const responses = await Promise.all([create("10:00", "10:30"), create("10:15", "10:45")]);
      assert.deepEqual(responses.map((response) => response.status).sort(), [201, 409]);
      assert.equal(database.slots.length, 1);
      assert.equal(database.lockQueries.length, 2);
    });
  });
});
