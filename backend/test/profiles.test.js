const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { describe, it } = require("node:test");
const { createApp } = require("../src/app");
const { doctorUpdateSchema, onboardingSchema, patientUpdateSchema, userPatchSchema } = require("../src/validators/profileSchemas");

const sampleUser = {
  id: "11111111-1111-4111-8111-111111111111",
  clerk_user_id: "user_verified_123",
  first_name: "Sam",
  last_name: "Patient",
  email: "sam@example.com",
  phone: null,
  role: "patient",
  is_active: true,
};

function testApp({ user = sampleUser, authenticated = true, databaseQuery, database, clerkProfileResolver } = {}) {
  const app = createApp({
    database: database || { query: databaseQuery || (async (sql) => {
      if (sql.includes("FROM users WHERE clerk_user_id")) return { rows: [user] };
      if (sql.includes("FROM patients p WHERE p.user_id")) return { rows: [{ id: "22222222-2222-4222-8222-222222222222", user_id: user.id }] };
      return { rows: [] };
    }) },
    frontendOrigin: "http://localhost:3000",
    clerkAuthMiddleware: (request, _response, next) => {
      request.auth = authenticated ? { isAuthenticated: true, userId: "user_verified_123" } : { isAuthenticated: false };
      next();
    },
    clerkProfileResolver,
  });
  return app;
}

