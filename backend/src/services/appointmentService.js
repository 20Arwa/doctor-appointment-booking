const { localDateTime, slotStartsInFuture } = require("../utils/schedulingTime");

const APPOINTMENT_DETAILS = `
  SELECT a.id, a.status, a.reason, a.cancelled_at,
         a.created_at, a.updated_at, av.id AS availability_id,
         a.scheduled_date::text AS date, a.scheduled_start_time::text AS start_time, a.scheduled_end_time::text AS end_time,
         d.id AS doctor_id, du.first_name AS doctor_first_name, du.last_name AS doctor_last_name,
         d.specialty, p.id AS patient_id, pu.first_name AS patient_first_name,
         pu.last_name AS patient_last_name, pu.email AS patient_email
  FROM appointments a
  JOIN availability av ON av.id = a.availability_id
  JOIN doctors d ON d.id = av.doctor_id
  JOIN users du ON du.id = d.user_id
  JOIN patients p ON p.id = a.patient_id
  JOIN users pu ON pu.id = p.user_id`;

class AppointmentError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function fail(status, code, message) {
  throw new AppointmentError(status, code, message);
}

function timeContext(timeZone) {
  const now = localDateTime(timeZone);
  if (!now) fail(503, "TIMEZONE_NOT_CONFIGURED", "Application timezone is not configured");
  return now;
}

async function withTransaction(database, callback) {
  const client = await database.connect();
  let started = false;
  try {
    await client.query("BEGIN");
    started = true;
    const result = await callback(client);
    await client.query("COMMIT");
    started = false;
    return result;
  } catch (error) {
    if (started) await client.query("ROLLBACK").catch(() => {});
    if (error.code === "23505") {
      fail(409, "SLOT_UNAVAILABLE", "The availability slot is already booked");
    }
    throw error;
  } finally {
    client.release();
  }
}

async function requirePatientId(client, userId) {
  const result = await client.query("SELECT id FROM patients WHERE user_id = $1", [userId]);
  if (!result.rows[0]) fail(403, "PATIENT_PROFILE_REQUIRED", "An existing patient profile is required to book appointments");
  return result.rows[0].id;
}

async function requireOwnDoctorId(database, user) {
  if (user.role !== "doctor") fail(403, "FORBIDDEN", "Only the associated doctor may complete this appointment");
  const result = await database.query("SELECT id FROM doctors WHERE user_id = $1", [user.id]);
  if (!result.rows[0]) fail(403, "DOCTOR_PROFILE_REQUIRED", "An existing doctor profile is required");
  return result.rows[0].id;
}

async function lockBookableSlot(client, availabilityId, now) {
  const result = await client.query(
    `SELECT av.id, av.doctor_id, av.date::text AS date,
            av.start_time::text AS start_time, av.end_time::text AS end_time
     FROM availability av
     JOIN doctors d ON d.id = av.doctor_id
     JOIN users du ON du.id = d.user_id
     WHERE av.id = $1 AND du.is_active = TRUE
     FOR UPDATE OF av`,
    [availabilityId],
  );
  const slot = result.rows[0];
  if (!slot) fail(404, "SLOT_NOT_FOUND", "Availability slot not found");
  if (!slotStartsInFuture(slot, now)) fail(409, "SLOT_UNAVAILABLE", "Availability slot is no longer bookable");
  return slot;
}

async function readDetails(client, appointmentId) {
  const result = await client.query(`${APPOINTMENT_DETAILS} WHERE a.id = $1`, [appointmentId]);
  return result.rows[0];
}

async function listAppointments(database, user, filters) {
  let ownership;
  if (user.role === "patient") {
    ownership = "p.user_id = $1";
  } else {
    ownership = "d.user_id = $1";
  }
  const values = [user.id];
  const where = [ownership];
  if (filters.status) {
    values.push(filters.status);
    where.push(`a.status = $${values.length}`);
  }
  if (filters.from) {
    values.push(filters.from);
    where.push(`av.date >= $${values.length}::date`);
  }
  if (filters.to) {
    values.push(filters.to);
    where.push(`av.date <= $${values.length}::date`);
  }
  const result = await database.query(`${APPOINTMENT_DETAILS} WHERE ${where.join(" AND ")} ORDER BY av.date, av.start_time`, values);
  return result.rows;
}

async function getAppointment(database, user, appointmentId) {
  const ownership = user.role === "patient" ? "p.user_id = $2" : "d.user_id = $2";
  const result = await database.query(`${APPOINTMENT_DETAILS} WHERE a.id = $1 AND ${ownership}`, [appointmentId, user.id]);
  if (!result.rows[0]) fail(404, "APPOINTMENT_NOT_FOUND", "Appointment not found");
  return result.rows[0];
}

