const { createHash } = require("node:crypto");
const { countOccupiedPlacesForSlots } = require("./appointmentService");
const { localDateTime } = require("../utils/schedulingTime");

const ALTERNATIVE_WINDOW_DAYS = 14;
const MAX_SUGGESTIONS = 5;

function scheduleRequestFingerprint(input) {
  const periods = [...input.periods]
    .map(({ weekday, start_time, end_time }) => ({ weekday, start_time, end_time }))
    .sort((first, second) => first.weekday - second.weekday
      || first.start_time.localeCompare(second.start_time)
      || first.end_time.localeCompare(second.end_time));
  return createHash("sha256").update(JSON.stringify({
    mode: input.mode,
    starts_on: input.starts_on,
    ends_on: input.ends_on,
    periods,
  })).digest("hex");
}

async function findScheduleUpdateBatch(database, scheduleId, sourceUpdatedAt) {
  const result = await database.query(
    `SELECT id, request_fingerprint, result FROM assisted_reschedule_batches
     WHERE schedule_id = $1 AND source_schedule_updated_at = $2::timestamptz`,
    [scheduleId, sourceUpdatedAt],
  );
  return result.rows[0] ?? null;
}

async function findAlternatives(client, appointment, timeZone) {
  if (!appointment.mode || !["wave", "stream"].includes(appointment.mode)) return [];
  const suggestions = [];
  const now = localDateTime(timeZone);
  const pageSize = 50;
  let offset = 0;
  while (suggestions.length < MAX_SUGGESTIONS) {
    const candidates = await client.query(
      `SELECT id, mode, capacity, date::text AS date,
              start_time::text AS start_time, end_time::text AS end_time
       FROM availability
       WHERE doctor_id = $1 AND mode = $2 AND booking_visibility = 'public'
         AND deleted_at IS NULL AND id <> $3
         AND date BETWEEN GREATEST($4::date - $5::int, $6::date) AND $4::date + $5::int
         AND (date > $6::date OR (date = $6::date AND start_time > $7::time))
         AND NOT EXISTS (SELECT 1 FROM appointments existing
           WHERE existing.availability_id = availability.id AND existing.patient_id = $9
             AND existing.status = 'confirmed')
         AND NOT EXISTS (SELECT 1 FROM appointment_allocations allocation
           WHERE allocation.availability_id = availability.id AND allocation.patient_id = $9
             AND (allocation.status = 'confirmed' OR (allocation.status = 'held' AND allocation.expires_at > NOW())))
         AND NOT EXISTS (SELECT 1 FROM appointment_slot_holds hold
           WHERE hold.availability_id = availability.id AND hold.patient_id = $9
             AND hold.status = 'active' AND hold.expires_at > NOW())
       ORDER BY ABS(EXTRACT(EPOCH FROM ((date + start_time) - ($4::date + $8::time)))), date, start_time
       LIMIT $10 OFFSET $11`,
      [appointment.doctor_id, appointment.mode, appointment.availability_id,
        appointment.date, ALTERNATIVE_WINDOW_DAYS, now.date, now.time,
        appointment.start_time, appointment.patient_id, pageSize, offset],
    );
    if (!candidates.rows.length) break;
    const occupiedBySlot = await countOccupiedPlacesForSlots(client, candidates.rows.map((candidate) => candidate.id));
    for (const candidate of candidates.rows) {
      const occupied = occupiedBySlot.get(candidate.id) ?? 0;
      const remaining = Number(candidate.capacity) - occupied;
      if (remaining <= 0) continue;
      suggestions.push({ ...candidate, remaining_capacity_at_suggestion: remaining });
      if (suggestions.length >= MAX_SUGGESTIONS) break;
    }
    offset += candidates.rows.length;
    if (candidates.rows.length < pageSize) break;
  }
  return suggestions;
}

function appointmentCoveredBySchedule(appointment, input, exceptions) {
  if (appointment.date < input.starts_on || appointment.date > input.ends_on) return false;
  const exception = exceptions.get(appointment.date);
  if (exception?.exception_type === "day_off") return false;
  const weekday = new Date(`${appointment.date}T00:00:00.000Z`).getUTCDay();
  let periods = input.periods.filter((period) => period.weekday === weekday);
  if (exception?.exception_type === "override") periods = exception.periods;
  if (exception?.exception_type === "additional") periods = [...periods, ...exception.periods];
  const appointmentStart = appointment.start_time.slice(0, 5);
  const appointmentEnd = appointment.end_time.slice(0, 5);
  return periods.some((period) => period.start_time <= appointmentStart && period.end_time >= appointmentEnd);
}

