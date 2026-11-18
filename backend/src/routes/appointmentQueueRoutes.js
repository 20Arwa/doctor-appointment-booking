const express = require("express");
const controller = require("../controllers/appointmentQueueController");
const { requireClerkIdentity, requireLocalUser } = require("../middleware/auth");
const { validate } = require("../middleware/validate");
const { appointmentQueueParamsSchema, queueQuerySchema, receptionistQueueQuerySchema } = require("../validators/appointmentQueueSchemas");
const { rescheduleAppointmentSchema } = require("../validators/appointmentSchemas");
const appointmentController = require("../controllers/appointmentController");

const router = express.Router();
router.use(requireClerkIdentity, requireLocalUser);
router.get("/patient/appointments/:appointmentId", validate(appointmentQueueParamsSchema, "params"), controller.patient);
router.get("/doctor", validate(queueQuerySchema, "query"), controller.doctor);
router.get("/reception", validate(receptionistQueueQuerySchema, "query"), controller.receptionist);
router.post("/appointments/:appointmentId/check-in", validate(appointmentQueueParamsSchema, "params"), controller.checkIn);
router.post("/appointments/:appointmentId/no-show", validate(appointmentQueueParamsSchema, "params"), controller.noShow);
router.put("/appointments/:appointmentId/reschedule", validate(appointmentQueueParamsSchema, "params"), validate(rescheduleAppointmentSchema, "body"), appointmentController.rescheduleAppointment);
router.post("/call-next", validate(queueQuerySchema, "query"), controller.callNext);
router.post("/appointments/:appointmentId/complete", validate(appointmentQueueParamsSchema, "params"), controller.complete);
module.exports = router;
