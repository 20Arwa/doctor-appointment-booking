import type { CancellationRefundPreview } from "@/lib/profile-api";

function formatAmount(amount: string, currency: string) {
  return new Intl.NumberFormat("en-IN", { style: "currency", currency }).format(Number(amount));
}

export function CancellationRefundEstimate({ preview, loading, error }: {
  preview: CancellationRefundPreview | null;
  loading: boolean;
  error: string | null;
}) {
  if (loading) {
    return <div role="status" aria-live="polite" className="rounded-xl border border-border bg-muted p-4 text-sm text-muted-foreground">Checking the current refund estimate…</div>;
  }
  if (error || !preview) {
    return <div className="rounded-xl border border-border bg-muted p-4 text-sm text-muted-foreground" aria-live="polite">
      <p className="font-medium text-foreground">Refund estimate unavailable</p>
      <p className="mt-1">We couldn’t load an estimate. You can still cancel; the backend will calculate the actual refund when you confirm.</p>
    </div>;
  }

  return <section className="rounded-xl border border-border bg-muted p-4" aria-live="polite" aria-label="Refund estimate">
    <dl className="grid gap-2 text-sm sm:grid-cols-2">
      <div>
        <dt className="text-muted-foreground">Original payment</dt>
        <dd className="mt-0.5 font-medium text-foreground">{preview.original_payment ? formatAmount(preview.original_payment.amount, preview.original_payment.currency) : "No payment found"}</dd>
      </div>
      <div>
        <dt className="text-muted-foreground">Applicable refund</dt>
        <dd className="mt-0.5 font-medium text-foreground">{preview.refund_percentage}%</dd>
      </div>
      <div className="sm:col-span-2">
        <dt className="text-muted-foreground">Estimated refund</dt>
        <dd className="mt-0.5 font-semibold text-foreground">{preview.currency ? formatAmount(preview.estimated_refund_amount, preview.currency) : "Unavailable"}</dd>
      </div>
    </dl>
    {!preview.refund_expected && <p className="mt-3 text-sm font-medium text-muted-foreground">No refund is expected. {preview.explanation}</p>}
    {preview.refund_expected && <p className="mt-3 text-sm text-muted-foreground">{preview.explanation}</p>}
    <p className="mt-2 text-xs text-muted-foreground">This estimate is informational. The backend recalculates the actual refund when you confirm cancellation.</p>
  </section>;
}
