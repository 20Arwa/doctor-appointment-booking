import type { AssistantResult } from "@/lib/assistant-api";

export type ProposalType = "book" | "cancel" | "reschedule";
export type ProposalStatus = "loading" | "pending" | "confirming" | "processing" | "dismissing" | "checkout_pending" | "refund_pending" | "completed" | "expired" | "failed" | "dismissed";

const proposalTypes: Record<string, ProposalType> = {
  prepare_booking_action: "book",
  prepare_cancellation_action: "cancel",
  prepare_reschedule_action: "reschedule",
};

export function proposalTypeForResult(result: AssistantResult): ProposalType | null {
  const actionType = proposalTypes[result.tool];
  const data = result.data;
  const proposal = data.proposal;
  if (!actionType || data.requires_patient_confirmation !== true || !proposal || typeof proposal !== "object") return null;
  return (proposal as Record<string, unknown>).action_type === actionType ? actionType : null;
}

export function isProposalExpired(expiresAt: string, now = Date.now()): boolean {
  const instant = Date.parse(expiresAt);
  return !Number.isFinite(instant) || instant <= now;
}

export function confirmationStatus(status: string): ProposalStatus {
  if (status === "completed") return "completed";
  if (status === "checkout_pending") return "checkout_pending";
  if (status === "refund_pending") return "refund_pending";
  if (status === "expired") return "expired";
  return "failed";
}

export function proposalStatusFromBackend(status: string, expiresAt: string, now = Date.now()): ProposalStatus {
  if (status === "completed") return "completed";
  if (status === "checkout_pending") return "checkout_pending";
  if (status === "refund_pending") return "refund_pending";
  if (status === "expired" || isProposalExpired(expiresAt, now)) return "expired";
  if (status === "pending") return "pending";
  if (status === "executing") return "processing";
  if (status === "dismissed") return "dismissed";
  return "failed";
}

export function preserveDismissalOnPrepare(current: ProposalStatus, backendStatus: string, expiresAt: string, now = Date.now()): ProposalStatus {
  if (current === "dismissed" || current === "dismissing") return current;
  return proposalStatusFromBackend(backendStatus, expiresAt, now);
}

export async function reconcileActionStatus(
  readStatus: () => Promise<{ status: string; expires_at: string; summary?: Record<string, unknown> }>,
  fallbackStatus: ProposalStatus,
  now = Date.now(),
): Promise<{ status: ProposalStatus; summary?: Record<string, unknown> }> {
  try {
    const latest = await readStatus();
    return { status: proposalStatusFromBackend(latest.status, latest.expires_at, now), ...(latest.summary ? { summary: latest.summary } : {}) };
  } catch {
    return { status: fallbackStatus };
  }
}

export function proposalTitle(type: ProposalType, status?: ProposalStatus): string {
  if (type === "book" && status === "completed") return "Booking confirmed";
  return type === "book" ? "Booking proposal" : type === "cancel" ? "Cancellation proposal" : "Rescheduling proposal";
}

export function proposalDescription(type: ProposalType, status: ProposalStatus): string {
  return type === "book" && status === "completed"
    ? "Your appointment has been successfully confirmed."
    : "Review these verified details before confirming.";
}
