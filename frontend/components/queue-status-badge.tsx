import { Badge } from "@/components/ui/badge";
import type { ReceptionQueueEntry } from "@/lib/profile-api";

type QueueStatus = ReceptionQueueEntry["status"] | "confirmed";

const labels: Record<QueueStatus, string> = {
  confirmed: "Not checked in",
  not_checked_in: "Not checked in",
  waiting: "Waiting",
  in_progress: "In progress",
  completed: "Completed",
  no_show: "No-show",
  cancelled: "Cancelled",
};

const styles: Record<QueueStatus, string> = {
  confirmed: "bg-muted text-muted-foreground",
  not_checked_in: "bg-muted text-muted-foreground",
  waiting: "bg-status-confirmed-bg text-status-confirmed",
  in_progress: "bg-primary/10 text-primary",
  completed: "bg-status-completed-bg text-status-completed",
  no_show: "bg-destructive/10 text-destructive",
  cancelled: "bg-status-cancelled-bg text-status-cancelled",
};

export function QueueStatusBadge({ status, className = "" }: {
  status: QueueStatus;
  className?: string;
}) {
  return <Badge className={`${styles[status]} ${className}`.trim()}>{labels[status]}</Badge>;
}
