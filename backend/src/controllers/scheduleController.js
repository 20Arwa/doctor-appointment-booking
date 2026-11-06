const { localDateTime } = require("../utils/schedulingTime");

async function owner(response, doctorId) {
  if (response.locals.user.role !== "doctor") return false;
  const result = await response.locals.database.query("SELECT id, appointment_duration_minutes FROM doctors WHERE user_id = $1", [response.locals.user.id]);
  return result.rows[0]?.id === doctorId ? result.rows[0] : false;
}
function fail(response, status, code, message) { return response.status(status).json({ error: { code, message } }); }

async function assertWindowAvailable(client, { doctorId, scheduleId, date, startTime, endTime, mode, capacity, visibility }) {
  const matching = await client.query(
    `SELECT 1
     FROM availability av
     JOIN doctor_schedule_windows schedule_window ON schedule_window.id = av.schedule_window_id
     WHERE av.doctor_id = $1 AND av.schedule_id = $2 AND av.date = $3::date
       AND av.start_time = $4::time AND av.end_time = $5::time
       AND av.mode = $6 AND av.capacity = $7 AND av.booking_visibility = $8
       AND av.deleted_at IS NULL AND schedule_window.deleted_at IS NULL
     LIMIT 1`, [doctorId, scheduleId, date, startTime, endTime, mode, capacity, visibility],
  );
  if (matching.rows[0]) return true;

  const conflict = await client.query(
    `SELECT EXISTS (
       SELECT 1 FROM availability av
       WHERE av.doctor_id = $1 AND av.date = $2::date AND av.deleted_at IS NULL
         AND av.start_time < $4::time AND av.end_time > $3::time
     ) OR EXISTS (
       SELECT 1 FROM doctor_schedule_windows schedule_window
       WHERE schedule_window.doctor_id = $1 AND schedule_window.service_date = $2::date AND schedule_window.deleted_at IS NULL
         AND schedule_window.start_time < $4::time AND schedule_window.end_time > $3::time
     ) OR EXISTS (
       SELECT 1 FROM availability legacy
       WHERE legacy.doctor_id = $1 AND legacy.date = $2::date
         AND legacy.mode = 'stream' AND legacy.deleted_at IS NOT NULL
         AND legacy.start_time < $4::time AND legacy.end_time > $3::time
         AND (
           EXISTS (SELECT 1 FROM appointments appointment
                   WHERE appointment.availability_id = legacy.id
                     AND appointment.status IN ('confirmed', 'completed'))
           OR EXISTS (SELECT 1 FROM appointment_allocations allocation
                      WHERE allocation.availability_id = legacy.id
                        AND allocation.status IN ('held', 'confirmed'))
           OR EXISTS (SELECT 1 FROM appointment_slot_holds hold
                      WHERE hold.availability_id = legacy.id
                        AND hold.status = 'active' AND hold.expires_at > NOW())
         )
     ) AS has_conflict`, [doctorId, date, startTime, endTime],
  );
  if (conflict.rows[0]?.has_conflict) {
    const error = new Error("Generated availability overlaps existing or still-booked availability");
    error.code = "23P01";
    throw error;
  }
  return false;
}

async function overlapsConfirmedAppointment(client, doctorId, date, startTime, endTime) {
  const result = await client.query(
    `SELECT 1 FROM appointments appointment
     JOIN availability av ON av.id = appointment.availability_id
     WHERE av.doctor_id = $1 AND appointment.status = 'confirmed' AND appointment.scheduled_date = $2::date
       AND appointment.scheduled_start_time < $4::time AND appointment.scheduled_end_time > $3::time
     LIMIT 1`, [doctorId, date, startTime, endTime],
  );
  return Boolean(result.rows[0]);
}

