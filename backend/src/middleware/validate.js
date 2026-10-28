function validate(schema, source) {
  return (request, response, next) => {
    const result = schema.safeParse(request[source]);
    if (!result.success) {
      return response.status(400).json({
        error: {
          code: "VALIDATION_ERROR",
          message: "Request contains invalid fields",
          details: result.error.issues.map(({ path, message }) => ({ path: path.join("."), message })),
        },
      });
    }
    response.locals[source] = result.data;
    return next();
  };
}

module.exports = { validate };
