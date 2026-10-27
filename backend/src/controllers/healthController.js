async function getHealth(_request, response, next) {
  try {
    await response.locals.database.query("SELECT 1");
    return response.status(200).json({
      status: "ok",
      database: "connected",
    });
  } catch (_error) {
    return response.status(503).json({
      status: "error",
      database: "unavailable",
    });
  }
}

module.exports = { getHealth };
