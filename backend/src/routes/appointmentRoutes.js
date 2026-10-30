const express = require("express");
const {
  cancelAppointment,
  completeAppointment,
  createAppointment,
  getAppointment,
  listAppointments,
  previewCancellationRefund,
  rescheduleAppointment,
} = require("../controllers/appointmentController");
const { requireClerkIdentity, requireLocalUser } = require("../middleware/auth");
const { validate } = require("../middleware/validate");
const {
  appointmentIdParamsSchema,
  appointmentQuerySchema,
  createAppointmentSchema,
  rescheduleAppointmentSchema,
} = require("../validators/appointmentSchemas");

const router = express.Router();
router.use(requireClerkIdentity, requireLocalUser);
router.get("/", validate(appointmentQuerySchema, "query"), listAppointments);
router.post("/", validate(createAppointmentSchema, "body"), createAppointment);
router.get("/:id", validate(appointmentIdParamsSchema, "params"), getAppointment);
router.get("/:id/cancellation-preview", validate(appointmentIdParamsSchema, "params"), previewCancellationRefund);
router.put("/:id/cancel", validate(appointmentIdParamsSchema, "params"), cancelAppointment);
router.put("/:id/reschedule", validate(appointmentIdParamsSchema, "params"), validate(rescheduleAppointmentSchema, "body"), rescheduleAppointment);
router.put("/:id/complete", validate(appointmentIdParamsSchema, "params"), completeAppointment);

module.exports = router;
