async function findSchedulePeriodOverlaps(client, doctorId, candidate, input, excludedScheduleId = null) {
  const result = await client.query(
    `SELECT existing_schedule.id AS schedule_id,
            existing_schedule.recurrence_type,
            existing_period.weekday,
            existing_period.service_date::text AS service_date,
            existing_period.start_time::text AS start_time,
            existing_period.end_time::text AS end_time
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
     ORDER BY existing_schedule.id, existing_period.start_time`,
    [doctorId, candidate.weekday ?? null, candidate.service_date ?? null,
      input.recurrence_type, input.starts_on ?? null, input.ends_on ?? null,
      candidate.start_time, candidate.end_time, excludedScheduleId],
  );
  return result.rows;
}

async function findSchedulePeriodOverlap(client, doctorId, candidate, input, excludedScheduleId = null) {
  return (await findSchedulePeriodOverlaps(client, doctorId, candidate, input, excludedScheduleId))[0] ?? null;
}

module.exports = { findSchedulePeriodOverlap, findSchedulePeriodOverlaps };
