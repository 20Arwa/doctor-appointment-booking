const appointmentService = require("../services/appointmentService");
const { appointmentEventKey } = require("../services/notificationDeliveryService");

async function notify(response, eventType, appointment) {
  const eventKey = appointmentEventKey(eventType, appointment);
  const actorRole = response.locals.user.role;
  await Promise.all([
    (async () => {
      try { await response.locals.notificationDeliveryService.sendAppointmentNotification({ eventKey, eventType, appointment, actorRole }); }
      catch (_error) { console.error("Appointment email notification failed", { eventType, reason: "unexpected_error" }); }
    })(),
    (async () => {
      try { await response.locals.inAppNotificationService.sendAppointmentNotification({ eventKey, eventType, appointment, actorRole }); }
      catch (_error) { console.error("In-App appointment notification failed", { eventType, reason: "unexpected_error" }); }
    })(),
  ]);
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
  body: await appointmentService.listAppointments(response.locals.database, response.locals.user, response.locals.query, response.locals.applicationTimezone),
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

const previewCancellationRefund = handle(async (_request, response) => ({
  body: await response.locals.paymentService.previewCancellationRefund(
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
  const refund = await response.locals.paymentService.refundCancelledAppointment(response.locals.user, appointment);
  await notify(response, "appointment.cancelled", appointment);
  return { body: { ...appointment, refund } };
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
  await notify(response, "appointment.rescheduled", appointment);
  const {
    previous_date: _previousDate,
    previous_start_time: _previousStartTime,
    reschedule_version: _rescheduleVersion,
    ...body
  } = appointment;
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
  previewCancellationRefund,
  rescheduleAppointment,
};
