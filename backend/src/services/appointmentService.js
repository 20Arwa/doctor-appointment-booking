const { localDateTime, slotStartsInFuture } = require("../utils/schedulingTime");

const APPOINTMENT_DETAILS = `
  SELECT a.id, a.status, a.reason, a.cancelled_at,
         a.created_at, a.updated_at, av.id AS availability_id,
         a.scheduled_date::text AS date, a.scheduled_start_time::text AS start_time, a.scheduled_end_time::text AS end_time,
         d.id AS doctor_id, du.first_name AS doctor_first_name, du.last_name AS doctor_last_name,
         d.specialty, p.id AS patient_id, pu.first_name AS patient_first_name,
         pu.last_name AS patient_last_name, pu.email AS patient_email,
         p.date_of_birth::text AS patient_date_of_birth, p.gender AS patient_gender,
         a.consultation_fee::text AS consultation_fee,
         CASE WHEN a.consultation_fee IS NULL THEN NULL ELSE 'INR' END AS consultation_currency
  FROM appointments a
  JOIN availability av ON av.id = a.availability_id
  JOIN doctors d ON d.id = av.doctor_id
  JOIN users du ON du.id = d.user_id
  JOIN patients p ON p.id = a.patient_id
  JOIN users pu ON pu.id = p.user_id
  `;

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

async function requireOwnDoctorId(database, user) {
  if (user.role !== "doctor") fail(403, "FORBIDDEN", "Only the associated doctor may complete this appointment");
  const result = await database.query("SELECT id FROM doctors WHERE user_id = $1", [user.id]);
  if (!result.rows[0]) fail(403, "DOCTOR_PROFILE_REQUIRED", "An existing doctor profile is required");
  return result.rows[0].id;
}