async function createAppointment(database, user, timeZone, input) {
  if (user.role !== "patient") fail(403, "FORBIDDEN", "Only patients can book appointments");
  const now = timeContext(timeZone);
  return withTransaction(database, async (client) => {
    const patientId = await requirePatientId(client, user.id);
    const slot = await lockBookableSlot(client, input.availability_id, now);
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [slot.doctor_id]);
    const overlap = await client.query(
      `SELECT 1 FROM appointments other JOIN availability other_av ON other_av.id = other.availability_id
       WHERE other_av.doctor_id = $1 AND other.status = 'confirmed' AND other_av.date = $2::date
         AND other_av.start_time < $4::time AND other_av.end_time > $3::time LIMIT 1`,
      [slot.doctor_id, slot.date, slot.start_time, slot.end_time],
    );
    if (overlap.rows[0]) fail(409, "SLOT_UNAVAILABLE", "The selected time overlaps another confirmed appointment");
    const created = await client.query(
      `INSERT INTO appointments (patient_id, availability_id, status, reason, scheduled_date, scheduled_start_time, scheduled_end_time)
       VALUES ($1, $2, 'confirmed', $3, $4::date, $5::time, $6::time) RETURNING id`,
      [patientId, input.availability_id, input.reason ?? null, slot.date, slot.start_time, slot.end_time],
    );
    return readDetails(client, created.rows[0].id);
  });
}

async function cancelAppointment(database, user, appointmentId) {
  if (user.role !== "patient") fail(403, "FORBIDDEN", "Only the owning patient may cancel this appointment");
  return withTransaction(database, async (client) => {
    const owned = await client.query(
      `SELECT a.id, a.status
       FROM appointments a JOIN patients p ON p.id = a.patient_id
       WHERE a.id = $1 AND p.user_id = $2
       FOR UPDATE OF a`,
      [appointmentId, user.id],
    );
    if (!owned.rows[0]) fail(404, "APPOINTMENT_NOT_FOUND", "Appointment not found");
    if (owned.rows[0].status !== "confirmed") fail(409, "APPOINTMENT_STATE_CONFLICT", "Only confirmed appointments can be cancelled");
    await client.query(
      "UPDATE appointments SET status = 'cancelled', cancelled_at = NOW(), updated_at = NOW() WHERE id = $1",
      [appointmentId],
    );
    return readDetails(client, appointmentId);
  });
}

async function rescheduleAppointment(database, user, timeZone, appointmentId, newAvailabilityId) {
  if (user.role !== "patient") fail(403, "FORBIDDEN", "Only the owning patient may reschedule this appointment");
  const now = timeContext(timeZone);
  return withTransaction(database, async (client) => {
    const owned = await client.query(
      `SELECT a.id, a.status, a.availability_id, a.patient_id, a.reason
       FROM appointments a JOIN patients p ON p.id = a.patient_id
       WHERE a.id = $1 AND p.user_id = $2
       FOR UPDATE OF a`,
      [appointmentId, user.id],
    );
    const original = owned.rows[0];
    if (!original) fail(404, "APPOINTMENT_NOT_FOUND", "Appointment not found");
    if (original.status !== "confirmed") fail(409, "APPOINTMENT_STATE_CONFLICT", "Only confirmed appointments can be rescheduled");
    if (original.availability_id === newAvailabilityId) fail(409, "SLOT_UNAVAILABLE", "Choose a different availability slot");
    const previousAppointment = await readDetails(client, appointmentId);

    const slot = await lockBookableSlot(client, newAvailabilityId, now);
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [slot.doctor_id]);
    const conflict = await client.query(
      `SELECT 1 FROM appointments other JOIN availability other_av ON other_av.id = other.availability_id
       WHERE other_av.doctor_id = $1 AND other.status = 'confirmed' AND other_av.date = $2::date
         AND other_av.start_time < $4::time AND other_av.end_time > $3::time LIMIT 1`,
      [slot.doctor_id, slot.date, slot.start_time, slot.end_time],
    );
    if (conflict.rows[0]) fail(409, "SLOT_UNAVAILABLE", "The selected time overlaps another confirmed appointment");
    await client.query(
      "UPDATE appointments SET status = 'cancelled', cancelled_at = NOW(), updated_at = NOW() WHERE id = $1",
      [appointmentId],
    );
    const created = await client.query(
      `INSERT INTO appointments (patient_id, availability_id, status, reason, scheduled_date, scheduled_start_time, scheduled_end_time)
       VALUES ($1, $2, 'confirmed', $3, $4::date, $5::time, $6::time) RETURNING id`,
      [original.patient_id, newAvailabilityId, original.reason, slot.date, slot.start_time, slot.end_time],
    );
    const appointment = await readDetails(client, created.rows[0].id);
    return { ...appointment, previous_date: previousAppointment.date, previous_start_time: previousAppointment.start_time };
  });
}

