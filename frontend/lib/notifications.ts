import { toast } from "sonner";

export function notifySuccess(message: string, id: string) {
  toast.success(message, { id, duration: 4000 });
}

export function notifyError(message: string, id: string) {
  toast.error(message, { id, duration: 6000 });
}
