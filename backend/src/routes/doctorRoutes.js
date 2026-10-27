const express = require("express");
const { getDoctor, listDoctors, updateDoctor } = require("../controllers/doctorController");
const { requireClerkIdentity, requireLocalUser } = require("../middleware/auth");
const { validate } = require("../middleware/validate");
const { doctorUpdateSchema, idParamsSchema } = require("../validators/profileSchemas");

const router = express.Router();
router.get("/", listDoctors);
router.get("/:id", validate(idParamsSchema, "params"), getDoctor);
router.put("/:id", requireClerkIdentity, requireLocalUser, validate(idParamsSchema, "params"), validate(doctorUpdateSchema, "body"), updateDoctor);

module.exports = router;
