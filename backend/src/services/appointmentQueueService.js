const { AppointmentError } = require("./appointmentService");

function fail(status, code, message) { throw new AppointmentError(status, code, message); }

function compareCheckedInOrder(first, second) {
  const checkedInOrder = Date.parse(first.checked_in_at) - Date.parse(second.checked_in_at);
  return checkedInOrder || Number(first.token_number) - Number(second.token_number);
}

async function withTransaction(database, callback) {
  const client = await database.connect();
  try {
    await client.query("BEGIN");
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally { client.release(); }
}

async function doctorIdForUser(database, user) {
  if (user.role !== "doctor") fail(403, "FORBIDDEN", "Only doctors may access this queue");
  const result = await database.query("SELECT id FROM doctors WHERE user_id = $1", [user.id]);
  if (!result.rows[0]) fail(403, "DOCTOR_PROFILE_REQUIRED", "An existing doctor profile is required");
  return result.rows[0].id;
}

async function appointmentQueue(database, user, doctorId, date, timeZone = "Asia/Kolkata") {
  if (user.role === "doctor") {
    const ownDoctorId = await doctorIdForUser(database, user);
    if (doctorId && doctorId !== ownDoctorId) fail(403, "FORBIDDEN", "Doctors may access only their own queue");
    doctorId = ownDoctorId;
  } else if (user.role !== "receptionist") {
    fail(403, "FORBIDDEN", "This account cannot access appointment queues");
  }
  const values = [date, timeZone];
  const filters = ["q.service_date = $1"];
  if (doctorId) { values.push(doctorId); filters.push(`q.doctor_id = $${values.length}`); }
  const result = await database.query(
    `SELECT q.appointment_id, q.doctor_id, q.service_date::text AS date, q.token_number,
            q.status, q.checked_in_at, q.called_at, q.completed_at,
            a.scheduled_start_time::text AS start_time, a.scheduled_end_time::text AS end_time,
            (a.status = 'confirmed' AND q.status = 'not_checked_in' AND
             ((a.scheduled_date + a.scheduled_start_time) AT TIME ZONE $2) <= NOW()) AS no_show_eligible,
            p.id AS patient_id, pu.first_name AS patient_first_name, pu.last_name AS patient_last_name,
            duser.first_name AS doctor_first_name, duser.last_name AS doctor_last_name
       FROM appointment_queue_entries q
       JOIN appointments a ON a.id = q.appointment_id
       JOIN patients p ON p.id = a.patient_id
       JOIN users pu ON pu.id = p.user_id
       JOIN doctors d ON d.id = q.doctor_id
       JOIN users duser ON duser.id = d.user_id
      WHERE ${filters.join(" AND ")}
      ORDER BY a.scheduled_date ASC, a.scheduled_start_time ASC, a.id ASC`, values,
  );
  const entries = result.rows;
  const current = entries.find((entry) => entry.status === "in_progress") || null;
  const waiting = entries.filter((entry) => entry.status === "waiting").sort(compareCheckedInOrder);
  return { date, current_token: current?.token_number ?? null, current, waiting, entries };
}

async function patientAppointmentQueue(database, user, appointmentId) {
  if (user.role !== "patient") fail(403, "FORBIDDEN", "Only patients may view their own queue position");
  const ownResult = await database.query(
    `SELECT q.appointment_id, q.doctor_id, q.service_date::text AS date, q.token_number, q.status
       FROM appointment_queue_entries q JOIN appointments a ON a.id = q.appointment_id
       JOIN patients p ON p.id = a.patient_id
      WHERE q.appointment_id = $1 AND p.user_id = $2`, [appointmentId, user.id],
  );
  const own = ownResult.rows[0];
  if (!own) fail(404, "QUEUE_ENTRY_NOT_FOUND", "Queue entry not found");
  const result = await database.query(
    `SELECT appointment_id, token_number, status, checked_in_at FROM appointment_queue_entries
      WHERE doctor_id = $1 AND service_date = $2::date
      ORDER BY CASE WHEN status = 'waiting' THEN 0 ELSE 1 END,
               checked_in_at ASC NULLS LAST, token_number ASC`, [own.doctor_id, own.date],
  );
  const current = result.rows.find((entry) => entry.status === "in_progress") || null;
  const waiting = result.rows.filter((entry) => entry.status === "waiting").sort(compareCheckedInOrder);
  const waitingIndex = own.status === "waiting" ? waiting.findIndex((entry) => entry.appointment_id === own.appointment_id) : -1;
  const peopleAhead = waitingIndex >= 0 ? waitingIndex + Number(Boolean(current)) : 0;
  const position = waitingIndex >= 0 ? peopleAhead + 1 : null;
  return { token_number: own.token_number, position, people_ahead: waitingIndex >= 0 ? peopleAhead : null, current_token: current?.token_number ?? null, status: own.status, date: own.date };
}

async function checkIn(database, user, appointmentId, timeZone = "Asia/Kolkata") {
  if (user.role !== "receptionist") fail(403, "FORBIDDEN", "Only receptionists may check patients in");
  return withTransaction(database, async (client) => {
    const result = await client.query(
      `UPDATE appointment_queue_entries q SET status = 'waiting', checked_in_at = NOW(), checked_in_by_user_id = $2, updated_at = NOW()
        FROM appointments a WHERE q.appointment_id = $1 AND a.id = q.appointment_id
          AND a.status = 'confirmed' AND q.status = 'not_checked_in'
          AND q.service_date = (NOW() AT TIME ZONE $3)::date
      RETURNING q.appointment_id, q.doctor_id, q.service_date::text AS date, q.token_number, q.status, q.checked_in_at`,
      [appointmentId, user.id, timeZone],
    );
    if (!result.rows[0]) fail(409, "QUEUE_STATE_CONFLICT", "This appointment cannot be checked in or has already been checked in");
    return result.rows[0];
  });
}

async function markNoShow(database, user, appointmentId, timeZone = "Asia/Kolkata") {
  if (user.role !== "receptionist") fail(403, "FORBIDDEN", "Only receptionists may mark no-shows");
  return withTransaction(database, async (client) => {
    const result = await client.query(
      `UPDATE appointment_queue_entries q SET status = 'no_show', no_show_at = NOW(), no_show_by_user_id = $2, updated_at = NOW()
        FROM appointments a WHERE q.appointment_id = $1 AND a.id = q.appointment_id
          AND a.status = 'confirmed' AND q.status = 'not_checked_in'
          AND ((a.scheduled_date + a.scheduled_start_time) AT TIME ZONE $3) <= NOW()
      RETURNING q.appointment_id, q.doctor_id, q.service_date::text AS date, q.token_number, q.status`,
      [appointmentId, user.id, timeZone],
    );
    if (!result.rows[0]) fail(409, "QUEUE_STATE_CONFLICT", "No-show can be recorded only after the appointment start time and before check-in");
    return result.rows[0];
  });
}

async function callNext(database, user, requestedDate, timeZone = "Asia/Kolkata") {
  const doctorId = await doctorIdForUser(database, user);
    const date = requestedDate || new Intl.DateTimeFormat("en-CA", { timeZone }).format(new Date());
  return withTransaction(database, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [doctorId]);
    const active = await client.query(
      "SELECT appointment_id FROM appointment_queue_entries WHERE doctor_id = $1 AND status = 'in_progress' FOR UPDATE",
      [doctorId],
    );
    if (active.rows[0]) fail(409, "CONSULTATION_ALREADY_IN_PROGRESS", "Complete the current consultation before calling the next patient");
    const next = await client.query(
      `SELECT q.appointment_id FROM appointment_queue_entries q JOIN appointments a ON a.id = q.appointment_id
        WHERE q.doctor_id = $1 AND q.service_date = $2::date AND q.status = 'waiting' AND a.status = 'confirmed'
        ORDER BY q.checked_in_at ASC, q.token_number ASC LIMIT 1 FOR UPDATE OF q`, [doctorId, date],
    );
    if (!next.rows[0]) fail(404, "QUEUE_EMPTY", "There are no checked-in patients waiting");
    const called = await client.query(
      `UPDATE appointment_queue_entries SET status = 'in_progress', called_at = NOW(), called_by_user_id = $2, updated_at = NOW()
        WHERE appointment_id = $1 RETURNING appointment_id, doctor_id, service_date::text AS date, token_number, status, called_at`,
      [next.rows[0].appointment_id, user.id],
    );
    return called.rows[0];
  });
}

module.exports = { appointmentQueue, callNext, checkIn, markNoShow, patientAppointmentQueue };
