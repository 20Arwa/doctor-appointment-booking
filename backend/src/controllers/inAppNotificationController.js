async function listNotifications(_request, response, next) {
  try { return response.json(await response.locals.inAppNotificationService.list(response.locals.user.id, response.locals.query)); }
  catch (error) { return next(error); }
}

async function markNotificationRead(_request, response, next) {
  try {
    const notification = await response.locals.inAppNotificationService.markRead(response.locals.user.id, response.locals.params.id);
    if (!notification) return response.status(404).json({ error: { code: "NOTIFICATION_NOT_FOUND", message: "Notification not found" } });
    return response.json(notification);
  } catch (error) { return next(error); }
}

async function markAllNotificationsRead(_request, response, next) {
  try { return response.json(await response.locals.inAppNotificationService.markAllRead(response.locals.user.id)); }
  catch (error) { return next(error); }
}

module.exports = { listNotifications, markNotificationRead, markAllNotificationsRead };
