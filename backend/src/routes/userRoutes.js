const express = require("express");
const { createMe, getMe, patchMe } = require("../controllers/userController");
const { requireClerkIdentity, requireLocalUser } = require("../middleware/auth");
const { validate } = require("../middleware/validate");
const { onboardingSchema, userPatchSchema } = require("../validators/profileSchemas");

const router = express.Router();
router.use(requireClerkIdentity);
router.get("/me", requireLocalUser, getMe);
router.post("/me", validate(onboardingSchema, "body"), createMe);
router.patch("/me", requireLocalUser, validate(userPatchSchema, "body"), patchMe);

module.exports = router;
