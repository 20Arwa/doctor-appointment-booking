const queueService = require("../services/appointmentQueueService");
const appointmentService = require("../services/appointmentService");
const env = require("../config/env");

function handle(operation) {
  return async (request, response, next) => {
    try { return response.json(await operation(request, response)); }
    catch (error) {
      if (error instanceof appointmentService.AppointmentError) return response.status(error.status).json({ error: { code: error.code, message: error.message } });
      return next(error);
    }
  };
}

module.exports = {
  patient: handle((_request, response) => queueService.patientAppointmentQueue(response.locals.database, response.locals.user, response.locals.params.appointmentId)),
  doctor: handle((_request, response) => queueService.appointmentQueue(response.locals.database, response.locals.user, null, response.locals.query.date || new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date()))),
  receptionist: handle((_request, response) => queueService.appointmentQueue(response.locals.database, response.locals.user, response.locals.query.doctor_id || null, response.locals.query.date)),
  checkIn: handle((_request, response) => queueService.checkIn(response.locals.database, response.locals.user, response.locals.params.appointmentId, env.APPLICATION_TIMEZONE || "Asia/Kolkata")),
  noShow: handle((_request, response) => queueService.markNoShow(response.locals.database, response.locals.user, response.locals.params.appointmentId, env.QUEUE_NO_SHOW_GRACE_MINUTES, env.APPLICATION_TIMEZONE || "Asia/Kolkata")),
  callNext: handle((_request, response) => queueService.callNext(response.locals.database, response.locals.user, response.locals.query.date, env.APPLICATION_TIMEZONE || "Asia/Kolkata")),
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
