function notFoundHandler(_request, response) {
  response.status(404).json({
    error: { code: "NOT_FOUND", message: "Resource not found" },
  });
}

function errorHandler(error, _request, response, _next) {
  if (response.headersSent) return;

  const isBadRequest = error instanceof SyntaxError && error.status === 400 && "body" in error;
  const status = isBadRequest ? 400 : 500;
  const code = isBadRequest ? "INVALID_JSON" : "INTERNAL_SERVER_ERROR";
  const message = isBadRequest ? "Request body must contain valid JSON" : "An unexpected error occurred";
  if (process.env.NODE_ENV !== "production") {
  console.error(error);
}

  response.status(status).json({ error: { code, message } });
}

module.exports = { errorHandler, notFoundHandler };
