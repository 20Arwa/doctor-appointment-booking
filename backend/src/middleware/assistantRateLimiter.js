const DEFAULT_LIMIT = 10;
const DEFAULT_WINDOW_MS = 60_000;

// This limiter is process-local; multiple backend processes do not share quota state.
function createAssistantRateLimiter({ limit = DEFAULT_LIMIT, windowMs = DEFAULT_WINDOW_MS, now = Date.now } = {}) {
  const windows = new Map();
  let nextCleanupAt = 0;

  return function assistantRateLimiter(_request, response, next) {
    const userId = response.locals.user?.id;
    if (!userId) {
      return response.status(401).json({ error: { code: "UNAUTHENTICATED", message: "Authentication is required" } });
    }

    const currentTime = now();
    if (currentTime >= nextCleanupAt) {
      for (const [key, window] of windows) {
        if (window.resetAt <= currentTime) windows.delete(key);
      }
      nextCleanupAt = currentTime + windowMs;
    }

    let userWindow = windows.get(userId);
    if (!userWindow || userWindow.resetAt <= currentTime) {
      userWindow = { count: 0, resetAt: currentTime + windowMs };
      windows.set(userId, userWindow);
    }

    if (userWindow.count >= limit) {
      const retryAfter = Math.max(1, Math.ceil((userWindow.resetAt - currentTime) / 1000));
      response.set("Retry-After", String(retryAfter));
      return response.status(429).json({
        error: { code: "RATE_LIMITED", message: "You're sending messages too quickly. Please wait a moment before trying again." },
      });
    }

    userWindow.count += 1;
    return next();
  };
}

const assistantRateLimiter = createAssistantRateLimiter();

module.exports = { assistantRateLimiter, createAssistantRateLimiter };