async function supersedeCoveredRequestsForScheduleChange(client, { scheduleId, input, exceptions }) {
  const requests = await client.query(
    `SELECT request.id, appointment.scheduled_date::text AS date,
            appointment.scheduled_start_time::text AS start_time,
            appointment.scheduled_end_time::text AS end_time
     FROM assisted_reschedule_requests request
     JOIN assisted_reschedule_batches batch ON batch.id = request.batch_id
     JOIN appointments appointment ON appointment.id = request.appointment_id
     WHERE batch.schedule_id = $1 AND request.status IN ('pending_patient', 'no_alternatives')
       AND appointment.status = 'confirmed'
     ORDER BY request.id`,
    [scheduleId],
  );
  const superseded = [];
  for (const request of requests.rows) {
    if (!appointmentCoveredBySchedule(request, input, exceptions)) continue;
    const updated = await client.query(
      `UPDATE assisted_reschedule_requests
       SET status = 'superseded',
           notification_status = CASE WHEN notification_status IN ('pending', 'processing', 'failed') THEN 'not_required' ELSE notification_status END,
           notification_next_attempt_at = NULL, notification_lease_token = NULL, notification_lease_expires_at = NULL,
           updated_at = NOW()
       WHERE id = $1 AND status IN ('pending_patient', 'no_alternatives')
       RETURNING id`,
      [request.id],
    );
    if (updated.rows[0]) superseded.push(request.id);
  }
  return superseded;
}

async function createRequestsForAffectedAppointments(client, { batchId, affectedAppointments, timeZone }) {
  const created = [];
  for (const appointment of affectedAppointments) {
    const alreadyCreated = await client.query(
      `SELECT request.id, request.status,
              (SELECT COUNT(*)::int FROM assisted_reschedule_suggestions suggestion
               WHERE suggestion.request_id = request.id) AS suggestion_count
       FROM assisted_reschedule_requests request
       WHERE request.batch_id = $1 AND request.appointment_id = $2`,
      [batchId, appointment.id],
    );
    if (alreadyCreated.rows[0]) {
      created.push({ ...alreadyCreated.rows[0], appointment_id: appointment.id });
      continue;
    }
    await client.query(
      `UPDATE assisted_reschedule_requests
       SET status = 'superseded',
           notification_status = CASE WHEN notification_status IN ('pending', 'processing', 'failed') THEN 'not_required' ELSE notification_status END,
           notification_next_attempt_at = NULL, notification_lease_token = NULL, notification_lease_expires_at = NULL,
           updated_at = NOW()
       WHERE appointment_id = $1 AND status IN ('pending_patient', 'no_alternatives')`,
      [appointment.id],
    );
    const suggestions = await findAlternatives(client, appointment, timeZone);
    const status = suggestions.length ? "pending_patient" : "no_alternatives";
    const inserted = await client.query(
      `INSERT INTO assisted_reschedule_requests (
         batch_id, appointment_id, doctor_id, patient_id, source_availability_id,
         appointment_updated_at, previous_date, previous_start_time, previous_end_time,
         mode, status, notification_status, expires_at
       ) VALUES ($1,$2,$3,$4,$5,$6::timestamptz,$7::date,$8::time,$9::time,$10,$11,$12,
         (($7::date + $8::time) AT TIME ZONE $13))
       ON CONFLICT (batch_id, appointment_id) DO NOTHING
       RETURNING id`,
      [batchId, appointment.id, appointment.doctor_id, appointment.patient_id,
        appointment.availability_id, appointment.appointment_updated_at, appointment.date,
        appointment.start_time, appointment.end_time, appointment.mode, status,
        suggestions.length ? "pending" : "not_required", timeZone],
    );
    const requestId = inserted.rows[0]?.id ?? (await client.query(
      "SELECT id FROM assisted_reschedule_requests WHERE batch_id = $1 AND appointment_id = $2",
      [batchId, appointment.id],
    )).rows[0]?.id;
    if (!requestId) throw new Error("Assisted rescheduling request could not be persisted");
    if (inserted.rows[0]) {
      for (const [index, suggestion] of suggestions.entries()) await client.query(
        `INSERT INTO assisted_reschedule_suggestions (
           request_id, availability_id, mode, service_date, start_time, end_time,
           remaining_capacity_at_suggestion, rank
         ) VALUES ($1,$2,$3,$4::date,$5::time,$6::time,$7,$8)`,
        [requestId, suggestion.id, suggestion.mode, suggestion.date, suggestion.start_time,
          suggestion.end_time, suggestion.remaining_capacity_at_suggestion, index + 1],
      );
    }
    created.push({ id: requestId, appointment_id: appointment.id, status, suggestion_count: suggestions.length });
  }
  return created;
}

