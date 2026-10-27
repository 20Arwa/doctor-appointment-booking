const express = require("express");
const { getDoctor, listDoctors, updateDoctor } = require("../controllers/doctorController");
const { requireClerkIdentity, requireLocalUser } = require("../middleware/auth");
const { validate } = require("../middleware/validate");
const { doctorUpdateSchema, idParamsSchema } = require("../validators/profileSchemas");
const { createDoctorSlots, deleteDoctorSlot, getDoctorSlots } = require("../controllers/availabilityController");
const { doctorIdParamsSchema, slotParamsSchema, slotQuerySchema, slotsBodySchema } = require("../validators/availabilitySchemas");

const router = express.Router();
router.get("/:id/slots", validate(doctorIdParamsSchema, "params"), validate(slotQuerySchema, "query"), getDoctorSlots);
router.post("/:id/slots", validate(doctorIdParamsSchema, "params"), requireClerkIdentity, requireLocalUser, validate(slotsBodySchema, "body"), createDoctorSlots);
router.delete("/:id/slots/:slotId", validate(slotParamsSchema, "params"), requireClerkIdentity, requireLocalUser, deleteDoctorSlot);
router.get("/", listDoctors);
router.get("/:id", validate(idParamsSchema, "params"), getDoctor);
router.put("/:id", requireClerkIdentity, requireLocalUser, validate(idParamsSchema, "params"), validate(doctorUpdateSchema, "body"), updateDoctor);

module.exports = router;
