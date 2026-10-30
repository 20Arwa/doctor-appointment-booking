const { localDateTime, slotStartsInFuture } = require("../utils/schedulingTime");

const AVAILABILITY_REFERENCE_CONSTRAINTS = new Set([
  "appointments_availability_id_fkey",
  "appointment_slot_holds_availability_id_fkey",
]);

function isAvailabilityReferenceViolation(error) {
  return error.code === "23503"
    || (error.code === "23001" && AVAILABILITY_REFERENCE_CONSTRAINTS.has(error.constraint));
}

function requireTimezone(response) {
  const now = localDateTime(response.locals.applicationTimezone);
  if (!now) {
    response.status(503).json({ error: { code: "TIMEZONE_NOT_CONFIGURED", message: "Application timezone is not configured" } });
    return null;
  }
  return now;
}

function timeToMinutes(value) {
  return Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5));
}

async function getDoctorSlots(_request, response, next) {
  const now = requireTimezone(response);
  if (!now) return;
  const { id } = response.locals.params;
  const { from, to } = response.locals.query;
  let isOwnDoctorManagementView = false;
  if (response.locals.user.role === "doctor") {
    const ownership = await getOwnDoctorId(response);
    isOwnDoctorManagementView = !ownership.error && ownership.doctorId === id;
  }
  const values = [id, now.date, now.time, response.locals.applicationTimezone];
  const filters = ["doctor_id = $1", "deleted_at IS NULL", "(date > $2::date OR (date = $2::date AND start_time > $3::time))"];
  if (from) {
    values.push(from);
    filters.push(`date >= $${values.length}::date`);
  }
  if (to) {
    values.push(to);
    filters.push(`date <= $${values.length}::date`);
  }

  try {
    const holdFilter = isOwnDoctorManagementView ? "" : "AND payment_hold.id IS NULL";
    const result = await response.locals.database.query(
      `SELECT availability.id, availability.doctor_id, availability.date::text AS date,
              availability.start_time::text AS start_time, availability.end_time::text AS end_time,
              availability.created_at, availability.updated_at,
              payment_hold.status AS hold_status, payment_hold.expires_at AS hold_expires_at
       FROM availability
       LEFT JOIN LATERAL (
         SELECT hold.id, hold.status, hold.expires_at
         FROM appointment_slot_holds hold
         WHERE hold.availability_id = availability.id
           AND hold.status = 'active' AND hold.expires_at > NOW()
         ORDER BY hold.expires_at DESC
         LIMIT 1
       ) payment_hold ON TRUE
       WHERE ${filters.join(" AND ")}
         AND NOT EXISTS (
           SELECT 1 FROM appointments appointment
            WHERE appointment.availability_id = availability.id AND appointment.status = 'confirmed'
              AND ((appointment.scheduled_date + appointment.scheduled_end_time) AT TIME ZONE $4) > NOW()
          )
          ${holdFilter}
       ORDER BY date, start_time`,
      values,
    );
    return response.json(result.rows);
  } catch (error) { return next(error); }
}

async function getOwnDoctorId(response) {
  const user = response.locals.user;
  if (user.role !== "doctor") return { error: "FORBIDDEN" };
  const result = await response.locals.database.query("SELECT id FROM doctors WHERE user_id = $1", [user.id]);
  if (!result.rows[0]) return { error: "DOCTOR_PROFILE_NOT_FOUND" };
  return { doctorId: result.rows[0].id };
}

function sendOwnershipError(response, error) {
  const status = error === "FORBIDDEN" ? 403 : 404;
  const code = error;
  const message = error === "FORBIDDEN" ? "Only a doctor can manage availability" : "Doctor profile not found";
  return response.status(status).json({ error: { code, message } });
}

async function createDoctorSlots(_request, response, next) {
  const now = requireTimezone(response);
  if (!now) return;
  const { id: requestedDoctorId } = response.locals.params;
  const ownership = await getOwnDoctorId(response);
  if (ownership.error) return sendOwnershipError(response, ownership.error);
  if (ownership.doctorId !== requestedDoctorId) {
    return response.status(403).json({ error: { code: "FORBIDDEN", message: "You may manage only your own availability" } });
  }

  const { slots } = response.locals.body;
  const pastSlot = slots.find((slot) => !slotStartsInFuture(slot, now));
  if (pastSlot) {
    return response.status(400).json({ error: { code: "VALIDATION_ERROR", message: "All slots must start in the future in the configured application timezone" } });
  }

  const client = await response.locals.database.connect();
  let transactionStarted = false;
  try {
    await client.query("BEGIN");
    transactionStarted = true;
    const dates = [...new Set(slots.map((slot) => slot.date))].sort();
    // Transaction-scoped locks serialize overlap checks per doctor and date. Sorted acquisition avoids batch deadlocks.
    for (const slotDate of dates) {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))", [ownership.doctorId, slotDate]);
    }

    const existing = await client.query(
      "SELECT date::text AS date, start_time::text AS start_time, end_time::text AS end_time FROM availability WHERE doctor_id = $1 AND deleted_at IS NULL AND date = ANY($2::date[])",
      [ownership.doctorId, dates],
    );
    const conflict = slots.find((slot) => existing.rows.some((saved) => {
      if (saved.date !== slot.date) return false;
      return timeToMinutes(saved.start_time) < timeToMinutes(slot.end_time)
        && timeToMinutes(saved.end_time) > timeToMinutes(slot.start_time);
    }));
    if (conflict) {
      await client.query("ROLLBACK");
      transactionStarted = false;
      return response.status(409).json({ error: { code: "SLOT_OVERLAP", message: "One or more slots overlap existing availability" } });
    }

    const values = [];
    const rows = slots.map((slot, index) => {
      const offset = index * 4;
      values.push(ownership.doctorId, slot.date, slot.start_time, slot.end_time);
      return `($${offset + 1}, $${offset + 2}::date, $${offset + 3}::time, $${offset + 4}::time)`;
    });
    const inserted = await client.query(
      `INSERT INTO availability (doctor_id, date, start_time, end_time) VALUES ${rows.join(", ")} RETURNING id, doctor_id, date::text AS date, start_time::text AS start_time, end_time::text AS end_time, created_at, updated_at`,
      values,
    );
    await client.query("COMMIT");
    transactionStarted = false;
    return response.status(201).json(inserted.rows);
  } catch (error) {
    if (transactionStarted) await client.query("ROLLBACK").catch(() => {});
    if (error.code === "23505") {
      return response.status(409).json({ error: { code: "SLOT_CONFLICT", message: "A slot with that doctor, date, and start time already exists" } });
    }
    return next(error);
  } finally { client.release(); }
}