async function listDoctorRequests(database, user, doctorId, filters) {
  if (user.role !== "doctor") return { forbidden: true };
  const owner = await database.query("SELECT id FROM doctors WHERE user_id = $1", [user.id]);
  if (owner.rows[0]?.id !== doctorId) return { forbidden: true };
  await database.query(
    `UPDATE assisted_reschedule_requests request
     SET status = CASE WHEN request.expires_at <= NOW() THEN 'expired' ELSE 'superseded' END,
         notification_status = CASE WHEN notification_status IN ('pending', 'processing', 'failed') THEN 'not_required' ELSE notification_status END,
         notification_next_attempt_at = NULL, notification_lease_token = NULL, notification_lease_expires_at = NULL,
         updated_at = NOW(), responded_at = COALESCE(responded_at, NOW())
     WHERE request.doctor_id = $1 AND request.status IN ('pending_patient', 'no_alternatives')
       AND (request.expires_at <= NOW() OR NOT EXISTS (
         SELECT 1 FROM appointments appointment WHERE appointment.id = request.appointment_id
           AND appointment.status = 'confirmed' AND appointment.updated_at = request.appointment_updated_at
       ))`,
    [doctorId],
  );
  const values = [doctorId];
  const where = ["request.doctor_id = $1"];
  if (filters.status) {
    values.push(filters.status);
    where.push(`request.status = $${values.length}`);
  }
  values.push(filters.limit, filters.offset);
  const result = await database.query(
    `SELECT request.id, request.appointment_id, request.patient_id,
            request.source_availability_id, request.previous_date::text AS previous_date,
            request.previous_start_time::text AS previous_start_time,
            request.previous_end_time::text AS previous_end_time,
            request.mode, request.status, request.created_at, request.updated_at,
            request.expires_at,
            patient_user.first_name AS patient_first_name, patient_user.last_name AS patient_last_name,
            appointment.status AS appointment_status,
            (SELECT COUNT(*)::int FROM assisted_reschedule_suggestions suggestion
             WHERE suggestion.request_id = request.id) AS suggestion_count
     FROM assisted_reschedule_requests request
     JOIN appointments appointment ON appointment.id = request.appointment_id
     JOIN patients patient ON patient.id = request.patient_id
     JOIN users patient_user ON patient_user.id = patient.user_id
     WHERE ${where.join(" AND ")}
     ORDER BY request.created_at DESC, request.id DESC
     LIMIT $${values.length - 1} OFFSET $${values.length}`,
    values,
  );
  return { items: result.rows, limit: filters.limit, offset: filters.offset };
}

async function getPatientRequest(database, user, appointmentId) {
  if (user.role !== "patient") return { forbidden: true };
  await database.query(
    `UPDATE assisted_reschedule_requests request
     SET status = CASE WHEN request.expires_at <= NOW() THEN 'expired' ELSE 'superseded' END,
         notification_status = CASE WHEN notification_status IN ('pending', 'processing', 'failed') THEN 'not_required' ELSE notification_status END,
         notification_next_attempt_at = NULL, notification_lease_token = NULL, notification_lease_expires_at = NULL,
         updated_at = NOW(), responded_at = COALESCE(responded_at, NOW())
     WHERE request.appointment_id = $1 AND request.patient_id = (SELECT id FROM patients WHERE user_id = $2)
       AND request.status IN ('pending_patient', 'no_alternatives')
       AND (request.expires_at <= NOW() OR NOT EXISTS (
         SELECT 1 FROM appointments appointment WHERE appointment.id = request.appointment_id
           AND appointment.status = 'confirmed' AND appointment.updated_at = request.appointment_updated_at
       ))`,
    [appointmentId, user.id],
  );
  const result = await database.query(
    `SELECT request.id, request.appointment_id, request.status, request.mode,
            request.previous_date::text AS previous_date,
            request.previous_start_time::text AS previous_start_time,
            request.previous_end_time::text AS previous_end_time,
            request.appointment_updated_at::text AS appointment_updated_at,
            request.expires_at,
            request.created_at, request.updated_at,
            appointment.status AS appointment_status,
            doctor_user.first_name AS doctor_first_name, doctor_user.last_name AS doctor_last_name
     FROM assisted_reschedule_requests request
     JOIN appointments appointment ON appointment.id = request.appointment_id
     JOIN patients patient ON patient.id = request.patient_id
     JOIN doctors doctor ON doctor.id = request.doctor_id
     JOIN users doctor_user ON doctor_user.id = doctor.user_id
     WHERE request.appointment_id = $1 AND patient.user_id = $2
     ORDER BY request.created_at DESC, request.id DESC LIMIT 1`,
    [appointmentId, user.id],
  );
  if (!result.rows[0]) return null;
  const suggestions = await database.query(
    `SELECT id, availability_id, mode, service_date::text AS date,
            start_time::text AS start_time, end_time::text AS end_time,
            remaining_capacity_at_suggestion, rank
     FROM assisted_reschedule_suggestions WHERE request_id = $1 ORDER BY rank`,
    [result.rows[0].id],
  );
  return { ...result.rows[0], suggestions: suggestions.rows };
}

module.exports = {
  createRequestsForAffectedAppointments,
  findAlternatives,
  findScheduleUpdateBatch,
  appointmentCoveredBySchedule,
  supersedeCoveredRequestsForScheduleChange,
  getPatientRequest,
  listDoctorRequests,
  scheduleRequestFingerprint,
};
