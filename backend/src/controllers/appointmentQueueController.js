const queueService = require("../services/appointmentQueueService");
const appointmentService = require("../services/appointmentService");
const env = require("../config/env");

function handle(operation, dispatchAfterCommit = false) {
  return async (request, response, next) => {
    try {
      const result = await operation(request, response);
      if (dispatchAfterCommit) response.locals.triggerAppointmentOutbox?.();
      return response.json(result);
    }
    catch (error) {
      if (error instanceof appointmentService.AppointmentError) return response.status(error.status).json({ error: { code: error.code, message: error.message } });
      return next(error);
    }
  };
}

module.exports = {
  patient: handle((_request, response) => queueService.patientAppointmentQueue(response.locals.database, response.locals.user, response.locals.params.appointmentId)),
  doctor: handle((_request, response) => queueService.appointmentQueue(response.locals.database, response.locals.user, null, response.locals.query.date || new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date()), env.APPLICATION_TIMEZONE || "Asia/Kolkata")),
  receptionist: handle((_request, response) => queueService.appointmentQueue(response.locals.database, response.locals.user, response.locals.query.doctor_id || null, response.locals.query.date, env.APPLICATION_TIMEZONE || "Asia/Kolkata")),
  checkIn: handle((_request, response) => queueService.checkIn(response.locals.database, response.locals.user, response.locals.params.appointmentId, env.APPLICATION_TIMEZONE || "Asia/Kolkata"), true),
  noShow: handle((_request, response) => queueService.markNoShow(response.locals.database, response.locals.user, response.locals.params.appointmentId, env.APPLICATION_TIMEZONE || "Asia/Kolkata")),
  callNext: handle((_request, response) => queueService.callNext(response.locals.database, response.locals.user, response.locals.query.date, env.APPLICATION_TIMEZONE || "Asia/Kolkata"), true),
  async complete(request, response, next) {
    try {
      const appointment = await appointmentService.completeAppointment(response.locals.database, response.locals.user, response.locals.params.appointmentId);
      return response.json(appointment);
    } catch (error) {
      if (error instanceof appointmentService.AppointmentError) return response.status(error.status).json({ error: { code: error.code, message: error.message } });
      return next(error);
    }
  },
};
