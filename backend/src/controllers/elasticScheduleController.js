const { localDateTime } = require("../utils/schedulingTime");
const { eachDateInclusive } = require("../utils/dateOnly");
const { findSchedulePeriodOverlaps } = require("../services/schedulePeriodConflictService");
const { failForProtectedAppointments, findProtectedAppointmentsByIds } = require("../services/scheduleProtectionService");

function fail(response, status, code, message) {
  return response.status(status).json({ error: { code, message } });
}

async function owner(response, doctorId) {
  if (response.locals.user.role !== "doctor") return false;
  const result = await response.locals.database.query(
    "SELECT id, appointment_duration_minutes FROM doctors WHERE user_id = $1",
    [response.locals.user.id],
  );
  return result.rows[0]?.id === doctorId ? result.rows[0] : false;
}

async function loadSchedule(database, doctorId, scheduleId, lock = false) {
  const schedule = await database.query(
    `SELECT id, doctor_id, mode, recurrence_type, visibility,
            starts_on::text AS starts_on, ends_on::text AS ends_on,
            wave_capacity_per_slot, stream_capacity_per_window,
            to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at
     FROM doctor_schedules
     WHERE id = $1 AND doctor_id = $2 AND active AND archived_at IS NULL
     ${lock ? "FOR UPDATE" : ""}`,
    [scheduleId, doctorId],
  );
  if (!schedule.rows[0]) return null;
  const periods = await database.query(
    `SELECT weekday, start_time::text AS start_time, end_time::text AS end_time
     FROM doctor_schedule_periods WHERE schedule_id = $1 ORDER BY weekday, start_time`,
    [scheduleId],
  );
  return { ...schedule.rows[0], periods: periods.rows };
}

