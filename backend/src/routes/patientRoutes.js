const express = require("express");
const { getPatient, listPatients, updatePatient } = require("../controllers/patientController");
const { requireClerkIdentity, requireLocalUser } = require("../middleware/auth");
const { validate } = require("../middleware/validate");
const { idParamsSchema, patientUpdateSchema } = require("../validators/profileSchemas");

const router = express.Router();
router.use(requireClerkIdentity, requireLocalUser);
router.get("/", listPatients);
router.get("/:id", validate(idParamsSchema, "params"), getPatient);
router.put("/:id", validate(idParamsSchema, "params"), validate(patientUpdateSchema, "body"), updatePatient);

module.exports = router;
