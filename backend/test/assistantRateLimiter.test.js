const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { createAssistantRateLimiter } = require("../src/middleware/assistantRateLimiter");

function sendRequest(limiter, userId) {
  const response = {
    locals: { user: { id: userId } },
    headers: {},
    set(name, value) { this.headers[name] = value; return this; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  let nextCalls = 0;
  limiter({}, response, () => { nextCalls += 1; return response; });
  return { response, nextCalls };
}

describe("assistant user rate limiter", () => {
  it("allows ten requests per user per minute and returns a standard 429 with Retry-After", () => {
    let currentTime = 1000;
    const limiter = createAssistantRateLimiter({ now: () => currentTime });
    for (let request = 0; request < 10; request += 1) {
      assert.equal(sendRequest(limiter, "patient-a").nextCalls, 1);
    }
    const limited = sendRequest(limiter, "patient-a");
    assert.equal(limited.nextCalls, 0);
    assert.equal(limited.response.statusCode, 429);
    assert.equal(limited.response.headers["Retry-After"], "60");
    assert.deepEqual(limited.response.body, {
      error: { code: "RATE_LIMITED", message: "Too many assistant requests. Please try again shortly." },
    });
    currentTime += 60_000;
    assert.equal(sendRequest(limiter, "patient-a").nextCalls, 1);
  });

  it("keeps request quotas independent for each authenticated local user", () => {
    const limiter = createAssistantRateLimiter({ now: () => 5000 });
    for (let request = 0; request < 10; request += 1) {
      assert.equal(sendRequest(limiter, "patient-a").nextCalls, 1);
      assert.equal(sendRequest(limiter, "patient-b").nextCalls, 1);
    }
    assert.equal(sendRequest(limiter, "patient-a").response.statusCode, 429);
    assert.equal(sendRequest(limiter, "patient-b").response.statusCode, 429);
  });
});