async function overlapsLegacyAvailability(client, doctorId, date, startTime, endTime) {
  const result = await client.query(
    `SELECT av.id,
            COALESCE((SELECT json_agg(DISTINCT a.status) FROM appointments a WHERE a.availability_id = av.id), '[]'::json) AS appointment_statuses,
            EXISTS (SELECT 1 FROM appointment_allocations a WHERE a.availability_id = av.id) AS has_allocation_history,
            EXISTS (SELECT 1 FROM appointment_slot_holds h WHERE h.availability_id = av.id) AS has_hold_history
     FROM availability av
     WHERE av.doctor_id = $1 AND av.date = $2::date AND av.mode IS NULL AND av.deleted_at IS NULL
       AND av.start_time < $4::time AND av.end_time > $3::time
     FOR UPDATE OF av`, [doctorId, date, startTime, endTime],
  );
  const obsoleteIds = result.rows.filter((row) => row.appointment_statuses.length === 0 && !row.has_allocation_history && !row.has_hold_history).map((row) => row.id);
  if (obsoleteIds.length) {
    await client.query(
      "UPDATE availability SET deleted_at = NOW(), updated_at = NOW() WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL",
      [obsoleteIds],
    );
  }
  const referenced = result.rows.filter((row) => !obsoleteIds.includes(row.id));
  if (!referenced.length) return null;
  const row = referenced[0];
  const references = [];
  if (row.appointment_statuses.length) references.push(`appointment history (${row.appointment_statuses.join(", ")})`);
  if (row.has_allocation_history) references.push("allocation history");
  if (row.has_hold_history) references.push("payment hold history");
  return `legacy availability with ${references.join(" and ")}`;
}

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
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [id]);
    const weekdayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    for (const candidate of input.periods) {
      const overlap = await client.query(
        `SELECT existing_period.weekday, existing_period.service_date::text AS service_date,
                existing_period.start_time::text AS start_time, existing_period.end_time::text AS end_time
         FROM doctor_schedule_periods existing_period
         JOIN doctor_schedules existing_schedule ON existing_schedule.id = existing_period.schedule_id
         WHERE existing_schedule.doctor_id = $1 AND existing_schedule.active AND existing_schedule.archived_at IS NULL
           AND ($9::uuid IS NULL OR existing_schedule.id <> $9::uuid)
           AND ($6::date IS NULL OR existing_schedule.ends_on IS NULL OR existing_schedule.ends_on >= $6::date)
           AND ($5::date IS NULL OR existing_schedule.starts_on IS NULL OR existing_schedule.starts_on <= $5::date)
           AND (
             (existing_schedule.recurrence_type = 'weekly' AND $4 = 'weekly' AND existing_period.weekday = $2)
             OR (existing_schedule.recurrence_type <> 'weekly' AND $4 <> 'weekly' AND existing_period.service_date = $3::date)
             OR (existing_schedule.recurrence_type <> 'weekly' AND $4 = 'weekly'
                 AND EXTRACT(DOW FROM existing_period.service_date) = $2
                 AND existing_period.service_date BETWEEN $5::date AND $6::date)
             OR (existing_schedule.recurrence_type = 'weekly' AND $4 <> 'weekly'
                 AND existing_period.weekday = EXTRACT(DOW FROM $3::date)
                 AND (existing_schedule.starts_on IS NULL OR existing_schedule.starts_on <= $3::date)
                 AND (existing_schedule.ends_on IS NULL OR existing_schedule.ends_on >= $3::date))
           )
           AND existing_period.start_time < $8::time AND existing_period.end_time > $7::time
         LIMIT 1`,
        [id, candidate.weekday ?? null, candidate.service_date ?? null,
          input.recurrence_type, input.starts_on ?? null, input.ends_on ?? null,
          candidate.start_time, candidate.end_time, input.request_id ?? null],
      );
      if (overlap.rows[0]) {
        const existing = overlap.rows[0];
        const weekday = input.recurrence_type === "weekly" ? weekdayNames[candidate.weekday] : candidate.service_date;
        const existingStart = String(existing.start_time).slice(0, 5);
        const existingEnd = String(existing.end_time).slice(0, 5);
        await client.query("ROLLBACK");
        return fail(response, 409, "SCHEDULE_PERIOD_CONFLICT", `Schedule overlaps ${weekday} ${existingStart}–${existingEnd} IST.`);
      }
    }
    const inserted = await client.query(
      `INSERT INTO doctor_schedules (id, doctor_id, mode, recurrence_type, visibility, starts_on, ends_on, time_zone, wave_capacity_per_slot, stream_capacity_per_window)
       VALUES (COALESCE($1::uuid, gen_random_uuid()),$2,$3,$4,$5,$6::date,$7::date,$8,$9,$10)
       ON CONFLICT (id) DO NOTHING RETURNING *`,
      [input.request_id ?? null, id, input.mode, input.recurrence_type, input.visibility, input.starts_on ?? null, input.ends_on ?? null, response.locals.applicationTimezone || "Asia/Kolkata", input.wave_capacity_per_slot, input.stream_capacity_per_window],
    );
    let schedule = inserted.rows[0];
    if (!schedule && input.request_id) {
      const existing = await client.query("SELECT *, starts_on::text AS starts_on_text, ends_on::text AS ends_on_text FROM doctor_schedules WHERE id = $1 AND doctor_id = $2 FOR UPDATE", [input.request_id, id]);
      schedule = existing.rows[0];
      const existingStartsOn = schedule?.starts_on_text ?? undefined;
      const existingEndsOn = schedule?.ends_on_text ?? undefined;
      if (!schedule || schedule.mode !== input.mode || schedule.recurrence_type !== input.recurrence_type || schedule.visibility !== input.visibility || existingStartsOn !== input.starts_on || existingEndsOn !== input.ends_on || schedule.wave_capacity_per_slot !== input.wave_capacity_per_slot || schedule.stream_capacity_per_window !== input.stream_capacity_per_window) {
        await client.query("ROLLBACK");
        return fail(response, 409, "SCHEDULE_REQUEST_CONFLICT", "This schedule request ID was already used for different schedule details");
      }
      const existingPeriods = await client.query("SELECT weekday, service_date::text AS service_date, start_time::text AS start_time, end_time::text AS end_time FROM doctor_schedule_periods WHERE schedule_id = $1 ORDER BY start_time", [input.request_id]);
      if (existingPeriods.rows.length !== input.periods.length) {
        await client.query("ROLLBACK");
        return fail(response, 409, "SCHEDULE_REQUEST_CONFLICT", "This schedule request ID was already used for different schedule details");
      }
      const samePeriods = input.periods.every((period) => existingPeriods.rows.some((item) => item.weekday === (period.weekday ?? null) && item.service_date === (period.service_date ?? null) && item.start_time.slice(0, 5) === period.start_time && item.end_time.slice(0, 5) === period.end_time));
      if (!samePeriods) {
        await client.query("ROLLBACK");
        return fail(response, 409, "SCHEDULE_REQUEST_CONFLICT", "This schedule request ID was already used for different schedule details");
      }
      await client.query("COMMIT");
      return response.status(200).json({ ...schedule, periods: existingPeriods.rows });
    }
    if (!schedule) throw new Error("Schedule could not be created");
    for (const period of input.periods) await client.query(
      `INSERT INTO doctor_schedule_periods (schedule_id, recurrence_type, weekday, service_date, start_time, end_time) VALUES ($1,$2,$3,$4::date,$5::time,$6::time)`,
      [schedule.id, input.recurrence_type, period.weekday ?? null, period.service_date ?? null, period.start_time, period.end_time],
    );
    await client.query("COMMIT");
    return response.status(201).json({ ...schedule, periods: input.periods });
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
    const loaded = await client.query(
      `SELECT id, doctor_id, mode, recurrence_type, visibility,
              starts_on::text AS starts_on, ends_on::text AS ends_on,
              wave_capacity_per_slot, stream_capacity_per_window
       FROM doctor_schedules
       WHERE id = $1 AND doctor_id = $2 AND active AND archived_at IS NULL
       FOR UPDATE`, [scheduleId, id],
    );
    const schedule = loaded.rows[0];
    if (!schedule) { await client.query("ROLLBACK"); return fail(response, 404, "SCHEDULE_NOT_FOUND", "Active schedule not found"); }
    const periods = await client.query("SELECT weekday, service_date::text AS service_date, start_time::text AS start_time, end_time::text AS end_time FROM doctor_schedule_periods WHERE schedule_id = $1 ORDER BY start_time", [scheduleId]);
    let generated = 0;
    let skippedConflicts = 0;
    const skippedConflictDetails = [];
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
        const periodStart = `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
        if (schedule.mode === "stream") {
          if (date < now.date || (date === now.date && periodStart <= now.time)) continue;
          if (await overlapsConfirmedAppointment(client, id, date, periodStart, period.end_time)) {
            continue;
          }
          const legacyConflict = await overlapsLegacyAvailability(client, id, date, periodStart, period.end_time);
          if (legacyConflict) { skippedConflicts += 1; skippedConflictDetails.push({ date, start_time: periodStart, end_time: period.end_time, reason: legacyConflict }); continue; }
          const alreadyGenerated = await assertWindowAvailable(client, {
            doctorId: id, scheduleId, date, startTime: periodStart, endTime: period.end_time,
            mode: "stream", capacity: schedule.stream_capacity_per_window, visibility: schedule.visibility,
          });
          if (!alreadyGenerated) {
            const window = await client.query(
              `INSERT INTO doctor_schedule_windows (schedule_id, doctor_id, mode, visibility, service_date, start_time, end_time, wave_capacity_per_slot, stream_capacity_per_window)
               VALUES ($1,$2,'stream',$3,$4::date,$5::time,$6::time,0,$7) RETURNING id`,
              [scheduleId, id, schedule.visibility, date, periodStart, period.end_time, schedule.stream_capacity_per_window],
            );
            await client.query(
              `INSERT INTO availability (doctor_id, date, start_time, end_time, schedule_window_id, schedule_id, mode, booking_visibility, capacity)
               VALUES ($1,$2::date,$3::time,$4::time,$5,$6,'stream',$7,$8)`,
              [id, date, periodStart, period.end_time, window.rows[0].id, scheduleId, schedule.visibility, schedule.stream_capacity_per_window],
            );
            generated += 1;
          }
          continue;
        }
        while (minute + duration <= end) {
          const endMinute = minute + duration;
          const startTime = `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
          const endTime = `${String(Math.floor(endMinute / 60)).padStart(2, "0")}:${String(endMinute % 60).padStart(2, "0")}`;
          if (date < now.date || (date === now.date && startTime <= now.time)) { minute += duration; continue; }
          if (await overlapsConfirmedAppointment(client, id, date, startTime, endTime)) { minute += duration; continue; }
          const legacyConflict = await overlapsLegacyAvailability(client, id, date, startTime, endTime);
          if (legacyConflict) { skippedConflicts += 1; skippedConflictDetails.push({ date, start_time: startTime, end_time: endTime, reason: legacyConflict }); minute += duration; continue; }
          const alreadyGenerated = await assertWindowAvailable(client, {
            doctorId: id, scheduleId, date, startTime, endTime, mode: "wave",
            capacity: schedule.wave_capacity_per_slot, visibility: schedule.visibility,
          });
          if (!alreadyGenerated) {
            const window = await client.query(
              `INSERT INTO doctor_schedule_windows (schedule_id, doctor_id, mode, visibility, service_date, start_time, end_time, wave_capacity_per_slot, stream_capacity_per_window) VALUES ($1,$2,$3,$4,$5::date,$6::time,$7::time,$8,$9) RETURNING id`,
              [scheduleId, id, schedule.mode, schedule.visibility, date, startTime, endTime, schedule.wave_capacity_per_slot, schedule.stream_capacity_per_window],
            );
            await client.query(
              `INSERT INTO availability (doctor_id, date, start_time, end_time, schedule_window_id, schedule_id, mode, booking_visibility, capacity) VALUES ($1,$2::date,$3::time,$4::time,$5,$6,$7,$8,$9)`,
              [id, date, startTime, endTime, window.rows[0].id, scheduleId, schedule.mode, schedule.visibility, schedule.wave_capacity_per_slot],
            );
            generated += 1;
          }
          minute += duration;
        }
      }
    }
    await client.query("COMMIT");
    return response.status(201).json({
      schedule_id: scheduleId,
      mode: schedule.mode,
      [schedule.mode === "stream" ? "generated_windows" : "generated_slots"]: generated,
      ...(skippedConflicts ? { skipped_conflicts: skippedConflicts, skipped_conflict_details: skippedConflictDetails } : {}),
    });
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
    const schedule = await client.query("SELECT id, recurrence_type FROM doctor_schedules WHERE id = $1 AND doctor_id = $2 AND active AND archived_at IS NULL FOR UPDATE", [scheduleId, id]);
    if (!schedule.rows[0]) { await client.query("ROLLBACK"); return fail(response, 404, "SCHEDULE_NOT_FOUND", "Active schedule not found"); }
    if (input.exception_type === "additional") {
      const weekday = new Date(`${input.service_date}T00:00:00Z`).getUTCDay();
      for (const period of input.periods) {
        const overlap = await client.query(
          `SELECT 1 FROM doctor_schedule_periods
           WHERE schedule_id = $1 AND ($2::boolean AND weekday = $3 OR NOT $2::boolean AND service_date = $4::date)
             AND start_time < $6::time AND end_time > $5::time LIMIT 1`,
          [scheduleId, schedule.rows[0].recurrence_type === "weekly", weekday, input.service_date, period.start_time, period.end_time],
        );
        if (overlap.rows[0]) {
          await client.query("ROLLBACK");
          return fail(response, 409, "SCHEDULE_EXCEPTION_CONFLICT", "Additional hours must not overlap the schedule's existing hours");
        }
      }
    }
    const inserted = await client.query("INSERT INTO doctor_schedule_exceptions (schedule_id, service_date, exception_type) VALUES ($1,$2::date,$3) ON CONFLICT (schedule_id, service_date) DO NOTHING RETURNING id, schedule_id, service_date::text AS service_date, exception_type", [scheduleId, input.service_date, input.exception_type]);
    const exception = inserted.rows[0] ?? (await client.query("SELECT id, schedule_id, service_date::text AS service_date, exception_type FROM doctor_schedule_exceptions WHERE schedule_id = $1 AND service_date = $2::date FOR UPDATE", [scheduleId, input.service_date])).rows[0];
    if (!exception || exception.exception_type !== input.exception_type) {
      await client.query("ROLLBACK");
      return fail(response, 409, "SCHEDULE_EXCEPTION_CONFLICT", "A different exception already exists for this date");
    }
    const existingPeriods = await client.query("SELECT start_time::text AS start_time, end_time::text AS end_time FROM doctor_schedule_exception_periods WHERE exception_id = $1 ORDER BY start_time", [exception.id]);
    const samePeriods = existingPeriods.rows.length === input.periods.length && input.periods.every((period) => existingPeriods.rows.some((item) => item.start_time.slice(0, 5) === period.start_time && item.end_time.slice(0, 5) === period.end_time));
    if (!inserted.rows[0] && !samePeriods) {
      await client.query("ROLLBACK");
      return fail(response, 409, "SCHEDULE_EXCEPTION_CONFLICT", "A different exception already exists for this date");
    }
    if (inserted.rows[0]) {
      await client.query("SELECT id FROM availability WHERE schedule_id = $1 AND date = $2::date AND deleted_at IS NULL FOR UPDATE", [scheduleId, input.service_date]);
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [id]);
      const activeHolds = await client.query(
        `SELECT 1 FROM availability av
         WHERE av.schedule_id = $1 AND av.date = $2::date AND av.deleted_at IS NULL
           AND (EXISTS (SELECT 1 FROM appointment_slot_holds hold WHERE hold.availability_id = av.id AND hold.status = 'active' AND hold.expires_at > NOW())
             OR EXISTS (SELECT 1 FROM appointment_allocations allocation WHERE allocation.availability_id = av.id AND allocation.status = 'held' AND allocation.expires_at > NOW()))
         LIMIT 1`, [scheduleId, input.service_date],
      );
      if (activeHolds.rows[0]) {
        await client.query("ROLLBACK");
        return fail(response, 409, "SCHEDULE_EXCEPTION_HELD", "This date has an active payment hold. Wait for it to finish before changing availability.");
      }
      const confirmedAppointments = await client.query(
        `SELECT 1 FROM appointments appointment
         JOIN availability av ON av.id = appointment.availability_id
         WHERE av.schedule_id = $1 AND av.date = $2::date AND av.deleted_at IS NULL
           AND appointment.status = 'confirmed'
           AND ((appointment.scheduled_date + appointment.scheduled_end_time) AT TIME ZONE $3) > NOW()
         LIMIT 1`, [scheduleId, input.service_date, response.locals.applicationTimezone || "Asia/Kolkata"],
      );
      const confirmedAllocations = await client.query(
        `SELECT 1 FROM appointment_allocations allocation
         JOIN availability av ON av.id = allocation.availability_id
         WHERE av.schedule_id = $1 AND av.date = $2::date AND av.deleted_at IS NULL
           AND allocation.status = 'confirmed' LIMIT 1`, [scheduleId, input.service_date],
      );
      if (confirmedAppointments.rows[0] || confirmedAllocations.rows[0]) {
        await client.query("ROLLBACK");
        return fail(response, 409, "SCHEDULE_EXCEPTION_BOOKED", "This date has a confirmed appointment and cannot be changed safely.");
      }
      await client.query("UPDATE availability SET deleted_at = NOW(), updated_at = NOW() WHERE schedule_id = $1 AND date = $2::date AND deleted_at IS NULL", [scheduleId, input.service_date]);
      await client.query("UPDATE doctor_schedule_windows SET deleted_at = NOW() WHERE schedule_id = $1 AND service_date = $2::date AND deleted_at IS NULL", [scheduleId, input.service_date]);
      for (const period of input.periods) await client.query("INSERT INTO doctor_schedule_exception_periods (exception_id, exception_type, start_time, end_time) VALUES ($1,$2,$3::time,$4::time)", [exception.id, input.exception_type, period.start_time, period.end_time]);
    }
    if (input.exception_type !== "day_off") {
      const exceptionPeriods = inserted.rows[0]
        ? input.periods
        : existingPeriods.rows.map((period) => ({ start_time: period.start_time.slice(0, 5), end_time: period.end_time.slice(0, 5) }));
      for (const period of exceptionPeriods) {
        const unsafeLegacy = await client.query(
          `SELECT av.start_time::text AS start_time, av.end_time::text AS end_time
           FROM availability av
           WHERE av.doctor_id = $1 AND av.date = $2::date AND av.mode IS NULL AND av.deleted_at IS NULL
             AND av.start_time < $4::time AND av.end_time > $3::time
             AND (EXISTS (SELECT 1 FROM appointments a WHERE a.availability_id = av.id)
               OR EXISTS (SELECT 1 FROM appointment_allocations a WHERE a.availability_id = av.id)
               OR EXISTS (SELECT 1 FROM appointment_slot_holds h WHERE h.availability_id = av.id))
           ORDER BY av.start_time LIMIT 1`, [id, input.service_date, period.start_time, period.end_time],
        );
        if (unsafeLegacy.rows[0]) {
          const row = unsafeLegacy.rows[0];
          await client.query("ROLLBACK");
          return fail(response, 409, "SCHEDULE_EXCEPTION_AVAILABILITY_CONFLICT", `Cannot add hours on ${input.service_date}: existing availability ${row.start_time.slice(0, 5)}–${row.end_time.slice(0, 5)} IST has booking or payment history.`);
        }
        const legacyRows = await client.query(
          `SELECT av.id FROM availability av
           WHERE av.doctor_id = $1 AND av.date = $2::date AND av.mode IS NULL AND av.deleted_at IS NULL
             AND av.start_time < $4::time AND av.end_time > $3::time
             AND NOT EXISTS (SELECT 1 FROM appointments a WHERE a.availability_id = av.id)
             AND NOT EXISTS (SELECT 1 FROM appointment_allocations a WHERE a.availability_id = av.id)
             AND NOT EXISTS (SELECT 1 FROM appointment_slot_holds h WHERE h.availability_id = av.id)
           FOR UPDATE`, [id, input.service_date, period.start_time, period.end_time],
        );
        if (legacyRows.rows.length) await client.query(
          "UPDATE availability SET deleted_at = NOW(), updated_at = NOW() WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL",
          [legacyRows.rows.map((row) => row.id)],
        );
      }
    }
    await client.query("COMMIT");
    const originalBody = response.locals.body;
    response.locals.body = { from: input.service_date, to: input.service_date };
    let generationError = null;
    const generatedResponse = { locals: response.locals, statusCode: 200, payload: null, status(code) { this.statusCode = code; return this; }, json(payload) { this.payload = payload; return this; } };
    await generateAvailability(null, generatedResponse, (error) => { generationError = error; });
    response.locals.body = originalBody;
    if (generationError) return next(generationError);
    if (generatedResponse.statusCode >= 400) return response.status(generatedResponse.statusCode).json(generatedResponse.payload);
    return response.status(inserted.rows[0] ? 201 : 200).json({ ...exception, periods: input.periods, generation: generatedResponse.payload });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    if (error.code === "23P01" || error.code === "23505") return fail(response, 409, "SCHEDULE_EXCEPTION_CONFLICT", "An exception already exists or its periods overlap");
    return next(error);
  } finally { client.release(); }
}

module.exports = { createException, createSchedule, generateAvailability, listSchedules };