function desiredWindows(schedule, input, doctor, exceptions, timeZone) {
  const now = localDateTime(timeZone);
  const windows = new Map();
  for (const date of eachDateInclusive(input.starts_on, input.ends_on)) {
    const weekday = new Date(`${date}T00:00:00.000Z`).getUTCDay();
    const exception = exceptions.get(date);
    if (exception?.exception_type === "day_off") continue;
    let periods = input.periods.filter((period) => period.weekday === weekday);
    if (exception?.exception_type === "override") periods = exception.periods;
    if (exception?.exception_type === "additional") periods = [...periods, ...exception.periods];
    for (const period of periods) {
      let minute = Number(period.start_time.slice(0, 2)) * 60 + Number(period.start_time.slice(3, 5));
      const end = Number(period.end_time.slice(0, 2)) * 60 + Number(period.end_time.slice(3, 5));
      const duration = schedule.mode === "stream" ? end - minute : doctor.appointment_duration_minutes;
      while (minute + duration <= end) {
        const startTime = `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
        const endMinute = minute + duration;
        const endTime = `${String(Math.floor(endMinute / 60)).padStart(2, "0")}:${String(endMinute % 60).padStart(2, "0")}`;
        if (date > now.date || (date === now.date && startTime > now.time)) {
          windows.set(`${date}|${startTime}|${endTime}`, { date, start_time: startTime, end_time: endTime });
        }
        if (schedule.mode === "stream") break;
        minute += duration;
      }
    }
  }
  return windows;
}

function hasAdditionalExceptionOverlap(input, exceptions) {
  for (const exception of exceptions.values()) {
    if (exception.exception_type !== "additional") continue;
    const weekday = new Date(`${exception.service_date}T00:00:00Z`).getUTCDay();
    const weeklyPeriods = input.periods.filter((period) => period.weekday === weekday);
    if (weeklyPeriods.some((weekly) => exception.periods.some((extra) =>
      weekly.start_time < extra.end_time.slice(0, 5) && weekly.end_time > extra.start_time.slice(0, 5)))) return true;
  }
  return false;
}

async function readExceptions(database, scheduleId, from, to) {
  const exceptions = await database.query(
    `SELECT id, service_date::text AS service_date, exception_type
     FROM doctor_schedule_exceptions
     WHERE schedule_id = $1 AND service_date BETWEEN $2::date AND $3::date`,
    [scheduleId, from, to],
  );
  const result = new Map();
  for (const exception of exceptions.rows) {
    const periods = exception.exception_type === "day_off" ? { rows: [] } : await database.query(
      `SELECT start_time::text AS start_time, end_time::text AS end_time
       FROM doctor_schedule_exception_periods WHERE exception_id = $1 ORDER BY start_time`, [exception.id],
    );
    result.set(exception.service_date, { ...exception, periods: periods.rows });
  }
  return result;
}

async function inspectDiff(database, schedule, desired, today) {
  const rows = await database.query(
    `SELECT av.id, av.date::text AS date, av.start_time::text AS start_time,
            av.end_time::text AS end_time, av.capacity,
            EXISTS (SELECT 1 FROM appointments a WHERE a.availability_id = av.id AND a.status = 'confirmed') AS has_confirmed_appointment,
            EXISTS (SELECT 1 FROM appointment_allocations a WHERE a.availability_id = av.id
              AND ((a.status = 'held' AND a.expires_at > NOW())
            OR (a.status = 'confirmed' AND (EXISTS (SELECT 1 FROM appointments linked
              WHERE linked.allocation_id = a.id AND linked.status = 'confirmed') OR NOT EXISTS
              (SELECT 1 FROM appointments linked WHERE linked.allocation_id = a.id))))) AS has_active_allocation,
            EXISTS (SELECT 1 FROM appointment_slot_holds h WHERE h.availability_id = av.id AND h.status = 'active' AND h.expires_at > NOW()) AS has_active_payment_hold
     FROM availability av
     WHERE av.schedule_id = $1 AND av.deleted_at IS NULL
       AND av.date >= $2::date
     ORDER BY av.id`, [schedule.id, today],
  );
  return { rows: rows.rows, ...buildAvailabilityDiff(rows.rows, desired, schedule.mode) };
}

async function findSavedSchedulePeriodConflicts(database, doctorId, scheduleId, input) {
  const conflicts = [];
  for (const proposed of input.periods) {
    const rows = await findSchedulePeriodOverlaps(database, doctorId, proposed, { ...input, recurrence_type: "weekly" }, scheduleId);
    for (const row of rows) conflicts.push({
      weekday: proposed.weekday,
      proposed_start_time: proposed.start_time,
      proposed_end_time: proposed.end_time,
      existing_schedule_id: row.schedule_id,
      existing_recurrence_type: row.recurrence_type,
      existing_weekday: row.weekday,
      existing_service_date: row.service_date,
      existing_start_time: row.start_time.slice(0, 5),
      existing_end_time: row.end_time.slice(0, 5),
    });
  }
  return conflicts;
}

async function findWindowBlockers(database, doctorId, scheduleId, desired, savedScheduleConflicts, resizableKeys = new Set(), reconcilableKeys = new Set()) {
  const windows = [...desired.values()];
  if (!windows.length) return [];
  const from = windows.reduce((value, item) => item.date < value ? item.date : value, windows[0].date);
  const to = windows.reduce((value, item) => item.date > value ? item.date : value, windows[0].date);
  const [availability, appointments, reservations] = await Promise.all([
    database.query(
      `SELECT id, schedule_id, date::text AS date, start_time::text AS start_time, end_time::text AS end_time
       FROM availability WHERE doctor_id = $1 AND deleted_at IS NULL AND date BETWEEN $2::date AND $3::date`,
      [doctorId, from, to],
    ),
    database.query(
      `SELECT av.schedule_id, scheduled_date::text AS date,
              scheduled_start_time::text AS start_time,
              scheduled_end_time::text AS end_time
       FROM appointments a JOIN availability av ON av.id = a.availability_id
       WHERE av.doctor_id = $1 AND a.status = 'confirmed'
         AND a.scheduled_date BETWEEN $2::date AND $3::date`,
      [doctorId, from, to],
    ),
    database.query(
      `SELECT DISTINCT av.schedule_id, av.date::text AS date,
              av.start_time::text AS start_time, av.end_time::text AS end_time,
              EXISTS (SELECT 1 FROM appointment_slot_holds h
                WHERE h.availability_id = av.id AND h.status = 'active' AND h.expires_at > NOW()) AS has_payment_hold,
              EXISTS (SELECT 1 FROM appointment_allocations a
                WHERE a.availability_id = av.id
                  AND ((a.status = 'held' AND a.expires_at > NOW())
                    OR (a.status = 'confirmed' AND (EXISTS (SELECT 1 FROM appointments linked
                      WHERE linked.allocation_id = a.id AND linked.status = 'confirmed') OR NOT EXISTS
                      (SELECT 1 FROM appointments linked WHERE linked.allocation_id = a.id))))) AS has_allocation
       FROM availability av
       WHERE av.doctor_id = $1 AND av.date BETWEEN $2::date AND $3::date
         AND (EXISTS (SELECT 1 FROM appointment_slot_holds h
                WHERE h.availability_id = av.id AND h.status = 'active' AND h.expires_at > NOW())
           OR EXISTS (SELECT 1 FROM appointment_allocations a
                WHERE a.availability_id = av.id
                  AND ((a.status = 'held' AND a.expires_at > NOW())
                    OR (a.status = 'confirmed' AND (EXISTS (SELECT 1 FROM appointments linked
                      WHERE linked.allocation_id = a.id AND linked.status = 'confirmed') OR NOT EXISTS
                      (SELECT 1 FROM appointments linked WHERE linked.allocation_id = a.id))))))`,
      [doctorId, from, to],
    ),
  ]);
  return windows.flatMap((window) => {
    const weekday = new Date(`${window.date}T00:00:00Z`).getUTCDay();
    const reasons = new Set();
    if (savedScheduleConflicts.some((conflict) => conflict.weekday === weekday
      && window.start_time < conflict.existing_end_time && window.end_time > conflict.existing_start_time)) {
      reasons.add("overlaps_saved_schedule_period");
    }
    if (availability.rows.some((row) => row.schedule_id !== scheduleId && row.date === window.date
      && window.start_time < row.end_time.slice(0, 5) && window.end_time > row.start_time.slice(0, 5))) {
      reasons.add("overlaps_other_availability");
    }
    if (appointments.rows.some((row) => !(row.schedule_id === scheduleId
      && (resizableKeys.has(`${window.date}|${window.start_time}|${window.end_time}`)
        || reconcilableKeys.has(`${window.date}|${window.start_time}|${window.end_time}`)))
      && row.date === window.date
      && window.start_time < row.end_time.slice(0, 5) && window.end_time > row.start_time.slice(0, 5))) {
      reasons.add("overlaps_confirmed_appointment");
    }
    for (const row of reservations.rows) {
      if (row.schedule_id === scheduleId && (resizableKeys.has(`${window.date}|${window.start_time}|${window.end_time}`)
        || reconcilableKeys.has(`${window.date}|${window.start_time}|${window.end_time}`))
        && !row.has_payment_hold) continue;
      if (row.date !== window.date || window.start_time >= row.end_time.slice(0, 5)
          || window.end_time <= row.start_time.slice(0, 5)) continue;
      if (row.has_payment_hold) reasons.add("overlaps_active_payment_hold");
      if (row.has_allocation) reasons.add("overlaps_active_allocation");
    }
    return reasons.size ? [{ ...window, reasons: [...reasons] }] : [];
  });
}

function splitStreamWindowsAroundAppointments(windows, appointments) {
  return windows.flatMap((window) => {
    const overlapping = appointments.filter((appointment) => appointment.date === window.date)
      .map((appointment) => ({ start_time: appointment.start_time.slice(0, 5), end_time: appointment.end_time.slice(0, 5) }))
      .sort((a, b) => a.start_time.localeCompare(b.start_time));
    let segments = [window];
    for (const appointment of overlapping) {
      segments = segments.flatMap((segment) => {
        if (appointment.start_time >= segment.end_time || appointment.end_time <= segment.start_time) return [segment];
        const available = [];
        if (appointment.start_time > segment.start_time) available.push({ ...segment, end_time: appointment.start_time });
        if (appointment.end_time < segment.end_time) available.push({ ...segment, start_time: appointment.end_time });
        return available;
      });
    }
    return segments;
  });
}

function excludeRetiringWindowAppointments(appointments, retiringRows) {
  const retiringIds = new Set(retiringRows.map((row) => row.id));
  return appointments.filter((appointment) => !retiringIds.has(appointment.availability_id));
}

function reconcileStreamCapacity(candidate, configuredCapacity, occupiedPlaces) {
  return { ...candidate, capacity: Math.max(configuredCapacity - occupiedPlaces, 0) };
}

function appointmentCoveredBySchedule(appointment, input, exceptions) {
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

async function inspectRemovedReservations(database, retire, input, exceptions) {
  const ids = retire.map((row) => row.id);
  if (!ids.length) return { affectedAppointments: [], activePaymentHolds: [], activeAllocations: [] };
  const [appointments, holds, allocations] = await Promise.all([
    database.query(
      `SELECT a.id, a.availability_id, a.allocation_id, a.status, a.scheduled_date::text AS date,
              a.scheduled_start_time::text AS start_time, a.scheduled_end_time::text AS end_time
       FROM appointments a WHERE a.availability_id = ANY($1::uuid[]) AND a.status = 'confirmed'
       ORDER BY a.scheduled_date, a.scheduled_start_time`, [ids],
    ),
    database.query(
      `SELECT h.id, h.availability_id, av.date::text AS date,
              av.start_time::text AS start_time, av.end_time::text AS end_time, h.expires_at
       FROM appointment_slot_holds h JOIN availability av ON av.id = h.availability_id
       WHERE h.availability_id = ANY($1::uuid[]) AND h.status = 'active' AND h.expires_at > NOW()
       ORDER BY av.date, av.start_time`, [ids],
    ),
    database.query(
      `SELECT allocation.id, allocation.availability_id, allocation.status,
              allocation.expires_at, av.date::text AS date,
              av.start_time::text AS start_time, av.end_time::text AS end_time
       FROM appointment_allocations allocation JOIN availability av ON av.id = allocation.availability_id
       WHERE allocation.availability_id = ANY($1::uuid[])
         AND ((allocation.status = 'held' AND allocation.expires_at > NOW())
           OR (allocation.status = 'confirmed' AND (EXISTS (SELECT 1 FROM appointments linked
             WHERE linked.allocation_id = allocation.id AND linked.status = 'confirmed') OR NOT EXISTS
             (SELECT 1 FROM appointments linked WHERE linked.allocation_id = allocation.id))))
       ORDER BY av.date, av.start_time`, [ids],
    ),
  ]);
  const linkedAllocationIds = new Set(appointments.rows.map((appointment) => appointment.allocation_id).filter(Boolean));
  return {
    affectedAppointments: appointments.rows.filter((appointment) => !appointmentCoveredBySchedule(appointment, input, exceptions)),
    activePaymentHolds: holds.rows,
    activeAllocations: allocations.rows.filter((allocation) => !linkedAllocationIds.has(allocation.id)),
  };
}

function buildAvailabilityDiff(rows, desired, mode = null) {
  const existingByKey = new Map(rows.map((row) => [`${row.date}|${row.start_time.slice(0, 5)}|${row.end_time.slice(0, 5)}`, row]));
  const resized = [];
  const resizedRows = new Set();
  const resizedKeys = new Set();
  if (mode === "stream") {
    for (const window of desired.values()) {
      if (existingByKey.has(`${window.date}|${window.start_time}|${window.end_time}`)) continue;
      const reusable = rows.find((row) => row.date === window.date && !row.has_active_payment_hold
        && window.start_time <= row.start_time.slice(0, 5) && window.end_time >= row.end_time.slice(0, 5)
        && (window.start_time < row.start_time.slice(0, 5) || window.end_time > row.end_time.slice(0, 5))
        && !resizedRows.has(row.id));
      if (reusable) {
        resized.push({ availability_id: reusable.id, date: window.date,
          previous_start_time: reusable.start_time.slice(0, 5), previous_end_time: reusable.end_time.slice(0, 5),
          start_time: window.start_time, end_time: window.end_time });
        resizedRows.add(reusable.id);
        resizedKeys.add(`${window.date}|${window.start_time}|${window.end_time}`);
      }
    }
  }
  const retire = rows.filter((row) => !resizedRows.has(row.id)
    && !desired.has(`${row.date}|${row.start_time.slice(0, 5)}|${row.end_time.slice(0, 5)}`));
  const add = [...desired.values()].filter((window) => !existingByKey.has(`${window.date}|${window.start_time}|${window.end_time}`)
    && !resizedKeys.has(`${window.date}|${window.start_time}|${window.end_time}`));
  const affected = retire.map((row) => ({
    availability_id: row.id,
    date: row.date,
    start_time: row.start_time.slice(0, 5),
    end_time: row.end_time.slice(0, 5),
    has_confirmed_appointment: row.has_confirmed_appointment,
    has_active_allocation: row.has_active_allocation,
    has_active_payment_hold: row.has_active_payment_hold,
  }));
  return { retire, add, resized, kept: rows.length - retire.length - resized.length, affected };
}

function filterBlockedAdditions(additions, blocked) {
  const blockedKeys = new Set(blocked.map((item) => `${item.date}|${item.start_time}|${item.end_time}`));
  return additions.filter((item) => !blockedKeys.has(`${item.date}|${item.start_time}|${item.end_time}`));
}

function isStaleScheduleVersion(currentVersion, expectedVersion) {
  return currentVersion !== expectedVersion;
}

async function loadInputs(response, doctorId, scheduleId, input) {
  const schedule = await loadSchedule(response.locals.database, doctorId, scheduleId);
  if (!schedule || schedule.recurrence_type !== "weekly") return { error: "SCHEDULE_NOT_FOUND" };
  if (schedule.mode !== input.mode) return { error: "SCHEDULE_MODE_CONFLICT" };
  // Wave slot boundaries follow the doctor's current profile duration, matching the
  // existing generation endpoint; no duration snapshot is stored on weekly schedules.
  const doctorResult = await response.locals.database.query(
    "SELECT appointment_duration_minutes FROM doctors WHERE id = $1", [doctorId],
  );
  const doctor = doctorResult.rows[0];
  const exceptions = await readExceptions(response.locals.database, scheduleId, input.starts_on, input.ends_on);
  if (hasAdditionalExceptionOverlap(input, exceptions)) return { error: "SCHEDULE_EXCEPTION_CONFLICT" };
  const desired = desiredWindows(schedule, input, doctor, exceptions, response.locals.applicationTimezone || "Asia/Kolkata");
  const today = localDateTime(response.locals.applicationTimezone || "Asia/Kolkata").date;
  const diff = await inspectDiff(response.locals.database, schedule, desired, today);
  const savedScheduleConflicts = await findSavedSchedulePeriodConflicts(response.locals.database, doctorId, scheduleId, input);
  let candidates = diff.add;
  if (candidates.length) {
    const from = candidates.reduce((value, item) => item.date < value ? item.date : value, candidates[0].date);
    const to = candidates.reduce((value, item) => item.date > value ? item.date : value, candidates[0].date);
    const excluded = await response.locals.database.query(
      `SELECT removed.date::text AS date, removed.start_time::text AS start_time, removed.end_time::text AS end_time
       FROM availability removed
       JOIN doctor_schedule_windows schedule_window ON schedule_window.id = removed.schedule_window_id
       WHERE removed.schedule_id = $1 AND removed.deleted_at IS NOT NULL AND schedule_window.deleted_at IS NULL
         AND removed.date BETWEEN $2::date AND $3::date`, [scheduleId, from, to],
    );
    const excludedKeys = new Set(excluded.rows.map((row) =>
      `${row.date}|${row.start_time.slice(0, 5)}|${row.end_time.slice(0, 5)}`));
    candidates = candidates.filter((candidate) =>
      !excludedKeys.has(`${candidate.date}|${candidate.start_time}|${candidate.end_time}`));
  }
  if (schedule.mode === "stream" && candidates.length) {
    const from = candidates.reduce((value, item) => item.date < value ? item.date : value, candidates[0].date);
    const to = candidates.reduce((value, item) => item.date > value ? item.date : value, candidates[0].date);
    const appointments = await response.locals.database.query(
      `SELECT av.id AS availability_id, av.schedule_id, scheduled_date::text AS date,
              scheduled_start_time::text AS start_time, scheduled_end_time::text AS end_time
       FROM appointments a JOIN availability av ON av.id = a.availability_id
       WHERE av.doctor_id = $1 AND a.status = 'confirmed'
         AND a.scheduled_date BETWEEN $2::date AND $3::date`, [doctorId, from, to],
    );
    const retiredRows = await response.locals.database.query(
      `SELECT av.id, av.date::text AS date, av.start_time::text AS start_time, av.end_time::text AS end_time,
              EXISTS (SELECT 1 FROM appointments a WHERE a.availability_id = av.id AND a.status = 'confirmed') AS has_confirmed_appointment,
              EXISTS (SELECT 1 FROM appointment_allocations allocation WHERE allocation.availability_id = av.id
                AND ((allocation.status = 'held' AND allocation.expires_at > NOW()) OR
                  (allocation.status = 'confirmed' AND (EXISTS (SELECT 1 FROM appointments linked
                    WHERE linked.allocation_id = allocation.id AND linked.status = 'confirmed') OR NOT EXISTS
                    (SELECT 1 FROM appointments linked WHERE linked.allocation_id = allocation.id))))) AS has_active_allocation,
              EXISTS (SELECT 1 FROM appointment_slot_holds hold WHERE hold.availability_id = av.id
                AND hold.status = 'active' AND hold.expires_at > NOW()) AS has_active_payment_hold
       FROM availability av
       WHERE av.schedule_id = $1 AND av.deleted_at IS NOT NULL AND av.date BETWEEN $2::date AND $3::date
         AND (EXISTS (SELECT 1 FROM appointments a WHERE a.availability_id = av.id AND a.status = 'confirmed')
           OR EXISTS (SELECT 1 FROM appointment_allocations allocation WHERE allocation.availability_id = av.id
             AND ((allocation.status = 'held' AND allocation.expires_at > NOW()) OR
               (allocation.status = 'confirmed' AND (EXISTS (SELECT 1 FROM appointments linked
                 WHERE linked.allocation_id = allocation.id AND linked.status = 'confirmed') OR NOT EXISTS
                 (SELECT 1 FROM appointments linked WHERE linked.allocation_id = allocation.id)))))
           OR EXISTS (SELECT 1 FROM appointment_slot_holds hold WHERE hold.availability_id = av.id
             AND hold.status = 'active' AND hold.expires_at > NOW()))`, [scheduleId, from, to],
    );
    const reconciliationRows = [...diff.retire, ...retiredRows.rows].filter((row) => candidates.some((candidate) =>
      row.date === candidate.date && candidate.start_time < row.end_time.slice(0, 5)
        && candidate.end_time > row.start_time.slice(0, 5)));
    candidates = splitStreamWindowsAroundAppointments(candidates,
      excludeRetiringWindowAppointments(appointments.rows, reconciliationRows));
    diff.streamReconciliationRows = reconciliationRows;
  }
  const reconcilableKeys = new Set();
  if (schedule.mode === "stream") {
    for (const candidate of candidates) {
      const old = (diff.streamReconciliationRows ?? diff.retire).filter((row) => row.date === candidate.date
        && candidate.start_time < row.end_time.slice(0, 5) && candidate.end_time > row.start_time.slice(0, 5));
      if (!old.some((row) => row.has_confirmed_appointment || row.has_active_allocation)) continue;
      const key = `${candidate.date}|${candidate.start_time}|${candidate.end_time}`;
      reconcilableKeys.add(key);
      const occupied = await response.locals.database.query(
        `SELECT COUNT(DISTINCT reservation.patient_id)::int AS count FROM (
           SELECT allocation.patient_id FROM appointment_allocations allocation
           WHERE allocation.availability_id = ANY($1::uuid[])
             AND ((allocation.status = 'held' AND allocation.expires_at > NOW()) OR
               (allocation.status = 'confirmed' AND (EXISTS (SELECT 1 FROM appointments linked WHERE linked.allocation_id = allocation.id AND linked.status = 'confirmed')
                 OR NOT EXISTS (SELECT 1 FROM appointments linked WHERE linked.allocation_id = allocation.id))))
           UNION SELECT appointment.patient_id FROM appointments appointment
             WHERE appointment.availability_id = ANY($1::uuid[]) AND appointment.status = 'confirmed'
             AND NOT EXISTS (SELECT 1 FROM appointment_allocations allocation WHERE allocation.id = appointment.allocation_id
               AND allocation.availability_id = appointment.availability_id
               AND ((allocation.status = 'held' AND allocation.expires_at > NOW()) OR (allocation.status = 'confirmed'
                 AND (EXISTS (SELECT 1 FROM appointments linked WHERE linked.allocation_id = allocation.id AND linked.status = 'confirmed')
                   OR NOT EXISTS (SELECT 1 FROM appointments linked WHERE linked.allocation_id = allocation.id)))))
         ) reservation`, [old.map((row) => row.id)],
      );
      Object.assign(candidate, reconcileStreamCapacity(candidate, schedule.stream_capacity_per_window,
        Number(occupied.rows[0]?.count ?? 0)));
    }
    // Only reservation-backed replacement windows receive a reduced capacity. Ordinary
    // additions have no explicit capacity and must retain the schedule's configured value.
    candidates = candidates.filter((candidate) => candidate.capacity === undefined || candidate.capacity > 0);
  }
  const resizeCandidates = diff.resized.map(({ date, start_time, end_time }) => ({ date, start_time, end_time }));
  const resizeKeys = new Set(resizeCandidates.map((window) => `${window.date}|${window.start_time}|${window.end_time}`));
  const blocked = await findWindowBlockers(response.locals.database, doctorId, scheduleId,
    [...candidates, ...resizeCandidates], savedScheduleConflicts, resizeKeys, reconcilableKeys);
  const blockedKeys = new Set(blocked.map((window) => `${window.date}|${window.start_time}|${window.end_time}`));
  const blockedResize = diff.resized.filter((window) => blockedKeys.has(`${window.date}|${window.start_time}|${window.end_time}`));
  for (const resize of blockedResize) {
    const row = diff.rows.find((availability) => availability.id === resize.availability_id);
    if (!row) continue;
    diff.retire.push(row);
    diff.affected.push({ availability_id: row.id, date: row.date, start_time: row.start_time.slice(0, 5),
      end_time: row.end_time.slice(0, 5), has_confirmed_appointment: row.has_confirmed_appointment,
      has_active_allocation: row.has_active_allocation, has_active_payment_hold: row.has_active_payment_hold });
  }
  diff.resized = diff.resized.filter((window) => !blockedKeys.has(`${window.date}|${window.start_time}|${window.end_time}`));
  const additions = filterBlockedAdditions(candidates, blocked);
  const reservations = await inspectRemovedReservations(response.locals.database, diff.retire, input, exceptions);
  return { schedule, doctor, exceptions, desired, diff, savedScheduleConflicts, blocked, additions, ...reservations };
}

async function previewScheduleUpdate(_request, response, next) {
  const { id, scheduleId } = response.locals.params;
  if (!await owner(response, id)) return fail(response, 403, "FORBIDDEN", "Only the owning doctor may preview schedule changes");
  try {
    const loaded = await loadInputs(response, id, scheduleId, response.locals.body);
    if (loaded.error === "SCHEDULE_NOT_FOUND") return fail(response, 404, loaded.error, "Active weekly schedule not found");
    if (loaded.error === "SCHEDULE_EXCEPTION_CONFLICT") return fail(response, 409, loaded.error, "The proposed weekly hours overlap a saved additional-hours exception");
    if (loaded.error) return fail(response, 409, loaded.error, "The proposed schedule mode does not match the saved schedule");
    const { schedule, doctor, diff, savedScheduleConflicts, blocked, additions, affectedAppointments, activePaymentHolds, activeAllocations } = loaded;
    return response.json({
      schedule_id: schedule.id,
      schedule_updated_at: schedule.updated_at,
      mode: schedule.mode,
      wave_appointment_duration_minutes: schedule.mode === "wave" ? doctor.appointment_duration_minutes : null,
      added_availability: additions,
      resized_availability: diff.resized,
      blocked_availability: blocked,
      saved_schedule_period_conflicts: savedScheduleConflicts,
      can_update: savedScheduleConflicts.length === 0 && activePaymentHolds.length === 0,
      ...(activePaymentHolds.length ? { update_block_reason: "ACTIVE_PAYMENT_HOLD" } : {}),
      removed_availability: diff.affected,
      affected_appointments: affectedAppointments,
      active_payment_holds: activePaymentHolds,
      active_allocations: activeAllocations,
      unchanged_count: diff.kept,
      exceptions_preserved: true,
    });
  } catch (error) { return next(error); }
}

async function updateSchedule(_request, response, next) {
  const { id, scheduleId } = response.locals.params;
  if (!await owner(response, id)) return fail(response, 403, "FORBIDDEN", "Only the owning doctor may update schedules");
  const input = response.locals.body;
  const client = await response.locals.database.connect();
  try {
    await client.query("BEGIN");
    // Schedule first matches generation and exception writers. Availability rows are then
    // locked in ID order, followed by the doctor lock used by booking and checkout.
    const lockedSchedule = await client.query(
      `SELECT id, doctor_id FROM doctor_schedules
       WHERE id = $1 AND doctor_id = $2 AND active AND archived_at IS NULL
       FOR UPDATE`, [scheduleId, id],
    );
    if (!lockedSchedule.rows[0]) { await client.query("ROLLBACK"); return fail(response, 404, "SCHEDULE_NOT_FOUND", "Active weekly schedule not found"); }
    const current = await loadSchedule(client, id, scheduleId);
    if (current.recurrence_type !== "weekly" || current.mode !== input.mode) {
      await client.query("ROLLBACK");
      return fail(response, 409, "SCHEDULE_MODE_CONFLICT", "This endpoint updates an existing weekly schedule without changing its mode");
    }
    if (isStaleScheduleVersion(current.updated_at, input.expected_updated_at)) {
      await client.query("ROLLBACK");
      return fail(response, 409, "SCHEDULE_PREVIEW_STALE", "The saved schedule changed after preview. Refresh and preview again.");
    }
    const now = localDateTime(response.locals.applicationTimezone || "Asia/Kolkata");
    await client.query(
      `SELECT av.id FROM availability av
       WHERE av.schedule_id = $1 AND av.deleted_at IS NULL AND av.date >= $2::date
       ORDER BY av.id FOR UPDATE`, [scheduleId, now.date],
    );
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [id]);

    const loaded = await loadInputs({ ...response, locals: { ...response.locals, database: client } }, id, scheduleId, input);
    if (loaded.error === "SCHEDULE_EXCEPTION_CONFLICT") {
      await client.query("ROLLBACK");
      return fail(response, 409, loaded.error, "The proposed weekly hours overlap a saved additional-hours exception");
    }
    if (loaded.error) { await client.query("ROLLBACK"); return fail(response, 409, "SCHEDULE_PREVIEW_STALE", "The saved schedule could not be reloaded; preview the change again."); }
    const { schedule, doctor, desired, diff, savedScheduleConflicts, blocked, additions } = loaded;
    const protectedAppointments = await findProtectedAppointmentsByIds(
      client, loaded.affectedAppointments.map((appointment) => appointment.id),
      response.locals.applicationTimezone || "Asia/Kolkata",
    );
    if (failForProtectedAppointments(response, protectedAppointments)) { await client.query("ROLLBACK"); return; }
    if (loaded.activePaymentHolds.length) {
      await client.query("ROLLBACK");
      return response.status(409).json({ error: { code: "ACTIVE_PAYMENT_HOLD", message: "An active payment hold uses availability that this update would retire. Wait for payment to finish or expire, then preview the schedule again." }, active_payment_holds: loaded.activePaymentHolds });
    }
    if (savedScheduleConflicts.length) {
      await client.query("ROLLBACK");
      return response.status(409).json({
        error: { code: "SCHEDULE_PERIOD_CONFLICT", message: "The proposed weekly periods overlap another active saved schedule." },
        conflicts: savedScheduleConflicts,
      });
    }

    for (const row of diff.retire) {
      await client.query("UPDATE availability SET deleted_at = NOW(), updated_at = NOW() WHERE id = $1 AND deleted_at IS NULL", [row.id]);
      await client.query("UPDATE doctor_schedule_windows SET deleted_at = NOW() WHERE id = (SELECT schedule_window_id FROM availability WHERE id = $1) AND deleted_at IS NULL", [row.id]);
    }
    for (const row of diff.resized) {
      await client.query(
        `UPDATE availability SET start_time = $2::time, end_time = $3::time, updated_at = NOW()
         WHERE id = $1 AND schedule_id = $4 AND deleted_at IS NULL`,
        [row.availability_id, row.start_time, row.end_time, scheduleId],
      );
      await client.query(
        `UPDATE doctor_schedule_windows SET start_time = $2::time, end_time = $3::time
         WHERE id = (SELECT schedule_window_id FROM availability WHERE id = $1) AND schedule_id = $4 AND deleted_at IS NULL`,
        [row.availability_id, row.start_time, row.end_time, scheduleId],
      );
    }
    const generated = [];
    for (const window of additions) {
      if (window.date === now.date && window.start_time <= now.time) continue;
      const capacity = window.capacity ?? (schedule.mode === "wave" ? schedule.wave_capacity_per_slot : schedule.stream_capacity_per_window);
      const windowRow = await client.query(
        `INSERT INTO doctor_schedule_windows (schedule_id, doctor_id, mode, visibility, service_date,
           start_time, end_time, wave_capacity_per_slot, stream_capacity_per_window)
         VALUES ($1,$2,$3,$4,$5::date,$6::time,$7::time,$8,$9) RETURNING id`,
        [scheduleId, id, schedule.mode, schedule.visibility, window.date, window.start_time, window.end_time,
          schedule.wave_capacity_per_slot, schedule.stream_capacity_per_window],
      );
      const availability = await client.query(
        `INSERT INTO availability (doctor_id, date, start_time, end_time, schedule_window_id, schedule_id, mode, booking_visibility, capacity)
         VALUES ($1,$2::date,$3::time,$4::time,$5,$6,$7,$8,$9) RETURNING id`,
        [id, window.date, window.start_time, window.end_time, windowRow.rows[0].id, scheduleId, schedule.mode, schedule.visibility, capacity],
      );
      generated.push({ ...window, availability_id: availability.rows[0].id });
    }
    await client.query("DELETE FROM doctor_schedule_periods WHERE schedule_id = $1", [scheduleId]);
    for (const period of input.periods) await client.query(
      `INSERT INTO doctor_schedule_periods (schedule_id, recurrence_type, weekday, service_date, start_time, end_time)
       VALUES ($1,'weekly',$2,NULL,$3::time,$4::time)`, [scheduleId, period.weekday, period.start_time, period.end_time],
    );
    await client.query(
      `UPDATE doctor_schedules SET starts_on = $2::date, ends_on = $3::date, updated_at = NOW()
       WHERE id = $1`, [scheduleId, input.starts_on, input.ends_on],
    );
    await client.query("COMMIT");
    return response.json({
      schedule_id: scheduleId,
      generated,
      added_count: generated.length,
      resized_count: diff.resized.length,
      retired: diff.affected,
      removed_count: diff.affected.length,
      unchanged_count: diff.kept,
      blocked_availability: blocked,
      wave_appointment_duration_minutes: schedule.mode === "wave" ? doctor.appointment_duration_minutes : null,
      exceptions_preserved: true,
    });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    if (error.code === "23P01" || error.code === "23505") return fail(response, 409, "SCHEDULE_CONFLICT", "The updated schedule overlaps existing availability");
    return next(error);
  } finally { client.release(); }
}

module.exports = {
  buildAvailabilityDiff,
  desiredWindows,
  filterBlockedAdditions,
  findSavedSchedulePeriodConflicts,
  findWindowBlockers,
  hasAdditionalExceptionOverlap,
  appointmentCoveredBySchedule,
  inspectDiff,
  inspectRemovedReservations,
  isStaleScheduleVersion,
  splitStreamWindowsAroundAppointments,
  loadInputs,
  excludeRetiringWindowAppointments,
  reconcileStreamCapacity,
  previewScheduleUpdate,
  updateSchedule,
};
