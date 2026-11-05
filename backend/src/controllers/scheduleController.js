const { localDateTime } = require("../utils/schedulingTime");

async function owner(response, doctorId) {
  if (response.locals.user.role !== "doctor") return false;
  const result = await response.locals.database.query("SELECT id, appointment_duration_minutes FROM doctors WHERE user_id = $1", [response.locals.user.id]);
  return result.rows[0]?.id === doctorId ? result.rows[0] : false;
}
function fail(response, status, code, message) { return response.status(status).json({ error: { code, message } }); }

async function listSchedules(_request, response, next) {
  try {
    const { id } = response.locals.params;
    const rows = await response.locals.database.query(
      `SELECT s.*, COALESCE(json_agg(json_build_object('weekday', p.weekday, 'service_date', p.service_date, 'start_time', p.start_time, 'end_time', p.end_time)) FILTER (WHERE p.id IS NOT NULL), '[]') AS periods
       FROM doctor_schedules s LEFT JOIN doctor_schedule_periods p ON p.schedule_id = s.id
       WHERE s.doctor_id = $1 AND (s.visibility = 'public' OR s.doctor_id = (SELECT id FROM doctors WHERE user_id = $2))
       GROUP BY s.id ORDER BY s.created_at DESC`, [id, response.locals.user?.id ?? null],
    );
    return response.json(rows.rows);
  } catch (error) { return next(error); }
}

async function createSchedule(_request, response, next) {
  const { id } = response.locals.params;
  const doctor = await owner(response, id);
  if (!doctor) return fail(response, 403, "FORBIDDEN", "Only the owning doctor may manage schedules");
  const input = response.locals.body;
  const client = await response.locals.database.connect();
  try {
    await client.query("BEGIN");
    const inserted = await client.query(
      `INSERT INTO doctor_schedules (doctor_id, mode, recurrence_type, visibility, starts_on, ends_on, time_zone, wave_capacity_per_slot, stream_capacity_per_window)
       VALUES ($1,$2,$3,$4,$5::date,$6::date,$7,$8,$9) RETURNING *`,
      [id, input.mode, input.recurrence_type, input.visibility, input.starts_on ?? null, input.ends_on ?? null, response.locals.applicationTimezone || "Asia/Kolkata", input.wave_capacity_per_slot, input.stream_capacity_per_window],
    );
    for (const period of input.periods) await client.query(
      `INSERT INTO doctor_schedule_periods (schedule_id, recurrence_type, weekday, service_date, start_time, end_time) VALUES ($1,$2,$3,$4::date,$5::time,$6::time)`,
      [inserted.rows[0].id, input.recurrence_type, period.weekday ?? null, period.service_date ?? null, period.start_time, period.end_time],
    );
    await client.query("COMMIT");
    return response.status(201).json({ ...inserted.rows[0], periods: input.periods });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    if (error.code === "23P01" || error.code === "23505") return fail(response, 409, "SCHEDULE_PERIOD_CONFLICT", "Schedule periods overlap or are duplicated");
    return next(error);
  } finally { client.release(); }
}