async function withServer(app, callback) {
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  try { await callback(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
}

describe("profile request validation", () => {
  it("allows only patient or doctor role and requires doctor specialty", () => {
    assert.equal(onboardingSchema.safeParse({ role: "patient" }).success, true);
    assert.equal(onboardingSchema.safeParse({ role: "doctor" }).success, false);
    assert.equal(onboardingSchema.safeParse({ role: "admin" }).success, false);
    assert.equal(onboardingSchema.safeParse({ role: "doctor", specialty: "Cardiology" }).success, true);
  });

  it("blocks role and identity fields on user updates", () => {
    assert.equal(userPatchSchema.safeParse({ first_name: "Sam" }).success, true);
    assert.equal(userPatchSchema.safeParse({ role: "doctor" }).success, false);
    assert.equal(userPatchSchema.safeParse({ clerk_user_id: "another-user" }).success, false);
  });

  it("rejects invalid patient and doctor fields", () => {
    assert.equal(patientUpdateSchema.safeParse({ date_of_birth: "not-a-date" }).success, false);
    assert.equal(patientUpdateSchema.safeParse({ gender: "unspecified" }).success, true);
    assert.equal(doctorUpdateSchema.safeParse({ specialty: "" }).success, false);
    assert.equal(doctorUpdateSchema.safeParse({ user_id: "another-user" }).success, false);
  });
});

describe("Phase 1 database migration", () => {
  it("declares case-insensitive email uniqueness, profile uniqueness, role checks, and restrictive user foreign keys", () => {
    const migration = fs.readFileSync(path.join(__dirname, "..", "migrations", "001_users_patients_doctors.sql"), "utf8");
    assert.match(migration, /UNIQUE INDEX users_email_lower_unique ON users \(lower\(email\)\)/i);
    assert.match(migration, /role TEXT NOT NULL CHECK \(role IN \('patient', 'doctor'\)\)/i);
    assert.match(migration, /user_id UUID NOT NULL UNIQUE REFERENCES users\(id\) ON DELETE RESTRICT/i);
    assert.equal((migration.match(/user_id UUID NOT NULL UNIQUE REFERENCES users\(id\) ON DELETE RESTRICT/gi) || []).length, 2);
    assert.match(migration, /clerk_user_id TEXT NOT NULL UNIQUE/i);
  });
});

describe("profile authorization", () => {
  it("rejects requests without a verified Clerk identity", async () => {
    await withServer(testApp({ authenticated: false }), async (url) => {
      const response = await fetch(`${url}/api/v1/users/me`);
      assert.equal(response.status, 401);
      assert.equal((await response.json()).error.code, "UNAUTHENTICATED");
    });
  });

  it("rejects inactive local users", async () => {
    await withServer(testApp({ user: { ...sampleUser, is_active: false } }), async (url) => {
      const response = await fetch(`${url}/api/v1/users/me`);
      assert.equal(response.status, 403);
      assert.equal((await response.json()).error.code, "ACCOUNT_INACTIVE");
    });
  });

  it("rejects a role change and limits patient listings to the patient's own profile", async () => {
    const app = testApp({});
    await withServer(app, async (url) => {
      const roleChange = await fetch(`${url}/api/v1/users/me`, {
        method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ role: "doctor" }),
      });
      assert.equal(roleChange.status, 400);
      const patientList = await fetch(`${url}/api/v1/patients`);
      assert.equal(patientList.status, 200);
      assert.equal((await patientList.json()).length, 1);
    });
  });

  it("does not let a self-selected doctor access patient listings", async () => {
    const user = { ...sampleUser, role: "doctor" };
    let patientQueries = 0;
    const app = testApp({ user, databaseQuery: async (sql) => {
      if (sql.includes("FROM users WHERE clerk_user_id")) return { rows: [user] };
      if (sql.includes("FROM patients")) patientQueries += 1;
      return { rows: [] };
    } });
    await withServer(app, async (url) => {
      const response = await fetch(`${url}/api/v1/patients`);
      assert.equal(response.status, 403);
      assert.equal(patientQueries, 0);
    });
  });

  it("scopes patient record reads to the authenticated local user's ownership", async () => {
    const patientId = "22222222-2222-4222-8222-222222222222";
    let lookupParameters;
    const app = testApp({ databaseQuery: async (sql, values) => {
      if (sql.includes("FROM users WHERE clerk_user_id")) return { rows: [sampleUser] };
      if (sql.includes("FROM patients p WHERE p.id")) { lookupParameters = values; return { rows: [] }; }
      return { rows: [] };
    } });
    await withServer(app, async (url) => {
      const response = await fetch(`${url}/api/v1/patients/${patientId}`);
      assert.equal(response.status, 404);
      assert.deepEqual(lookupParameters, [patientId, sampleUser.id]);
    });
  });

  it("creates the selected role and matching profile atomically, and rejects duplicate onboarding", async () => {
    const statements = [];
    const transactionClient = {
      query: async (sql, values = []) => {
        statements.push(sql);
        if (sql.startsWith("INSERT INTO users")) {
          return { rows: [{ ...sampleUser, role: values[5] }] };
        }
        if (sql.startsWith("INSERT INTO doctors")) return { rows: [{ id: "33333333-3333-4333-8333-333333333333", specialty: values[1] }] };
        if (sql.startsWith("INSERT INTO patients")) return { rows: [{ id: "44444444-4444-4444-8444-444444444444" }] };
        return { rows: [] };
      },
      release() {},
    };
    const database = { query: async () => ({ rows: [] }), connect: async () => transactionClient };
    const app = testApp({
      database,
      clerkProfileResolver: async () => ({ firstName: "Sam", lastName: "Doctor", email: "sam@example.com", phone: null }),
    });
    await withServer(app, async (url) => {
      const response = await fetch(`${url}/api/v1/users/me`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ role: "doctor", specialty: "Cardiology" }),
      });
      assert.equal(response.status, 201);
      const body = await response.json();
      assert.equal(body.role, "doctor");
      assert.equal(body.profile.specialty, "Cardiology");
      assert.equal(statements[0], "BEGIN");
      assert.ok(statements.some((sql) => sql.startsWith("INSERT INTO doctors")));
      assert.equal(statements.at(-1), "COMMIT");
    });

    const duplicateClient = { ...transactionClient, query: async (sql) => {
      if (sql.startsWith("INSERT INTO users")) { const error = new Error("duplicate"); error.code = "23505"; throw error; }
      return { rows: [] };
    } };
    await withServer(testApp({ database: { query: async () => ({ rows: [] }), connect: async () => duplicateClient }, clerkProfileResolver: async () => ({ firstName: "Sam", lastName: "Doctor", email: "sam@example.com", phone: null }) }), async (url) => {
      const response = await fetch(`${url}/api/v1/users/me`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ role: "patient" }),
      });
      assert.equal(response.status, 409);
      assert.equal((await response.json()).error.code, "PROFILE_CONFLICT");
    });
  });
});
