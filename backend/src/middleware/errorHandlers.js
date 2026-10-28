function notFoundHandler(_request, response) {
  response.status(404).json({
    error: { code: "NOT_FOUND", message: "Resource not found" },
  });
}

function errorHandler(error, request, response, next) {
  if (response.headersSent) {
    return next(error);
  }

  const isBadRequest =
    error instanceof SyntaxError &&
    error.status === 400 &&
    "body" in error;

  console.error("[API ERROR]", {
    method: request.method,
    path: request.path,
    name: error.name,
    code: error.code,
    message: error.message,
    stack: error.stack,
  });

  const status = isBadRequest ? 400 : 500;
  const code = isBadRequest ? "INVALID_JSON" : "INTERNAL_SERVER_ERROR";
  const message = isBadRequest
    ? "Request body must contain valid JSON"
    : "An unexpected error occurred";

  response.status(status).json({
    error: { code, message },
  });
}

module.exports = { errorHandler, notFoundHandler };
