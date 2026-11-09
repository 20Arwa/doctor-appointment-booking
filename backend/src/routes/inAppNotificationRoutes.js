const express = require("express");
const { listNotifications, markNotificationRead, markAllNotificationsRead } = require("../controllers/inAppNotificationController");
const { requireClerkIdentity, requireLocalUser } = require("../middleware/auth");
const { validate } = require("../middleware/validate");
const { notificationIdParamsSchema, notificationQuerySchema } = require("../validators/inAppNotificationSchemas");

const router = express.Router();
router.use(requireClerkIdentity, requireLocalUser);
router.get("/", validate(notificationQuerySchema, "query"), listNotifications);
router.patch("/read-all", markAllNotificationsRead);
router.patch("/:id/read", validate(notificationIdParamsSchema, "params"), markNotificationRead);

module.exports = router;
