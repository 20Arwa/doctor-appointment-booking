const { findSchedulePeriodOverlaps } = require("./schedulePeriodConflictService");
const { countOccupiedPlaces } = require("./appointmentService");

const POINT_IN_TIME_NOTICE = "Availability and suggestions are point-in-time and do not guarantee booking.";

async function requireDoctorId(database, actor) {
  if (actor?.role !== "doctor" || !actor.id) throw Object.assign(new Error("Tool is unavailable"), { code: "TOOL_UNAVAILABLE" });
  const result = await database.query("SELECT id FROM doctors WHERE user_id = $1", [actor.id]);
  if (!result.rows[0]) throw Object.assign(new Error("Doctor profile not found"), { code: "TOOL_QUERY_FAILED" });
  return result.rows[0].id;
}

async function getSchedules(database, doctorId, from, to, limit = 51) {
  const result = await database.query(
    `SELECT s.id, s.mode, s.recurrence_type, s.visibility, s.starts_on::text AS starts_on,
            s.ends_on::text AS ends_on, s.time_zone, s.wave_capacity_per_slot,
            s.stream_capacity_per_window, s.active,
            COALESCE(json_agg(json_build_object('weekday', p.weekday, 'service_date', p.service_date::text,
              'start_time', p.start_time::text, 'end_time', p.end_time::text))
              FILTER (WHERE p.id IS NOT NULL AND (
                (s.recurrence_type = 'specific_dates' AND p.service_date BETWEEN $2::date AND $3::date)
                OR (s.recurrence_type = 'weekly' AND EXISTS (
                  SELECT 1 FROM generate_series(
                    GREATEST($2::date, COALESCE(s.starts_on, $2::date)),
                    LEAST($3::date, COALESCE(s.ends_on, $3::date)), INTERVAL '1 day'
                  ) AS occurrence(service_date)
                  WHERE EXTRACT(DOW FROM occurrence.service_date)::int = p.weekday
                )))), '[]') AS periods
     FROM doctor_schedules s LEFT JOIN doctor_schedule_periods p ON p.schedule_id = s.id
     WHERE s.doctor_id = $1 AND s.active AND s.archived_at IS NULL
       AND (s.starts_on IS NULL OR s.starts_on <= $3::date)
       AND (s.ends_on IS NULL OR s.ends_on >= $2::date)
       AND (
         (s.recurrence_type = 'specific_dates' AND EXISTS (
           SELECT 1 FROM doctor_schedule_periods ranged_period WHERE ranged_period.schedule_id = s.id
             AND ranged_period.service_date BETWEEN $2::date AND $3::date))
         OR (s.recurrence_type = 'weekly' AND EXISTS (
           SELECT 1 FROM doctor_schedule_periods ranged_period
           CROSS JOIN LATERAL generate_series(
             GREATEST($2::date, COALESCE(s.starts_on, $2::date)),
             LEAST($3::date, COALESCE(s.ends_on, $3::date)), INTERVAL '1 day'
           ) AS occurrence(service_date)
           WHERE ranged_period.schedule_id = s.id
             AND EXTRACT(DOW FROM occurrence.service_date)::int = ranged_period.weekday))
       )
     GROUP BY s.id ORDER BY s.mode, s.created_at LIMIT $4`, [doctorId, from, to, limit],
  );
  return result.rows;
}

async function getExceptions(database, doctorId, from, to, limit = 101) {
  const result = await database.query(
    `SELECT exception.service_date::text AS date, exception.exception_type,
            COALESCE(json_agg(json_build_object('start_time', period.start_time::text,
              'end_time', period.end_time::text) ORDER BY period.start_time)
              FILTER (WHERE period.id IS NOT NULL), '[]') AS periods
     FROM doctor_schedules schedule
     JOIN doctor_schedule_exceptions exception ON exception.schedule_id = schedule.id
     LEFT JOIN doctor_schedule_exception_periods period ON period.exception_id = exception.id
     WHERE schedule.doctor_id = $1 AND schedule.active AND schedule.archived_at IS NULL
       AND (schedule.starts_on IS NULL OR schedule.starts_on <= $3::date)
       AND (schedule.ends_on IS NULL OR schedule.ends_on >= $2::date)
       AND exception.service_date BETWEEN $2::date AND $3::date
       AND (schedule.starts_on IS NULL OR exception.service_date >= schedule.starts_on)
       AND (schedule.ends_on IS NULL OR exception.service_date <= schedule.ends_on)
     GROUP BY exception.id ORDER BY exception.service_date, exception.id LIMIT $4`,
    [doctorId, from, to, limit],
  );
  return result.rows;
}

