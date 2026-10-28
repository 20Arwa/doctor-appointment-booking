async function listPatients(_request, response) {
  const user = response.locals.user;
  if (user.role !== "patient") {
    return response.status(403).json({ error: { code: "FORBIDDEN", message: "Patient records are not available to this account" } });
  }
  const result = await response.locals.database.query(
    "SELECT p.id, p.date_of_birth, p.gender, p.created_at, p.updated_at FROM patients p WHERE p.user_id = $1",
    [user.id],
  );
  return response.json(result.rows);
}

async function getPatient(_request, response) {
  const user = response.locals.user;
  if (user.role !== "patient") {
    return response.status(403).json({ error: { code: "FORBIDDEN", message: "Patient records are not available to this account" } });
  }
  const result = await response.locals.database.query(
    "SELECT p.id, p.date_of_birth, p.gender, p.created_at, p.updated_at FROM patients p WHERE p.id = $1 AND p.user_id = $2",
    [response.locals.params.id, user.id],
  );
  if (!result.rows[0]) return response.status(404).json({ error: { code: "NOT_FOUND", message: "Patient not found" } });
  return response.json(result.rows[0]);
}

async function updatePatient(_request, response, next) {
  const user = response.locals.user;
  if (user.role !== "patient") {
    return response.status(403).json({ error: { code: "FORBIDDEN", message: "Patient records are not available to this account" } });
  }
  const fields = response.locals.body;
  const columns = Object.keys(fields);
  const values = columns.map((column) => fields[column]);
  const assignments = columns.map((column, index) => `${column} = $${index + 1}`);
  values.push(response.locals.params.id, user.id);
  try {
    const result = await response.locals.database.query(
      `UPDATE patients SET ${assignments.join(", ")}, updated_at = NOW() WHERE id = $${values.length - 1} AND user_id = $${values.length} RETURNING id, date_of_birth, gender, created_at, updated_at`,
      values,
    );
    if (!result.rows[0]) return response.status(404).json({ error: { code: "NOT_FOUND", message: "Patient not found" } });
    return response.json(result.rows[0]);
  } catch (error) { return next(error); }
}

module.exports = { getPatient, listPatients, updatePatient };
