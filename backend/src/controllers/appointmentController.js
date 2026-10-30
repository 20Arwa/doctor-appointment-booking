const appointmentService = require("../services/appointmentService");

async function notify(response, action, appointment) {
  try {
    await response.locals.emailNotificationService.sendAppointmentNotification(action, appointment);
  } catch (error) {
    console.error(`Appointment ${action} email notification failed`, { message: error.message });
  }
}

function handle(operation) {
  return async (request, response, next) => {
    try {
      const result = await operation(request, response);
      if (response.headersSent) return;
      return response.status(result.status || 200).json(result.body);
    } catch (error) {
      if (error instanceof appointmentService.AppointmentError) {
        return response.status(error.status).json({ error: { code: error.code, message: error.message } });
      }
      return next(error);
    }
  };
}

const listAppointments = handle(async (_request, response) => ({
  body: await appointmentService.listAppointments(response.locals.database, response.locals.user, response.locals.query),
}));

const createAppointment = (_request, response) => {
  if (response.locals.user.role !== "patient") {
    return response.status(403).json({ error: { code: "FORBIDDEN", message: "Only patients can book appointments" } });
  }
  return response.status(402).json({
    error: { code: "PAYMENT_REQUIRED", message: "Create and verify a payment order before booking an appointment" },
  });
};

const getAppointment = handle(async (_request, response) => ({
  body: await appointmentService.getAppointment(
    response.locals.database,
    response.locals.user,
    response.locals.params.id,
  ),
}));

const cancelAppointment = handle(async (_request, response) => {
  const appointment = await appointmentService.cancelAppointment(
    response.locals.database,
    response.locals.user,
    response.locals.params.id,
  );
  await notify(response, "cancelled", appointment);
  return { body: appointment };
});

const rescheduleAppointment = handle(async (_request, response) => {
  const appointment = await (response.locals.user.role === "doctor" || !response.locals.body.availability_id
    ? appointmentService.doctorRescheduleAppointment(
      response.locals.database,
      response.locals.user,
      response.locals.applicationTimezone,
      response.locals.params.id,
      response.locals.body,
    )
    : appointmentService.rescheduleAppointment(
    response.locals.database,
    response.locals.user,
    response.locals.applicationTimezone,
    response.locals.params.id,
    response.locals.body.availability_id,
    ));
  await notify(response, "rescheduled", appointment);
  const { previous_date: _previousDate, previous_start_time: _previousStartTime, ...body } = appointment;
  return { body };
});

const completeAppointment = handle(async (_request, response) => ({
  body: await appointmentService.completeAppointment(
    response.locals.database,
    response.locals.user,
    response.locals.params.id,
  ),
}));

module.exports = {
  cancelAppointment,
  completeAppointment,
  createAppointment,
  getAppointment,
  listAppointments,
  rescheduleAppointment,
};
