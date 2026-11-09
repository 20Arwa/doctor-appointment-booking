import { toast } from "sonner";

export const IN_APP_NOTIFICATIONS_CHANGED_EVENT = "medrella:in-app-notifications-changed";

export function notifyInAppNotificationsChanged() {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(IN_APP_NOTIFICATIONS_CHANGED_EVENT));
}

export function notifySuccess(message: string, id: string) {
  toast.success(message, { id, duration: 4000 });
}

export function notifyError(message: string, id: string) {
  toast.error(message, { id, duration: 6000 });
}