async function deleteDoctorSlot(_request, response, next) {
  const now = requireTimezone(response);
  if (!now) return;
  const { id: requestedDoctorId, slotId } = response.locals.params;
  const ownership = await getOwnDoctorId(response);
  if (ownership.error) return sendOwnershipError(response, ownership.error);
  if (ownership.doctorId !== requestedDoctorId) {
    return response.status(403).json({ error: { code: "FORBIDDEN", message: "You may manage only your own availability" } });
  }

  const client = await response.locals.database.connect();
  let transactionStarted = false;
  try {
    await client.query("BEGIN");
    transactionStarted = true;
    const locked = await client.query(
      "SELECT id FROM availability WHERE id = $1 AND doctor_id = $2 AND deleted_at IS NULL FOR UPDATE",
      [slotId, ownership.doctorId],
    );
    if (!locked.rows[0]) {
      await client.query("ROLLBACK");
      transactionStarted = false;
      return response.status(404).json({ error: { code: "SLOT_NOT_FOUND", message: "Availability slot not found" } });
    }

    // Booking and payment reservation flows lock the slot before this doctor-scoped advisory lock.
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [ownership.doctorId]);
    const activeAppointment = await client.query(
      `SELECT 1 FROM appointments
       WHERE availability_id = $1 AND status = 'confirmed'
         AND ((scheduled_date + scheduled_end_time) AT TIME ZONE $2) > NOW()
       LIMIT 1`,
      [slotId, response.locals.applicationTimezone],
    );
    if (activeAppointment.rows[0]) {
      await client.query("ROLLBACK");
      transactionStarted = false;
      return response.status(409).json({ error: { code: "SLOT_IN_USE", message: "This slot has a future confirmed appointment and cannot be removed" } });
    }

    const activeHold = await client.query(
      "SELECT 1 FROM appointment_slot_holds WHERE availability_id = $1 AND status = 'active' AND expires_at > NOW() LIMIT 1",
      [slotId],
    );
    if (activeHold.rows[0]) {
      await client.query("ROLLBACK");
      transactionStarted = false;
      return response.status(409).json({ error: { code: "SLOT_IN_USE", message: "This slot is temporarily held for payment and cannot be removed yet" } });
    }

    const history = await client.query(
      `SELECT EXISTS (SELECT 1 FROM appointments WHERE availability_id = $1)
           OR EXISTS (SELECT 1 FROM appointment_slot_holds WHERE availability_id = $1) AS referenced`,
      [slotId],
    );
    if (history.rows[0]?.referenced) {
      await client.query(
        "UPDATE availability SET deleted_at = NOW(), updated_at = NOW() WHERE id = $1 AND doctor_id = $2 AND deleted_at IS NULL",
        [slotId, ownership.doctorId],
      );
      await client.query("COMMIT");
      transactionStarted = false;
      return response.status(204).end();
    }

    // RESTRICT foreign keys remain the final guard if a reference races with these checks.
    const result = await client.query(
      "DELETE FROM availability WHERE id = $1 AND doctor_id = $2 AND deleted_at IS NULL RETURNING id",
      [slotId, ownership.doctorId],
    );
    if (!result.rows[0]) {
      await client.query("ROLLBACK");
      transactionStarted = false;
      return response.status(404).json({ error: { code: "SLOT_NOT_FOUND", message: "Availability slot not found" } });
    }
    await client.query("COMMIT");
    transactionStarted = false;
    return response.status(204).end();
  } catch (error) {
    if (transactionStarted) await client.query("ROLLBACK").catch(() => {});
    if (isAvailabilityReferenceViolation(error)) {
      return response.status(409).json({ error: { code: "SLOT_IN_USE", message: "This slot is now in use by a booking or payment hold and cannot be removed" } });
    }
    return next(error);
  } finally { client.release(); }
}

module.exports = { createDoctorSlots, deleteDoctorSlot, getDoctorSlots, localDateTime, slotStartsInFuture };
