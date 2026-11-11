const service = require("../services/assistedRescheduleService");
const appointmentService = require("../services/appointmentService");

function patientAction(operation) {
  return async (request, response, next) => {
    try {
      const result = await operation(response);
      return response.json(result);
    } catch (error) {
      if (error instanceof appointmentService.AppointmentError) {
        return response.status(error.status).json({ error: { code: error.code, message: error.message } });
      }
      return next(error);
    }
  };
}

function listDoctorRequests(_request, response, next) {
  const { id } = response.locals.params;
  service.listDoctorRequests(response.locals.database, response.locals.user, id, response.locals.query)
    .then((result) => result.forbidden
      ? response.status(403).json({ error: { code: "FORBIDDEN", message: "Only the owning doctor may view assisted rescheduling requests" } })
      : response.json(result))
    .catch(next);
}

function getPatientRequest(_request, response, next) {
  service.getPatientRequest(response.locals.database, response.locals.user, response.locals.params.id)
    .then((result) => result?.forbidden
      ? response.status(403).json({ error: { code: "FORBIDDEN", message: "Only the owning patient may view assisted rescheduling requests" } })
      : result ? response.json(result)
        : response.status(404).json({ error: { code: "ASSISTED_RESCHEDULE_REQUEST_NOT_FOUND", message: "Assisted rescheduling request not found" } }))
    .catch(next);
}

const confirmPatientRequest = patientAction((response) => appointmentService.confirmAssistedReschedule(
  response.locals.database,
  response.locals.user,
  response.locals.applicationTimezone,
  response.locals.params.requestId,
  response.locals.body.suggestion_id,
));

const declinePatientRequest = patientAction((response) => appointmentService.declineAssistedReschedule(
  response.locals.database,
  response.locals.user,
  response.locals.params.requestId,
));

module.exports = {
  confirmPatientRequest,
  declinePatientRequest,
  getPatientRequest,
  listDoctorRequests,
};
