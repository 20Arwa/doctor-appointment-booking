function localDateTime(timeZone, instant = new Date()) {
  if (!timeZone) return null;
  try {
    const values = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(instant).filter((part) => part.type !== "literal").map(({ type, value }) => [type, value]));
    return { date: `${values.year}-${values.month}-${values.day}`, time: `${values.hour}:${values.minute}` };
  } catch (_error) {
    return null;
  }
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

function slotStartsInFuture(slot, now) {
  return slot.date > now.date || (slot.date === now.date && slot.start_time > now.time);
}

async function getDoctorSlots(_request, response, next) {
  const now = requireTimezone(response);
  if (!now) return;
  const { id } = response.locals.params;
  const { from, to } = response.locals.query;
  const values = [id, now.date, now.time];
  const filters = ["doctor_id = $1", "(date > $2::date OR (date = $2::date AND start_time > $3::time))"];
  if (from) {
    values.push(from);
    filters.push(`date >= $${values.length}::date`);
  }
  if (to) {
    values.push(to);
    filters.push(`date <= $${values.length}::date`);
  }

  try {
    // Phase 3 can add a NOT EXISTS predicate here for non-cancelled appointments referencing a slot.
    const result = await response.locals.database.query(
      `SELECT id, doctor_id, date::text AS date, start_time::text AS start_time, end_time::text AS end_time, created_at, updated_at FROM availability WHERE ${filters.join(" AND ")} ORDER BY date, start_time`,
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
      "SELECT date::text AS date, start_time::text AS start_time, end_time::text AS end_time FROM availability WHERE doctor_id = $1 AND date = ANY($2::date[])",
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
  const { id: requestedDoctorId, slotId } = response.locals.params;
  const ownership = await getOwnDoctorId(response);
  if (ownership.error) return sendOwnershipError(response, ownership.error);
  if (ownership.doctorId !== requestedDoctorId) {
    return response.status(403).json({ error: { code: "FORBIDDEN", message: "You may manage only your own availability" } });
  }
  try {
    // Phase 3 must reject deletion when any current or historical appointment references this slot.
    // The appointments foreign key must use ON DELETE RESTRICT so availability history cannot cascade away.
    const result = await response.locals.database.query(
      "DELETE FROM availability WHERE id = $1 AND doctor_id = $2 RETURNING id",
      [slotId, ownership.doctorId],
    );
    if (!result.rows[0]) return response.status(404).json({ error: { code: "SLOT_NOT_FOUND", message: "Availability slot not found" } });
    return response.status(204).end();
  } catch (error) {
    if (error.code === "23503") {
      return response.status(409).json({ error: { code: "SLOT_REFERENCED", message: "Availability referenced by appointment history cannot be deleted" } });
    }
    return next(error);
  }
}

module.exports = { createDoctorSlots, deleteDoctorSlot, getDoctorSlots, localDateTime, slotStartsInFuture };
