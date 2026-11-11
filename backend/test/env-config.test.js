const assert = require("node:assert/strict");
const test = require("node:test");

const configPath = require.resolve("../src/config/env");
const controlledKeys = ["NODE_ENV", "CLERK_SECRET_KEY", "DATABASE_URL", "FRONTEND_ORIGIN", "STRIPE_SECRET_KEY"];

function loadConfig(overrides) {
  const original = Object.fromEntries(controlledKeys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, {
    CLERK_SECRET_KEY: "unit-test-clerk-secret",
    DATABASE_URL: "postgresql://unit-test:unit-test@127.0.0.1:5432/unit_test",
    STRIPE_SECRET_KEY: "sk_test_unit",
    ...overrides,
  });
  for (const key of controlledKeys) {
    if (!Object.hasOwn(overrides, key)) delete process.env[key];
  }
  delete require.cache[configPath];
  try {
    return { config: require(configPath) };
  } catch (error) {
    return { error };
  } finally {
    for (const key of controlledKeys) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
    delete require.cache[configPath];
  }
}

test("uses the localhost frontend origin default outside production", () => {
  const { config, error } = loadConfig({ NODE_ENV: "development" });
  assert.equal(error, undefined);
  assert.equal(config.FRONTEND_ORIGIN, "http://localhost:3000");
});

test("requires an explicit HTTPS frontend origin in production", () => {
  const missing = loadConfig({ NODE_ENV: "production" });
  assert.match(missing.error?.message || "", /FRONTEND_ORIGIN/);

  const http = loadConfig({ NODE_ENV: "production", FRONTEND_ORIGIN: "http://app.example.test" });
  assert.match(http.error?.message || "", /FRONTEND_ORIGIN/);

  for (const frontendOrigin of [
    "https://alice@app.example.test",
    "https://:secret@app.example.test",
    "https://alice:secret@app.example.test",
  ]) {
    const credentials = loadConfig({ NODE_ENV: "production", FRONTEND_ORIGIN: frontendOrigin });
    assert.match(credentials.error?.message || "", /FRONTEND_ORIGIN/);
  }

  const configured = loadConfig({ NODE_ENV: "production", FRONTEND_ORIGIN: "https://app.example.test" });
  assert.equal(configured.error, undefined);
  assert.equal(configured.config.FRONTEND_ORIGIN, "https://app.example.test");
});
