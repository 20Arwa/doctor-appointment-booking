async function listDoctors(database, filters = {}) {
  const values = [];
  const where = ["u.is_active = TRUE"];
  if (filters.name) {
    values.push(filters.name);
    where.push(`CONCAT_WS(' ', u.first_name, u.last_name) ILIKE '%' || $${values.length} || '%'`);
  }
  if (filters.specialty) {
    values.push(filters.specialty);
    where.push(`d.specialty ILIKE '%' || $${values.length} || '%'`);
  }
  const limit = Number.isInteger(filters.limit) ? ` LIMIT $${values.push(filters.limit)}` : "";
  const result = await database.query(
    `SELECT d.id, u.first_name, u.last_name, d.specialty, d.bio, d.appointment_duration_minutes,
            d.consultation_fee::float8 AS consultation_fee, d.created_at, d.updated_at
     FROM doctors d JOIN users u ON u.id = d.user_id
     WHERE ${where.join(" AND ")}
     ORDER BY u.last_name, u.first_name${limit}`,
    values,
  );
  return result.rows;
}

module.exports = { listDoctors };
