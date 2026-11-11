const { localDateTime, slotStartsInFuture } = require("../utils/schedulingTime");
const { failForProtectedAppointments, findProtectedAppointmentsForAvailability } = require("../services/scheduleProtectionService");

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
  let excludedAppointmentId = null;
  let excludedAllocationId = null;
  if (response.locals.query.exclude_appointment_id) {
    if (response.locals.user.role !== "doctor" || !isOwnDoctorManagementView) {
      return response.status(403).json({ error: { code: "FORBIDDEN", message: "Only the owning doctor can exclude an appointment while checking availability" } });
    }
    const excluded = await response.locals.database.query(
      `SELECT a.id, a.allocation_id FROM appointments a
       JOIN availability av ON av.id = a.availability_id
       WHERE a.id = $1 AND av.doctor_id = $2 AND a.status = 'confirmed'`,
      [response.locals.query.exclude_appointment_id, id],
    );
    if (!excluded.rows[0]) return response.status(404).json({ error: { code: "APPOINTMENT_NOT_FOUND", message: "Confirmed appointment not found" } });
    excludedAppointmentId = excluded.rows[0].id;
    excludedAllocationId = excluded.rows[0].allocation_id;
  }
  const values = [id, now.date, now.time, response.locals.applicationTimezone, isOwnDoctorManagementView, excludedAppointmentId, excludedAllocationId];
  const filters = [
    "doctor_id = $1",
    `(deleted_at IS NULL OR ($5::boolean AND (
       EXISTS (
         SELECT 1 FROM appointments a
         WHERE a.availability_id = availability.id AND a.status = 'confirmed'
           AND ((a.scheduled_date + a.scheduled_end_time) AT TIME ZONE $4) > NOW()
       )
       OR EXISTS (
         SELECT 1 FROM appointment_allocations allocation
         WHERE allocation.availability_id = availability.id
           AND (
             (allocation.status = 'held' AND allocation.expires_at > NOW())
             OR (
               allocation.status = 'confirmed'
               AND (
                 EXISTS (SELECT 1 FROM appointments linked WHERE linked.allocation_id = allocation.id AND linked.status = 'confirmed')
                 OR NOT EXISTS (SELECT 1 FROM appointments linked WHERE linked.allocation_id = allocation.id)
               )
             )
           )
       )
       OR EXISTS (
         SELECT 1 FROM appointment_slot_holds hold
         WHERE hold.availability_id = availability.id AND hold.status = 'active' AND hold.expires_at > NOW()
       )
     )))`,
    "(date > $2::date OR (date = $2::date AND start_time > $3::time))",
  ];
  if (from) {
    values.push(from);
    filters.push(`date >= $${values.length}::date`);
  }
  if (to) {
    values.push(to);
    filters.push(`date <= $${values.length}::date`);
  }

  try {
    const holdFilter = isOwnDoctorManagementView ? "" : "AND (availability.mode IS NOT NULL OR payment_hold.id IS NULL)";
    const result = await response.locals.database.query(
      `SELECT availability.id, availability.doctor_id, availability.schedule_id,
              availability.deleted_at IS NOT NULL AS reservation_only,
              EXISTS (SELECT 1 FROM appointments a WHERE a.availability_id = availability.id AND a.status = 'confirmed'
                AND ((a.scheduled_date + a.scheduled_end_time) AT TIME ZONE $4) > NOW()) AS has_confirmed_appointment,
              EXISTS (SELECT 1 FROM appointment_allocations allocation WHERE allocation.availability_id = availability.id
                AND ((allocation.status = 'held' AND allocation.expires_at > NOW())
                  OR (allocation.status = 'confirmed' AND (EXISTS (SELECT 1 FROM appointments linked
                    WHERE linked.allocation_id = allocation.id AND linked.status = 'confirmed') OR NOT EXISTS
                    (SELECT 1 FROM appointments linked WHERE linked.allocation_id = allocation.id))))) AS has_active_allocation,
              EXISTS (SELECT 1 FROM appointment_allocations allocation WHERE allocation.availability_id = availability.id
                AND allocation.status = 'held' AND allocation.expires_at > NOW()) AS has_active_held_allocation,
              (SELECT COUNT(*)::int FROM appointment_allocations allocation
               WHERE allocation.availability_id = availability.id
                 AND ((allocation.status = 'held' AND allocation.expires_at > NOW())
                   OR (allocation.status = 'confirmed' AND (EXISTS (SELECT 1 FROM appointments linked
                     WHERE linked.allocation_id = allocation.id AND linked.status = 'confirmed') OR NOT EXISTS
                     (SELECT 1 FROM appointments linked WHERE linked.allocation_id = allocation.id))))) AS active_allocation_count,
              availability.date::text AS date,
              availability.start_time::text AS start_time, availability.end_time::text AS end_time,
              availability.mode, availability.capacity,
              GREATEST(availability.capacity - COALESCE(occupancy.occupied, 0), 0)::int AS remaining_capacity,
              COALESCE(preserved.bookings, 0)::int AS preserved_reservation_count,
              availability.created_at, availability.updated_at,
              payment_hold.status AS hold_status, payment_hold.expires_at AS hold_expires_at
       FROM availability
       LEFT JOIN LATERAL (
         SELECT COUNT(DISTINCT reservation.patient_id)::int AS occupied
         FROM (
           SELECT allocation.patient_id FROM appointment_allocations allocation
           WHERE allocation.availability_id = availability.id
             AND ((allocation.status = 'held' AND allocation.expires_at > NOW())
               OR (allocation.status = 'confirmed' AND (EXISTS (SELECT 1 FROM appointments linked
                 WHERE linked.allocation_id = allocation.id AND linked.status = 'confirmed') OR NOT EXISTS
                 (SELECT 1 FROM appointments linked WHERE linked.allocation_id = allocation.id))))
             AND allocation.id IS DISTINCT FROM $7::uuid
           UNION
           SELECT appointment.patient_id FROM appointments appointment
           WHERE appointment.availability_id = availability.id AND appointment.status = 'confirmed'
             AND appointment.id IS DISTINCT FROM $6::uuid
             AND NOT EXISTS (
               SELECT 1 FROM appointment_allocations allocation
               WHERE allocation.id = appointment.allocation_id
                 AND allocation.availability_id = availability.id
                 AND ((allocation.status = 'held' AND allocation.expires_at > NOW())
                   OR (allocation.status = 'confirmed' AND (EXISTS (SELECT 1 FROM appointments linked
                     WHERE linked.allocation_id = allocation.id AND linked.status = 'confirmed') OR NOT EXISTS
                     (SELECT 1 FROM appointments linked WHERE linked.allocation_id = allocation.id))))
                 AND allocation.id IS DISTINCT FROM $7::uuid
             )
           UNION
           SELECT hold.patient_id FROM appointment_slot_holds hold
           WHERE hold.availability_id = availability.id AND hold.status = 'active' AND hold.expires_at > NOW()
         ) reservation
       ) occupancy ON TRUE
       LEFT JOIN LATERAL (
         SELECT COUNT(DISTINCT reservation.patient_id)::int AS bookings FROM (
           SELECT appointment.patient_id FROM appointments appointment
           WHERE appointment.availability_id = availability.id AND appointment.status = 'confirmed'
           UNION
           SELECT allocation.patient_id FROM appointment_allocations allocation
           WHERE allocation.availability_id = availability.id AND allocation.status = 'confirmed'
             AND (EXISTS (SELECT 1 FROM appointments linked WHERE linked.allocation_id = allocation.id AND linked.status = 'confirmed')
               OR NOT EXISTS (SELECT 1 FROM appointments linked WHERE linked.allocation_id = allocation.id))
         ) reservation
       ) preserved ON TRUE
       LEFT JOIN LATERAL (
         SELECT hold.id, hold.status, hold.expires_at
         FROM appointment_slot_holds hold
         WHERE hold.availability_id = availability.id
           AND hold.status = 'active' AND hold.expires_at > NOW()
         ORDER BY hold.expires_at DESC
         LIMIT 1
       ) payment_hold ON TRUE
       WHERE ${filters.join(" AND ")}
         AND (availability.booking_visibility = 'public' OR $5::boolean)
         AND (availability.mode IS NOT NULL OR NOT EXISTS (
           SELECT 1 FROM appointments appointment
            WHERE appointment.availability_id = availability.id AND appointment.status = 'confirmed'
              AND ((appointment.scheduled_date + appointment.scheduled_end_time) AT TIME ZONE $4) > NOW()
          ))
         AND (availability.mode IS NULL OR availability.capacity > COALESCE(occupancy.occupied, 0) OR $5::boolean)
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
    // Take the doctor lock first to serialize manual slots with schedule generation/edits,
    // then sorted date locks to keep multi-date manual batches deadlock-free.
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [ownership.doctorId]);
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
      "SELECT id, schedule_window_id FROM availability WHERE id = $1 AND doctor_id = $2 AND deleted_at IS NULL FOR UPDATE",
      [slotId, ownership.doctorId],
    );
    if (!locked.rows[0]) {
      await client.query("ROLLBACK");
      transactionStarted = false;
      return response.status(404).json({ error: { code: "SLOT_NOT_FOUND", message: "Availability slot not found" } });
    }

    // Booking and payment reservation flows lock the slot before this doctor-scoped advisory lock.
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [ownership.doctorId]);
    const protectedAppointments = await findProtectedAppointmentsForAvailability(
      client, slotId, response.locals.applicationTimezone || "Asia/Kolkata",
    );
    if (failForProtectedAppointments(response, protectedAppointments)) {
      await client.query("ROLLBACK");
      transactionStarted = false;
      return;
    }
    const activeHold = await client.query(
      `SELECT 1 WHERE EXISTS (
         SELECT 1 FROM appointment_slot_holds
         WHERE availability_id = $1 AND status = 'active' AND expires_at > NOW()
       ) OR EXISTS (
         SELECT 1 FROM appointment_allocations
         WHERE availability_id = $1 AND status = 'held' AND expires_at > NOW()
       )`,
      [slotId],
    );
    if (activeHold.rows[0]) {
      await client.query("ROLLBACK");
      transactionStarted = false;
      return response.status(409).json({ error: { code: "ACTIVE_PAYMENT_HOLD", message: "An active payment hold is using this availability. Wait for it to expire or be resolved before removing it." } });
    }

    const history = await client.query(
      `SELECT EXISTS (SELECT 1 FROM appointments WHERE availability_id = $1)
           OR EXISTS (SELECT 1 FROM appointment_allocations WHERE availability_id = $1)
           OR EXISTS (SELECT 1 FROM appointment_slot_holds WHERE availability_id = $1) AS referenced`,
      [slotId],
    );
    if (history.rows[0]?.referenced || locked.rows[0].schedule_window_id) {
      await client.query(
        "UPDATE availability SET deleted_at = NOW(), updated_at = NOW() WHERE id = $1 AND doctor_id = $2 AND deleted_at IS NULL",
        [slotId, ownership.doctorId],
      );
      // Keep its active schedule-window row as a durable, date-specific exclusion marker.
      // Recovery recognizes the retired availability/window pair and will not regenerate it.
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