async function doctorRescheduleAppointment(database, user, timeZone, appointmentId, input) {
  const doctorId = await requireOwnDoctorId(database, user);
  const now = timeContext(timeZone);
  if (!slotStartsInFuture({ date: input.date, start_time: input.start_time }, now)) {
    fail(409, "APPOINTMENT_TIME_NOT_FUTURE", "The new appointment time must be in the future");
  }
  return withTransaction(database, async (client) => {
    const owned = await client.query(
      `SELECT a.id, a.status, a.availability_id, a.scheduled_date::text AS date,
              a.scheduled_start_time::text AS start_time, a.scheduled_end_time::text AS end_time
       FROM appointments a JOIN availability av ON av.id = a.availability_id
       WHERE a.id = $1 AND av.doctor_id = $2 FOR UPDATE OF a`,
      [appointmentId, doctorId],
    );
    const original = owned.rows[0];
    if (!original) fail(404, "APPOINTMENT_NOT_FOUND", "Appointment not found");
    if (original.status !== "confirmed") fail(409, "APPOINTMENT_STATE_CONFLICT", "Only confirmed appointments can be rescheduled");
    if (original.date === input.date && original.start_time.slice(0, 5) === input.start_time) {
      fail(409, "APPOINTMENT_TIME_UNCHANGED", "Choose a different appointment date or time");
    }
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [doctorId]);
    const conflict = await client.query(
      `SELECT 1 FROM appointments other
       JOIN availability other_av ON other_av.id = other.availability_id
       WHERE other_av.doctor_id = $1 AND other.id <> $2 AND other.status = 'confirmed'
         AND other.scheduled_date = $3::date
         AND other.scheduled_start_time < $5::time
         AND other.scheduled_end_time > $4::time LIMIT 1`,
      [doctorId, appointmentId, input.date, input.start_time, input.end_time],
    );
    if (conflict.rows[0]) fail(409, "DOCTOR_TIME_CONFLICT", "The selected time overlaps another confirmed appointment");
    const targetSlot = await client.query(
      `SELECT id FROM availability
       WHERE doctor_id = $1 AND date = $2::date AND start_time = $3::time AND end_time = $4::time`,
      [doctorId, input.date, input.start_time, input.end_time],
    );
    const availabilityId = targetSlot.rows[0]?.id ?? original.availability_id;
    const updated = await client.query(
      `UPDATE appointments SET availability_id = $2, scheduled_date = $3::date,
       scheduled_start_time = $4::time, scheduled_end_time = $5::time,
       updated_at = NOW() WHERE id = $1 RETURNING id`,
      [appointmentId, availabilityId, input.date, input.start_time, input.end_time],
    );
    const appointment = await readDetails(client, updated.rows[0].id);
    return { ...appointment, previous_date: original.date, previous_start_time: original.start_time };
  });
}

async function completeAppointment(database, user, appointmentId) {
  const doctorId = await requireOwnDoctorId(database, user);
  return withTransaction(database, async (client) => {
    const owned = await client.query(
      `SELECT a.id, a.status
       FROM appointments a
       JOIN availability av ON av.id = a.availability_id
       WHERE a.id = $1 AND av.doctor_id = $2
       FOR UPDATE OF a`,
      [appointmentId, doctorId],
    );
    if (!owned.rows[0]) fail(404, "APPOINTMENT_NOT_FOUND", "Appointment not found");
    if (owned.rows[0].status !== "confirmed") fail(409, "APPOINTMENT_STATE_CONFLICT", "Only confirmed appointments can be completed");
    await client.query("UPDATE appointments SET status = 'completed', updated_at = NOW() WHERE id = $1", [appointmentId]);
    return readDetails(client, appointmentId);
  });
}

module.exports = {
  AppointmentError,
  cancelAppointment,
  completeAppointment,
  createAppointment,
  doctorRescheduleAppointment,
  getAppointment,
  listAppointments,
  rescheduleAppointment,
};