async function lockBookableSlot(client, availabilityId, now) {
  const result = await client.query(
    `SELECT av.id, av.doctor_id, av.deleted_at, av.date::text AS date,
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
  if (slot.deleted_at) fail(409, "SLOT_UNAVAILABLE", "Availability slot is no longer bookable");
  if (!slotStartsInFuture(slot, now)) fail(409, "SLOT_UNAVAILABLE", "Availability slot is no longer bookable");
  return slot;
}

async function ensureNoActivePaymentHold(client, doctorId, date, startTime, endTime, excludedHoldId = null) {
  const held = await client.query(
    `SELECT 1 FROM appointment_slot_holds h
     JOIN availability av ON av.id = h.availability_id
     WHERE av.doctor_id = $1 AND av.date = $2::date
       AND av.start_time < $4::time AND av.end_time > $3::time
       AND h.status = 'active' AND h.expires_at > NOW()
       AND ($5::uuid IS NULL OR h.id <> $5) LIMIT 1`,
    [doctorId, date, startTime, endTime, excludedHoldId],
  );
  if (held.rows[0]) fail(409, "SLOT_UNAVAILABLE", "The selected time is temporarily reserved for payment");
}

async function createPaymentAppointment(client, { availabilityId, patientId, reason, holdId, consultationFee, timeZone }) {
  const slot = await lockBookableSlot(client, availabilityId, timeContext(timeZone));
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [slot.doctor_id]);
  await ensureNoActivePaymentHold(client, slot.doctor_id, slot.date, slot.start_time, slot.end_time, holdId);
  const conflict = await client.query(
    `SELECT 1 FROM appointments other
     JOIN availability other_av ON other_av.id = other.availability_id
     WHERE other_av.doctor_id = $1 AND other.status = 'confirmed'
       AND other.scheduled_date = $2::date
       AND other.scheduled_start_time < $4::time
       AND other.scheduled_end_time > $3::time LIMIT 1`,
    [slot.doctor_id, slot.date, slot.start_time, slot.end_time],
  );
  if (conflict.rows[0]) fail(409, "SLOT_UNAVAILABLE", "The selected time overlaps another confirmed appointment");
  const created = await client.query(
    `INSERT INTO appointments (patient_id, availability_id, status, reason, scheduled_date, scheduled_start_time, scheduled_end_time, consultation_fee)
     VALUES ($1, $2, 'confirmed', $3, $4::date, $5::time, $6::time, $7::numeric) RETURNING id`,
    [patientId, availabilityId, reason, slot.date, slot.start_time, slot.end_time, consultationFee],
  );
  return readDetails(client, created.rows[0].id);
}

async function readDetails(client, appointmentId) {
  const result = await client.query(`${APPOINTMENT_DETAILS} WHERE a.id = $1`, [appointmentId]);
  return result.rows[0];
}

async function listAppointments(database, user, filters, timeZone = "Asia/Kolkata") {
  let ownership;
  if (user.role === "patient") {
    ownership = "p.user_id = $1";
  } else {
    ownership = "d.user_id = $1";
  }
  const values = [user.id];
  const where = [ownership];
  if (filters.view === "upcoming") {
    values.push(timeZone);
    where.push(`a.status = 'confirmed' AND ((a.scheduled_date + a.scheduled_end_time) AT TIME ZONE $${values.length}) > NOW()`);
  } else if (filters.view === "past") {
    values.push(timeZone);
    where.push(`(a.status = 'completed' OR (a.status = 'confirmed' AND ((a.scheduled_date + a.scheduled_end_time) AT TIME ZONE $${values.length}) <= NOW()))`);
  } else if (filters.view === "cancelled") {
    where.push("a.status = 'cancelled'");
  }
  if (filters.status) {
    values.push(filters.status);
    where.push(`a.status = $${values.length}`);
  }
  if (filters.from) {
    values.push(filters.from);
    where.push(`a.scheduled_date >= $${values.length}::date`);
  }
  if (filters.to) {
    values.push(filters.to);
    where.push(`a.scheduled_date <= $${values.length}::date`);
  }
  const order = filters.view === "past" || filters.view === "cancelled"
    ? "a.scheduled_date DESC, a.scheduled_start_time DESC, a.id DESC"
    : "a.scheduled_date, a.scheduled_start_time, a.id";
  let pagination = "";
  if (filters.limit !== undefined) {
    values.push(filters.limit + 1, filters.offset ?? 0);
    pagination = ` LIMIT $${values.length - 1} OFFSET $${values.length}`;
  }
  const result = await database.query(`${APPOINTMENT_DETAILS} WHERE ${where.join(" AND ")} ORDER BY ${order}${pagination}`, values);
  if (filters.limit === undefined) return result.rows;
  const items = result.rows.slice(0, filters.limit);
  const hasMore = result.rows.length > filters.limit;
  return { items, has_more: hasMore, next_offset: (filters.offset ?? 0) + items.length };
}

async function requireDoctorPatientRelationship(database, user, patientId) {
  if (user.role !== "doctor") fail(403, "FORBIDDEN", "Only doctors may view patient details");
  const result = await database.query(
    `SELECT 1
     FROM appointments a
     JOIN availability av ON av.id = a.availability_id
     JOIN doctors d ON d.id = av.doctor_id
     WHERE d.user_id = $1 AND a.patient_id = $2
     LIMIT 1`,
    [user.id, patientId],
  );
  if (!result.rows[0]) fail(404, "PATIENT_NOT_FOUND", "Patient not found for this doctor");
}

async function getDoctorPatient(database, user, patientId) {
  if (user.role !== "doctor") fail(403, "FORBIDDEN", "Only doctors may view patient details");
  const result = await database.query(
    `SELECT pu.first_name, pu.last_name, pu.email, pu.phone,
            p.date_of_birth::text AS date_of_birth, p.gender
     FROM patients p
     JOIN users pu ON pu.id = p.user_id
     WHERE p.id = $1
       AND EXISTS (
         SELECT 1
         FROM appointments a
         JOIN availability av ON av.id = a.availability_id
         JOIN doctors d ON d.id = av.doctor_id
         WHERE a.patient_id = p.id AND d.user_id = $2
       )`,
    [patientId, user.id],
  );
  if (!result.rows[0]) fail(404, "PATIENT_NOT_FOUND", "Patient not found for this doctor");
  return result.rows[0];
}

async function listDoctorPatientAppointments(database, user, patientId, filters, timeZone = "Asia/Kolkata") {
  await requireDoctorPatientRelationship(database, user, patientId);
  const values = [user.id, patientId];
  const where = ["d.user_id = $1", "p.id = $2"];
  if (filters.view === "scheduled") {
    values.push(timeZone);
    where.push(`a.status = 'confirmed' AND ((a.scheduled_date + a.scheduled_end_time) AT TIME ZONE $${values.length}) > NOW()`);
  } else if (filters.view === "past") {
    values.push(timeZone);
    where.push(`(a.status = 'completed' OR (a.status = 'confirmed' AND ((a.scheduled_date + a.scheduled_end_time) AT TIME ZONE $${values.length}) <= NOW()))`);
  } else {
    where.push("a.status = 'cancelled'");
  }

  values.push(filters.limit + 1, filters.offset ?? 0);
  const result = await database.query(
    `SELECT a.id, a.status, a.reason, a.cancelled_at, a.created_at, a.updated_at,
            av.id AS availability_id,
            a.scheduled_date::text AS date, a.scheduled_start_time::text AS start_time,
            a.scheduled_end_time::text AS end_time,
            d.id AS doctor_id, du.first_name AS doctor_first_name, du.last_name AS doctor_last_name,
            d.specialty, p.id AS patient_id, pu.first_name AS patient_first_name,
            pu.last_name AS patient_last_name, p.date_of_birth::text AS patient_date_of_birth,
            p.gender AS patient_gender, a.consultation_fee::text AS consultation_fee,
            CASE WHEN a.consultation_fee IS NULL THEN NULL ELSE 'INR' END AS consultation_currency
     FROM appointments a
     JOIN availability av ON av.id = a.availability_id
     JOIN doctors d ON d.id = av.doctor_id
     JOIN users du ON du.id = d.user_id
     JOIN patients p ON p.id = a.patient_id
     JOIN users pu ON pu.id = p.user_id
     WHERE ${where.join(" AND ")}
     ORDER BY a.scheduled_date DESC, a.scheduled_start_time DESC, a.id DESC
     LIMIT $${values.length - 1} OFFSET $${values.length}`,
    values,
  );
  const items = result.rows.slice(0, filters.limit);
  return {
    items,
    has_more: result.rows.length > filters.limit,
    next_offset: (filters.offset ?? 0) + items.length,
  };
}

async function getAppointment(database, user, appointmentId) {
  const ownership = user.role === "patient" ? "p.user_id = $2" : "d.user_id = $2";
  const result = await database.query(`${APPOINTMENT_DETAILS} WHERE a.id = $1 AND ${ownership}`, [appointmentId, user.id]);
  if (!result.rows[0]) fail(404, "APPOINTMENT_NOT_FOUND", "Appointment not found");
  return result.rows[0];
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
      `SELECT a.id, a.status, a.availability_id, a.patient_id, a.reason, a.consultation_fee
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
    await ensureNoActivePaymentHold(client, slot.doctor_id, slot.date, slot.start_time, slot.end_time);
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
      `INSERT INTO appointments (patient_id, availability_id, status, reason, scheduled_date, scheduled_start_time, scheduled_end_time, consultation_fee)
       VALUES ($1, $2, 'confirmed', $3, $4::date, $5::time, $6::time, $7::numeric) RETURNING id`,
      [original.patient_id, newAvailabilityId, original.reason, slot.date, slot.start_time, slot.end_time, original.consultation_fee],
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
    await ensureNoActivePaymentHold(client, doctorId, input.date, input.start_time, input.end_time);
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
      `SELECT id, deleted_at FROM availability
       WHERE doctor_id = $1 AND date = $2::date AND start_time = $3::time AND end_time = $4::time`,
      [doctorId, input.date, input.start_time, input.end_time],
    );
    if (targetSlot.rows[0]?.deleted_at) fail(409, "SLOT_UNAVAILABLE", "The selected availability slot has been removed");
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
  createPaymentAppointment,
  doctorRescheduleAppointment,
  getAppointment,
  listAppointments,
  getDoctorPatient,
  listDoctorPatientAppointments,
  readAppointmentDetails: readDetails,
  rescheduleAppointment,
};
