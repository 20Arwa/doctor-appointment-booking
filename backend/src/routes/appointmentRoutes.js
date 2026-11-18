const express = require("express");
const {
  cancelAppointment,
  completeAppointment,
  createAppointment,
  getAppointment,
  getAppointmentPatientProfile,
  listAppointments,
  previewCancellationRefund,
  rescheduleAppointment,
} = require("../controllers/appointmentController");
const { requireClerkIdentity, requireLocalUser, requireRole } = require("../middleware/auth");
const { validate } = require("../middleware/validate");
const {
  appointmentIdParamsSchema,
  appointmentQuerySchema,
  createAppointmentSchema,
  rescheduleAppointmentSchema,
} = require("../validators/appointmentSchemas");

const assistedRescheduleController = require("../controllers/assistedRescheduleController");
const { assistedRescheduleRequestParamsSchema, confirmAssistedRescheduleSchema } = require("../validators/assistedRescheduleSchemas");
const router = express.Router();
router.use(requireClerkIdentity, requireLocalUser);
router.get("/", requireRole("patient", "doctor"), validate(appointmentQuerySchema, "query"), listAppointments);
router.post("/", requireRole("patient"), validate(createAppointmentSchema, "body"), createAppointment);
router.get("/:id", requireRole("patient", "doctor"), validate(appointmentIdParamsSchema, "params"), getAppointment);
router.get("/:id/patient-profile", requireRole("doctor"), validate(appointmentIdParamsSchema, "params"), getAppointmentPatientProfile);
router.get("/:id/assisted-reschedule-request", requireRole("patient"), validate(appointmentIdParamsSchema, "params"), assistedRescheduleController.getPatientRequest);
router.post("/assisted-reschedule-requests/:requestId/confirm", requireRole("patient"), validate(assistedRescheduleRequestParamsSchema, "params"), validate(confirmAssistedRescheduleSchema, "body"), assistedRescheduleController.confirmPatientRequest);
router.post("/assisted-reschedule-requests/:requestId/decline", requireRole("patient"), validate(assistedRescheduleRequestParamsSchema, "params"), assistedRescheduleController.declinePatientRequest);
router.get("/:id/cancellation-preview", requireRole("patient"), validate(appointmentIdParamsSchema, "params"), previewCancellationRefund);
router.put("/:id/cancel", requireRole("patient"), validate(appointmentIdParamsSchema, "params"), cancelAppointment);
router.put("/:id/reschedule", requireRole("patient", "doctor"), validate(appointmentIdParamsSchema, "params"), validate(rescheduleAppointmentSchema, "body"), rescheduleAppointment);
router.put("/:id/complete", requireRole("doctor"), validate(appointmentIdParamsSchema, "params"), completeAppointment);

module.exports = router;
