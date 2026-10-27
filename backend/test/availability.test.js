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

function createDatabase({ initialSlots = [], appointmentReferences = [], currentUser = user } = {}) {
  const slots = initialSlots.map((slot, index) => ({
    id: slot.id || `44444444-4444-4444-8444-${String(index + 1).padStart(12, "0")}`,
    doctor_id: slot.doctor_id || doctorId,
    date: slot.date,
    start_time: slot.start_time,
    end_time: slot.end_time,
    created_at: "2099-01-01T00:00:00.000Z",
    updated_at: "2099-01-01T00:00:00.000Z",
  }));
  const lockTails = new Map();

  const database = {
    slots,
    lockQueries: [],
    availabilityQueries: [],
    async query(sql, values = []) {
      if (sql.includes("FROM users WHERE clerk_user_id")) return { rows: [currentUser] };
      if (sql === "SELECT id FROM doctors WHERE user_id = $1") {
        return { rows: values[0] === currentUser.id && currentUser.role === "doctor" ? [{ id: doctorId }] : [] };
      }
      if (sql.startsWith("SELECT id, doctor_id, date::text AS date")) {
        database.availabilityQueries.push(sql);
        const [requestedDoctorId, currentDate, currentTime, from, to] = values;
        return { rows: slots.filter((slot) => slot.doctor_id === requestedDoctorId
          && (slot.date > currentDate || (slot.date === currentDate && slot.start_time > currentTime))
          && (!from || slot.date >= from) && (!to || slot.date <= to)) };
      }
      if (sql.startsWith("DELETE FROM availability")) {
        const [slotId, requestedDoctorId] = values;
        if (appointmentReferences.includes(slotId)) {
          const error = new Error("foreign key conflict");
          error.code = "23503";
          throw error;
        }
        const index = slots.findIndex((slot) => slot.id === slotId && slot.doctor_id === requestedDoctorId);
        if (index < 0) return { rows: [] };
        return { rows: [slots.splice(index, 1)[0]] };
      }
      throw new Error(`Unexpected test query: ${sql}`);
    },
    async connect() {
      let staged = [];
      let releaseLocks = [];
      let ownsLock = false;
      return {
        async query(sql, values = []) {
          if (sql === "BEGIN") return { rows: [] };
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
            return { rows: slots.filter((slot) => slot.doctor_id === requestedDoctorId && dates.includes(slot.date)) };
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
              });
            }
            return { rows: staged };
          }
          if (sql === "COMMIT") {
            slots.push(...staged);
            staged = [];
            for (const release of releaseLocks) release();
            releaseLocks = [];
            ownsLock = false;
            return { rows: [] };
          }
          if (sql === "ROLLBACK") {
            staged = [];
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
        request.auth = authenticated ? { isAuthenticated: true, userId: "user_clerk_verified" } : { isAuthenticated: false };
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
    assert.equal(migrationFiles.length, 4);
    assert.match(migrationFiles[3], /^004_.*\.sql$/);
    const sql = fs.readFileSync(path.join(__dirname, "..", "migrations", "002_doctor_availability.sql"), "utf8");
    assert.match(sql, /CREATE TABLE availability/i);
    assert.match(sql, /doctor_id UUID NOT NULL REFERENCES doctors\(id\) ON DELETE RESTRICT/i);
    assert.match(sql, /CHECK \(end_time > start_time\)/i);
    assert.match(sql, /UNIQUE INDEX availability_doctor_date_start_unique\s+ON availability \(doctor_id, date, start_time\)/i);
    assert.match(sql, /CREATE INDEX availability_date_idx ON availability \(date\)/i);
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

  it("deletes only owned slots and returns a conflict when a slot is appointment-referenced", async () => {
    const slotId = "44444444-4444-4444-8444-000000000001";
    const { app } = createTestApp({ database: createDatabase({ initialSlots: [{ id: slotId, date: "2099-04-10", start_time: "10:00", end_time: "10:30" }] }) });
    await withServer(app, async (url) => {
      const missing = await fetch(`${url}/api/v1/doctors/${doctorId}/slots/66666666-6666-4666-8666-666666666666`, { method: "DELETE" });
      assert.equal(missing.status, 404);
      const deleted = await fetch(`${url}/api/v1/doctors/${doctorId}/slots/${slotId}`, { method: "DELETE" });
      assert.equal(deleted.status, 204);
    });
    const referencedId = "44444444-4444-4444-8444-000000000002";
    const referenced = createTestApp({ database: createDatabase({
      initialSlots: [{ id: referencedId, date: "2099-04-10", start_time: "10:00", end_time: "10:30" }],
      appointmentReferences: [referencedId],
    }) });
    await withServer(referenced.app, async (url) => {
      const response = await fetch(`${url}/api/v1/doctors/${doctorId}/slots/${referencedId}`, { method: "DELETE" });
      assert.equal(response.status, 409);
      assert.equal((await response.json()).error.code, "SLOT_REFERENCED");
    });
    const anotherOwner = createTestApp();
    await withServer(anotherOwner.app, async (url) => {
      const response = await fetch(`${url}/api/v1/doctors/${otherDoctorId}/slots/${slotId}`, { method: "DELETE" });
      assert.equal(response.status, 403);
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