async function generateAvailability(_request, response, next) {
  const { id, scheduleId } = response.locals.params;
  const doctor = await owner(response, id);
  if (!doctor) return fail(response, 403, "FORBIDDEN", "Only the owning doctor may generate availability");
  const { from, to } = response.locals.body;
  const now = localDateTime(response.locals.applicationTimezone || "Asia/Kolkata");
  if (from < now.date) return fail(response, 400, "DATE_IN_PAST", "Availability generation must start today or later");
  const client = await response.locals.database.connect();
  try {
    await client.query("BEGIN");
    const loaded = await client.query("SELECT * FROM doctor_schedules WHERE id = $1 AND doctor_id = $2 AND active AND archived_at IS NULL FOR UPDATE", [scheduleId, id]);
    const schedule = loaded.rows[0];
    if (!schedule) { await client.query("ROLLBACK"); return fail(response, 404, "SCHEDULE_NOT_FOUND", "Active schedule not found"); }
    const periods = await client.query("SELECT weekday, service_date::text AS service_date, start_time::text AS start_time, end_time::text AS end_time FROM doctor_schedule_periods WHERE schedule_id = $1 ORDER BY start_time", [scheduleId]);
    let generated = 0;
    const duration = doctor.appointment_duration_minutes;
    for (let cursor = new Date(`${from}T00:00:00Z`), last = new Date(`${to}T00:00:00Z`); cursor <= last; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
      const date = cursor.toISOString().slice(0, 10);
      if (schedule.recurrence_type === "weekly" && (date < String(schedule.starts_on).slice(0, 10) || date > String(schedule.ends_on).slice(0, 10))) continue;
      const exceptionResult = await client.query("SELECT id, exception_type FROM doctor_schedule_exceptions WHERE schedule_id = $1 AND service_date = $2::date", [scheduleId, date]);
      const exception = exceptionResult.rows[0];
      let dayPeriods = periods.rows.filter((p) => schedule.recurrence_type === "weekly" ? Number(p.weekday) === cursor.getUTCDay() : p.service_date === date);
      if (exception?.exception_type === "day_off") continue;
      if (exception && exception.exception_type !== "day_off") {
        const extra = await client.query("SELECT start_time::text AS start_time, end_time::text AS end_time FROM doctor_schedule_exception_periods WHERE exception_id = $1", [exception.id]);
        dayPeriods = exception.exception_type === "override" ? extra.rows : [...dayPeriods, ...extra.rows];
      }
      for (const period of dayPeriods) {
        let minute = Number(period.start_time.slice(0, 2)) * 60 + Number(period.start_time.slice(3, 5));
        const end = Number(period.end_time.slice(0, 2)) * 60 + Number(period.end_time.slice(3, 5));
        let count = 0;
        while (minute + duration <= end && (schedule.mode !== "stream" || count < schedule.stream_capacity_per_window)) {
          const endMinute = minute + duration;
          const startTime = `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
          const endTime = `${String(Math.floor(endMinute / 60)).padStart(2, "0")}:${String(endMinute % 60).padStart(2, "0")}`;
          if (date < now.date || (date === now.date && startTime <= now.time)) { minute += duration; count += 1; continue; }
          const exists = await client.query(
            `SELECT 1 FROM availability WHERE doctor_id = $1 AND date = $2::date AND start_time = $3::time AND deleted_at IS NULL
             UNION ALL SELECT 1 FROM doctor_schedule_windows WHERE schedule_id = $4 AND service_date = $2::date AND start_time = $3::time AND deleted_at IS NULL LIMIT 1`,
            [id, date, startTime, scheduleId],
          );
          if (!exists.rows[0]) {
            const window = await client.query(
              `INSERT INTO doctor_schedule_windows (schedule_id, doctor_id, mode, visibility, service_date, start_time, end_time, wave_capacity_per_slot, stream_capacity_per_window) VALUES ($1,$2,$3,$4,$5::date,$6::time,$7::time,$8,$9) RETURNING id`,
              [scheduleId, id, schedule.mode, schedule.visibility, date, startTime, endTime, schedule.wave_capacity_per_slot, schedule.stream_capacity_per_window],
            );
            await client.query(
              `INSERT INTO availability (doctor_id, date, start_time, end_time, schedule_window_id, schedule_id, mode, booking_visibility, capacity) VALUES ($1,$2::date,$3::time,$4::time,$5,$6,$7,$8,$9)`,
              [id, date, startTime, endTime, window.rows[0].id, scheduleId, schedule.mode, schedule.visibility, schedule.mode === "wave" ? schedule.wave_capacity_per_slot : 1],
            );
            generated += 1;
          }
          minute += duration;
          count += 1;
        }
      }
    }
    await client.query("COMMIT");
    return response.status(201).json({ schedule_id: scheduleId, generated_slots: generated });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    if (error.code === "23P01" || error.code === "23505") return fail(response, 409, "SCHEDULE_CONFLICT", "Generated availability overlaps another schedule");
    return next(error);
  } finally { client.release(); }
}

async function createException(_request, response, next) {
  const { id, scheduleId } = response.locals.params;
  if (!await owner(response, id)) return fail(response, 403, "FORBIDDEN", "Only the owning doctor may manage schedule exceptions");
  const input = response.locals.body;
  const client = await response.locals.database.connect();
  try {
    await client.query("BEGIN");
    const schedule = await client.query("SELECT id FROM doctor_schedules WHERE id = $1 AND doctor_id = $2 AND active AND archived_at IS NULL FOR UPDATE", [scheduleId, id]);
    if (!schedule.rows[0]) { await client.query("ROLLBACK"); return fail(response, 404, "SCHEDULE_NOT_FOUND", "Active schedule not found"); }
    const inserted = await client.query("INSERT INTO doctor_schedule_exceptions (schedule_id, service_date, exception_type) VALUES ($1,$2::date,$3) RETURNING id, schedule_id, service_date::text AS service_date, exception_type", [scheduleId, input.service_date, input.exception_type]);
    for (const period of input.periods) await client.query("INSERT INTO doctor_schedule_exception_periods (exception_id, exception_type, start_time, end_time) VALUES ($1,$2,$3::time,$4::time)", [inserted.rows[0].id, input.exception_type, period.start_time, period.end_time]);
    await client.query("COMMIT");
    return response.status(201).json({ ...inserted.rows[0], periods: input.periods });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    if (error.code === "23P01" || error.code === "23505") return fail(response, 409, "SCHEDULE_EXCEPTION_CONFLICT", "An exception already exists or its periods overlap");
    return next(error);
  } finally { client.release(); }
}

module.exports = { createException, createSchedule, generateAvailability, listSchedules };