async function getConflicts(database, doctorId, from, to, limit = 50) {
  const slots = await database.query(
    `SELECT id, schedule_id, date::text AS date, start_time::text AS start_time,
            end_time::text AS end_time, mode, capacity
     FROM availability WHERE doctor_id = $1 AND date BETWEEN $2::date AND $3::date
       AND (
         availability.deleted_at IS NULL
         OR EXISTS (
           SELECT 1 FROM appointment_allocations alloc
           WHERE alloc.availability_id = availability.id AND (
             (alloc.status = 'held' AND alloc.expires_at > NOW())
             OR (alloc.status = 'confirmed' AND (
               EXISTS (SELECT 1 FROM appointments linked_appt WHERE linked_appt.allocation_id = alloc.id AND linked_appt.status = 'confirmed')
               OR NOT EXISTS (SELECT 1 FROM appointments linked_appt WHERE linked_appt.allocation_id = alloc.id)
             ))
           )
         )
         OR EXISTS (SELECT 1 FROM appointment_slot_holds hold WHERE hold.availability_id = availability.id
           AND hold.status = 'active' AND hold.expires_at > NOW())
         OR EXISTS (SELECT 1 FROM appointments confirmed_appt WHERE confirmed_appt.availability_id = availability.id AND confirmed_appt.status = 'confirmed')
       )
     ORDER BY date, start_time LIMIT 501`, [doctorId, from, to],
  );
  const items = [];
  for (const slot of slots.rows) {
    const input = { recurrence_type: "specific_dates", starts_on: slot.date, ends_on: slot.date };
    const scheduleOverlaps = await findSchedulePeriodOverlaps(database, doctorId, {
      service_date: slot.date, start_time: slot.start_time, end_time: slot.end_time,
    }, input, slot.schedule_id);
    const detail = await database.query(
      `SELECT EXISTS (SELECT 1 FROM appointments a WHERE a.availability_id = $1 AND a.status = 'confirmed') AS has_confirmed_appointment,
              EXISTS (SELECT 1 FROM appointment_allocations a WHERE a.availability_id = $1 AND
                ((a.status = 'held' AND a.expires_at > NOW()) OR (a.status = 'confirmed' AND
                (EXISTS (SELECT 1 FROM appointments linked WHERE linked.allocation_id = a.id AND linked.status = 'confirmed')
                 OR NOT EXISTS (SELECT 1 FROM appointments linked WHERE linked.allocation_id = a.id))))) AS has_active_reservation,
              EXISTS (SELECT 1 FROM appointment_slot_holds h WHERE h.availability_id = $1
                AND h.status = 'active' AND h.expires_at > NOW()) AS has_active_payment_hold`, [slot.id],
    );
    const occupancy = await countOccupiedPlaces(database, slot.id);
    const row = detail.rows[0] || {};
    const reasons = [];
    if (scheduleOverlaps.length) reasons.push("schedule_overlap");
    if (row.has_confirmed_appointment) reasons.push("confirmed_appointment");
    if (row.has_active_reservation) reasons.push("active_reservation");
    if (row.has_active_payment_hold) reasons.push("payment_hold");
    if (occupancy >= Number(slot.capacity || 1)) reasons.push("capacity_reached");
    if (reasons.length) items.push({ date: slot.date, start_time: slot.start_time, end_time: slot.end_time,
      mode: slot.mode || "legacy", capacity: Number(slot.capacity || 1), occupied: occupancy,
      remaining_capacity: Math.max(Number(slot.capacity || 1) - occupancy, 0), conflicts: reasons });
    if (items.length > limit) break;
  }
  return { conflicts: items.slice(0, limit), truncated: items.length > limit || slots.rows.length > 500, notice: POINT_IN_TIME_NOTICE };
}

module.exports = { POINT_IN_TIME_NOTICE, getConflicts, getExceptions, getSchedules, requireDoctorId };
