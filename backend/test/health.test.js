const assert = require("node:assert/strict");
const { after, before, describe, it } = require("node:test");
const { createApp } = require("../src/app");

const testClerkMiddleware = (_request, _response, next) => next();

describe("GET /api/v1/health", () => {
  let server;
  let baseUrl;
  let query;
  let queryCount;

  before(async () => {
    queryCount = 0;
    query = async (sql) => {
      queryCount += 1;
      assert.equal(sql, "SELECT 1");
      return { rows: [{ "?column?": 1 }] };
    };
    const app = createApp({
      database: { query: (...args) => query(...args) },
      frontendOrigin: "http://localhost:3000",
      clerkAuthMiddleware: testClerkMiddleware,
    });
    server = app.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  it("returns application and database health when the database responds", async () => {
    const response = await fetch(`${baseUrl}/api/v1/health`);

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: "ok", database: "connected" });
    assert.equal(queryCount, 1);
  });

  it("returns a generic unavailable status when the database fails", async () => {
    query = async () => {
      throw new Error("private connection details");
    };
    const response = await fetch(`${baseUrl}/api/v1/health`);

    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { status: "error", database: "unavailable" });
  });

  it("returns a consistent not-found response outside the API routes", async () => {
    const response = await fetch(`${baseUrl}/api/v1/missing`);

    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), {
      error: { code: "NOT_FOUND", message: "Resource not found" },
    });
  });
});

describe("error handling", () => {
  it("returns a safe validation error for malformed JSON", async () => {
    const app = createApp({
      database: { query: async () => ({ rows: [] }) },
      frontendOrigin: "http://localhost:3000",
      clerkAuthMiddleware: testClerkMiddleware,
    });
    const server = app.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));

    try {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/v1/health`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{invalid",
      });

      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), {
        error: { code: "INVALID_JSON", message: "Request body must contain valid JSON" },
      });
    } finally {
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
