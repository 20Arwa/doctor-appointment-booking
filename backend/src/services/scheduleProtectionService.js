const PROTECTED_APPOINTMENT_CODE = "SCHEDULE_CHANGE_PROTECTED_APPOINTMENT";

async function queryProtectedAppointments(client, scopeSql, scopeValues, timeZone) {
  const timeZoneParameter = `$${scopeValues.length + 1}`;
  const result = await client.query(
    `SELECT appointment.id AS appointment_id,
            appointment.scheduled_date::text AS date,
            appointment.scheduled_start_time::text AS start_time,
            appointment.scheduled_end_time::text AS end_time
     FROM appointments appointment
     JOIN availability av ON av.id = appointment.availability_id
     CROSS JOIN (SELECT clock_timestamp() AS checked_at) protection_window
     WHERE appointment.status = 'confirmed'
       AND ${scopeSql}
       AND ((appointment.scheduled_date + appointment.scheduled_start_time) AT TIME ZONE ${timeZoneParameter}) >= protection_window.checked_at
       AND ((appointment.scheduled_date + appointment.scheduled_start_time) AT TIME ZONE ${timeZoneParameter}) <= protection_window.checked_at + INTERVAL '6 hours'
     ORDER BY appointment.scheduled_date, appointment.scheduled_start_time`,
    [...scopeValues, timeZone],
  );
  return result.rows;
}

function findProtectedAppointmentsByIds(client, appointmentIds, timeZone) {
  if (!appointmentIds.length) return Promise.resolve([]);
  return queryProtectedAppointments(client, "appointment.id = ANY($1::uuid[])", [appointmentIds], timeZone);
}

function findProtectedAppointmentsForScheduleDate(client, scheduleId, serviceDate, timeZone) {
  return queryProtectedAppointments(client,
    "av.schedule_id = $1 AND appointment.scheduled_date = $2::date", [scheduleId, serviceDate], timeZone);
}

function findProtectedAppointmentsForAvailability(client, availabilityId, timeZone) {
  return queryProtectedAppointments(client, "appointment.availability_id = $1", [availabilityId], timeZone);
}

function appointmentAffectedByException(appointment, exceptionType, periods) {
  if (exceptionType === "day_off") return true;
  if (exceptionType === "additional") return false;
  return !periods.some((period) => appointment.start_time.slice(0, 5) >= period.start_time
    && appointment.end_time.slice(0, 5) <= period.end_time);
}

function failForProtectedAppointments(response, appointments) {
  if (!appointments.length) return false;
  const details = appointments.map(({ appointment_id, date, start_time, end_time }) => ({
    appointment_id,
    date,
    start_time: start_time.slice(0, 5),
    end_time: end_time.slice(0, 5),
  }));
  const first = details[0];
  response.status(409).json({
    error: {
      code: PROTECTED_APPOINTMENT_CODE,
      message: `This change affects a confirmed appointment starting within six hours (${first.date} at ${first.start_time} IST).`,
      details: { protected_appointments: details },
    },
  });
  return true;
}

module.exports = {
  PROTECTED_APPOINTMENT_CODE,
  appointmentAffectedByException,
  failForProtectedAppointments,
  findProtectedAppointmentsByIds,
  findProtectedAppointmentsForAvailability,
  findProtectedAppointmentsForScheduleDate,
};
