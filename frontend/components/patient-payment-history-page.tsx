"use client";

import { useAuth } from "@clerk/nextjs";
import { useCallback, useEffect, useState } from "react";
import { PaymentHistoryView } from "@/components/payment-history-view";
import { getPatientPaymentHistory, type PatientPaymentHistoryItem } from "@/lib/profile-api";

export function PatientPaymentHistoryPage() {
  const { getToken } = useAuth();
  const [payments, setPayments] = useState<PatientPaymentHistoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchPayments = useCallback(async () => {
    const token = await getToken();
    if (!token) throw new Error("Your secure sign-in session is not ready. Please try again.");
    return getPatientPaymentHistory(token);
  }, [getToken]);

  const retry = useCallback(() => {
    setLoading(true);
    setError(null);
    void fetchPayments().then(setPayments)
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "We couldn’t load your payment history. Please try again."))
      .finally(() => setLoading(false));
  }, [fetchPayments]);

  useEffect(() => {
    let active = true;
    void fetchPayments().then((result) => { if (active) setPayments(result); })
      .catch((cause: unknown) => { if (active) setError(cause instanceof Error ? cause.message : "We couldn’t load your payment history. Please try again."); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [fetchPayments]);

  return (
    <div className="space-y-8">
      <header>
        <p className="text-sm font-semibold uppercase tracking-[0.14em] text-primary">Payments</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">Payment History</h1>
        <p className="mt-3 max-w-2xl text-base leading-7 text-muted-foreground">Review appointment payments, refunds, and available receipts.</p>
      </header>
      <PaymentHistoryView payments={payments} loading={loading} error={error} onRetry={retry} />
    </div>
  );
}
