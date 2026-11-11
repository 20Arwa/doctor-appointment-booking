const { localDateTime, slotStartsInFuture } = require("../utils/schedulingTime");

const APPOINTMENT_DETAILS = `
  SELECT a.id, a.status, a.reason, a.cancelled_at,
         a.created_at, a.updated_at, av.id AS availability_id, av.mode,
         a.scheduled_date::text AS date, a.scheduled_start_time::text AS start_time, a.scheduled_end_time::text AS end_time,
         d.id AS doctor_id, du.first_name AS doctor_first_name, du.last_name AS doctor_last_name,
         d.specialty, d.appointment_duration_minutes, d.user_id AS doctor_user_id, du.email AS doctor_email,
         p.id AS patient_id, p.user_id AS patient_user_id, pu.first_name AS patient_first_name,
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
      fail(409, "SLOT_CAPACITY_REACHED", "The selected availability option has reached its booking capacity");
    }
    if (error.code === "23514" && error.constraint === "appointment_allocation_capacity") {
      fail(409, "SLOT_CAPACITY_REACHED", "The selected availability option has reached its booking capacity");
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

async function lockBookableSlot(client, availabilityId, now, { allowDeleted = false } = {}) {
  const result = await client.query(
    `SELECT av.id, av.doctor_id, av.deleted_at, av.booking_visibility, av.date::text AS date,
            av.start_time::text AS start_time, av.end_time::text AS end_time,
            av.mode, av.capacity
     FROM availability av
     JOIN doctors d ON d.id = av.doctor_id
     JOIN users du ON du.id = d.user_id
     WHERE av.id = $1 AND du.is_active = TRUE
     FOR UPDATE OF av`,
    [availabilityId],
  );
  const slot = result.rows[0];
  if (!slot) fail(404, "SLOT_NOT_FOUND", "Availability slot not found");
  if (slot.deleted_at && !allowDeleted) fail(409, "SLOT_UNAVAILABLE", "Availability slot is no longer bookable");
  if (!slotStartsInFuture(slot, now)) fail(409, "SLOT_UNAVAILABLE", "Availability slot is no longer bookable");
  return slot;
}

async function lockAvailabilityRowsAndDoctors(client, availabilityIds) {
  const ids = [...new Set(availabilityIds)].sort();
  const locked = await client.query(
    `SELECT id, doctor_id FROM availability
     WHERE id = ANY($1::uuid[])
     ORDER BY id
     FOR UPDATE`, [ids],
  );
  if (locked.rows.length !== ids.length) fail(404, "SLOT_NOT_FOUND", "Availability slot not found");
  const doctorIds = [...new Set(locked.rows.map((row) => row.doctor_id))].sort();
  for (const doctorId of doctorIds) {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [doctorId]);
  }
  return new Map(locked.rows.map((row) => [row.id, row.doctor_id]));
}

async function countOccupiedPlaces(client, availabilityId, { excludedAppointmentId = null, excludedAllocationId = null, excludedHoldId = null } = {}) {
  const result = await client.query(
    `SELECT COUNT(DISTINCT reservation.patient_id)::int AS occupied
     FROM (
       SELECT allocation.patient_id FROM appointment_allocations allocation
       WHERE allocation.availability_id = $1
         AND ((allocation.status = 'held' AND allocation.expires_at > NOW())
           OR (allocation.status = 'confirmed' AND (EXISTS (SELECT 1 FROM appointments linked
             WHERE linked.allocation_id = allocation.id AND linked.status = 'confirmed') OR NOT EXISTS
             (SELECT 1 FROM appointments linked WHERE linked.allocation_id = allocation.id))))
         AND allocation.id IS DISTINCT FROM $2::uuid
       UNION
       SELECT appointment.patient_id FROM appointments appointment
       WHERE appointment.availability_id = $1 AND appointment.status = 'confirmed'
         AND appointment.id IS DISTINCT FROM $3::uuid
         AND NOT EXISTS (
           SELECT 1 FROM appointment_allocations allocation
           WHERE allocation.id = appointment.allocation_id AND allocation.availability_id = $1
             AND ((allocation.status = 'held' AND allocation.expires_at > NOW())
               OR (allocation.status = 'confirmed' AND (EXISTS (SELECT 1 FROM appointments linked
                 WHERE linked.allocation_id = allocation.id AND linked.status = 'confirmed') OR NOT EXISTS
                 (SELECT 1 FROM appointments linked WHERE linked.allocation_id = allocation.id))))
             AND allocation.id IS DISTINCT FROM $2::uuid
         )
       UNION
       SELECT hold.patient_id FROM appointment_slot_holds hold
       WHERE hold.availability_id = $1 AND hold.status = 'active' AND hold.expires_at > NOW()
         AND hold.id IS DISTINCT FROM $4::uuid
     ) reservation`, [availabilityId, excludedAllocationId, excludedAppointmentId, excludedHoldId],
  );
  return Number(result.rows[0]?.occupied || 0);
}

async function countOccupiedPlacesForSlots(client, availabilityIds) {
  const ids = [...new Set(availabilityIds)];
  if (!ids.length) return new Map();
  const result = await client.query(
    `SELECT reservation.availability_id,
            COUNT(DISTINCT reservation.patient_id)::int AS occupied
     FROM (
       SELECT allocation.availability_id, allocation.patient_id
       FROM appointment_allocations allocation
       WHERE allocation.availability_id = ANY($1::uuid[])
         AND ((allocation.status = 'held' AND allocation.expires_at > NOW())
           OR (allocation.status = 'confirmed' AND (EXISTS (SELECT 1 FROM appointments linked
             WHERE linked.allocation_id = allocation.id AND linked.status = 'confirmed') OR NOT EXISTS
             (SELECT 1 FROM appointments linked WHERE linked.allocation_id = allocation.id))))
       UNION
       SELECT appointment.availability_id, appointment.patient_id
       FROM appointments appointment
       WHERE appointment.availability_id = ANY($1::uuid[]) AND appointment.status = 'confirmed'
         AND NOT EXISTS (
           SELECT 1 FROM appointment_allocations allocation
           WHERE allocation.id = appointment.allocation_id
             AND allocation.availability_id = appointment.availability_id
             AND ((allocation.status = 'held' AND allocation.expires_at > NOW())
               OR (allocation.status = 'confirmed' AND (EXISTS (SELECT 1 FROM appointments linked
                 WHERE linked.allocation_id = allocation.id AND linked.status = 'confirmed') OR NOT EXISTS
                 (SELECT 1 FROM appointments linked WHERE linked.allocation_id = allocation.id))))
         )
       UNION
       SELECT hold.availability_id, hold.patient_id
       FROM appointment_slot_holds hold
       WHERE hold.availability_id = ANY($1::uuid[])
         AND hold.status = 'active' AND hold.expires_at > NOW()
     ) reservation
     GROUP BY reservation.availability_id`,
    [ids],
  );
  return new Map(result.rows.map((row) => [row.availability_id, Number(row.occupied)]));
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
  const grandfatheredHold = holdId ? await client.query(
    `SELECT 1 FROM appointment_slot_holds
     WHERE id = $1 AND availability_id = $2 AND status = 'consumed'`, [holdId, availabilityId],
  ) : { rows: [] };
  const slot = await lockBookableSlot(client, availabilityId, timeContext(timeZone), { allowDeleted: Boolean(grandfatheredHold.rows[0]) });
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [slot.doctor_id]);
  const occupied = await countOccupiedPlaces(client, availabilityId, { excludedHoldId: holdId });
  if (occupied >= Number(slot.capacity || 1)) {
    fail(409, "SLOT_CAPACITY_REACHED", "The selected availability option has reached its booking capacity");
  }
  if (!slot.mode) {
    await ensureNoActivePaymentHold(client, slot.doctor_id, slot.date, slot.start_time, slot.end_time, holdId);
    const conflict = await client.query(
      `SELECT 1 FROM appointments other JOIN availability other_av ON other_av.id = other.availability_id
       WHERE other_av.doctor_id = $1 AND other.status = 'confirmed' AND other.scheduled_date = $2::date
         AND other.scheduled_start_time < $4::time AND other.scheduled_end_time > $3::time LIMIT 1`,
      [slot.doctor_id, slot.date, slot.start_time, slot.end_time],
    );
    if (conflict.rows[0]) fail(409, "SLOT_UNAVAILABLE", "The selected time overlaps another confirmed appointment");
  }
  let allocation = { rows: [{ id: null }] };
  if (slot.mode) {
    try {
      allocation = await client.query(
        `INSERT INTO appointment_allocations (availability_id, mode, patient_id, status)
         VALUES ($1, $2, $3, 'confirmed') RETURNING id`, [availabilityId, slot.mode, patientId],
      );
    } catch (error) {
      if (error.code === "23514" && error.constraint === "appointment_allocation_capacity") {
        fail(409, "SLOT_CAPACITY_REACHED", "The selected availability option has reached its booking capacity");
      }
      throw error;
    }
  }
  const created = await client.query(
    `INSERT INTO appointments (patient_id, availability_id, allocation_id, status, reason, scheduled_date, scheduled_start_time, scheduled_end_time, consultation_fee)
     VALUES ($1, $2, $3, 'confirmed', $4, $5::date, $6::time, $7::time, $8::numeric) RETURNING id`,
    [patientId, availabilityId, allocation.rows[0].id, reason, slot.date, slot.start_time, slot.end_time, consultationFee],
  );
  const appointment = await readDetails(client, created.rows[0].id);
  return appointment;
}

async function readDetails(client, appointmentId) {
  const result = await client.query(`${APPOINTMENT_DETAILS} WHERE a.id = $1`, [appointmentId]);
  return result.rows[0];
}

async function readAcceptedAssistedAppointment(client, appointmentId, suggestion, { requestId, suggestionId }) {
  const appointment = await readDetails(client, appointmentId);
  const matchesSuggestion = appointment
    && appointment.availability_id === suggestion.availability_id
    && appointment.mode === suggestion.mode
    && appointment.date === suggestion.date
    && appointment.start_time?.slice(0, 8) === suggestion.start_time?.slice(0, 8)
    && appointment.end_time?.slice(0, 8) === suggestion.end_time?.slice(0, 8);
  if (!matchesSuggestion) {
    fail(409, "ASSISTED_RESCHEDULE_ACCEPTED_STATE_CONFLICT", "This request is marked accepted, but the appointment does not match its confirmed suggestion. Contact support before trying again.");
  }
  return appointment;
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
            av.id AS availability_id, av.mode,
            a.scheduled_date::text AS date, a.scheduled_start_time::text AS start_time,
            a.scheduled_end_time::text AS end_time,
            d.id AS doctor_id, du.first_name AS doctor_first_name, du.last_name AS doctor_last_name,
            d.specialty, d.appointment_duration_minutes, p.id AS patient_id, pu.first_name AS patient_first_name,
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
    const initial = await client.query(
      `SELECT a.availability_id FROM appointments a JOIN patients p ON p.id = a.patient_id
       WHERE a.id = $1 AND p.user_id = $2`, [appointmentId, user.id],
    );
    if (!initial.rows[0]) fail(404, "APPOINTMENT_NOT_FOUND", "Appointment not found");
    await lockAvailabilityRowsAndDoctors(client, [initial.rows[0].availability_id]);
    const owned = await client.query(
      `SELECT a.id, a.status, a.availability_id
       FROM appointments a JOIN patients p ON p.id = a.patient_id
       WHERE a.id = $1 AND p.user_id = $2
       FOR UPDATE OF a`,
      [appointmentId, user.id],
    );
    if (!owned.rows[0]) fail(404, "APPOINTMENT_NOT_FOUND", "Appointment not found");
    if (owned.rows[0].availability_id !== initial.rows[0].availability_id) fail(409, "APPOINTMENT_CHANGED", "The appointment changed; retry cancellation");
    if (owned.rows[0].status !== "confirmed") fail(409, "APPOINTMENT_STATE_CONFLICT", "Only confirmed appointments can be cancelled");
    await client.query(
      "UPDATE appointments SET status = 'cancelled', cancelled_at = NOW(), updated_at = NOW() WHERE id = $1",
      [appointmentId],
    );
    await client.query("UPDATE appointment_allocations SET status = 'released', updated_at = NOW() WHERE id = (SELECT allocation_id FROM appointments WHERE id = $1) AND status = 'confirmed'", [appointmentId]);
    await supersedeOpenAssistedRescheduleRequests(client, appointmentId);
    const appointment = await readDetails(client, appointmentId);
    return appointment;
  });
}

async function rescheduleAppointment(database, user, timeZone, appointmentId, newAvailabilityId) {
  if (user.role !== "patient") fail(403, "FORBIDDEN", "Only the owning patient may reschedule this appointment");
  const now = timeContext(timeZone);
  return withTransaction(database, async (client) => {
    const initial = await client.query(
      `SELECT a.availability_id FROM appointments a JOIN patients p ON p.id = a.patient_id
       WHERE a.id = $1 AND p.user_id = $2`, [appointmentId, user.id],
    );
    if (!initial.rows[0]) fail(404, "APPOINTMENT_NOT_FOUND", "Appointment not found");
    await lockAvailabilityRowsAndDoctors(client, [initial.rows[0].availability_id, newAvailabilityId]);
    const owned = await client.query(
      `SELECT a.id, a.status, a.availability_id, a.allocation_id, a.patient_id, a.reason, a.consultation_fee
       FROM appointments a JOIN patients p ON p.id = a.patient_id
       WHERE a.id = $1 AND p.user_id = $2
       FOR UPDATE OF a`,
      [appointmentId, user.id],
    );
    const original = owned.rows[0];
    if (!original) fail(404, "APPOINTMENT_NOT_FOUND", "Appointment not found");
    if (original.availability_id !== initial.rows[0].availability_id) fail(409, "APPOINTMENT_CHANGED", "The appointment changed; retry rescheduling");
    if (original.status !== "confirmed") fail(409, "APPOINTMENT_STATE_CONFLICT", "Only confirmed appointments can be rescheduled");
    if (original.availability_id === newAvailabilityId) fail(409, "SLOT_UNAVAILABLE", "Choose a different availability slot");
    const previousAppointment = await readDetails(client, appointmentId);

    const slot = await lockBookableSlot(client, newAvailabilityId, now);
    if (!slot.mode) await ensureNoActivePaymentHold(client, slot.doctor_id, slot.date, slot.start_time, slot.end_time);
    const conflict = slot.mode ? { rows: [] } : await client.query(
      `SELECT 1 FROM appointments other JOIN availability other_av ON other_av.id = other.availability_id
       WHERE other_av.doctor_id = $1 AND other.status = 'confirmed' AND other_av.date = $2::date
         AND other_av.start_time < $4::time AND other_av.end_time > $3::time LIMIT 1`,
      [slot.doctor_id, slot.date, slot.start_time, slot.end_time],
    );
    if (conflict.rows[0]) fail(409, "SLOT_UNAVAILABLE", "The selected time overlaps another confirmed appointment");
    const occupied = await countOccupiedPlaces(client, newAvailabilityId, { excludedAllocationId: original.allocation_id });
    if (occupied >= Number(slot.capacity || 1)) fail(409, "SLOT_CAPACITY_REACHED", "The selected availability option has reached its booking capacity");
    const newAllocation = slot.mode ? await client.query(
      "INSERT INTO appointment_allocations (availability_id, mode, patient_id, status) VALUES ($1,$2,$3,'confirmed') RETURNING id",
      [newAvailabilityId, slot.mode, original.patient_id],
    ) : { rows: [{ id: null }] };
    await client.query(
      "UPDATE appointments SET status = 'cancelled', cancelled_at = NOW(), updated_at = NOW() WHERE id = $1",
      [appointmentId],
    );
    const created = await client.query(
      `INSERT INTO appointments (patient_id, availability_id, allocation_id, status, reason, scheduled_date, scheduled_start_time, scheduled_end_time, consultation_fee)
       VALUES ($1, $2, $3, 'confirmed', $4, $5::date, $6::time, $7::time, $8::numeric) RETURNING id`,
      [original.patient_id, newAvailabilityId, newAllocation.rows[0].id, original.reason, slot.date, slot.start_time, slot.end_time, original.consultation_fee],
    );
    if (original.allocation_id) await client.query("UPDATE appointment_allocations SET status = 'released', updated_at = NOW() WHERE id = $1 AND status = 'confirmed'", [original.allocation_id]);
    if (original.allocation_id && newAllocation.rows[0].id) await client.query(
      `INSERT INTO appointment_reschedule_history (appointment_id, patient_id, changed_by_user_id, previous_allocation_id, previous_availability_id, previous_date, previous_start_time, previous_end_time, new_allocation_id, new_availability_id, new_date, new_start_time, new_end_time)
       VALUES ($1,$2,$3,$4,$5,$6::date,$7::time,$8::time,$9,$10,$11::date,$12::time,$13::time)`,
      [appointmentId, original.patient_id, user.id, original.allocation_id, original.availability_id, previousAppointment.date, previousAppointment.start_time, previousAppointment.end_time, newAllocation.rows[0].id, newAvailabilityId, slot.date, slot.start_time, slot.end_time],
    );
    await supersedeOpenAssistedRescheduleRequests(client, appointmentId);
    const appointment = await readDetails(client, created.rows[0].id);
    const result = { ...appointment, previous_date: previousAppointment.date, previous_start_time: previousAppointment.start_time };
    return result;
  });
}

async function supersedeOpenAssistedRescheduleRequests(client, appointmentId, exceptRequestId = null) {
  await client.query(
    `UPDATE assisted_reschedule_requests
     SET status = 'superseded',
         notification_status = CASE WHEN notification_status IN ('pending', 'processing', 'failed') THEN 'not_required' ELSE notification_status END,
         notification_next_attempt_at = NULL, notification_lease_token = NULL, notification_lease_expires_at = NULL,
         updated_at = NOW(), responded_at = COALESCE(responded_at, NOW())
     WHERE appointment_id = $1 AND status IN ('pending_patient', 'no_alternatives')
       AND ($2::uuid IS NULL OR id <> $2::uuid)`,
    [appointmentId, exceptRequestId],
  );
}

async function expireAssistedRescheduleRequest(client, requestId) {
  await client.query(
    `UPDATE assisted_reschedule_requests
     SET status = 'expired',
         notification_status = CASE WHEN notification_status IN ('pending', 'processing', 'failed') THEN 'not_required' ELSE notification_status END,
         notification_next_attempt_at = NULL, notification_lease_token = NULL, notification_lease_expires_at = NULL,
         updated_at = NOW(), responded_at = COALESCE(responded_at, NOW())
     WHERE id = $1 AND status IN ('pending_patient', 'no_alternatives')
       AND expires_at <= clock_timestamp()`, [requestId],
  );
}

async function getOwnedAssistedRequest(client, requestId, patientUserId, lock = false) {
  const result = await client.query(
    `SELECT request.id, request.appointment_id, request.doctor_id, request.patient_id,
            request.source_availability_id, request.appointment_updated_at,
            request.mode, request.status, request.selected_availability_id,
            request.expires_at, request.expires_at <= clock_timestamp() AS request_expired,
            appointment.status AS appointment_status, appointment.availability_id AS current_availability_id,
            appointment.allocation_id AS current_allocation_id, appointment.patient_id AS current_patient_id,
            appointment.reason, appointment.consultation_fee,
            appointment.scheduled_date::text AS current_date,
            appointment.scheduled_start_time::text AS current_start_time,
            appointment.scheduled_end_time::text AS current_end_time,
            current_av.mode AS current_mode, current_av.doctor_id AS current_doctor_id,
            (appointment.updated_at = request.appointment_updated_at) AS snapshot_matches
     FROM assisted_reschedule_requests request
     JOIN appointments appointment ON appointment.id = request.appointment_id
     JOIN availability current_av ON current_av.id = appointment.availability_id
     JOIN patients patient ON patient.id = request.patient_id
     WHERE request.id = $1 AND patient.user_id = $2
     ${lock ? "FOR UPDATE OF request, appointment" : ""}`,
    [requestId, patientUserId],
  );
  return result.rows[0];
}

function failForClosedAssistedRequest(request) {
  if (request.status === "declined") {
    fail(409, "ASSISTED_RESCHEDULE_REQUEST_DECLINED", "You declined this assisted rescheduling request");
  }
  if (request.status === "superseded") {
    fail(409, "ASSISTED_RESCHEDULE_REQUEST_SUPERSEDED", "This request was replaced by a newer schedule change");
  }
  if (request.status === "expired" && request.request_expired === true) {
    fail(409, "ASSISTED_RESCHEDULE_REQUEST_EXPIRED", "This assisted rescheduling request has expired");
  }
  fail(409, "ASSISTED_RESCHEDULE_REQUEST_CLOSED", "This assisted rescheduling request is no longer open");
}

async function confirmAssistedReschedule(database, user, timeZone, requestId, suggestionId) {
  if (user.role !== "patient") fail(403, "FORBIDDEN", "Only the owning patient may confirm assisted rescheduling");
  const now = timeContext(timeZone);
  const result = await withTransaction(database, async (client) => {
    const initial = await getOwnedAssistedRequest(client, requestId, user.id);
    if (!initial) fail(404, "ASSISTED_RESCHEDULE_REQUEST_NOT_FOUND", "Assisted rescheduling request not found");
    const suggestionResult = await client.query(
      `SELECT suggestion.id, suggestion.availability_id, suggestion.mode,
              suggestion.service_date::text AS date, suggestion.start_time::text AS start_time,
              suggestion.end_time::text AS end_time
       FROM assisted_reschedule_suggestions suggestion
       WHERE suggestion.id = $1 AND suggestion.request_id = $2`,
      [suggestionId, requestId],
    );
    const suggestion = suggestionResult.rows[0];
    if (!suggestion) fail(404, "ASSISTED_RESCHEDULE_SUGGESTION_NOT_FOUND", "Suggested alternative not found for this request");
    if (initial.status === "accepted") {
      if (initial.selected_availability_id !== suggestion.availability_id) {
        fail(409, "ASSISTED_RESCHEDULE_ALREADY_ACCEPTED", "A different alternative has already been confirmed");
      }
      return readAcceptedAssistedAppointment(client, initial.appointment_id, suggestion, { requestId, suggestionId });
    }
    if (initial.status !== "pending_patient") {
      failForClosedAssistedRequest(initial);
    }
    await lockAvailabilityRowsAndDoctors(client, [initial.current_availability_id, suggestion.availability_id]);
    const request = await getOwnedAssistedRequest(client, requestId, user.id, true);
    if (!request) fail(404, "ASSISTED_RESCHEDULE_REQUEST_NOT_FOUND", "Assisted rescheduling request not found");
    if (request.status === "accepted") {
      if (request.selected_availability_id !== suggestion.availability_id) fail(409, "ASSISTED_RESCHEDULE_ALREADY_ACCEPTED", "A different alternative has already been confirmed");
      return readAcceptedAssistedAppointment(client, request.appointment_id, suggestion, { requestId, suggestionId });
    }
    if (request.status !== "pending_patient") {
      failForClosedAssistedRequest(request);
    }
    if (request.request_expired === true) {
      await expireAssistedRescheduleRequest(client, requestId);
      return { assistedRequestExpired: true };
    }
    if (request.appointment_status !== "confirmed" || !request.snapshot_matches
        || request.current_availability_id !== initial.current_availability_id
        || request.current_patient_id !== request.patient_id
        || request.current_doctor_id !== request.doctor_id || request.current_mode !== request.mode) {
      fail(409, "ASSISTED_RESCHEDULE_REQUEST_STALE", "The appointment changed after this alternative was suggested");
    }
    if (request.current_availability_id === suggestion.availability_id) fail(409, "SLOT_UNAVAILABLE", "Choose a different availability option");
    const slot = await lockBookableSlot(client, suggestion.availability_id, now);
    if (slot.doctor_id !== request.doctor_id || slot.mode !== request.mode || suggestion.mode !== request.mode
        || slot.booking_visibility !== "public" || slot.date !== suggestion.date
        || slot.start_time.slice(0, 5) !== suggestion.start_time.slice(0, 5)
        || slot.end_time.slice(0, 5) !== suggestion.end_time.slice(0, 5)) {
      fail(409, "SLOT_UNAVAILABLE", "The suggested availability has changed and is no longer bookable");
    }
    if (!slotStartsInFuture(slot, now)) fail(409, "SLOT_UNAVAILABLE", "The suggested appointment time has passed");
    if (!request.current_allocation_id) fail(409, "APPOINTMENT_ALLOCATION_MISSING", "The appointment allocation is no longer available for rescheduling");
    const occupied = await countOccupiedPlaces(client, slot.id);
    if (occupied >= Number(slot.capacity || 1)) fail(409, "SLOT_CAPACITY_REACHED", "The selected availability option has reached its booking capacity");
    const accepted = await client.query(
      `UPDATE assisted_reschedule_requests
       SET status = 'accepted', selected_availability_id = $2,
           notification_status = CASE WHEN notification_status IN ('pending', 'processing', 'failed') THEN 'not_required' ELSE notification_status END,
           notification_next_attempt_at = NULL, notification_lease_token = NULL, notification_lease_expires_at = NULL,
           updated_at = NOW(), responded_at = NOW()
       WHERE id = $1 AND status = 'pending_patient' AND expires_at > clock_timestamp()
       RETURNING id`, [requestId, slot.id],
    );
    if (!accepted.rows[0]) {
      const latestResult = await client.query(
        `SELECT status, selected_availability_id, expires_at <= clock_timestamp() AS request_expired
         FROM assisted_reschedule_requests WHERE id = $1 FOR UPDATE`, [requestId],
      );
      const latest = latestResult.rows[0];
      if (!latest) fail(404, "ASSISTED_RESCHEDULE_REQUEST_NOT_FOUND", "Assisted rescheduling request not found");
      if (latest.status === "pending_patient" && latest.request_expired === true) {
        await expireAssistedRescheduleRequest(client, requestId);
        return { assistedRequestExpired: true };
      }
      if (latest.status === "accepted") {
        if (latest.selected_availability_id === suggestion.availability_id) {
          return readAcceptedAssistedAppointment(client, request.appointment_id, suggestion, { requestId, suggestionId });
        }
        fail(409, "ASSISTED_RESCHEDULE_ALREADY_ACCEPTED", "A different alternative has already been confirmed");
      }
      if (latest.status !== "pending_patient") failForClosedAssistedRequest(latest);
      fail(409, "ASSISTED_RESCHEDULE_REQUEST_CONFLICT", "The request changed while confirming. Reload it and try again.");
    }
    const allocation = await client.query(
      `INSERT INTO appointment_allocations (availability_id, mode, patient_id, status)
       VALUES ($1,$2,$3,'confirmed') RETURNING id`, [slot.id, request.mode, request.patient_id],
    );
    const updated = await client.query(
      `UPDATE appointments SET availability_id = $2, allocation_id = $3,
       scheduled_date = $4::date, scheduled_start_time = $5::time, scheduled_end_time = $6::time,
       updated_at = NOW() WHERE id = $1 AND status = 'confirmed' RETURNING id`,
      [request.appointment_id, slot.id, allocation.rows[0].id, slot.date, slot.start_time, slot.end_time],
    );
    if (!updated.rows[0]) fail(409, "APPOINTMENT_STATE_CONFLICT", "Only confirmed appointments can be rescheduled");
    await client.query(
      "UPDATE appointment_allocations SET status = 'released', updated_at = NOW() WHERE id = $1 AND status = 'confirmed'",
      [request.current_allocation_id],
    );
    await client.query(
      `INSERT INTO appointment_reschedule_history (appointment_id, patient_id, changed_by_user_id,
        previous_allocation_id, previous_availability_id, previous_date, previous_start_time, previous_end_time,
        new_allocation_id, new_availability_id, new_date, new_start_time, new_end_time)
       VALUES ($1,$2,$3,$4,$5,$6::date,$7::time,$8::time,$9,$10,$11::date,$12::time,$13::time)`,
      [request.appointment_id, request.patient_id, user.id, request.current_allocation_id,
        request.current_availability_id, request.current_date, request.current_start_time, request.current_end_time,
        allocation.rows[0].id, slot.id, slot.date, slot.start_time, slot.end_time],
    );
    await supersedeOpenAssistedRescheduleRequests(client, request.appointment_id, requestId);
    return readDetails(client, request.appointment_id);
  });
  if (result?.assistedRequestExpired) fail(409, "ASSISTED_RESCHEDULE_REQUEST_EXPIRED", "This assisted rescheduling request has expired");
  return result;
}

async function declineAssistedReschedule(database, user, requestId) {
  if (user.role !== "patient") fail(403, "FORBIDDEN", "Only the owning patient may decline assisted rescheduling");
  const result = await withTransaction(database, async (client) => {
    const initial = await getOwnedAssistedRequest(client, requestId, user.id);
    if (!initial) fail(404, "ASSISTED_RESCHEDULE_REQUEST_NOT_FOUND", "Assisted rescheduling request not found");
    await lockAvailabilityRowsAndDoctors(client, [initial.current_availability_id]);
    const request = await getOwnedAssistedRequest(client, requestId, user.id, true);
    if (!request) fail(404, "ASSISTED_RESCHEDULE_REQUEST_NOT_FOUND", "Assisted rescheduling request not found");
    if (request.status === "declined") return { request_id: requestId, status: "declined", idempotent: true };
    if (request.status !== "pending_patient") fail(409, "ASSISTED_RESCHEDULE_REQUEST_CLOSED", "This assisted rescheduling request is no longer open");
    if (request.request_expired === true) {
      await expireAssistedRescheduleRequest(client, requestId);
      return { assistedRequestExpired: true };
    }
    if (request.appointment_status !== "confirmed" || !request.snapshot_matches) {
      fail(409, "ASSISTED_RESCHEDULE_REQUEST_STALE", "The appointment changed after this request was created");
    }
    const result = await client.query(
      `UPDATE assisted_reschedule_requests SET status = 'declined',
       notification_status = CASE WHEN notification_status IN ('pending', 'processing', 'failed') THEN 'not_required' ELSE notification_status END,
       notification_next_attempt_at = NULL, notification_lease_token = NULL, notification_lease_expires_at = NULL,
       updated_at = NOW(), responded_at = NOW()
       WHERE id = $1 AND status = 'pending_patient' AND expires_at > clock_timestamp() RETURNING id`, [requestId],
    );
    if (!result.rows[0]) fail(409, "ASSISTED_RESCHEDULE_REQUEST_EXPIRED", "This assisted rescheduling request expired before it could be declined");
    return { request_id: requestId, status: "declined" };
  });
  if (result?.assistedRequestExpired) fail(409, "ASSISTED_RESCHEDULE_REQUEST_EXPIRED", "This assisted rescheduling request has expired");
  return result;
}

async function doctorRescheduleAppointment(database, user, timeZone, appointmentId, input) {
  const doctorId = await requireOwnDoctorId(database, user);
  const now = timeContext(timeZone);
  if (!input.availability_id && !slotStartsInFuture({ date: input.date, start_time: input.start_time }, now)) {
    fail(409, "APPOINTMENT_TIME_NOT_FUTURE", "The new appointment time must be in the future");
  }
  return withTransaction(database, async (client) => {
    const initial = await client.query(
      `SELECT a.availability_id FROM appointments a JOIN availability av ON av.id = a.availability_id
       WHERE a.id = $1 AND av.doctor_id = $2`, [appointmentId, doctorId],
    );
    if (!initial.rows[0]) fail(404, "APPOINTMENT_NOT_FOUND", "Appointment not found");
    const targetInitial = input.availability_id
      ? await client.query("SELECT id FROM availability WHERE id = $1 AND doctor_id = $2 AND deleted_at IS NULL", [input.availability_id, doctorId])
      : await client.query(
        `SELECT id FROM availability WHERE doctor_id = $1 AND date = $2::date
         AND start_time = $3::time AND end_time = $4::time AND deleted_at IS NULL`,
        [doctorId, input.date, input.start_time, input.end_time],
      );
    await lockAvailabilityRowsAndDoctors(client, [initial.rows[0].availability_id, ...(targetInitial.rows[0] ? [targetInitial.rows[0].id] : [])]);
    const owned = await client.query(
      `SELECT a.id, a.status, a.availability_id, a.allocation_id, a.patient_id, a.scheduled_date::text AS date,
              a.scheduled_start_time::text AS start_time, a.scheduled_end_time::text AS end_time
       FROM appointments a JOIN availability av ON av.id = a.availability_id
       WHERE a.id = $1 AND av.doctor_id = $2 FOR UPDATE OF a`,
      [appointmentId, doctorId],
    );
    const original = owned.rows[0];
    if (!original) fail(404, "APPOINTMENT_NOT_FOUND", "Appointment not found");
    if (original.availability_id !== initial.rows[0].availability_id) fail(409, "APPOINTMENT_CHANGED", "The appointment changed; retry rescheduling");
    if (original.status !== "confirmed") fail(409, "APPOINTMENT_STATE_CONFLICT", "Only confirmed appointments can be rescheduled");
    if (!input.availability_id && original.date === input.date && original.start_time.slice(0, 5) === input.start_time) {
      fail(409, "APPOINTMENT_TIME_UNCHANGED", "Choose a different appointment date or time");
    }
    const targetSlot = targetInitial.rows[0]
      ? await client.query("SELECT id, deleted_at, mode, capacity, date::text AS date, start_time::text AS start_time, end_time::text AS end_time FROM availability WHERE id = $1", [targetInitial.rows[0].id])
      : { rows: [] };
    if (input.availability_id && !targetSlot.rows[0]) fail(409, "SLOT_UNAVAILABLE", "The selected availability option is no longer available");
    const targetDate = targetSlot.rows[0]?.date ?? input.date;
    const targetStart = targetSlot.rows[0]?.start_time.slice(0, 5) ?? input.start_time;
    const targetEnd = targetSlot.rows[0]?.end_time.slice(0, 5) ?? input.end_time;
    if (original.date === targetDate && original.start_time.slice(0, 5) === targetStart) {
      fail(409, "APPOINTMENT_TIME_UNCHANGED", "Choose a different appointment date or time");
    }
    if (!slotStartsInFuture({ date: targetDate, start_time: targetStart }, now)) fail(409, "APPOINTMENT_TIME_NOT_FUTURE", "The new appointment time must be in the future");
    const conflict = targetSlot.rows[0]?.mode ? { rows: [] } : await client.query(
      `SELECT 1 FROM appointments other
       JOIN availability other_av ON other_av.id = other.availability_id
       WHERE other_av.doctor_id = $1 AND other.id <> $2 AND other.status = 'confirmed'
         AND other.scheduled_date = $3::date
         AND other.scheduled_start_time < $5::time
         AND other.scheduled_end_time > $4::time LIMIT 1`,
      [doctorId, appointmentId, targetDate, targetStart, targetEnd],
    );
    if (conflict.rows[0]) fail(409, "DOCTOR_TIME_CONFLICT", "The selected time overlaps another confirmed appointment");
    if (!targetSlot.rows[0]?.mode) await ensureNoActivePaymentHold(client, doctorId, targetDate, targetStart, targetEnd);
    if (targetSlot.rows[0]?.deleted_at) fail(409, "SLOT_UNAVAILABLE", "The selected availability slot has been removed");
    const availabilityId = targetSlot.rows[0]?.id ?? original.availability_id;
    if (original.allocation_id && !targetSlot.rows[0]) fail(409, "SLOT_UNAVAILABLE", "Choose a generated availability slot for this appointment");
    let allocationId = null;
    if (targetSlot.rows[0]?.mode) {
      const occupied = await countOccupiedPlaces(client, availabilityId, {
        excludedAppointmentId: appointmentId,
        excludedAllocationId: original.allocation_id,
      });
      if (occupied >= Number(targetSlot.rows[0].capacity || 1)) fail(409, "SLOT_CAPACITY_REACHED", "The selected availability option has reached its booking capacity");
      const allocation = await client.query("INSERT INTO appointment_allocations (availability_id, mode, patient_id, status) VALUES ($1,$2,$3,'confirmed') RETURNING id", [availabilityId, targetSlot.rows[0].mode, original.patient_id]);
      allocationId = allocation.rows[0].id;
    }
    const updated = await client.query(
      `UPDATE appointments SET availability_id = $2, allocation_id = $6, scheduled_date = $3::date,
       scheduled_start_time = $4::time, scheduled_end_time = $5::time,
       updated_at = NOW() WHERE id = $1 RETURNING id, updated_at::text AS reschedule_version`,
      [appointmentId, availabilityId, targetDate, targetStart, targetEnd, allocationId],
    );
    if (original.allocation_id) await client.query("UPDATE appointment_allocations SET status = 'released', updated_at = NOW() WHERE id = $1 AND status = 'confirmed'", [original.allocation_id]);
    if (original.allocation_id && allocationId) await client.query(
      `INSERT INTO appointment_reschedule_history (appointment_id, patient_id, changed_by_user_id, previous_allocation_id, previous_availability_id, previous_date, previous_start_time, previous_end_time, new_allocation_id, new_availability_id, new_date, new_start_time, new_end_time)
       VALUES ($1,$2,$3,$4,$5,$6::date,$7::time,$8::time,$9,$10,$11::date,$12::time,$13::time)`,
      [appointmentId, original.patient_id, user.id, original.allocation_id, original.availability_id, original.date, original.start_time, original.end_time, allocationId, availabilityId, targetDate, targetStart, targetEnd],
    );
    await supersedeOpenAssistedRescheduleRequests(client, appointmentId);
    const appointment = await readDetails(client, updated.rows[0].id);
    const result = {
      ...appointment,
      previous_date: original.date,
      previous_start_time: original.start_time,
      reschedule_version: updated.rows[0].reschedule_version,
    };
    return result;
  });
}

async function completeAppointment(database, user, appointmentId) {
  const doctorId = await requireOwnDoctorId(database, user);
  return withTransaction(database, async (client) => {
    await client.query(
      `SELECT id FROM assisted_reschedule_requests
       WHERE appointment_id = $1 AND status IN ('pending_patient', 'no_alternatives')
       FOR UPDATE`, [appointmentId],
    );
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
    await supersedeOpenAssistedRescheduleRequests(client, appointmentId);
    return readDetails(client, appointmentId);
  });
}

module.exports = {
  AppointmentError,
  countOccupiedPlaces,
  countOccupiedPlacesForSlots,
  cancelAppointment,
  confirmAssistedReschedule,
  declineAssistedReschedule,
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
