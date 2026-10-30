import type { ReactNode } from "react";

export type CheckoutReturnState = "success" | "cancelling" | "cancelled" | "captured" | null;

type CheckoutReturnNoticeProps = {
  state: CheckoutReturnState;
  paymentPendingId: string | null;
  message: string | null;
  statusAction?: ReactNode;
};

export function CheckoutReturnNotice({
  state,
  paymentPendingId,
  message,
  statusAction,
}: CheckoutReturnNoticeProps) {
  if (!state) return null;

  const title = state === "cancelled"
    ? "Checkout cancelled"
    : state === "captured"
      ? "Payment received"
      : state === "success"
        ? "Verifying payment"
        : "Checking payment status";
  const fallbackMessage = state === "cancelled"
    ? "Payment was not completed. Your appointment is not confirmed. You can choose a time and try again."
    : state === "captured"
      ? "Your payment was received, but the appointment could not be confirmed. Contact Medrella support."
      : state === "cancelling"
        ? "You returned from Checkout. We’re checking whether payment completed. Your appointment is not confirmed yet."
        : "We’re waiting for Stripe to confirm payment. This return does not confirm an appointment.";
  const canCheckStatus = Boolean(paymentPendingId) && (state === "success" || state === "cancelling");

  return (
    <section className="rounded-2xl border border-border bg-card p-5" aria-live="polite">
      <h2 className="font-semibold text-card-foreground">{title}</h2>
      <p className="mt-2 text-sm text-muted-foreground">{message || fallbackMessage}</p>
      {canCheckStatus ? statusAction : null}
    </section>
  );
}
