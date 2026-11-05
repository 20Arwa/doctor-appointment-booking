const appointmentService = require("../services/appointmentService");

async function listDoctors(_request, response) {
  const result = await response.locals.database.query(
    "SELECT d.id, u.first_name, u.last_name, d.specialty, d.bio, d.appointment_duration_minutes, d.consultation_fee::float8 AS consultation_fee, d.created_at, d.updated_at FROM doctors d JOIN users u ON u.id = d.user_id WHERE u.is_active = TRUE ORDER BY u.last_name, u.first_name",
  );
  return response.json(result.rows);
}

async function getDoctor(_request, response) {
  const result = await response.locals.database.query(
    "SELECT d.id, u.first_name, u.last_name, d.specialty, d.bio, d.appointment_duration_minutes, d.consultation_fee::float8 AS consultation_fee, d.created_at, d.updated_at FROM doctors d JOIN users u ON u.id = d.user_id WHERE d.id = $1 AND u.is_active = TRUE",
    [response.locals.params.id],
  );
  if (!result.rows[0]) return response.status(404).json({ error: { code: "NOT_FOUND", message: "Doctor not found" } });
  return response.json(result.rows[0]);
}

async function updateDoctor(_request, response, next) {
  const user = response.locals.user;
  if (user.role !== "doctor") {
    return response.status(403).json({ error: { code: "FORBIDDEN", message: "Only the owning doctor may update this profile" } });
  }
  const fields = response.locals.body;
  const columns = Object.keys(fields);
  const values = columns.map((column) => fields[column]);
  const assignments = columns.map((column, index) => `${column} = $${index + 1}`);
  values.push(response.locals.params.id, user.id);
  try {
    const result = await response.locals.database.query(
      `UPDATE doctors SET ${assignments.join(", ")}, updated_at = NOW() WHERE id = $${values.length - 1} AND user_id = $${values.length} RETURNING id, specialty, bio, appointment_duration_minutes, consultation_fee::float8 AS consultation_fee, created_at, updated_at`,
      values,
    );
    if (!result.rows[0]) return response.status(404).json({ error: { code: "NOT_FOUND", message: "Doctor not found" } });
    return response.json(result.rows[0]);
  } catch (error) { return next(error); }
}

async function getDoctorPatient(_request, response, next) {
  try {
    const patient = await appointmentService.getDoctorPatient(
      response.locals.database,
      response.locals.user,
      response.locals.params.patientId,
    );
    return response.json(patient);
  } catch (error) {
    if (error instanceof appointmentService.AppointmentError) {
      return response.status(error.status).json({ error: { code: error.code, message: error.message } });
    }
    return next(error);
  }
}

async function listDoctorPatientAppointments(_request, response, next) {
  try {
    const page = await appointmentService.listDoctorPatientAppointments(
      response.locals.database,
      response.locals.user,
      response.locals.params.patientId,
      response.locals.query,
      response.locals.applicationTimezone,
    );
    return response.json(page);
  } catch (error) {
    if (error instanceof appointmentService.AppointmentError) {
      return response.status(error.status).json({ error: { code: error.code, message: error.message } });
    }
    return next(error);
  }
}

module.exports = { getDoctor, getDoctorPatient, listDoctorPatientAppointments, listDoctors, updateDoctor };
