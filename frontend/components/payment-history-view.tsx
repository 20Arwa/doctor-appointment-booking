import type { PatientPaymentHistoryItem } from "@/lib/profile-api";
import { ExternalLink } from "lucide-react";

const paymentStatusLabels: Record<PatientPaymentHistoryItem["status"], string> = {
  created: "Created",
  pending: "Pending",
  authorized: "Authorized",
  captured: "Paid",
  failed: "Failed",
  cancelled: "Cancelled",
  expired: "Expired",
  partially_refunded: "Partially refunded",
  refunded: "Refunded",
};

const refundStatusLabels: Record<PatientPaymentHistoryItem["refunds"][number]["status"], string> = {
  pending: "Pending",
  processed: "Refunded",
  failed: "Failed",
  cancelled: "Cancelled",
};

function paymentStatusClass(status: PatientPaymentHistoryItem["status"]) {
  if (status === "captured") return "bg-status-confirmed-bg text-status-confirmed";
  if (status === "refunded") return "bg-status-confirmed-bg text-status-confirmed";
  if (status === "partially_refunded") return "bg-status-completed-bg text-status-completed";
  if (status === "pending" || status === "created" || status === "authorized") return "bg-status-pending-bg text-status-pending";
  return "bg-status-cancelled-bg text-status-cancelled";
}

function refundStatusClass(status: PatientPaymentHistoryItem["refunds"][number]["status"]) {
  if (status === "processed") return "bg-status-confirmed-bg text-status-confirmed";
  if (status === "pending") return "bg-status-pending-bg text-status-pending";
  return "bg-status-cancelled-bg text-status-cancelled";
}

const statusBadgeClass = "inline-flex w-fit items-center rounded-full border border-current/15 font-medium";

export function paymentStatusLabel(status: PatientPaymentHistoryItem["status"]) {
  return paymentStatusLabels[status];
}

export function refundStatusLabel(status: PatientPaymentHistoryItem["refunds"][number]["status"]) {
  return refundStatusLabels[status];
}

export function formatPaymentAmount(amount: string | number, currency: string) {
  return new Intl.NumberFormat("en-IN", { style: "currency", currency }).format(Number(amount));
}

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Date unavailable" : new Intl.DateTimeFormat("en-IN", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Kolkata",
  }).format(date);
}

function refundAmount(refunds: PatientPaymentHistoryItem["refunds"], currency: string) {
  const refundedMinorUnits = refunds
    .filter((refund) => refund.status === "processed")
    .reduce((total, refund) => total + Math.round(Number(refund.amount) * 100), 0);
  return refundedMinorUnits ? formatPaymentAmount(refundedMinorUnits / 100, currency) : null;
}

export function PaymentHistoryView({ payments, loading, error, onRetry }: {
  payments: PatientPaymentHistoryItem[];
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}) {
  if (loading) {
    return <div role="status" aria-live="polite" className="rounded-2xl border border-border bg-card p-6 text-muted-foreground">Loading payment history…</div>;
  }
  if (error) {
    return (
      <section role="alert" className="rounded-2xl border border-border bg-card p-6">
        <p className="font-medium text-foreground">We couldn’t load your payment history.</p>
        <p className="mt-2 text-sm text-muted-foreground">{error}</p>
        <button type="button" onClick={onRetry} className="mt-4 min-h-11 rounded-lg bg-primary px-4 font-semibold text-primary-foreground hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">Try again</button>
      </section>
    );
  }
  if (!payments.length) {
    return <section className="rounded-2xl border border-border bg-card p-8 text-center">
      <h2 className="text-lg font-semibold text-card-foreground">No payments yet</h2>
      <p className="mt-2 text-sm text-muted-foreground">Payments for your appointments will appear here.</p>
    </section>;
  }
  return (
    <ul className="space-y-4" aria-label="Payment history">
      {payments.map((payment) => {
        const refunded = refundAmount(payment.refunds, payment.currency);
        return (
          <li key={payment.id} className="rounded-2xl border border-border bg-card p-4 shadow-sm sm:p-5">
            <article aria-labelledby={`payment-${payment.id}`}>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <h2 id={`payment-${payment.id}`} className="text-lg font-semibold text-card-foreground">{formatPaymentAmount(payment.amount, payment.currency)}</h2>
                  <p className="mt-1 text-sm text-muted-foreground">{formatDate(payment.date)}</p>
                </div>
                <span aria-label="Payment status" className={`${statusBadgeClass} px-2.5 py-1 text-xs ${paymentStatusClass(payment.status)}`}>{paymentStatusLabel(payment.status)}</span>
              </div>

              {payment.appointment && <div className="mt-3 border-t border-border pt-3">
                <h3 className="text-sm font-semibold text-foreground">Appointment</h3>
                <p className="mt-0.5 text-sm text-muted-foreground">{formatDate(`${payment.appointment.date}T${payment.appointment.start_time}+05:30`)} IST</p>
                {payment.appointment.doctor && <p className="mt-0.5 text-sm text-muted-foreground">Dr. {payment.appointment.doctor.first_name} {payment.appointment.doctor.last_name} · {payment.appointment.doctor.specialty}</p>}
              </div>}

              {payment.refunds.length > 0 && <div className="mt-3 border-t border-border pt-3">
                <h3 className="text-sm font-semibold text-foreground">Refund details</h3>
                {refunded && <p className="mt-1 text-sm font-medium text-foreground">Refunded amount: {refunded}</p>}
                <ul className="mt-1.5 space-y-1.5">
                  {payment.refunds.map((refund) => <li key={refund.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                    <span className="text-muted-foreground">{formatPaymentAmount(refund.amount, refund.currency)} · {formatDate(refund.created_at)}{refund.reason ? ` · ${refund.reason.replaceAll("_", " ")}` : ""}</span>
                    <span aria-label="Refund status" className={`${statusBadgeClass} px-2 py-0.5 text-xs ${refundStatusClass(refund.status)}`}>{refundStatusLabel(refund.status)}</span>
                  </li>)}
                </ul>
              </div>}

              {payment.receipt_url && <div className="mt-3">
                <a href={payment.receipt_url} target="_blank" rel="noreferrer" className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-border bg-muted/50 px-3 text-sm font-medium text-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
                  View receipt <ExternalLink aria-hidden="true" size={14} />
                </a>
              </div>}
            </article>
          </li>
        );
      })}
    </ul>
  );
}
