const appointmentService = require("../services/appointmentService");

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

const createAppointment = handle(async (_request, response) => ({
  status: 201,
  body: await appointmentService.createAppointment(
    response.locals.database,
    response.locals.user,
    response.locals.applicationTimezone,
    response.locals.body,
  ),
}));

const getAppointment = handle(async (_request, response) => ({
  body: await appointmentService.getAppointment(
    response.locals.database,
    response.locals.user,
    response.locals.params.id,
  ),
}));

const cancelAppointment = handle(async (_request, response) => ({
  body: await appointmentService.cancelAppointment(
    response.locals.database,
    response.locals.user,
    response.locals.params.id,
  ),
}));

const rescheduleAppointment = handle(async (_request, response) => ({
  body: await (response.locals.user.role === "doctor" || !response.locals.body.availability_id
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
    )),
}));

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
