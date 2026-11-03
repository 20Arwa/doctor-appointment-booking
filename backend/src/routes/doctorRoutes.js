const express = require("express");
const { getDoctor, getDoctorPatient, listDoctorPatientAppointments, listDoctors, updateDoctor } = require("../controllers/doctorController");
const { requireClerkIdentity, requireLocalUser } = require("../middleware/auth");
const { validate } = require("../middleware/validate");
const { doctorUpdateSchema, idParamsSchema } = require("../validators/profileSchemas");
const { createDoctorSlots, deleteDoctorSlot, getDoctorSlots } = require("../controllers/availabilityController");
const { doctorIdParamsSchema, slotParamsSchema, slotQuerySchema, slotsBodySchema } = require("../validators/availabilitySchemas");
const { doctorPatientAppointmentsQuerySchema, doctorPatientParamsSchema } = require("../validators/doctorPatientSchemas");

const router = express.Router();
router.get("/patients/:patientId/appointments", requireClerkIdentity, requireLocalUser, validate(doctorPatientParamsSchema, "params"), validate(doctorPatientAppointmentsQuerySchema, "query"), listDoctorPatientAppointments);
router.get("/patients/:patientId", requireClerkIdentity, requireLocalUser, validate(doctorPatientParamsSchema, "params"), getDoctorPatient);
router.get("/:id/slots", validate(doctorIdParamsSchema, "params"), validate(slotQuerySchema, "query"), requireClerkIdentity, requireLocalUser, getDoctorSlots);
router.post("/:id/slots", validate(doctorIdParamsSchema, "params"), requireClerkIdentity, requireLocalUser, validate(slotsBodySchema, "body"), createDoctorSlots);
router.delete("/:id/slots/:slotId", validate(slotParamsSchema, "params"), requireClerkIdentity, requireLocalUser, deleteDoctorSlot);
router.get("/", listDoctors);
router.get("/:id", validate(idParamsSchema, "params"), getDoctor);
router.put("/:id", requireClerkIdentity, requireLocalUser, validate(idParamsSchema, "params"), validate(doctorUpdateSchema, "body"), updateDoctor);

module.exports = router;
